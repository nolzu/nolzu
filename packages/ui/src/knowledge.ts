import { frontmatterDescription, frontmatterEnd, frontmatterPaths, isMaintenanceKey, KB_MAINTENANCE_KEY, type KnowledgeStatus } from '@nolzu/protocol';
import { patchLines } from './ticket/patch.ts';

/**
 * The rules behind the Knowledge screen.
 *
 * Everything the screen shows is worked out here, so the component only draws. The page gathers
 * the raw parts: the folder as it is on disk, the change rows from the database, the diff of every
 * change from git, and the card the knowledge lane holds. Nothing is read or fetched here.
 */

// Read in protocol, because the output check reads a knowledge file the same way.
export { frontmatterDescription };

// One row of `knowledge_changes`, with the two things only git can answer about it.
export interface KnowledgeChangeInput {
  id: number;
  // The run that wrote it. Approve and Return act on a whole run, because one run is one commit.
  runId: number;
  // The card that taught it, or the reserved key of a maintenance run.
  cardKey: string;
  // The phase of the run that wrote it, which tells Optimize from Learn this project under the
  // reserved key. Absent on a row the page read no phase for, which reads as the key alone says.
  phase?: string;
  // From the repository root, which is the path git prints.
  filePath: string;
  commitSha: string | null;
  summary: string | null;
  status: KnowledgeStatus;
  // What the person wrote when they returned the change, and null for every other status.
  note: string | null;
  // The commit date, ISO, from git. Null while a change waits for review, because it has no commit.
  committedAt: string | null;
  // The patch of that one commit, from git. Never a copy kept in the database: a stored copy
  // drifts away from the repository the person can open.
  diff: string | null;
  // True when the patch was past the size the page reads, so there is a commit but no diff here.
  diffTooLarge: boolean;
  // The knowledge folder the commit is in, when the project no longer uses it. The project became a
  // workspace, so the commit is in the repository that moved into it. Absent or null otherwise.
  movedFrom?: string | null;
  // A change that waits has no commit to diff, so its lines come from the file as it is in the
  // folder now and the kept copy the run left. Null on either side is a file that is not there.
  // Absent when the kept copy is gone or the change does not wait.
  held?: { before: string | null; after: string | null } | null;
}

export interface KnowledgeInput {
  // Null when no project is set, so `resolveKnowledgeDir` has nothing to be relative to.
  folder: string | null;
  exists: boolean;
  // Where the folder sits in its repository, with a trailing slash, or empty at the root. The file
  // list is relative to the folder and the change rows are relative to the repository, and this is
  // what joins the two.
  prefix: string;
  // Relative to the folder, sorted by the page.
  files: readonly string[];
  // The file the person picked, with its text. Null when none is picked or the pick is gone.
  open: { path: string; text: string } | null;
  // Every row, oldest first.
  changes: readonly KnowledgeChangeInput[];
  // The cards that still exist. A change from a card that was deleted keeps its row and loses its link.
  cards: readonly { key: string; title: string }[];
  // The card the knowledge lane is holding, from the board snapshot.
  busy: string | null;
  // When each file last changed, from git, by its path inside the folder. A file git has no commit
  // of is absent.
  fileDates?: Readonly<Record<string, string>>;
  // What each file says, by its path inside the folder, for the Search knowledge box.
  fileTexts?: Readonly<Record<string, string>>;
  // The folder as a person reads it: from the project, or with the home folder as ~. The screen
  // names this one and never the long path. Absent means `folder`.
  shown?: string;
  // Whether each path a file names in its `paths:` key is on its repository's base branch, by the
  // path as the file names it. A path absent here was not checked, so it is marked neither way.
  pathsOnBase?: Readonly<Record<string, boolean>>;
  // The project's repositories by their path, in the project's order. The file list groups the
  // knowledge folder by them. Absent is a project with none listed.
  repos?: readonly string[];
}

export interface KnowledgeSource {
  kind: 'card' | 'maintenance';
  // The card key, and null for a maintenance run, which belongs to no card.
  key: string | null;
  title: string | null;
}

