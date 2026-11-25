import { type Segment, spendOf, type StripRun } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import PhaseStrip from './PhaseStrip.svelte';

// Svelte's markers are no space in the browser, so they are dropped before the tags read as one.
const text = (body: string) => body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// The page's clock. Every time on the trail is drawn as a time ago from it.
const NOW = new Date('2026-10-20T16:00:00.000Z');
const run = (id: number, phase: string, over: Partial<StripRun> = {}): StripRun => ({
  id,
  phase,
  state: 'complete',
  model: 'sonnet',
  effort: 'low',
  costUsd: 0.12,
  durationMs: 64_000,
  tokens: { input: 10_000, output: 4_200, cacheRead: 0, cacheCreation: 0 },
  question: null,
  ...over,
});
// The strip core builds for these runs: every phase in board order, the newest run of each. Built here
// by hand, because this package reads only the protocol.
const PHASES: readonly [string, string][] = [
  ['refine', 'Refine'],
  ['plan', 'Plan'],
  ['implement', 'Implement'],
  ['qa', 'QA'],
  ['wrapup', 'Wrap-up'],
];
const strip = (runs: StripRun[]): Segment[] =>
  PHASES.map(([phase, label]) => {
    const mine = runs.filter((one) => one.phase === phase).sort((a, b) => b.id - a.id);
    return { phase, label, run: mine[0] ?? null, count: mine.length, spend: spendOf(mine) };
  });
const draw = (runs: StripRun[]) => render(PhaseStrip, { props: { strip: strip(runs), spend: spendOf(runs), logBase: '/t/APP-1/log' } }).body;
const segment = (body: string, phase: string) => new RegExp(`data-phase="${phase}"[\\s\\S]*?</li>`).exec(body)?.[0] ?? '';

