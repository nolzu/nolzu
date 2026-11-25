import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KB_MAINTENANCE_KEY, type KnowledgeProposalFile } from '@nolzu/protocol';
import type { RunGit } from './git/base.ts';
import { PATCH_CAP_BYTES } from './git/diff.ts';
import { unquotePath } from './git/porcelain.ts';

// The key a knowledge run that belongs to no card carries. It is in the protocol package because
// the Knowledge screen reads it too. Optimize is what starts such a run.
export { KB_MAINTENANCE_KEY };

/**
 * The message of the one commit a knowledge run makes.
 *
 * It names the card and the run, so somebody reading the knowledge repository's history on its own
 * can say which card taught which file.
 */
export const knowledgeCommitMessage = (cardKey: string, runId: number): string => `knowledge: ${cardKey} run ${runId}`;

export type KnowledgeKind = 'added' | 'corrected' | 'removed';

export interface KnowledgeChange {
  // From the repository root, which is what `status --porcelain` prints whatever folder git ran in.
  path: string;
  kind: KnowledgeKind;
}

// One `status --porcelain` line. The first two characters are what the index and the working tree
// say, the path starts at the fourth. A staged rename names two paths, and only the new one counts:
// a knowledge run has no command, so a file it moved arrives as one new path and one deleted path.
function parseLine(line: string): KnowledgeChange | null {
  if (line.length < 4) return null;
  const letters = line.slice(0, 2);
  const rest = line.slice(3);
  const arrow = rest.indexOf(' -> ');
  const path = unquotePath(arrow === -1 ? rest : rest.slice(arrow + ' -> '.length));
  if (path === '') return null;

  const kind: KnowledgeKind = letters.includes('D') ? 'removed' : letters === '??' || letters.includes('A') ? 'added' : 'corrected';
  return { path, kind };
}

/**
 * What one run changed in the knowledge folder, from the folder itself rather than from a list the
 * model wrote.
 *
 * A path that was already changed before the run is left out. It belongs to the person working in
 * the same repository, or to an earlier run whose change is still pending, and neither is this
 * run's to commit.
 */
