import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The layout needs the SvelteKit runtime to render, so its head is read off the source. The pill takes
// the board card's words through `cardPill`, so the two never disagree. A state this version does not
// know has no pill, so it keeps the round box and its muted dot.
const source = readFileSync(new URL('./+layout.svelte', import.meta.url), 'utf8');

it('draws a known state as the board card’s pill, and an unknown one in the round box', () => {
  const [, known = '', unknown = ''] = /\{#if known\}([\s\S]*?)\{:else\}([\s\S]*?)\{\/if\}/.exec(source) ?? [];

  expect(known).toContain('<StatePill state={pill.state} word={pill.word} detail={pill.detail} check={pill.check} />');
  // With the card's column, so the pill names the phase a ready card finished and a closed card reads Closed.
  expect(source).toContain('cardPill(forward.card, live, clock, column)');
  expect(unknown).toContain('<span class="round" data-state="unknown">{shown.state}</span>');
  expect(source).toContain(".round[data-state='unknown']::before");
});

// The sticky head once covered the question on a cold load of /t/<key>/overview#asks, because the
// padding that kept it clear was set only after hydration. The padding is in the style now, with a
// fallback height until the page measures the head, so the browser lands the link below the head.
it('keeps the head in sight on a wide screen, with scroll padding in the style', () => {
  const style = (/<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');

  expect(/\n {2}\.thead \{([^}]*)\}/.exec(style)?.[1]).toMatch(/position: sticky;[\s\S]*top: 0;[\s\S]*background: var\(--bg\);/);
  expect(style).toMatch(/@media \(min-width: 641px\) \{\s*:global\(html:has\(header\.thead\)\) \{\s*scroll-padding-top: var\(--thead-height, 160px\);/);
  expect(style).toMatch(/@media \(max-width: 640px\) \{\s*\.thead \{\s*position: static;/);
  expect(source).toContain('<header class="thead" bind:offsetHeight={headHeight}>');
  expect(source).toContain("root.style.setProperty('--thead-height', `${headHeight}px`)");
  expect(source).not.toContain('scrollPaddingTop');
});