it('draws one segment per phase, in board order', () => {
  expect([...draw([]).matchAll(/data-phase="([^"]+)"/g)].map((match) => match[1])).toEqual(['refine', 'plan', 'implement', 'qa', 'wrapup']);
});

// The segment used to be headed with the stage id, so an idle Investigations card read "running" over
// "not run yet". The heading and the log link both take the label the board gives the stage.
it('heads a segment with the stage label and not its id', () => {
  expect(text(draw([]))).toContain('Wrap-up writes what it learned');
});

it('shows a finished run on one detail line, its tokens in the title, and a link to its log', () => {
  const refine = segment(draw([run(7, 'refine')]), 'refine');

  expect(text(refine)).toContain('sonnet · low · 1m 04s · $0.12 estimated');
  expect(refine).toContain('title="14.2k tok: 10k in');
  expect(refine).toMatch(/<a[^>]*href="\/t\/APP-1\/log\?run=7"/);
});

// Cursor reads the effort off the model id, so the trail names none, not even "no effort".
it('names no effort for a run on an engine that reads it off the model id', () => {
  const refine = segment(draw([run(7, 'refine', { engine: 'cursor', model: 'gpt-5.3-codex', effort: 'medium' })]), 'refine');

  expect(text(refine)).toContain('Cursor · gpt-5.3-codex · 1m 04s');
});

// A QA FAIL ends as a complete run. The trail says failed in red, and not done.
it('draws a QA run that failed as failed, not done', () => {
  const qa = segment(draw([run(4, 'qa', { verdict: 'FAIL' })]), 'qa');

  expect(qa).toContain('data-state="failed"');
  expect(text(qa)).toContain('FAIL');
  expect(text(qa)).not.toContain('done');
});

it('says what a phase that has not run will do, and offers no log', () => {
  const qa = segment(draw([]), 'qa');

  expect(text(qa)).toContain('> QA runs the checks the plan wrote');
  expect(qa).not.toContain('<a');
});

it('marks a phase that ran more than once', () => {
  expect(text(segment(draw([run(2, 'plan'), run(5, 'plan')]), 'plan'))).toContain('ran 2 times');
});

it('says a running phase has no cost yet, never $0.00', () => {
  const plan = text(segment(draw([run(3, 'plan', { state: 'running', costUsd: null, durationMs: null, tokens: null })]), 'plan'));

  expect(plan).toContain('running');
  expect(plan).toContain('no cost yet');
  expect(plan).not.toContain('$0.00');
});

// Codex reports token counts and no cost and no time. On a finished run "no cost yet" would read as
// a number still on its way, and a total of "0s" would say a card that ran for minutes took none.
it('leaves out a cost and a time the engine never reported', () => {
  const body = draw([run(3, 'plan', { costUsd: null, durationMs: null })]);

  expect(text(segment(body, 'plan'))).not.toContain('no cost yet');
  // What the run did report is still there.
  expect(text(segment(body, 'plan'))).toContain('14.2k tok');
  expect(text(body)).not.toContain('Total so far');
  expect(text(body)).not.toContain('0s');
});

// No footer sentence. Each cost, and the total, is marked as an estimate where it stands.
it('marks each cost and the total as estimated, with no footer sentence', () => {
  const body = draw([run(1, 'refine'), run(2, 'plan')]);

  expect(text(body)).not.toContain('estimated values');
  expect(body.match(/title="Estimated value"/g)).toHaveLength(3);
});

it('adds up the cost and the time of the runs shown', () => {
  expect(text(draw([run(1, 'refine'), run(2, 'plan', { costUsd: 0.71, durationMs: 220_000 })]))).toContain('Total so far $0.83 estimated · 4m 44s');
});

it('marks nothing on a phase that ran once', () => {
  expect(text(segment(draw([run(2, 'plan')]), 'plan'))).not.toContain('ran');
});

it('says a phase that ended on a question asked one, and marks it as the board marks blocked', () => {
  const plan = segment(draw([run(2, 'plan', { question: 'Titles only?' })]), 'plan');

  expect(text(plan)).toContain('asked a question');
  expect(text(plan)).not.toContain('asked you');
  expect(plan).toContain('data-asked="true"');
});

// A card moved on from an old question waits on nothing there, even while a newer phase asks.
it('says asked you only on the newest phase, and asked a question on an older one', () => {
  const runs = [run(1, 'refine', { question: 'Titles only?' }), run(2, 'plan', { question: 'Stars or thumbs?' })];
  const body = render(PhaseStrip, { props: { strip: strip(runs), spend: spendOf(runs), logBase: '/t/APP-1/log', since: '2026-10-20T15:02:00.000Z', now: NOW } }).body;

  expect(text(segment(body, 'refine'))).toContain('asked a question');
  expect(text(segment(body, 'refine'))).not.toContain('asked you');
  expect(text(segment(body, 'plan'))).toContain('asked you 58 minutes ago');
});

it('counts input and output as the tokens, and names the cache reads in the title', () => {
  const refine = segment(draw([run(7, 'refine', { tokens: { input: 1_000, output: 400, cacheRead: 900_000, cacheCreation: 5_000 } })]), 'refine');

  expect(refine).toContain('title="1.4k tok: 1k in · 400 out · 900k cache read · 5k cache written"');
});

// A card with a Claude Code run and a Codex run. The figure covers one of the two, and without the
// count it reads as the whole bill.
it('says the total covers only some of the runs, and why the other has no cost', () => {
  const body = text(draw([run(1, 'refine'), run(2, 'plan', { costUsd: null, durationMs: null })]));

  // The coverage is its own sentence under the list, because the time in the heading covers both runs
  // and the cost does not.
  expect(body).toContain('Total so far $0.12 estimated · 1m 04s · 28.4k tok');
  expect(body).toContain('The cost covers 1 of 2 runs.');
  expect(body).toContain('1 of those runs reports tokens only, no cost reported.');
});

// The time is the sum over both runs while the cost is one run's, so the coverage sentence must not
// reach the time. A cost-less run that does report a duration is the case that shows it.
it('keeps the coverage off the time when a run reports a duration and no cost', () => {
  const body = text(draw([run(1, 'refine'), run(2, 'plan', { costUsd: null, durationMs: 200_000 })]));

  expect(body).toContain('Total so far $0.12 estimated · 4m 24s · 28.4k tok');
  expect(body).toContain('The cost covers 1 of 2 runs.');
});

// Nothing reported a cost, so there is no figure for a coverage clause to qualify and no "them" to
// point at. The sentence names the runs instead.
it('says no cost was reported when no run reported one', () => {
  const body = text(draw([run(1, 'refine', { costUsd: null, durationMs: 200_000 })]));

  expect(body).toContain('No cost reported for 1 run.');
  expect(body).not.toContain('tokens only');
});

// A run that ended will never report a cost it has not reported, so its line does not say "yet".
it('says no cost yet only while a run may still report one', () => {
  expect(text(draw([run(1, 'refine', { state: 'running', costUsd: null, tokens: null })]))).toContain('no cost yet');
  expect(text(draw([run(1, 'refine', { state: 'failed', costUsd: null, tokens: null })]))).not.toContain('no cost yet');
});

// A run still going has reported no counts either, and there the cost is on its way.
it('leaves out the tokens-only reason while a phase is still running', () => {
  const body = text(draw([run(1, 'refine'), run(2, 'plan', { state: 'running', costUsd: null, durationMs: null, tokens: null })]));

  expect(body).toContain('The cost covers 1 of 2 runs.');
  expect(body).not.toContain('tokens only');
});

// Svelte drops the space at the start of an element and of a block, so these read "$0.12estimated",
// "logof the Plan run" and "Plan· ran 2 times". text() turns every tag into a space and cannot see it,
// so this reads the raw markup.
it('keeps the space before a hidden word and before the run count', () => {
  const raw = segment(draw([run(2, 'plan'), run(5, 'plan')]), 'plan').replaceAll(/<!--[\s\S]*?-->/g, '');

  expect(raw).toMatch(/\$0\.12 <span class="hidden[^"]*">estimated<\/span>/);
  expect(raw).toContain('sonnet · low · 1m 04s · <span');
  expect(raw).toMatch(/>log <span class="hidden[^"]*">of the Plan run<\/span>/);
  expect(raw).toMatch(/>Plan <span class="quiet[^"]*">· ran 2 times<\/span>/);
});

// The trail: the total beside the heading, who moved the card into each phase and
// when, and what each phase still to run will do.
it('puts the total beside the heading, with the tokens after the cost and the time', () => {
  const body = draw([run(1, 'refine'), run(2, 'plan', { costUsd: 0.71, durationMs: 220_000 })]);
  const head = /<div class="head[^"]*">[\s\S]*?<\/div>/.exec(body)?.[0] ?? '';

  expect(text(head)).toBe('Trail Total so far $0.83 estimated · 4m 44s · 28.4k tok');
});

