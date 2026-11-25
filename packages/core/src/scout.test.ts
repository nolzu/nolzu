import { describe, expect, it } from 'vitest';
import { dedup, fingerprint, normalize } from './scout.ts';

/**
 * The pure half of the Scout pipeline.
 *
 * Nothing here calls an engine. Fetching, counting, pattern matching and change detection are
 * plain code, and the agent runs only when something new or changed appears. So the whole value of
 * this module is that two lines which are the same event collapse to one fingerprint, and two lines
 * which are not, do not.
 */
const line = (id: string, ms: number) =>
  `2026-09-26T14:0${ms}:11.482Z ERROR recipes.api request ${id} failed: timeout after ${ms}000ms`;

describe('normalize', () => {
  // The three things a log line carries that change on every occurrence of one event. A fingerprint
  // that kept them would make one finding per line, which is the noise Scout exists to remove.
  it('collapses two lines of one event that differ only in an id, a timestamp and a number', () => {
    expect(normalize(line('7f3a1c', 1))).toBe(normalize(line('90bb42', 8)));
  });

  // The other side. Two lines that are two events stay apart, or Scout would fold real problems
  // into one finding and a person would never see the second.
  it('keeps two lines that are two events apart', () => {
    expect(normalize('recipes.api request failed: timeout')).not.toBe(normalize('recipes.api request failed: refused'));
  });

  // Each of these made two findings where there is one event, or one where there are two. An id shorter than six characters used to keep its letters and lose
  // its digits, so every short request id made a finding of its own: ten thousand lines of one
  // event came out as six hundred and seventy three.
  it.each([
    ['a short hex id', 'recipes.api request 2a3f failed', 'recipes.api request 1a2b failed'],
    ['a number that crosses six digits', 'timeout after 5000 ms', 'timeout after 120000 ms'],
    ['a line and a column', 'at listRecipes (recipes/api/list.ts:40:12)', 'at listRecipes (recipes/api/list.ts:412:12)'],
    ['a host and a port', 'upstream 10.0.0.1:80 refused', 'upstream 10.0.0.1:8080 refused'],
  ])('reads two lines that differ in %s as one event', (_what, one, other) => {
    expect(normalize(one)).toBe(normalize(other));
  });

  // The other direction, which is the worse one: a word made of the letters a to f is not an id,
  // and reading it as one folded two real problems into a single finding.
  it.each(['decade', 'facade', 'accede', 'deface', 'beefed'])('leaves the word %s alone', (word) => {
    expect(normalize(`the ${word} cache failed`)).toContain(word);
    expect(normalize(`the ${word} cache failed`)).not.toBe(normalize('the beadfed cache failed'));
  });

  it.each([
    ['an ISO timestamp', '2026-09-26T14:02:11.482Z started', '2026-09-24T09:41:02.001Z started'],
    ['a clock time', 'at 14:02:11 the worker woke', 'at 09:41:02 the worker woke'],
    ['a uuid', 'card 9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7 failed', 'card a1b2c3d4-0000-4000-8000-000000000001 failed'],
    ['a long hex id', 'commit 4f9a0b7c1d2e3f405162738495a6b7c8d9e0f102 failed', 'commit 0011223344556677889900aabbccddeeff001122 failed'],
    ['a number', 'retried 3 times', 'retried 117 times'],
    ['a hex address', 'at 0x7ffee3b0 in the parser', 'at 0x00001a2b in the parser'],
  ])('strips %s', (_what, one, other) => {
    expect(normalize(one)).toBe(normalize(other));
  });

  // The shape and not only the equality. A person reads this text on the finding, so a date that
  // came out as three numbers and a clock would be equal for two occurrences and unreadable for
  // everybody. The whole timestamp is one token.
  it('reads a whole timestamp as one token', () => {
    expect(normalize('2026-09-26T14:02:11.482Z started')).toBe('<time> started');
    expect(normalize('2026-09-26 14:02:11+02:00 started')).toBe('<time> started');
  });

  // What is left has to still read as the event, or a person looking at the finding sees nothing
  // they can act on.
  it('leaves the words of the message alone', () => {
    expect(normalize(line('7f3a1c', 1))).toContain('failed: timeout after');
    expect(normalize(line('7f3a1c', 1))).toContain('recipes.api');
  });

  // Whitespace is not an event either. A line wrapped by one collector and not by another is one
  // event, and two fingerprints would be two findings.
  it('reads one run of whitespace as one space', () => {
    expect(normalize('recipes.api   failed\n  again')).toBe(normalize('recipes.api failed again'));
  });
});