export interface KnowledgeChangeView {
  id: number;
  runId: number;
  sha: string | null;
  shortSha: string | null;
  status: KnowledgeStatus;
  statusLabel: string;
  summary: string | null;
  // The note the change was returned with, or null.
  note: string | null;
  // The day the change was committed, or null while it waits for review.
  when: string | null;
  // Relative to the folder, which is how the file list names it.
  path: string;
  // The phase of the run that wrote it, or null when the page read none.
  phase: string | null;
  // Null when the card that taught it was deleted.
  source: KnowledgeSource | null;
  diff: string | null;
  // Why there is no diff, or null when there is one. The three reasons read differently to a
  // person: nothing is committed yet, git does not have the commit, or the patch is too large.
  diffNote: string | null;
  // Whether the screen offers Revert on this change. Only the newest applied change of the open
  // file: a later commit on the same path moved the file on, and taking the older commit back on
  // its own would drop that work, so the server refuses it anyway.
  canRevert: boolean;
  // True when the commit is in a knowledge folder the project no longer uses.
  moved: boolean;
  // How many lines the change added and took out, or null when there are no lines to count.
  lines: { added: number; removed: number } | null;
  // What a change that waits would write, from its kept copy. Null for every other change and when
  // the kept copy is gone.
  held: LineGroup[] | null;
}

// Lines that went out and the lines that came in at one place in a file.
export interface LineGroup {
  removed: string[];
  added: string[];
}

// The open file cut around the newest change, so the middle pane draws that change where it is.
export type FilePart = { kind: 'text'; text: string } | ({ kind: 'change' } & LineGroup);

export interface KnowledgeInline {
  // The newest applied change of the file, which is also the one Revert takes back.
  change: KnowledgeChangeView;
  // True when that change made the file. Its lines are then the whole file, so none are marked.
  whole: boolean;
}

export interface KnowledgeFileRow {
  path: string;
  name: string;
  open: boolean;
  // The day the file last changed in git, or null when git has no commit of it.
  updated: string | null;
  // What the file says, for the search box. Empty when the page did not read it.
  text?: string;
  // The paths the file depends on that its base branch no longer has.
  gone: string[];
  // True when a change to this file waits for review.
  pending: boolean;
}

// One path a file says it depends on, and whether the base branch still has it.
export interface KnowledgePath {
  path: string;
  state: 'there' | 'gone' | 'unchecked';
}

// Not checked is a base branch git could not read, or a path in no repository of the project. Not
// "gone": a file the card added is not on a local base branch nobody pulled since the merge.
export const PATH_WORDS: Record<KnowledgePath['state'], string> = { there: 'on the base branch', gone: 'not on the base branch', unchecked: 'not checked' };

export interface KnowledgeOpenFile {
  path: string;
  // From the repository root, for the line above the file.
  repoPath: string;
  lineCount: number;
  // The file without its frontmatter block, which is what the middle pane renders.
  body: string;
  // The body, cut around the lines of `inline` when they can be placed. One text part otherwise.
  parts: FilePart[];
  // The change drawn in the file with its card and Revert, or null when none of it is applied.
  inline: KnowledgeInline | null;
  // The description from the file's frontmatter, or null when it has none.
  description: string | null;
  // The paths its frontmatter names, empty for a file that names none.
  paths: KnowledgePath[];
  taughtBy: KnowledgeSource[];
  // Newest change first.
  history: KnowledgeChangeView[];
}

export interface KnowledgeView {
  folder: string | null;
  // The one sentence when there is no folder to browse, else null.
  problem: string | null;
  // True when the folder is there and holds nothing.
  empty: boolean;
  fileCount: number;
  // The day of the newest applied change, or null when nothing has been applied.
  lastReviewed: string | null;
  // The day of the newest change a maintenance run committed, or null when Optimize changed nothing.
  lastOptimize: string | null;
  // The folder as its repository names it, or the whole path for a folder at a repository root.
  place: string | null;
  // The card writing knowledge right now, or the words for a maintenance run, which locks the
  // folder either way. Null when nothing is writing.
  busy: string | null;
  files: KnowledgeFileRow[];
  open: KnowledgeOpenFile | null;
  pending: KnowledgeChangeView[];
  // The project's repositories, which the file list groups by.
  repos: readonly string[];
}

// Knowledge is earned, so an empty folder is a normal
// state and not a setup step somebody forgot.
export const NO_KNOWLEDGE = 'No knowledge yet. It is earned from real work, never generated from a scan.';

const STATUS_LABELS: Record<KnowledgeStatus, string> = {
  applied: 'applied',
  reverted: 'reverted',
  pending: 'waiting for review',
  returned: 'returned',
};

