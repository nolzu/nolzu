import type { RunEvent } from '@nolzu/protocol';
import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { cardFixture } from '../board/fixture.ts';
import LogTab from './LogTab.svelte';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const RUNS = [
  { id: 5, phase: 'plan', state: 'running', startedAt: '2026-09-22T10:00:00.000Z' },
  { id: 3, phase: 'refine', state: 'complete', startedAt: '2026-09-22T09:00:00.000Z' },
];
const EVENTS: RunEvent[] = [
  { type: 'text', text: 'Reading the list.' },
  { type: 'tool', name: 'Read', input: { file_path: 'src/list.ts' } },
];
const draw = (over: Record<string, unknown> = {}) =>
  render(LogTab, { props: { runs: RUNS, selected: 5, events: EVENTS, runHref: (id: number) => `?run=${id}`, rawHref: '/api/card/APP-1/log/raw?run=5', ...over } }).body;

it('offers every run of the card as a link, and marks the one shown', () => {
  const body = draw();

  expect(body).toMatch(/<a[^>]*href="\?run=5"[^>]*aria-current="true"/);
  expect(body).toMatch(/<a[^>]*href="\?run=3"/);
  expect(text(body)).toContain('Refine');
  // The shown row's own class, never `on`, which is the mono line of what the run ran on.
  expect(body).toMatch(/<li class="run[^"]*\bcurrent\b[^"]*">(?:(?!<\/li>)[\s\S])*href="\?run=5"/);
  expect(body).not.toMatch(/<li class="run[^"]*\bon\b/);
});

it('draws the rows, with the tool input folded away under its name', () => {
  const body = draw();

  expect(text(body)).toContain('Reading the list.');
  expect(body).toMatch(/<details[^>]*><summary[^>]*>Read<\/summary>/);
  expect(body).not.toMatch(/<details[^>]*open/);
});

it('offers the raw file for download', () => {
  expect(draw()).toMatch(/<a[^>]*href="\/api\/card\/APP-1\/log\/raw\?run=5"[^>]*download/);
});

it('says so when the card has no run yet', () => {
  expect(text(draw({ runs: [], selected: null, events: [] }))).toContain('No runs yet');
});

// A run stopped in a retry wait writes no later line, so the tab reads the run's state to end the count.
it('counts a retry wait down only while its run has not ended', () => {
  const wait: RunEvent = { type: 'api_retry', attempt: 1, delayMs: 60_000, status: 529, maxRetries: 3, reason: 'API Error: 529 Overloaded', until: Date.now() + 60_000 };

  expect(text(draw({ events: [wait] }))).toMatch(/retrying in \d/);
  expect(text(draw({ events: [wait], runs: [{ ...RUNS[0], state: 'stopped' }] }))).toContain('stopped waiting to try again');
});

// The row of one kind, as the tab draws it: the time column, the word in the kind column, then what
// happened, then a figure at the edge.
const rowOf = (body: string, kind: string) => text(new RegExp(`<li[^>]*data-kind="${kind}"[^>]*>([\\s\\S]*?)</li>`).exec(body)?.[1] ?? '');

