import { flushSync } from 'svelte';
import { render } from 'svelte/server';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import ClosedCard from './ClosedCard.svelte';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};
const words = (target: HTMLElement) => target.textContent?.replace(/\s+/g, ' ').trim() ?? '';

// What the app answers for the branch of APP-1, read from a recorded gh answer by `cardPulls`.
const MERGED = { repo: 'cook/recipes', branch: 'APP-1-add-a-search-box', number: 12, url: 'https://github.com/cook/recipes/pull/12', state: 'merged' as const };
// The same card with gh logged out: the link to GitHub's search for the branch, and no state.
const UNREAD = {
  repo: 'cook/recipes',
  branch: 'APP-1-add-a-search-box',
  number: null,
  url: 'https://github.com/cook/recipes/pulls?q=is%3Apr%20head%3AAPP-1-add-a-search-box',
  state: null,
};
const LOGGED_OUT = 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.';
const DIFF = 'diff --git a/.nolzu/knowledge/api.md b/.nolzu/knowledge/api.md\n--- a/.nolzu/knowledge/api.md\n+++ b/.nolzu/knowledge/api.md\n@@ -1 +1 @@\n-Sort them in the web app.\n+The server sorts.\n';
const APPLIED = { id: 7, path: '.nolzu/knowledge/api.md', status: 'applied' as const, summary: 'Sorting', diff: DIFF };

function draw(props: Record<string, unknown>) {
  page = mounted(ClosedCard as never, { knowledge: [], knowledgeHref: '/knowledge', onpulls: async () => ({ pulls: [], said: null }), onrevert: async () => ({ ok: true, message: '' }), ...props });
  return page.target;
}

it('draws first and reads the pull request state after, then shows merged from the recorded answer', async () => {
  let answer: (value: { pulls: (typeof MERGED)[]; said: null }) => void = () => {};
  const target = draw({ onpulls: () => new Promise((resolve) => (answer = resolve)) });

  // A grey line while gh answers. The words stay for a screen reader.
  expect(target.querySelector('[data-skeleton]')?.getAttribute('data-shape')).toBe('line');
  expect(words(target)).toContain('Reading the pull request state through gh.');
  answer({ pulls: [MERGED], said: null });
  await settle();
  expect(target.querySelector('[data-skeleton]')).toBeNull();

  expect(words(target)).toContain('#12 merged');
  expect(words(target)).toContain('cook/recipes · APP-1-add-a-search-box');
  expect(target.querySelector('a[href="https://github.com/cook/recipes/pull/12"]')?.textContent).toBe('Open on GitHub');
});

// The merger, how long ago, the size and the base, read from the recorded answer.
it('says who merged it and how long ago, with the base and the size', async () => {
  const at = new Date(Date.now() - 2 * 3600_000 - 60_000).toISOString();
  const target = draw({ onpulls: async () => ({ pulls: [{ ...MERGED, number: 42, mergedBy: 'you', mergedAt: at, additions: 48, deletions: 6, files: 3, base: 'main' }], said: null }) });
  await settle();

  expect(words(target.querySelector('[data-pull]') as HTMLElement)).toBe('#42 merged by you, 2 hours ago cook/recipes · APP-1-add-a-search-box into main · +48 -6 in 3 files Open on GitHub');
  // One line of words, as the closed card draws it, with no branch mark beside them.
  expect(target.querySelector('[data-pull] svg')).toBeNull();
  // One line: the state, where and the link are parts of one row, not a column with the link beside it.
  // The state is a heading, as every other block title is.
  expect([...(target.querySelector('[data-pull]') as HTMLElement).children].map((one) => one.tagName)).toEqual(['H2', 'SPAN', 'A']);
});

it('names the merger by login when it is not the gh user', async () => {
  const target = draw({ onpulls: async () => ({ pulls: [{ ...MERGED, mergedBy: 'dana' }], said: null }) });
  await settle();

  expect(words(target)).toContain('#12 merged by dana');
});

// A pull request that is not merged names no merger, even if the answer carried one.
it('names no merger and no time on a pull request that is not merged', async () => {
  const target = draw({ onpulls: async () => ({ pulls: [{ ...MERGED, state: 'open', mergedBy: 'dana', mergedAt: new Date().toISOString() }], said: null }) });
  await settle();

  expect(words(target.querySelector('[data-pull]') as HTMLElement)).toContain('#12 open cook/recipes');
});