describe('fingerprint', () => {
  const item = { sourceKind: 'elasticsearch', errorType: 'TimeoutError', message: line('7f3a1c', 1), location: 'recipes/api/list.ts:40' };

  // The four parts. Each one apart, so an adapter that stops sending
  // one of them cannot quietly widen what counts as the same event.
  it.each(['sourceKind', 'errorType', 'location'] as const)('answers differently when %s differs', (field) => {
    expect(fingerprint({ ...item, [field]: 'something else' })).not.toBe(fingerprint(item));
  });

  it('answers the same for two occurrences of one event', () => {
    expect(fingerprint({ ...item, message: line('90bb42', 8) })).toBe(fingerprint(item));
  });

  // One field, two shapes. A hex id holds a letter about ninety seven times in a hundred and is all
  // digits the rest of the time, and reading the two as different tokens made a second finding for
  // that hundredth occurrence. The message a person reads keeps them apart; the id does not.
  it('answers the same for an id that happens to be all digits', () => {
    const digits = { ...item, message: line('12345678', 1) };
    const mixed = { ...item, message: line('2a3f5678', 1) };

    expect(fingerprint(digits)).toBe(fingerprint(mixed));
    expect(normalize(digits.message)).not.toBe(normalize(mixed.message));
  });

  // The ceiling, written as a test rather than left to be found. An id made only of the letters a
  // to f cannot be told from a word, so it makes a finding of its own. That is the side of the
  // trade Nolzu takes: an extra finding is read and closed, and two real problems folded into one
  // are never seen.
  it('makes a finding of its own for an id that reads as a word', () => {
    expect(fingerprint({ ...item, message: line('deadbe', 1) })).not.toBe(fingerprint({ ...item, message: line('facade', 1) }));
  });

  it('answers differently for two events', () => {
    expect(fingerprint({ ...item, message: 'recipes.api request failed: refused' })).not.toBe(fingerprint(item));
  });

  // A source that groups errors itself, such as Sentry, keeps its own id. Nolzu's own fingerprinting
  // exists for the sources that have none, and using both would split one Sentry issue in two the
  // moment its message text changed.
  it('takes the source own id when the source has one', () => {
    const sentry = { ...item, sourceKind: 'sentry', sourceId: 'RECIPES-API-4F' };

    expect(fingerprint(sentry)).toBe('sentry:RECIPES-API-4F');
    expect(fingerprint({ ...sentry, message: 'a message the vendor reworded' })).toBe(fingerprint(sentry));
  });

  // The id travels into sqlite and into a URL, so it is short, stable and has no character that
  // needs escaping anywhere.
  // The id travels into sqlite and into a URL, so it is short, stable and has no character that
  // needs escaping. Sixteen characters every time, including the lanes that start with a zero,
  // which a single example would not catch.
  it('answers a plain id of one width, whatever it hashed', () => {
    for (let at = 0; at < 200; at += 1) {
      expect(fingerprint({ ...item, location: `recipes/api/list.ts:${at}` })).toMatch(/^[a-z]+:[0-9a-f]{16}$/);
    }
  });

  // A vendor picked the characters of its own id, and this one goes into a URL. A plain id comes
  // through unchanged, and one with a slash or a hash in it is encoded rather than trusted.
  it('encodes a source own id that carries a character a URL would read', () => {
    expect(fingerprint({ ...item, sourceKind: 'sentry', sourceId: 'RECIPES-API-4F' })).toBe('sentry:RECIPES-API-4F');
    expect(fingerprint({ ...item, sourceKind: 'sentry', sourceId: 'a b/c#d' })).toBe('sentry:a%20b%2Fc%23d');
  });

  // An adapter that sends the field and leaves it empty has no grouping of its own, so the id is
  // hashed. Read as an id, every item of that source would fold into one finding.
  it('hashes the item when the source own id is empty', () => {
    const empty = { ...item, sourceKind: 'sentry', sourceId: '' };

    expect(fingerprint(empty)).toMatch(/^sentry:[0-9a-f]{16}$/);
    expect(fingerprint({ ...empty, message: 'another event' })).not.toBe(fingerprint(empty));
  });

  // The same input on another day gives the same id, or every check would make new findings. Held
  // by the value itself, because a test that hashes twice in one process proves nothing about that.
  // The message carries a timestamp, an id and a number on purpose, so the value pins the
  // normalization as well as the hash. A finding's id has to outlive an upgrade: a change to either
  // one gives every stored finding a new id and a duplicate of itself.
  it('answers the same value it answered when this test was written', () => {
    expect(fingerprint({ sourceKind: 'paste', errorType: 'TimeoutError', message: line('7f3a1c', 1), location: 'recipes/api/list.ts:40' })).toBe('paste:9c434a743fd99bb2');
  });
});

/**
 * Many lines, few events.
 *
 * This is the step Scout's promise leans on: a log pattern becomes one finding across many
 * lines. It is pure and runs before anything is stored, so one fetch of ten thousand lines reaches
 * the database as the handful of events behind them.
 */
describe('dedup', () => {
  const at = (id: string, ms: number) => ({ sourceKind: 'elasticsearch', errorType: 'TimeoutError', message: line(id, ms), location: 'recipes/api/list.ts:40' });

  it('folds many lines of one event into one entry that counts them', () => {
    const found = dedup([at('7f3a1c', 1), at('90bb42', 8), at('c0ffee', 3)]);

    expect(found).toHaveLength(1);
    expect(found[0]?.count).toBe(3);
  });

  // The first and the last line are what the finding shows as first and last seen, so both are
  // kept rather than only the newest.
  it('keeps the first line and the last line of the event', () => {
    const found = dedup([at('7f3a1c', 1), at('90bb42', 8)]);

    expect(found[0]?.first.message).toContain('7f3a1c');
    expect(found[0]?.last.message).toContain('90bb42');
  });

  // The other side. Two events stay two entries, in the order they were first seen, so a person
  // reads them the way the source reported them.
  it('keeps two events apart and in the order they first appeared', () => {
    const refused = { ...at('7f3a1c', 1), message: 'recipes.api request failed: refused' };

    expect(dedup([refused, at('90bb42', 8)]).map((one) => one.count)).toEqual([1, 1]);
    expect(dedup([refused, at('90bb42', 8)])[0]?.first.message).toContain('refused');
  });

  it('answers nothing for nothing', () => {
    expect(dedup([])).toEqual([]);
  });
});
