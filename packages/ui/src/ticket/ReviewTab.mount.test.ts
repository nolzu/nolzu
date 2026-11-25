import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import { parseRound, type ReviewBlock } from './review.ts';
import ReviewTab from './ReviewTab.svelte';

const THREE = `issue: src/recipes/import.ts:88
A recipe file with no ingredients throws, so one bad file stops the whole import. Return an empty
list here and let the caller name the file it came from.

suggestion: src/recipes/import.ts:120
The caller reads the same file twice. Read it once and pass the parsed recipe down.

praise: src/recipes/list.ts:14
The list reads in one pass and names the file its error came from.
`;

const found = parseRound(THREE);
const blocks: ReviewBlock[] = found.ok ? found.blocks : [];

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

function draw(oncopy: (text: string) => Promise<string | null>, over: Record<string, unknown> = {}) {
  page = mounted(ReviewTab as never, {
    rounds: [{ number: 1 }],
    current: 1,
    blocks,
    problem: null,
    read: [{ number: 1, blocks }],
    reviewer: { decision: 'CHANGES_REQUESTED', author: 'dana', draft: false },
    oncopy,
    ...over,
  });
  const target = page.target;
  return { target, button: (index: number) => target.querySelector<HTMLButtonElement>(`[data-copy="${index}"]`)! };
}

// A round in the shape the skill writes now: the place beside the comment, the subject over the
// discussion, and Copy hands over the comment alone, without its place.
it('shows the place beside a located comment and copies the comment without it', async () => {
  const read = parseRound('src/recipes/import.ts:88-92\nissue (blocking): An empty file stops the import\n\nReturn an empty list here.\n');
  const located = read.ok ? read.blocks : [];
  const oncopy = vi.fn<(text: string) => Promise<string | null>>(async () => null);
  const ui = draw(oncopy, { blocks: located, read: [{ number: 1, blocks: located }] });

  expect(ui.target.querySelector('.at')?.textContent).toBe('src/recipes/import.ts:88-92');
  expect(ui.target.querySelector('[data-subject]')?.textContent).toBe('An empty file stops the import');
  ui.button(0).click();
  await settle();

  expect(oncopy).toHaveBeenCalledWith('issue (blocking): An empty file stops the import\n\nReturn an empty list here.');
  expect(ui.target.textContent).toContain('Paste it into the pull request at src/recipes/import.ts:88-92.');
});

// What a person does next is paste the block into the pull request, so the button hands over the
// block exactly as the file holds it, label and all, over as many lines as it has.
it('hands the whole block over, byte for byte, when Copy is clicked', async () => {
  const oncopy = vi.fn<(text: string) => Promise<string | null>>(async () => null);
  const ui = draw(oncopy);

  ui.button(0).click();
  await settle();

  expect(oncopy).toHaveBeenCalledTimes(1);
  expect(oncopy).toHaveBeenCalledWith(
    'issue: src/recipes/import.ts:88\nA recipe file with no ingredients throws, so one bad file stops the whole import. Return an empty\nlist here and let the caller name the file it came from.',
  );
  expect(ui.target.textContent).toContain('on the clipboard');
});

it('copies the block that was clicked and not the first one', async () => {
  const oncopy = vi.fn<(text: string) => Promise<string | null>>(async () => null);
  const ui = draw(oncopy);

  ui.button(2).click();
  await settle();

  expect(oncopy).toHaveBeenCalledWith(blocks[2]?.text);
  expect(oncopy.mock.calls[0]?.[0]).toContain('praise:');
});

// A refused clipboard says so. A button that answers nothing reads as a button that did nothing.
it('shows the sentence the copy was refused with', async () => {
  const ui = draw(async () => 'The block was not copied. The browser refused the clipboard.');

  ui.button(1).click();
  await settle();

  expect(ui.target.textContent).toContain('The browser refused the clipboard');
});

// A screen reader reads the buttons of a page as a list. Three buttons all called Copy name nothing,
// so each one's accessible name carries its label and the place the finding is about.
it('names every copy button after the block it copies', () => {
  const ui = draw(async () => null);

  expect([0, 1, 2].map((index) => ui.button(index).getAttribute('aria-label'))).toEqual([
    'Copy the issue block for src/recipes/import.ts:88',
    'Copy the suggestion block for src/recipes/import.ts:120',
    'Copy the praise block for src/recipes/list.ts:14',
  ]);
});
