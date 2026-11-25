// What a person typed, once it has been read. Free text is a first class answer and not a
// failure: it becomes a local ticket with a title.
export type TicketRef =
  | { kind: 'local'; key: string }
  | { kind: 'external'; key: string }
  | { kind: 'github'; owner: string | null; repo: string; number: number }
  | { kind: 'text'; text: string };

export interface Ticket {
  key: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  url: string | null;
  // Used to offer the sibling cards a new card would be linked to. A source that reports no
  // parent leaves this null and the preview stays empty.
  parentKey: string | null;
}

export interface TicketQuery {
  limit: number;
  repos: readonly string[];
  // What the person typed, where a screen collects it: GitHub search qualifiers, or a whole JQL
  // query for Jira. Left out by a caller that wants the adapter's own query, which is what every
  // caller before the Scout source form wanted.
  terms?: string;
}

/**
 * One failed CI run, as a source reports it.
 *
 * Beside `Ticket` because it is the other thing a ticket query answers, and both are read by the
 * same source. No url and no time: the finding it becomes has no column for either.
 */
export interface FailedRun {
  // `owner/repo`, so a finding says which repository went red.
  repo: string;
  // The workflow's own name, which is what a person recognises.
  workflow: string;
  branch: string;
  // The run's own id, which rises with every run of the repository. It is what tells a run this
  // check has already reported from one it has not.
  id: number;
}

export interface TicketResult {
  ref: TicketRef;
  ticket: Ticket | null;
  // The source answered and the ticket was not there, which is not the same as a call that
  // failed. One batched read can carry both.
  notFound: boolean;
}

// Read-only: nothing is ever written back to a ticket system. `get` takes an
// array from the first line, so a source that can batch is never forced into a call per key.
export interface TicketAdapter {
  // An id. It goes into the card row, so it stays lower case and stable.
  name: string;
  // The same system as a person writes it, for a sentence they read. Left out where the id reads
  // the same either way.
  title?: string;
  get(refs: readonly TicketRef[], signal: AbortSignal): Promise<readonly TicketResult[]>;
  search(query: TicketQuery, signal: AbortSignal): Promise<readonly Ticket[]>;
}

// Ticket keys are uppercase, and refs are case sensitive, so a lowercase word stays free text.
const KEY = /^([A-Z][A-Z0-9]*)-(\d+)$/;
const OWNER_REPO_NUMBER = /^(?:([A-Za-z0-9._-]+)\/)?([A-Za-z0-9._-]+)#(\d+)$/;
const GITHUB_URL = /^https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/(?:issues|pull)\/(\d+)\/?$/;

function gitHubRef(owner: string | null, repo: string | undefined, rawNumber: string | undefined): TicketRef | null {
  if (!repo || !rawNumber) return null;
  const number = Number(rawNumber);
  // Issue and pull request numbers start at 1, so a zero means the text only looked like a ref.
  return number > 0 ? { kind: 'github', owner, repo, number } : null;
}

export function parseTicketRef(input: string, localPrefix?: string): TicketRef {
  const text = input.trim();
  if (text === '') return { kind: 'text', text: '' };

  // An issue URL and a pull request URL read as the same ref. The board decides which of the two
  // a number is, so the parser does not need to know.
  const url = GITHUB_URL.exec(text);
  if (url) {
    const ref = gitHubRef(url[1] ?? null, url[2], url[3]);
    if (ref) return ref;
  }

  const hash = OWNER_REPO_NUMBER.exec(text);
  if (hash) {
    const ref = gitHubRef(hash[1] ?? null, hash[2], hash[3]);
    if (ref) return ref;
  }

  const key = KEY.exec(text);
  if (key) {
    const isLocal = localPrefix !== undefined && key[1] === localPrefix;
    return isLocal ? { kind: 'local', key: text } : { kind: 'external', key: text };
  }

  return { kind: 'text', text };
}

/**
 * A pasted link to a ticket, by the system it belongs to, or null for anything else.
 *
 * GitHub and Linear are read by their exact host, so a host that only starts like theirs is no link.
 * Jira runs on any host, so a Jira link is read by its path, `/browse/PROJ-123`, or a board's
 * `selectedIssue`, and the host comes back with it. The read compares that host with the site the
 * project set, because a key read from the wrong site is somebody else's ticket.
 */
export type TicketLink =
  | { system: 'jira'; key: string; host: string }
  | { system: 'linear'; key: string }
  | { system: 'github'; owner: string; repo: string; number: number; pull: boolean };

