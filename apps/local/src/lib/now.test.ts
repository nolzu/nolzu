import { type BoardSnapshot, type CardView, DEFAULT_PROFILE, type ProfileLimit } from '@nolzu/protocol';
import { waitingOnMe } from '@nolzu/ui';
import { boardFixture, cardFixture, stageFixture } from '@nolzu/ui/fixture';
import { describe, expect, it } from 'vitest';
import { backStep, doneLine, isNow, knowledgeRun, longSummary, nearLines, type NowSnapshot, rowPill, rowSays, type RunRow, slotPips, slotsLine, stackAsk, startStep, todayStats, usageRows, waitingCount, waitingItems, whenLine } from './now.ts';

// The pure half of Now. What the page draws is in NowPage.mount.test.ts and routes/page.test.ts.
const NOW = new Date('2026-10-12T12:00:00.000Z');

const board = (cards: CardView[], over: Partial<BoardSnapshot> = {}): BoardSnapshot => ({ ...boardFixture('pull-request', cards), ...over });

const snapshot = (over: Partial<NowSnapshot> = {}): NowSnapshot => ({
  version: 3,
  boards: [board([])],
  waiting: {},
  running: [],
  done: [],
  today: { runs: 0, reported: 0, costUsd: null, durationMs: 0, moved: 0 },
  profiles: [],
  scout: { sources: 0, fresh: 0, newest: null },
  ...over,
});

const extra = (since: string | null, summary: string | null = null) => ({ since, summary, resumable: true });

const row = (over: Partial<RunRow> = {}): RunRow => ({
  runId: 7,
  key: 'APP-3',
  title: 'Add tags to recipes',
  kind: 'card',
  phase: 'Implement',
  state: 'running',
  runState: 'running',
  position: null,
  startedAt: '2026-10-12T11:57:46.000Z',
  model: 'sonnet',
  effort: 'high',
  lane: null,
  ...over,
});

// The Knowledge screen and the rail follow the knowledge run off the Now stream, by the key that
// holds the knowledge lane.
describe('the knowledge run', () => {
  const lanes = (heldBy: string | null) => [{ name: 'knowledge', heldBy, waiting: 0 }];
  const held = (heldBy: string | null, rows: RunRow[]) => snapshot({ boards: [board([], { lanes: lanes(heldBy) as never })], running: rows });
  const act = { runId: 7, cardKey: 'kb-maintenance', line: 'Reading README.md', outputAt: 0 };

  it('names a maintenance run by its phase and a learn run with its repository, with its start and its last action', () => {
    expect(knowledgeRun(held('kb-maintenance', [row({ key: 'kb-maintenance', kind: 'maintenance', title: null, phase: 'Learn this project' })]), { 'kb-maintenance': act })).toEqual({
      name: 'Learn this project',
      since: '2026-10-12T11:57:46.000Z',
      line: 'Reading README.md',
    });
    expect(knowledgeRun(held('kb-learn-api', [row({ key: 'kb-learn-api', kind: 'maintenance', title: null, phase: 'Learn your repositories' })]), {})?.name).toBe('Learn your repositories, api');
    // A card's wrap-up is named by its key, as the lock line always named it.
    expect(knowledgeRun(held('APP-3', [row({ phase: 'Wrap-up' })]), {})?.name).toBe('APP-3');
  });

  it('is nothing while no run holds the lane, and leaves out an action of an earlier run', () => {
    expect(knowledgeRun(held(null, [row()]), {})).toBeNull();
    expect(knowledgeRun(null, {})).toBeNull();
    expect(knowledgeRun(held('kb-maintenance', [row({ key: 'kb-maintenance', kind: 'maintenance', phase: 'Optimize' })]), { 'kb-maintenance': { ...act, runId: 3 } })?.line).toBeNull();
  });
});