// The day part of an ISO timestamp. No month name and no locale: this is a date a person compares
// with what git says, and git says the same digits.
export const day = (iso: string | null): string | null => (iso === null ? null : iso.slice(0, 10));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A day from `day` as the foot draws it, "4 Oct". Limit: no year; add it
// once a folder's last Optimize is ever a year old.
export const dayMonth = (iso: string | null): string | null => {
  if (iso === null) return null;
  const [, month, date] = iso.split('-').map(Number);
  return `${date} ${MONTHS[(month ?? 1) - 1]}`;
};

// A repository's own file and the folder of notes about several repositories, as `@nolzu/core` names
// them (`REPO_FILE`, `SHARED_FOLDER`). The UI does not depend on core, so they are written here too.
const REPO_FILE = 'repository.md';
const SHARED = 'shared';

// The folders Nolzu writes itself, named in words. A repository's folder shows its name, and any other
// folder shows as it is on disk.
export const FOLDER_LABELS: Readonly<Record<string, string>> = { [SHARED]: 'Shared' };

export interface KnowledgeFolder {
  // The first folder of its files' paths, inside the knowledge folder.
  path: string;
  label: string;
  // Each named by its path under this folder.
  files: KnowledgeFileRow[];
  holdsOpen: boolean;
  // How many of its files have a change waiting for review, so a folded folder still shows them.
  pending: number;
}

// The file list as a tree, grouped by repository: one folder per first path part, the project's
// repositories first in its order, then Shared, then any other folder, each with its repository file
// first. The files at the top of the folder come last: the run recipe, and the file and notes of a
// repository at the project folder itself. A project of one repository shows its folder's files at
// the top, with no folder row.
// Limit: one level only; a file deeper down keeps its path under that folder in its name.
export function knowledgeTree(files: readonly KnowledgeFileRow[], repos: readonly string[] = []): { top: KnowledgeFileRow[]; folders: KnowledgeFolder[] } {
  const top: KnowledgeFileRow[] = [];
  const folders: KnowledgeFolder[] = [];
  const only = repos.length === 1 && repos[0] !== '.' ? `${repos[0]}/` : null;
  for (const file of files) {
    const cut = file.path.indexOf('/');
    if (cut === -1 || (only !== null && file.path.startsWith(only))) {
      top.push(cut === -1 ? file : { ...file, name: file.path.slice(cut + 1) });
      continue;
    }
    const path = file.path.slice(0, cut);
    let folder = folders.find((one) => one.path === path);
    if (folder === undefined) {
      folder = { path, label: FOLDER_LABELS[path] ?? path, files: [], holdsOpen: false, pending: 0 };
      folders.push(folder);
    }
    folder.files.push({ ...file, name: file.path.slice(cut + 1) });
    if (file.open) folder.holdsOpen = true;
    if (file.pending) folder.pending += 1;
  }
  const place = (path: string) => (repos.includes(path) ? repos.indexOf(path) : path === SHARED ? repos.length : repos.length + 1);
  const repoFileFirst = (list: KnowledgeFileRow[]) => list.sort((a, b) => Number(b.name === REPO_FILE) - Number(a.name === REPO_FILE));
  for (const folder of folders) repoFileFirst(folder.files);
  return { top: repoFileFirst(top), folders: folders.sort((a, b) => place(a.path) - place(b.path)) };
}

// The Search knowledge box: the name or the text holds the typed words, in any case.
export function fileMatches(file: KnowledgeFileRow, query: string): boolean {
  const asked = query.trim().toLowerCase();
  return asked === '' || file.name.toLowerCase().includes(asked) || (file.text ?? '').toLowerCase().includes(asked);
}

/**
 * The file without its frontmatter block.
 *
 * The block is the file's own bookkeeping, and the right pane shows the description out of it.
 * Rendered as markdown it becomes a rule and a heading that repeat that description, so the middle
 * pane gets the body alone.
 */
export function fileBody(text: string): string {
  const lines = text.split('\n');
  const end = frontmatterEnd(lines);
  return end === -1 ? text : lines.slice(end + 1).join('\n').replace(/^\n+/, '');
}

/**
 * Who a change came from.
 *
 * A maintenance run belongs to no card and reads "maintenance".
 * A card that was deleted answers null, so the screen shows the change and skips the link rather
 * than offering one that leads to a 404.
 */
export function changeSource(cardKey: string, cards: readonly { key: string; title: string }[]): KnowledgeSource | null {
  if (isMaintenanceKey(cardKey)) return { kind: 'maintenance', key: null, title: null };
  const card = cards.find((one) => one.key === cardKey);
  return card === undefined ? null : { kind: 'card', key: card.key, title: card.title };
}

