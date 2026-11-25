import type { DatabaseSync } from 'node:sqlite';
import { boardFor, nextStage, projectRepos } from '@nolzu/core';
import { createCard, createLocalTicket, getSetting, linkCards, type NewCard, peekLocalKey, resolveDataDir, setCardRepos, setExtraContext } from '@nolzu/core/node';
import { BOARD_KINDS, type BoardKind, type CardSize, isBoardKind, isCardSize, keyPrefixFor, parseTicketRef, type TicketAdapter, type TicketRef, ticketLink } from '@nolzu/protocol';
import { createKeychain, FROM_EPIC_FILE, writeCardFile, getPull, ghRunner, git, gitEnv, githubIssues, type GitHubOptions, issueKey, type JiraFetch, type Keychain, parseRemote, repoFolder, type RunGh, runKeychain } from '@nolzu/runner';
import { cardFolder } from './files.ts';
import { CONTEXT_LIMIT } from './overview.ts';
import { jiraReader } from './ticket-system.ts';

// What the Add card dialog sends. `input` is a ticket key or free text, read by parseTicketRef.
export interface CardRequest {
  input: string;
  // For free text: the title, when the person wrote one apart from the input, and the description.
  title?: string;
  description?: string;
  // Typed, or copied from another card in the dialog. Either way it is the new card's extra context.
  extra?: string;
  // Cards to link to the new one.
  links?: readonly string[];
  board?: string;
  // What the person picked. Left out means none.
  size?: CardSize;
}

export interface MadeCard {
  key: string;
  // Said to the person when the card was made but something about it is missing.
  note: string | null;
}

// The ticket systems this call may read. Each one is optional, so a test hands in only the one it
// is about, and a caller with neither still makes local cards.
export interface TicketSources {
  // For a key such as PROJ-123, or a pasted Jira link. A function where reaching the adapter costs
  // something: the route's reads the Jira token from the keychain, so it is called only once a key or
  // a link was given. Null from it, or no adapter, keeps a typed key as an external card.
  external?: TicketAdapter | (() => Promise<TicketAdapter | null>) | null;
  // How to reach `gh`, and the owner a ref without one takes, given the repository it names. A
  // function, because finding that owner spawns git, and a card made from free text or a local key
  // needs neither. `several` lists the owners when more than one repository has that name.
  github?: ((repo?: string) => Promise<GitHubOptions & { several?: readonly string[] }>) | null;
}

// How long a ticket read may take before the person gets a sentence instead of a dialog that spins.
// A read of one issue is a single GraphQL call, so anything past this is a call that will not come
// back: a dead proxy, a host that never answers, a `gh` waiting on something.
export const READ_TIMEOUT_MS = 30_000;

