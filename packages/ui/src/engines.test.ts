import { describe, expect, it } from 'vitest';
import { canContinue, engineRows, missingEngine, type Detected } from './engines.ts';

const detected = (engine: string, over: Partial<Detected> = {}): Detected => ({
  engine,
  binary: engine === 'claude-code' ? 'claude' : engine,
  found: true,
  version: '1.0.0',
  install: `https://example.invalid/${engine}`,
  error: null,
  ...over,
});
const ALL = ['claude-code', 'cursor', 'codex'];

describe('engineRows', () => {
  it('keeps the three engines in one order, whatever order they arrive in', () => {
    const rows = engineRows([...ALL].reverse().map((engine) => detected(engine)));

    expect(rows.map((row) => row.engine)).toEqual(ALL);
  });

  it('gives every row a word, so the state is never a colour alone', () => {
    const rows = engineRows([detected('claude-code'), detected('cursor', { found: false, version: null }), detected('codex', { version: null, error: 'boom' })]);

    expect(rows.map((row) => row.word)).toEqual(['found', 'not found', 'check failed']);
    expect(rows.every((row) => row.tone !== undefined)).toBe(true);
  });

  it('offers the install page for an engine that is not found, and no login line', () => {
    const [row] = engineRows([detected('claude-code', { found: false, version: null })]);

    expect(row).toMatchObject({ install: 'https://example.invalid/claude-code', note: null });
  });

  it('keeps the raw error of a check that failed', () => {
    expect(engineRows([detected('claude-code', { version: null, error: 'Error: cannot find module' })])[0]?.error).toBe('Error: cannot find module');
  });

  it('says the login is seen on the first run, for a found engine', () => {
    expect(engineRows([detected('claude-code')])[0]?.note).toMatch(/first run/);
  });

  // The line says what is true today. A roadmap promise on a screen is read as a date.
  it('says of no engine that it cannot run', () => {
    const rows = engineRows(ALL.map((engine) => detected(engine)));

    expect(rows.every((row) => row.note === 'The login is seen on the first run.')).toBe(true);
    expect(rows.map((row) => row.note ?? '').join(' ')).not.toMatch(/later|soon|will|coming/i);
  });

  // A caller with no wall state gets the engines that run every phase with or without the wall.
  it('marks Claude Code and Codex as running every phase when no wall state is given', () => {
    const rows = engineRows(ALL.map((engine) => detected(engine)));

    expect(rows.filter((row) => row.runsHere).map((row) => row.engine)).toEqual(['claude-code', 'codex']);
  });

  it('marks every engine the server says runs every phase here', () => {
    const rows = engineRows(ALL.map((engine) => detected(engine)), { engines: ALL, wallProblem: null });

    expect(rows.every((row) => row.runsHere)).toBe(true);
  });
});

// The server's answer for this machine: which engines run every phase, and why the wall cannot start.
const WALLED = { engines: ALL, wallProblem: null };
const BWRAP = 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.';
const UNWALLED = { engines: ['claude-code', 'codex'], wallProblem: BWRAP };
const only = (engine: string) => engineRows(ALL.map((one) => (one === engine ? detected(one) : detected(one, { found: false, version: null }))));

describe('canContinue', () => {
  it('goes on when Claude Code is found', () => {
    expect(canContinue(engineRows([detected('claude-code')]), false)).toEqual({ ok: true, why: null });
  });

  it('goes on with only Cursor where the wall starts', () => {
    expect(canContinue(only('cursor'), false, WALLED)).toEqual({ ok: true, why: null });
  });

  it('holds with only Cursor where the wall cannot start, and names what to install', () => {
    const verdict = canContinue(only('cursor'), false, UNWALLED);

    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/^Cursor cannot run every phase on this machine\. Install Claude Code or Codex to go on/);
    expect(verdict.why).toContain(BWRAP);
  });

  it('goes on with Codex where the wall cannot start', () => {
    expect(canContinue(only('codex'), false, UNWALLED)).toEqual({ ok: true, why: null });
  });

  it('holds when no engine is found, and names the ones that run every phase here', () => {
    const none = engineRows(ALL.map((engine) => detected(engine, { found: false, version: null })));

    expect(canContinue(none, false, WALLED).why).toBe('Install Claude Code, Cursor or Codex to go on.');
    expect(canContinue(none, false).why).toBe('Install Claude Code or Codex to go on.');
  });

  it('holds when the one engine that would do is there but its check failed', () => {
    const verdict = canContinue(engineRows([detected('claude-code', { version: null, error: 'boom' })]), false);

    expect(verdict.ok).toBe(false);
    expect(verdict.why).toMatch(/^Claude Code is on this machine, but its check failed/);
  });

  it('goes on in fake mode, which needs no engine', () => {
    expect(canContinue(engineRows([detected('claude-code', { found: false, version: null })]), true).ok).toBe(true);
  });
});

// The no-tool block reads the names /api/tools found, not the full check.
describe('missingEngine', () => {
  it('says nothing once one engine that runs every phase here is on the PATH', () => {
    expect(missingEngine(['cursor'], WALLED)).toBeNull();
    expect(missingEngine(['codex'], UNWALLED)).toBeNull();
  });

  it('names the found engine that cannot run every phase, and the fix', () => {
    expect(missingEngine(['cursor'], UNWALLED)).toBe(`Cursor cannot run every phase on this machine. Install Claude Code or Codex to go on, or make Nolzu's wall start so any engine can: ${BWRAP}`);
  });
});
