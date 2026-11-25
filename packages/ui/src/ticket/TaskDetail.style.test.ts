import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The first row's button sat on the line the table row above draws, so the first row keeps its padding.
it('keeps the top padding of the first property row', () => {
  const style = readFileSync(new URL('./TaskDetail.svelte', import.meta.url), 'utf8');

  expect(/\.prop:first-child \{([^}]*)\}/.exec(style)?.[1]).not.toContain('padding-top');
});