export function knowledgeChanges(before: readonly string[], after: readonly string[]): readonly KnowledgeChange[] {
  const theirs = new Set(before.map(parseLine).filter((change) => change !== null).map((change) => change.path));
  const mine = new Map<string, KnowledgeKind>();

  for (const line of after) {
    const change = parseLine(line);
    if (change === null || theirs.has(change.path)) continue;
    mine.set(change.path, change.kind);
  }
  // Sorted, so the rows of a run read in the same order the screen lists the files.
  return [...mine].map(([path, kind]) => ({ path, kind })).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The knowledge folder as git sees it right now.
 *
 * `-uall` lists every new file, because the plain form collapses a new folder into one line and the
 * files inside it would never be committed. The pathspec keeps the answer to this folder, because
 * the default knowledge folder sits inside the project's own repository. Approve narrows it to the
 * paths of one change, to ask whether they are still what the hold left.
 */
export async function knowledgeState(run: RunGit, paths: readonly string[] = ['.']): Promise<readonly string[]> {
  const status = await run(['status', '--porcelain', '-uall', '--', ...paths]);
  if (status.code !== 0) {
    throw new Error(said(status.stderr, 'git could not read the knowledge folder, and said nothing about why.'));
  }
  return status.stdout.split('\n').filter((line) => line.trim() !== '');
}

export interface KnowledgeCommitOptions {
  // git in the knowledge folder itself.
  run: RunGit;
  cardKey: string;
  runId: number;
  before: readonly string[];
  after: readonly string[];
  // Writes the rows behind the commit. It runs after the commit and before this returns: when it
  // throws, the commit is taken back, because a commit no row names cannot be shown or reverted.
  record: (made: KnowledgeCommit) => void;
}

export interface KnowledgeCommit {
  commit: string;
  changes: readonly KnowledgeChange[];
}

/**
 * Commits what one knowledge run wrote, as one commit, and records the rows behind it.
 *
 * Null when the run changed nothing. A wrap-up that taught nothing is a normal end, so it leaves no
 * empty commit and no row.
 */
export async function commitKnowledge(options: KnowledgeCommitOptions): Promise<KnowledgeCommit | null> {
  const changes = knowledgeChanges(options.before, options.after);
  if (changes.length === 0) return null;

  const commit = await commitPaths(
    options.run,
    knowledgeCommitMessage(options.cardKey, options.runId),
    changes.map((change) => change.path),
    (made) => options.record({ commit: made, changes }),
  );
  return { commit, changes };
}

/**
 * One commit of files that no run wrote, such as the repository files onboarding starts with.
 *
 * Paths are from the repository root, like a status line. There is no run, so there is no row to
 * record: the Knowledge screen lists these files from the folder, with no history entry.
 */
export const commitKnowledgeFiles = (run: RunGit, message: string, paths: readonly string[]): Promise<string> => commitPaths(run, message, paths, () => undefined);

// `top` because a status path starts at the repository root while git runs in the knowledge
// folder, and `literal` because a file named with a bracket is a name and not a pattern.
const spec = (path: string): string => `:(top,literal)${path}`;

/**
 * One commit of the named paths, with the rows behind it written before this returns.
 *
 * `record` runs after the commit: when it throws, the commit is taken back, because a commit no
 * row names cannot be shown or reverted. Both the run's own commit and an approved change go
 * through here, so the two carry the same message and take the same way back.
 */
async function commitPaths(run: RunGit, message: string, paths: readonly string[], record: (commit: string) => void): Promise<string> {
  const specs = paths.map(spec);
  const head = await run(['rev-parse', 'HEAD']);
  // Empty in a repository with no commit yet, which is the one case the undo below cannot use.
  const was = head.code === 0 ? head.stdout.trim() : '';

  const staged = await run(['add', '--', ...specs]);
  if (staged.code !== 0) throw new Error(said(staged.stderr, 'git could not stage what the run wrote into the knowledge folder.'));
  // A folder holding its own .git is staged as a pointer to it, and the person's own git status would
  // then run inside that repository, under a config the run wrote.
  const nested = (await run(['diff', '--cached', '--raw', '--', ...specs])).stdout
    .split('\n')
    .find((line) => line.startsWith(':') && line.slice(1).trimStart().split(' ')[1] === '160000');
  if (nested !== undefined) {
    await unstage(run, was, specs);
    const at = nested.slice(nested.indexOf('\t') + 1);
    throw new Error(`${at} has its own .git folder, so git would commit a pointer to it and none of its files. Remove ${at}/.git, then try again.`);
  }

  // Only this run's paths. The person may have staged their own work in the same repository, and
  // this commit is not the place it lands.
  // The repository's hooks stay off, as on every git call: nobody is asked before this commit, and a
  // hook a run planted would run here outside the wall.
  const made = await run(['commit', '--cleanup=verbatim', '-m', message, '--', ...specs]);
  if (made.code !== 0) {
    await unstage(run, was, specs);
    throw new Error(said(made.stderr, 'git refused the knowledge commit and said nothing about why.'));
  }
  const commit = (await run(['rev-parse', 'HEAD'])).stdout.trim();

  try {
    record(commit);
  } catch (error) {
    await undo(run, was, specs, commit);
    throw error;
  }
  return commit;
}

// One knowledge file as the run left it, kept while a person decides. Null content is a file the
// run removed.
export interface HeldKnowledgeFile {
  path: string;
  kind: KnowledgeKind;
  content: string | null;
}

// One run's whole change, kept aside. It is what Approve writes back, so it holds the files and
// nothing about the folder around them.
export interface HeldKnowledge {
  cardKey: string;
  runId: number;
  files: readonly HeldKnowledgeFile[];
}

export interface KnowledgeHoldOptions {
  // git in the knowledge folder itself.
  run: RunGit;
  cardKey: string;
  runId: number;
  before: readonly string[];
  after: readonly string[];
  // Stores the kept copy and the pending rows. It runs before the folder is put back, so nothing
  // the run wrote is lost when it throws.
  keep: (held: HeldKnowledge) => void;
}

/**
 * Keeps what one run wrote aside and puts the knowledge folder back to the state it was in.
 *
 * This is the review setting's whole job: the person's knowledge files never carry content nobody
 * approved. Null when the run changed nothing, as after a wrap-up that taught nothing.
 */
export async function holdKnowledge(options: KnowledgeHoldOptions): Promise<HeldKnowledge | null> {
  const changes = knowledgeChanges(options.before, options.after);
  if (changes.length === 0) return null;

  const { run } = options;
  const root = await repoRoot(run);
  // Limit: read as text, because a knowledge file is a note a run wrote. A folder somebody
  // filled with images would need a buffer here.
  const files = changes.map((change) => {
    const file = join(root, change.path);
    return { path: change.path, kind: change.kind, content: existsSync(file) ? readFileSync(file, 'utf8') : null };
  });
  const held: HeldKnowledge = { cardKey: options.cardKey, runId: options.runId, files };

  // Kept before the folder is touched. A store that fails then leaves the run's work where it is,
  // which is the same place a run that died halfway leaves it.
  options.keep(held);
  for (const change of changes) await restore(run, root, change.path);
  return held;
}

export interface KnowledgeDiffOptions {
  // git in the knowledge folder itself, and the one runner here that pipes a file's own content
  // through git. Hand in one that stops reading at `PATCH_CAP_BYTES + 1`, the way `filePatch` does
  // for a card, or a large note sits in this process whole.
  run: RunGit;
  before: readonly string[];
  after: readonly string[];
}

/**
 * The patch of every file one run wrote, one per file, against what the knowledge folder holds.
 *
 * This is what a team project sends up instead of committing. It has to run before the folder is
 * put back, because git reads a patch off the files on disk and nothing in this build can make one
 * from the kept copy afterwards.
 *
 * A path here names the file as the knowledge folder holds it, which is what a proposal carries,
 * and the patch is asked for with `--relative` so the two say the same thing. A file the run added
 * reads as a new file against nothing, and one it removed as a deletion.
 *
 * Every file `knowledgeChanges` names is described or this throws. `holdKnowledge` keeps that same
 * list, and a proposal carrying fewer files than the hold would have the team approve a run whose
 * file list is short, which is the one thing the proposal being per run exists to stop.
 */
export async function knowledgeDiffs(options: KnowledgeDiffOptions): Promise<readonly KnowledgeProposalFile[]> {
  const changes = knowledgeChanges(options.before, options.after);
  if (changes.length === 0) return [];

  const { run } = options;
  const prefix = await folderPrefix(run);
  // `HEAD` when the repository has one, so a file the run staged itself still reads as a change to
  // the file under it. A knowledge repository with no commit yet has no HEAD to name, and there
  // everything the run wrote is new.
  const range = (await run(['rev-parse', 'HEAD'])).code === 0 ? ['HEAD'] : [];

  const files: KnowledgeProposalFile[] = [];
  // Limit: one git call per file, which is one call per note a run wrote. Ask once and split the
  // answer on `diff --git` the day a run writes enough files for this to be felt.
  for (const change of changes) {
    const path = inFolder(change.path, prefix);
    // Every file the run changed, or a sentence. A short list used to be the third answer: a file
    // whose patch could not be read left the proposal while the kept copy still held it, so the
    // team approved a run and got a file nobody on it had seen.
    files.push({ path, diff: await patchOf(run, change.path, path, range) });
  }
  return files;
}

// A change path starts at the repository root, and a proposal names the file as the knowledge
// folder holds it. A folder that is the root itself has no prefix to take off.
const inFolder = (path: string, prefix: string): string => (prefix !== '' && path.startsWith(prefix) ? path.slice(prefix.length) : path);

// Where the knowledge folder sits inside its repository, with a trailing slash, and empty when the
// folder is the repository root.
async function folderPrefix(run: RunGit): Promise<string> {
  const asked = await run(['rev-parse', '--show-prefix']);
  if (asked.code !== 0) throw new Error(said(asked.stderr, 'git could not say where the knowledge folder sits in its repository.'));
  return asked.stdout.trim();
}

// One file's patch. A file git does not track yet has no diff of its own, so it is compared against
// nothing, the way `filePatch` in `git/diff.ts` reads an untracked file of a card.
async function patchOf(run: RunGit, path: string, inFolderPath: string, range: readonly string[]): Promise<string> {
  const tracked = await readPatch(run, ['diff', '--no-color', '--relative', ...range, '--', spec(path)], path);
  if (tracked !== '') return tracked;
  return readPatch(run, ['diff', '--no-color', '--no-index', '--', '/dev/null', inFolderPath], path);
}

/**
 * One git call's patch, or a sentence naming the file.
 *
 * The `--no-index` call answers 1 both for a difference it found and for a path it could not read,
 * and prints the patch only in the first case. So an empty answer with a non-zero code is git
 * failing and not a file that changed nothing: a file the run staged and then removed reads that
 * way, and taken as "no difference" it left the proposal while the kept copy still held it.
 */
async function readPatch(run: RunGit, args: readonly string[], path: string): Promise<string> {
  const answer = await run(args);
  // The caller's runner stops reading one character past the cap and kills git, which is how a note
  // of half a gigabyte never sits in this process whole. What came back is a cut patch, and a cut
  // patch applies wrongly, so the run stops here and the sentence says the size.
  if (Buffer.byteLength(answer.stdout) > PATCH_CAP_BYTES) {
    throw new Error(`The patch of ${path} is over ${PATCH_CAP_BYTES} bytes, which is more than one proposal carries. Keep a file that large out of the knowledge folder.`);
  }
  if (answer.code !== 0 && answer.stdout === '') throw new Error(said(answer.stderr, `git could not read what the run wrote to ${path}.`));
  return answer.stdout;
}

export interface KnowledgeApplyOptions {
  // git in the knowledge folder itself.
  run: RunGit;
  held: HeldKnowledge;
  // Writes the rows the commit belongs to, as the run's own commit does.
  record: (commit: string) => void;
}

/**
 * Writes an approved change back into the folder and commits it.
 *
 * The message names the same card and run as an applied run's commit, because the person approved
 * that run's work and the knowledge history says which card taught which file.
 */
export async function applyKnowledge(options: KnowledgeApplyOptions): Promise<string> {
  const { run, held } = options;
  const root = await repoRoot(run);
  const paths = held.files.map((file) => file.path);

  // The hold put these paths back to HEAD, so anything changed in them now is the person's own
  // edit, made while the change waited. It was never committed, so writing over it would drop work
  // git cannot bring back.
  const theirs = knowledgeChanges([], await knowledgeState(run, paths.map(spec))).map((change) => change.path);
  if (theirs.length > 0) {
    throw new Error(`${theirs.join(', ')} changed since this knowledge change was held. Commit or drop that edit, then approve again.`);
  }

  for (const file of held.files) {
    const target = join(root, file.path);
    if (file.content === null) {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }

  try {
    return await commitPaths(run, knowledgeCommitMessage(held.cardKey, held.runId), paths, options.record);
  } catch (error) {
    // The files are written but not committed. Left there they would sit in the person's knowledge
    // with nobody's approval, and every later run would read them as somebody else's change and
    // leave them out for good.
    throw new Error(`${(error as Error).message} ${await putBack(run, root, paths, 'and the change still waits for you.')}`, { cause: error });
  }
}

/**
 * The message of a revert commit in the knowledge folder.
 *
 * It names the file and the run whose commit is taken back, so the knowledge history reads as a
 * pair: what a card taught, and where that was undone.
 */
export const knowledgeRevertMessage = (cardKey: string, runId: number, path: string): string =>
  `knowledge revert: ${path} from ${cardKey} run ${runId}`;

export interface KnowledgeRevertOptions {
  // git in the knowledge folder itself.
  run: RunGit;
  // The commit that applied the change, and the one file of it to take back.
  sha: string;
  path: string;
  cardKey: string;
  runId: number;
  // Marks the row reverted. It runs after the commit and before this returns: when it throws, the
  // commit is taken back, as the run's own commit does.
  record: (commit: string) => void;
}

/**
 * Takes one file back to what it was before a knowledge commit, as a new commit.
 *
 * A revert is a commit and never a reset, because the history of that repository is the person's
 * and a reset would take whatever they committed on top of it with them. The file has to still be
 * what the commit left, or taking that one commit back would drop the work that came after.
 */
export async function revertKnowledgeFile(options: KnowledgeRevertOptions): Promise<string> {
  const { run, path, sha } = options;
  const short = sha.slice(0, 7);

  const known = await run(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (known.code !== 0) {
    throw new Error(`The knowledge folder has no commit ${short} any more, so ${path} cannot be taken back. Somebody rewrote that history.`);
  }

  // `git diff` below cannot see a file nobody tracked, and a change that removed a note leaves a
  // path the person may have written their own note at. `applyKnowledge` reads the same answer for
  // the same reason, and this is why it asks with `-uall`.
  const theirs = knowledgeChanges([], await knowledgeState(run, [spec(path)])).map((change) => change.path);
  if (theirs.length > 0) {
    throw new Error(`${path} carries an edit nobody committed, so commit ${short} cannot be taken back. Commit or drop that edit first. Nothing was reverted.`);
  }

  // Limit: the commit against the file as it is now, so a revert is offered only while nothing
  // came after it. A later change to another part of the same file could be kept with
  // `git apply --reverse`, which is where to go if people ask for it.
  const since = await run(['diff', '--quiet', sha, '--', spec(path)]);
  if (since.code === 1) {
    throw new Error(`${path} changed after commit ${short}, so that commit cannot be taken back on its own. Nothing was reverted.`);
  }
  if (since.code !== 0) throw new Error(said(since.stderr, `git could not compare ${path} with commit ${short}.`));

  const root = await repoRoot(run);
  await restore(run, root, path, `${sha}^`, `what it was before commit ${short}`);
  try {
    return await commitPaths(run, knowledgeRevertMessage(options.cardKey, options.runId, path), [path], options.record);
  } catch (error) {
    // The file is written back but not committed. Left there it would read as somebody's own edit,
    // and every later run would leave it out as work that is not theirs to commit.
    throw new Error(
      `${(error as Error).message} ${await putBack(run, root, [path], 'and nothing was reverted.', 'what it was before this revert')}`,
      { cause: error },
    );
  }
}

// Every path back to what it was, and the sentence saying whether that worked. A failure here is
// told rather than thrown: the caller is already carrying the reason the commit did not happen.
async function putBack(run: RunGit, root: string, paths: readonly string[], then: string, what?: string): Promise<string> {
  try {
    for (const path of paths) await restore(run, root, path, 'HEAD', what);
    return `The knowledge folder was put back, ${then}`;
  } catch (error) {
    return `The knowledge folder could not be put back either: ${(error as Error).message}`;
  }
}

// The folder the paths of a change are relative to. A change row names a file from the repository
// root, and reading or writing that file needs the root itself.
async function repoRoot(run: RunGit): Promise<string> {
  const top = await run(['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || top.stdout.trim() === '') {
    throw new Error(said(top.stderr, 'git could not say where the knowledge repository starts.'));
  }
  return top.stdout.trim();
}

/**
 * One path, back to the state a commit holds.
 *
 * HEAD for a run that is being put back: a path this run changed was clean when the run started,
 * because `knowledgeChanges` leaves out everything that was already changed. A revert asks for the
 * commit before the one it takes back. Either way, a path that commit does not have was not there,
 * so it goes. The first commit of a repository has no commit before it, and every path in it is a
 * path it added, so removing is the right answer there too. `what` is the words a person reads,
 * because the rev itself is a sha nobody asked for.
 */
async function restore(run: RunGit, root: string, path: string, rev = 'HEAD', what = 'what it was before the run'): Promise<void> {
  // Asked of the commit itself, not read off a failed checkout. A checkout can fail for its own
  // reasons, such as another git holding the index, and deleting a tracked file on that answer
  // would throw away the very content this is meant to bring back.
  const known = await run(['cat-file', '-e', `${rev}:${path}`]);
  if (known.code === 0) {
    const back = await run(['checkout', rev, '--', spec(path)]);
    if (back.code !== 0) throw new Error(said(back.stderr, `git could not put ${path} back to ${what}.`));
    return;
  }

  // That commit has no such path, so this is the change that made it. Removed from disk, and from
  // the index in case anything staged it, which leaves the folder as if it had never been written.
  rmSync(join(root, path), { force: true });
  const cleared = await run(['reset', '--quiet', '--', spec(path)]);
  if (existsSync(join(root, path))) {
    throw new Error(said(cleared.stderr, `git could not put ${path} back to ${what}.`));
  }
}

// Takes back the commit this run made, and nothing else.
//
// When somebody committed on top of it in the meantime, the commit stays where it is. Resetting
// then would take their work with it, and the run's commit is the smaller loss: it sits in the
// knowledge history with no row naming it, so the Knowledge screen never shows it and only a person
// reading the history finds it. This is the one case where a commit and the rows do not agree.
async function undo(run: RunGit, was: string, specs: readonly string[], commit: string): Promise<void> {
  const head = await run(['rev-parse', 'HEAD']);
  if (head.code !== 0 || head.stdout.trim() !== commit) return;

  if (was === '') {
    // The first commit of a repository has no earlier state. The files it held stay staged, which
    // is the closest thing to where they were.
    await run(['update-ref', '-d', 'HEAD']);
    return;
  }
  await run(['reset', '--soft', was]);
  await unstage(run, was, specs);
}

// The run's own paths go back to what the commit before held. A soft reset leaves the whole index
// as the commit left it, so without this the next commit the person makes carries this run's files.
async function unstage(run: RunGit, was: string, specs: readonly string[]): Promise<void> {
  if (was === '') return;
  await run(['reset', '--quiet', '--', ...specs]);
}

// git's own words when it said any, because a person reads what the hook or the repository said
// rather than a sentence invented about it.
const said = (stderr: string, fallback: string): string => (stderr.trim() === '' ? fallback : stderr.trim());
