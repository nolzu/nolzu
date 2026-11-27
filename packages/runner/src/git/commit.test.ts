import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempRepo, type TempRepo } from '../../test/temp-repo.ts';
import { commitCard, draftedMessage, MESSAGE_DIFF_LIMIT, splitCommitMessage, uncommittedDiff } from './commit.ts';

it('splits the subject from the body at the first blank line', () => {
  const message = splitCommitMessage('feat(ui): add the search box\n\nThe list was long enough to need one.\n');

  expect(message.subject).toBe('feat(ui): add the search box');
  expect(message.body).toBe('The list was long enough to need one.');
});

it('gives an empty body for a one line message', () => {
  expect(splitCommitMessage('fix(core): stop the second write\n').body).toBe('');
});

it('trims the blank lines around the text, and keeps the ones inside the body', () => {
  const message = splitCommitMessage('\n\nfix(core): stop the second write\n\nfirst paragraph\n\nsecond paragraph\n\n\n');

  expect(message.subject).toBe('fix(core): stop the second write');
  expect(message.body).toBe('first paragraph\n\nsecond paragraph');
});

it('keeps a long subject whole rather than cutting it', () => {
  const subject = 'feat(runner): '.padEnd(100, 'x');
  const message = splitCommitMessage(`${subject}\n\nbody\n`);

  expect(message.subject).toBe(subject);
  expect(message.subject).toHaveLength(100);
});

it('reads a message that is only whitespace as empty', () => {
  const message = splitCommitMessage('   \n\n  \n');

  expect(message.subject).toBe('');
  expect(message.body).toBe('');
});

it('keeps the body when no blank line separates it, because git reads it that way too', () => {
  const message = splitCommitMessage('fix(core): stop the second write\nthe body nobody separated\n');

  expect(message.subject).toBe('fix(core): stop the second write');
  expect(message.body).toBe('the body nobody separated');
});

it('trims the whitespace around the subject itself', () => {
  const message = splitCommitMessage('   fix(core): stop the second write   \n\nbody\n');

  expect(message.subject).toBe('fix(core): stop the second write');
});

it('reads a message written with windows line endings', () => {
  const message = splitCommitMessage('fix(core): stop the second write\r\n\r\nfirst\r\n\r\nsecond\r\n');

  expect(message.subject).toBe('fix(core): stop the second write');
  // The trims take the carriage returns at both ends, so only a body of two paragraphs shows one
  // left in the middle. Left there it travels into the commit and into every log tool.
  expect(message.body).toBe('first\n\nsecond');
  expect(message.body).not.toContain('\r');
});

it('takes an engine answer as the message, without the code fence around it', () => {
  expect(draftedMessage('```\nfeat(list): add the search box\n\nThe list was long.\n```\n', false)).toBe('feat(list): add the search box\n\nThe list was long.');
});

it('keeps the subject alone for the short kind, even when the answer carried a body', () => {
  expect(draftedMessage('feat(list): add the search box\n\nThe list was long.\n', true)).toBe('feat(list): add the search box');
});

it('gives an empty message for an empty answer', () => {
  expect(draftedMessage('  \n```\n```\n', false)).toBe('');
});

let repo: TempRepo | null = null;

afterEach(() => {
  repo?.remove();
  repo = null;
});

const cardRepo = (): TempRepo => {
  const made = tempRepo('nolzu-commit-');
  repo = made;
  made.write('a.txt', 'a\n');
  made.commit('first commit');
  return made;
};

const commit = (made: TempRepo, message: string, include?: readonly string[], hooks?: boolean) =>
  commitCard({ worktreePath: made.dir, repo: { project: made.dir, workTree: made.dir }, message, include, env: made.env, hooks });

const hook = (made: TempRepo, body: string): void => {
  const at = join(made.dir, '.git', 'hooks', 'pre-commit');
  writeFileSync(at, body);
  chmodSync(at, 0o755);
};

it('reads the tracked changes and names the new files, for the message to be written from', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');
  made.write('new.txt', 'new\n');

  const diff = await uncommittedDiff({ worktreePath: made.dir, env: made.env });

  expect(diff).toContain('+changed');
  expect(diff).toContain('New files:\nnew.txt');
  expect(diff).not.toContain('cut at');
});

