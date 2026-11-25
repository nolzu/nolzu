import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import Block from './Block.svelte';

const children = createRawSnippet(() => ({ render: () => '<p>The body.</p>' }));
const draw = (props: { fold?: boolean; open?: boolean; peek?: string | readonly string[] }) => render(Block, { props: { id: 'one', title: 'One', peek: 'A preview.', children, ...props } }).body;

// Only a block that folds can hide its body. A block with no fold button never hides it, whatever
// `open` says, or the body would be gone with no way to open it.
it('hides the body only on a block that folds and starts folded', () => {
  expect(draw({ fold: true, open: false })).toMatch(/<div class="body[^"]*" id="one-body" hidden/);
  expect(draw({ fold: false, open: false })).not.toMatch(/id="one-body" hidden/);
  expect(draw({ fold: false, open: false })).not.toContain('A preview.');
  expect(draw({ fold: true, open: true })).not.toMatch(/id="one-body" hidden/);
});

// A list of steps reads as sentences: a step with no full stop gets one, and one that has it keeps one.
it('joins a list preview as sentences', () => {
  expect(draw({ fold: true, open: false, peek: ['Load the stack.', 'Type pasta', ' '] })).toMatch(/<p class="peek[^"]*">Load the stack\. Type pasta\.<\/p>/);
});
