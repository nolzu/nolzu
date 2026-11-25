import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { RunEvent } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { detectEngines, ENGINE_INSTALLS, enginesOnPath, parseVersion, type RunCommand, usedApiKey } from './detect.ts';

// A command runner that answers from a table and records every call, so no test starts a real CLI.
function runner(answers: Record<string, Awaited<ReturnType<RunCommand>>>) {
  const calls: string[][] = [];
  const run: RunCommand = async (binary, args) => {
    calls.push([binary, ...args]);
    return answers[binary] ?? { code: null, stdout: '', missing: true };
  };
  return { run, calls };
}

it.each([
  ['2.1.278 (Claude Code)', '2.1.278'],
  ['codex-cli 0.145.0', '0.145.0'],
  ['2026.08.11-5f2a1c9', '2026.08.11'],
  ['no version here', null],
  ['', null],
])('reads the version out of %j', (stdout, version) => {
  expect(parseVersion(stdout)).toBe(version);
});

it('reports every engine with its version, found on the PATH', async () => {
  const { run } = runner({
    claude: { code: 0, stdout: '2.1.278 (Claude Code)\n' },
    'cursor-agent': { code: 0, stdout: '2026.08.11-5f2a1c9\n' },
    codex: { code: 0, stdout: 'codex-cli 0.145.0\n' },
  });

  const found = await detectEngines(run);

  expect(found.map((engine) => [engine.engine, engine.found, engine.version])).toEqual([
    ['claude-code', true, '2.1.278'],
    ['cursor', true, '2026.08.11'],
    ['codex', true, '0.145.0'],
  ]);
});

it('reports a missing engine as not found, with the page that says how to install it', async () => {
  const { run } = runner({});

  const claude = (await detectEngines(run)).find((engine) => engine.engine === 'claude-code');

  expect(claude).toMatchObject({ found: false, version: null, install: 'https://code.claude.com/docs/en/setup' });
});

// Some CLIs print their version and still exit with a code. The binary is there all the same.
it('reads a version the engine printed before it exited with an error', async () => {
  const { run } = runner({ codex: { code: 1, stdout: 'codex-cli 0.145.0\n' } });

  expect((await detectEngines(run)).find((engine) => engine.engine === 'codex')).toMatchObject({ found: true, version: '0.145.0' });
});

it('reports an engine that answered with nothing as found with an unknown version', async () => {
  const { run } = runner({ codex: { code: 0, stdout: '' } });

  expect((await detectEngines(run)).find((engine) => engine.engine === 'codex')).toMatchObject({ found: true, version: null });
});

// The credential rule: a login state is read only from what the unmodified CLI says. So the only thing
// ever run is each binary with its version flag, and no path under the home folder is read.
it('runs each binary with its version flag and nothing else', async () => {
  const { run, calls } = runner({});

  await detectEngines(run);

  expect(calls).toEqual([
    ['claude', '--version'],
    ['cursor-agent', '--version'],
    ['codex', '--version'],
  ]);
});

// No command tells whether an engine is logged in without touching a credential, so the login shows
// through the runs: the first line of a run says whether it used an API key.
it('marks a run that used an API key', () => {
  const session = (apiKeyMode: boolean): RunEvent => ({ type: 'session', sessionId: 'a', model: 'haiku', apiKeyMode });

  expect(usedApiKey([session(true), { type: 'text', text: 'hi' }])).toBe(true);
  expect(usedApiKey([session(false)])).toBe(false);
  expect(usedApiKey([])).toBeNull();
});

// A check that ran and failed keeps what the binary said, so the screen can show it word for word.
it('keeps the raw error of a check that failed', async () => {
  const { run } = runner({ claude: { code: 1, stdout: '', stderr: 'Error: cannot find module ./cli.js\n' } });

  const [claude] = await detectEngines(run);

  expect(claude).toMatchObject({ found: true, version: null, error: 'Error: cannot find module ./cli.js' });
});

it('has no error for a check that answered, or for a binary that is not there', async () => {
  const { run } = runner({ claude: { code: 0, stdout: '2.1.278 (Claude Code)\n', stderr: 'a warning\n' } });

  const found = await detectEngines(run);

  expect(found[0]?.error).toBeNull();
  expect(found[1]?.error).toBeNull();
});

it('has no error for a binary that printed its version and then exited with a code', async () => {
  const { run } = runner({ claude: { code: 1, stdout: '2.1.278 (Claude Code)\n', stderr: 'update check failed\n' } });

  expect((await detectEngines(run))[0]).toMatchObject({ version: '2.1.278', error: null });
});

it('says a check that was stopped after its wait did not answer, and not that it exited with nothing', async () => {
  const { run } = runner({ claude: { code: null, stdout: '', killed: true } });

  expect((await detectEngines(run))[0]?.error).toBe('claude --version did not answer in 5 seconds.');
});

it('names the reason a binary that is there could not run', async () => {
  const { run } = runner({ claude: { code: null, stdout: '', reason: 'EACCES' } });

  expect((await detectEngines(run))[0]?.error).toBe('claude --version could not run: EACCES.');
});

// One slow engine must not hold up the other two.
it('runs the three checks at the same time', async () => {
  let running = 0;
  let most = 0;
  const run: RunCommand = async () => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, 10));
    running -= 1;
    return { code: 0, stdout: '1.0.0' };
  };

  await detectEngines(run);

  expect(most).toBe(3);
});

// The look the start page repeats while no tool is there: a file check in each PATH folder, so the
// fake claude below is found without being run (it would leave a file behind if it ran).
it('finds an engine by its binary in a PATH folder, without running it', () => {
  const bin = mkdtempSync(join(tmpdir(), 'nolzu-path-'));
  const ran = join(bin, 'ran');
  try {
    expect(enginesOnPath(bin)).toEqual([]);

    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ntouch '${ran}'\n`);
    expect(enginesOnPath(bin)).toEqual([]);
    chmodSync(join(bin, 'claude'), 0o755);
    writeFileSync(join(bin, 'codex'), '');
    chmodSync(join(bin, 'codex'), 0o755);

    expect(enginesOnPath(`${join(bin, 'missing')}${delimiter}${bin}`)).toEqual(['claude-code', 'codex']);
    expect(existsSync(ran)).toBe(false);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

// Each command is the npm line of the vendor's own install page, the page in `install`.
it('records the install command of each engine that has an npm one, and the install page of every engine', () => {
  expect(ENGINE_INSTALLS.map(({ engine, install, command }) => [engine, install, command])).toEqual([
    ['claude-code', 'https://code.claude.com/docs/en/setup', 'npm install -g @anthropic-ai/claude-code'],
    ['cursor', 'https://cursor.com/cli', null],
    ['codex', 'https://github.com/openai/codex', 'npm install -g @openai/codex'],
  ]);
});
