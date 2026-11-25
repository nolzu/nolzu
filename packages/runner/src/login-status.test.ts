import { describe, expect, it } from 'vitest';
import type { RunCommand } from './detect.ts';
import { checkLogin, readLoginStatus, signInCommand, statusCommand } from './login-status.ts';

type Answer = Awaited<ReturnType<RunCommand>>;

// What each tool answered on 2026-10-15, with the account and team taken out. The signed out
// answers came from an empty config folder (an empty home for Cursor), so no login was touched.
// Cursor exits 0 when signed out, which is why its words decide and not its exit code.
const RECORDED: Record<'claude-code' | 'codex' | 'cursor', { in: Answer; out: Answer }> = {
  'claude-code': {
    in: { code: 0, stdout: 'Login method: Claude Pro account\n', stderr: '' },
    out: { code: 1, stdout: 'Not logged in. Run claude auth login to authenticate.\n', stderr: '' },
  },
  codex: {
    in: { code: 0, stdout: '', stderr: 'Logged in using ChatGPT\n' },
    out: { code: 1, stdout: '', stderr: 'Not logged in\n' },
  },
  cursor: {
    in: { code: 0, stdout: '\u2713 Logged in as you@example.com\n', stderr: '' },
    out: { code: 0, stdout: 'Not logged in\n', stderr: '' },
  },
};
const NOT_INSTALLED: Answer = { code: null, stdout: '', stderr: '', missing: true, reason: 'ENOENT' };

describe('readLoginStatus', () => {
  it.each(Object.entries(RECORDED))('reads a signed in %s, with its own words', (engine, answers) => {
    const read = readLoginStatus(engine as keyof typeof RECORDED, answers.in);

    expect(read.state).toBe('in');
    expect(read.said).toBe((answers.in.stdout + (answers.in.stderr ?? '')).trim());
  });

  it.each(Object.entries(RECORDED))('reads a signed out %s', (engine, answers) => {
    expect(readLoginStatus(engine as keyof typeof RECORDED, answers.out).state).toBe('out');
  });

  it.each(Object.keys(RECORDED))('says a %s that is not on this machine is not installed', (engine) => {
    expect(readLoginStatus(engine as keyof typeof RECORDED, NOT_INSTALLED)).toEqual({ state: 'missing', said: null });
  });

  // Codex exits 1 on an error as well as on a missing login, so only its own line means signed out.
  it('says a Codex error is a failed check, not a signed out folder', () => {
    const read = readLoginStatus('codex', { code: 1, stdout: '', stderr: 'Error checking login status: permission denied\n' });

    expect(read).toEqual({ state: 'failed', said: 'Error checking login status: permission denied' });
  });

  // The error the Cursor page names, in case a version answers with it.
  it('reads "Not authenticated" from Cursor as signed out', () => {
    expect(readLoginStatus('cursor', { code: 1, stdout: '', stderr: 'Not authenticated\n' }).state).toBe('out');
  });

  it('says a Cursor answer it cannot read is a failed check, and shows the words', () => {
    expect(readLoginStatus('cursor', { code: 0, stdout: 'Endpoint: default\n', stderr: '' })).toEqual({ state: 'failed', said: 'Endpoint: default' });
  });

  it('says a Claude Code exit other than 0 or 1 is a failed check', () => {
    expect(readLoginStatus('claude-code', { code: 2, stdout: '', stderr: 'error: unknown command auth\n' }).state).toBe('failed');
  });

  it('names the command and the wait when a tool does not answer', () => {
    const read = readLoginStatus('codex', { code: null, stdout: '', stderr: '', killed: true });

    expect(read.state).toBe('failed');
    expect(read.said).toBe('codex login status did not answer in 15 seconds.');
  });

  it('names the system reason when a tool could not start', () => {
    expect(readLoginStatus('claude-code', { code: null, stdout: '', stderr: '', reason: 'EACCES' }).said).toBe('claude auth status --text could not run: EACCES.');
  });
});

describe('checkLogin', () => {
  it.each(Object.keys(RECORDED))('runs the status command of %s and nothing else', async (engine) => {
    const asked: string[] = [];
    const run: RunCommand = async (binary, args) => {
      asked.push([binary, ...args].join(' '));
      return RECORDED[engine as keyof typeof RECORDED].in;
    };

    expect((await checkLogin(engine as keyof typeof RECORDED, run)).state).toBe('in');
    expect(asked).toEqual([statusCommand(engine as keyof typeof RECORDED)]);
  });
});

it('names the status and sign-in command of each tool', () => {
  expect(statusCommand('claude-code')).toBe('claude auth status --text');
  expect(statusCommand('codex')).toBe('codex login status');
  expect(statusCommand('cursor')).toBe('cursor-agent status');
  expect(signInCommand('claude-code')).toBe('claude auth login');
  expect(signInCommand('codex')).toBe('codex login');
  expect(signInCommand('cursor')).toBe('cursor-agent login');
});