describe('one row per kind, with a time column and a kind column', () => {
  it.each<[string, RunEvent, string]>([
    ['session', { type: 'session', sessionId: '3e9b71d0', model: 'sonnet', apiKeyMode: false }, 'session Session 3e9b71d0 on sonnet'],
    ['text', { type: 'text', text: 'I will read how RecipeCard picks its image.' }, 'assistant I will read how RecipeCard picks its image.'],
    ['tool', { type: 'tool', name: 'Read', input: { file_path: 'web/src/lib/RecipeCard.svelte' } }, 'tool call Read { "file_path": "web/src/lib/RecipeCard.svelte" }'],
    ['result', { type: 'tool_result', bytes: 2970, error: false, lines: 84 }, 'result 84 lines 2.9 KB'],
    ['usage', { type: 'usage', id: 'msg_1', tokens: { input: 400, output: 18_000, cacheRead: 0, cacheCreation: 0 } }, 'tokens 18.4k tokens so far'],
    ['limit', { type: 'rate_limit', windows: [{ name: 'five_hour', used: 0.62, resetsAt: null, status: 'allowed' }] }, 'limit 5-hour limit 62% used, no reset time reported'],
    ['question', { type: 'needs_input', question: 'Titles only?' }, 'asks Asked: Titles only?'],
    ['denied', { type: 'permission_denied', denied: [{ tool: 'Write', id: null, path: 'src/list.ts' }] }, 'refused Refused: Write on src/list.ts'],
    ['complete', { type: 'complete', costUsd: 0.04, durationMs: 18_000, tokens: null }, 'done Done in 18s, $0.04 estimated'],
    ['failed', { type: 'failed', reason: 'The run went quiet.', status: null }, 'failed Failed: The run went quiet.'],
  ])('draws a %s row', (kind, event, said) => {
    expect(rowOf(draw({ events: [event] }), kind)).toBe(said);
  });

  it('draws the retry wait as a plain row naming the attempt', () => {
    const wait: RunEvent = { type: 'api_retry', attempt: 2, delayMs: 60_000, status: 529, maxRetries: 3, reason: 'API Error: 529 Overloaded', until: Date.now() + 60_000 };

    expect(rowOf(draw({ events: [wait] }), 'retry')).toMatch(/^retry API Error: 529 Overloaded, retrying in .+, attempt 2 of 3, status 529$/);
  });

  // The marker is for the runner. The done row below says the run ended.
  it('draws a says row without the closing marker', () => {
    const body = draw({ events: [{ type: 'text', text: '## What changed\n\nThe card shows a placeholder.\n\nNOLZU: complete' }] });

    expect(rowOf(body, 'text')).toBe('assistant ## What changed The card shows a placeholder.');
    expect(body).not.toContain('NOLZU');
  });

  // The runner notes the time in front of the lines, and the route sends it with each event as `at`.
  it('says how far into the run each line came', () => {
    const started = Date.parse('2026-09-22T10:00:00.000Z');
    const events = [
      { type: 'text', text: 'One.', at: started + 4_000 },
      { type: 'tool_result', bytes: 120, error: false, lines: 3, at: started + 131_000 },
    ];
    const body = draw({ events });

    expect(rowOf(body, 'text')).toBe('0:04 assistant One.');
    expect(rowOf(body, 'result')).toBe('2:11 result 3 lines 120 B');
  });

  it('leaves the time column empty for a log written before the runner noted times', () => {
    expect(rowOf(draw({ events: [{ type: 'text', text: 'One.' }] }), 'text')).toBe('assistant One.');
  });

  // The route reads what the tool acted on, so the row says it beside the name, folded input or not.
  it('says the tool subject inline, beside its name', () => {
    const body = draw({ events: [{ type: 'tool', name: 'Read', input: { file_path: 'web/src/lib/RecipeCard.svelte' }, subject: 'web/src/lib/RecipeCard.svelte' }] });

    expect(body).toMatch(/<summary[^>]*>Read {2}web\/src\/lib\/RecipeCard\.svelte<\/summary>/);
  });
});

