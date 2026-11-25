import { readFileSync } from 'node:fs';
import { type Segment, spendOf, type StripRun } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { cardFixture } from './fixture.ts';
import type { PeekView } from './peek.ts';
import PeekSheet from './PeekSheet.svelte';

const NOW = new Date('2026-10-14T14:03:10Z');
const run = (id: number, phase: string, over: Partial<StripRun> = {}): StripRun => ({
  id,
  phase,
  state: 'complete',
  model: 'sonnet',
  effort: 'medium',
  costUsd: null,
  durationMs: null,
  tokens: null,
  question: null,
  ...over,
});
const segment = (phase: string, label: string, runs: StripRun[]): Segment => ({ phase, label, run: runs.at(-1) ?? null, count: runs.length, spend: spendOf(runs) });

const VIEW: PeekView = {
  key: 'APP-16',
  summary: { text: 'The cards ask for pictures at the old path. The path is fixed in one place.', at: '2026-10-14T14:02:40Z', live: true },
  log: { runId: 3, rows: [{ kind: 'tool', text: 'Reading web/src/lib/RecipeCard.svelte' }, { kind: 'usage', text: '41.8k tokens so far' }], total: 48 },
  tokens: 41_800,
  trail: [
    segment('refine', 'Refine', [run(1, 'refine', { model: 'haiku', costUsd: 0.03, durationMs: 21_000 })]),
    segment('plan', 'Plan', [run(2, 'plan', { costUsd: 0.12, durationMs: 65_000 })]),
    segment('implement', 'Implement', [run(3, 'implement', { state: 'running' })]),
    segment('qa', 'QA', []),
  ],
  retry: null,
  openComments: 0,
  session: null,
};
const RUNNING = cardFixture({ key: 'APP-16', title: 'Fix the broken image on recipe cards', stage: 'implement', state: 'running', runId: 3, runState: 'running', runStartedAt: '2026-10-14T14:00:56Z', engine: 'claude-code', model: 'sonnet', effort: 'high' });
const draw = (props: Record<string, unknown>) =>
  render(PeekSheet, { props: { card: RUNNING, stage: 'Implement', view: VIEW, clock: NOW, back: 'Plan', openHref: '/t/APP-16', logHref: '/t/APP-16/log', onclose: () => {}, ...props } }).body;
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

describe('the peek sheet', () => {
  it('draws the card: summary so far, live line, last rows, trail, Stop and Move back', () => {
    const html = draw({ live: { line: 'Editing web/src/lib/RecipeCard.svelte', quiet: null, since: '4s ago' } });

    expect(text(html)).toContain('So far, in plain words 30s ago The cards ask for pictures at the old path.');
    expect(text(html)).toContain('Claude Code · sonnet · high 41.8k tok');
    // Svelte drops a space at the start of an element, so the count keeps its own words apart.
    expect(text(html)).toContain('Log last 2 of 48 Full log');
    expect(text(html)).toContain('tool Reading web/src/lib/RecipeCard.svelte');
    expect(text(draw({ view: { ...VIEW, log: { runId: 3, rows: [{ kind: 'result', text: '84 lines', aside: '2.9 KB' }], total: 1 } } }))).toContain('result 84 lines, 2.9 KB');
    expect(html).toContain('data-peek-stop');
    expect(text(html)).toContain('Move back to Plan');
    expect(text(html)).toContain('Stop keeps the checkout as it is. Moving back stops the run first.');
  });

  // The time of day leads a row where the log noted one, and the kind words stay the short ones.
  it('says the time of each row in the compact form, and keeps says and tool', () => {
    const rows = [
      { kind: 'text' as const, text: 'Reading the list.', time: '14:02:31' },
      { kind: 'tool' as const, text: 'Reading web/src/lib/RecipeCard.svelte', time: '14:02:33' },
    ];
    const html = text(draw({ view: { ...VIEW, log: { runId: 3, rows, total: 2 } } }));

    expect(html).toContain('14:02:31 says Reading the list.');
    expect(html).toContain('14:02:33 tool Reading web/src/lib/RecipeCard.svelte');
  });

  // Running cost stays off, and an estimate is no measured cost.
  it('shows measured cost only on the trail: what each phase reported, and nothing for the one that runs', () => {
    const trail = /<ol class="trail[\s\S]*?<\/ol>/.exec(draw({}))?.[0] ?? '';

    expect(text(trail)).toBe('Refine haiku 21s $0.03 Plan sonnet 1m 05s $0.12 Implement sonnet 2m 14s QA next');
    expect(text(draw({}))).toContain('Trail $0.15 so far');
    expect(draw({})).not.toContain('~$');
  });

  // Amber only where an agent starts or works.
  it('marks in amber only the live line and the phase that runs, and nothing on a card that is not running', () => {
    const working = draw({ live: { line: 'Editing web/src/lib/RecipeCard.svelte', quiet: null, since: '4s ago' } });
    expect(working).toMatch(/class="ico[^"]*\bamber\b/);
    expect(working).toContain('data-step="now"');

    const quiet = draw({ live: { line: 'Editing web/src/lib/RecipeCard.svelte', quiet: '6m', since: null } });
    expect(quiet).not.toMatch(/class="ico[^"]*\bamber\b/);

    const idle = { ...RUNNING, state: 'ready' as const, runState: null, runId: null };
    const ready = draw({ card: idle, view: { ...VIEW, trail: VIEW.trail.slice(0, 2) } });
    expect(ready).not.toMatch(/amber/);
    expect(ready).not.toContain('data-peek-stop');
    expect(ready).not.toContain('Moving back stops the run first');
  });

  it('says plainly that no summary is there yet, and never makes one up', () => {
    expect(text(draw({ view: { ...VIEW, summary: null } }))).toContain('No plain summary yet. The agent writes one after each file it changes.');
    // A grey block while the card is read, with the words for a screen reader.
    expect(text(draw({ view: null }))).toContain('Reading the card.');
    expect(draw({ view: null })).toContain('data-skeleton');
    expect(draw({ view: VIEW })).not.toContain('data-skeleton');
  });

  it('counts a retry wait down from its stored time in the live line', () => {
    const waiting = { ...RUNNING, runState: 'retrying' as const };
    const html = draw({ card: waiting, view: { ...VIEW, retry: { attempt: 2, maxRetries: 3, reason: 'API Error: 529 Overloaded', until: NOW.getTime() + 134_000 } } });

    expect(text(html)).toContain('API Error: 529 Overloaded, retrying in 2m 14s, attempt 2 of 3');
  });
});

// On a phone the rail is a band at the top with z-index 30. The open sheet has to cover it, or the
// band hides the sheet's header and its Close button.
it('sits over the rail on a narrow screen', () => {
  const style = readFileSync(new URL('./PeekSheet.svelte', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const narrow = /@media \(max-width: 760px\) \{\s*\.sheet \{([^}]*)\}/.exec(style)?.[1] ?? '';

  expect(narrow).toContain('position: fixed;');
  expect(Number(/z-index: (\d+);/.exec(narrow)?.[1])).toBeGreaterThan(30);
});
