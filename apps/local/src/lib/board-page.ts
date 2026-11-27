import { boardFor, canMove } from '@nolzu/core';
import { type Board, type BoardChoice, type BoardKind, type BoardSnapshot, type CardState, type CardView, cardStarts, isBoardKind, type ResearchKind, type StageView, ticketLink } from '@nolzu/protocol';
import { type Allowed, dropToast, type FixIt, fixItOf, keyStart, type MyTickets, pushToast, type Refusal, refusalFromServer, refuseDrop, runView, type SendBack, sendBackOf, type ToastItem } from '@nolzu/ui';
import { forwardMove, postWrite, retryStage } from './ticket.ts';

// What each column answers while a card is dragged: a move forward, a move back, or no move at all.
// Core's own rule decides, so the board never offers a drop the server would refuse.
export function allowedFor(board: Board, card: { stage: string; state: CardState } | null): Allowed {
  return (stage) => {
    if (card === null || !canMove(board, card, stage)) return false;
    const index = (id: string) => board.stages.findIndex((one) => one.id === id);
    return index(stage) > index(card.stage) ? 'forward' : 'back';
  };
}

// The count beside the board's title: the cards not yet closed, so a
// Closed column that only grows does not swell it.
const NOUNS: Partial<Record<BoardKind, readonly [string, string]>> = { epics: ['epic', 'epics'], prreview: ['pull request', 'pull requests'] };

// Epics adds the Delivery tasks of its open epics. PR reviews says how many pull requests are
// open and the repositories they come from, read off the `repo#n` keys.
export function boardCount(snapshot: BoardSnapshot, kind: BoardKind): string {
  const open = openCards(snapshot);
  if (kind === 'prreview') {
    const pulls = open.filter((card) => card.pull?.ended === undefined);
    const repos = [...new Set(pulls.flatMap((card) => (card.key.includes('#') ? [card.key.slice(0, card.key.lastIndexOf('#'))] : [])))];
    return repos.length === 0 ? `${pulls.length} open` : `${pulls.length} open · ${wordList(repos)}`;
  }
  const line = countLine(open.length, kind);
  if (kind !== 'epics') return line;
  const tasks = open.reduce((sum, card) => sum + (card.tasks?.length ?? 0), 0);
  return tasks === 0 ? line : `${line} · ${tasks} ${tasks === 1 ? 'task' : 'tasks'} on Delivery`;
}

