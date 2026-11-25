import type { DiffComment } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import LineComment from './LineComment.svelte';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const comment: DiffComment = {
  id: 3,
  repo: '.',
  file: 'src/lib/RecipeCard.svelte',
  line: 12,
  lineText: '    <div class="img-missing" aria-hidden="true"></div>',
  text: 'Use the placeholder from assets, not a grey box.',
  commit: 'abc1234',
  createdAt: '2000-01-01T00:00:00.000Z',
  sentAt: null,
};
const draw = (props: Record<string, unknown>) => render(LineComment, { props: { comment, line: 12, onsave: async () => null, ondelete: async () => null, ...props } }).body;

it('draws an open comment: who, its line, the text, Edit, Delete and when it goes', () => {
  expect(text(draw({}))).toMatch(/^Y You line 12 · \d+[hd] ago Use the placeholder from assets, not a grey box\. Edit Delete Goes with the next send back$/);
});

it('draws an outdated comment with the line it was made on, in a box and not in a colour', () => {
  const body = draw({ line: null, outdated: true });

  expect(text(body)).toContain('You made on line 12 ·');
  expect(text(body)).toContain('Outdated The line it was made on: <div class="img-missing" aria-hidden="true"></div>'.replace(/</g, '&lt;'));
  expect(body).toContain('data-outdated');
});

it('names an empty line it was made on in words', () => {
  expect(text(draw({ line: null, outdated: true, comment: { ...comment, lineText: '' } }))).toContain('The line it was made on: (an empty line)');
});

it('draws a sent comment with no Edit, and says it went', () => {
  const shown = text(draw({ comment: { ...comment, sentAt: '2000-01-01T00:00:00.000Z' } }));

  expect(shown).not.toContain('Edit');
  expect(shown).toMatch(/Delete Sent back \d+[hd] ago$/);
});

it('draws the field of a new comment with its label, Save comment and Cancel', () => {
  const shown = text(draw({ comment: null, line: 4 }));

  expect(shown).toBe('Comment on line 4 Save comment ⌘↵ Cancel Goes with the next send back');
});

// A date that does not parse names no time, so the line never claims one it does not know.
it('says no time when the date does not parse', () => {
  expect(text(draw({ comment: { ...comment, createdAt: 'later' } }))).toMatch(/^Y You line 12 Use the placeholder/);
  expect(text(draw({ comment: { ...comment, createdAt: 'later', sentAt: 'later' } }))).toMatch(/Delete Sent back$/);
});
