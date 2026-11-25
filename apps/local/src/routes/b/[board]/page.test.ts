import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
// The stub vitest aliases `$app/paths` to. By path and not by that name, because the app's types for
// `$app/paths` are SvelteKit's own and carry no `drawnAt`.
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';
import BoardOff from '$lib/BoardOff.svelte';

const { load } = await import('./+page.ts');
type Event = { params: { board: string }; parent: () => Promise<{ offBoards: readonly string[] }> };
const page = load as unknown as (event: Event) => Promise<{ off: string | null }>;
const at = (board: string, offBoards: readonly string[] = []): Event => ({ params: { board }, parent: async () => ({ offBoards }) });

// The route draws the board, or says it is off. Nothing here reads or writes a card, so the cards of
// an off board are where they were when it is on again.
it('says a board is off, and draws one that is on', async () => {
  expect(await page(at('epics', ['epics', 'questions']))).toEqual({ off: 'epics' });
  expect(await page(at('prreview', ['epics']))).toEqual({ off: null });
  expect(await page(at('delivery', ['epics']))).toEqual({ off: null });
});

// The two kinds of the Research board had boards of their own, so a saved link goes on to it, on or off.
it.each(['investigations', 'questions'])('sends the old /b/%s link on to Research', async (board) => {
  await expect(page(at(board))).rejects.toMatchObject({ status: 308, location: '/b/research' });
  await expect(page(at(board, ['questions', 'investigations']))).rejects.toMatchObject({ status: 308, location: '/b/research' });
});

it('keeps the 404 for a board that is not one of the five', async () => {
  await expect(page(at('recipes'))).rejects.toMatchObject({ status: 404, body: { message: 'There is no recipes board. The Delivery board is at /b/delivery.' } });
});

it('says the board is off, that its cards are kept, and where to turn it on', () => {
  drawnAt('/b/epics');
  const { body, head } = render(BoardOff, { props: { kind: 'epics' } });

  expect(head).toContain('<title>Epics · Nolzu</title>');
  expect(body).toContain('The Epics board is off, so the rail does not show it. Its cards stay as they are until it is on again.');
  expect(body).toContain('href="../settings/project#boards"');
  expect(body).toContain('Turn it on in Settings, Project');
});

// The route's own choice, which the load alone does not prove. Read and not drawn, because the board
// page needs SvelteKit's navigation, which no test here has.
it('draws the off page for an off board, and the board for one that is on', () => {
  const route = readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../../+layout.server.ts', import.meta.url), 'utf8');

  expect(route).toMatch(/\{#if data\.off === null\}\s*<BoardPage \/>\s*\{:else\}\s*<BoardOff kind=\{data\.off\} \/>\s*\{\/if\}/);
  expect(layout).toContain("offBoards: getSetting(database(), 'offBoards')");
});
