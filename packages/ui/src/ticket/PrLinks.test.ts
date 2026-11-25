import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import PrLinks from './PrLinks.svelte';

const none = async () => null;
const PULLS = [
  { repo: 'cook/recipes', number: 12, url: 'https://github.com/cook/recipes/pull/12', title: 'Add a search box', state: 'open' as const, foundBy: 'branch' as const },
  { repo: 'cook/api', number: 7, url: null, title: null, state: null, foundBy: 'attached' as const },
];

it('lists each pull request with its state, and offers Detach only on an attached one', () => {
  const { body } = render(PrLinks, { props: { pulls: PULLS, onattach: none, ondetach: none } });

  expect(body).toContain('href="https://github.com/cook/recipes/pull/12"');
  // A row with no url read yet still links to the pull request on GitHub.
  expect(body).toContain('href="https://github.com/cook/api/pull/7"');
  expect(body).toContain('Add a search box');
  expect(body).toContain('Open');
  expect(body).toContain('Not read yet');
  expect(body).toContain('Found by the branch, so it stays');
  expect(body.match(/data-detach/g)).toHaveLength(1);
  expect(body).toContain('data-detach="cook/api#7"');
  expect(body).toContain('aria-label="Detach cook/api#7"');
});

it('says where a pull request comes from when the card has none', () => {
  const { body } = render(PrLinks, { props: { pulls: [], onattach: none, ondetach: none } });

  expect(body).toContain('No pull request on this card yet.');
  expect(body).toContain('Attach a pull request');
});

// The browser's own grey placeholder is under 4.5:1 on the field in both themes.
it('draws the placeholder in the muted ink', () => {
  const source = readFileSync(new URL('./PrLinks.svelte', import.meta.url), 'utf8');

  expect(source).toMatch(/input::placeholder \{\s*color: var\(--muted\);\s*opacity: 1;/);
});