it('cuts a large diff and says where', async () => {
  const made = cardRepo();
  made.write('a.txt', `${'line\n'.repeat(MESSAGE_DIFF_LIMIT)}`);

  const diff = await uncommittedDiff({ worktreePath: made.dir, env: made.env });

  expect(diff).toContain(`[The diff above was cut at ${MESSAGE_DIFF_LIMIT} characters.]`);
  expect(diff.length).toBeLessThan(MESSAGE_DIFF_LIMIT + 100);
});

it('commits the tracked changes', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');

  const result = await commit(made, 'fix(list): change a');

  expect(result.ok).toBe(true);
  expect(made.run('log', '-1', '--format=%s').trim()).toBe('fix(list): change a');
  expect(made.run('status', '--porcelain').trim()).toBe('');
});

it('commits an untracked file only when it was ticked', async () => {
  const made = cardRepo();
  made.write('ticked.txt', 'in\n');
  made.write('unticked.txt', 'out\n');

  const result = await commit(made, 'feat(list): add one file', ['ticked.txt']);

  expect(result.ok).toBe(true);
  expect(made.run('show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual(['ticked.txt']);
  expect(made.run('status', '--porcelain').trim()).toContain('unticked.txt');
});

// The composer ticks every changed file, tracked ones too, and sends the ticked paths. The commit
// takes exactly those: an unticked tracked change stays in the folder, and so does one staged before.
it('commits exactly the ticked paths, tracked and new, and leaves an unticked change and a staged one out', async () => {
  const made = cardRepo();
  made.write('b.txt', 'b\n');
  made.write('c.txt', 'c\n');
  made.commit('two more');
  made.write('a.txt', 'a\nchanged\n');
  made.write('b.txt', 'b\nchanged\n');
  made.write('c.txt', 'c\nstaged\n');
  made.run('add', 'c.txt');
  made.write('new.txt', 'new\n');
  made.write('left.txt', 'left\n');

  const result = await commitCard({ worktreePath: made.dir, repo: { project: made.dir, workTree: made.dir }, message: 'feat(list): two files', only: ['a.txt', 'new.txt'], env: made.env });

  expect(result.ok).toBe(true);
  expect(made.run('show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual(['a.txt', 'new.txt']);
  expect(made.run('status', '--porcelain').split('\n').filter((line) => line !== '').sort()).toEqual([' M b.txt', '?? left.txt', 'M  c.txt']);
});

it('commits both paths of a ticked rename, and refuses an empty tick list before git runs', async () => {
  const made = cardRepo();
  made.run('mv', 'a.txt', 'renamed.txt');

  expect(await commitCard({ worktreePath: made.dir, repo: { project: made.dir, workTree: made.dir }, message: 'feat: none', only: [], env: made.env })).toEqual({ ok: false, reason: 'No file is ticked. Tick the files to commit, then commit.' });
  const result = await commitCard({ worktreePath: made.dir, repo: { project: made.dir, workTree: made.dir }, message: 'refactor: rename a', only: ['renamed.txt', 'a.txt'], env: made.env });

  expect(result.ok).toBe(true);
  expect(made.run('status', '--porcelain').trim()).toBe('');
});

it('takes a ticked new file out of the index again when git refuses the commit', async () => {
  const made = cardRepo();
  made.write('new.txt', 'new\n');
  hook(made, '#!/bin/sh\necho no >&2\nexit 1\n');

  const result = await commitCard({ worktreePath: made.dir, repo: { project: made.dir, workTree: made.dir }, message: 'feat: new', only: ['new.txt'], hooks: true, env: made.env });

  expect(result.ok).toBe(false);
  expect(made.run('status', '--porcelain').trim()).toBe('?? new.txt');
});

it('refuses a ticked path that points outside the card checkout', async () => {
  const made = cardRepo();
  writeFileSync(join(made.dir, '..', 'outside.txt'), 'not this card\n');
  const before = made.run('rev-parse', 'HEAD').trim();

  const result = await commit(made, 'feat(list): reach out', ['../outside.txt']);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  // The module's own sentence, not git's refusal: the guard runs before anything is staged.
  expect(result.reason).toContain("outside the card's checkout");
  expect(result.reason).toContain('../outside.txt');
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
});

it('keeps the message byte for byte, and adds no trailer of its own', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');
  const message = 'feat(list): add the search box\n\nThe list needed one.\nA second line.';

  await commit(made, message);

  const stored = made.run('log', '-1', '--format=%B');
  expect(stored.trimEnd()).toBe(message);
  expect(stored).not.toMatch(/co-authored-by|generated with/i);
});

it('keeps the author the person git is configured as', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');

  await commit(made, 'fix(list): change a');

  expect(made.run('log', '-1', '--format=%an').trim()).toBe('Demo');
});

it('refuses an empty message before git runs', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');
  const before = made.run('rev-parse', 'HEAD').trim();

  const result = await commit(made, '   \n\n  ');

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toMatch(/message/i);
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
});

it('commits a subject of any length, as git does', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');
  const subject = `feat(list): ${'x'.repeat(100)}`;

  expect((await commit(made, `${subject}\n\nbody\n`)).ok).toBe(true);
  expect(made.run('log', '-1', '--format=%s').trim()).toBe(subject);
});

