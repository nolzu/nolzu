import { expect, it, vi } from 'vitest';
import { type AwakeDeps, holdAwake, keepAwakeCommand } from './awake.ts';

const has = (...names: string[]) => (name: string) => names.includes(name);

it('uses caffeinate with the idle flag on macOS, tied to this process', () => {
  const command = keepAwakeCommand('darwin', has(), 4242);

  expect(command?.[0]).toBe('caffeinate');
  expect(command?.[1]).toContain('-i');
  // Tied to Nolzu, so a crash that skips the release still lets the machine sleep again.
  expect(command?.[1].join(' ')).toContain('-w 4242');
});

it('uses systemd-inhibit on Linux when it is installed', () => {
  expect(keepAwakeCommand('linux', has('systemd-inhibit'), 4242)?.[0]).toBe('systemd-inhibit');
  // Tied to Nolzu as on macOS: the held shell ends once process 4242 is gone.
  expect(keepAwakeCommand('linux', has('systemd-inhibit'), 4242)?.[1].slice(-2)).toEqual(['nolzu', '4242']);
});

it.each([
  ['linux', has()],
  ['win32', has('systemd-inhibit', 'caffeinate')],
  ['freebsd', has('caffeinate')],
])('holds nothing on %s without a tool it knows', (platform, available) => {
  expect(keepAwakeCommand(platform, available, 4242)).toBeNull();
});

function fakeDeps(platform = 'darwin', available = has()) {
  const helpers: { command: string; killed: boolean }[] = [];
  const deps: AwakeDeps = {
    platform,
    has: available,
    pid: 4242,
    spawn: vi.fn((command: string) => {
      const helper = { command, killed: false };
      helpers.push(helper);
      return { kill: () => (helper.killed = true) };
    }),
  };
  return { deps, helpers };
}

it('starts one helper and ends it on release', () => {
  const { deps, helpers } = fakeDeps();

  const release = holdAwake(deps);
  expect(helpers).toEqual([{ command: 'caffeinate', killed: false }]);
  release();

  expect(helpers[0]?.killed).toBe(true);
});

it('spawns nothing and does not throw where no tool exists', () => {
  const { deps } = fakeDeps('linux');

  const release = holdAwake(deps);

  expect(deps.spawn).not.toHaveBeenCalled();
  expect(() => release()).not.toThrow();
});

it('gives each run its own helper, so ending one leaves the other held', () => {
  const { deps, helpers } = fakeDeps();

  const first = holdAwake(deps);
  holdAwake(deps);
  first();

  expect(helpers.map((helper) => helper.killed)).toEqual([true, false]);
});

it('can be released twice, because a run releases it on every way out', () => {
  const { deps } = fakeDeps();
  const release = holdAwake(deps);

  release();

  expect(() => release()).not.toThrow();
});

// A helper that cannot start must not cost the run: the run matters more than the machine staying up.
it('lets the run go on when the helper cannot start', () => {
  const deps: AwakeDeps = { platform: 'darwin', has: has(), pid: 1, spawn: () => { throw new Error('EAGAIN'); } };

  expect(() => holdAwake(deps)()).not.toThrow();
});
