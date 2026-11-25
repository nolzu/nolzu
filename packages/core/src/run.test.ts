import type { CardState, RunEvent } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { foldRun, stateAfterRun } from './run.ts';

const session: RunEvent = { type: 'session', sessionId: 'sess-1', model: 'sonnet', apiKeyMode: false };
const complete: RunEvent = {
  type: 'complete',
  costUsd: 0.0412,
  durationMs: 18240,
  tokens: { input: 9, output: 412, cacheRead: 14820, cacheCreation: 3310 },
};
const question: RunEvent = { type: 'needs_input', question: 'Which index name should the search use?' };
const apiError: RunEvent = { type: 'failed', reason: 'API Error: 529 Overloaded', status: 529 };

it.each<[string, RunEvent[], CardState]>([
  ['complete gives ready', [session, { type: 'text', text: 'The plan is in place.' }, complete], 'ready'],
  ['needs input gives blocked, although the run completes', [session, question, complete], 'blocked'],
  ['failed gives failed', [session, { type: 'failed', reason: 'error_max_turns', status: null }], 'failed'],
  [
    'an API error result gives failed',
    [session, { type: 'api_retry', attempt: 1, delayMs: 2000, status: 529, maxRetries: 3, reason: 'overloaded' }, apiError],
    'failed',
  ],
  ['a question followed by a failure gives failed', [session, question, apiError], 'failed'],
  ['a stream that ends without a result gives failed', [session, { type: 'text', text: 'Reading the list.' }], 'failed'],
  [
    // A line the parser learned to read must never change what a card says. Without this,
    // an unknown notice could quietly mark a finished run as failed.
    'a rate limit notice leaves the state alone',
    [session, { type: 'rate_limit', windows: [{ name: 'five_hour', used: 0.62, resetsAt: 1789551000, status: 'allowed' }] }, complete],
    'ready',
  ],
])('%s', (_, events, state) => {
  expect(stateAfterRun(events)).toBe(state);
});

it('lets a refused tool decide nothing about the card', () => {
  // A hook that keeps a read-only phase inside its own folder refuses stray writes by design, so a
  // refusal is evidence and not a verdict. The phase's own result decides, as it always did.
  const complete = { type: 'complete', costUsd: 0.04, durationMs: 1200, tokens: { input: 9, output: 412, cacheRead: 0, cacheCreation: 0 } } as const;
  const denied = { type: 'permission_denied', denied: [{ tool: 'Write', id: null, path: null }] } as const;

  expect(stateAfterRun([denied, complete])).toBe('ready');
  // And a run that was refused and then produced no result is still a run that stopped early.
  expect(stateAfterRun([denied])).toBe('failed');
});

const retry: RunEvent = { type: 'api_retry', attempt: 2, delayMs: 300_000, status: 529, maxRetries: 3, reason: 'overloaded' };

it('takes the session id and the model from the session event', () => {
  const record = foldRun([session, complete]);

  expect(record.sessionId).toBe('sess-1');
  expect(record.model).toBe('sonnet');
});

it('takes the cost, the four counts and the duration from the complete event', () => {
  const record = foldRun([session, complete]);

  expect(record.costUsd).toBe(0.0412);
  expect(record.durationMs).toBe(18240);
  expect(record.tokens).toEqual({ input: 9, output: 412, cacheRead: 14820, cacheCreation: 3310 });
  expect(record.state).toBe('complete');
  expect(record.cardState).toBe('ready');
});

it('keeps the question and blocks the card, although the run completes after it', () => {
  const record = foldRun([session, question, complete]);

  expect(record.question).toBe('Which index name should the search use?');
  expect(record.cardState).toBe('blocked');
});

it('keeps the reason and the status of a failure', () => {
  const record = foldRun([session, apiError]);

  expect(record.failureReason).toBe('API Error: 529 Overloaded');
  expect(record.failureStatus).toBe(529);
  expect(record.state).toBe('failed');
  expect(record.cardState).toBe('failed');
});

it('reports a wait as retrying while the card stays running', () => {
  const record = foldRun([session, retry]);

  expect(record.state).toBe('retrying');
  expect(record.retry).toEqual({ attempt: 2, delayMs: 300_000, reason: 'overloaded' });
  // The run has not ended, so the card is not failed and not ready.
  expect(record.cardState).toBe('running');
});

