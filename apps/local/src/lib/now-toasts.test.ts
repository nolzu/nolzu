import type { ProfileLimit } from '@nolzu/protocol';
import type { ToastItem } from '@nolzu/ui';
import { describe, expect, it, vi } from 'vitest';
import type { NowSnapshot, RunEnd } from './now.ts';
import { type Heard, nowToasts } from './now-toasts.ts';
import { type BoardState, NO_LIMITS } from './snapshot-client.ts';

// Scout and Evidence are off as shipped. These tests pin how they work once the switch is on again, and
// coming-soon.test.ts pins the off state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), SCOUT_AND_EVIDENCE: true }));

// The toasts the Now stream raises, as pure rules. The layout feeding them in is in
// routes/layout.mount.test.ts.
const NOW = Date.parse('2026-10-17T17:00:00Z');
const HREFS = { card: (key: string) => `/t/${key}`, scout: '/scout', engines: '/settings/engines' };
const RESETS = Date.parse('2026-10-17T19:00:00Z') / 1000;

const snapshot = (over: Partial<NowSnapshot> = {}): NowSnapshot => ({
  version: 3,
  boards: [],
  waiting: {},
  running: [],
  done: [],
  today: { runs: 0, reported: 0, costUsd: null, durationMs: 0, moved: 0 },
  profiles: [{ id: 'claude-code', label: 'Claude Code', silent: false }],
  scout: { sources: 1, fresh: 0, newest: null },
  ended: [],
  ...over,
});

const ended = (runId: number, over: Partial<RunEnd> = {}): RunEnd => ({
  runId,
  key: 'APP-1',
  phase: 'Plan',
  state: 'complete',
  verdict: null,
  reason: null,
  endedAt: `2026-10-17T16:${String(10 + runId).padStart(2, '0')}:00.000Z`,
  model: 'sonnet',
  durationMs: 48_000,
  costUsd: 0.07,
  ...over,
});

const state = (now: NowSnapshot | null, limits: Readonly<Record<string, ProfileLimit>> = NO_LIMITS): BoardState<NowSnapshot> => ({ snapshot: now, reconnecting: false, activity: {}, limits });

const reading = (used: number, resetsAt = RESETS, card?: string): Record<string, ProfileLimit> => ({
  'claude-code': { seenAt: NOW - 60_000, windows: [{ name: 'five_hour', used, resetsAt, status: 'allowed' }], ...(card === undefined ? {} : { card }) },
});

// Every state in order, as the stream hands them to the layout, and every toast they raised.
function feed(...states: BoardState<NowSnapshot>[]): ToastItem[] {
  let heard: Heard | null = null;
  const all: ToastItem[] = [];
  for (const one of states) {
    const raised = nowToasts(heard, one, NOW, HREFS, 'UTC');
    heard = raised.heard;
    all.push(...raised.toasts);
  }
  return all;
}

describe('a page load', () => {
  // The first snapshot and the first limits event replay what is already so: runs that ended before,
  // findings already new, a window already near its limit.
  it('raises nothing for the state it replays', () => {
    const loaded = snapshot({ ended: [ended(2), ended(1, { state: 'failed', reason: 'The engine went quiet.' })], scout: { sources: 1, fresh: 3, newest: null } });

    expect(feed(state(null), state(loaded), state(loaded, reading(0.95)))).toEqual([]);
  });
});

