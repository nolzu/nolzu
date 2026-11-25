import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, openDatabase, startRun, writeSetting } from '@nolzu/core/node';
import { DEFAULT_PROFILE } from '@nolzu/protocol';
import { parseRunLine, timeInRunLog } from '@nolzu/runner';
import { clockTime } from '@nolzu/ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { peekFor } from './peek.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-peek-'));
  db = openDatabase(dir);
  writeSetting(db, 'projectPath', dir);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'implement', title: 'Add a search box' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The recorded implement scenario the fake engine replays, so the rows are the ones a real run of
// Claude Code gives.
const IMPLEMENT = readFileSync(new URL('../../../../packages/runner/fake/implement.ndjson', import.meta.url), 'utf8');

function ran(phase: string, columns: Record<string, string | number | null>, log = ''): number {
  const logPath = join(dir, 'logs', `APP-1-${phase}.ndjson`);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  writeFileSync(logPath, log);
  const id = startRun(db, { cardKey: 'APP-1', phase, engine: DEFAULT_PROFILE.id, model: 'sonnet', effort: 'medium', sessionId: null, logPath, lane: null });
  const names = Object.keys(columns);
  if (names.length > 0) db.prepare(`UPDATE runs SET ${names.map((name) => `${name} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(columns), id);
  return id;
}

const summaryFile = (phase: string, text: string) => {
  mkdirSync(join(dir, '.tasks', 'APP-1', phase), { recursive: true });
  const path = join(dir, '.tasks', 'APP-1', phase, 'summary.md');
  writeFileSync(path, text);
  return path;
};

describe('the plain summary so far', () => {
  it('reads the running phase its own file, with the time it was written', async () => {
    ran('plan', { state: 'complete', plain_summary: 'There is a plan of two steps.' });
    ran('implement', { state: 'running', cwd: join(dir, 'worktrees', 'APP-1') });
    const path = summaryFile('implement', '## What changed, in plain words\n\nThe list filters as you type. The api is not touched.\n');
    utimesSync(path, new Date('2026-10-14T14:02:40Z'), new Date('2026-10-14T14:02:40Z'));

    const view = await peekFor(db, 'APP-1', parseRunLine);

    expect(view?.summary).toEqual({ text: 'The list filters as you type. The api is not touched.', at: '2026-10-14T14:02:40.000Z', live: true });
  });

  // The plan's summary is about the plan. Shown under a running Implement it would read as this run's.
  it('says there is none yet while the running phase has written none, and never shows the last phase', async () => {
    ran('plan', { state: 'complete', plain_summary: 'There is a plan of two steps.' });
    ran('implement', { state: 'running' });

    expect((await peekFor(db, 'APP-1', parseRunLine))?.summary).toBeNull();
  });

  // The loop removes the old file only when the run starts, so until then the file is the last run's.
  it('shows no summary for a rerun still in the queue, though the last run left its file', async () => {
    ran('implement', { state: 'failed' });
    summaryFile('implement', 'The list filters as you type.\n');

    for (const state of ['queued', 'waiting_lane']) {
      ran('implement', { state });
      expect((await peekFor(db, 'APP-1', parseRunLine))?.summary).toBeNull();
    }
  });

  // The stored summary is the last run's words. A run in the queue has written none of its own.
  it('shows no stored summary of the last run while a rerun waits in the queue', async () => {
    ran('implement', { state: 'complete', plain_summary: 'The list filters as you type.' });

    for (const state of ['queued', 'waiting_lane']) {
      ran('implement', { state });
      expect((await peekFor(db, 'APP-1', parseRunLine))?.summary).toBeNull();
    }
  });

  it('shows no summary for a running phase whose file is empty', async () => {
    ran('implement', { state: 'running' });
    summaryFile('implement', '  \n\n');

    expect((await peekFor(db, 'APP-1', parseRunLine))?.summary).toBeNull();
  });

  it('shows the newest stored summary once no phase runs', async () => {
    ran('plan', { state: 'complete', plain_summary: 'There is a plan of two steps.' });

    expect((await peekFor(db, 'APP-1', parseRunLine))?.summary).toEqual({ text: 'There is a plan of two steps.', at: null, live: false });
  });
});

