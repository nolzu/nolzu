import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { wallHere } from '../packages/runner/src/wall-detect.ts';
import { stubBinary } from '../packages/runner/test/stub-binary.ts';
import { tempRepo } from '../packages/runner/test/temp-repo.ts';

// The measurement script, run for real with fake engines first on PATH. It never reaches a real
// engine. The fixture sits under the ignored `.vitest` folder, not the system temp folder, because
// the macOS wall leaves the temp folders writable and the read-only check would then prove nothing.

const MARKER = 'nolzu-ssh-marker-7f3a';

// Does what the prompt asks, and the forbidden part too, so the wall is what decides. It finds
// each path in the prompt's backticks, the way a person reading the prompt would.
const FAKE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  const find = (end) => (input.match(new RegExp('\x60([^\x60]*' + end.replace('.', '\\.') + ')\x60')) || [])[1];
  const attempt = (label, fn) => {
    try {
      const value = fn();
      console.log(label + ': ' + (value === undefined ? 'ok' : value));
    } catch (error) {
      console.log(label + ' refused: ' + error.code);
    }
  };
  attempt('read', () => fs.readFileSync(find('README.md'), 'utf8').length);
  if (!process.env.FAKE_SKIP_OUT) attempt('out', () => fs.writeFileSync(find('out.md'), 'summary'));
  attempt('append', () => fs.appendFileSync(find('README.md'), 'changed'));
  attempt('env', () => fs.readFileSync(find('.env'), 'utf8'));
  attempt('ssh', () => fs.readFileSync(find('known_hosts'), 'utf8'));
  const state = path.basename(process.argv[1]) === 'codex' ? '.codex/sessions' : '.claude/projects';
  attempt('session', () => {
    fs.mkdirSync(path.join(process.env.HOME, state), { recursive: true });
    fs.writeFileSync(path.join(process.env.HOME, state, 'fake.jsonl'), '{}');
    fs.writeFileSync(path.join(process.env.HOME, state, process.argv.some((arg) => arg.startsWith('default_permissions=')) ? 'profile.json' : 'run.json'), JSON.stringify({ cwd: process.cwd(), tmp: process.env.TMPDIR, args: process.argv.slice(2) }));
  });
  if (process.argv.some((arg) => arg.startsWith('default_permissions='))) {
    if (process.env.FAKE_NO_PROFILE) {
      console.error('error: unknown configuration key default_permissions');
      process.exit(2);
    }
    if (process.env.FAKE_WARN_PROFILE) console.error('warning: default_permissions is ignored');
    console.log('profile set');
  }
  if (process.env.FAKE_LOGIN) console.log('Error: please log in first');
  if (process.env.FAKE_EXIT) process.exitCode = Number(process.env.FAKE_EXIT);
});
`;

// A browser that prints the page it was given, and writes its profile where it was told.
const FAKE_CHROMIUM = String.raw`
const fs = require('node:fs');
const dir = process.argv.find((arg) => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/Local State', '{}');
console.log('<html><body>' + decodeURIComponent(process.argv.at(-1).replace('data:text/html,', '')) + '</body></html>');
`;

const scratch = join(import.meta.dirname, '../.vitest');
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, 'measure-'));
const home = join(root, 'home');
const work = join(root, 'work');
const out = join(root, 'out');
for (const dir of [join(home, '.ssh'), join(home, '.claude'), join(home, '.codex'), work, out]) mkdirSync(dir, { recursive: true });
writeFileSync(join(home, '.ssh/known_hosts'), `example.com ssh-ed25519 ${MARKER}\n`);
const claude = stubBinary(FAKE, 'claude');
const codex = stubBinary(FAKE, 'codex');
const chromium = stubBinary(FAKE_CHROMIUM, 'chromium');
const cursor = stubBinary(FAKE, 'cursor-agent');
const repo = tempRepo();
repo.write('recipe.md', 'Pancakes\n');
repo.commit('Add a recipe');

afterAll(() => {
  claude.remove();
  codex.remove();
  chromium.remove();
  cursor.remove();
  repo.remove();
  rmSync(root, { recursive: true, force: true });
});

const measure = (args: string[], env: Record<string, string> = {}, extra: { ask?: string; yes?: boolean; workDir?: string } = {}) => {
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'measure-walls.mjs'), ...(extra.yes === false ? [] : ['--yes']), '--work-dir', extra.workDir ?? work, '--out', out, '--chromium', chromium.path, ...args],
    {
      encoding: 'utf8',
      input: extra.ask ?? '',
      env: {
        ...process.env,
        HOME: home,
        PATH: [dirname(claude.path), dirname(codex.path), dirname(cursor.path), dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
        ...env,
      },
    },
  );
  const path = /^Report: (.+\.json)$/m.exec(result.stdout)?.[1] ?? '';
  return { result, path, report: path === '' ? null : JSON.parse(readFileSync(path, 'utf8')) };
};
const { result: run, path: reportPath, report } = measure(['--engines', 'claude,codex', '--clone-repo', repo.dir]);
const engine = (name: string) => report.engines.find((one: { engine: string }) => one.engine === name);

// macOS only for now. On Linux the Claude Code wall refuses this empty home, which has no
// ~/.claude.json, and Chromium does not start in the wall. Later Linux work closes both.
const linuxGap = process.platform === 'linux';

it.skipIf(linuxGap)('writes a JSON report and a text summary, and prints where', () => {
  expect(run.status, run.stderr).toBe(0);
  expect(reportPath.startsWith(out)).toBe(true);
  expect(readFileSync(reportPath.replace(/\.json$/, '.txt'), 'utf8')).toContain('claude-code');
  expect(report).toMatchObject({
    platform: process.platform,
    wall: expect.objectContaining({ ready: expect.any(Boolean) }),
    bwrap: expect.objectContaining({ present: expect.any(Boolean) }),
    engines: expect.any(Array),
  });
  expect(report.engines.map((one: { engine: string }) => one.engine)).toEqual(['claude-code', 'codex']);
  for (const one of report.engines) {
    expect(one).toMatchObject({ ran: true, skipped: null, args: expect.any(Array) });
    for (const key of ['startedAndLoggedIn', 'outWritten', 'readmeUnchanged', 'envAbsent', 'sshAbsent']) {
      expect(one, key).toHaveProperty(key);
    }
  }
});

it('leaves nothing behind in its work folder', () => {
  expect(readdirSync(work)).toEqual([]);
});

it('measures the clone methods on the repository it was given', () => {
  const methods = report.clone.methods.map((one: { method: string }) => one.method);
  expect(methods).toContain('git worktree --detach');
  for (const one of report.clone.methods) expect(one).toMatchObject({ ok: true, ms: expect.any(Number) });
  expect(repo.run('worktree', 'list').split('\n').filter(Boolean)).toHaveLength(1);
});

it('records whether Codex took the permission profile', () => {
  expect(engine('codex').defaultPermissions).toMatchObject({ accepted: true, exitCode: 0, value: '":read-only"' });
  expect(engine('codex').defaultPermissions.args).toEqual(expect.arrayContaining(['-c', 'default_permissions=":read-only"']));
  const refused = measure(['--engines', 'codex', '--codex-permissions', 'nope'], { FAKE_NO_PROFILE: '1' });
  expect(refused.report.engines[0].defaultPermissions).toMatchObject({ value: 'nope', accepted: false });
});

it.skipIf(linuxGap)('starts the browser inside the wall, with its profile in the run folder', () => {
  expect(report.chromium).toMatchObject({ withOwnSandbox: true, withoutOwnSandbox: true });
  expect(run.stdout).toContain('Chromium in the wall');
});

it('never prints the secret it looks for', () => {
  expect(run.stdout).not.toContain(MARKER);
  expect(readFileSync(reportPath, 'utf8')).not.toContain(MARKER);
  expect(readFileSync(reportPath, 'utf8')).not.toContain('nolzu-dummy-env');
});

it.skipIf(process.platform !== 'darwin' || !wallHere().ready)('says the macOS wall refused the forbidden reads and writes', () => {
  for (const name of ['claude-code', 'codex']) {
    expect(engine(name), name).toMatchObject({
      walled: true,
      refused: null,
      startedAndLoggedIn: true,
      outWritten: true,
      readmeUnchanged: true,
      envAbsent: true,
      sshAbsent: true,
    });
  }
  expect(engine('claude-code').stateTouched).toContain('~/.claude/projects');
  expect(engine('codex').stateTouched).toContain('~/.codex/sessions');
});

it.skipIf(linuxGap)('says no when out.md was not written', () => {
  const one = measure(['--engines', 'claude'], { FAKE_SKIP_OUT: '1' }).report.engines[0];
  expect(one).toMatchObject({ outWritten: false });
});

it.skipIf(linuxGap)('does not call a failed or logged-out start a start', () => {
  expect(measure(['--engines', 'claude'], { FAKE_EXIT: '3' }).report.engines[0]).toMatchObject({ exitCode: 3, startedAndLoggedIn: false, loginProblem: false });
  expect(measure(['--engines', 'claude'], { FAKE_LOGIN: '1' }).report.engines[0]).toMatchObject({ exitCode: 0, startedAndLoggedIn: false, loginProblem: true });
});

it('says Codex did not accept the profile when it only warns about the key', () => {
  const one = measure(['--engines', 'codex'], { FAKE_WARN_PROFILE: '1' }).report.engines[0];
  expect(one.defaultPermissions).toMatchObject({ exitCode: 0, accepted: false });
});

it('asks before it runs an engine, and a closed input counts as no', () => {
  const ran = (extra: { ask?: string }) => measure(['--engines', 'claude'], {}, { yes: false, ...extra }).report.engines[0];
  expect(ran({ ask: 'n\n' })).toMatchObject({ ran: false, skipped: 'not confirmed' });
  expect(ran({})).toMatchObject({ ran: false, skipped: 'not confirmed' });
  expect(ran({ ask: 'y\n' })).toMatchObject({ ran: true });
  // The second question comes after the input has already ended.
  const both = measure(['--engines', 'claude,codex'], {}, { yes: false }).report.engines;
  expect(both.map((one: { ran: boolean }) => one.ran)).toEqual([false, false]);
});

it.skipIf(linuxGap)('keeps its own work folder out of the state it reports', () => {
  const touched = measure(['--engines', 'claude'], {}, { workDir: home }).report.engines[0].stateTouched;
  expect(touched.filter((path: string) => path.includes('.nolzu-measure-'))).toEqual([]);
  expect(readdirSync(home).filter((name) => name.startsWith('.nolzu-measure-'))).toEqual([]);
});

const walled = process.platform === 'darwin' && wallHere().ready;

it.skipIf(!walled)('starts each engine where the plan says, with its own temp folder and its own sandbox settings', () => {
  const seen = (state: string) => JSON.parse(readFileSync(join(home, state, 'run.json'), 'utf8'));
  rmSync(join(home, '.claude/projects/run.json'), { force: true });
  rmSync(join(home, '.codex/sessions/run.json'), { force: true });
  const codexReport = measure(['--engines', 'claude,codex']).report.engines[1];
  const claudeRun = seen('.claude/projects');
  expect(claudeRun.cwd).toMatch(/\/claude-code$/);
  expect(claudeRun.tmp).toMatch(/\/claude-code-tmp$/);
  const codexRun = seen('.codex/sessions');
  // A read-only Codex run starts in the card folder, with its own sandbox off inside the wall.
  expect(codexRun.cwd).toMatch(/\/\.tasks\/[^/]+$/);
  expect(codexRun.args).toContain('danger-full-access');
  expect(codexRun.args).not.toContain('workspace-write');
  expect(codexReport.args).toContain('danger-full-access');
});

it('turns the shell sandbox of Cursor off, because the wall is the sandbox', () => {
  const one = measure(['--engines', 'cursor-agent']).report.engines[0];
  expect(one.args.slice(-2)).toEqual(['--sandbox', 'disabled']);
});

it('does not run an engine when the wall refuses, and says why', () => {
  rmSync(join(home, '.claude/projects/run.json'), { force: true });
  const one = measure(['--engines', 'claude'], { CODEX_SANDBOX: 'seatbelt' }).report.engines[0];
  expect(one).toMatchObject({ ran: true, walled: false, refused: expect.stringContaining('already') });
  expect(one).not.toHaveProperty('outWritten');
  expect(() => readFileSync(join(home, '.claude/projects/run.json'))).toThrow();
});

it.skipIf(linuxGap)('does not check ~/.ssh against a sample too short to be unique', () => {
  const other = mkdtempSync(join(scratch, 'home2-'));
  mkdirSync(join(other, '.ssh'), { recursive: true });
  writeFileSync(join(other, '.ssh/known_hosts'), 'a b c\n');
  try {
    expect(measure(['--engines', 'claude'], { HOME: other }).report.engines[0]).toMatchObject({ sshAbsent: null });
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
