import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCard, openDatabase, setCardModels, startRun, writeSetting } from '@nolzu/core/node';
import { type BoardKind, DEFAULT_PROFILE } from '@nolzu/protocol';
import { waitingOnMe } from '@nolzu/ui';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The stub vitest aliases `$app/paths` to. By path and not by that name, because the app's types for
// `$app/paths` are SvelteKit's own and carry no `drawnAt`.
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import { createLoop, type Loop } from '$lib/loop.ts';
import { isNow, type NowSnapshot, waitingCount } from '$lib/now.ts';
import { nowSnapshot } from '$lib/now-snapshot.ts';
import NowPage from '$lib/NowPage.svelte';
import { events } from './api/board/stream.ts';

// Scout and Evidence are off as shipped. These tests pin how they work once the switch is on again, and
// coming-soon.test.ts pins the off state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), SCOUT_AND_EVIDENCE: true }));

// Now over a fixture database with one card in each state, read the way the Now stream reads it and
// drawn the way the page draws it. One agent slot, so the second run waits in the queue, and an engine
// that never answers, so the first one stays running.
let dir = '';
let live: Loop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-now-'));
  const db = openDatabase(dir);
  writeSetting(db, 'agentSlots', 1);
  writeSetting(db, 'offBoards', ['epics']);
  db.close();
  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  live.engine.spawn = async function* () {
    await new Promise<never>(() => {});
    yield '';
  };
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A fixed noon, so "today" and every age hold whenever the suite runs.
const NOON = new Date('2026-10-12T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOON.getTime() - minutesAgo * 60_000).toISOString();

// A run of a card, ended with what the test names. Written through the run writer, then the columns
// the loop would have written when it ended.
function ran(key: string, phase: string, ended: Record<string, string | number | null>): number {
  const id = startRun(live.db, { cardKey: key, phase, engine: DEFAULT_PROFILE.id, model: 'sonnet', effort: 'medium', sessionId: 's-1', logPath: join(dir, `${key}.ndjson`), lane: null });
  const columns = Object.keys(ended);
  live.db.prepare(`UPDATE runs SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(ended), id);
  return id;
}

function card(key: string, stage: string, state: string, board: BoardKind = 'delivery'): void {
  createCard(live.db, { key, board, stage, title: `${key} title` });
  live.db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(state, key);
}

// A run the scheduler holds: running in the one slot, or waiting for it.
function queued(key: string, phase: 'implement' | 'plan'): void {
  live.db.prepare("UPDATE cards SET state = 'queued' WHERE key = ?").run(key);
  const id = startRun(live.db, { cardKey: key, phase, engine: DEFAULT_PROFILE.id, model: 'sonnet', effort: 'high', sessionId: null, logPath: join(dir, `${key}.ndjson`), lane: null });
  live.scheduler.add(live.buildJob(key, phase, id));
}

async function fixture(): Promise<NowSnapshot> {
  card('APP-1', 'plan', 'blocked');
  ran('APP-1', 'plan', {
    state: 'complete',
    question: 'Should a rating be 1 to 5 stars, or thumbs up and down?',
    question_options: JSON.stringify([
      { label: '1 to 5 stars', means: 'A new column in recipes.' },
      { label: 'Thumbs up and down', means: 'Reuse the likes table.' },
    ]),
    ended_at: at(12),
  });
  card('APP-2', 'plan', 'ready');
  ran('APP-2', 'plan', { state: 'complete', plain_summary: 'The search runs in the api, and the page only sends what you type.', ended_at: at(3) });
  card('APP-3', 'qa', 'ready');
  ran('APP-3', 'qa', { state: 'complete', verdict: 'FAIL', verdict_reason: 'When the api is down the page shows an empty list.', ended_at: at(22) });
  card('APP-4', 'refine', 'failed');
  ran('APP-4', 'refine', { state: 'failed', error: 'The engine stopped before it wrote the ticket.', ended_at: at(30) });
  card('APP-5', 'inbox', 'idle');
  card('APP-6', 'implement', 'idle');
  queued('APP-6', 'implement');
  card('APP-7', 'plan', 'idle');
  queued('APP-7', 'plan');
  // Done today: moved into Closed today, after a run that cost something.
  card('APP-8', 'closed', 'idle');
  live.db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, at) VALUES ('APP-8', 'wrapup', 'closed', 'auto', ?)").run(at(35));
  ran('APP-8', 'wrapup', { state: 'complete', cost_estimate: 0.48, duration_ms: 9 * 60_000, plain_summary: 'Each card shows its time in minutes.', ended_at: at(40) });
  // On a board that is off, so it waits on nobody's screen and counts nowhere.
  card('APP-9', 'plan', 'ready', 'epics');
  await new Promise((resolve) => setTimeout(resolve, 50));
  return nowSnapshot(live, NOON);
}

const page = (snapshot: NowSnapshot) => {
  drawnAt('/');
  return render(NowPage, { props: { stream: { snapshot, reconnecting: false, activity: {}, limits: {} }, now: NOON } }).body;
};
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const section = (html: string, id: string) => new RegExp(`<section[^>]*aria-labelledby="${id}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? '';
// The opening tag of the one button that carries the data attribute, whatever order the attributes take.
const button = (html: string, data: string) => new RegExp(`<button[^>]*${data}[^>]*>`).exec(html)?.[0] ?? '';
const item = (html: string, key: string) => new RegExp(`<article[^>]*data-card="${key}"[\\s\\S]*?</article>`).exec(html)?.[0] ?? '';

describe('Now over a fixture database', () => {
  it('lists every card that waits, oldest first, and counts them as waitingOnMe does', async () => {
    const snapshot = await fixture();
    const html = page(snapshot);
    const waiting = section(html, 'waiting-title');

    expect([...waiting.matchAll(/<article[^>]*data-card="([^"]+)"/g)].map((found) => found[1])).toEqual(['APP-4', 'APP-3', 'APP-1', 'APP-2']);
    const counted = snapshot.boards.flatMap((board) => board.cards).filter(waitingOnMe).length;
    expect(counted).toBe(4);
    expect(waitingCount(snapshot)).toBe(counted);
    expect(waiting).toContain(`data-waiting-count="">${counted}</span>`);
    // The off board's card is in no board Now reads.
    expect(snapshot.boards.map((board) => board.kind)).not.toContain('epics');
    expect(html).not.toContain('APP-9');
  });

  it('answers a question with the offered answers and Send and resume', async () => {
    const asks = item(page(await fixture()), 'APP-1');

    expect(text(asks)).toContain('Asks you APP-1 APP-1 title Plan · waiting 12m Should a rating be 1 to 5 stars, or thumbs up and down?');
    expect(asks).toMatch(/<button[^>]*aria-pressed="false"[^>]*>[\s\S]*?1 to 5 stars/);
    expect(asks).toMatch(/<button[^>]*aria-pressed="false"[^>]*>[\s\S]*?Thumbs up and down/);
    expect(asks).toContain('placeholder="Or write your own answer"');
    expect(button(asks, 'data-send-answer')).toContain('class="btn go');
    expect(asks).toMatch(/data-send-answer[^>]*>[\s\S]*?data-glyph="resume"[\s\S]*?Send and resume/);
    // Nothing typed yet, so Send is held.
    expect(button(asks, 'data-send-answer')).toContain('aria-disabled="true"');
  });

  it('approves a ready card with what the start runs, and offers the plan and Send back', async () => {
    const ready = item(page(await fixture()), 'APP-2');

    expect(text(ready)).toContain('Ready for you APP-2 APP-2 title Plan done 3m ago The search runs in the api, and the page only sends what you type.');
    expect(button(ready, 'data-approve')).toContain('class="btn go');
    // No estimate: nothing measured an Implement run in this project.
    expect(text(ready)).toMatch(/Approve and start Implement Claude Code · \S+ · \S+ Read the plan Send back/);
    expect(ready).toContain('href="./t/APP-2/overview#plan"');
  });

  // Fix it is the go button, and it names both runs. No estimate: nothing measured
  // an Implement or a QA run in this project.
  it('shows a QA failure with its reason, the amber Fix it and the report', async () => {
    const failed = item(page(await fixture()), 'APP-3');

    expect(text(failed)).toMatch(/^QA failed APP-3 APP-3 title QA · 22m ago When the api is down the page shows an empty list\. Fix it: run Implement again with this reason, then QA Claude Code · \S+ · \S+ See the QA report Send back$/);
    expect(button(failed, 'data-fix')).toContain('class="btn go');
    expect(failed).toContain('href="./t/APP-3/overview#qa-panel"');
    expect(button(failed, 'data-send-back')).not.toContain('class="btn go');
  });

  it('retries a failed run with its start line', async () => {
    const failed = item(page(await fixture()), 'APP-4');

    // Refine on haiku at low effort is the one preset row with measured runs behind it.
    expect(text(failed)).toBe('Failed APP-4 APP-4 title Refine · 30m ago The engine stopped before it wrote the ticket. Retry Refine Claude Code · haiku · low · about $0.05 · under a minute Open the card Send back');
    expect(button(failed, 'data-retry')).toContain('class="btn go');
  });

  // Read the plan is for a card ready after Plan. A card that failed in Plan has no plan to read.
  it('keeps Open the card on a card that failed in Plan', async () => {
    const snapshot = await fixture();
    const moved = { ...snapshot, boards: snapshot.boards.map((board) => ({ ...board, cards: board.cards.map((card) => (card.key === 'APP-4' ? { ...card, stage: 'plan' } : card)) })) };
    const failed = item(page(moved), 'APP-4');

    expect(text(failed)).toContain('Open the card');
    expect(text(failed)).not.toContain('Read the plan');
  });

  it('shows the queue with the slots and lanes, Stop for the running run and Remove for the waiting one', async () => {
    const running = section(page(await fixture()), 'running-title');

    expect(text(running)).toContain('Running 2');
    expect(running).toContain('1 of 1 agent slots busy');
    expect(text(running)).toContain('Stack lane free');
    expect(running).toMatch(/data-state="running"[\s\S]*?APP-6 title[\s\S]*?Implement[\s\S]*?sonnet · high[\s\S]*?aria-label="Stop APP-6"/);
    expect(running).toMatch(/data-state="queued"[\s\S]*?Queued[\s\S]*?1st[\s\S]*?APP-7 title[\s\S]*?Starts when a slot is free[\s\S]*?aria-label="Remove APP-7 from the queue"/);
    // A card in the queue is not waiting on the person.
    expect(section(page(nowSnapshot(live, NOON)), 'waiting-title')).not.toContain('APP-6');
  });

  // One model name can run on two engines, so the row names the engine before it.
  it('names the engine of each running run beside its model', async () => {
    const running = section(page(await fixture()), 'running-title');

    expect(text(running)).toContain('Claude Code · sonnet · high');
  });

  // The wait after an API error is stored with its reason and the time the next try starts, so the
  // Running row counts down where it once said only what kind of wait it was.
  it('counts a retry wait down from the time stored on its run, with the reason', async () => {
    card('APP-6', 'implement', 'queued');
    queued('APP-6', 'implement');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const runId = live.scheduler.queue().running[0]!.runId;
    live.db
      .prepare("UPDATE runs SET state = 'retrying', attempt = 2, retry_max = 3, retry_reason = 'API Error: 529 Overloaded', retry_until = ? WHERE id = ?")
      .run(NOON.getTime() + 134_000, runId);

    const snapshot = nowSnapshot(live, NOON);
    expect(snapshot.running[0]?.retry).toEqual({ attempt: 2, maxRetries: 3, reason: 'API Error: 529 Overloaded', until: NOON.getTime() + 134_000 });
    expect(text(section(page(snapshot), 'running-title'))).toContain('Retrying APP-6 APP-6 title API Error: 529 Overloaded, retrying in 2m 14s, attempt 2 of 3');
  });

  it('lists what was done today, and the day in figures from the runs that ended today', async () => {
    const html = page(await fixture());

    expect(text(section(html, 'done-title'))).toBe('Done today 1 APP-8 APP-8 title Each card shows its time in minutes. $0.48 · 9m 00s');
    // Five runs ended today and one reported a cost. Nine cards were made, which is no move, and one
    // was moved.
    expect(text(section(html, 'today-title'))).toBe('Today 9m agent time 5 runs $0.48 estimated value of 1 of 5 runs 1 card moved');
    expect(text(section(html, 'usage-title'))).toBe('Usage limits Claude Code not seen yet');
  });

  // The runs a page raises a toast for: ended ready or failed, newest first. A question, a stop, a pass,
  // an Ask message, a run with no card and a run still in the queue raise none.
  it('carries the newest card runs that ended ready or failed, and none still in the queue', async () => {
    await fixture();
    card('APP-10', 'plan', 'idle');
    ran('APP-10', 'plan', { state: 'stopped', ended_at: at(1) });
    ran('APP-2', 'extract-summary', { state: 'complete', ended_at: at(1) });
    ran('APP-2', 'ask', { state: 'complete', ended_at: at(1) });
    ran('kb-maintenance', 'optimize', { state: 'complete', ended_at: at(1) });
    const running = live.scheduler.queue().running[0]!.runId;
    live.db.prepare("UPDATE runs SET state = 'complete', ended_at = ? WHERE id = ?").run(at(0), running);

    const ended = nowSnapshot(live, NOON).ended ?? [];

    expect(ended.map((run) => [run.key, run.phase, run.state, run.verdict, run.reason])).toEqual([
      ['APP-2', 'Plan', 'complete', null, null],
      ['APP-3', 'QA', 'complete', 'FAIL', 'When the api is down the page shows an empty list.'],
      ['APP-4', 'Refine', 'failed', null, 'The engine stopped before it wrote the ticket.'],
      ['APP-8', 'Wrap-up', 'complete', null, null],
    ]);
    expect(ended[3]).toMatchObject({ model: 'sonnet', durationMs: 9 * 60_000, costUsd: 0.48, endedAt: at(40) });
  });

  // The near-limit warning names the profile and the share the engine measured. Under 90% there is none.
  it('warns in Usage limits when a window reads 90% or more, and not under that', async () => {
    const snapshot = await fixture();
    const reading = (used: number) => ({ [DEFAULT_PROFILE.id]: { seenAt: NOON.getTime() - 60_000, windows: [{ name: 'five_hour', used, resetsAt: Date.parse('2026-10-12T15:00:00.000Z') / 1000, status: 'allowed' }] } });
    const usage = (used: number) => section(render(NowPage, { props: { stream: { snapshot, reconnecting: false, activity: {}, limits: reading(used) }, now: NOON } }).body, 'usage-title');

    expect(text(usage(0.99))).toContain('Claude Code: 5-hour window 99% used, resets 15:00');
    expect(usage(0.99)).toContain('data-kind="warning"');
    expect(usage(0.89)).not.toContain('data-kind="warning"');
  });

  // A cost nobody reported is never summed as zero, in Done today or in Today.
  it('shows no cost where no run reported one, and never a made-up $0.00', () => {
    card('APP-8', 'closed', 'idle');
    live.db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, at) VALUES ('APP-8', 'wrapup', 'closed', 'auto', ?)").run(at(35));
    ran('APP-8', 'wrapup', { state: 'complete', cost_estimate: null, duration_ms: 9 * 60_000, ended_at: at(40) });
    const html = page(nowSnapshot(live, NOON));

    expect(text(section(html, 'done-title'))).toBe('Done today 1 APP-8 APP-8 title no cost reported · 9m 00s');
    expect(text(section(html, 'today-title'))).toBe('Today 9m agent time 1 run None no run reported a cost 1 card moved');
    expect(html).not.toContain('$0.00');
  });

  // A card shows in one section at a time: moved into Pull request today and in the queue again now, it
  // is in Running and not in Done today.
  it('keeps a card that is in the queue out of Done today', async () => {
    card('APP-8', 'pr-watch', 'idle');
    live.db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, at) VALUES ('APP-8', 'wrapup', 'pr-watch', 'auto', ?)").run(at(35));
    queued('APP-8', 'implement');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const html = page(nowSnapshot(live, NOON));

    expect(text(section(html, 'done-title'))).toBe('Done today 0 Nothing done yet today.');
    expect(text(section(html, 'running-title'))).toContain('APP-8 APP-8 title');
  });

  // Today starts at midnight on this machine's clock, the day the browser prints, and not 24 hours ago.
  it('counts Today from midnight on this machine, so a run that ended late yesterday is not in it', () => {
    card('APP-8', 'implement', 'idle');
    ran('APP-8', 'implement', { state: 'complete', cost_estimate: 0.2, duration_ms: 60_000, ended_at: new Date(2026, 9, 11, 23, 0).toISOString() });
    ran('APP-8', 'implement', { state: 'complete', cost_estimate: 0.3, duration_ms: 120_000, ended_at: new Date(2026, 9, 12, 0, 30).toISOString() });

    expect(nowSnapshot(live, new Date(2026, 9, 12, 12, 0)).today).toEqual({ runs: 1, reported: 1, costUsd: 0.3, durationMs: 120_000, moved: 0 });
  });

  it('leaves out the idle card, which waits on nobody and runs nothing', async () => {
    expect(page(await fixture())).not.toContain('APP-5');
  });
});

// The chain suggestion in the right column, over stored events: five plans moved on to Implement
// after one run each, as a person approving them as they came leaves them.
describe('the chain suggestion', () => {
  function approved(count: number): void {
    for (let n = 1; n <= count; n++) {
      const key = `APP-${20 + n}`;
      card(key, 'implement', 'idle');
      live.db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, started_phase, at) VALUES (?, 'refine', 'plan', 'you', 'plan', ?)").run(key, at(60 - n * 3));
      ran(key, 'plan', { state: 'complete', started_at: at(59 - n * 3), ended_at: at(59 - n * 3) });
      live.db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, started_phase, at) VALUES (?, 'plan', 'implement', 'you', 'implement', ?)").run(key, at(58 - n * 3));
    }
  }
  const slot = (html: string) => /<section[^>]*data-chain="[^"]*"[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';

  it('suggests the chain with the real count, in the amber panel', () => {
    approved(5);
    const suggestion = slot(page(nowSnapshot(live, NOON)));

    expect(suggestion).toContain('class="panel pad suggest');
    expect(text(suggestion)).toBe('A suggestion You approved 5 of the last 5 plans without a change. Let Implement start right after Plan on the cards you tick? Turn on Not now');
    // Neither button starts a run, so neither is the amber go button.
    expect(button(suggestion, 'data-chain-on')).toMatch(/class="btn sm/);
    expect(button(suggestion, 'data-chain-later')).toMatch(/class="btn ghost sm/);
  });

  it('shows nothing below the threshold', () => {
    approved(4);

    expect(slot(page(nowSnapshot(live, NOON)))).toBe('');
  });

  it('turns into the off switch once the chain is on', () => {
    approved(5);
    writeSetting(live.db, 'chainBoards', ['delivery']);
    const on = slot(page(nowSnapshot(live, NOON)));

    expect(text(on)).toBe('Implement after Plan On for Delivery cards where "Go on to Implement after Plan" is ticked on the Settings tab. When their plan is done, Implement starts without waiting for you. Turn off');
    expect(on).not.toContain('suggest');
  });

  // The card stays ready on Plan, as after a refused drop, and the item says why in the shared neutral
  // warning box. The approve button is refused for the same reason, and the sentence shows once.
  it('says why a chained start was refused on the card that waits', () => {
    card('APP-2', 'plan', 'ready');
    setCardModels(live.db, 'APP-2', { implement: { engine: 'claude-code', model: 'gpt-9' } });
    const gone = 'gpt-9 is gone. Pick another model in the card settings, or in Settings, Models.';
    ran('APP-2', 'plan', { state: 'complete', ended_at: at(3), chain_refused: `Implement did not start on its own. ${gone}` });
    const ready = item(page(nowSnapshot(live, NOON)), 'APP-2');

    expect(ready).toMatch(/<div class="banner[^"]*" data-kind="warning"/);
    expect(text(ready)).toContain(`Plan done 3m ago Implement did not start on its own. ${gone}`);
    expect(text(ready).split(gone)).toHaveLength(2);
    expect(ready).not.toContain('class="refused');
  });
});

// A wrap-up that held its card short of Closed says why on Now, in the neutral box: a knowledge change
// that waits for review first, then problems the output check found. A card with neither says nothing.
describe('a wrap-up held on Wrap-up', () => {
  it('says what the card still holds for the person', () => {
    card('APP-2', 'wrapup', 'ready');
    const runId = ran('APP-2', 'wrapup', { state: 'complete', ended_at: at(3) });
    const said = () => text(item(page(nowSnapshot(live, NOON)), 'APP-2'));

    expect(said()).not.toContain('waits for your review');
    live.db.prepare("UPDATE runs SET output_check = ? WHERE id = ?").run(JSON.stringify({ problems: [{ file: 'knowledge/a.md', problem: 'No description.' }], note: null }), runId);
    expect(said()).toContain('The output check found problems in what the run wrote. Open the card to read them.');
    live.db.prepare("INSERT INTO knowledge_changes (card_key, run_id, file_path, status) VALUES ('APP-2', ?, '.nolzu/knowledge/a.md', 'pending')").run(runId);
    expect(said()).toContain('A knowledge change waits for your review on Knowledge.');
    expect(item(page(nowSnapshot(live, NOON)), 'APP-2')).toMatch(/data-holds[\s\S]*data-kind="warning"/);
  });
});

// A run with no card has no board to show it, so Now is where it shows and where it stops.
describe('runs with no card', () => {
  it('lists the knowledge upkeep run and a Scout assessment from the queue, by what they do', () => {
    const upkeep = ran('kb-maintenance', 'optimize', { state: 'running', started_at: at(2) });
    const assessment = ran('assess-3', 'assess', { state: 'queued' });
    const queue = { slots: 3, running: [{ runId: upkeep, cardKey: 'kb-maintenance', lane: 'knowledge' }], waiting: [{ runId: assessment, cardKey: 'assess-3', lane: 'scout' }] };
    const snapshot = nowSnapshot({ db: live.db, snapshot: live.snapshot, scheduler: { ...live.scheduler, queue: () => queue } }, NOON);

    expect(snapshot.running).toEqual([
      expect.objectContaining({ runId: upkeep, key: 'kb-maintenance', kind: 'maintenance', title: null, phase: 'Optimize', state: 'running', runState: 'running', startedAt: at(2) }),
      expect.objectContaining({ runId: assessment, key: 'assess-3', kind: 'assessment', title: null, phase: 'Assessment', state: 'queued', position: 1 }),
    ]);
    const running = section(page(snapshot), 'running-title');
    expect(text(running)).toContain('maintenance Knowledge maintenance Optimize');
    expect(text(running)).toContain('scout assess Assessment of Scout finding 3 Starts when a slot is free Assessment read-only');
    expect(running).toContain('aria-label="Stop maintenance"');
    expect(running).toContain('aria-label="Remove scout assess from the queue"');
  });
});

describe('an empty Now', () => {
  it('says nothing waits, nothing runs and nothing is done', async () => {
    const html = page(nowSnapshot(live, NOON));

    expect(text(section(html, 'waiting-title'))).toBe('Waiting on you 0 Answer, approve or send back from here. Oldest first. Nothing waiting on you.');
    expect(text(section(html, 'running-title'))).toContain('Nothing runs or waits for a slot.');
    expect(text(section(html, 'done-title'))).toBe('Done today 0 Nothing done yet today.');
    expect(text(html)).toContain('No source yet. Scout reads logs and errors once you add one.');
  });

  it('waits for the first snapshot, and says so while the stream is down', () => {
    drawnAt('/');
    const waiting = render(NowPage, { props: { stream: { snapshot: null, reconnecting: false, activity: {}, limits: {} } } }).body;
    const down = render(NowPage, { props: { stream: { snapshot: null, reconnecting: true, activity: {}, limits: {} } } }).body;

    // A grey card until the first snapshot lands. The words stay for a screen reader.
    expect(text(waiting)).toContain('Waiting for the boards.');
    expect(waiting).toContain('data-shape="card"');
    expect(down).not.toContain('data-skeleton');
    expect(text(down)).toContain('The boards are not answering. Trying again.');
    expect(text(down)).not.toContain('Waiting for the boards.');
  });
});

// The layout opens this stream once, and the rail and the page read it.
describe('the Now stream', () => {
  const chunk = async (reader: ReadableStreamDefaultReader<Uint8Array>) => new TextDecoder().decode((await reader.read()).value);
  const data = (text: string) => JSON.parse(text.slice(text.indexOf('data: ') + 6).trim()) as unknown;

  it('opens with a whole Now snapshot, then the usage readings, and sends a new one on a change to any board', async () => {
    card('APP-1', 'plan', 'ready');
    const controller = new AbortController();
    const reader = events(live, new Request('http://localhost/api/now', { signal: controller.signal }), () => nowSnapshot(live)).body!.getReader();

    const first = data(await chunk(reader));
    expect(isNow(first)).toBe(true);
    expect(await chunk(reader)).toMatch(/^event: limits\n/);

    live.db.prepare("UPDATE cards SET state = 'blocked' WHERE key = 'APP-1'").run();
    createCard(live.db, { key: 'APP-2', board: 'investigations', stage: 'inbox', title: 'Why is the list slow?' });
    live.changed();
    const next = data(await chunk(reader)) as NowSnapshot;
    expect(next.boards.flatMap((board) => board.cards.map((one) => one.key))).toEqual(['APP-1', 'APP-2']);
    expect(waitingCount(next)).toBe(1);
    await reader.cancel();
  });

  // The usage readings ride beside the snapshot and never in it, and stay on this machine.
  // A profile goes in by its name alone, with no folder.
  it('carries no usage reading and no profile folder in the snapshot, only in the limits event', async () => {
    const reading = { seenAt: NOON.getTime(), windows: [{ name: 'five_hour', used: 0.62, resetsAt: null, status: 'allowed' }] };
    writeSetting(live.db, 'engineLimits', { 'claude-code': reading });
    const controller = new AbortController();
    const reader = events(live, new Request('http://localhost/api/now', { signal: controller.signal }), () => nowSnapshot(live)).body!.getReader();

    const first = await chunk(reader);
    expect(first).not.toContain('five_hour');
    expect(first).not.toContain('seenAt');
    expect(Object.keys(data(first) as object).sort()).toEqual(['boards', 'chain', 'done', 'ended', 'firstRun', 'knowledgePending', 'notifications', 'profiles', 'qaAsks', 'qaSetup', 'running', 'scout', 'setup', 'today', 'version', 'waiting']);
    expect((data(first) as NowSnapshot).profiles).toEqual([{ id: 'claude-code', label: 'Claude Code', silent: false }]);
    expect(data(await chunk(reader))).toEqual({ 'claude-code': reading });
    await reader.cancel();
  });

  it('is the route at /api/now', () => {
    expect(readFileSync(join(import.meta.dirname, 'api/now/+server.ts'), 'utf8')).toContain('return events(live, request, () => ({ ...nowSnapshot(live), project: current, ...(switched() ? { switched: true } : {}) }));');
  });
});

// The Running rows share one grid, which scrolls in its own panel when the main column is narrower than
// the grid's least width, and then Stop sits out of view. So the right column goes under the main one
// below the width where a row still fits beside it, with a 16px scroll bar taken off the window. Past
// that width the main column only grows. A render carries no CSS, so this reads the rules.
describe('the Running row', () => {
  const style = (file: string) => (/<style>([\s\S]*)<\/style>/.exec(readFileSync(join(import.meta.dirname, file), 'utf8'))?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const now = style('../lib/NowPage.svelte');
  const tokens = readFileSync(join(import.meta.dirname, '../../../../packages/ui/src/tokens.css'), 'utf8');
  const space = (n: string) => Number(new RegExp(`--space-${n}: (\\d+)px;`).exec(tokens)![1]);
  const rule = (css: string, selector: string) => new RegExp(`\\n  ${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

  const runs = rule(now, '.runs');
  const tracks = [...(/grid-template-columns: ([^;]+);/.exec(runs)?.[1] ?? '').matchAll(/calc\((\d+)px \+ var\(--space-(\d)\)\)|minmax\((\d+)px, [^)]+\)|(\d+)px/g)];
  const gap = space(/column-gap: var\(--space-(\d)\);/.exec(runs)![1]!);
  // The panel's border, a pixel each side.
  const least = tracks.reduce((sum, [, calc, step, min, fixed]) => sum + (calc === undefined ? Number(min ?? fixed) : Number(calc) + space(step!)), 0) + (tracks.length - 1) * gap + 2;

  const page = rule(now, '.page');
  const [aside, between, side] = [Number(/minmax\(0, 1fr\) (\d+)px;/.exec(page)![1]), Number(/gap: (\d+)px;/.exec(page)![1]), Number(/padding: \d+px (\d+)px/.exec(page)![1])];
  const breakpoint = Number(/@media \(max-width: (\d+)px\) \{\s*\.page \{\s*grid-template-columns: minmax\(0, 1fr\);/.exec(now)![1]);
  const rail = Number(/width: (\d+)px;/.exec(rule(style('../lib/Rail.svelte'), '.rail'))![1]);
  const main = (width: number) => width - 16 - rail - 2 * side - (width > breakpoint ? between + aside : 0);

  it('reads six columns and the page around them', () => {
    expect(tracks).toHaveLength(6);
    expect(least).toBeGreaterThan(600);
    expect([aside, rail]).toEqual([300, 232]);
  });

  it.each([1280, 1366, 1440, breakpoint + 1])('fits with its Stop button in view at %ipx', (width) => {
    expect(main(width)).toBeGreaterThanOrEqual(least);
  });
});

// Now took `/`. Every link that meant the board at `/` goes to the board's own address.
describe('the board links', () => {
  const app = join(import.meta.dirname, '..');
  const read = (file: string) => readFileSync(join(app, file), 'utf8');

  it('draws Now at the root, and no board', () => {
    expect(read('routes/+page.svelte')).toContain('<NowPage stream={nowLive.state} />');
    expect(read('routes/+page.svelte')).not.toContain('BoardPage');
  });

  it('sends the card page breadcrumb, New project and G then D to a board address', () => {
    // A question or an investigation goes back to Research, the one place the rail lists for it.
    expect(read('routes/t/[key]/+layout.svelte')).toContain('const crumb = $derived(choiceOf(data.ticket.board));');
    expect(read('routes/t/[key]/+layout.svelte')).toContain(`<a class="crumb" href={crumb === 'research' ? resolve('/b/research') : resolve('/b/[board]', { board: crumb })} data-back>`);
    expect(read('routes/new/task/+page.server.ts')).toContain('redirect(303, `/b/${made.board}`);');
    expect(read('routes/+layout.svelte')).toContain("'go:delivery': () => void goto(resolve('/b/[board]', { board: 'delivery' })),");
    // Research is one rail item over its two kinds, at its own address.
    expect(read('lib/Rail.svelte')).toContain("const boardHref = (kind: BoardChoice) => (kind === 'research' ? resolve('/b/research') : resolve('/b/[board]', { board: kind }));");
  });

  // The root is Now's: its rail link, its G chord, the selector's pick that opens the picked project's Now, Scout and Evidence
  // while they wait for a later version, and nothing else.
  it('links the root only as Now', () => {
    const files = readdirSync(app, { recursive: true, encoding: 'utf8' }).filter((file) => /\.(svelte|ts)$/.test(file) && !file.endsWith('.test.ts'));
    const root = files.flatMap((file) => [...read(file).matchAll(/[^\n]*(?:resolve\('\/'\)|redirect\(\d+, '\/'\)|href="\/")[^\n]*/g)].map((line) => `${file}: ${line[0].trim()}`));

    expect(root).toEqual([
      "hooks.server.ts: if (!SCOUT_AND_EVIDENCE && /^\\/(scout|evidence)(\\/|$)/.test(path)) redirect(303, '/');",
      "lib/Rail.svelte: <a href={resolve('/')} aria-current={routeId === '/' ? 'page' : undefined} aria-label={compact ? nowName : undefined}>",
      "routes/+layout.svelte: if (nowLive.state.snapshot?.switched === true) location.assign(resolve('/'));",
      "routes/+layout.svelte: 'go:now': () => void goto(resolve('/')),",
      "routes/new/+page.svelte: <a class=\"home\" href={resolve('/')} aria-label=\"Back to Now\">{@render logo()}</a>",
      "routes/team/+page.ts: if (!CLOUD_OPEN) redirect(303, '/');",
      "routes/api/current-project/+server.ts: redirect(303, '/');",
    ]);
  });
});