describe('Waiting on you', () => {
  // Every card a person has to act on, on every board that is on, and nothing else.
  it('lists the cards that wait on the person across the boards, and counts them as waitingOnMe does', () => {
    const delivery = [
      cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars or thumbs?' }),
      cardFixture({ key: 'APP-2', stage: 'plan', state: 'ready' }),
      cardFixture({ key: 'APP-3', stage: 'implement', state: 'running' }),
      cardFixture({ key: 'APP-4', stage: 'qa', state: 'ready', verdict: 'FAIL', verdictReason: 'The list stays empty.' }),
      cardFixture({ key: 'APP-5', stage: 'refine', state: 'failed', failureReason: 'The engine stopped.' }),
      cardFixture({ key: 'APP-6', stage: 'inbox', state: 'idle' }),
      cardFixture({ key: 'APP-7', stage: 'plan', state: 'queued' }),
    ];
    const epics = [cardFixture({ key: 'APP-8', stage: 'plan', state: 'ready' })];
    const now = snapshot({ boards: [board(delivery), board(epics, { kind: 'epics' })] });

    const items = waitingItems(now);
    expect(items.map((item) => [item.card.key, item.kind, item.board.kind])).toEqual(
      expect.arrayContaining([
        ['APP-1', 'asks', 'delivery'],
        ['APP-2', 'ready', 'delivery'],
        ['APP-4', 'qa-failed', 'delivery'],
        ['APP-5', 'failed', 'delivery'],
        ['APP-8', 'ready', 'epics'],
      ]),
    );
    expect(items).toHaveLength(5);
    expect(waitingCount(now)).toBe([...delivery, ...epics].filter(waitingOnMe).length);
  });

  it('has no count before the first snapshot', () => {
    expect(waitingCount(null)).toBeNull();
    expect(waitingCount(snapshot())).toBe(0);
  });

  // Oldest first. A card that never ran and never moved has no time, so it goes last.
  it('puts the card that has waited longest first, and a card with no time last', () => {
    const cards = ['APP-1', 'APP-2', 'APP-3', 'APP-4'].map((key) => cardFixture({ key, stage: 'plan', state: 'ready' }));
    const now = snapshot({
      boards: [board(cards)],
      waiting: { 'APP-1': extra('2026-10-12T11:50:00.000Z'), 'APP-2': extra(null), 'APP-3': extra('2026-10-12T09:00:00.000Z'), 'APP-4': extra('2026-10-12T11:00:00.000Z') },
    });

    expect(waitingItems(now).map((item) => item.card.key)).toEqual(['APP-3', 'APP-4', 'APP-1', 'APP-2']);
  });

  it('says how long each kind has waited, in its words', () => {
    const at = (card: CardView, since: string | null) => waitingItems(snapshot({ boards: [board([card])], waiting: { [card.key]: extra(since) } }))[0]!;
    const asks = cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars?' });
    const ready = cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' });
    const failedQa = cardFixture({ key: 'APP-1', stage: 'qa', state: 'ready', verdict: 'FAIL' });

    expect(whenLine(at(asks, '2026-10-12T11:48:00.000Z'), NOW)).toBe('Plan · waiting 12m');
    expect(whenLine(at(ready, '2026-10-12T11:57:00.000Z'), NOW)).toBe('Plan done 3m ago');
    expect(whenLine(at(failedQa, '2026-10-12T11:38:00.000Z'), NOW)).toBe('QA · 22m ago');
    // No time, or no clock yet: the stage alone, never a made-up age.
    expect(whenLine(at(ready, '2026-10-12T11:59:30.000Z'), NOW)).toBe('Plan done under a minute ago');
    // A run that passed QA moved the card on to Review by itself, and nothing was done on Review.
    expect(whenLine(at(cardFixture({ key: 'APP-1', stage: 'review', state: 'ready', verdict: 'PASS' }), '2026-10-12T11:57:00.000Z'), NOW)).toBe('Review · waiting 3m');
    expect(whenLine(at(asks, null), NOW)).toBe('Plan');
    expect(whenLine(at(ready, '2026-10-12T11:57:00.000Z'), undefined)).toBe('Plan');
  });
});

