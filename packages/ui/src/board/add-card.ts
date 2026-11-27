import { type BoardKind, estimateShort, parseTicketRef, pullKey, type StageView, ticketLink } from '@nolzu/protocol';
import { dropTarget, refuseDrop } from './drop.ts';

// What the add button and its dialog say on each board: the
// dialog's title is the button that opened it, and its field asks for what that board takes.
export function addWords(board: BoardKind): { title: string; label: string } {
  if (board === 'epics') return { title: 'Add epic', label: 'Epic title, or a link to a ticket' };
  if (board === 'prreview') return { title: 'Add pull request', label: 'Pull request, as owner/repo#number or a link from GitHub' };
  return { title: 'Add card', label: 'Title, or a link to a ticket or pull request' };
}

// The Add card dialog's fields. `input` is a ticket key or free text.
export interface CardForm {
  input: string;
  description: string;
  // Typed, or copied from another card. Either way it is the new card's extra context.
  extra?: string;
  // The cards the new one is linked to.
  links?: readonly string[];
}

// The project's ticket system, as the server stores it. Local unless Jira was connected.
export type Tickets = 'local' | 'jira';

export interface InputReading {
  // `jira` is read from Jira when the card is added. `connect` is a Jira link on a local project, which
  // the dialog offers to connect, and `linear` a Linear link. Both make a local card as they are.
  kind: 'text' | 'external' | 'local' | 'github' | 'misplaced' | 'empty' | 'jira' | 'connect' | 'linear';
  // What the input will become, said next to the field, so the kind is never a colour alone.
  says: string;
}

// The same reading the server makes, so the dialog never promises a card the server refuses. The
// board is the server's too: the PR reviews board reads a GitHub number as a pull request, and every
// other board reads it as an issue. `off` holds the boards turned off on /projects.
export function readInput(input: string, prefix: string, board: BoardKind = 'delivery', off: readonly BoardKind[] = [], tickets: Tickets = 'local'): InputReading {
  if (input.trim() === '') return { kind: 'empty', says: '' };
  const link = ticketLink(input);
  const kept = (key: string) => `it becomes a local card titled ${key}, with the link in its text.`;
  if (link?.system === 'jira') {
    if (tickets !== 'jira') return { kind: 'connect', says: `Added as it is, ${kept(link.key)}` };
    // The server refuses it, because a key with the local prefix reads as a local card.
    if (parseTicketRef(link.key, prefix).kind === 'local') {
      return { kind: 'local', says: `${link.key} has this project's local key prefix. Change the key prefix in Settings, Project at /settings/project to one no Jira project uses.` };
    }
    return { kind: 'jira', says: fromJira(link.key) };
  }
  if (link?.system === 'linear') return { kind: 'linear', says: `That is a Linear issue. Nolzu cannot read Linear into a card yet, so ${kept(link.key)}` };
  const ref = parseTicketRef(input, prefix);
  switch (ref.kind) {
    case 'text':
      return { kind: 'text', says: 'A new local ticket with this title.' };
    case 'external':
      if (tickets === 'jira') return { kind: 'jira', says: fromJira(ref.key) };
      return { kind: 'external', says: `${ref.key} goes on the board with its key as the title. Nolzu cannot read that ticket system yet.` };
    case 'local':
      return { kind: 'local', says: `${ref.key} is a local key, and Nolzu numbers local cards itself. Type a title to make a new card.` };
    case 'github': {
      // A link says what it points at, and the server never looks: it reads the number by the board.
      const linked = /\/(issues|pull)\/\d+\/?$/.exec(input.trim())?.[1];
      const pulls = board === 'prreview';
      if (!pulls && linked === 'pull') {
        // An off board is not in the rail, so the hint names the switch that brings it back.
        if (off.includes('prreview')) {
          return {
            kind: 'misplaced',
            says: 'This link is a pull request, and the PR reviews board is off. Turn it on under Boards in Settings, Project at /settings/project, then add the link on the PR reviews board.',
          };
        }
        return { kind: 'misplaced', says: 'This link is a pull request. Add it on the PR reviews board.' };
      }
      if (pulls && linked === 'issues') return { kind: 'misplaced', says: 'This link is an issue, and the PR reviews board takes pull requests only.' };
      const named = `${ref.owner === null ? '' : `${ref.owner}/`}${ref.repo}#${ref.number}`;
      const says = [`Nolzu reads ${pulls ? 'pull request' : 'issue'} ${named} from GitHub when you add the card.`];
      // The server takes the owner from the project's remote, and refuses the card when there is none.
      if (ref.owner === null) says.push('The owner comes from the GitHub remote of this project.');
      return { kind: 'github', says: says.join(' ') };
    }
  }
}

const fromJira = (key: string) => `Nolzu reads ${key} from Jira when you add the card.`;

// A GitHub issue or pull request is sent too. Whether gh can read it is known on the server alone, and
// the server says so in its own sentence.
export function canSubmit(form: CardForm, prefix: string, board: BoardKind = 'delivery', tickets: Tickets = 'local'): boolean {
  const kind = readInput(form.input, prefix, board, [], tickets).kind;
  return kind !== 'empty' && kind !== 'local' && kind !== 'misplaced';
}

