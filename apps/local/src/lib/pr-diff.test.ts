import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv, type RunGh } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { numberDiff, writePrDiff } from './pr-diff.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-pr-diff-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The card folder of a pull request card, key and all. The key holds a `#`, and it has to survive
// the folder name and the argument list.
const taskDir = () => join(dir, '.tasks', 'recipes#41');
const patchPath = () => join(taskDir(), 'pr-review', 'diff.patch');

const PATCH = `diff --git a/src/recipes/list.ts b/src/recipes/list.ts
@@ -1,2 +1,2 @@
-  return recipes.map((recipe) => recipe.title);
+  return recipes.filter((recipe) => recipe.ready).map((recipe) => recipe.title);
`;

/**
 * HAND WRITTEN, AND NOT RECORDED. `gh pr diff` has never been run against GitHub here: that is a
 * call to an outside service with a person's own login, so this stub is a documented shape and not a
 * measured one.
 *
 * Four facts the first real call has to confirm. It exits 0 for a diff it could read. Its stdout
 * ends with a newline, which is what the byte-for-byte test below is written against. A binary file
 * inside the diff prints as `Binary files a/... and b/... differ` and no hunk. A diff GitHub refuses
 * for size prints something on stderr with a non-zero exit, and the sentence that reaches the card
 * is only as good as what it prints.
 */
const stub = (answer: { code?: number; stdout?: string; stderr?: string } = {}) => {
  const calls: string[][] = [];
  const run: RunGh = (args) => {
    calls.push([...args]);
    return Promise.resolve({ code: answer.code ?? 0, stdout: answer.stdout ?? PATCH, stderr: answer.stderr ?? '' });
  };
  return { run, calls };
};

const live = () => AbortSignal.timeout(2000);

it('writes what gh printed, byte for byte with line numbers, and asks gh for that pull request', async () => {
  const gh = stub();

  const file = await writePrDiff({ taskDir: taskDir(), sourceRef: 'cook/recipes#41', gh: gh.run, signal: live() });

  expect(file).toBe(patchPath());
  expect(readFileSync(patchPath(), 'utf8')).toBe(`diff --git a/src/recipes/list.ts b/src/recipes/list.ts
@@ -1,2 +1,2 @@
  -  return recipes.map((recipe) => recipe.title);
1 +  return recipes.filter((recipe) => recipe.ready).map((recipe) => recipe.title);
`);
  expect(gh.calls).toEqual([['pr', 'diff', '41', '--repo', 'cook/recipes', '--color', 'never']]);
});

it('throws one sentence naming the pull request when gh exits non-zero, and writes no file', async () => {
  const gh = stub({ code: 1, stdout: '', stderr: 'could not find any pull request\n' });

  await expect(writePrDiff({ taskDir: taskDir(), sourceRef: 'cook/recipes#41', gh: gh.run, signal: live() })).rejects.toThrow(
    /cook\/recipes#41.*exited 1.*could not find any pull request/s,
  );
  expect(existsSync(patchPath())).toBe(false);
});