it('names who moved the card into a phase and when, from the newest move that started it', () => {
  const moves = [
    { said: 'moved by you', at: '2026-10-18T09:58:00.000Z', phase: 'refine' },
    { said: 'moved by Nolzu', at: '2026-10-19T10:02:00.000Z', phase: null },
    { said: 'moved by you', at: '2026-10-20T10:10:00.000Z', phase: 'refine' },
  ];
  const body = render(PhaseStrip, { props: { strip: strip([run(1, 'refine'), run(2, 'plan')]), spend: spendOf([]), logBase: '/t/APP-1/log', moves, now: NOW } }).body;

  expect(text(segment(body, 'refine'))).toContain('moved by you, 5 hours ago');
  expect(segment(body, 'refine')).toContain('<time datetime="2026-10-20T10:10:00.000Z" title="Tuesday, 20 October 2026 at 10:10">5 hours ago</time>');
  expect(text(segment(body, 'refine'))).not.toContain('2 days ago');
  // No move started Plan, so its segment names no mover rather than a made-up one.
  expect(segment(body, 'plan')).not.toContain('data-moved');
});

it('says what each phase that has not run will do', () => {
  const body = draw([run(1, 'refine')]);

  expect(text(segment(body, 'qa'))).toContain('> QA runs the checks the plan wrote');
  expect(text(segment(body, 'wrapup'))).toContain('writes what it learned');
  expect(text(segment(body, 'refine'))).not.toContain('rewrites the ticket');
});

// The reason a QA FAIL went on anyway shows under QA, with who moved it and when.
it('shows why a QA FAIL went on anyway under the QA phase', () => {
  const moves = [
    { said: 'moved by Nolzu', at: '2026-10-20T15:38:00.000Z', phase: 'qa' },
    { said: 'moved by you', at: '2026-10-20T15:44:00.000Z', phase: null, from: 'qa', reason: 'The empty list is fine until the api has a status page.' },
  ];
  const runs = [run(1, 'implement'), run(2, 'qa', { verdict: 'FAIL' })];
  const body = render(PhaseStrip, { props: { strip: strip(runs), spend: spendOf(runs), logBase: '/t/APP-1/log', moves, now: NOW } }).body;

  expect(text(segment(body, 'qa'))).toContain('moved by Nolzu, 22 minutes ago Accepted anyway, moved by you, 16 minutes ago The empty list is fine until the api has a status page.');
  expect(segment(body, 'implement')).not.toContain('data-reason');
});