describe('the log, the tokens and the trail', () => {
  it('gives the last six rows of the newest run, its row count and its tokens so far', async () => {
    ran('implement', { state: 'running', cwd: '/workspace/recipe-app/worktrees/APP-1' }, IMPLEMENT);

    const view = (await peekFor(db, 'APP-1', parseRunLine))!;

    expect(view.log?.rows).toHaveLength(6);
    expect(view.log!.total).toBeGreaterThan(6);
    expect(view.log?.rows.at(-1)).toEqual({ kind: 'complete', text: 'Done in 41s, $0.12 estimated' });
    // A tool reads as an action on its file, and carries no input.
    expect(view.log?.rows.find((row) => row.kind === 'tool')?.text).toMatch(/^Writing /);
    expect(JSON.stringify(view.log)).not.toContain('Filter the recipe list by title\\n\\n## What changed');
    // Input and output of the scenario's seven calls, as its result line reports them.
    expect(view.tokens).toBe(21 + 1204);
  });

  // The same rows as the Log tab: a result says its lines, and its size rides with it.
  it('keeps the size of a tool result in its row', async () => {
    const answer = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'one\ntwo\n' }] } });
    ran('implement', { state: 'running' }, `${answer}\n`);

    expect((await peekFor(db, 'APP-1', parseRunLine))?.log?.rows).toEqual([{ kind: 'result', text: '2 lines', aside: '8 B' }]);
  });

  // The runner notes the time in front of a line, and the sheet says it as the time of day.
  it('says the time of day each row came, where the runner noted one', async () => {
    const at = Date.parse('2026-10-14T14:02:31Z');
    const answer = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'one\ntwo\n' }] } });
    ran('implement', { state: 'running' }, `${timeInRunLog(at)}\n${answer}\n`);

    expect((await peekFor(db, 'APP-1', parseRunLine))?.log?.rows).toEqual([{ kind: 'result', text: '2 lines', aside: '8 B', time: clockTime(at) }]);
    expect(clockTime(at)).toMatch(/^\d\d:\d\d:\d\d$/);
  });

  it('has no tokens for a run whose engine reported none, and no log for a run with none', async () => {
    const refine = readFileSync(new URL('../../../../packages/runner/fake/refine.ndjson', import.meta.url), 'utf8');
    ran('refine', { state: 'complete' }, refine);
    expect((await peekFor(db, 'APP-1', parseRunLine))?.tokens).toBeNull();

    ran('plan', { state: 'queued', log_path: '' });
    expect((await peekFor(db, 'APP-1', parseRunLine))?.log).toBeNull();
  });

  it('builds the trail of the card board, with what each phase reported', async () => {
    ran('refine', { state: 'complete', cost_estimate: 0.03, duration_ms: 21_000 });
    ran('implement', { state: 'running' });

    const trail = (await peekFor(db, 'APP-1', parseRunLine))!.trail;

    expect(trail.map((segment) => segment.phase)).toEqual(['refine', 'plan', 'implement', 'qa', 'wrapup']);
    expect(trail[0]?.spend.costUsd).toBe(0.03);
    expect(trail[2]?.run?.state).toBe('running');
  });

  it('carries the wait the newest run sits in, for the countdown', async () => {
    ran('implement', { state: 'retrying', attempt: 1, retry_max: 3, retry_reason: 'API Error: 529 Overloaded', retry_until: 1_790_000_120_000 });

    expect((await peekFor(db, 'APP-1', parseRunLine))?.retry).toEqual({ attempt: 1, maxRetries: 3, reason: 'API Error: 529 Overloaded', until: 1_790_000_120_000 });
  });

  // A stop in the wait writes no later line, so the row must not go on saying it retries.
  it('stops the countdown in the log rows once the run ended in its wait', async () => {
    const wait = JSON.stringify({ type: 'nolzu.retry', retry: { attempt: 1, delayMs: 120_000, status: 529, maxRetries: 3, reason: 'API Error: 529 Overloaded', until: 1_790_000_120_000 } });
    ran('implement', { state: 'stopped' }, `${wait}\n`);

    expect((await peekFor(db, 'APP-1', parseRunLine, 1_790_000_000_000))?.log?.rows).toEqual([
      { kind: 'retry', text: 'API Error: 529 Overloaded, stopped waiting to try again, attempt 1 of 3, status 529' },
    ]);
  });

  it('answers null for a card that is not there', async () => {
    expect(await peekFor(db, 'APP-404', parseRunLine)).toBeNull();
  });
});

