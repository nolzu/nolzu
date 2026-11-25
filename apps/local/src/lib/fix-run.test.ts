import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRun, writeSetting } from '@nolzu/core/node';
import type { Job } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fix, moveTo } from '../routes/api/board/writes.ts';
import { createLoop, type Loop } from './loop.ts';

// Fix it on the real loop with the fake engine: the QA switch makes a card's
// first QA fail with a reason and a screenshot, and every later QA pass. One press sends the card back
// to Implement, goes on with QA's reason, and starts QA once that run ends ready, never before.
let dir = '';
let loop: Loop;
// Every job the engine was handed, with the state of each run row at that moment.
let spawned: { job: Job; states: Map<number, string> }[] = [];
let replay: (job: Job, signal: AbortSignal) => AsyncIterable<string>;

const IMPLEMENT_SESSION = 'c5d9e2f1-7a3b-4c8d-9e0f-3b4a5c6d7e03';
const QA_REASON = 'Typing a word in the search box leaves every recipe in the list';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-fix-'));
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', NOLZU_FAKE_QA_FAIL: '1' });
  // QA asks how to run the app the first time. Answered, so a move into QA starts it.
  writeSetting(loop.db, 'qaApp', { '.': { mode: 'code' } });
  spawned = [];
  replay = loop.engine.spawn.bind(loop.engine);
  engineDoes((job, signal) => replay(job, signal));
});

afterEach(() => {
  loop.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function engineDoes(run: (job: Job, signal: AbortSignal) => AsyncIterable<string>): void {
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    const rows = loop.db.prepare('SELECT id, state FROM runs').all() as { id: number; state: string }[];
    spawned.push({ job, states: new Map(rows.map((row) => [row.id, row.state])) });
    return run(job, signal);
  };
}

const addCard = (key: string, stage: string, state = 'idle') =>
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, ?, ?)").run(key, stage, state, `${key} title`);
const card = (key: string) => loop.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: string };
const runs = (key: string) => loop.db.prepare('SELECT phase, state, verdict FROM runs WHERE card_key = ? ORDER BY id').all(key) as { phase: string; state: string; verdict: string | null }[];
const moves = (key: string) => loop.db.prepare('SELECT from_stage, to_stage, who, started_phase FROM card_events WHERE card_key = ? ORDER BY id').all(key);
const WAIT = { timeout: 10_000 };

// The queue empty after a turn of the event loop, so a chain that was going to start has started.
async function settled(): Promise<void> {
  await vi.waitFor(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queue = loop.scheduler.queue();
    expect(queue.running.length + queue.waiting.length).toBe(0);
  }, WAIT);
}

// A card whose first QA failed. With `implemented`, an Implement run came first, so its session is
// there to go on in.
async function failedQa(key: string, implemented: boolean): Promise<void> {
  addCard(key, implemented ? 'plan' : 'implement', implemented ? 'ready' : 'idle');
  if (implemented) {
    expect(await moveTo(loop, key, 'implement')).toBeNull();
    await settled();
  }
  expect(await moveTo(loop, key, 'qa')).toBeNull();
  await settled();
  expect(card(key)).toEqual({ stage: 'qa', state: 'ready' });
  expect(runs(key).at(-1)).toEqual({ phase: 'qa', state: 'complete', verdict: 'FAIL' });
}

