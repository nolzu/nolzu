import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import TabBar from './TabBar.svelte';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'settings', label: 'Settings' },
];

it('draws every tab as a real link, so the back button works', () => {
  const { body } = render(TabBar, { props: { cardKey: 'PROJ-123', tabs: TABS, current: 'overview' } });
  const hrefs = [...body.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);

  expect(hrefs).toEqual(['/t/PROJ-123/overview', '/t/PROJ-123/files', '/t/PROJ-123/settings']);
});

it('marks the current tab for a screen reader as well as for the eye', () => {
  const { body } = render(TabBar, { props: { cardKey: 'PROJ-123', tabs: TABS, current: 'files' } });
  const current = body.slice(body.indexOf('/t/PROJ-123/files'));

  expect(current).toContain('aria-current="page"');
  expect(body.match(/aria-current="page"/g)).toHaveLength(1);
});

// A pull request card is keyed repo#number. Unencoded, the hash starts the fragment and the whole
// key is gone from the address, so every tab would open the wrong card.
it('keeps a key holding a hash whole in the address', () => {
  const { body } = render(TabBar, { props: { cardKey: 'recipes#42', tabs: TABS.slice(0, 1), current: 'overview' } });

  expect(body).toContain('href="/t/recipes%2342/overview"');
});

it('escapes a key that holds markup, so a ticket key cannot reach the page as markup', () => {
  const { body } = render(TabBar, { props: { cardKey: 'PROJ<b>1', tabs: TABS, current: 'overview' } });

  expect(body).not.toContain('<b>');
});

// The keys help lists the tab keys, so the row draws no hint.
it('says nothing about number keys on the tab row', () => {
  const { body } = render(TabBar, { props: { cardKey: 'PROJ-123', tabs: TABS, current: 'overview' } });

  expect(body).not.toContain('switches tabs');
});

// "Files 3" and "Log live": what a tab holds after its label, with a word space between them.
it('draws what each tab holds after its label, and nothing for a tab with no count', () => {
  const { body } = render(TabBar, { props: { cardKey: 'PROJ-123', tabs: TABS, current: 'overview', counts: { files: '3' } } });
  const tabs = [...body.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((match) => match[1]!.replace(/<!--[^>]*-->/g, '').replace(/<[^>]+>/g, '').trim());

  expect(tabs).toEqual(['Overview', 'Files 3', 'Settings']);
});

// The Changes count reads as the diff does: added in green, removed in red. A screen reader hears
// the words, not the signs.
it('colours the Changes count and says it in words', () => {
  const tabs = [{ id: 'changes', label: 'Changes' }];
  const { body } = render(TabBar, { props: { cardKey: 'PROJ-123', tabs, current: 'overview', counts: { changes: '+60 -8' } } });
  const one = render(TabBar, { props: { cardKey: 'PROJ-123', tabs, current: 'changes', counts: { changes: '+1 -0' } } }).body;

  expect(body).toMatch(/<span class="plus[^"]*">\+60<\/span>/);
  expect(body).toMatch(/<span class="minus[^"]*">-8<\/span>/);
  expect(body).toMatch(/<span aria-hidden="true"[^>]*>/);
  expect(body).toContain('60 lines added, 8 removed');
  expect(one).toContain('1 line added, 0 removed');
});

// A server render carries no CSS, so the colours are read off the component. They are the tokens
// the diff view draws its added and removed lines in, which tokens.test.ts holds to 4.5:1.
it('draws the added count in green and the removed count in red', () => {
  const style = /<style>([\s\S]*)<\/style>/.exec(readFileSync(new URL('./TabBar.svelte', import.meta.url), 'utf8'))![1]!;

  expect(style).toMatch(/\.plus \{\s*color: var\(--green\);/);
  expect(style).toMatch(/\.minus \{\s*color: var\(--red\);/);
});

it('draws a Changes word that is not a count as it is', () => {
  const { body } = render(TabBar, { props: { cardKey: 'PROJ-123', tabs: [{ id: 'changes', label: 'Changes' }], current: 'overview', counts: { changes: 'merged' } } });

  expect(body).not.toContain('class="plus');
  expect(body.replace(/<!--[^>]*-->/g, '')).toMatch(/<span class="n[^"]*">merged<\/span>/);

  // Only the whole "+N -M" form splits, so a longer word that holds one draws as it is too.
  for (const changes of ['about +3 -1', '+3 -1 more']) {
    const other = render(TabBar, { props: { cardKey: 'PROJ-123', tabs: [{ id: 'changes', label: 'Changes' }], current: 'overview', counts: { changes } } }).body;
    expect(other).not.toContain('class="plus');
    expect(other).toContain(changes);
  }
});

// git counts the Changes lines after the page drew, so the tab holds a grey pill in the count's place.
it('draws a pill skeleton for a count still on its way, and the count once it lands', () => {
  const tabs = [{ id: 'changes', label: 'Changes' }, ...TABS];
  const waiting = render(TabBar, { props: { cardKey: 'PROJ-123', tabs, current: 'overview', pending: ['changes'] } }).body;
  const changes = waiting.slice(waiting.indexOf('/t/PROJ-123/changes'), waiting.indexOf('/t/PROJ-123/overview'));
  expect(changes).toContain('data-shape="pill"');
  expect(changes).toContain('counting the lines');
  expect(waiting.match(/data-skeleton/g)).toHaveLength(1);

  const landed = render(TabBar, { props: { cardKey: 'PROJ-123', tabs, current: 'overview', counts: { changes: '+2 -1' }, pending: ['changes'] } }).body;
  expect(landed).not.toContain('data-skeleton');
});
