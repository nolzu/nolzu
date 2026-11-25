import * as childProcess from 'node:child_process';
import type { Job, RunEvent } from '@nolzu/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { scenarioDelays } from './fake.ts';
import { selectEngine } from './select.ts';

vi.mock('node:child_process');

afterEach(() => {
  vi.useRealTimers();
});

it('returns the fake engine in fake mode and never spawns a process', async () => {
  const engine = selectEngine({ NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  const events: RunEvent[] = [];
  for await (const line of engine.spawn({ phase: 'plan' } as Job, new AbortController().signal)) {
    events.push(...engine.parse(line));
  }
  expect(engine.name).toBe('fake');
  expect(events.at(-1)?.type).toBe('complete');
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const) {
    expect(childProcess[name]).not.toHaveBeenCalled();
  }
  // Outside fake mode it is the Claude engine, and choosing it still starts nothing.
  expect(selectEngine({ NOLZU_FAKE_AGENT: '0' }, { path: () => '' }).name).toBe('claude-code');
});

it('waits the scenario delay times NOLZU_FAKE_DELAY_SCALE before each line', async () => {
  vi.useFakeTimers();
  const engine = selectEngine({ NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '2' });
  const lines = engine.spawn({ phase: 'plan' } as Job, new AbortController().signal)[Symbol.asyncIterator]();
  let arrived = false;
  const first = lines.next().then((result) => {
    arrived = true;
    return result;
  });
  const delay = (scenarioDelays.plan ?? 0) * 2;
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(arrived).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(arrived).toBe(true);
  expect((await first).value).toContain('"subtype":"init"');
});

it('runs the engine the profile\u2019s vendor names', () => {
  // The two adapters spawn two binaries, so the setting decides which one a run starts. Choosing
  // one still starts nothing: the binary is looked up when the run spawns.
  expect(selectEngine({ NOLZU_FAKE_AGENT: '0' }, { engine: 'codex', path: () => '' }).name).toBe('codex');
  expect(selectEngine({ NOLZU_FAKE_AGENT: '0' }, { engine: 'cursor', path: () => '' }).name).toBe('cursor');
  expect(selectEngine({ NOLZU_FAKE_AGENT: '0' }, { engine: 'claude-code', path: () => '' }).name).toBe('claude-code');
  // A vendor no version of this product knows stops here rather than starting a run.
  expect(() => selectEngine({ NOLZU_FAKE_AGENT: '0' }, { engine: 'gemini-cli', path: () => '' })).toThrow(/gemini-cli/);
});


it.each(['abc', '', '-1'])('rejects the delay scale %j', (value) => {
  expect(() => selectEngine({ NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: value })).toThrow('NOLZU_FAKE_DELAY_SCALE');
});

// The login shell can take seconds to answer, and a loop that fails to build is built again on the
// next request. Asked once per process, it costs that once.
it('asks the login shell for its PATH once, however often an engine is chosen', () => {
  const spawnSync = vi.mocked(childProcess.spawnSync);
  spawnSync.mockClear();

  selectEngine({ SHELL: '/bin/zsh', PATH: '/usr/bin' });
  selectEngine({ SHELL: '/bin/zsh', PATH: '/usr/bin' });

  expect(spawnSync).toHaveBeenCalledTimes(1);
});
