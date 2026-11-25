import { render } from 'svelte/server';
import { expect, it } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';
import BoardOff from '$lib/BoardOff.svelte';

const { load } = await import('./+page.ts');
const page = load as unknown as (event: { parent: () => Promise<{ offBoards: readonly string[] }> }) => Promise<{ off: boolean }>;
const at = (offBoards: readonly string[]) => ({ parent: async () => ({ offBoards }) });

it('draws the board while its kinds are on', async () => {
  expect(await page(at(['epics']))).toEqual({ off: false });
});

// The two kinds are on or off together, so the board is off with them, and its address says so.
it('is off with both its kinds, and says so where the board would be', async () => {
  expect(await page(at(['questions', 'investigations']))).toEqual({ off: true });
  drawnAt('/b/research');
  const { body, head } = render(BoardOff, { props: { kind: 'research' } });
  expect(head).toContain('<title>Research · Nolzu</title>');
  expect(body).toContain('The Research board is off, so the rail does not show it.');
});