// A note on a move back out of a phase is a send back, and reads as one under that phase.
it('shows a send back note under the phase the card left', () => {
  const moves = [{ said: 'moved by you', at: '2026-10-20T15:44:00.000Z', phase: null, from: 'qa', reason: 'Rename the button to Save recipe.', back: true }];
  const runs = [run(1, 'implement'), run(2, 'qa')];
  const body = render(PhaseStrip, { props: { strip: strip(runs), spend: spendOf(runs), logBase: '/t/APP-1/log', moves, now: NOW } }).body;

  expect(text(segment(body, 'qa'))).toContain('Sent back, moved by you, 16 minutes ago Rename the button to Save recipe.');
  expect(text(segment(body, 'qa'))).not.toContain('Accepted anyway');
});

// The marks and lines of the trail.
it('draws a done phase as a check in a soft green circle', () => {
  const refine = segment(draw([run(1, 'refine')]), 'refine');

  expect(refine).toContain('data-mark="done"');
  expect(refine).toMatch(/class="dot[^"]*"[^>]*>(<!--[^>]*-->)?\s*<svg/);
  expect(text(refine)).toContain('done');
});

it('marks the step after a done phase as waiting for the person, and only that one', () => {
  const body = draw([run(1, 'refine'), run(2, 'plan')]);

  expect(segment(body, 'implement')).toContain('data-mark="next"');
  expect(text(segment(body, 'implement'))).toContain('> Implement waits for your approval');
  expect(segment(body, 'qa')).toContain('data-mark="none"');
  expect(text(body).match(/waits for your approval/g)).toHaveLength(1);
});

it('marks no step as waiting while a phase still runs, asks or failed', () => {
  expect(text(draw([run(1, 'refine', { state: 'running', costUsd: null })]))).not.toContain('waits for your approval');
  expect(text(draw([run(1, 'refine', { question: 'Titles only?' })]))).not.toContain('waits for your approval');
  expect(text(draw([run(1, 'qa', { verdict: 'FAIL' })]))).not.toContain('waits for your approval');
});

it('says since when an asking phase waits, as a violet ring with a question mark', () => {
  const runs = [run(1, 'refine'), run(2, 'plan', { question: 'Stars or thumbs?' })];
  const plan = segment(render(PhaseStrip, { props: { strip: strip(runs), spend: spendOf(runs), logBase: '/t/APP-1/log', since: '2026-10-19T15:02:00.000Z', now: NOW } }).body, 'plan');

  expect(plan).toContain('data-mark="asked"');
  expect(text(plan)).toContain('asked you yesterday');
  expect(text(plan)).not.toContain('asked a question');
});

it('says a QA FAIL with its reason and the time it ended, as a red ring with an x', () => {
  const runs = [run(1, 'implement'), run(2, 'qa', { verdict: 'FAIL', verdictReason: 'empty list', endedAt: '2026-10-20T15:40:00.000Z' })];
  const qa = segment(render(PhaseStrip, { props: { strip: strip(runs), spend: spendOf(runs), logBase: '/t/APP-1/log', now: NOW } }).body, 'qa');

  expect(qa).toContain('data-mark="failed"');
  expect(qa).toMatch(/class="dot[^"]*"[^>]*>(<!--[^>]*-->)?\s*<svg/);
  expect(text(qa)).toContain('FAIL, empty list, 20 minutes ago');
});

it('says FAIL alone when the run gave no reason and no time', () => {
  expect(text(segment(draw([run(2, 'qa', { verdict: 'FAIL' })]), 'qa'))).toContain('FAIL');
});

// One model can run on two engines, so the trail names the engine, and the wall that held the run. A
// row made before the wall column says no wall.
it('names the engine and the wall of a run on its detail line', () => {
  const walled = segment(draw([run(7, 'refine', { engine: 'cursor', wall: 'macos' })]), 'refine');
  const codex = segment(draw([run(7, 'refine', { engine: 'codex#work', wall: 'codex' })]), 'refine');
  const open = segment(draw([run(7, 'refine', { engine: 'claude-code', wall: 'none' })]), 'refine');
  const old = segment(draw([run(7, 'refine', { engine: 'claude-code', wall: null })]), 'refine');

  expect(text(walled)).toContain('Cursor · sonnet · walled by macOS · 1m 04s');
  expect(text(codex)).toContain('Codex · sonnet · low · Codex sandbox · 1m 04s');
  expect(text(open)).toContain('Claude Code · sonnet · low · not walled · 1m 04s');
  expect(text(old)).toContain('Claude Code · sonnet · low · 1m 04s');
});