// A maintenance run holds the lane under its reserved key, and that key is never shown to a
// person. The change rows follow the same rule in `changeSource`.
const busyLabel = (key: string | null): string | null => (isMaintenanceKey(key) ? 'A maintenance run' : key);

// Whether a change row belongs to the file that is open. The row names its file from the
// repository root and the file list names it from the folder, so the prefix joins the two. The page
// asks git for a diff with the same rule, so one answer cannot drift from the other.
export const changeIsOf = (filePath: string, prefix: string, path: string): boolean => filePath === prefix + path;

// A text as its lines. The newline that ends the last line is no line of its own.
const linesOf = (text: string): string[] => {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

// Limit: a plain LCS table of n by m cells, because a knowledge note is a few hundred lines. Past
// this size the whole text reads as one group, every line out and every line in.
const MAX_DIFF_CELLS = 250_000;

/**
 * Where two texts differ, line by line, as groups of lines out and lines in.
 *
 * A change that waits has no commit, so this is how its kept copy is set against the file in the
 * folder. Each group ends where a line stayed the same.
 */
export function lineGroups(before: string, after: string): LineGroup[] {
  const a = linesOf(before);
  const b = linesOf(after);
  if (a.length * b.length > MAX_DIFF_CELLS) return a.length + b.length === 0 ? [] : [{ removed: a, added: b }];

  // How long the common run is from each pair of lines to the end of both texts.
  const common = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i]![j] = a[i] === b[j] ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }

  const groups: LineGroup[] = [];
  let group: LineGroup | null = null;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      group = null;
      i++;
      j++;
      continue;
    }
    if (group === null) {
      group = { removed: [], added: [] };
      groups.push(group);
    }
    if (j < b.length && (i === a.length || common[i]![j + 1]! >= common[i + 1]![j]!)) group.added.push(b[j++]!);
    else group.removed.push(a[i++]!);
  }
  return groups;
}

/**
 * A line of a knowledge file, cut where its inline code starts and ends.
 *
 * The changed lines are drawn as lines and not as rendered markdown, so this is the one bit of
 * markdown they keep. A line with a lone backtick stays as it is.
 */
export function codeSpans(line: string): { text: string; code: boolean }[] {
  const pieces = line.split('`');
  if (pieces.length % 2 === 0) return [{ text: line, code: false }];
  return pieces.map((text, index) => ({ text, code: index % 2 === 1 })).filter((piece) => piece.text !== '');
}

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

// The groups of one patch, each with the index in the new file where its added lines start, or where
// its removed lines were, and the lines git printed around them with their index in the new file.
function patchGroups(diff: string): { groups: (LineGroup & { at: number })[]; context: { at: number; text: string }[] } {
  const groups: (LineGroup & { at: number })[] = [];
  const context: { at: number; text: string }[] = [];
  let group: (LineGroup & { at: number }) | null = null;
  // The index in the new file of the next line, and -1 before the first hunk.
  let next = -1;
  for (const line of diff.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      // A hunk with no new lines names the line before it, and every other hunk its first line.
      const start = Number(hunk[1]);
      next = hunk[2] === '0' ? start : start - 1;
      group = null;
      continue;
    }
    if (next === -1 || line.startsWith('\\')) continue;
    const sign = line.slice(0, 1);
    if (sign === '+' || sign === '-') {
      if (group === null) {
        group = { at: next, removed: [], added: [] };
        groups.push(group);
      }
      if (sign === '+') {
        group.added.push(line.slice(1));
        next++;
      } else group.removed.push(line.slice(1));
      continue;
    }
    if (sign === ' ') context.push({ at: next, text: line.slice(1) });
    group = null;
    next++;
  }
  return { groups, context };
}