// Every test above drives APP-1 alone, so a key the code swapped for APP-1 would pass them. A second
// card with its own runs, summary and log tells the two apart.
describe('a second card', () => {
  const second = (phase: string, columns: Record<string, string | number | null>, log = ''): number => {
    const logPath = join(dir, 'logs', `APP-2-${phase}.ndjson`);
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(logPath, log);
    const id = startRun(db, { cardKey: 'APP-2', phase, engine: DEFAULT_PROFILE.id, model: 'sonnet', effort: 'medium', sessionId: null, logPath, lane: null });
    for (const [name, value] of Object.entries(columns)) db.prepare(`UPDATE runs SET ${name} = ? WHERE id = ?`).run(value, id);
    return id;
  };

  it('shows each card its own run, summary, log, tokens, trail and wait', async () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Sort the list' });
    // APP-1 is the older card with the newest-looking data around it: its runs come first and last.
    ran('refine', { state: 'complete', plain_summary: 'One refined.', cost_estimate: 0.01 });
    second('refine', { state: 'complete', plain_summary: 'Two refined.', cost_estimate: 0.07 });
    second('implement', { state: 'running', cwd: join(dir, 'worktrees', 'APP-2') }, IMPLEMENT);
    mkdirSync(join(dir, '.tasks', 'APP-2', 'implement'), { recursive: true });
    writeFileSync(join(dir, '.tasks', 'APP-2', 'implement', 'summary.md'), 'Two sorts the list.\n');
    ran('plan', { state: 'retrying', attempt: 1, retry_max: 3, retry_reason: 'one waits', retry_until: 1_790_000_120_000 });

    const two = (await peekFor(db, 'APP-2', parseRunLine))!;
    expect(two.key).toBe('APP-2');
    expect(two.summary?.text).toBe('Two sorts the list.');
    expect(two.tokens).toBe(21 + 1204);
    expect(two.log?.total).toBeGreaterThan(6);
    expect(two.retry).toBeNull();
    expect(two.trail[0]?.spend.costUsd).toBe(0.07);

    const one = (await peekFor(db, 'APP-1', parseRunLine))!;
    expect(one.summary).toBeNull();
    expect(one.log?.rows).toEqual([]);
    expect(one.tokens).toBeNull();
    expect(one.retry?.reason).toBe('one waits');
    expect(one.trail[0]?.spend.costUsd).toBe(0.01);
  });

  it('shows a finished card its own stored summary', async () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'plan', title: 'Sort the list' });
    second('plan', { state: 'complete', plain_summary: 'Two planned.' });
    ran('plan', { state: 'complete', plain_summary: 'One planned.' });

    expect((await peekFor(db, 'APP-2', parseRunLine))?.summary?.text).toBe('Two planned.');
  });
});

// The sheet's Next step block reads these, as the card page does: Send back with comments counts the
// comments not sent, and its line names the Implement session it goes on in.
describe('what the next step block reads', () => {
  it('counts the open diff comments and names the newest Implement session', async () => {
    const comment = db.prepare("INSERT INTO diff_comments (card_key, repo, file, line, line_text, body, commit_sha, created_at, sent_at) VALUES ('APP-1', '.', 'a.ts', 1, 'x', 'Rename it', 'abc', '2026-10-14T14:00:00Z', ?)");
    comment.run(null);
    comment.run(null);
    comment.run('2026-10-14T14:01:00Z');
    ran('implement', { state: 'complete', session_id: '0123456789abcdef' });
    ran('qa', { state: 'complete', session_id: 'fedcba9876543210' });

    const view = await peekFor(db, 'APP-1', parseRunLine);

    expect(view?.openComments).toBe(2);
    expect(view?.session).toBe('01234567');
  });

  it('says none of either on a card that never ran', async () => {
    const view = await peekFor(db, 'APP-1', parseRunLine);

    expect(view?.openComments).toBe(0);
    expect(view?.session).toBeNull();
  });
});
