import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ghRunner } from './gh.ts';

const made: string[] = [];

const folder = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-gh-'));
  made.push(dir);
  return dir;
};

// A `gh` of our own, on a PATH of our own. The real one is never spawned here, and a folder with
// no `gh` in it is how "not installed" is reached. The folder is written into the script as `DIR`,
// because the runner replaces PATH with the one it resolved and the script finds no other tool on
// it.
function fakeGh(body: string): string {
  const dir = folder();
  const file = join(dir, 'gh');
  writeFileSync(file, `#!/bin/sh\nDIR="${dir}"\n${body}\n`);
  chmodSync(file, 0o755);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const live = (): AbortSignal => AbortSignal.timeout(10_000);

// The condition the adapter writes down and cannot keep: a shell would split this query on its
// spaces and newlines and strip its quotes, and the document would reach GitHub in pieces.
it('hands gh every argument whole, so a query with quotes and newlines arrives as it was written', async () => {
  const dir = fakeGh(`printf '%s\\n' "$@" > "$DIR/args.txt"\nprintf '{"data":{}}'`);
  const args = ['api', 'graphql', '-f', 'query=query {\n  t0: repository(owner: "acme", name: "app")\n}'];

  const answer = await ghRunner({ path: () => dir })(args, live());

  expect(answer.stdout).toBe('{"data":{}}');
  expect(readFileSync(join(dir, 'args.txt'), 'utf8')).toBe(`${args.join('\n')}\n`);
});

// The runs lose these tokens, and Nolzu's own gh keeps them: it is how a person who signs gh in
// through the environment reads pull requests and publishes. Dummy values, and the script prints
// names only.
it('hands gh the GitHub tokens of the environment Nolzu runs in', async () => {
  const names = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
  for (const name of names) vi.stubEnv(name, 'dummy');
  const dir = fakeGh(`for name in ${names.join(' ')}; do eval "test -n \\"\\$$name\\"" && echo $name; done`);

  const answer = await ghRunner({ path: () => dir })(['api', 'user'], live());

  expect(answer.stdout.trim().split('\n')).toEqual(names);
});

it('says where to install gh when there is none on the PATH', async () => {
  await expect(ghRunner({ path: () => folder() })(['api', 'graphql'], live())).rejects.toThrow(/Install the GitHub CLI from https:\/\/cli\.github\.com/);
});

// PR watch and the PR reviews board show this sentence too, so it names GitHub and not its issues.
it('names GitHub, not GitHub issues, when gh is missing', async () => {
  await expect(ghRunner({ path: () => folder() })(['api', 'graphql'], live())).rejects.toThrow(
    'gh is not on the PATH, so Nolzu cannot read GitHub. Install the GitHub CLI from https://cli.github.com, then start Nolzu again.',
  );
});

// A different fix from a missing gh, and from an issue that is gone. Measured against gh 2.95.0
// on 2026-09-25: no login exits 4 and prints nothing on stdout.
it('says to run gh auth login when gh has no login', async () => {
  const dir = fakeGh('echo "To get started with GitHub CLI, please run:  gh auth login" >&2\nexit 4');

  await expect(ghRunner({ path: () => dir })(['api', 'graphql'], live())).rejects.toThrow(/Run gh auth login in a terminal/);
});

// `gh` exits 1 when one alias of a document failed and still prints every alias that worked, so a
// non-zero exit is an answer and not a failure. The adapter reads stdout.
it('hands a non-zero exit back with what gh printed, on both streams', async () => {
  const dir = fakeGh(`printf '{"data":{"t0":null}}'\necho 'gh: Bad credentials (HTTP 401)' >&2\nexit 1`);

  const answer = await ghRunner({ path: () => dir })(['api', 'graphql'], live());

  expect(answer).toMatchObject({ code: 1, stdout: '{"data":{"t0":null}}', stderr: 'gh: Bad credentials (HTTP 401)\n' });
});

// Twenty issue bodies are megabytes, and without the cap all of it lands in memory before anyone
// can look at it. The caller gets a sentence, not three megabytes and not half a document.
it('stops a gh that sends more than the cap, and says so', async () => {
  const dir = fakeGh(`${process.execPath} -e 'process.stdout.write("x".repeat(3000000))'`);

  await expect(ghRunner({ path: () => dir, maxStdout: 1000 })(['api', 'graphql'], live())).rejects.toThrow(
    /more than 1000 characters/,
  );
  // The way out, and it is per tool: one `gh` read is one issue for one card, so the issue itself is
  // the thing to open. "Try again" would be a loop, because the same read sends the same bytes.
  await expect(ghRunner({ path: () => dir, maxStdout: 1000 })(['api', 'graphql'], live())).rejects.toThrow(
    /Open the issue on GitHub instead/,
  );
});

// The other side of the cap. Without this a runner that refused everything would pass the test
// above.
it('keeps an answer that fits under the cap', async () => {
  const dir = fakeGh(`${process.execPath} -e 'process.stdout.write("x".repeat(900))'`);

  const answer = await ghRunner({ path: () => dir, maxStdout: 1000 })(['api', 'graphql'], live());

  expect(answer.stdout).toHaveLength(900);
});

// The cap a real read runs under. The two tests above set a cap of their own, so a default of five
// characters would keep them green and drop every answer GitHub ever sends. Two hundred thousand
// characters arrive in several chunks, which is what the cap is checked between.
it('keeps a whole answer under the cap it uses by default', async () => {
  const dir = fakeGh(`${process.execPath} -e 'process.stdout.write("x".repeat(200000))'`);

  const answer = await ghRunner({ path: () => dir })(['api', 'graphql'], live());

  expect(answer.stdout).toHaveLength(200_000);
});

// The deadline the Add card read carries. A `gh` that never answers has to end in a sentence, and
// not in a dialog that spins with nothing to say.
it('says gh did not answer when the deadline passes during the call', async () => {
  // Node by its own path, not `sleep`. The runner hands the child the login shell's PATH, and on a
  // CI runner that PATH held no `sleep`, so the stub exited 127 at once and the deadline never ran.
  // Every other stub here uses a shell builtin or an absolute path for the same reason.
  const dir = fakeGh(`${process.execPath} -e 'setTimeout(() => {}, 5000)'`);

  await expect(ghRunner({ path: () => dir })(['api', 'graphql'], AbortSignal.timeout(100))).rejects.toThrow(
    /did not answer in time/,
  );
});

it('reads nothing when the call was stopped before it started', async () => {
  const dir = fakeGh(`printf '{"data":{}}'`);

  await expect(ghRunner({ path: () => dir })(['api', 'graphql'], AbortSignal.abort())).rejects.toThrow(/stopped before it started/);
});