// An empty answer is not an empty pull request. `gh` prints nothing when it refused the call for a
// reason it only wrote on stderr, and a file with no bytes in it would read to the agent as a diff.
it('throws when gh printed no diff, and writes no file', async () => {
  const gh = stub({ stdout: '' });

  await expect(writePrDiff({ taskDir: taskDir(), sourceRef: 'cook/recipes#41', gh: gh.run, signal: live() })).rejects.toThrow(/empty diff for cook\/recipes#41/);
  expect(existsSync(patchPath())).toBe(false);
});

// A finding's place is the line in the file after the change. A reviewer that counted from the `@@`
// header, or took the line of the diff file its reader prints, put a real finding ten lines off.
it('puts the line in the file after the change in front of each hunk line', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -7,3 +7,4 @@ function cook() {',
    ' keep',
    '-gone',
    '+one',
    '+two',
    ' keep',
    '@@ -98 +99,2 @@',
    ' last',
    '+added',
    '\\ No newline at end of file',
    'diff --git a/src/b.ts b/src/b.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1 @@',
    '+--- not a header',
    'Binary files a/logo.png and b/logo.png differ',
    '',
  ].join('\n');

  expect(numberDiff(patch).split('\n')).toEqual([
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -7,3 +7,4 @@ function cook() {',
    '  7  keep',
    '    -gone',
    '  8 +one',
    '  9 +two',
    ' 10  keep',
    '@@ -98 +99,2 @@',
    ' 99  last',
    '100 +added',
    '    \\ No newline at end of file',
    'diff --git a/src/b.ts b/src/b.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/b.ts',
    '@@ -0,0 +1 @@',
    '  1 +--- not a header',
    'Binary files a/logo.png and b/logo.png differ',
    '',
  ]);
});

// Nothing is called for a ref the writer cannot turn into a repository and a number. A bare
// `recipes#41` is refused as well: `--repo` takes the owner, and guessing one reads somebody else's
// pull request.
it.each([
  ['a card with no source ref', null],
  ['a local key', 'APP-1'],
  ['a ref with no owner', 'recipes#41'],
  ['free text', 'Cache the recipe list'],
])('throws for %s without calling gh', async (_what, sourceRef) => {
  const gh = stub();

  await expect(writePrDiff({ taskDir: taskDir(), sourceRef, gh: gh.run, signal: live() })).rejects.toThrow(/does not know which diff to read/);
  expect(gh.calls).toEqual([]);
  expect(existsSync(patchPath())).toBe(false);
});

// A run in fake mode reads a file like a real one.
//
// Whatever the card names, and that is the point. Nothing a run in fake mode can make carries a pull
// request, so a fake mode that read the ref first would leave the PR reviews board unusable
// without a gh login.
it.each([
  ['a pull request ref', 'cook/recipes#41'],
  ['no source ref', null],
  ['a local key', 'APP-1'],
])('writes its built-in patch in fake mode, for a card with %s', async (_what, sourceRef) => {
  await writePrDiff({ taskDir: taskDir(), sourceRef, gh: null, signal: live() });

  const written = readFileSync(patchPath(), 'utf8');
  expect(written).toContain('diff --git');
  expect(written.endsWith('\n')).toBe(true);
});

// One diff for one run. The fake engine replays a Read of this file and answers with bytes of its
// own, so those bytes have to be these: two different diffs in the transcript and the Files tab are
// two diffs a person has to tell apart.
it('writes the bytes the fake engine replays as the read of it', async () => {
  await writePrDiff({ taskDir: taskDir(), sourceRef: null, gh: null, signal: live() });
  const fixture = readFileSync(new URL('../../../../packages/runner/fake/pr-review.ndjson', import.meta.url), 'utf8');

  const replayed = fixture
    .split('\n')
    .filter((line) => line.includes('toolu_fake_pr_review_01') && line.includes('tool_result'))
    .map((line) => (JSON.parse(line) as { message: { content: { content: string }[] } }).message.content[0]?.content);

  expect(replayed).toEqual([readFileSync(patchPath(), 'utf8')]);
});

// GitHub refuses a diff over 300 files with a 406, and `gh`'s runner drops an answer over its cap.
// Either way the diff comes from git: a real origin with a pull request ref, and a clone of it.
describe('a diff GitHub will not send', () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Cook', '-c', 'user.email=cook@example.com', ...args], { cwd, encoding: 'utf8' });
  const said = 'could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300).';
  const tooBig = (how: 'refused' | 'cut') => {
    const calls: string[][] = [];
    const run: RunGh = (args) => {
      calls.push([...args]);
      if (args[1] === 'view') return Promise.resolve({ code: 0, stdout: 'main\n', stderr: '' });
      if (how === 'cut') return Promise.reject(new Error('GitHub sent more than 4000000 characters for one read, so the answer was dropped.'));
      return Promise.resolve({ code: 1, stdout: '', stderr: `${said}\n` });
    };
    return { run, calls };
  };

  // main gets a.txt; the pull request changes it and adds b.txt; main then moves on with c.txt, which
  // GitHub leaves out of the diff, because it compares from where the head left the base.
  const remote = () => {
    const work = join(dir, 'work');
    sh(dir, 'init', '-q', '-b', 'main', work);
    writeFileSync(join(work, 'a.txt'), 'one\n');
    sh(work, 'add', '.');
    sh(work, 'commit', '-qm', 'a');
    sh(work, 'checkout', '-qb', 'feature');
    writeFileSync(join(work, 'a.txt'), 'two\n');
    writeFileSync(join(work, 'b.txt'), 'new\n');
    sh(work, 'add', '.');
    sh(work, 'commit', '-qm', 'b');
    sh(work, 'checkout', '-q', 'main');
    writeFileSync(join(work, 'c.txt'), 'later\n');
    sh(work, 'add', '.');
    sh(work, 'commit', '-qm', 'c');
    sh(dir, 'clone', '-q', '--bare', work, join(dir, 'origin.git'));
    sh(join(dir, 'origin.git'), 'update-ref', 'refs/pull/41/head', 'feature');
    sh(dir, 'clone', '-q', join(dir, 'origin.git'), join(dir, 'recipes'));
    return join(dir, 'recipes');
  };

  it.each(['refused', 'cut'] as const)('reads it from git when GitHub %s it, and leaves no ref behind', async (how) => {
    const local = remote();
    const gh = tooBig(how);
    const notes: string[] = [];
    const asked: string[] = [];

    await writePrDiff({
      taskDir: taskDir(),
      sourceRef: 'cook/recipes#41',
      gh: gh.run,
      signal: AbortSignal.timeout(10_000),
      localRepo: (owner, repo) => (asked.push(`${owner}/${repo}`), Promise.resolve(local)),
      gitEnv: gitEnv(process.env),
      note: (line) => notes.push(line),
    });

    const patch = readFileSync(patchPath(), 'utf8');
    expect(patch).toBe(numberDiff(sh(join(dir, 'work'), 'diff', '--no-color', '-M', 'main...feature')));
    expect(patch).toContain('b/b.txt');
    expect(patch).not.toContain('c.txt');
    expect(asked).toEqual(['cook/recipes']);
    expect(gh.calls.at(-1)).toEqual(['pr', 'view', '41', '--repo', 'cook/recipes', '--json', 'baseRefName', '--jq', '.baseRefName']);
    expect(notes).toEqual([expect.stringMatching(/^GitHub sends no diff for cook\/recipes#41 \(.+\), so Nolzu read it from git in .+recipes: 2 files\.$/)]);
    expect(sh(local, 'for-each-ref', 'refs/nolzu')).toBe('');
    expect(sh(local, 'branch', '--list')).toBe('* main\n');
  });

  it('says why when no repository of the project has that origin, and writes no file', async () => {
    const run = writePrDiff({ taskDir: taskDir(), sourceRef: 'cook/recipes#41', gh: tooBig('refused').run, signal: live(), localRepo: () => Promise.resolve(null) });

    await expect(run).rejects.toThrow(`GitHub sends no diff for cook/recipes#41 (GitHub said: ${said}), and Nolzu could not read it from git either: no repository of this project has cook/recipes as its origin. Add it to the project, or review this pull request on GitHub.`);
    expect(existsSync(patchPath())).toBe(false);
  });

  it("says git's own words when the fetch fails", async () => {
    const local = remote();
    sh(join(dir, 'origin.git'), 'update-ref', '-d', 'refs/pull/41/head');

    const run = writePrDiff({ taskDir: taskDir(), sourceRef: 'cook/recipes#41', gh: tooBig('refused').run, signal: AbortSignal.timeout(10_000), localRepo: () => Promise.resolve(local), gitEnv: gitEnv(process.env) });

    await expect(run).rejects.toThrow(/could not read it from git either: git fetch in .+recipes exited 128 and said: fatal: couldn't find remote ref refs\/pull\/41\/head/);
    expect(existsSync(patchPath())).toBe(false);
  });
});