it('reports nothing to commit rather than making an empty commit', async () => {
  const made = cardRepo();
  const before = made.run('rev-parse', 'HEAD').trim();

  const result = await commit(made, 'fix(list): nothing changed');

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('There is nothing to commit');
  expect(result.reason).toContain('no untracked file was ticked');
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
});

it('keeps the words of a hook that refused the commit', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');
  hook(made, '#!/bin/sh\necho "the tests are red" 1>&2\nexit 1\n');
  const before = made.run('rev-parse', 'HEAD').trim();

  const result = await commit(made, 'fix(list): change a', undefined, true);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('the tests are red');
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
});

it('keeps git own words when signing is on and no signer is there', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');
  made.run('config', 'commit.gpgsign', 'true');
  made.run('config', 'gpg.program', join(made.dir, 'no-such-gpg'));
  const before = made.run('rev-parse', 'HEAD').trim();

  const result = await commit(made, 'fix(list): change a');

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toMatch(/gpg|sign/i);
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
});

it('stages the ticked file only, when its name holds a glob character', async () => {
  const made = cardRepo();
  made.write('routes/[id]/page.svelte', 'bracket\n');
  made.write('routes/i/page.svelte', 'sibling\n');

  const result = await commit(made, 'feat(routes): add one page', ['routes/[id]/page.svelte']);

  expect(result.ok).toBe(true);
  // A path is a pathspec to git, so the brackets matched the sibling and committed it too.
  expect(made.run('show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual(['routes/[id]/page.svelte']);
});

it('keeps the message free of carriage returns, whatever the composer sent', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');

  await commit(made, 'fix(list): windows composer\r\n\r\nthe body\r\n');

  // A browser form sends every newline as a carriage return and a newline.
  expect(made.run('log', '-1', '--format=%B')).not.toContain('\r');
});

it('keeps the words of a hook that wrote them to stdout', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');
  hook(made, '#!/bin/sh\necho "the tests are red"\nexit 1\n');

  const result = await commit(made, 'fix(list): change a', undefined, true);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  // Most hooks print to stdout, and git hands that through as its own stdout.
  expect(result.reason).toContain('the tests are red');
});

it('stores the message as it was written, down to the trailing spaces', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');

  await commit(made, 'fix(list): keep the shape\n\nbody with spaces   ');

  // git cleans a message up by default, which would edit what the person confirmed.
  expect(made.run('log', '-1', '--format=%B')).toContain('spaces   ');
});

it('refuses a checkout whose conflicts are not resolved', async () => {
  const made = cardRepo();
  made.write('c.txt', 'base\n');
  made.commit('add c');
  made.run('checkout', '-q', '-b', 'other');
  made.write('c.txt', 'theirs\n');
  made.commit('theirs');
  made.run('checkout', '-q', 'main');
  made.write('c.txt', 'ours\n');
  made.commit('ours');
  try {
    made.run('merge', 'other');
  } catch {
    // The conflict is the point of the fixture.
  }
  const before = made.run('rev-parse', 'HEAD').trim();

  const result = await commit(made, 'fix(list): finish the merge');

  // `add -u` marks an unmerged path resolved, which would commit the conflict markers as a merge
  // commit nobody wrote.
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('conflicts');
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
  expect(made.run('status', '--porcelain')).toContain('UU');
});