export interface CardPayload {
  input: string;
  title?: string;
  description?: string;
  extra?: string;
  links?: readonly string[];
}

// What POST /api/cards takes. A key carries no title, because the ticket is its own title.
export function cardPayload(form: CardForm, prefix: string): CardPayload {
  const input = form.input.trim();
  const around = { ...(form.extra === undefined ? {} : { extra: form.extra }), ...(form.links === undefined ? {} : { links: form.links }) };
  if (readInput(input, prefix).kind !== 'text') return { input, ...around };
  return { input, title: input, description: form.description, ...around };
}

// Context copied from another card fills an empty field. Over text the person typed it waits for a yes,
// because that text is theirs.
export function copyContext(current: string, copied: string): { text: string; ask: boolean } {
  return current.trim() === '' ? { text: copied, ask: false } : { text: current, ask: true };
}

// The key the card gets, shown beside the title. Free text takes the next local number, which the server
// reads with the code that hands it out, as `next`. A ticket key is its own key, and a GitHub issue or
// pull request takes the key the runner makes from it. Null where the input makes no card.
export function cardKey(input: string, prefix: string, board: BoardKind, next: string | null, tickets: Tickets = 'local'): string | null {
  const kind = readInput(input, prefix, board, [], tickets).kind;
  const ref = parseTicketRef(input, prefix);
  if (kind === 'text' || kind === 'connect' || kind === 'linear') return next;
  if (kind === 'jira') {
    const link = ticketLink(input);
    return link?.system === 'jira' ? link.key : ref.kind === 'external' ? ref.key : null;
  }
  if (kind === 'external' && ref.kind === 'external') return ref.key;
  if (kind === 'github' && ref.kind === 'github') return pullKey(ref.repo, ref.number);
  return null;
}

// What a key press in the dialog asks for. Cmd Enter adds the card and never starts a run, so fast typing
// cannot spend money. Shift Cmd Enter is the go button. Ctrl stands in for Cmd off a Mac.
export function pressOf(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): 'add' | 'start' | null {
  if (event.key !== 'Enter' || event.altKey || !(event.metaKey || event.ctrlKey)) return null;
  return event.shiftKey ? 'start' : 'add';
}

// What the two buttons say for the chosen board, read off its stages in the live snapshot: the column a
// card lands in, and the stage the go button starts, with the drop box's line and an estimate only where
// runs measured one. `refused` is why a drop there would be refused. The button still adds the card, and
// the page raises that refusal, so fast typing never starts a run. Nothing is offered before the board's first snapshot.
export interface StartOffer {
  first: string | null;
  stage: string | null;
  line: string | null;
  refused: string | null;
}

export function startOffer(stages: readonly StageView[] | undefined): StartOffer {
  const first = stages?.[0]?.label ?? null;
  // The one move a new card can make, to the column after its first, as a drop would.
  const next = stages?.[1];
  if (next === undefined) return { first, stage: null, line: null, refused: null };
  // The words of the toast the press raises. The card does not exist yet, so it has no settings of its
  // own, and the fix is in Settings, Models.
  const refusal = refuseDrop(next, 'forward');
  if (refusal !== null) {
    const fix = refusal.act === undefined ? refusal.fix : `${refusal.act} in Settings, Models.`;
    return { first, stage: next.label, line: null, refused: fix === null ? refusal.message : `${refusal.message} ${fix}` };
  }
  // refuseDrop reads the fields dropTarget refuses on, so what is left starts a run or nothing.
  const target = dropTarget(next, true);
  if (target.kind !== 'starts') return { first, stage: null, line: null, refused: null };
  const estimate = next.starts?.estimate;
  return { first, stage: next.label, line: estimate === undefined ? target.command : `${target.command} · ${estimateShort(estimate)}`, refused: null };
}

// A ticket assigned to the person with no card in this project yet. A press posts `input` as the card's
// input, the link or the key a person would paste.
export interface MyTicket {
  key: string;
  title: string;
  input: string;
}

// What the server read. `asked` is false when the project has no source to ask, and `problems` holds a
// sentence for each source that failed.
export interface MyTickets {
  asked: boolean;
  tickets: readonly MyTicket[];
  problems: readonly string[];
}

// Under an empty field only, because a typed title or key is a card already on its way. Not on the PR
// reviews board, which reads a GitHub number as a pull request.
export function showMine(mine: MyTickets | null, board: BoardKind, input: string): mine is MyTickets {
  return mine !== null && mine.asked && board !== 'prreview' && input.trim() === '';
}

// The line beside "Your tickets". Empty when a source failed and nothing came back, because its sentence says enough.
export function mineLine(mine: MyTickets): string {
  if (mine.tickets.length > 0) return `${mine.tickets.length} without a card`;
  return mine.problems.length > 0 ? '' : 'Nothing assigned to you is waiting for a card.';
}