describe('the start a waiting card offers', () => {
  const item = (card: CardView, cards: CardView[] = [card]) => waitingItems(snapshot({ boards: [board(cards)] })).find((one) => one.card.key === card.key)!;

  // The same lines the drop box and the R confirm show: engine, model and effort, and the estimate
  // only where one was measured.
  it('approves a ready card into the next column with what it starts', () => {
    expect(startStep(item(cardFixture({ key: 'APP-2', stage: 'plan', state: 'ready' })))).toEqual({
      kind: 'go',
      label: 'Approve and start Implement',
      line: 'Claude Code · sonnet · medium',
      to: 'implement',
    });
  });

  // A wrap-up waiting for a knowledge review is answered on Knowledge, so Now offers no start and no move back.
  it('lists a card waiting for a knowledge review, with no start and no send back', () => {
    const waiting = item(cardFixture({ key: 'APP-3', stage: 'wrapup', state: 'queued', runState: 'waiting_review', lane: 'knowledge' }));

    expect(waiting.kind).toBe('review');
    expect(startStep(waiting)).toBeNull();
    expect(backStep(waiting)).toBeNull();
  });

  it('adds the estimate when one was measured, and none otherwise', () => {
    const measured = board([cardFixture({ key: 'APP-2', stage: 'plan', state: 'ready' })]);
    const stages = measured.stages.map((stage) =>
      stage.id === 'implement' ? { ...stage, starts: { ...stage.starts!, estimate: { costUsd: 0.4, lowMs: 360_000, highMs: 600_000, runs: 8, from: 'history' as const } } } : stage,
    );
    const [found] = waitingItems(snapshot({ boards: [{ ...measured, stages }] }));

    expect(startStep(found!)).toMatchObject({ kind: 'go', line: 'Claude Code · sonnet · medium · about $0.40 · 6 to 10 min' });
  });

  it('uses the card’s own model over the column’s', () => {
    const own = cardFixture({ key: 'APP-2', stage: 'plan', state: 'ready', starts: { implement: { phase: 'implement', model: 'opus', effort: 'high', engine: 'claude-code', modelState: 'ok', refusal: null } } });

    expect(startStep(item(own))).toMatchObject({ line: 'Claude Code · opus · high' });
  });

  it('refuses a start the column would refuse, with its reason', () => {
    const gone = cardFixture({ key: 'APP-2', stage: 'plan', state: 'ready', starts: { implement: { phase: 'implement', model: 'sonnet-4-5', effort: 'high', engine: 'claude-code', modelState: 'gone', refusal: null } } });

    expect(startStep(item(gone))).toEqual({ kind: 'refused', reason: 'sonnet-4-5 is gone. Pick another model in the card settings, or in Settings, Models.' });
  });

  // A column that starts nothing moves the card with a plain button: amber is for a run.
  it('moves a ready card into a column that starts nothing without the go button', () => {
    expect(startStep(item(cardFixture({ key: 'APP-2', stage: 'qa', state: 'ready', verdict: 'PASS' })))).toEqual({ kind: 'move', label: 'Move to Review', to: 'review' });
  });

  it('retries a failed run in its own column', () => {
    expect(startStep(item(cardFixture({ key: 'APP-5', stage: 'refine', state: 'failed' })))).toEqual({ kind: 'retry', label: 'Retry Refine', line: 'Claude Code · haiku · low' });
  });

  // Fix it on a QA failure names both runs. The line is the Implement row the first
  // run starts on, and the sum of both estimates only where both were measured.
  it('offers Fix it on a QA failure, with both runs named, and no start on a question', () => {
    expect(startStep(item(cardFixture({ key: 'APP-4', stage: 'qa', state: 'ready', verdict: 'FAIL' })))).toEqual({
      kind: 'fix',
      label: 'Fix it: run Implement again with this reason, then QA',
      line: 'Claude Code · sonnet · medium',
    });
    expect(startStep(item(cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars?' })))).toBeNull();
  });

  it('adds the sum of both estimates to Fix it only when both runs were measured', () => {
    const failed = board([cardFixture({ key: 'APP-4', stage: 'qa', state: 'ready', verdict: 'FAIL' })]);
    const measure = (ids: string[]) =>
      failed.stages.map((stage) => (ids.includes(stage.id) ? { ...stage, starts: { ...stage.starts!, estimate: { costUsd: 0.2, lowMs: 120_000, highMs: 240_000, runs: 6, from: 'history' as const } } } : stage));

    expect(startStep(waitingItems(snapshot({ boards: [{ ...failed, stages: measure(['implement', 'qa']) }] }))[0]!)).toMatchObject({ kind: 'fix', line: 'Claude Code · sonnet · medium · about $0.40 · 4 to 8 min for both runs' });
    expect(startStep(waitingItems(snapshot({ boards: [{ ...failed, stages: measure(['implement']) }] }))[0]!)).toMatchObject({ kind: 'fix', line: 'Claude Code · sonnet · medium' });
  });

  it('refuses Fix it when its QA run would be refused', () => {
    const gone = cardFixture({ key: 'APP-4', stage: 'qa', state: 'ready', verdict: 'FAIL', starts: { qa: { phase: 'qa', model: 'sonnet-4-5', effort: 'high', engine: 'claude-code', modelState: 'gone', refusal: null } } });

    expect(startStep(item(gone))).toEqual({ kind: 'refused', reason: 'sonnet-4-5 is gone. Pick another model in the card settings, or in Settings, Models.' });
  });

  it('sends a card back one column, the way Shift Left does', () => {
    expect(backStep(item(cardFixture({ key: 'APP-2', stage: 'plan', state: 'ready' })))).toEqual({ to: 'refine', label: 'Refine' });
    expect(backStep(item(cardFixture({ key: 'APP-4', stage: 'qa', state: 'ready', verdict: 'FAIL' })))).toEqual({ to: 'implement', label: 'Implement' });
    expect(backStep(item(cardFixture({ key: 'APP-1', stage: 'plan', state: 'blocked', question: 'Stars?' })))).toBeNull();
  });
});

describe('Running', () => {
  const live = (over: { line?: string | null; quiet?: string | null; since?: string | null } = {}) => ({ line: 'Editing web/src/lib/RecipeCard.svelte', quiet: null, since: '4s ago', ...over });

  it('counts a running row up from its start, and gives a queued one its place', () => {
    expect(rowPill(row(), null, NOW)).toEqual({ state: 'running', word: null, detail: '2m 14s' });
    expect(rowPill(row({ state: 'queued', runState: 'queued', position: 1, startedAt: null }), null, NOW)).toEqual({ state: 'queued', word: null, detail: '1st' });
    // No start yet, or no clock: the word, never a made-up time.
    expect(rowPill(row({ startedAt: null }), null, NOW)).toEqual({ state: 'running', word: null, detail: null });
  });

  it('reads Quiet once the run has said nothing for the set time, and Retrying in a retry wait', () => {
    expect(rowPill(row(), live({ quiet: '6m', since: null }), NOW)).toEqual({ state: 'quiet', word: null, detail: '6m' });
    expect(rowPill(row({ runState: 'retrying' }), null, NOW)).toEqual({ state: 'running', word: 'Retrying', detail: null });
  });

  it('says what the run did last, or why a queued one waits', () => {
    expect(rowSays(row(), live())).toBe('Editing web/src/lib/RecipeCard.svelte · 4s ago');
    expect(rowSays(row(), live({ quiet: '6m', since: null }))).toBe('Editing web/src/lib/RecipeCard.svelte');
    expect(rowSays(row(), null)).toBeNull();
    expect(rowSays(row({ state: 'queued', runState: 'queued' }), null)).toBe('Starts when a slot is free');
    expect(rowSays(row({ state: 'queued', runState: 'waiting_lane', lane: 'knowledge' }), null)).toBe('Waits for the Knowledge lane');
    expect(rowSays(row({ runState: 'retrying' }), null)).toBe('Waits to try again after an API error');
  });

  // The wait is stored with its reason and the time the next try starts, so the line counts
  // down on the clock the page ticks.
  it('counts a retry wait down from its stored time, with its reason and the attempt', () => {
    const retry = { attempt: 2, maxRetries: 3, reason: 'API Error: 529 Overloaded', until: NOW.getTime() + 134_000 };
    expect(rowSays(row({ runState: 'retrying', retry }), null, NOW)).toBe('API Error: 529 Overloaded, retrying in 2m 14s, attempt 2 of 3');
    expect(rowSays(row({ runState: 'retrying', retry }), null, new Date(NOW.getTime() + 134_000))).toBe('API Error: 529 Overloaded, retrying now, attempt 2 of 3');
    // No clock, or no stored time: the line says what kind of wait it is and makes up no count.
    expect(rowSays(row({ runState: 'retrying', retry }), null)).toBe('Waits to try again after an API error');
    expect(rowSays(row({ runState: 'retrying', retry: null }), null, NOW)).toBe('Waits to try again after an API error');
  });

  it('says how many slots are busy, as the rail foot prints it', () => {
    expect(slotsLine({ busy: 2, total: 3 })).toBe('2 of 3 slots busy');
    expect(slotsLine({ busy: 1, total: 1 })).toBe('1 of 1 slot busy');
  });

  // The board header's meter: one pip per slot, each busy one naming the card and phase that holds it.
  it('names the run in each busy slot, says when another project holds one, and marks the card a click can reach', () => {
    const now = snapshot({
      boards: [board([], { slots: { busy: 3, total: 4 } })],
      running: [row({ key: 'APP-2', phase: 'Implement' }), row({ key: 'APP-5', state: 'queued', runState: 'queued' }), row({ key: 'knowledge', kind: 'maintenance', title: null, phase: 'Knowledge upkeep' })],
    });
    expect(slotPips(now)).toEqual([
      { label: 'APP-2 · Implement', key: 'APP-2', busy: true },
      { label: 'Knowledge upkeep', key: null, busy: true },
      { label: 'Busy in another project', key: null, busy: true },
      { label: 'Free slot', key: null, busy: false },
    ]);
  });

  it('still fills a busy slot the rows do not name, and draws nothing with no slots', () => {
    expect(slotPips(snapshot({ boards: [board([], { slots: { busy: 1, total: 2 } })] }))).toEqual([
      { label: 'Busy in another project', key: null, busy: true },
      { label: 'Free slot', key: null, busy: false },
    ]);
    expect(slotPips(snapshot({ boards: [board([], { slots: { busy: 0, total: 0 } })] }))).toEqual([]);
  });
});

describe('Done today and Today', () => {
  it('prints the cost and the time of a done card, and says when no cost was reported', () => {
    expect(doneLine({ key: 'APP-11', title: 'Sort by time', summary: null, costUsd: 0.92, durationMs: 14 * 60_000 + 3000 })).toBe('$0.92 · 14m 03s');
    expect(doneLine({ key: 'APP-11', title: 'Sort by time', summary: null, costUsd: null, durationMs: 9 * 60_000 })).toBe('no cost reported · 9m 00s');
  });

  it('prints the day as four figures, with the cost called an estimated value', () => {
    expect(todayStats({ runs: 9, reported: 9, costUsd: 1.84, durationMs: 47 * 60_000, moved: 6 })).toEqual([
      { value: '47m', label: 'agent time' },
      { value: '9', label: 'runs' },
      { value: '$1.84', label: 'estimated value' },
      { value: '6', label: 'cards moved' },
    ]);
    expect(todayStats({ runs: 1, reported: 1, costUsd: 0, durationMs: 3_700_000, moved: 1 })).toEqual([
      { value: '1h 01m', label: 'agent time' },
      { value: '1', label: 'run' },
      { value: '$0.00', label: 'estimated value' },
      { value: '1', label: 'card moved' },
    ]);
  });

  // A cost nobody reported is never summed as zero, and a sum short of some runs says so.
  it('says how many runs the cost covers, and shows no cost no run reported', () => {
    expect(todayStats({ runs: 9, reported: 7, costUsd: 1.5, durationMs: 0, moved: 0 })[2]).toEqual({ value: '$1.50', label: 'estimated value of 7 of 9 runs' });
    expect(todayStats({ runs: 3, reported: 0, costUsd: null, durationMs: 0, moved: 0 })[2]).toEqual({ value: 'None', label: 'no run reported a cost' });
    expect(todayStats({ runs: 1, reported: 0, costUsd: null, durationMs: 42_500, moved: 0 })[0]).toEqual({ value: '42s', label: 'agent time' });
    expect(todayStats({ runs: 0, reported: 0, costUsd: null, durationMs: 0, moved: 0 })[2]).toEqual({ value: '$0.00', label: 'estimated value' });
  });
});

describe('Usage limits', () => {
  const SEEN = Date.parse('2026-10-12T11:59:00.000Z');
  const reading = (windows: ProfileLimit['windows'], seenAt = SEEN): Record<string, ProfileLimit> => ({ 'claude-code': { seenAt, windows } });
  const claude = { id: 'claude-code', label: 'Claude Code', silent: false };

  it('shows each window the engine reported, with its reset and when it was seen', () => {
    const five = { name: 'five_hour', used: 0.62, resetsAt: Date.parse('2026-10-12T19:00:00.000Z') / 1000, status: 'allowed' };
    const week = { name: 'seven_day', used: 0.31, resetsAt: Date.parse('2026-10-15T09:00:00.000Z') / 1000, status: 'allowed' };

    expect(usageRows([claude], reading([five, week]), NOW.getTime(), 'UTC')).toEqual([
      { name: 'Claude Code · 5 hours', share: 62, note: null, detail: 'resets 19:00 · seen 1m ago' },
      { name: 'Claude Code · week', share: 31, note: null, detail: 'resets 15 Oct, 09:00 · seen 1m ago' },
    ]);
  });

  it('says when a profile has not been seen, or its engine reports nothing', () => {
    const codex = { id: 'codex', label: 'Codex CLI', silent: false };
    const cursor = { id: 'cursor', label: 'Cursor', silent: true };

    expect(usageRows([codex, cursor], {}, NOW.getTime(), 'UTC')).toEqual([
      { name: 'Codex CLI', share: null, note: 'not seen yet', detail: null },
      { name: 'Cursor', share: null, note: 'reports no usage window', detail: null },
    ]);
  });

  // A share from before the window reset says nothing about the window now, so no figure is shown.
  it('shows no share for a window that reset after it was seen', () => {
    const old = { name: 'five_hour', used: 0.9, resetsAt: Date.parse('2026-10-12T10:00:00.000Z') / 1000, status: 'allowed' };

    expect(usageRows([claude], reading([old], Date.parse('2026-10-12T08:00:00.000Z')), NOW.getTime(), 'UTC')).toEqual([
      { name: 'Claude Code · 5 hours', share: null, note: 'reset since it was seen', detail: null },
    ]);
  });

  // The drop box's rule: a five-hour reading older than five hours is from a window that reset.
  it('shows no share for a reading older than its window, with no reset time either', () => {
    const five = { name: 'five_hour', used: 0.4, resetsAt: null, status: null };

    expect(usageRows([claude], reading([five], NOW.getTime() - 5 * 60 * 60 * 1000 - 1), NOW.getTime(), 'UTC')[0]).toMatchObject({ share: null, note: 'reset since it was seen' });
    expect(usageRows([claude], reading([five], NOW.getTime() - 4 * 60 * 60 * 1000), NOW.getTime(), 'UTC')[0]).toEqual({ name: 'Claude Code · 5 hours', share: 40, note: null, detail: 'seen 4h ago' });
  });

  // The near-limit warning names the profile and the measured share, and shows nothing without a
  // reading at 90% or more.
  it('warns for each window at 90% or more, with the profile it belongs to', () => {
    const five = { name: 'five_hour', used: 0.99, resetsAt: Date.parse('2026-10-12T19:00:00.000Z') / 1000, status: 'allowed' };
    const week = { name: 'seven_day', used: 0.89, resetsAt: Date.parse('2026-10-15T09:00:00.000Z') / 1000, status: 'allowed' };
    const work = { id: 'claude-code#work', label: 'Work', silent: false };

    expect(nearLines([claude, work], { ...reading([five, week]), 'claude-code#work': { seenAt: SEEN, windows: [{ ...week, used: 0.93 }] } }, NOW.getTime(), 'UTC')).toEqual([
      'Claude Code: 5-hour window 99% used, resets 19:00',
      'Work: weekly window 93% used, resets 15 Oct, 09:00',
    ]);
    expect(nearLines([claude], reading([{ ...five, used: 0.89 }]), NOW.getTime(), 'UTC')).toEqual([]);
    expect(nearLines([claude], {}, NOW.getTime(), 'UTC')).toEqual([]);
  });

  it('says so when the engine named a window and gave no share for it', () => {
    expect(usageRows([claude], reading([{ name: 'five_hour', used: null, resetsAt: null, status: null }]), NOW.getTime(), 'UTC')).toEqual([
      { name: 'Claude Code · 5 hours', share: null, note: 'no share reported', detail: null },
    ]);
  });

  it('keeps the default profile’s label and an unknown window’s own name', () => {
    expect(usageRows([{ id: DEFAULT_PROFILE.id, label: DEFAULT_PROFILE.label, silent: false }], reading([{ name: 'seven_day_opus', used: 0.1, resetsAt: null, status: null }], NOW.getTime() - 20_000), NOW.getTime(), 'UTC')).toEqual([
      { name: 'Claude Code · seven_day_opus', share: 10, note: null, detail: 'seen under a minute ago' },
    ]);
  });
});

describe('the stream event', () => {
  it('takes a whole Now snapshot and nothing else', () => {
    expect(isNow(snapshot())).toBe(true);
    expect(isNow(board([]))).toBe(false);
    expect(isNow({ ...snapshot(), boards: [{}] })).toBe(false);
    expect(isNow(null)).toBe(false);
  });
});

// The question at the first QA: a move into QA asks it while the project has not answered, and every
// other move, and every move after the answer, goes straight on.
describe('stackAsk', () => {
  const qaSetup = { project: 'recipes', repo: null, dev: { command: 'npm run dev', repo: '.' }, scripts: '', unwalled: null, address: '', test: 'npm test', playwright: false, chrome: false, browser: false };
  const waiting = board([cardFixture({ key: 'APP-1', stage: 'implement', state: 'ready' }), cardFixture({ key: 'APP-2', stage: 'refine', state: 'ready' })]);

  it('asks on a move into QA with the QA stage it starts', () => {
    expect(stackAsk(snapshot({ boards: [waiting], qaSetup }), 'APP-1', 'qa')?.starts?.phase).toBe('qa');
  });

  // The answer is cleared when the scripts changed on a card's branch, and a retry in QA starts the app again.
  it('asks on a retry of a card in QA, and on no retry elsewhere', () => {
    const failed = board([cardFixture({ key: 'APP-3', stage: 'qa', state: 'failed' })]);
    expect(stackAsk(snapshot({ boards: [failed], qaSetup }), 'APP-3', 'qa')?.starts?.phase).toBe('qa');
    expect(stackAsk(snapshot({ boards: [waiting], qaSetup }), 'APP-1', 'implement')).toBeNull();
  });

  it('asks nothing on a move that starts no QA', () => {
    expect(stackAsk(snapshot({ boards: [waiting], qaSetup }), 'APP-2', 'plan')).toBeNull();
    expect(stackAsk(snapshot({ boards: [waiting], qaSetup }), 'APP-1', 'plan')).toBeNull();
  });

  it('asks nothing once the project answered, or from a snapshot built before the question', () => {
    expect(stackAsk(snapshot({ boards: [waiting], qaSetup: null }), 'APP-1', 'qa')).toBeNull();
    expect(stackAsk(snapshot({ boards: [waiting] }), 'APP-1', 'qa')).toBeNull();
    expect(stackAsk(null, 'APP-1', 'qa')).toBeNull();
  });

  // A workspace answers per repository, so only a card whose repository has no answer asks.
  it('asks only for the cards the stream names', () => {
    expect(stackAsk(snapshot({ boards: [waiting], qaSetup, qaAsks: ['APP-1'] }), 'APP-1', 'qa')?.starts?.phase).toBe('qa');
    expect(stackAsk(snapshot({ boards: [waiting], qaSetup, qaAsks: ['APP-2'] }), 'APP-1', 'qa')).toBeNull();
  });
});

// An epic does not move to Wrap-up by itself when its last task closes. Now lists it
// for the person, and the go button is the one that starts Wrap-up.
describe('an epic whose every task is done', () => {
  const epics = (cards: CardView[]): BoardSnapshot => ({
    ...boardFixture('pull-request', cards),
    kind: 'epics',
    stages: [
      stageFixture({ id: 'inbox', label: 'Inbox', role: 'you' }),
      stageFixture({ id: 'review', label: 'Review', role: 'you' }),
      stageFixture({ id: 'in-delivery', label: 'In delivery', role: 'auto' }),
      stageFixture({ id: 'wrapup', label: 'Wrap-up', role: 'agent', starts: { phase: 'wrapup', model: 'haiku', effort: 'low', engine: 'claude-code', modelState: 'ok', refusal: null } }),
      stageFixture({ id: 'done', label: 'Done', role: 'archive' }),
    ],
  });
  const finished = cardFixture({ key: 'APP-1', stage: 'in-delivery', state: 'idle', delivered: { done: 2, total: 2 }, finished: true });
  const going = cardFixture({ key: 'APP-5', stage: 'in-delivery', state: 'idle', delivered: { done: 1, total: 2 } });
  const now = snapshot({ boards: [board([]), epics([finished, going])], waiting: { 'APP-1': extra('2026-10-12T11:55:00.000Z') } });

  it('waits on the person while it stays in In delivery', () => {
    const items = waitingItems(now);

    expect(items.map((item) => [item.card.key, item.kind, item.card.stage])).toEqual([['APP-1', 'tasks-done', 'in-delivery']]);
    expect(waitingCount(now)).toBe(1);
  });

  it('offers Wrap-up as the one go button, and no way back', () => {
    const [item] = waitingItems(now);

    expect(startStep(item!)).toMatchObject({ kind: 'go', to: 'wrapup', label: 'Start Wrap-up' });
    expect(backStep(item!)).toBeNull();
    expect(whenLine(item!, NOW)).toBe('In delivery · waiting 5m');
  });
});

describe('longSummary', () => {
  it('holds a summary longer than three lines, and leaves a few short sentences whole', () => {
    expect(longSummary('Sessions get a Published flag. New ones start Published.')).toBe(false);
    expect(longSummary('One.\nTwo.\nThree.')).toBe(false);
    expect(longSummary('One.\nTwo.\nThree.\nFour.')).toBe(true);
    expect(longSummary('All 8 steps are done.\n\nBackend:\n- One\n- Two')).toBe(true);
    expect(longSummary('x'.repeat(216))).toBe(false);
    expect(longSummary('x'.repeat(217))).toBe(true);
    // A blank line between paragraphs takes room too.
    expect(longSummary('One.\n\nTwo.\n\nThree.')).toBe(true);
    // Two source lines that each wrap once are four drawn lines.
    expect(longSummary(`${'x'.repeat(100)}\n${'x'.repeat(100)}`)).toBe(true);
  });
});