const FENCE = /^\s*(```|~~~)/;
const fences = (lines: readonly string[]): number => lines.filter((line) => FENCE.test(line)).length;
const trimmed = (lines: readonly string[]): string => lines.join('\n').replace(/^\n+|\n+$/g, '');

/**
 * The open file cut around the lines one change wrote, or null when they cannot be placed.
 *
 * The patch is from the change's own commit, so its lines are where it says only while the file
 * has not moved on. Each one is checked against the file. A cut inside the frontmatter or a code
 * block would break the markdown on either side, so neither is placed.
 */
function placeChange(text: string, diff: string): FilePart[] | null {
  const lines = linesOf(text);
  const end = frontmatterEnd(lines);
  let start = end === -1 ? 0 : end + 1;
  while (end !== -1 && start < lines.length && lines[start] === '') start++;

  const { groups, context } = patchGroups(diff);
  // A change that only took lines out has no line of its own left to find, so the lines around it
  // say whether the file is still where the commit left it.
  if (groups.length === 0 || context.some((one) => lines[one.at] !== one.text)) return null;
  const parts: FilePart[] = [];
  let cursor = start;
  for (const group of groups) {
    if (group.at < cursor) return null;
    if (group.added.some((line, index) => lines[group.at + index] !== line)) return null;
    if (fences(lines.slice(start, group.at)) % 2 === 1 || fences(group.added) % 2 === 1) return null;
    const before = trimmed(lines.slice(cursor, group.at));
    if (before !== '') parts.push({ kind: 'text', text: before });
    parts.push({ kind: 'change', removed: group.removed, added: group.added });
    cursor = group.at + group.added.length;
  }
  const after = trimmed(lines.slice(cursor));
  if (after !== '') parts.push({ kind: 'text', text: after });
  return parts;
}

// How many lines a patch added and took out. git's header lines come off with `patchLines`.
const countOf = (diff: string): { added: number; removed: number } => {
  const kinds = patchLines(diff).map((line) => line.kind);
  return { added: kinds.filter((kind) => kind === 'add').length, removed: kinds.filter((kind) => kind === 'del').length };
};

const countGroups = (groups: readonly LineGroup[]) => ({
  added: groups.reduce((sum, group) => sum + group.added.length, 0),
  removed: groups.reduce((sum, group) => sum + group.removed.length, 0),
});

// The newest of some timestamps, or null.
const latest = (stamps: readonly (string | null)[]): string | null =>
  stamps.reduce<string | null>((best, at) => (at !== null && (best === null || Date.parse(at) > Date.parse(best)) ? at : best), null);

const problemOf = (input: KnowledgeInput): string | null => {
  if (input.folder === null) {
    return 'There is no project set, so there is no knowledge folder yet. Make a project on New project.';
  }
  if (!input.exists) {
    return `There is no folder ${input.shown ?? input.folder} yet. The first wrap-up that teaches something makes it.`;
  }
  return null;
};

const diffNote = (change: KnowledgeChangeInput, shortSha: string | null): string | null => {
  if (change.diff !== null) return null;
  if ((change.movedFrom ?? null) !== null) return `This change was committed in ${change.movedFrom}, before this project became a workspace. Its diff and its commit are there.`;
  if (change.diffTooLarge) return `This change is too large to show here. Open commit ${shortSha} in the folder to read it.`;
  // A returned change was never applied, so there is nothing to diff. The note above says why.
  if (change.status === 'returned') return 'This change was returned, so nothing was committed and there is no diff.';
  if (change.commitSha === null) return 'There is no commit yet. The change waits for a person.';
  return `git has no commit ${shortSha} in this folder, so there is no diff to show.`;
};

export function knowledgeView(input: KnowledgeInput): KnowledgeView {
  const problem = problemOf(input);
  const view = (change: KnowledgeChangeInput): KnowledgeChangeView => {
    const shortSha = change.commitSha === null ? null : change.commitSha.slice(0, 7);
    const kept = change.status === 'pending' && change.held != null ? lineGroups(change.held.before ?? '', change.held.after ?? '') : null;
    return {
      id: change.id,
      runId: change.runId,
      sha: change.commitSha,
      shortSha,
      status: change.status,
      statusLabel: STATUS_LABELS[change.status],
      summary: change.summary,
      note: change.note,
      when: day(change.committedAt),
      path: change.filePath.startsWith(input.prefix) ? change.filePath.slice(input.prefix.length) : change.filePath,
      phase: change.phase ?? null,
      source: changeSource(change.cardKey, input.cards),
      diff: change.diff,
      diffNote: diffNote(change, shortSha),
      canRevert: false,
      moved: (change.movedFrom ?? null) !== null,
      lines: change.diff !== null ? countOf(change.diff) : kept !== null ? countGroups(kept) : null,
      held: kept,
    };
  };

  // A note whose code moved on is a note to check before trusting it.
  const pathsOf = (text: string): KnowledgePath[] =>
    frontmatterPaths(text).map((path) => {
      const there = input.pathsOnBase?.[path];
      return { path, state: there === undefined ? 'unchecked' : there ? 'there' : 'gone' };
    });
  const goneOf = (text: string) => pathsOf(text).flatMap((one) => (one.state === 'gone' ? [one.path] : []));

  const open = input.open;
  const mine = open === null ? [] : input.changes.filter((change) => changeIsOf(change.filePath, input.prefix, open.path)).map(view);
  // The newest applied change is the only one the folder can still take back, so it is the only one
  // that gets a button. A button that always refuses is worse than no button.
  // A moved change is in another repository, so this folder cannot take it back.
  const newest = mine.findLast((change) => change.status === 'applied' && !change.moved);
  if (newest !== undefined) newest.canRevert = true;
  // Unique by card, in the order the file was taught. Only an applied change: a reverted one was
  // taken back, and a pending or returned one is held aside, so neither is in the file.
  const taughtBy: KnowledgeSource[] = [];
  for (const change of mine) {
    const source = change.source;
    if (change.status !== 'applied' || source === null) continue;
    if (!taughtBy.some((one) => one.kind === source.kind && one.key === source.key)) taughtBy.push(source);
  }

  // The newest applied change. "Reviewed" is what applied means: with the review setting on, a
  // change is applied only after a person approves it.
  const applied = input.changes.filter((change) => change.status === 'applied' && change.committedAt !== null);
  const reviewed = latest(applied.map((change) => change.committedAt));
  const optimized = latest(input.changes.filter((change) => change.cardKey === KB_MAINTENANCE_KEY && change.phase !== 'orient').map((change) => change.committedAt));
  // The change that is drawn in the file. A change that made the file is the file, so its lines stay
  // unmarked and the card and Revert sit at the top. So do the lines of a change that cannot be placed.
  const inline = newest === undefined ? null : { change: newest, whole: newest.diff !== null && /^@@ -0,0 /m.test(newest.diff) };
  const placed = open === null || inline === null || inline.whole || inline.change.diff === null ? null : placeChange(open.text, inline.change.diff);

  return {
    folder: input.folder,
    problem,
    empty: problem === null && input.files.length === 0,
    fileCount: input.files.length,
    lastReviewed: day(reviewed),
    lastOptimize: day(optimized),
    place: input.folder === null ? null : input.prefix === '' ? (input.shown ?? input.folder) : input.prefix.replace(/\/$/, ''),
    busy: busyLabel(input.busy),
    files: input.files.map((path) => ({
      path,
      name: path.split('/').pop() ?? path,
      open: open?.path === path,
      updated: day(input.fileDates?.[path] ?? null),
      text: input.fileTexts?.[path] ?? '',
      gone: goneOf(path === open?.path ? open.text : (input.fileTexts?.[path] ?? '')),
      pending: input.changes.some((change) => change.status === 'pending' && changeIsOf(change.filePath, input.prefix, path)),
    })),
    open:
      open === null
        ? null
        : {
            path: open.path,
            repoPath: input.prefix + open.path,
            lineCount: linesOf(open.text).length,
            body: fileBody(open.text),
            parts: placed ?? [{ kind: 'text', text: fileBody(open.text) }],
            inline,
            description: frontmatterDescription(open.text),
            paths: pathsOf(open.text),
            taughtBy,
            history: [...mine].reverse(),
          },
    pending: input.changes.filter((change) => change.status === 'pending').map(view),
    repos: input.repos ?? [],
  };
}

// One run's pending change, which is what Approve and Return act on: one run is one commit, so
// half of it can never be applied.
export interface KnowledgePendingRun {
  runId: number;
  // The card that wrote it, or maintenance. Null when that card was deleted.
  source: KnowledgeSource | null;
  // The run that wrote it, in words: a wrap-up, Optimize or Learn this project.
  by: string;
  changes: KnowledgeChangeView[];
}

// The pending list, grouped by run, in the order the rows were written.
export function pendingRuns(pending: readonly KnowledgeChangeView[]): KnowledgePendingRun[] {
  const runs: KnowledgePendingRun[] = [];
  for (const change of pending) {
    const found = runs.find((one) => one.runId === change.runId);
    const by = change.phase === 'orient' ? 'Learn this project' : change.phase === 'learn-repo' ? 'Learn your repositories' : change.source?.kind === 'maintenance' ? 'Optimize' : 'wrap-up';
    if (found === undefined) runs.push({ runId: change.runId, source: change.source, by, changes: [change] });
    else found.changes.push(change);
  }
  return runs;
}