const JIRA_BROWSE = /\/browse\/([A-Z][A-Z0-9]*-\d+)\/?$/;
const LINEAR_ISSUE = /^\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/[^/]*)?\/?$/;

export function ticketLink(input: string): TicketLink | null {
  const text = input.trim();
  const github = GITHUB_URL.exec(text);
  if (github) {
    const ref = gitHubRef(github[1] ?? null, github[2], github[3]);
    return ref?.kind === 'github' && ref.owner !== null ? { system: 'github', owner: ref.owner, repo: ref.repo, number: ref.number, pull: text.includes('/pull/') } : null;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') return null;
  if (url.hostname === 'github.com') return null;
  if (url.hostname === 'linear.app') {
    const key = LINEAR_ISSUE.exec(url.pathname)?.[1];
    return key === undefined ? null : { system: 'linear', key };
  }
  const key = JIRA_BROWSE.exec(url.pathname)?.[1] ?? url.searchParams.get('selectedIssue') ?? '';
  return KEY.test(key) ? { system: 'jira', key, host: url.host } : null;
}

// A link copied from the browser often carries the tab or the comment it was on, as in /pull/12/files.
const PULL_URL_TAIL = /^(https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+)[/?#].*$/;
const ISSUE_URL = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\//;
const PASTE_PULL = 'Paste a pull request link, as in https://github.com/owner/repo/pull/12, or type owner/repo#12.';

/**
 * The pull request a pasted link or a typed owner/repo#N names, with its name in lower case as the
 * card's list shows it, or the sentence that says what to type instead. An issue link is refused here,
 * so it costs no call to GitHub.
 */
export function pullRequestRef(input: string): { owner: string; repo: string; number: number; name: string } | { refused: string } {
  const text = input.trim().replace(PULL_URL_TAIL, '$1');
  if (ISSUE_URL.test(text)) return { refused: `That link is to an issue. ${PASTE_PULL}` };
  const ref = parseTicketRef(text);
  if (ref.kind !== 'github') return { refused: PASTE_PULL };
  if (ref.owner === null) return { refused: `Type the owner as well, as in owner/${ref.repo}#${ref.number}.` };
  return { owner: ref.owner, repo: ref.repo, number: ref.number, name: `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase() };
}

// The longest title a local card keeps. The rest of a pasted paragraph goes in its text.
export const TITLE_CAP = 80;

/** `text` cut to `cap` characters on a word, with an ellipsis, so no screen shows half a word. */
export function cutOnWord(text: string, cap: number): string {
  const whole = text.trim();
  if (whole.length <= cap) return whole;
  // One character goes to the ellipsis.
  const room = whole.slice(0, cap - 1);
  const space = room.search(/\s\S*$/);
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}…`;
}

/** The title of a local card made from typed text: its first line with words, cut to `TITLE_CAP`. */
export function localTitle(text: string): string {
  return cutOnWord(text.split('\n').find((line) => line.trim() !== '') ?? '', TITLE_CAP);
}

/**
 * The title the refine skill wrote on the first heading of `refined.md`, `# <KEY>: <title>`, cut to
 * `TITLE_CAP`. Null when the first heading names another card or no title, so a brief in another
 * shape leaves the card's title alone.
 */
export function refinedTitle(markdown: string, key: string): string | null {
  const heading = markdown.split('\n').find((line) => /^#\s/.test(line));
  const prefix = `${key}:`;
  const rest = heading?.slice(1).trim();
  if (rest === undefined || !rest.startsWith(prefix)) return null;
  const title = localTitle(rest.slice(prefix.length));
  return title === '' ? null : title;
}

// The kinds a branch name's {type} takes.
export const BRANCH_TYPES = ['feature', 'fix', 'chore'] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

/**
 * The `Kind:` and `Branch:` lines the refine skill writes under the title of `refined.md`, for the
 * {type} and {desc} of the branch name. Null for a line that is missing, and for a kind that is none
 * of the three, so the branch name falls back.
 */
export function refinedBranch(markdown: string): { type: BranchType | null; desc: string | null } {
  // Only the lines right under the first heading, so a `Branch:` line in the brief's own text is not
  // taken for the name.
  const lines = markdown.split(/\r?\n/);
  const heading = lines.findIndex((one) => /^#\s/.test(one));
  const top: string[] = [];
  for (const one of heading < 0 ? [] : lines.slice(heading + 1)) {
    if (one.trim() === '' && top.length === 0) continue;
    if (!/^(kind|branch):/i.test(one.trim())) break;
    top.push(one.trim());
  }
  const line = (label: string): string | null => {
    const value = top.map((one) => new RegExp(`^${label}:(.*)$`, 'i').exec(one)?.[1]?.trim() ?? '').find((one) => one !== '') ?? '';
    return value === '' ? null : value;
  };
  const kind = line('Kind')?.toLowerCase() ?? null;
  return { type: BRANCH_TYPES.find((one) => one === kind) ?? null, desc: line('Branch') };
}

// The lines under a second-level heading of the brief, up to the next heading. Case and spacing do
// not count, the way the output check reads headings.
function briefSection(markdown: string, heading: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().replace(/\s+/g, ' ').toLowerCase() === heading);
  if (start === -1) return [];
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => /^#{1,2} /.test(line));
  return end === -1 ? after : after.slice(0, end);
}

export const CRITERION_LEVELS = ['must', 'should'] as const;
export type CriterionLevel = (typeof CRITERION_LEVELS)[number];

export interface RefinedCriterion {
  id: string;
  // Null on a brief written before the levels.
  level: CriterionLevel | null;
  text: string;
  // The indented `Check:` line under it, or a `Check:` after the text on its own line, how the
  // criterion is proved. Null when there is none.
  check: string | null;
}

/**
 * The acceptance checks of `refined.md`: `- AC1 (must): <text>` with an indented `Check:` line, or
 * with `Check:` after the text on the same line. A brief written before the levels reads too, with a
 * null level and check.
 */
export function refinedCriteria(markdown: string): RefinedCriterion[] {
  const found: RefinedCriterion[] = [];
  for (const line of briefSection(markdown, '## acceptance checks')) {
    const item = /^[-*] (AC\d+)\b(?:\s*\((\w+)\))?\s*:\s*(.*)$/i.exec(line);
    if (item !== null) {
      const level = item[2]?.toLowerCase();
      // A model that keeps the whole item on one line puts the Check after the text. Only a capital
      // `Check:` after a sentence counts, so a text such as "the health check: ..." stays whole.
      const [text = '', check] = (item[3] ?? '').split(/(?<=[.!?)"'`])\s+Check:\s*/);
      found.push({ id: (item[1] ?? '').toUpperCase(), level: CRITERION_LEVELS.find((one) => one === level) ?? null, text: text.trim(), check: check?.trim() || null });
      continue;
    }
    // Indented as the skill shows it, or at the margin, which Markdown still reads as part of the item.
    const check = /^\s*check\s*:\s*(.*)$/i.exec(line);
    const last = found.at(-1);
    if (check !== null && last !== undefined && last.check === null) last.check = (check[1] ?? '').trim();
  }
  return found;
}

export interface RefinedQuestion {
  // Null on a brief written before the ids.
  id: string | null;
  question: string;
  // The answer the next phase builds on. Null when the line names none.
  answer: string | null;
  // `blocks: yes` makes the next drag a forced choice. Null when the line says neither.
  blocks: boolean | null;
}

/**
 * The open questions of `refined.md`: `- Q1: <question> Default: <answer>. blocks: yes`. The
 * architecture writes them in the same shape under `## What is still open`.
 */
export function refinedQuestions(markdown: string, heading = '## Open questions'): RefinedQuestion[] {
  return briefSection(markdown, heading.toLowerCase()).flatMap((line) => {
    const item = /^[-*] (.*)$/.exec(line.trimEnd());
    if (item === null) return [];
    let rest = item[1] ?? '';
    const id = /^(Q\d+)\s*:\s*/i.exec(rest);
    if (id !== null) rest = rest.slice(id[0].length);
    const blocks = /\s*\bblocks\s*:\s*(yes|no)\b\.?$/i.exec(rest);
    if (blocks !== null) rest = rest.slice(0, blocks.index);
    const answer = /\s*\bDefault\s*:\s*(.*)$/i.exec(rest);
    if (answer !== null) rest = rest.slice(0, answer.index);
    const text = (answer?.[1] ?? '').trim().replace(/\.$/, '');
    return [{ id: id?.[1]?.toUpperCase() ?? null, question: rest.trim(), answer: text === '' ? null : text, blocks: blocks === null ? null : blocks[1]?.toLowerCase() === 'yes' }];
  });
}

export interface Decision {
  id: string;
  text: string;
}

/**
 * The `- D1: <rule>. Not: <option turned down>` lines of an architecture (`## The decisions`) and of a
 * plan (`## Decisions`), which goes on from the architecture's last id. An indented line under one
 * belongs to it. The first line of an id wins. A file written before the ids gives none.
 */
export function decisionLines(markdown: string): Decision[] {
  const found: Decision[] = [];
  let last: Decision | null = null;
  for (const line of [...briefSection(markdown, '## the decisions'), ...briefSection(markdown, '## decisions')]) {
    const item = /^[-*] (D\d+)\s*:\s*(.*)$/i.exec(line.trimEnd());
    if (item !== null) found.push((last = { id: (item[1] ?? '').toUpperCase(), text: (item[2] ?? '').trim() }));
    else if (last !== null && /^\s+\S/.test(line)) last.text = `${last.text} ${line.trim()}`;
    else if (line.trim() !== '') last = null;
  }
  return found.filter((one, at) => found.findIndex((other) => other.id === one.id) === at);
}

export function localKey(prefix: string, counter: number): string {
  return `${prefix}-${counter}`;
}

// The card key of a GitHub pull request and of a GitHub issue: one plain name, so the card gets a folder
// and a checkout. Two owners' repositories of one name share it, and the card writers refuse the second.
// Here rather than in the runner, so Add card shows the key the runner will give the card.
export const pullKey = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;

/**
 * The card key of a ticket reference: `group/project#12` is `project#12`, and a key with no path is
 * its own card key.
 *
 * A card key names one folder, so a path in it means no checkout and no run. The full reference is the
 * card's source ref. Lower case, because GitHub and GitLab names are case insensitive, and a name typed
 * by hand and one the API answered would otherwise be two cards.
 */
export function cardKeyOf(ref: string): string {
  const cut = ref.lastIndexOf('/');
  return cut === -1 ? ref : ref.slice(cut + 1).toLowerCase();
}

// A card key names the card's folder, its checkout and its address, so the key has to be one line of
// plain text with no space, because the Scout cursor splits its ids on one.
//
// A SLASH IS NOT REFUSED HERE, and that is a decision rather than an oversight. No writer makes such a
// key any more. A GitHub key comes from `pullKey` and a GitLab key from `cardKeyOf` above, and Scout's
// Start cuts any key that still holds a path. `ensureWorktree` in `packages/runner/src/git/worktree.ts`
// still refuses one at run time, so a card a migration left on its old key, because another card held
// the new one, sits on the board and cannot run.
//
// The length is the one every filesystem this app runs on caps a single name at, and not a shorter
// one of our own. A shorter cap refused keys that work: `pullKey` is `repo#number`, GitHub allows a
// repository name of 100 characters, and `branchName` keeps a key longer than its own cap whole on
// purpose. Counted in bytes, because that is what the filesystem counts.
const CARD_KEY_MAX_BYTES = 255;

/**
 * Why this text cannot be a card key, or null when it can.
 *
 * Checked at the write, because a key from a ticket system is copied out of somebody else's answer.
 * Refused and never repaired: a repaired key is a key that system does not know, so the next check
 * finds the ticket again and makes a second card for it.
 *
 * Characters are read by code point rather than by one regular expression, which cannot carry a
 * control character without tripping the lint rule that exists to catch one written by accident.
 */
export function cardKeyProblem(key: string): string | null {
  if (key === '') return 'A card key cannot be empty.';
  if (key === '.' || key === '..') return 'A card key cannot be . or .., because the key names the card folder.';
  const bytes = new TextEncoder().encode(key).length;
  if (bytes > CARD_KEY_MAX_BYTES) return `A card key is ${CARD_KEY_MAX_BYTES} bytes or less, and that one is ${bytes}.`;
  return lineProblem(key);
}

/**
 * Why a ticket reference cannot start a card, or null when it can.
 *
 * The card takes the last part as its key and keeps the whole reference as its source ref, which
 * pages print. So the part the cut takes off is one line of plain text too. It has no length cap,
 * because a source ref names no folder.
 */
export function ticketRefProblem(ref: string): string | null {
  return cardKeyProblem(cardKeyOf(ref)) ?? lineProblem(ref);
}

function lineProblem(text: string): string | null {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return 'A card key is one line of plain text, with no line break and no control character.';
    if (/\s/.test(character)) return 'A card key holds no space.';
  }
  return null;
}