it('goes on in the implement session with the reason, then starts QA once Implement ended, not before', async () => {
  await failedQa('APP-1', true);
  spawned = [];

  expect(await loop.fix('APP-1')).toBe(true);
  await vi.waitFor(() => expect(card('APP-1')).toEqual({ stage: 'review', state: 'ready' }), WAIT);

  const [implement, qa] = spawned;
  expect(spawned.map(({ job }) => job.phase)).toEqual(['implement', 'qa']);
  // The session the first Implement run made, and the message is the whole prompt.
  expect(implement?.job.resumeFrom).toBe(IMPLEMENT_SESSION);
  expect(implement?.job.prompt).toContain(`QA said: ${QA_REASON}`);
  expect(implement?.job.prompt).toContain('Reason: every recipe stayed in the list');
  expect(implement?.job.prompt).toContain('Expected: only recipes with that word in the title show');
  expect(implement?.job.prompt).toContain('`qa/evidence/2-search-box.png`');
  // QA was handed to the engine only after the Implement row had ended.
  expect(qa?.states.get(implement!.job.runId)).toBe('complete');
  expect(runs('APP-1').map((run) => [run.phase, run.state, run.verdict])).toEqual([
    ['implement', 'complete', null],
    ['qa', 'complete', 'FAIL'],
    ['implement', 'complete', null],
    ['qa', 'complete', 'PASS'],
  ]);
  // Back by the press, on to QA by Nolzu, and on to Review by the PASS.
  expect(moves('APP-1').slice(2)).toEqual([
    { from_stage: 'qa', to_stage: 'implement', who: 'you', started_phase: null },
    { from_stage: 'implement', to_stage: 'qa', who: 'auto', started_phase: 'qa' },
    { from_stage: 'qa', to_stage: 'review', who: 'auto', started_phase: null },
  ]);
});

it('starts a fresh Implement run with the reason when the card has no implement session', async () => {
  await failedQa('APP-2', false);
  // A QA run from before the evidence folder left its screenshot in qa/.
  const qa = join(spawned.at(-1)?.job.taskDir ?? '', 'qa');
  renameSync(join(qa, 'evidence', '2-search-box.png'), join(qa, '2-search-box.png'));
  spawned = [];

  expect(await loop.fix('APP-2')).toBe(true);
  await vi.waitFor(() => expect(card('APP-2')).toEqual({ stage: 'review', state: 'ready' }), WAIT);

  const implement = spawned[0]?.job;
  expect(implement?.phase).toBe('implement');
  expect(implement?.resumeFrom).toBeNull();
  // The card's own prompt, with QA's message after it.
  expect(implement?.prompt.split('\n')[0]).toContain('/implement/instructions.md`');
  expect(implement?.prompt).toContain(`QA said: ${QA_REASON}`);
  expect(implement?.prompt).toContain('`qa/2-search-box.png`');
  expect(spawned.map(({ job }) => job.phase)).toEqual(['implement', 'qa']);
});

it('starts no QA when the Implement run fails', async () => {
  await failedQa('APP-1', true);
  engineDoes(() => {
    throw new Error('The claude engine was not found at claude.');
  });

  expect(await loop.fix('APP-1')).toBe(true);
  await vi.waitFor(() => expect(card('APP-1')).toEqual({ stage: 'implement', state: 'failed' }), WAIT);
  await settled();

  expect(runs('APP-1').map((run) => run.phase)).toEqual(['implement', 'qa', 'implement']);
  expect(card('APP-1').stage).toBe('implement');
});

it('starts no QA when the Implement run is stopped', async () => {
  await failedQa('APP-1', true);
  // An Implement run that goes on until it is stopped.
  engineDoes((job, signal) =>
    (async function* () {
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve));
      yield* [];
    })(),
  );

  expect(await loop.fix('APP-1')).toBe(true);
  const runId = (loop.db.prepare("SELECT max(id) AS id FROM runs WHERE card_key = 'APP-1'").get() as { id: number }).id;
  await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('running'), WAIT);
  loop.stop(runId);
  await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('stopped'), WAIT);
  await settled();

  expect(runs('APP-1').map((run) => run.phase)).toEqual(['implement', 'qa', 'implement']);
  expect(card('APP-1')).toEqual({ stage: 'implement', state: 'idle' });
});

it('starts no QA when the Implement run asks a question', async () => {
  await failedQa('APP-1', true);
  engineDoes((job, signal) => replay({ ...job, phase: 'needs-input' }, signal));

  expect(await loop.fix('APP-1')).toBe(true);
  await vi.waitFor(() => expect(card('APP-1')).toEqual({ stage: 'implement', state: 'blocked' }), WAIT);
  await settled();

  expect(runs('APP-1').map((run) => run.phase)).toEqual(['implement', 'qa', 'implement']);
});

