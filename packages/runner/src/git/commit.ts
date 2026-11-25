import { isAbsolute } from 'node:path';
import { gitEnv } from './env.ts';
import { git } from './exec.ts';

export interface CommitMessage {
  subject: string;
  body: string;
}

// A message as git reads it: the first line is the subject, and the body is
// what follows the blank line under it. A file that is only whitespace gives an empty subject, and
// the caller refuses that before git runs.
export function splitCommitMessage(text: string): CommitMessage {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();

  const subject = (lines.shift() ?? '').trim();
  // Only the blank lines between the subject and the body go. The ones inside the body are the
  // person's paragraphs.
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();

  return { subject, body: lines.join('\n').trimEnd() };
}

// What an engine answered when asked for a message, as the composer's box takes it. A model wraps an
// answer in a code fence often enough to strip one here. The short kind keeps the subject alone,
// whatever else came back, because a body is exactly what the person asked to leave out.
export function draftedMessage(answer: string, short: boolean): string {
  const text = answer
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !line.trim().startsWith('```'))
    .join('\n');
  const { subject, body } = splitCommitMessage(text);
  return short || body === '' ? subject : `${subject}\n\n${body}`;
}

// The longest change a message is written from. A message names the change in one line, so the
// start of a large diff says enough, and the pass that reads it stays cheap.
export const MESSAGE_DIFF_LIMIT = 20_000;