it('refuses a ticked folder that holds its own git repository', async () => {
  const made = cardRepo();
  made.write('ui-kit/src/index.ts', 'export const x = 1;\n');
  const inner = join(made.dir, 'ui-kit');
  execFileSync('git', ['init', '-q', '-b', 'main', inner], { env: made.env });
  execFileSync('git', ['add', '-A'], { cwd: inner, env: made.env });
  execFileSync('git', ['commit', '-qm', 'inner'], { cwd: inner, env: made.env });
  const before = made.run('rev-parse', 'HEAD').trim();

  const result = await commit(made, 'feat(ui): add the kit', ['ui-kit/']);

  // git records a pointer to the inner repository and none of its files, and only warns about it.
  expect(result.ok).toBe(false);
  if (result.ok) return;
  // The nested reason, not the one about climbing out of the checkout: this folder is inside it.
  expect(result.reason).toContain('has its own .git folder');
  expect(result.reason).toContain('ui-kit');
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
});

it('makes no commit when git refuses a ticked path', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');
  const before = made.run('rev-parse', 'HEAD').trim();

  // The tick list was drawn before the file was renamed away. Reporting the commit as made would
  // hide that the file never went in.
  const result = await commit(made, 'feat(list): add the notes', ['notes.txt']);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain('notes.txt');
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
});

it.each(['', '.', './'])('refuses the ticked path %o, which would mean the whole checkout', async (path) => {
  const made = cardRepo();
  made.write('ticked.txt', 'in\n');
  made.write('unticked.txt', 'out\n');
  const before = made.run('rev-parse', 'HEAD').trim();

  const result = await commit(made, 'feat(list): add everything', [path]);

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("outside the card's checkout");
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
});

it('refuses a ticked path given as an absolute one', async () => {
  const made = cardRepo();
  made.write('ticked.txt', 'in\n');
  const before = made.run('rev-parse', 'HEAD').trim();

  const result = await commit(made, 'feat(list): add one file', [join(made.dir, 'ticked.txt')]);

  // An absolute path reads as a pathspec from the repository root, so it names a different file.
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.reason).toContain("outside the card's checkout");
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
});

it('runs no hook of the repository unless the person turned hooks on', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');
  const mark = join(made.dir, '..', 'hook-ran');
  hook(made, `#!/bin/sh\ntouch "${mark}"\nexit 1\n`);

  const result = await commit(made, 'fix(list): change a');

  expect(result.ok).toBe(true);
  expect(existsSync(mark)).toBe(false);
});

it('runs no hook from a folder the checkout names, as husky sets it up', async () => {
  const made = cardRepo();
  // An agent can write .husky/pre-commit, because it is a plain file in the checkout.
  made.write('.husky/pre-commit', '#!/bin/sh\ntouch planted\n');
  chmodSync(join(made.dir, '.husky', 'pre-commit'), 0o755);
  made.run('config', 'core.hooksPath', '.husky');

  const result = await commit(made, 'chore: add husky', ['.husky/pre-commit']);

  expect(result.ok).toBe(true);
  expect(existsSync(join(made.dir, 'planted'))).toBe(false);
});

it('runs the hook when the person turned hooks on for this commit', async () => {
  const made = cardRepo();
  made.write('a.txt', 'a\nchanged\n');
  // In the git folder: the hook runs inside the git wall, which allows the repository only.
  const mark = join(made.dir, '.git', 'hook-ran');
  hook(made, `#!/bin/sh\ntouch "${mark}"\n`);

  const result = await commit(made, 'fix(list): change a', undefined, true);

  expect(result.ok).toBe(true);
  expect(existsSync(mark)).toBe(true);
});