// The chain belongs to the run the press started. An Implement run started later by hand, such as
// a Retry after a failed fix, ends ready on Implement and waits there.
it('chains no later Implement run of the card to QA', async () => {
  await failedQa('APP-1', true);
  engineDoes(() => {
    throw new Error('The claude engine was not found at claude.');
  });
  expect(await loop.fix('APP-1')).toBe(true);
  await vi.waitFor(() => expect(card('APP-1').state).toBe('failed'), WAIT);
  engineDoes((job, signal) => replay(job, signal));

  expect(loop.retry('APP-1')).toBe(true);
  await vi.waitFor(() => expect(card('APP-1')).toEqual({ stage: 'implement', state: 'ready' }), WAIT);
  await settled();

  expect(runs('APP-1').map((run) => run.phase)).toEqual(['implement', 'qa', 'implement', 'implement']);
});

it('refuses a card whose QA did not fail, and writes nothing', async () => {
  addCard('APP-1', 'plan', 'ready');

  await expect(loop.fix('APP-1')).rejects.toThrow('APP-1 has no failed QA run to fix. Fix it follows a QA FAIL.');
  expect(card('APP-1')).toEqual({ stage: 'plan', state: 'ready' });
  expect(runs('APP-1')).toEqual([]);
  expect(moves('APP-1')).toEqual([]);
});

// The route the button and R post to: the loop's sentence on a refusal, and nothing more once the run
// is queued, because the stream moves the card.
it('answers the fix route with the refusal, or with ok once Implement is queued', async () => {
  addCard('APP-9', 'plan', 'ready');
  const refused = await fix(loop, 'APP-9');
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ message: 'APP-9 has no failed QA run to fix. Fix it follows a QA FAIL.' });

  await failedQa('APP-1', false);
  expect((await fix(loop, 'APP-1')).status).toBe(200);
  await vi.waitFor(() => expect(card('APP-1')).toEqual({ stage: 'review', state: 'ready' }), WAIT);
  // The other card stays where it was.
  expect(card('APP-9')).toEqual({ stage: 'plan', state: 'ready' });
});

it('goes on in its own card session only, never another card\'s', async () => {
  // APP-1 has an implement session. APP-2 has none, so its fix is a fresh run.
  await failedQa('APP-1', true);
  await failedQa('APP-2', false);
  spawned = [];

  expect(await loop.fix('APP-2')).toBe(true);
  await vi.waitFor(() => expect(card('APP-2')).toEqual({ stage: 'review', state: 'ready' }), WAIT);

  expect(spawned[0]?.job.phase).toBe('implement');
  expect(spawned[0]?.job.cardKey).toBe('APP-2');
  expect(spawned[0]?.job.resumeFrom).toBeNull();
  // APP-1 stayed where QA left it.
  expect(card('APP-1')).toEqual({ stage: 'qa', state: 'ready' });
});

it('refuses a card in QA whose newest QA run did not fail', async () => {
  await failedQa('APP-1', true);
  loop.db.prepare("UPDATE runs SET verdict = 'BLOCKED' WHERE card_key = 'APP-1' AND phase = 'qa'").run();

  await expect(loop.fix('APP-1')).rejects.toThrow('has no failed QA run to fix');
  expect(card('APP-1')).toEqual({ stage: 'qa', state: 'ready' });
  expect(runs('APP-1').map((run) => run.phase)).toEqual(['implement', 'qa']);
});

it("reads the report in the card's own folder", async () => {
  await failedQa('APP-1', true);
  await failedQa('APP-2', true);
  const report = (key: string, step: string) =>
    writeFileSync(join(dir, '.tasks', key, 'qa', 'report.md'), `## 2. What QA checked\n\n1. fail: ${step}\n   Reason: broken\n`);
  report('APP-1', 'Open the first page');
  report('APP-2', 'Open the second page');
  spawned = [];

  expect(await loop.fix('APP-2')).toBe(true);
  await vi.waitFor(() => expect(card('APP-2')).toEqual({ stage: 'review', state: 'ready' }), WAIT);

  expect(spawned[0]?.job.prompt).toContain('Open the second page');
  expect(spawned[0]?.job.prompt).not.toContain('Open the first page');
});