// The work a commit would take, as the text a message is written from: every tracked change against
// the last commit, then the names of the untracked files. Read from git and not the stat the Changes
// tab shows, because the stat says how much changed and a message has to say what.
export async function uncommittedDiff(options: { worktreePath: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<string> {
  const env = gitEnv(options.env ?? process.env);
  const run = (args: readonly string[]) => git(args, { cwd: options.worktreePath, env, signal: options.signal, maxStdout: MESSAGE_DIFF_LIMIT + 1 });
  const tracked = await run(['diff', 'HEAD', '--no-color', '--no-ext-diff']);
  const others = await run(['ls-files', '--others', '--exclude-standard']);
  const added = others.stdout.split('\n').filter((line) => line.trim() !== '');
  const cut = tracked.stdout.length > MESSAGE_DIFF_LIMIT;
  return [
    cut ? `${tracked.stdout.slice(0, MESSAGE_DIFF_LIMIT)}\n[The diff above was cut at ${MESSAGE_DIFF_LIMIT} characters.]` : tracked.stdout,
    ...(added.length > 0 ? ['New files:', ...added] : []),
  ]
    .join('\n')
    .trim();
}

export interface CommitCardOptions {
  worktreePath: string;
  // What the person confirmed in the composer, typed or asked for and then edited.
  message: string;
  // The untracked files they ticked. Tracked changes are always staged, untracked ones never are
  // unless they are named here.
  include?: readonly string[];
  // Every file the person ticked, tracked and untracked, and both paths of a rename. When set, the
  // commit takes exactly these and nothing else: no other tracked change, and nothing staged before.
  only?: readonly string[];
  // The repository's git hooks run only when the person turned them on for this commit. An agent
  // wrote the work, and a hook it planted would run here with the person's full rights.
  hooks?: boolean;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export type CommitResult = { ok: true; commit: string } | { ok: false; reason: string };

// Why a message cannot be committed, or null. The workspace commit holds the same rules.
export function messageProblem(message: string): string | null {
  // A long subject is only warned about, in the box, because git takes any length.
  return message.trim() === '' ? 'The commit message is empty. Write a subject line first, then commit.' : null;
}

// The operation a checkout is in the middle of, by the ref git keeps while it waits for the commit
// that ends it, or null.
async function inProgress(run: (args: readonly string[]) => Promise<{ code: number | null }>): Promise<'merge' | 'cherry-pick' | 'revert' | null> {
  for (const [ref, name] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
    if ((await run(['rev-parse', '-q', '--verify', ref])).code === 0) return name;
  }
  return null;
}

// Stages the card's work and commits it. Nolzu adds no trailer, no co-author line and no tool name,
// and the author stays whoever git is configured as.
export async function commitCard(options: CommitCardOptions): Promise<CommitResult> {
  const message = options.message.replace(/\r\n/g, '\n');
  const problem = messageProblem(message);
  if (problem !== null) return { ok: false, reason: problem };

  const only = options.only;
  for (const path of only ?? options.include ?? []) {
    // Checked before git runs. A path that climbs out would commit a file that belongs to another
    // card, or to no card at all, and an empty one or a bare dot means the whole checkout, which
    // would sweep in every untracked file the person left unticked. One trailing slash is allowed,
    // because that is how git lists a folder holding its own repository.
    // On this machine the empty segment below already catches an absolute path, because one splits
    // with an empty first part. `isAbsolute` is what covers Windows, where `C:\\work` has no empty
    // segment and no test here runs.
    const parts = path.replace(/\/+$/, '').split('/');
    if (isAbsolute(path) || parts.some((part) => part === '' || part === '.' || part === '..')) {
      return { ok: false, reason: `${path} is outside the card's checkout, so it is not this card's to commit.` };
    }
  }

  if (only !== undefined && only.length === 0) return { ok: false, reason: 'No file is ticked. Tick the files to commit, then commit.' };

  const env = gitEnv(options.env ?? process.env);
  const run = (args: readonly string[], hooks = false) => git(args, { cwd: options.worktreePath, env, signal: options.signal, hooks });
  // `:(literal)` so a name holding a bracket or a star means that file and not its siblings.
  const literal = (paths: readonly string[]) => paths.map((path) => `:(literal)${path}`);

  // An unmerged path is not staged by `add -u`, it is marked resolved. That takes git's own refusal
  // away, and the card then commits the conflict markers as a merge commit nobody wrote.
  const unmerged = await run(['ls-files', '--unmerged']);
  if (unmerged.code !== 0) {
    return { ok: false, reason: unmerged.stderr.trim() };
  }
  if (unmerged.stdout.trim() !== '') {
    return {
      ok: false,
      reason: "This checkout has conflicts that are not resolved yet. Fix them in the card's files, mark them resolved with git add, then commit.",
    };
  }

  // While a merge, a cherry-pick or a revert is in progress, git refuses a commit of some paths: "cannot
  // do a partial commit during a merge". The commit that ends one holds the whole result, so the ticked
  // files must be every changed file, and the commit then takes all of them as git expects.
  const midway = await inProgress(run);
  if (midway !== null && only !== undefined) {
    const changed = await run(['diff', 'HEAD', '--name-only', '-z']);
    if (changed.code !== 0) return { ok: false, reason: changed.stderr.trim() };
    const unticked = changed.stdout.split('\0').filter((path) => path !== '' && !only.includes(path));
    if (unticked.length > 0) {
      return {
        ok: false,
        reason: `A ${midway} is in progress, and git commits all of its changes at once. Tick every changed file (${unticked.join(', ')} ${unticked.length === 1 ? 'is' : 'are'} not ticked), or end the ${midway} with git ${midway} --abort.`,
      };
    }
  }
  const whole = midway !== null;

  // git commits only paths it knows, so a ticked new file is added first, and taken out again if the
  // commit fails.
  let added: string[] = [];
  // `reset` and not `rm --cached`: for a folder whose `.git` is a file, rm runs git inside that folder
  // first, under a config a run may have written.
  const undo = async () => {
    // Without the slash git lists a nested repository with: the index holds it as a file-like entry.
    if (added.length > 0) await run(['reset', '-q', '--', ...literal(added.map((path) => path.replace(/\/+$/, '')))]);
  };
  if (only !== undefined) {
    const others = await run(['ls-files', '--others', '--exclude-standard', '-z', '--', ...literal(only)]);
    if (others.code !== 0) return { ok: false, reason: others.stderr.trim() };
    added = others.stdout.split('\0').filter((path) => path !== '');
    if (added.length > 0) {
      const staged = await run(['add', '--', ...literal(added)]);
      if (staged.code !== 0) return { ok: false, reason: staged.stderr.trim() };
    }
    if (whole) {
      const tracked = await run(['add', '-u']);
      if (tracked.code !== 0) return { ok: false, reason: tracked.stderr.trim() };
    }
  } else {
    // Tracked changes only. `add -A` would sweep in every untracked file, including the ones the
    // person deliberately left unticked.
    const tracked = await run(['add', '-u']);
    if (tracked.code !== 0) {
      return { ok: false, reason: tracked.stderr.trim() };
    }
    for (const path of options.include ?? []) {
      const one = await run(['add', '--', ...literal([path])]);
      if (one.code !== 0) {
        return { ok: false, reason: one.stderr.trim() };
      }
    }
  }

  // Read once, for two questions: is anything staged, and is any of it a pointer to another
  // repository. git would refuse an empty commit too, in a paragraph about branches and untracked
  // files. This says the one thing the person needs, and no empty commit is ever made.
  // With a path list it is HEAD to the folder for those paths, because a ticked tracked file is not staged.
  const staged = await run(only === undefined || whole ? ['diff', '--cached', '--raw'] : ['diff', 'HEAD', '--raw', '--', ...literal(only)]);
  if (staged.code !== 0) {
    return { ok: false, reason: staged.stderr.trim() };
  }
  if (staged.stdout.trim() === '') {
    await undo();
    return {
      ok: false,
      reason: 'There is nothing to commit: no tracked file changed, and no untracked file was ticked.',
    };
  }
  // A folder holding its own .git is staged as a pointer to it, so a clone of this repository would
  // get an empty folder where the files are. git only warns about that and carries on.
  const nested = staged.stdout
    .split('\n')
    .find((line) => line.startsWith(':') && line.slice(1).trimStart().split(' ')[1] === '160000');
  if (nested !== undefined) {
    const at = nested.slice(nested.indexOf('\t') + 1);
    await undo();
    return {
      ok: false,
      reason: `${at} has its own .git folder, so git would commit a pointer to it and none of its files. Remove ${at}/.git, or leave it unticked.`,
    };
  }

  // verbatim, so the message is stored exactly as it was confirmed, down to the blank lines.
  // `--only` builds the commit from HEAD plus the ticked paths, so a file staged and not ticked stays
  // staged and out of the commit.
  const partial = only !== undefined && !whole;
  const made = await run(['commit', ...(partial ? ['--only'] : []), '--cleanup=verbatim', '-m', message, ...(partial ? ['--', ...literal(only)] : [])], options.hooks === true);
  if (made.code !== 0) {
    await undo();
    // git's own words, so the person reads what the hook or the signer said rather than a sentence
    // Nolzu made up about it. Measured: git hands a hook's stdout through as its own stderr, so
    // reading stderr covers a hook that prints either way.
    const said = made.stderr.trim();
    return { ok: false, reason: said === '' ? 'git refused the commit and said nothing about why.' : said };
  }

  return { ok: true, commit: (await run(['rev-parse', 'HEAD'])).stdout.trim() };
}