describe('the run toasts', () => {
  it('raises one toast per run that ends after the page loaded, and never a second for it', () => {
    const before = snapshot({ ended: [ended(1)] });
    const after = snapshot({ ended: [ended(2, { key: 'APP-2' }), ended(1)] });

    const toasts = feed(state(before), state(after), state(after), state({ ...after, version: 4 }));

    expect(toasts.map((one) => one.card.key)).toEqual(['APP-2']);
  });

  // A run that ended before the page loaded and comes back into the list, as when a newer run's card
  // is removed, is not news.
  it('raises nothing for an older run that comes back into the list', () => {
    const before = snapshot({ ended: [ended(5), ended(4)] });
    const back = snapshot({ ended: [ended(4), ended(3)] });

    expect(feed(state(before), state(back))).toEqual([]);
  });

  it('says a run that ended ready, with its run line', () => {
    const [toast] = feed(state(snapshot()), state(snapshot({ ended: [ended(1)] })));

    expect(toast).toEqual({ kind: 'success', card: { key: 'APP-1', href: '/t/APP-1' }, headline: 'Plan finished', message: '', run: { model: 'sonnet', durationMs: 48_000, costUsd: 0.07 } });
  });

  it('says QA passed', () => {
    const [toast] = feed(state(snapshot()), state(snapshot({ ended: [ended(1, { phase: 'QA', verdict: 'PASS' })] })));

    expect(toast).toMatchObject({ kind: 'success', headline: 'QA passed', message: '' });
  });

  it('says a run failed, with the reason', () => {
    const [toast] = feed(state(snapshot()), state(snapshot({ ended: [ended(1, { phase: 'Implement', state: 'failed', reason: 'The engine went quiet for 10 minutes.', costUsd: null })] })));

    expect(toast).toEqual({
      kind: 'error',
      card: { key: 'APP-1', href: '/t/APP-1' },
      headline: 'Implement failed',
      message: 'The engine went quiet for 10 minutes.',
      run: { model: 'sonnet', durationMs: 48_000, costUsd: null },
    });
  });

  it('says QA failed, with what QA found', () => {
    const [toast] = feed(state(snapshot()), state(snapshot({ ended: [ended(1, { phase: 'QA', verdict: 'FAIL', reason: 'empty list, not the message' })] })));

    expect(toast).toMatchObject({ kind: 'error', headline: 'QA failed', message: 'empty list, not the message' });
  });

  // An engine's error can end in its whole stderr tail. The toast keeps one short line of it.
  it('keeps the first line of a long reason, cut short', () => {
    const reason = `The claude engine stopped with exit code 1. It said: ${'x'.repeat(400)}\nat main (cli.js:1:1)`;
    const [toast] = feed(state(snapshot()), state(snapshot({ ended: [ended(1, { state: 'failed', reason })] })));

    expect(toast?.message).toHaveLength(160);
    expect(toast?.message).toMatch(/^The claude engine stopped with exit code 1\. It said: x+…$/);
  });

  it('says a failed run gave no reason, rather than leaving the line empty', () => {
    const [toast] = feed(state(snapshot()), state(snapshot({ ended: [ended(1, { state: 'failed', reason: null })] })));

    expect(toast).toMatchObject({ kind: 'error', headline: 'Plan failed', message: 'It gave no reason. Read its log.' });
  });

  // QA that printed no verdict is neither a pass nor a fail: the card waits for the person.
  it('warns that QA gave no verdict', () => {
    const [toast] = feed(state(snapshot()), state(snapshot({ ended: [ended(1, { phase: 'QA', reason: 'This QA run printed no verdict.' })] })));

    expect(toast).toMatchObject({ kind: 'warning', headline: 'QA gave no verdict', message: 'This QA run printed no verdict.' });
  });
});

describe("Scout's toast", () => {
  const scout = (fresh: number) => snapshot({ scout: { sources: 1, fresh, newest: { title: 'TypeError in the list', line: 'The recipe app · seen once', source: 'The recipe app' } } });

  it('says how many findings a check found new, and from which source', () => {
    const toasts = feed(state(scout(0)), state(scout(2)), state(scout(2)));

    expect(toasts).toEqual([{ kind: 'info', card: { key: 'Scout', href: '/scout' }, title: 'Scout: 2 new findings', message: '', note: 'The recipe app' }]);
  });

  // Opening Scout moves the seen marker, so the count drops to 0. That is no finding, and the next one
  // counts from there.
  it('raises nothing when the count drops, and counts the next finding from there', () => {
    const toasts = feed(state(scout(3)), state(scout(0)), state(scout(1)));

    expect(toasts.map((one) => one.title)).toEqual(['Scout: 1 new finding']);
  });
});

describe('the near-limit warning', () => {
  it('raises the warning once when a window crosses 90%, with the profile and the card that saw it', () => {
    const toasts = feed(state(snapshot()), state(snapshot(), reading(0.85)), state(snapshot(), reading(0.92, RESETS, 'APP-16')), state(snapshot(), reading(0.97, RESETS, 'APP-17')), state(snapshot(), reading(0.97, RESETS, 'APP-17')));

    expect(toasts).toEqual([
      { kind: 'warning', card: { key: 'Claude Code, 5-hour window', href: '/settings/engines' }, title: '5-hour window 92% used, resets 19:00', message: '', note: 'Claude Code · seen on APP-16' },
    ]);
  });

  // A new window is a new crossing, and so is the same window going back under 90% and over again.
  it('raises it again for the next window, or after the share went back under', () => {
    const later = RESETS + 5 * 60 * 60;
    const toasts = feed(state(snapshot()), state(snapshot(), {}), state(snapshot(), reading(0.91)), state(snapshot(), reading(0.93, later)), state(snapshot(), reading(0.5, later)), state(snapshot(), reading(0.9, later)));

    expect(toasts.map((one) => one.title)).toEqual(['5-hour window 91% used, resets 19:00', '5-hour window 93% used, resets 00:00', '5-hour window 90% used, resets 00:00']);
  });

  it('raises nothing from a reading under 90%, or with no reading at all', () => {
    expect(feed(state(snapshot()), state(snapshot(), {}), state(snapshot(), reading(0.89)), state(snapshot(), {}))).toEqual([]);
  });

  it('names the profile alone when no card saw the reading', () => {
    const [toast] = feed(state(snapshot()), state(snapshot(), {}), state(snapshot(), reading(0.95)));

    expect(toast?.note).toBe('Claude Code');
  });
});