describe('the run list', () => {
  it('names each run by its phase, and an Ask run reads Ask', () => {
    const body = text(draw({ runs: [{ id: 9, phase: 'ask', state: 'complete', startedAt: null }, ...RUNS] }));

    expect(body).toContain('Ask');
    expect(body).toContain('Plan');
    expect(body).not.toMatch(/\bask\b/);
  });

  // A done run has a check, the live one an amber dot beside its link. The dot is not on the link:
  // amber on a control means a press that starts work.
  it('marks a done run with a check and the live one with a dot and the word running', () => {
    const body = draw();
    const row = (id: number) => new RegExp(`<li class="run[^"]*">((?:(?!<li).)*?href="\\?run=${id}"[\\s\\S]*?)</a>`).exec(body)?.[1] ?? '';

    expect(row(3)).toMatch(/<svg class="ok[^"]*"/);
    expect(row(3)).not.toContain('class="live');
    expect(text(row(3))).toContain('done');
    expect(row(5)).toMatch(/<span class="live[^"]*" aria-hidden="true"><\/span>(?:<!--[^>]*-->)*<a/);
    expect(text(row(5))).toContain('running');
    expect(row(5)).not.toMatch(/<svg class="ok/);
  });

  it('lists the newest run on top', () => {
    const body = draw();

    expect(body.indexOf('href="?run=5"')).toBeLessThan(body.indexOf('href="?run=3"'));
  });

  // The phase is the heading over its runs, so a screen reader hears it in the link instead.
  it('puts runs of one phase in a row under one heading, and numbers a phase that ran more than once', () => {
    const runs = [
      { id: 7, phase: 'plan', state: 'failed', startedAt: null },
      { id: 6, phase: 'plan', state: 'stopped', startedAt: null },
      { id: 3, phase: 'refine', state: 'complete', startedAt: null },
    ];
    const body = draw({ runs, selected: 7 });
    const headings = [...body.matchAll(/<span class="phase[^"]*"[^>]*>([^<]*)<\/span>/g)].map((match) => match[1]);
    const link = (id: number) => text(new RegExp(`<a href="\\?run=${id}"[\\s\\S]*?</a>`).exec(body)?.[0] ?? '');

    expect(headings).toEqual(['Plan', 'Refine']);
    expect(link(7)).toBe('Plan Attempt 2 failed');
    expect(link(6)).toBe('Plan Attempt 1 stopped');
    expect(link(3)).toBe('Refine done');
    expect(body).toMatch(/<option value="7"[^>]*>Plan · Attempt 2 · failed<\/option>/);
  });

  it('says when each run started as a time ago, with the full date and time on hover', () => {
    const body = draw();

    expect(body).toMatch(/<time datetime="2026-09-22T09:00:00.000Z" title="[^"]*2026[^"]*">[^<]*ago<\/time>/);
  });

  // A narrow screen has no room for the list beside the log, so the same runs sit in one select above it.
  it('offers the runs in a select too, for a narrow screen, with the shown one picked', () => {
    const body = draw();
    const options = [...body.matchAll(/<option value="(\d+)"([^>]*)>([^<]*)<\/option>/g)].map((match) => [match[1], match[2]!.includes('selected'), match[3]!.trim()]);

    expect(body).toMatch(/<form[^>]*method="get"[^>]*data-sveltekit-keepfocus[\s\S]*?<select[^>]*name="run"/);
    expect(options.map(([id, picked]) => [id, picked])).toEqual([
      ['5', true],
      ['3', false],
    ]);
    expect(options[1]![2]).toMatch(/^Refine · done · .+ ago$/);
  });

  it('says what the run runs on, and when it started', () => {
    expect(text(draw({ runs: [{ ...RUNS[0], engine: 'claude-code', model: 'sonnet', effort: 'high', started: '14:51' }] }))).toContain('Claude Code · sonnet · high · started 14:51');
    expect(text(draw({ runs: [{ ...RUNS[0], engine: 'claude-code', model: 'sonnet', effort: 'high', started: null }] }))).not.toContain('started');
  });

  // Cursor reads the effort off the model id, so the line names none, as the board does.
  it('names no effort for a run on an engine that reads it off the model id', () => {
    expect(text(draw({ runs: [{ ...RUNS[0], engine: 'cursor', model: 'gpt-5.3-codex', effort: 'medium', started: '14:51' }] }))).toContain('Cursor · gpt-5.3-codex · started 14:51');
  });

  // The wall that held the run goes beside the engine. A row made before the wall column says none.
  it('says the wall that held the run, and nothing on an old row', () => {
    const on = (wall: string | null) => text(draw({ runs: [{ ...RUNS[0], engine: 'codex', model: 'gpt-5.6', effort: 'high', wall, started: '14:51' }] }));

    expect(on('codex')).toContain('Codex · gpt-5.6 · high · Codex sandbox · started 14:51');
    expect(on('macos')).toContain('Codex · gpt-5.6 · high · walled by macOS · started 14:51');
    expect(on('none')).toContain('Codex · gpt-5.6 · high · not walled · started 14:51');
    expect(on(null)).toContain('Codex · gpt-5.6 · high · started 14:51');
  });
});

describe('the footer', () => {
  const RUNNING = cardFixture({ key: 'APP-1', stage: 'plan', state: 'running', runId: 5 });

  it('shows Stop while the shown run goes', () => {
    expect(draw({ card: RUNNING })).toMatch(/<button[^>]*data-run="stop"[^>]*>[\s\S]*?Stop/);
  });

  it('shows no Stop once the run has ended', () => {
    const body = draw({ card: { ...RUNNING, state: 'ready', runId: null }, runs: [{ ...RUNS[0], state: 'complete' }, RUNS[1]] });

    expect(body).not.toContain('data-run="stop"');
  });

  // Stop ends the card's own run. An older run, or an Ask run beside it, has nothing to stop.
  it('shows no Stop on a run that is not the one the card runs now', () => {
    expect(draw({ card: RUNNING, selected: 3 })).not.toContain('data-run="stop"');
  });

  it('shows no Stop with no board to read the card from', () => {
    expect(draw({ card: null })).not.toContain('data-run="stop"');
  });

  it('shows the elapsed time, and the tokens and cost only where reported', () => {
    const done = { ...RUNS[1], startedAt: '2026-09-22T09:00:00.000Z', endedAt: '2026-09-22T09:00:22.000Z', costUsd: 0.02, tokens: 7800 };
    const body = text(draw({ runs: [done], selected: 3, events: [] }));

    expect(body).toContain('0m 22s elapsed');
    expect(body).toContain('7.8k tokens');
    expect(body).toContain('$0.02 estimated cost');
    expect(text(draw({ events: [] }))).not.toContain('estimated cost');
  });

  // While the run goes, the tokens so far come off its own usage lines, and the cost waits for the end.
  it('shows the tokens so far while the run goes, where the engine reports usage, and no cost yet', () => {
    const body = text(draw({ events: [{ type: 'usage', id: 'msg_1', tokens: { input: 400, output: 18_000, cacheRead: 0, cacheCreation: 0 } }] }));

    expect(body).toContain('18.4k tokens');
    expect(body).not.toContain('estimated cost');
  });

  it('keeps the Cmd period cap on Stop', () => {
    expect(draw({ card: RUNNING })).toMatch(/<button[^>]*data-run="stop"[^>]*>[\s\S]*?⌘\./);
  });
});

// The run list sticks under the card page's sticky head, which sets --thead-height.
it('sticks the run list under the card page head', () => {
  const component = readFileSync(new URL('./LogTab.svelte', import.meta.url), 'utf8');

  expect(/\n {2}\.runs \{([^}]*)\}/.exec(component)?.[1]).toContain('top: calc(var(--thead-height, 0px) + var(--space-3));');
});
