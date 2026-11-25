import { expect, it } from 'vitest';
import { type RunEvent, type RunTokens, tokensSoFar } from './run.ts';

const counts = (input: number, output: number): RunTokens => ({ input, output, cacheRead: 9000, cacheCreation: 400 });
const usage = (id: string | null, input: number, output: number): RunEvent => ({ type: 'usage', id, tokens: counts(input, output) });

it('reports no count for a run whose engine reported no usage', () => {
  expect(tokensSoFar([{ type: 'text', text: 'Reading the list.' }])).toBeNull();
  expect(tokensSoFar([])).toBeNull();
});

it('adds input and output of each call, and leaves the cache counts out the way the strip does', () => {
  expect(tokensSoFar([usage('msg_1', 2, 300), usage('msg_2', 3, 500)])).toBe(805);
});

// Claude Code writes one line per content block and the call's whole usage on each, so a call that
// said something and used a tool arrives twice with the same counts.
it('counts a call named twice once, with its last counts', () => {
  expect(tokensSoFar([usage('msg_1', 2, 300), usage('msg_1', 2, 300), usage('msg_2', 3, 500)])).toBe(805);
  expect(tokensSoFar([usage('msg_1', 2, 100), usage('msg_1', 2, 300)])).toBe(302);
});

it('counts every event of an engine that names no call', () => {
  expect(tokensSoFar([usage(null, 13_201, 27), usage(null, 13_014, 71)])).toBe(26_313);
});

it('tells each change of the total by the place of its event, and nothing for a repeat', () => {
  const heard: [number, number][] = [];
  tokensSoFar([usage('msg_1', 2, 300), { type: 'text', text: 'Done.' }, usage('msg_1', 2, 300), usage('msg_2', 3, 500)], (at, total) => heard.push([at, total]));

  expect(heard).toEqual([
    [0, 302],
    [3, 805],
  ]);
});
