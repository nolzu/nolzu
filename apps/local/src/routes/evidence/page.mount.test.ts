import { type EvidenceDay, spendOf, timesheetOf } from '@nolzu/protocol';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FREE } from '$lib/display.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../test/stubs/app-paths.ts';
// eslint-disable-next-line no-restricted-imports -- the ui package's mount helper, which is not exported
import { mounted } from '../../../../../packages/ui/test/mounted.svelte.ts';
import Page from './+page.svelte';

// Evidence mounted for real: what a click does, which a server render cannot show.
class Source {
  onmessage: ((event: { data: string }) => void) | null = null;
  close(): void {}
}

const DAY = '2026-04-15';
const day: EvidenceDay = { day: DAY, blocks: [], spend: spendOf([]), problem: null };
const DATA = {
  display: FREE,
  day,
  phases: {},
  standup: { day: DAY, yesterday: day, cards: [] },
  week: timesheetOf([], '2026-04-13'),
  now: `${DAY}T15:40:00.000Z`,
  today: DAY,
  weeks: { previous: '2026-04-06', next: '2026-04-20' },
  exporters: [],
  forms: {},
  shown: null,
  sync: null,
  billingPrompt: true,
  billing: { clientName: null, hourlyRate: null, currency: 'USD' },
};

let target: HTMLElement;
let instance: object | null = null;

beforeEach(() => {
  drawnAt('/evidence');
  vi.stubGlobal('EventSource', Source);
  target = document.body.appendChild(document.createElement('div'));
});

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target.remove();
  vi.unstubAllGlobals();
});

it('hides "Bill this project?" on Not now, and keeps the fields folded at #billing', async () => {
  instance = mount(Page, { target, props: { data: DATA as never, form: null } });
  await tick();
  flushSync();
  expect(target.textContent).toContain('Bill this project?');

  [...target.querySelectorAll('button')].find((one) => one.textContent?.trim() === 'Not now')?.click();
  await tick();
  flushSync();

  expect(target.textContent).not.toContain('Bill this project?');
  expect(target.querySelector('details#billing input[name="client"]')).not.toBeNull();
});

// The standup box keeps what a person typed. A day step must not carry that text to the next day.
it('starts the standup box over for each day the arrows step to', async () => {
  const page = mounted(Page as never, { data: DATA, form: null } as never);
  const box = () => page.target.querySelector('textarea') as HTMLTextAreaElement;
  box().value = 'my own words';
  box().dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  expect(box().value).toBe('my own words');

  const next = '2026-04-14';
  page.set({ data: { ...DATA, day: { ...day, day: next }, standup: { day: next, yesterday: day, cards: [] } } } as never);
  await tick();

  expect(box().value).not.toBe('my own words');
  page.remove();
});
