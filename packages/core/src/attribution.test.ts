import { expect, it } from 'vitest';
import { isAttributionLine, withoutAttribution } from './attribution.ts';

// Built from parts, so a plain text search for attribution lines in the repository does not stop here.
const MADE = ['Generated', 'with'].join(' ');
const BY = ['Generated', 'by'].join(' ');
const CO = ['Co', 'Authored', 'By'].join('-');
const ROBOT = '\u{1F916}';

it('knows the lines an engine adds', () => {
  expect(isAttributionLine(`${ROBOT} ${MADE} [Claude Code](https://claude.com/claude-code)`)).toBe(true);
  expect(isAttributionLine(`${MADE} Claude Code`)).toBe(true);
  expect(isAttributionLine(`${CO}: Claude <noreply@anthropic.com>`)).toBe(true);
  expect(isAttributionLine(`${CO.toLowerCase()}: Cursor Agent <cursoragent@cursor.com>`)).toBe(true);
  expect(isAttributionLine(`${BY} Codex`)).toBe(true);
  expect(isAttributionLine('_Created using Nolzu_')).toBe(true);
  expect(isAttributionLine('Made with Cursor Agent')).toBe(true);
  expect(isAttributionLine('Written by an AI assistant.')).toBe(true);
});

// What a footer looks like once an engine dresses it: a robot inside emphasis, a quote, a small tag,
// or a whole sentence about the pull request.
it('knows a footer inside emphasis, a quote, a small tag or a sentence', () => {
  expect(isAttributionLine(`_${ROBOT} ${MADE} Claude Code_`)).toBe(true);
  expect(isAttributionLine(`> ${MADE} [Claude Code](https://claude.com/claude-code)`)).toBe(true);
  expect(isAttributionLine(`<sub>${BY} Codex</sub>`)).toBe(true);
  expect(isAttributionLine(`This PR was ${BY.toLowerCase()} Claude Code.`)).toBe(true);
  expect(isAttributionLine(`This pull request was ${MADE.toLowerCase()} [Claude Code](https://claude.com/claude-code)`)).toBe(true);
});

// A person's own lines stay: no tool right after the verb, a word that is only a word, or a person.
it('keeps a line that only uses a word a tool is also called', () => {
  expect(isAttributionLine('Built using a cursor so long lists page fast.')).toBe(false);
  expect(isAttributionLine('Built with the OpenAI SDK, the client streams replies.')).toBe(false);
  expect(isAttributionLine('Made with cursor paging, the list loads one page at a time.')).toBe(false);
  expect(isAttributionLine('Built with care, as the Claude Code docs suggest.')).toBe(false);
  expect(isAttributionLine(`${BY} the build script.`)).toBe(false);
  expect(isAttributionLine('Built with AI in mind, the search ranks by meaning.')).toBe(false);
  expect(isAttributionLine(`${CO}: Jane Doe <jane@example.com>`)).toBe(false);
  expect(isAttributionLine('The Claude Code docs say the flag is new.')).toBe(false);
  expect(isAttributionLine(`${ROBOT} The robot icon marks bots in the list.`)).toBe(false);
});

it('drops a trailing attribution line with the blank line before it, and keeps the final newline', () => {
  const pr = `Search recipes by title\n\n## What changed\n\nA q option.\n\n${ROBOT} ${MADE} [Claude Code](https://claude.com/claude-code)\n`;
  expect(withoutAttribution(pr)).toBe('Search recipes by title\n\n## What changed\n\nA q option.\n');
});

it('drops several attribution lines and the blank lines between them', () => {
  const text = `A change.\n\n${ROBOT} ${MADE} Claude Code\n\n${CO}: Claude <noreply@anthropic.com>`;
  expect(withoutAttribution(text)).toBe('A change.');
});

it('drops a rule left dangling last above a stripped footer, and keeps a rule with text under it', () => {
  expect(withoutAttribution(`A change.\n\n---\n\n${ROBOT} ${MADE} Claude Code\n`)).toBe('A change.\n');
  expect(withoutAttribution(`Top.\n\n---\n\nBottom.\n\n${MADE} Codex\n`)).toBe('Top.\n\n---\n\nBottom.\n');
});

it('drops one in the middle and leaves one blank line between the paragraphs around it', () => {
  expect(withoutAttribution(`First.\n\n${MADE} Codex\n\nSecond.\n`)).toBe('First.\n\nSecond.\n');
});

it('drops one that opens the text with the blank line after it', () => {
  expect(withoutAttribution(`${MADE} Cursor Agent\n\nThe list has a search box.\n`)).toBe('The list has a search box.\n');
});

it('gives a text with no attribution back exactly as it came', () => {
  const text = 'Line one.  \n\n\n- a\n- b\n\n---\n\nBuilt with the OpenAI SDK, the client streams replies.\n';
  expect(withoutAttribution(text)).toBe(text);
});