it('clears the wait once the run ends', () => {
  const record = foldRun([session, retry, complete]);

  expect(record.state).toBe('complete');
  expect(record.retry).toBeNull();
});

it('leaves a stream with no result failed on both counts', () => {
  const record = foldRun([session, { type: 'text', text: 'Reading the list.' }]);

  expect(record.state).toBe('failed');
  expect(record.cardState).toBe('failed');
});

// An API error that outlasts the retries is reported on a line that also carries what the work cost.
// The run is a failure, and the money is real: dropping it would take it out of every roll-up.
it('keeps what a failed run spent', () => {
  const record = foldRun([session, { type: 'failed', reason: 'API Error: 529 Overloaded', status: 529, costUsd: 0.83, durationMs: 143_500, tokens: { input: 40, output: 2100, cacheRead: 220_000, cacheCreation: 9000 } }], false);

  expect(record.state).toBe('failed');
  expect(record.costUsd).toBe(0.83);
  expect(record.durationMs).toBe(143_500);
  expect(record.tokens?.output).toBe(2100);
});

// An engine that reports a failure and nothing else leaves all three null, which is not nought.
it('reports nothing for a failed run that carried no numbers', () => {
  const record = foldRun([session, { type: 'failed', reason: 'error_max_turns', status: null }], false);

  expect(record.costUsd).toBeNull();
  expect(record.tokens).toBeNull();
});

// A result that names no counts leaves the run's own steps as what it spent. A call Claude Code names on two lines counts once.
it('adds up the run\'s own calls when its end names no counts', () => {
  const step = (input: number, id: string | null = null): RunEvent => ({ type: 'usage', id, tokens: { input, output: 10, cacheRead: 100, cacheCreation: 1 } });
  const done = { type: 'complete', costUsd: null, durationMs: null, tokens: null } as const;

  expect(foldRun([session, step(400), step(600), done]).tokens).toEqual({ input: 1000, output: 20, cacheRead: 200, cacheCreation: 2 });
  expect(foldRun([session, step(400, 'msg-1'), step(500, 'msg-1'), step(600, 'msg-2'), done]).tokens).toEqual({ input: 1100, output: 20, cacheRead: 200, cacheCreation: 2 });
  // A failed run keeps what its calls spent, as a failure with its own counts does.
  expect(foldRun([session, step(400), { type: 'failed', reason: 'Individual quota reached.', status: 429 }]).tokens?.input).toBe(400);
  // Counts the end names win, and a run with no call reported has none.
  expect(foldRun([session, step(400), complete]).tokens?.input).toBe(9);
  expect(foldRun([session, done]).tokens).toBeNull();
});

// A run a person stopped returns the card to idle in its current stage, because
// failed would blame the machine for a human action.
// What the run left on disk must be looked at before the card runs again, so a check's stop wins.
it('keeps a run a check stopped failed, even when a person stopped it too', () => {
  const record = foldRun([session, { type: 'failed', reason: 'The run created or replaced ~/.cursor/hooks.json.', status: null, halted: true }], true);

  expect(record.state).toBe('failed');
  expect(record.cardState).toBe('failed');
  expect(record.failureReason).toContain('hooks.json');
});

it('reports a stopped run as stopped, with the card idle and no cost', () => {
  const record = foldRun([session, { type: 'text', text: 'Half way.' }], true);

  expect(record.state).toBe('stopped');
  expect(record.cardState).toBe('idle');
  expect(record.costUsd).toBeNull();
  expect(record.tokens).toBeNull();
});

// A wait Nolzu holds carries the time the next try starts, and the record keeps it for the countdown.
// The engine's own retries carry none, and their record stays as it was.
it('keeps when the next try starts and how many tries there are, for a wait Nolzu holds', () => {
  const held: RunEvent = { ...retry, until: 1_790_000_300_000 } as RunEvent;
  const record = foldRun([session, held]);

  expect(record.retry).toEqual({ attempt: 2, delayMs: 300_000, reason: 'overloaded', until: 1_790_000_300_000, maxRetries: 3 });
  expect(foldRun([session, held, complete]).retry).toBeNull();
});
