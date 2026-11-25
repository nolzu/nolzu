import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stubBinary, type StubBinary } from '../test/stub-binary.ts';
import { codexModelList, codexModels, parseCodexModels, readCodexModels } from './codex-models.ts';

// Two models, cut out of what `codex debug models --bundled` printed on 0.145.0. The long fields
// each model carries are left out, and the shape is the binary's own.
const LIST = JSON.stringify({
  models: [
    {
      slug: 'gpt-5.6-sol',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' }],
      visibility: 'list',
    },
    { slug: 'gpt-5.4-mini', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], visibility: 'hide' },
  ],
});

let stub: StubBinary | null = null;
afterEach(() => {
  stub?.remove();
  stub = null;
});

it('reads a model and its own effort levels out of the list', () => {
  expect(parseCodexModels(LIST)).toEqual([
    { slug: 'gpt-5.6-sol', levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], hidden: false },
    { slug: 'gpt-5.4-mini', levels: ['low', 'medium'], hidden: true },
  ]);
});

it('says so when the list is not a list', () => {
  expect(() => parseCodexModels('not json')).toThrow(/not JSON/);
  expect(() => parseCodexModels('{"models":"soon"}')).toThrow(/no models/);
});

it('passes over an entry with no name', () => {
  expect(parseCodexModels('{"models":[{"supported_reasoning_levels":[{"effort":"low"}]}]}')).toEqual([]);
});

// A stub written a moment before can take more than the product's five seconds to start on a busy
// machine (measured: ETIMEDOUT under eight parallel runs), which an installed binary never does.
const STUB_WAIT = 30_000;

// A person picks from the models the vendor itself offers. A hidden one still runs when a row
// names it, which is why the levels are answered for every model and the picker gets fewer.
it('offers the listed models and keeps the levels of a hidden one', () => {
  const said = stubBinary(`process.stdout.write(${JSON.stringify(LIST)});`, 'codex-listed');
  stub = said;
  expect(codexModels(said.path, process.env, STUB_WAIT)).toEqual(['gpt-5.6-sol']);
  expect(codexModelList(said.path, process.env, STUB_WAIT).find((one) => one.slug === 'gpt-5.4-mini')?.levels).toEqual(['low', 'medium']);
});

// The wait is the caller's to set, with the product's five seconds by default: a binary slower than
// it leaves the list empty, and the same binary under a longer wait answers.
it('gives up on a list slower than its wait', () => {
  const slow = stubBinary(`setTimeout(() => process.stdout.write(${JSON.stringify(LIST)}), 300);`, 'codex-slow');
  stub = slow;
  expect(readCodexModels(slow.path, process.env, 50)).toEqual([]);
  expect(readCodexModels(slow.path, process.env, STUB_WAIT)).toHaveLength(2);
});

it('leaves the list empty when the binary is not there, rather than stopping the app', () => {
  expect(readCodexModels('/no/such/codex', process.env)).toEqual([]);
  expect(codexModels('/no/such/codex', process.env)).toEqual([]);
});

it('leaves the list empty when the binary printed something else', () => {
  const noise = stubBinary('process.stdout.write("Usage: codex [OPTIONS]");', 'codex-noise');
  stub = noise;
  expect(readCodexModels(noise.path, process.env, STUB_WAIT)).toEqual([]);
});

// The board reads the model list on every snapshot, and the binary takes about a tenth of a second
// to answer. Run per snapshot, that wait would sit on every page the person opens.
it('runs the binary once for a list it has already read', () => {
  const counted = stubBinary(
    `require('node:fs').appendFileSync(process.env.NOLZU_TEST_COUNT, 'ran\\n');\nprocess.stdout.write(${JSON.stringify(LIST)});`,
    'codex-counted',
  );
  stub = counted;
  const count = join(counted.path, '..', 'count.txt');
  const env = { ...process.env, NOLZU_TEST_COUNT: count };
  codexModelList(counted.path, env, STUB_WAIT);
  codexModelList(counted.path, env, STUB_WAIT);
  expect(readFileSync(count, 'utf8')).toBe('ran\n');
});

// Installing the engine repairs an empty list, and nobody restarts the app for it.
it('reads the list again after the engine is installed', () => {
  const later = stubBinary(`process.stdout.write(${JSON.stringify(LIST)});`, 'codex-later');
  stub = later;
  const path = join(later.path, '..', 'codex-installed');
  expect(codexModelList(path, process.env)).toEqual([]);

  copyFileSync(later.path, path);
  chmodSync(path, 0o755);

  expect(codexModelList(path, process.env, STUB_WAIT)).toHaveLength(2);
});

// The list comes from the binary and not from a table kept by hand here, so this is the one test
// that says the command still answers and still answers in the shape the adapter reads. It runs
// offline: no network and no login are touched.
//
// The gap this leaves: on a machine or a CI runner with no Codex CLI these two tests are skipped
// and the suite is green with nothing here proving the model list command. Only a machine with the
// binary installed runs them. docs/engines/codex.md says so too.
const installed = (() => {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!installed)('the installed binary', () => {
  it('prints a model list with the levels each model takes', () => {
    const models = readCodexModels('codex', process.env);
    expect(models.length).toBeGreaterThan(0);
    const sol = models.find((one) => one.slug === 'gpt-5.6-sol');
    // Six levels on one model is the fact the effort type was widened for.
    expect(sol?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    expect(models.some((one) => one.hidden)).toBe(true);
    expect(codexModels('codex', process.env)).not.toContain(models.find((one) => one.hidden)?.slug);
  });

  it('answers with no login folder', () => {
    // An empty `CODEX_HOME` is a logged out engine. The list still answers, which is why the
    // Models screen can show it before anybody has signed in.
    const home = mkdtempSync(join(tmpdir(), 'nolzu-codex-home-'));
    try {
      expect(readCodexModels('codex', { ...process.env, CODEX_HOME: home }).length).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
