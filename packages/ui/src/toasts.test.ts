import { describe, expect, it } from 'vitest';
import { dropToast, pushToast, runLine, splitCode, TOAST_LIMIT, TOAST_LONG_MS, TOAST_MS, type ToastItem, toastLife } from './toasts.ts';

const toast = (key: string, message = 'added to Inbox.'): ToastItem => ({ kind: 'success', card: { key, href: `/t/${key}` }, message });

describe('pushToast', () => {
  it('keeps three toasts and drops the oldest', () => {
    const stack = ['APP-1', 'APP-2', 'APP-3', 'APP-4'].reduce<ToastItem[]>((all, key) => pushToast(all, toast(key)), []);

    expect(TOAST_LIMIT).toBe(3);
    expect(stack.map((one) => one.card.key)).toEqual(['APP-2', 'APP-3', 'APP-4']);
  });

  // Two toasts about one card would say two things about it at once, and the older one is out of date.
  it('puts a new toast for a card in place of its older one, at the newest end', () => {
    const stack = [toast('APP-1'), toast('APP-2')].reduce<ToastItem[]>((all, one) => pushToast(all, one), []);

    const next = pushToast(stack, toast('APP-1', 'sonnet is gone, so Plan cannot start a run.'));

    expect(next.map((one) => [one.card.key, one.message])).toEqual([
      ['APP-2', 'added to Inbox.'],
      ['APP-1', 'sonnet is gone, so Plan cannot start a run.'],
    ]);
  });

  it('leaves the stack it was given as it was', () => {
    const stack = [toast('APP-1')];

    pushToast(stack, toast('APP-2'));

    expect(stack).toHaveLength(1);
  });
});

describe('dropToast', () => {
  it('takes the toasts of one card off the stack and keeps the rest in order', () => {
    expect(dropToast([toast('APP-1'), toast('APP-2'), toast('APP-3')], 'APP-2').map((one) => one.card.key)).toEqual(['APP-1', 'APP-3']);
  });
});

describe('runLine', () => {
  it('writes the model, the time and the cost of the run', () => {
    expect(runLine({ model: 'sonnet', durationMs: 62_000, costUsd: 0.08 })).toBe('sonnet · 1m 02s · $0.08');
  });

  // One model can run on two engines, so the engine goes first when the run names one.
  it('names the engine before the model', () => {
    expect(runLine({ engine: 'codex#work', model: 'gpt-5.6', durationMs: 62_000, costUsd: null })).toBe('Codex · gpt-5.6 · 1m 02s');
  });

  // The snapshot carries no duration, so a toast built from it has a model and a cost and no time.
  it('leaves out the parts the run did not report', () => {
    expect(runLine({ model: 'sonnet', durationMs: null, costUsd: 0.08 })).toBe('sonnet · $0.08');
    expect(runLine({ model: null, durationMs: 48_000, costUsd: null })).toBe('48s');
  });

  // A toast with no run has no line at all, never a made-up one.
  it('gives no line when there is no run, or the run reported nothing', () => {
    expect(runLine(null)).toBeNull();
    expect(runLine(undefined)).toBeNull();
    expect(runLine({ model: null, durationMs: null, costUsd: null })).toBeNull();
    expect(runLine({ model: '', durationMs: null, costUsd: null })).toBeNull();
  });

  // A reported nought is an answer, so it reads like money, as it does on the card page.
  it('writes a cost of nought as money', () => {
    expect(runLine({ model: 'haiku', durationMs: null, costUsd: 0 })).toBe('haiku · $0.00');
  });
});

describe('splitCode', () => {
  // A model or a path inside a sentence is set in mono, so the sentence is cut around it once.
  it('cuts the sentence around the first place the code stands', () => {
    expect(splitCode('Plan uses sonnet-4-5, which Claude Code no longer offers.', 'sonnet-4-5')).toEqual(['Plan uses ', 'sonnet-4-5', ', which Claude Code no longer offers.']);
    expect(splitCode('sonnet is gone, and sonnet stays gone.', 'sonnet')).toEqual(['', 'sonnet', ' is gone, and sonnet stays gone.']);
  });

  // A code the sentence does not hold would be drawn as a word nobody wrote.
  it('leaves the sentence whole with no code, an empty one, or one it does not hold', () => {
    expect(splitCode('APP-1 moved on in another tab.', null)).toBeNull();
    expect(splitCode('APP-1 moved on in another tab.', undefined)).toBeNull();
    expect(splitCode('APP-1 moved on in another tab.', '')).toBeNull();
    expect(splitCode('APP-1 moved on in another tab.', 'opus')).toBeNull();
  });
});

describe('toastLife', () => {
  it('gives a plain toast about 6 seconds, and an error or a toast with a link about 10', () => {
    expect([TOAST_MS, TOAST_LONG_MS]).toEqual([6000, 10_000]);
    expect(toastLife(toast('APP-1'))).toBe(TOAST_MS);
    expect(toastLife({ ...toast('APP-1'), kind: 'warning' })).toBe(TOAST_MS);
    expect(toastLife({ ...toast('APP-1'), kind: 'error' })).toBe(TOAST_LONG_MS);
    expect(toastLife({ ...toast('APP-1'), link: { label: 'Open Settings, Models', href: '/settings/models' } })).toBe(TOAST_LONG_MS);
    expect(toastLife({ ...toast('APP-1'), link: null })).toBe(TOAST_MS);
  });
});