// "api", "api and web", "api, web and cli".
const wordList = (words: readonly string[]): string => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`);

const openCards = <C extends { stage: string }>(snapshot: { stages: readonly { id: string; role: string }[]; cards: readonly C[] }): C[] => {
  const archive = new Set(snapshot.stages.filter((stage) => stage.role === 'archive').map((stage) => stage.id));
  return snapshot.cards.filter((card) => !archive.has(card.stage));
};

// The cards not in an archive column. The board's title and the rail count them alike.
export function openCount(snapshot: Pick<BoardSnapshot, 'stages' | 'cards'>): number {
  return openCards(snapshot).length;
}

// Research is no board kind, and its two kinds hold cards.
export function countLine(n: number, kind: BoardChoice): string {
  const [one, many] = NOUNS[kind as BoardKind] ?? ['card', 'cards'];
  return `${n} ${n === 1 ? one : many}`;
}

// The stage one column back, where Shift and the left arrow move a card, or null when it cannot move
// back. The same rule as a drop on that column, so the key never sends a move the drop would not.
export function stageBack(board: Board, card: { stage: string; state: CardState }): string | null {
  const before = board.stages[board.stages.findIndex((stage) => stage.id === card.stage) - 1];
  return before !== undefined && allowedFor(board, card)(before.id) === 'back' ? before.id : null;
}

// The column before the card's, whatever the card's state, for Peek's Move back: a running card is
// stopped first, which the plain move back refuses. Null in the first column.
export function stageBefore(board: Board, stage: string): StageView['id'] | null {
  return board.stages[board.stages.findIndex((one) => one.id === stage) - 1]?.id ?? null;
}

// The moved card the page selects again, once the stream shows it in the column it went to. Null while
// the move is on its way, and for a card this page does not show.
export function landed(cards: readonly { key: string; stage: string }[], moved: { key: string; to: string } | null): string | null {
  if (moved === null) return null;
  return cards.some((card) => card.key === moved.key && card.stage === moved.to) ? moved.key : null;
}

// The stage one column on, where Shift and the right arrow move a card, with the card's own models over
// the stage's, as a drop there reads it. Null when the card cannot move forward, by the rule a drop on
// that column follows.
export function stageForward(snapshot: BoardSnapshot, key: string): StageView | null {
  const card = snapshot.cards.find((found) => found.key === key);
  if (card === undefined) return null;
  const board = boardFor(snapshot.kind, snapshot.flow);
  const after = board.stages[board.stages.findIndex((stage) => stage.id === card.stage) + 1];
  const stage = after === undefined || allowedFor(board, card)(after.id) !== 'forward' ? undefined : snapshot.stages.find((one) => one.id === after.id);
  return stage === undefined ? null : { ...stage, starts: cardStarts(stage, card) };
}

// What a key that writes does to one card, read off the snapshot at the press: ask first with the
// Starts line, refuse the way a drop refuses, send a write, or nothing, which leaves the key to the
// browser. A retry goes to the card's own route, so it is named and not given as a path. A move asks
// with the column it goes to, so the confirm holds that column.
export type KeyWrite =
  | { kind: 'ask'; move?: string }
  // `at` is the stage the refused start would run in, so the toast can link the row that fixes it.
  | { kind: 'refused'; refusal: Refusal; at: string }
  | { kind: 'send'; to: 'retry' | '/api/board/move' | '/api/board/stop' | '/api/board/promote' | '/api/board/minimize'; body: unknown }
  | null;

export function keyWrite(snapshot: BoardSnapshot, key: string, action: 'retry' | 'forward' | 'stop' | 'promote' | 'minimize'): KeyWrite {
  const card = snapshot.cards.find((found) => found.key === key);
  if (card === undefined) return null;
  if (action === 'forward') {
    const stage = stageForward(snapshot, key);
    if (stage === null) return null;
    const next = keyStart(stage);
    if (next.kind === 'refused') return { kind: 'refused', refusal: { ...next.refusal, stage: stage.label }, at: stage.id };
    // The body a drop on that column sends, to the same route.
    return next.kind === 'ask' ? { kind: 'ask', move: stage.id } : { kind: 'send', to: '/api/board/move', body: { key, to: stage.id } };
  }
  if (action === 'minimize') return { kind: 'send', to: '/api/board/minimize', body: { key, minimized: !card.minimized } };
  if (action === 'promote') return card.state === 'queued' && card.runId !== null ? { kind: 'send', to: '/api/board/promote', body: { runId: card.runId } } : null;
  if (action === 'stop') {
    const run = runView(card, null);
    return run?.kind === 'stop' ? { kind: 'send', to: '/api/board/stop', body: { runId: run.runId } } : null;
  }
  // R on a QA FAIL is Fix it. Both of its runs start something, so it always asks first, and it is
  // refused the way a drop refuses either one.
  const fix = fixItOf(card, snapshot.stages);
  if (fix !== null) {
    for (const run of [fix.implement, fix.qa]) {
      const next = keyStart(run);
      if (next.kind === 'refused') return { ...next, at: run.id };
    }
    return { kind: 'ask' };
  }
  const stage = retryStage(snapshot, key);
  if (stage === null) return null;
  const next = keyStart(stage);
  if (next.kind === 'refused') return { ...next, at: stage.id };
  return next.kind === 'send' ? { kind: 'send', to: 'retry', body: {} } : next;
}

// What a start confirm is open for: a retry of a failed card when `move` is null, or a move one column
// on to the stage it names.
export interface Starting {
  key: string;
  move: string | null;
}

// The stage the confirm starts its run in, read off each snapshot, or null once the card can no longer
// do it, which closes the confirm. A move holds the column it was asked for, so a card that moved on in
// the meantime is never offered the column after it.
export function confirmStage(snapshot: BoardSnapshot, starting: Starting): StageView | null {
  if (starting.move === null) return retryStage(snapshot, starting.key) ?? confirmFix(snapshot, starting)?.implement ?? null;
  const next = stageForward(snapshot, starting.key);
  return next?.id === starting.move ? next : null;
}

// The confirm R opens on a QA FAIL is Fix it, with its two runs, until the card no longer offers it.
export function confirmFix(snapshot: BoardSnapshot, starting: Starting): FixIt | null {
  const card = snapshot.cards.find((found) => found.key === starting.key);
  return starting.move !== null || card === undefined ? null : fixItOf(card, snapshot.stages);
}

// The board a `/b/<name>` page shows. A name that is not one of the five is a page that is not there.
export function boardKind(name: string): BoardKind | null {
  return isBoardKind(name) ? name : null;
}

// Sends a move and answers with what the board has to show: nothing when the server took it, because
// the stream moves the card, or the refusal for one toast. It never touches the board it came from.
export async function sendMove(send: Parameters<typeof postWrite>[0], url: string, key: string, to: string): Promise<Refusal | null> {
  const said = await postWrite(send, url, { key, to });
  return said === null ? null : refusalFromServer(said);
}

// Where a board's pull request button posts, or null on a board that has none. The PR reviews board
// reads its repository's open pull requests, and the Delivery board looks up the pull request of each
// card on PR watch.
export function pullsAddress(base: string, kind: BoardKind): string | null {
  if (kind === 'prreview') return base;
  return kind === 'delivery' ? `${base}?board=delivery` : null;
}

// The sentence a board shows after its pull request button: what the read found, or why it did not
// happen. Never empty, so a press always says something.
export async function readPullsSaid(send: typeof fetch, url: string): Promise<string> {
  try {
    const response = await send(url, { method: 'POST' });
    const said = (await response.json().catch(() => ({}))) as { said?: string; message?: string };
    return said.said ?? said.message ?? `The pull requests were not read. The board answered ${response.status} and gave no reason.`;
  } catch {
    return 'The board could not be reached. Check that Nolzu is still running.';
  }
}

// The board stream this page reads. The kind rides in the address, so one endpoint serves five
// boards and a page that moves to another board opens a new stream rather than filtering an old one.
export function streamAddress(base: string, kind: BoardKind): string {
  return `${base}?board=${kind}`;
}

// Every board sits at `/b/<board>`. `/` is Now.
export function isBoardRoute(id: string | null): boolean {
  return id === '/b/[board]';
}

// What the Add card dialog hears back: the key the card got, or why there is none. `refused` is the
// server's sentence when the card was made and its start was not.
export type Made = { ok: true; key: string; note: string | null; refused?: string } | { ok: false; reason: string };

// Makes a card from the dialog's payload. The board and Now both send it here, so both say the same
// thing when the server refuses.
export async function postCard(send: typeof fetch, url: string, payload: unknown): Promise<Made> {
  try {
    const response = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    // An answer that is not JSON is still an answer, and says the board is up.
    const said = (await response.json().catch(() => ({}))) as { key?: string; note?: string | null; message?: string; refused?: string };
    if (!response.ok || said.key === undefined) return { ok: false, reason: said.message ?? `The card was not made. The board answered ${response.status} and gave no reason.` };
    return { ok: true, key: said.key, note: said.note ?? null, ...(said.refused === undefined ? {} : { refused: said.refused }) };
  } catch {
    return { ok: false, reason: 'The board could not be reached. Check that Nolzu is still running.' };
  }
}

// What the Research add box sends. Its words are the title, so a question that looks like a key is not
// read as one. A GitHub issue link alone goes as input, so the server reads it through gh as Add card does.
export function researchCard(text: string, board: ResearchKind): { input: string; title?: string; board: ResearchKind } {
  const link = ticketLink(text);
  return link?.system === 'github' && !link.pull ? { input: text.trim(), board } : { input: '', title: text.trim(), board };
}

// Connect Jira from Add card. The token is in the body of this one POST and in nothing the answer
// carries back.
export async function postJira(send: typeof fetch, url: string, form: { site: string; email: string; token: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const response = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
    if (response.ok) return { ok: true };
    const said = (await response.json().catch(() => ({}))) as { message?: string };
    return { ok: false, reason: said.message ?? `Jira was not connected. Nolzu answered ${response.status} and gave no reason.` };
  } catch {
    return { ok: false, reason: 'Nolzu could not be reached. Check that it is still running.' };
  }
}

// The key the next local card gets, for the dialog to show beside the title. Nothing when the app does
// not answer, and the dialog then shows no key rather than a guess.
export async function nextKey(send: typeof fetch, url: string): Promise<string | null> {
  try {
    const response = await send(url);
    return response.ok ? (((await response.json()) as { key?: string }).key ?? null) : null;
  } catch {
    return null;
  }
}

// The tickets assigned to the person with no card yet, for Add card's list. When the app does not answer,
// the list says so in place of the tickets.
export async function myTicketsOf(send: typeof fetch, url: string): Promise<MyTickets> {
  try {
    const response = await send(url);
    if (response.ok) return (await response.json()) as MyTickets;
  } catch {
    // The same sentence as an answer that is not ok.
  }
  return { asked: true, tickets: [], problems: ['Your tickets were not read, because Nolzu did not answer. Check that it is still running.'] };
}

// What Add card sends, as far as the page reads it. Its go button sets `start`.
export type AddPayload = { board?: string; start?: boolean };

// The start a press of the go button asks for: the stage it runs, read off the card's board at the press,
// and the refusal a drop there gives.
export interface AddStart {
  stage: StageView;
  refusal: Refusal | null;
}

// Add and start is one call. A start a drop on that stage would refuse is left out,
// so the card still lands in its first column and nothing runs, and the refusal is its toast. So is a
// start with no snapshot behind it, because the button then showed nothing to consent to.
export function addRequest<P extends AddPayload>(asked: P, snapshot: BoardSnapshot | null | undefined): { payload: P; start: AddStart | null } {
  if (asked.start !== true) return { payload: asked, start: null };
  // The one move a new card can make, to the column after its first, as a drop would.
  const stage = snapshot?.stages[1];
  const refusal = stage === undefined ? null : refuseDrop(stage, 'forward');
  const start = stage === undefined || stage.starts === null ? null : { stage, refusal: refusal === null ? null : { ...refusal, stage: stage.label } };
  if (start !== null && start.refusal === null) return { payload: asked, start };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- taken out, so the server starts nothing
  const { start: _, ...payload } = asked;
  return { payload: payload as P, start };
}

// Add and start while Learn your repositories holds the first run back: the card is only added,
// and `held` is the stage the page opens the Learn dialog on once Add card closes, as a first drag does.
export function addOrHold<P extends AddPayload>(asked: P, snapshot: BoardSnapshot | null | undefined, gates: boolean): { payload: P; start: AddStart | null; held: string | null } {
  const asks = addRequest(asked, snapshot);
  if (!gates || asks.start === null || asks.start.refusal !== null) return { ...asks, held: null };
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- taken out, so the server starts nothing
  const { start: _, ...payload } = asks.payload;
  return { payload: payload as P, start: null, held: asks.start.stage.id };
}

// What the page says once the dialog has closed: where the card is, or why its start was refused. `at` is
// the stage a start refused here would have run in, for the link that fixes it.
export interface Added {
  key: string;
  note: string | null;
  column: string;
  refusal: Refusal | null;
  at: string | null;
}

export function addedOf(made: { key: string; note: string | null; refused?: string }, snapshot: BoardSnapshot | null | undefined, start: AddStart | null): Added {
  // Read off the card's board, because the first column is Inbox on four boards and Incoming on PR reviews.
  const first = snapshot?.stages[0]?.label ?? 'the first column';
  if (start === null) return { key: made.key, note: made.note, column: first, refusal: null, at: null };
  // The server's sentence says what happened, as it does for a drop, so it names no column of its own.
  const refusal = start.refusal ?? (made.refused === undefined ? null : refusalFromServer(made.refused));
  // Only a refusal found here is about the model row a link can fix. The server's names its own fix.
  return { key: made.key, note: made.note, column: refusal === null ? start.stage.label : first, refusal, at: start.refusal === null ? null : start.stage.id };
}

// The added toast, or a refused start's toast with the setting that fixes it, from `fixLink`. The server's
// refusal has no `at` and gets no link, as a refused drop's server sentence gets none.
export function addedToast(state: BoardToasts, card: ToastCard, added: Added, link?: ToastLink): BoardToasts {
  if (added.refusal === null) return cardAdded(state, card, added.column, added.note);
  return refusedDrop(state, card, added.refusal, added.at === null ? undefined : link);
}

// The cards whose extra context the dialog can copy. An empty list when the app does not answer.
export async function contextCards(send: typeof fetch, url: string): Promise<{ key: string; title: string; extra: string }[]> {
  try {
    const response = await send(url);
    return response.ok ? ((await response.json()) as { key: string; title: string; extra: string }[]) : [];
  } catch {
    return [];
  }
}

// The toasts the board shows, and the latest press of each card. Every move sent and every refused drag
// takes the next number for its card, and an answer counts only for that card's latest press. A press
// of another card does not hide it, because the stack holds one toast per card.
export interface BoardToasts {
  toasts: ToastItem[];
  press: number;
  latest: Readonly<Record<string, number>>;
}

export const NO_TOASTS: BoardToasts = { toasts: [], press: 0, latest: {} };

type ToastCard = ToastItem['card'];

type ToastLink = NonNullable<ToastItem['link']>;

const CARD_LINK = 'Open card settings';

// A refused move names the column the card did not reach, and a refusal the board gave itself links the
// setting that fixes it. The fix then names that one place, so the reason and the fix fit two lines.
// Nothing ran, so the toast has the ban sign and never the x of a failed run.
const refusalToast = (card: ToastCard, refusal: Refusal, link?: ToastLink): ToastItem => ({
  kind: 'error',
  refused: true,
  card,
  ...(refusal.stage === undefined ? {} : { headline: `did not move to ${refusal.stage}` }),
  message: refusal.message,
  ...(refusal.code === undefined ? {} : { code: refusal.code }),
  fix: refusalFix(refusal, link),
  ...(link === undefined ? {} : { link }),
});

// The fix under a refusal: with a link, its act at that one place, so the reason and the fix fit two
// lines; without one, the refusal's own fix. The card page's decision panel says the same.
export function refusalFix(refusal: Refusal, link?: ToastLink): string | null {
  return link === undefined || refusal.act === undefined ? refusal.fix : `${refusal.act} in ${link.label === CARD_LINK ? 'the card settings' : 'Settings, Models'}.`;
}

// Every refusal the board gives itself is about the row a start runs on: its model, its login or its
// engine. A card that runs the phase on a row of its own is fixed in its settings tab, and every other
// card in Settings, Models. The snapshot does not say which rows a card set, so a card row with the
// project's values reads as the project's.
export function fixLink(snapshot: BoardSnapshot, key: string, stage: string | null, hrefs: { card: string; models: string }): ToastLink {
  const project = snapshot.stages.find((found) => found.id === stage)?.starts ?? null;
  const own = project === null ? undefined : snapshot.cards.find((found) => found.key === key)?.starts?.[project.phase];
  const ownRow = own !== undefined && project !== null && (own.engine !== project.engine || own.model !== project.model || own.effort !== project.effort);
  return ownRow ? { label: CARD_LINK, href: hrefs.card } : { label: 'Open Settings, Models', href: hrefs.models };
}

export interface NextStep {
  card: CardView;
  next: StageView | null;
  retry: StageView | null;
  back: { to: string; label: string } | null;
  fixIt: FixIt | null;
  sendBack: SendBack | null;
  // The stage the button starts, whose row the picker reads.
  go: StageView | null;
  fix: { text: string | null; label: string; href: string } | null;
}

/**
 * What the Next step block needs besides the card, read off one snapshot, so the panel, its button and
 * the pill never show two moments. The card page and the peek both call it, so they offer one step.
 * Null for a card the snapshot does not hold.
 */
export function nextStepOf(snapshot: BoardSnapshot, key: string, openComments: number, hrefs: { card: string; models: string }): NextStep | null {
  const forward = forwardMove(snapshot, key);
  if (forward === null) return null;
  const { card, next } = forward;
  // The stage a retry runs again, and the column a move back goes to.
  const retry = retryStage(snapshot, key);
  const to = stageBack(boardFor(snapshot.kind, snapshot.flow), card);
  const back = to === null ? null : { to, label: snapshot.stages.find((one) => one.id === to)?.label ?? to };
  // Fix it on a QA FAIL: Implement goes on with QA's reason, then QA runs again. Its button starts the
  // Implement row, so the picker and a refused start read that row.
  const fixIt = fixItOf(card, snapshot.stages);
  // Send back with comments, while the card has diff comments not sent yet. It goes on in the Implement
  // session too, so the picker, a refusal and the session line read the Implement row.
  const sendBack = sendBackOf(card, snapshot.stages, openComments);
  const go = fixIt?.implement ?? (card.state === 'failed' ? retry : (sendBack?.implement ?? retry ?? next));
  // A refused start says the refused toast's words, with the link to the one place that holds the row.
  // Fix it starts QA too, so a refused QA row is the one to fix when Implement's is fine.
  const refused = [go, fixIt?.qa ?? null].find((stage) => stage !== null && refuseDrop(stage, 'forward') !== null) ?? null;
  const refusal = refused === null ? null : refuseDrop(refused, 'forward');
  let fix: NextStep['fix'] = null;
  if (refused !== null && refusal !== null) {
    const link = fixLink(snapshot, key, refused.id, hrefs);
    fix = { text: refusalFix(refusal, link), label: link.label, href: link.href };
  }
  return { card, next, retry, back, fixIt, sendBack, go, fix };
}

// A move is sent. The card's old toast goes, so a refusal never stays up beside a move that worked.
export function pressed(state: BoardToasts, key: string): BoardToasts {
  const press = state.press + 1;
  return { toasts: dropToast(state.toasts, key), press, latest: { ...state.latest, [key]: press } };
}

// It takes a press too, so a late answer to an earlier move of the same card does not cover it. `link`
// is the setting that fixes it, from `fixLink`.
export function refusedDrop(state: BoardToasts, card: ToastCard, refusal: Refusal, link?: ToastLink): BoardToasts {
  const press = state.press + 1;
  return { toasts: pushToast(state.toasts, refusalToast(card, refusal, link)), press, latest: { ...state.latest, [card.key]: press } };
}

// A move the server took shows nothing, because the stream moves the card.
export function answered(state: BoardToasts, press: number, card: ToastCard, said: Refusal | null): BoardToasts {
  if (said === null || state.latest[card.key] !== press) return state;
  return { ...state, toasts: pushToast(state.toasts, refusalToast(card, said)) };
}

export function cardAdded(state: BoardToasts, card: ToastCard, column: string, note: string | null): BoardToasts {
  return { ...state, toasts: pushToast(state.toasts, { kind: 'success', card, message: `added to ${column}.`, fix: note }) };
}

// Delete card's answer. The card is gone, so the toast has no href and no Open, and the line under it
// names what could not be removed, then what stayed, such as a branch with commits not pushed or the
// card folder. A removal that failed makes it an error, which stays longer; the bell keeps it too.
export function cardDeleted(state: BoardToasts, key: string, said: string, stays: readonly string[], failed: readonly string[] = []): BoardToasts {
  const lines = [...failed, ...stays];
  return { ...state, toasts: pushToast(state.toasts, { kind: failed.length > 0 ? 'error' : 'success', card: { key }, title: said, message: '', fix: lines.length === 0 ? null : lines.join(' ') }) };
}

export function keyCopied(state: BoardToasts, card: ToastCard, copied: boolean): BoardToasts {
  const toast: ToastItem = copied
    ? { kind: 'success', card, message: 'copied to the clipboard.', fix: null }
    : { kind: 'error', card, message: 'not copied. The browser did not allow the clipboard.', fix: 'Select the key on the card and copy it from there.' };
  return { ...state, toasts: pushToast(state.toasts, toast) };
}

// A save on Settings, Project, which posts in place, so the page does not jump and the answer shows here.
// It is about no card: one placeholder key names it, so the next save replaces it. The sentence is the
// title: Saved, what the action said, or the refusal, which also stays under its field. No href, so no
// Open: it would reload the page the person is on, back to the top, and clear the refusal.
export const SETTING_TOAST = 'Settings';

export function settingToast(state: BoardToasts, refused: boolean, data: Record<string, unknown> | undefined): BoardToasts {
  const text = (name: string) => (typeof data?.[name] === 'string' ? data[name] : null);
  const card = { key: SETTING_TOAST };
  const toast: ToastItem = refused ? { kind: 'error', refused: true, card, title: text('message') ?? 'Not saved.', message: '' } : { kind: 'success', card, title: text('said') ?? 'Saved.', message: '' };
  return { ...state, toasts: pushToast(state.toasts, toast) };
}

export function dismissed(state: BoardToasts, key: string): BoardToasts {
  return { ...state, toasts: dropToast(state.toasts, key) };
}

// Waiting on me lives in the address, so a reload keeps it and a link carries it.
export function filterOn(url: URL): boolean {
  return url.searchParams.get('w') === '1';
}

// The query to add to the board's own path, keeping every other parameter.
export function filterQuery(url: URL, on: boolean): string {
  const params = new URLSearchParams(url.searchParams);
  if (on) params.set('w', '1');
  else params.delete('w');
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}