// A run made `vendor-lib` with a repository in it whose `.git` is a file, the shape submodule add makes,
// and named a filter in that repository's config. The person ticks the folder and presses Commit: the
// commit is refused, and undoing the add runs no git inside the folder, so the filter never runs.
it.each(['file', 'folder'] as const)('refuses a ticked folder whose .git is a %s, and runs no filter it names', async (shape) => {
  const made = cardRepo();
  made.write('.gitignore', '/.vendor-git/\n');
  made.commit('ignore the vendor git folder');
  const marker = join(made.dir, '..', `filter-ran-${shape}`);
  const sub = join(made.dir, 'vendor-lib');
  const gitDir = shape === 'file' ? join(made.dir, '.vendor-git') : join(sub, '.git');
  mkdirSync(sub);
  const inSub = (...args: string[]) => execFileSync('git', args, { cwd: sub, env: made.env });
  inSub('init', '-q', '-b', 'main', ...(shape === 'file' ? ['--separate-git-dir', gitDir] : []), '.');
  writeFileSync(join(sub, 'lib.txt'), 'data\n');
  inSub('add', 'lib.txt');
  inSub('commit', '-q', '-m', 'lib');
  inSub('config', 'filter.x.clean', `sh -c 'touch ${marker}; cat'`);
  mkdirSync(join(gitDir, 'info'), { recursive: true });
  writeFileSync(join(gitDir, 'info', 'attributes'), '* filter=x\n');
  inSub('read-tree', 'HEAD');
  const before = made.run('rev-parse', 'HEAD').trim();

  // The composer passes the ticked paths as `only`.
  const result = await commitCard({ worktreePath: made.dir, repo: { project: made.dir, workTree: made.dir }, message: 'feat: add the library', only: ['vendor-lib/'], env: made.env });

  expect(result.ok).toBe(false);
  expect(existsSync(marker)).toBe(false);
  expect(made.run('rev-parse', 'HEAD').trim()).toBe(before);
  // Taken out of the index again.
  expect(made.run('ls-files', '--stage', '--', 'vendor-lib').trim()).toBe('');
});

// After an agent resolved a merge's conflicts, Commit on the Changes tab used to say
// "fatal: cannot do a partial commit during a merge". The commit that ends a merge holds every change.
const conflicted = (how: 'merge' | 'cherry-pick'): TempRepo => {
  const made = cardRepo();
  made.run('checkout', '-q', '-b', 'other');
  made.write('a.txt', 'a\nfrom other\n');
  made.write('o.txt', 'o\n');
  made.commit('other side');
  made.run('checkout', '-q', 'main');
  made.write('a.txt', 'a\nfrom main\n');
  made.commit('main side');
  try {
    // A cherry-pick with a commit to make, so git keeps CHERRY_PICK_HEAD as it waits.
    made.run(...(how === 'merge' ? ['merge', '--no-edit'] : ['cherry-pick']), 'other');
  } catch {
    // The conflict in a.txt is the point.
  }
  made.write('a.txt', 'a\nfrom main\nfrom other\n');
  made.run('add', 'a.txt');
  made.write('note.txt', 'left out\n');
  return made;
};

it('ends a merge with one merge commit when every changed file is ticked, and leaves an unticked new file out', async () => {
  const made = conflicted('merge');
  const result = await commitCard({ worktreePath: made.dir, repo: { project: made.dir, workTree: made.dir }, message: 'merge: take main into the card', only: ['a.txt', 'o.txt'], env: made.env });
  expect(result).toMatchObject({ ok: true });
  expect(made.run('rev-list', '--parents', '-n', '1', 'HEAD').trim().split(' ')).toHaveLength(3);
  expect(made.run('show', 'HEAD:a.txt')).toBe('a\nfrom main\nfrom other\n');
  expect(made.run('status', '--porcelain').trim()).toBe('?? note.txt');
});

it('takes the ticked files as they are in the folder, also when edited after the merge staged them', async () => {
  const made = conflicted('merge');
  made.write('o.txt', 'o\nedited after the merge\n');
  const result = await commitCard({ worktreePath: made.dir, repo: { project: made.dir, workTree: made.dir }, message: 'merge: with the later edit', only: ['a.txt', 'o.txt'], env: made.env });
  expect(result).toMatchObject({ ok: true });
  expect(made.run('show', 'HEAD:o.txt')).toBe('o\nedited after the merge\n');
});

it('refuses a merge commit of some of its files, naming the unticked ones, and keeps the merge going', async () => {
  const made = conflicted('merge');
  const result = await commitCard({ worktreePath: made.dir, repo: { project: made.dir, workTree: made.dir }, message: 'merge: half', only: ['a.txt'], env: made.env });
  expect(result).toEqual({
    ok: false,
    reason: 'A merge is in progress, and git commits all of its changes at once. Tick every changed file (o.txt is not ticked), or end the merge with git merge --abort.',
  });
  expect(made.run('rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).not.toBe('');
});

it('ends a cherry-pick the same way', async () => {
  const made = conflicted('cherry-pick');
  const result = await commitCard({ worktreePath: made.dir, repo: { project: made.dir, workTree: made.dir }, message: 'fix: take the other side', only: ['a.txt', 'o.txt'], env: made.env });
  expect(result).toMatchObject({ ok: true });
  expect(made.run('show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()).toEqual(['a.txt', 'o.txt']);
});
