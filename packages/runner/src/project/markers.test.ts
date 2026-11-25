import { expect, it } from 'vitest';
import { readBlock, writeBlock } from './markers.ts';

const START = '<!-- nolzu:start -->';
const END = '<!-- nolzu:end -->';

const withBlock = `# Their heading

Their own words.

${START}
Managed by Nolzu.
${END}

More of their words.
`;

it('finds no block in a file nobody managed', () => {
  expect(readBlock('# Their heading\n\nTheir own words.\n')).toEqual({ body: null, broken: false });
});

it('reads the managed text without its markers', () => {
  expect(readBlock(withBlock)).toEqual({ body: 'Managed by Nolzu.', broken: false });
});

it('replaces only the managed text and keeps everything around it', () => {
  const next = writeBlock(withBlock, 'Something else.');

  expect(next).toContain('Their own words.');
  expect(next).toContain('More of their words.');
  expect(next).toContain('Something else.');
  expect(next).not.toContain('Managed by Nolzu.');
});

it('writes the same bytes when the managed text has not changed', () => {
  expect(writeBlock(withBlock, 'Managed by Nolzu.')).toBe(withBlock);
});

it('appends a block to a file that has none, keeping what was there', () => {
  const theirs = '# Their heading\n\nTheir own words.\n';
  const next = writeBlock(theirs, 'Managed by Nolzu.');

  expect(next.startsWith(theirs)).toBe(true);
  expect(readBlock(next)).toEqual({ body: 'Managed by Nolzu.', broken: false });
});

// Half a block means someone edited the markers, or a write was cut off. Replacing from the start
// marker to the end of the file would take their text with it.
it('reports a start marker with no end as broken, and changes nothing', () => {
  const half = `Their words.\n\n${START}\nManaged by Nolzu.\n`;

  expect(readBlock(half)).toEqual({ body: null, broken: true });
  expect(writeBlock(half, 'Something else.')).toBe(half);
});

it('uses the first block when a file somehow carries two', () => {
  const twice = `${START}\nfirst\n${END}\n\n${START}\nsecond\n${END}\n`;

  expect(readBlock(twice).body).toBe('first');
  expect(writeBlock(twice, 'new').includes('second')).toBe(true);
});

it('keeps a block that holds marker-like text of its own', () => {
  const body = 'A line that mentions nolzu:start in prose.';

  expect(readBlock(writeBlock('', body)).body).toBe(body);
});
