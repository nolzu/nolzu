import { expect, it } from 'vitest';
import { type EvidenceBlock, type EvidenceSource, evidenceDays, isDay, NO_EVIDENCE, oneLine } from './evidence.ts';
import { spendOf } from './spend.ts';

// A block the way the gatherer hands one over. Only the fields the fold reads are worth setting
// here; the words are the gatherer's job and its own tests cover them.
const block = (start: string, source: EvidenceSource, ref: string, over: Partial<EvidenceBlock> = {}): EvidenceBlock => ({
  start,
  source,
  ref,
  card: 'APP-1',
  cardTitle: 'Add a search box',
  description: `${source} ${ref}`,
  durationMs: null,
  spend: source === 'run' ? spendOf([{ costUsd: 0.02, durationMs: 60_000, tokens: null }]) : null,
  running: false,
  ...over,
});

const named = (blocks: readonly EvidenceBlock[]) => blocks.map((one) => `${one.source} ${one.ref}`);

// The main case. Three runs, two moves and one commit, handed over out of order, come
// back as one day in the order they happened.
it('puts a day of three runs, two moves and a commit in the order they happened', () => {
  const days = evidenceDays([
    block('2026-09-27T09:00:00.000Z', 'move', '1'),
    block('2026-09-27T12:10:00.000Z', 'move', '2'),
    block('2026-09-27T09:00:01.000Z', 'run', '1'),
    block('2026-09-27T14:45:00.000Z', 'run', '3'),
    block('2026-09-27T12:10:02.000Z', 'run', '2'),
    block('2026-09-27T16:20:00.000Z', 'commit', 'a1b2c3d'),
  ]);

  expect(days).toHaveLength(1);
  expect(days[0]?.day).toBe('2026-09-27');
  expect(named(days[0]?.blocks ?? [])).toEqual(['move 1', 'run 1', 'move 2', 'run 2', 'run 3', 'commit a1b2c3d']);
});

// The empty day is a state the screen says in words. The fold has no day to give back at all, and
// the gatherer is the one that makes the empty one.
it('gives no day back when nothing happened', () => {
  expect(evidenceDays([])).toEqual([]);
});

// The literal, not the constant. The one reader of this sentence compares it with itself, so the
// words a person reads on an empty day had no test at all, and half the sentence is the half that
// says what puts a block here.
it('tells a person what puts a block on a day with nothing on it', () => {
  expect(NO_EVIDENCE).toBe('Nothing recorded on this day. A block appears when a run starts, a card moves or a commit lands.');
});

// The rule `spendReport` uses, pinned here as well: the first ten characters of the UTC stamp. A
// run at 23:30 and one at 00:30 the next morning are two days and not one evening.
it('splits the day at midnight UTC', () => {
  const days = evidenceDays([block('2026-09-27T23:30:00.000Z', 'run', '1'), block('2026-09-28T00:30:00.000Z', 'run', '2')]);

  expect(days.map((one) => one.day)).toEqual(['2026-09-28', '2026-09-27']);
  expect(named(days[1]?.blocks ?? [])).toEqual(['run 1']);
});

// Two events in the same millisecond. The order is the same on every load, so the screen never
// shuffles: the move that started a run comes before the run, and two rows of one source keep the
// order they arrived in.
it('keeps a stable order for blocks on the same millisecond', () => {
  const same = '2026-09-27T09:00:00.000Z';
  const blocks = [block(same, 'commit', 'aaa1111'), block(same, 'run', '7'), block(same, 'run', '4'), block(same, 'move', '3')];

  expect(named(evidenceDays(blocks)[0]?.blocks ?? [])).toEqual(['move 3', 'run 7', 'run 4', 'commit aaa1111']);
  // The same blocks folded again give the same answer, which is what a second page load is.
  expect(named(evidenceDays(blocks)[0]?.blocks ?? [])).toEqual(['move 3', 'run 7', 'run 4', 'commit aaa1111']);
});

// The day total is the run blocks merged, so it agrees to the cent with the same day in the cost
// report. A move and a commit cost nothing and are not runs, so neither is counted.
it('adds up the run blocks only, and merges them rather than summing again', () => {
  const day = evidenceDays([
    block('2026-09-27T09:00:00.000Z', 'run', '1'),
    block('2026-09-27T10:00:00.000Z', 'run', '2'),
    block('2026-09-27T11:00:00.000Z', 'move', '1'),
    block('2026-09-27T12:00:00.000Z', 'commit', 'a1b2c3d'),
  ])[0];

  expect(day?.spend.runs).toBe(2);
  expect(day?.spend.costUsd).toBeCloseTo(0.04, 10);
  expect(day?.spend.partial).toBe(false);
});

// The fold is handed finished blocks and knows nothing about where they came from, so it never
// invents a problem. The gatherer fills that in when a source would not answer.
it('reports no problem of its own', () => {
  expect(evidenceDays([block('2026-09-27T09:00:00.000Z', 'run', '1')])[0]?.problem).toBeNull();
});

// A URL a person edited by hand reaches here. A string that only has the shape of a day becomes an
// Invalid Date, and the callers that build a week or a day window off it throw on it.
it('takes a day that exists and refuses one that does not', () => {
  expect(isDay('2026-09-27')).toBe(true);
  expect(isDay('2026-02-28')).toBe(true);

  for (const bad of ['2026-13-01', '2026-00-10', '2026-01-32', '2026-99-99', '2026-02-30', 'last', '', '2026-9-7']) {
    expect(isDay(bad)).toBe(false);
  }
});

// The helper the standup and the weekly report both fold a title through. It is one rule and not two,
// because the two texts would otherwise drift on the value that is least ours to trust.
it('folds any run of newlines in a value written outside this app into one space', () => {
  expect(oneLine('Add a search box')).toBe('Add a search box');
  expect(oneLine('Add a search box\nAPP-9, Ship it')).toBe('Add a search box APP-9, Ship it');
  expect(oneLine('one\r\ntwo')).toBe('one two');
  expect(oneLine('one\n\n\ntwo')).toBe('one two');
  // Not the CSV guard: a leading equals sign is a spreadsheet's problem and not plain text's.
  expect(oneLine('=SUM(A1)')).toBe('=SUM(A1)');
});