// A gh that failed or is not signed in claims nothing: the link stays and no state word is drawn.
it('shows the link with no state, and why, when gh did not answer', async () => {
  const target = draw({ onpulls: async () => ({ pulls: [UNREAD], said: LOGGED_OUT }) });
  await settle();
  const said = words(target.querySelector('[data-pull]') as HTMLElement);

  expect(said).toBe('Pull request cook/recipes · APP-1-add-a-search-box Open on GitHub');
  expect(words(target)).toContain(LOGGED_OUT);
  expect(target.querySelector(`a[href="${UNREAD.url}"]`)).not.toBeNull();
  // The green mark of a merged line rides on this attribute, so an unread line must not carry merged.
  expect(target.querySelector('[data-pull]')?.getAttribute('data-pull')).toBe('unknown');
});

// The server render is the page load. gh is asked only once the browser has the page.
it('asks nothing while the page is drawn on the server', () => {
  const onpulls = vi.fn(async () => ({ pulls: [], said: null }));
  render(ClosedCard, { props: { knowledge: [], knowledgeHref: '/knowledge', onpulls, onrevert: async () => ({ ok: true, message: '' }) } });

  expect(onpulls).not.toHaveBeenCalled();
});

// Only a Delivery card waits on a pull request. A closed epic or research card has none to read, so
// the page hands no reader and gh is never asked.
it('draws no pull request part when the page hands no reader', async () => {
  const target = draw({ onpulls: null });
  await settle();

  expect(target.querySelector('#pr-title')).toBeNull();
  expect(words(target)).not.toContain('pull request');
  expect(words(target)).toContain('What Nolzu learned');
});

it('draws the change the wrap-up made, and reverts it once for two quick presses', async () => {
  let done: (value: { ok: boolean; message: string }) => void = () => {};
  const onrevert = vi.fn(() => new Promise<{ ok: boolean; message: string }>((resolve) => (done = resolve)));
  const target = draw({ knowledge: [APPLIED], onrevert });
  const button = target.querySelector<HTMLButtonElement>('[data-revert="7"]')!;

  expect(words(target)).toContain('wrap-up changed 1 file');
  expect([...target.querySelectorAll('[data-kind]')].map((line) => `${line.getAttribute('data-kind')} ${line.textContent}`)).toEqual(['del Sort them in the web app.', 'add The server sorts.']);
  // Revert is a commit and starts no run, so it is a plain button.
  expect(button.className).not.toMatch(/\bgo\b/);

  button.click();
  button.click();
  done({ ok: true, message: 'Took .nolzu/knowledge/api.md back to what it was before commit 1a2b3c4.' });
  await settle();

  expect(onrevert).toHaveBeenCalledTimes(1);
  expect(onrevert).toHaveBeenCalledWith(7);
  expect(words(target)).toContain('Took .nolzu/knowledge/api.md back');
});

// The time of the knowledge commit in the header, and no kind tag beside the file.
it('says when the change was applied, and draws no kind tag', () => {
  const target = draw({ knowledge: [{ ...APPLIED, summary: 'added', applied: '2026-10-20T10:50:00Z' }], now: new Date('2026-10-20T11:00:00Z') });

  expect(words(target)).toContain('wrap-up changed 1 file, applied 10 minutes ago');
  expect(target.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-20T10:50:00Z');
  expect(words(target.querySelector('[data-change="7"]') as HTMLElement)).not.toContain('added');
});

it('offers no Revert on a change that waits for review or was reverted', () => {
  const target = draw({ knowledge: [{ ...APPLIED, status: 'pending', diff: null }, { ...APPLIED, id: 8, status: 'reverted' }] });

  expect(target.querySelector('[data-revert]')).toBeNull();
  expect(target.querySelector('a[href="/knowledge"]')?.textContent).toBe('Review it on Knowledge');
  expect(words(target.querySelector('[data-change="8"]') as HTMLElement)).toContain('reverted');
});

it('says the card changed no knowledge file', () => {
  expect(words(draw({}))).toContain('This card changed no knowledge file.');
});

// The rows come from the database and git reads each patch after the page drew.
it('draws a grey block in a change while its patch is on its way, and the lines once it lands', () => {
  const waiting = draw({ onpulls: null, knowledge: [{ ...APPLIED, diff: null }], diffsWaiting: true });
  expect(waiting.querySelector('[data-change="7"] [data-skeleton]')?.getAttribute('data-shape')).toBe('block');
  page?.remove();
  page = null;

  const landed = draw({ onpulls: null, knowledge: [APPLIED], diffsWaiting: false });
  expect(landed.querySelector('[data-skeleton]')).toBeNull();
  expect(words(landed)).toContain('The server sorts.');
});

// A patch git could not make stays empty once the wait is over, never grey for good.
it('draws no grey block in a change with no patch once the wait is over', () => {
  expect(draw({ onpulls: null, knowledge: [{ ...APPLIED, diff: null }], diffsWaiting: false }).querySelector('[data-skeleton]')).toBeNull();
});