// The sources are arguments, so a test hands in stubs and the route hands in the real `gh`. An
// external key with no adapter is kept with its ref rather than refused, so the card is there for
// an adapter to fill in later.
export async function createCardFrom(db: DatabaseSync, sources: TicketSources, request: CardRequest): Promise<MadeCard> {
  // A card can be made on any of the five, and a forward move there starts the phase its stage
  // names, with the engine, the model and the effort of that phase's row in the action table.
  const asked = request.board ?? 'delivery';
  if (!isBoardKind(asked)) throw new Error(`There is no ${asked} board here. A card goes on one of these: ${BOARD_KINDS.join(', ')}.`);
  const board: BoardKind = asked;
  const prefix = getSetting(db, 'localKeyPrefix');
  // Where a new card lands, which is not `inbox` everywhere: the PR reviews board starts at Incoming,
  // and a card written to a stage its board has not got sits in the database with no column to draw it.
  const first = boardFor(board, getSetting(db, 'deliveryFlow')).stages[0]?.id ?? 'inbox';
  let ref: TicketRef = parseTicketRef(request.input, prefix);
  // A Jira link reads as its key on a Jira project. Anywhere else a Jira or a Linear link is a local
  // card titled with its key, with the link in its text: Keep it as a local card in the dialog.
  const link = ticketLink(request.input);
  let kept: { title: string; description: string } | null = null;
  if (link !== null && link.system !== 'github') {
    if (link.system === 'jira' && getSetting(db, 'ticketSystem') === 'jira') {
      ref = { kind: 'external', key: jiraLinkKey(db, link, prefix) };
    } else {
      const text = request.description?.trim() ?? '';
      kept = { title: request.title?.trim() || link.key, description: text === '' ? request.input.trim() : `${text}\n\n${request.input.trim()}` };
    }
  }

  // Read before the write, so nothing is written for a ticket the source does not have.
  let external:
    | {
        key: string;
        title: string;
        summary: string | null;
        source: string;
        note: string | null;
        // What GitHub knows the card by, when that is not the card's key. A pull request card and an
        // issue card are keyed `repo#number`, because a key with a slash in it gets no card folder.
        ref?: string;
        pull?: NewCard['pull'];
        // The project repository a pull request belongs to, so its review knows where to look.
        repo?: string | null;
      }
    | null = null;
  if (ref.kind === 'github') {
    const source = sources.github;
    if (source === undefined || source === null) {
      throw new Error(
        board === 'prreview'
          ? 'Nolzu cannot read GitHub on this machine, so it cannot open a pull request. Install the GitHub CLI from https://cli.github.com, then start Nolzu again.'
          : 'Nolzu cannot read GitHub issues on this machine. Type the issue title to make a local card.',
      );
    }
    // Asked before the read, because the adapter reads nothing under a guessed owner and would
    // answer the same way as a call that failed.
    const { options, owner } = await ownerOf(source, ref);
    const full = issueKey(owner, ref.repo, ref.number);
    if (board === 'prreview') {
      // A number on this board is a pull request, not a ticket. The same seam reads it: one
      // GraphQL document through the same `gh`, and nothing new spawns a process.
      const found = await getPull(options.run, { owner, repo: ref.repo, number: ref.number }, AbortSignal.timeout(READ_TIMEOUT_MS));
      if (found.pull === null) {
        // Two states, and one fix each. GitHub answered and the pull request is not there, or the
        // call never got an answer and the pull request may be fine.
        throw new Error(
          found.notFound
            ? `GitHub has no pull request ${full}. The number may belong to an issue, the pull request may be gone, or this login may not open that repository.`
            : `${full} could not be read from GitHub. The call failed, so the pull request may still be there. Try again.`,
        );
      }
      if (found.pull.state !== 'open') {
        throw new Error(`${full} is ${found.pull.state}, so there is nothing to review. Type the number of a pull request that is still open.`);
      }
      const other = heldBy(db, found.pull.key, full);
      if (other !== null) {
        throw new Error(`${found.pull.key} on the board is ${other}. A card key carries no owner, so ${full} cannot go on the board as well. Review it on GitHub instead.`);
      }
      const { author, body, decision, headCommittedAt, draft, title, headSha, commits } = found.pull;
      external = {
        key: found.pull.key,
        title,
        // The description, as the card's ticket text. The review skill reads it to know what the
        // change is meant to do, and a review with no statement of intent is half a review.
        summary: body === '' ? null : body,
        source: 'github-pr',
        note: null,
        ref: full,
        // The head and the count as well, so a review of a card added by its number has a head to
        // compare the next read with.
        pull: { author, decision, headCommittedAt, draft, ...(headSha === undefined ? {} : { headSha }), ...(commits === undefined ? {} : { commits }) },
        repo: await originRepo(db, owner, ref.repo),
      };
    } else {
      external = { ...(await readIssue(db, options, ref, owner, 'Type its title to make a local card instead.')), note: null };
    }
  }
  if (ref.kind === 'local') {
    // Local keys are counted, so a typed one is either a card that exists or a mistake.
    const exists = db.prepare('SELECT key FROM cards WHERE key = ?').get(ref.key) !== undefined;
    throw new Error(exists ? `${ref.key} is already on the board. Open that card instead.` : `There is no card ${ref.key}. Type a title to make a new ${prefix} card.`);
  }
  if (ref.kind === 'external') {
    const adapter = typeof sources.external === 'function' ? await sources.external() : (sources.external ?? null);
    if (adapter === null) {
      external = { key: ref.key, title: ref.key, summary: null, source: 'external', note: `${ref.key} is on the board, but the ticket is not loaded, because Nolzu cannot read that ticket system yet.` };
    } else {
      const found = await readExternal(adapter, ref.key);
      external = { key: ref.key, title: found.title, summary: found.body, source: adapter.name, note: null };
    }
  }

  const title = kept?.title ?? (request.title?.trim() || (ref.kind === 'text' ? ref.text : ''));
  if (external === null && title === '') throw new Error('A card needs a title or a ticket key.');

  // One write, so a link that fails leaves no card behind and uses up no key.
  db.exec('BEGIN IMMEDIATE');
  try {
    let key: string;
    if (external === null) {
      key = createLocalTicket(db, { projectId: 1, prefix, title, description: kept?.description ?? request.description?.trim() ?? '', board, stage: first, size: request.size }).key;
    } else {
      key = external.key;
      createCard(db, {
        key,
        board,
        stage: first,
        title: external.title,
        summary: external.summary,
        source: external.source,
        sourceRef: external.ref ?? external.key,
        pull: external.pull ?? null,
        size: request.size,
      });
      if (external.repo != null) setCardRepos(db, key, [external.repo], 'person');
    }
    if (request.extra !== undefined && request.extra.trim() !== '') setExtraContext(db, key, request.extra);
    // After the card row, because a link names two cards that both have to exist.
    for (const other of request.links ?? []) linkCards(db, key, other);
    db.exec('COMMIT');
    return { key, note: external?.note ?? null };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// One GitHub issue read through `gh`, or the sentence that says which of two states it is in, with one
// fix each: GitHub answered and the issue is not there, or the call never got an answer and the issue
// may be fine. An issue whose `repo#number` key another repository's card holds is refused, with `instead`.
async function readIssue(db: DatabaseSync, options: GitHubOptions, ref: Extract<TicketRef, { kind: 'github' }>, owner: string, instead: string): Promise<LinkedTicket & { ref: string }> {
  const full = issueKey(owner, ref.repo, ref.number);
  const adapter = githubIssues(options);
  const [found] = await adapter.get([{ ...ref, owner }], AbortSignal.timeout(READ_TIMEOUT_MS));
  if (found === undefined || found.ticket === null) {
    throw new Error(
      found?.notFound === true
        ? `GitHub has no issue ${full}. The number may belong to a pull request, the issue may be gone, or this login may not open that repository.`
        : `${full} could not be read from GitHub. The call failed, so the issue may still be there. Try again.`,
    );
  }
  const other = heldBy(db, found.ticket.key, full);
  if (other !== null) throw new Error(`${found.ticket.key} on the board is ${other}. A card key carries no owner, so ${full} cannot go on the board as well. ${instead}`);
  return { key: found.ticket.key, title: found.ticket.title, summary: found.ticket.body, source: adapter.name, ref: full };
}

// The owner a GitHub ref takes: its own, or the one `refOwner` finds for its repository, or the sentence
// that says to type it.
async function ownerOf(source: NonNullable<TicketSources['github']>, ref: Extract<TicketRef, { kind: 'github' }>): Promise<{ options: GitHubOptions; owner: string }> {
  const options = await source(ref.repo);
  const owner = ref.owner ?? options.defaultOwner;
  const several = options.several ?? [];
  if (owner === null && several.length > 1) {
    throw new Error(
      `Type the owner as well, as in ${several[0]}/${ref.repo}#${ref.number}. ${several.length === 2 ? 'Two' : several.length} repositories of this project are called ${ref.repo}, from ${several.slice(0, -1).join(', ')} and ${several.at(-1)}, so Nolzu does not know which one you mean.`,
    );
  }
  if (owner === null) {
    throw new Error(`Type the owner as well, as in owner/${ref.repo}#${ref.number}. No repository of this project has a GitHub origin called ${ref.repo}, so Nolzu does not know whose ${ref.repo} you mean.`);
  }
  return { options, owner };
}

// The key of a pasted Jira link on a Jira project. The key is read from the site the project set, and
// a key of another site is another ticket. A key with the local prefix reads as a local card, so it
// cannot be a Jira card as well.
function jiraLinkKey(db: DatabaseSync, link: { host: string; key: string }, prefix: string): string {
  const site = getSetting(db, 'jiraSite');
  const host = site === null ? null : new URL(site).host;
  if (host !== null && host !== link.host) {
    throw new Error(`That link is on ${link.host}, and this project reads Jira at ${host}. Paste a link from ${host}, or type the key.`);
  }
  if (parseTicketRef(link.key, prefix).kind === 'local') {
    throw new Error(`${link.key} has this project's local key prefix, so it reads as a local card. Change the key prefix in Settings, Project at /settings/project to one no Jira project uses.`);
  }
  return link.key;
}

// One ticket read through the adapter, or the sentence that says which of two states it is in, with
// one fix each. Jira answers a refused token with the same 404 and the same sentence as a ticket that
// is gone, so a read that only looked at the status would send the person to Jira to hunt for a
// ticket that is fine. The adapter tells the two apart and refuses a refused token with its own
// sentence, which arrives here as a call that failed.
async function readExternal(adapter: TicketAdapter, key: string): Promise<{ title: string; body: string | null }> {
  const [found] = await adapter.get([{ kind: 'external', key }], AbortSignal.timeout(READ_TIMEOUT_MS));
  if (found === undefined || found.ticket === null) {
    const system = adapter.title ?? adapter.name;
    throw new Error(
      found?.notFound === true
        ? `${key} is not in ${system}. The key may be wrong, the ticket may be gone, or this account may not see that project.`
        : `${key} could not be read from ${system}. The call failed, so the ticket may still be there. Try again.`,
    );
  }
  return { title: found.ticket.title, body: found.ticket.body };
}

// A ticket of the project's ticket system an epic's task is linked to, read before anything is written.
export interface LinkedTicket {
  key: string;
  title: string;
  summary: string | null;
  source: string;
  // What GitHub knows an issue by, `owner/repo#number`, when that is not the key.
  ref?: string;
}

/**
 * Reads one ticket of the project's ticket system by its key or a pasted link, through the reader Add
 * card uses, and writes nothing. An epic's task row links to it, and Add makes the card from it. A ref
 * that names no ticket of that system, or a ticket that is a card already, is refused with the reason.
 */
export async function readTicket(db: DatabaseSync, sources: Pick<TicketSources, 'external' | 'github'>, input: string): Promise<LinkedTicket> {
  const prefix = getSetting(db, 'localKeyPrefix');
  // A project of local tickets links a task to a GitHub issue, read the way Add card reads one.
  if (getSetting(db, 'ticketSystem') !== 'jira') return readIssueRef(db, sources.github ?? null, input.trim(), prefix);
  const external = sources.external;
  const adapter = typeof external === 'function' ? await external() : (external ?? null);
  if (adapter === null) throw new Error('This project keeps local tickets, so a task has no ticket system to link to.');
  const system = adapter.title ?? adapter.name;
  const asked = input.trim();
  const link = ticketLink(asked);
  let key: string;
  if (link !== null) {
    if (link.system !== 'jira') throw new Error(`That link is not a ${system} ticket. Paste a ${system} key, such as PROJ-123, or a link to one.`);
    key = jiraLinkKey(db, link, prefix);
  } else {
    const ref = parseTicketRef(asked, prefix);
    if (ref.kind !== 'external') throw new Error(`${asked === '' ? 'Nothing' : `"${asked}"`} is not a ${system} key. Paste a key, such as PROJ-123, or a link to the ticket.`);
    key = ref.key;
  }
  const card = db.prepare('SELECT board FROM cards WHERE key = ?').get(key) as { board: string } | undefined;
  if (card !== undefined) throw new Error(`${key} is a card on the ${card.board} board already. Open that card, or link another ticket.`);
  const found = await readExternal(adapter, key);
  return { key, title: found.title, summary: found.body, source: adapter.name };
}

// A task row's GitHub issue: a link, `owner/repo#number` or `repo#number`. Refused with the reason for
// anything else, for an issue that is a card already, and where Nolzu cannot reach GitHub.
async function readIssueRef(db: DatabaseSync, source: TicketSources['github'] | null, asked: string, prefix: string): Promise<LinkedTicket> {
  const ref = parseTicketRef(asked, prefix);
  if (ref.kind !== 'github') throw new Error(`${asked === '' ? 'Nothing' : `"${asked}"`} is not a GitHub issue. Paste a link to the issue, or type it as repo#12 or owner/repo#12.`);
  if (source === undefined || source === null) throw new Error('Nolzu cannot read GitHub issues on this machine. Install the GitHub CLI from https://cli.github.com, then start Nolzu again.');
  const { options, owner } = await ownerOf(source, ref);
  const found = await readIssue(db, options, ref, owner, 'Link another issue.');
  const card = db.prepare('SELECT board FROM cards WHERE key = ?').get(found.key) as { board: string } | undefined;
  if (card !== undefined) throw new Error(`${found.key} is a card on the ${card.board} board already. Open that card, or link another issue.`);
  return found;
}

// The full name of the GitHub issue or pull request that holds this key already, when it is not `full`.
// Two repositories can carry the same name, and the key carries no owner. Without this the person
// reads that recipes#42 is already on the board and opens somebody else's card.
// Limit: the key shape stays repo#number, so one name holds one issue or pull request at a time.
function heldBy(db: DatabaseSync, key: string, full: string): string | null {
  const taken = db.prepare('SELECT source_ref FROM cards WHERE key = ?').get(key) as { source_ref: string | null } | undefined;
  return taken !== undefined && taken.source_ref !== null && taken.source_ref !== full ? taken.source_ref : null;
}

/**
 * The tasks of an epic: one Delivery card per title, each linked back to the epic.
 *
 * The epic's page sends the steps of its plan with the key each row showed, which the person may have
 * typed over, or a list the person wrote with no keys. A task with no key takes the next local key.
 * A plan step also sends its shareable description, which the card keeps as its ticket under one line
 * naming the epic, its internal notes, which go to `FROM_EPIC_FILE` in the card folder for every run of
 * the card to read, and the step it was made from, which the link keeps so a retitled task still
 * answers its step. A row linked to a ticket of the project's ticket system becomes that ticket's card,
 * with its own title and text, the way Add card makes one; `postTasks` read the ticket before this.
 *
 * One transaction for the whole list. Three cards with no link back, or an epic counting tasks that
 * were never written, are both worse than adding nothing. `createCardFrom` cannot be looped here,
 * because it opens a transaction of its own. The notes are written after it, so a list that failed
 * leaves no notes for the key the next card takes.
 */
export function addTasks(
  db: DatabaseSync,
  epicKey: string,
  titles: readonly string[],
  keys: readonly string[] = [],
  descriptions: readonly string[] = [],
  steps: readonly string[] = [],
  linked: readonly (LinkedTicket | null)[] = [],
  notes: readonly string[] = [],
  folderOf: (key: string) => string | null = (key) => cardFolder(db, key),
): { keys: string[]; note?: string } {
  const wanted = titles
    .map((title, at) => ({ title: title.trim(), key: keys[at]?.trim() ?? '', description: descriptions[at]?.trim() ?? '', step: steps[at]?.trim() ?? '', ticket: linked[at] ?? null, notes: notes[at]?.trim() ?? '' }))
    .filter((task) => task.title !== '');
  if (wanted.length === 0) throw new Error('A task needs a title. Write one task per line, then add them again.');
  const epic = db.prepare('SELECT board, title FROM cards WHERE key = ?').get(epicKey) as { board: string; title: string } | undefined;
  if (epic === undefined) throw new Error(`There is no card ${epicKey} here, so it has nothing to deliver.`);
  if (epic.board !== 'epics') throw new Error(`${epicKey} is not on the Epics board. An epic delivers tasks, a card on another board does not.`);

  const prefix = getSetting(db, 'localKeyPrefix');
  // The Delivery board's own first stage, read the way `createCardFrom` reads it above. `inbox` is
  // that stage today, and writing it out here is how the rule would drift.
  const first = boardFor('delivery', getSetting(db, 'deliveryFlow')).stages[0]?.id ?? 'inbox';
  let made: { key: string; notes: string }[];
  db.exec('BEGIN IMMEDIATE');
  try {
    made = wanted.map(({ title, key: asked, description: body, step, ticket, notes: told }) => {
      const description = body === '' ? '' : `Part of ${epicKey}: ${epic.title.replace(/\.+$/, '')}.\n\n${body}`;
      // The epic and its tasks share one key counter, so an epic RECI-1 gives RECI-2 and on. A key the
      // row sent leaves the counter alone: the next peek steps over a number a card holds.
      let key: string;
      if (ticket !== null) {
        key = ticket.key;
        createCard(db, { key, board: 'delivery', stage: first, title: ticket.title, summary: ticket.summary, source: ticket.source, sourceRef: ticket.ref ?? ticket.key });
      } else if (asked === '') {
        key = createLocalTicket(db, { projectId: 1, prefix, title, description, board: 'delivery', stage: first }).key;
      } else {
        key = asked;
        createCard(db, { key, board: 'delivery', stage: first, title, summary: description === '' ? null : description });
      }
      // After the card row, because a link names two cards that both have to exist.
      linkCards(db, epicKey, key);
      if (step !== '') db.prepare('UPDATE card_links SET step = ? WHERE a = min(?, ?) AND b = max(?, ?)').run(step, epicKey, key, epicKey, key);
      return { key, notes: told };
    });
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  // The cards are in. A note that cannot be written loses that task its notes and not its card.
  const unwritten = made.filter(({ key, notes: told }) => {
    if (told === '') return false;
    const folder = folderOf(key);
    if (folder === null) return true;
    try {
      writeCardFile(folder, FROM_EPIC_FILE, `${told}\n`);
      return false;
    } catch {
      return true;
    }
  });
  const result = { keys: made.map((one) => one.key) };
  return unwritten.length === 0
    ? result
    : { ...result, note: `The epic's notes could not be written for ${unwritten.map((one) => one.key).join(', ')}. Add them to the extra context of ${unwritten.length === 1 ? 'that card' : 'those cards'}.` };
}

/**
 * The owner a ref such as `recipes#12` belongs to: the one the project's own remote points at.
 *
 * Null for anything else, and nothing is guessed. `parseTicketRef` reads no owner out of a bare
 * `#12`, so a ref always names its repository and only the owner comes from here.
 */
export async function remoteOwner(db: DatabaseSync): Promise<string | null> {
  return (await remoteRepo(db))?.owner ?? null;
}

/**
 * The owner a ref such as `recipes#12` takes in this project: the one whose repository of that name
 * a project repository's GitHub origin points at. With no such repository, the one owner every origin
 * shares, as in a project of one repository. Null with the owners in `several` when two repositories
 * have the name, and null alone when nothing settles it, because a guessed owner reads somebody
 * else's repository.
 */
export async function refOwner(db: DatabaseSync, name: string): Promise<{ owner: string | null; several: string[] }> {
  const repos = projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') });
  const origins = (await Promise.all(repos.map((one) => remoteRepo(db, one.path)))).filter((one) => one !== null);
  const named = [...new Set(origins.filter((one) => one.repo.toLowerCase() === name.toLowerCase()).map((one) => one.owner))];
  if (named.length > 1) return { owner: null, several: named };
  const owners = [...new Set(origins.map((one) => one.owner))];
  return { owner: named[0] ?? (owners.length === 1 ? (owners[0] ?? null) : null), several: [] };
}

// Add card's way to GitHub: the person's `gh`, and the owner `refOwner` finds for the ref's repository.
export const githubSource =
  (db: DatabaseSync, run: RunGh) =>
  async (repo?: string): Promise<GitHubOptions & { several: string[] }> => {
    const found = await refOwner(db, repo ?? '');
    return { run, defaultOwner: found.owner, several: found.several };
  };

// The project repository whose GitHub origin is owner/name, or null when none is. A pull request card
// works in that one, and on a project of several repositories nothing else says which.
export async function originRepo(db: DatabaseSync, owner: string, name: string): Promise<string | null> {
  const same = (one: { owner: string; repo: string } | null) => one !== null && one.owner.toLowerCase() === owner.toLowerCase() && one.repo.toLowerCase() === name.toLowerCase();
  for (const one of projectRepos({ repos: getSetting(db, 'repos'), baseBranch: getSetting(db, 'baseBranch') })) {
    if (same(await remoteRepo(db, one.path))) return one.path;
  }
  return null;
}

// The repository the `origin` of one project repository points at. The project folder's own is the one
// the PR reviews board reads, and PR watch reads each repository a Delivery card works in.
export async function remoteRepo(db: DatabaseSync, repo = '.'): Promise<{ owner: string; repo: string } | null> {
  const path = getSetting(db, 'projectPath');
  if (path === null) return null;
  try {
    const found = await git(['remote', 'get-url', 'origin'], { cwd: repoFolder(path, repo), env: gitEnv(process.env) });
    if (found.code !== 0) return null;
    // The same reading the project scan uses, so one remote never means two things in one product.
    // github.com only: another host may be a GitHub Enterprise install, and `gh` here talks to
    // github.com.
    const place = parseRemote('origin', found.stdout.trim());
    return place.supported && place.host === 'github' ? { owner: place.owner, repo: place.repo } : null;
  } catch {
    // A project folder that is gone, or one that is not a repository. Neither is a reason to
    // refuse a card, so the ref has to name its owner.
    return null;
  }
}

const answer = (status: number, body: object): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const text = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string';

// How Add and start starts a card: the route hands in the move a drop sends, so the start has the same
// rules and refusals. Null when it started, else the sentence and status the move answered.
export type StartCard = (key: string, to: string) => Promise<{ status: number; message: string } | null>;

// The keychain and the fetch a Jira read takes, so a test hands in fakes and nothing reaches a keychain
// or a Jira site.
export interface JiraSeams {
  keychain?: Keychain;
  fetcher?: JiraFetch;
}

// `told` tells the open boards, because a new card changes what they show and no run starts to say so.
// `run` is the real `gh` unless a test hands in its own, as the pull request routes take it.
export async function postCard(
  db: DatabaseSync,
  told: () => void,
  request: Request,
  run: RunGh = ghRunner(),
  startCard: StartCard | null = null,
  jira: JiraSeams = {},
): Promise<Response> {
  let asked: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    asked = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    asked = {};
  }
  const { input, title, description, extra, links, board, size, start } = asked;
  const linksOk = links === undefined || (Array.isArray(links) && links.every((link) => typeof link === 'string'));
  if (typeof input !== 'string' || !text(title) || !text(description) || !text(extra) || !text(board) || !linksOk) {
    return answer(400, { message: 'A new card needs its input as text, and links as a list of card keys.' });
  }
  if (!(size === undefined || isCardSize(size)) || !(start === undefined || typeof start === 'boolean')) {
    return answer(400, { message: 'A card size is small, medium or large, and start is true or false.' });
  }
  if (extra !== undefined && Buffer.byteLength(extra, 'utf8') > CONTEXT_LIMIT) {
    return answer(413, { message: `The extra context is over ${CONTEXT_LIMIT / 1000} kB, which is the limit. Shorten it and add the card again.` });
  }

  try {
    const sources: TicketSources = {
      github: githubSource(db, run),
      external: () => jiraReader(db, jira.keychain ?? createKeychain(process.platform, runKeychain, resolveDataDir(process.env)), jira.fetcher),
    };
    const made = await createCardFrom(db, sources, { input, title, description, extra, links: links as string[] | undefined, board, size });
    told();
    if (start !== true) return answer(201, made);
    // After the card is written, so a refused start leaves it in its first column and the dialog still
    // closes on its key. A second card is never made for a start.
    const refused = await startFirst(db, made.key, board ?? 'delivery', startCard);
    return answer(201, refused === null ? made : { ...made, refused });
  } catch (error) {
    // The service's own sentence, which names the card or the key the person typed.
    return answer(409, { message: (error as Error).message });
  }
}

// The one move a new card can make, to the stage after its first, which is the board's first auto stage.
// `createCardFrom` has checked the board by now.
async function startFirst(db: DatabaseSync, key: string, board: string, startCard: StartCard | null): Promise<string | null> {
  const steps = boardFor(board as BoardKind, getSetting(db, 'deliveryFlow'));
  const to = nextStage(steps, steps.stages[0]?.id ?? '')?.id;
  if (to === undefined || startCard === null) return `${key} was added, and Nolzu started no run from here. Move the card to start one.`;
  return (await startCard(key, to))?.message ?? null;
}

// The key the next local card on `board` gets, for Add card to show. It is read with the code
// `createLocalTicket` picks its key with, so the two agree unless another card takes the number first.
export function nextCardKey(db: DatabaseSync, board: BoardKind = 'delivery'): string {
  return peekLocalKey(db, 1, keyPrefixFor(board, getSetting(db, 'localKeyPrefix'))).key;
}

// The POST /api/card/[key]/tasks body reader, `{ titles, keys?, descriptions?, steps?, refs?, notes? }`.
// `told` tells the open boards: the epic's count moved and the new cards are on the Delivery board, and
// no run starts to say so. Every ref is read before anything is written, so a read that fails adds
// nothing, and a key linked on two rows is refused.
export async function postTasks(db: DatabaseSync, told: () => void, key: string, request: Request, sources: Pick<TicketSources, 'external' | 'github'> | null = null): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const titles = (body as { titles?: unknown } | null)?.titles;
  if (!Array.isArray(titles) || !titles.every((title) => typeof title === 'string')) {
    return answer(400, { message: 'The tasks need a list of titles, one title per task.' });
  }
  const keys = (body as { keys?: unknown }).keys;
  if (keys !== undefined && !(Array.isArray(keys) && keys.length === titles.length && keys.every((one) => typeof one === 'string'))) {
    return answer(400, { message: 'The keys need one key per title, or none.' });
  }
  const texts = (name: 'descriptions' | 'steps' | 'refs' | 'notes') => (body as Record<string, unknown>)[name] as string[] | undefined;
  const textsOk = (list: unknown) => list === undefined || (Array.isArray(list) && list.length === titles.length && list.every((one) => typeof one === 'string'));
  if (!textsOk(texts('descriptions')) || !textsOk(texts('steps')) || !textsOk(texts('refs')) || !textsOk(texts('notes'))) {
    return answer(400, { message: 'The descriptions, steps, refs and notes need one text per title, or none.' });
  }
  try {
    const refs = (texts('refs') ?? []).map((ref) => ref.trim());
    const linked: (LinkedTicket | null)[] = [];
    for (const ref of refs) linked.push(ref === '' ? null : await readTicket(db, ticketSources(db, sources), ref));
    const twice = linked.find((one, at) => one !== null && linked.findIndex((other) => other?.key === one.key) !== at);
    if (twice != null) throw new Error(`${twice.key} is linked on two tasks. Unlink it from one of them, then add them again.`);
    const made = addTasks(db, key, titles as string[], keys as string[] | undefined, texts('descriptions'), texts('steps'), linked, texts('notes'));
    told();
    return answer(201, made);
  } catch (error) {
    // The service's own sentence, which names the epic, the ticket or what the list is missing.
    return answer(409, { message: (error as Error).message });
  }
}

// GET /api/tickets/read?ref=..., what Link on an epic's task row asks: the ticket's key and its own
// title, or the sentence it was refused with. Nothing is written.
export async function getTicket(db: DatabaseSync, ref: string, sources: Pick<TicketSources, 'external' | 'github'> | null = null): Promise<Response> {
  try {
    const found = await readTicket(db, ticketSources(db, sources), ref);
    // A GitHub issue's full name too, which Add sends back, so the owner typed here is the one read then.
    return answer(200, { key: found.key, title: found.title, ...(found.ref === undefined ? {} : { ref: found.ref }) });
  } catch (error) {
    return answer(409, { message: (error as Error).message });
  }
}

// The readers a task row's link takes: the caller's, or Jira through the keychain and the person's `gh`.
function ticketSources(db: DatabaseSync, given: Pick<TicketSources, 'external' | 'github'> | null): Pick<TicketSources, 'external' | 'github'> {
  return {
    external: given?.external ?? (() => jiraReader(db, createKeychain(process.platform, runKeychain, resolveDataDir(process.env)))),
    github: given?.github ?? githubSource(db, ghRunner()),
  };
}

// The cards the Add card dialog can copy extra context from.
export function contextSources(db: DatabaseSync): { key: string; title: string; extra: string }[] {
  return db
    .prepare("SELECT key, title, extra_context AS extra FROM cards WHERE trim(coalesce(extra_context, '')) != '' ORDER BY key")
    .all() as unknown as { key: string; title: string; extra: string }[];
}
