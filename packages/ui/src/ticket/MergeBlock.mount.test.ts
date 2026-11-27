import type { CardView, MergeBlocker } from '@nolzu/protocol';
import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import { boardFixture, cardFixture } from '../board/fixture.ts';
import type { MergePull } from './merge.ts';
import MergeBlock from './MergeBlock.svelte';

// Fix CI beside the failed checks: amber while it would start Implement, with what it runs on and the
// line on where the logs go, holding until the board shows the card moved.
const stages = boardFixture('pull-request').stages;

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

const JOB = 'https://github.com/example/recipes/actions/runs/7/job/8';
const pull = (failed: { name: string; url: string | null }[], more: MergeBlocker[] = []): MergePull => ({
  repo: 'example/recipes',
  number: 12,
  url: null,
  read: { blockers: [{ kind: 'checks', failed }, ...more], running: false },
  at: '2026-11-27T10:00:00.000Z',
});
const idle = cardFixture({ key: 'APP-1', stage: 'pr-watch', state: 'idle' });
const words = (target: HTMLElement) => target.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const button = (target: HTMLElement) => target.querySelector<HTMLButtonElement>('[data-run="fix-ci"]');

function draw(card: CardView, pulls: MergePull[], fix: Record<string, unknown> = {}) {
  page = mounted(MergeBlock as never, { pulls, now: new Date('2026-11-27T10:01:00.000Z'), fixCi: { card, stages, onfix: async () => null, ...fix } });
  return page.target;
}

it('draws Fix CI in amber beside the failed checks, with what it runs on and where the logs go', () => {
  const target = draw(idle, [pull([{ name: 'build', url: JOB }], [{ kind: 'draft' }])]);
  const fix = button(target)!;

  expect(fix.classList.contains('go')).toBe(true);
  expect(fix.textContent).toContain('Fix CI');
  expect(fix.closest('li')?.getAttribute('data-blocker')).toBe('checks');
  expect(words(target)).toContain('Claude Code · sonnet · medium');
  expect(words(target)).toContain("The failed logs go to the engine's vendor with the code, as the code and comments do.");
  expect(fix.getAttribute('aria-describedby')).toMatch(/-note /);
});

it('sends once and holds until the board shows the card moved', async () => {
  const onfix = vi.fn(async () => null);
  const target = draw(idle, [pull([{ name: 'build', url: JOB }])], { onfix });

  button(target)!.click();
  await settle();
  button(target)!.click();
  await settle();

  expect(onfix).toHaveBeenCalledTimes(1);
  expect(button(target)?.getAttribute('aria-busy')).toBe('true');
  expect(words(target)).toContain('Sent. Waiting for the board to show it.');
});

it('lets go on a refusal and hands the sentence to the toast', async () => {
  const onrefuse = vi.fn();
  const target = draw(idle, [pull([{ name: 'build', url: JOB }])], { onfix: async () => 'gh is not logged in to GitHub.', onrefuse });

  button(target)!.click();
  await settle();

  expect(onrefuse).toHaveBeenLastCalledWith('gh is not logged in to GitHub.');
  expect(button(target)?.getAttribute('aria-busy')).toBeNull();
});

it('refuses a busy card and a card with no readable log, without amber and without sending', async () => {
  const onfix = vi.fn(async () => null);
  const busy = draw({ ...idle, state: 'running', runId: 4, runState: 'running' }, [pull([{ name: 'build', url: JOB }])], { onfix });
  expect(button(busy)?.classList.contains('go')).toBe(false);
  expect(button(busy)?.getAttribute('aria-disabled')).toBe('true');
  expect(words(busy)).toContain('APP-1 is running. Wait for the run to end, then press Fix CI.');
  button(busy)!.click();
  page?.remove();

  const none = draw(idle, [pull([{ name: 'lint', url: 'https://ci.example.com/42' }])], { onfix });
  expect(words(none)).toContain('None of the failed checks has a log Nolzu can read. Open them on GitHub.');
  button(none)!.click();
  await settle();
  expect(onfix).not.toHaveBeenCalled();
});

it('draws no button without failed checks or without the card', () => {
  expect(button(draw(idle, [{ ...pull([]), read: { blockers: [{ kind: 'draft' }], running: false } }]))).toBeNull();
  page?.remove();
  page = mounted(MergeBlock as never, { pulls: [pull([{ name: 'build', url: JOB }])], now: new Date() });
  expect(button(page.target)).toBeNull();
});

it('shows the estimate only when runs measured one', () => {
  const measured = stages.map((one) => (one.id === 'implement' ? { ...one, starts: { ...one.starts!, estimate: { costUsd: 0.4, lowMs: 360_000, highMs: 600_000, from: 'history' as const, runs: 8 } } } : one));
  page = mounted(MergeBlock as never, { pulls: [pull([{ name: 'build', url: JOB }])], now: new Date(), fixCi: { card: idle, stages: measured, onfix: async () => null } });
  expect(words(page.target)).toContain('about $0.40 · 6 to 10 min, from 8 runs in this project');
  page.remove();

  expect(draw(idle, [pull([{ name: 'build', url: JOB }])]).querySelector('.figure')).toBeNull();
});
