import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import WaitingToggle from './WaitingToggle.svelte';

// The board's own filter button, which the header drew before the rail took its place.
const draw = (on: boolean, count: number) => render(WaitingToggle, { props: { on, count, onclick: () => {} } }).body;
const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

it('shows Waiting on me with its key and count, pressed when on', () => {
  expect(draw(true, 3)).toMatch(/<button[^>]*aria-pressed="true"[^>]*>/);
  expect(text(draw(true, 3))).toBe('Waiting on me 3 cards W');
  expect(draw(false, 0)).toMatch(/<button[^>]*aria-pressed="false"[^>]*>/);
});

// With nothing waiting the count reads 0. The key is a cap of its own, after the count, so the letter
// is never where the number goes, and a screen reader hears the words and not the letter.
it('reads 0 with nothing waiting, and keeps the key apart from the count', () => {
  const body = draw(false, 0);

  expect(/data-waiting-count[^>]*>([^<]*)</.exec(body)?.[1]).toBe('0');
  expect(body).toMatch(/<kbd aria-hidden="true"[^>]*>W<\/kbd>/);
  expect(body.indexOf('data-waiting-count')).toBeLessThan(body.indexOf('<kbd'));
});

it('says card, not cards, for one card waiting', () => {
  expect(text(draw(false, 1))).toBe('Waiting on me 1 card W');
});

// The space sits between the nodes, which text() cannot see, so this reads the raw markup.
it('keeps the space between the count and the word a screen reader hears', () => {
  const raw = draw(false, 3).replaceAll(/<!--[\s\S]*?-->/g, '');

  expect(raw).toMatch(/data-waiting-count[^>]*>3<\/span> <span class="hidden[^"]*">cards<\/span>/);
});
