import { mergeSpend, type Spend } from './spend.ts';

// Where a block came from. The word is printed beside the block, so status is never colour alone.
export type EvidenceSource = 'run' | 'move' | 'commit';

/**
 * One thing that happened, as the Evidence screen shows it.
 *
 * Worked out from the rows each time, and never stored: a derived block cannot go stale, and
 * nothing writes a block a query cannot work out.
 *
 * A block arrives finished. Whoever gathers it writes its words, because a stage label and a phase
 * label need the board and this package does not hold one. This module only groups and orders.
 */
export interface EvidenceBlock {
  // When it happened, as a UTC stamp with the Z on it. A run's start, a move's time, a commit's
  // committer date read back in UTC. The day it belongs to is its first ten characters, so every
  // source has to be converted before it gets here or two blocks sort against each other wrongly.
  start: string;
  source: EvidenceSource;
  // The run id, the move id or the short sha, as text. It names the block in a test and in a key.
  ref: string;
  // The card this belongs to, and only when that card is still on the board, because the screen
  // links it. Null for a maintenance run, for a run whose card was deleted, and for a commit on no
  // card branch. The line then says who the work was for instead.
  card: string | null;
  cardTitle: string | null;
  // The one line the screen prints.
  description: string;
  // What the engine reported, never the wall clock between the two stamps. The two are different
  // numbers, and the roll-up reads this one, so a timeline measuring the other would disagree with
  // the cost report about the same run. Null on a move, on a commit, and on a run that reported
  // none. A timesheet rounds this to minutes once, in its own column.
  durationMs: number | null;
  // Run blocks only, so a day's total is these merged and never a fresh sum.
  spend: Spend | null;
  // A run that has not ended. It shows no cost and no duration rather than a nought.
  running: boolean;
}

/** One day of blocks, in the order they happened. */
export interface EvidenceDay {
  // `YYYY-MM-DD`, the UTC day.
  day: string;
  // Earliest first, which is how a person walks back through their own day and how a timesheet
  // reads down its column.
  blocks: EvidenceBlock[];
  // The run blocks merged. Merged and not summed again, so this day and the same day in the cost
  // report agree to the cent.
  spend: Spend;
  // What could not be read, in a sentence, or null when everything answered. The fold knows nothing
  // about how the blocks were gathered, so it always writes null and the gatherer fills it in. An
  // unread source has to say so: drawn as an empty day it tells a person nothing happened on a day
  // they worked.
  problem: string | null;
}

// An empty day is a sentence rather than an empty frame. Named here beside the shapes,
// so a test reads the words without mounting anything.
export const NO_EVIDENCE = 'Nothing recorded on this day. A block appears when a run starts, a card moves or a commit lands.';

// The day a stamp belongs to, which is the expression `spendReport` groups a run by. Named here, in
// the module that owns the rule, so the fold below, the timesheet and the gatherers all read one
// line. A run over midnight belongs to the day it started and to no other.
export const utcDay = (stamp: string): string => stamp.slice(0, 10);

/**
 * Whether a string is a day this code can work with: `YYYY-MM-DD`, and a day that exists.
 *
 * The shape on its own is not enough. `2026-13-01` matches it and becomes an Invalid Date, so
 * `weekOf` and the evidence window throw on it, and `2026-02-30` quietly rolls over to 2 March. The
 * day is built and read back, which catches both. Beside `utcDay`, because a caller that reads a day
 * off a URL needs the same rule the rest of this module folds by.
 */
export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && utcDay(at.toISOString()) === value;
}

/**
 * One line of text, from something a person or an outside system wrote.
 *
 * A card title is typed into a form or written by a ticket adapter, and a commit subject comes from
 * whoever made the commit, so neither is ours to trust. The standup and the weekly report are read
 * as lines, and a newline inside one of those values writes lines the text never counted. Worse than
 * untidy: a subject that starts a line of its own can forge a heading in a message somebody sends to
 * their team.
 *
 * One space in place of any run of newlines, and nothing else. This is not the `flat` in
 * `timesheet.ts`, which also guards a spreadsheet against a leading equals sign. That guard belongs
 * to a CSV and would put a stray apostrophe in front of a title in plain text.
 */
export const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ');

// Two things in the same millisecond. A move is written in the transaction that starts the run, so
// the move comes first, and a commit is the last thing a piece of work does.
const RANK: Readonly<Record<EvidenceSource, number>> = { move: 0, run: 1, commit: 2 };

/**
 * The blocks grouped into days, newest day first.
 *
 * The day is the first ten characters of `start`, which is the expression `spendReport` groups a
 * run by, so the timeline and the cost report never disagree about which day a run belongs to. A
 * run over midnight belongs to the day it started and to no other.
 *
 * Blocks that fall on the same millisecond and the same source keep the order they arrived in,
 * because the sort is stable, so the screen draws them the same way on every load. The caller hands
 * them over oldest id first.
 */
export function evidenceDays(blocks: readonly EvidenceBlock[]): EvidenceDay[] {
  const days = new Map<string, EvidenceBlock[]>();
  for (const block of blocks) {
    const day = utcDay(block.start);
    const mine = days.get(day);
    if (mine === undefined) days.set(day, [block]);
    else mine.push(block);
  }

  return [...days]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, mine]) => ({
      day,
      blocks: [...mine].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : RANK[a.source] - RANK[b.source])),
      spend: mergeSpend(mine.flatMap((block) => (block.spend === null ? [] : [block.spend]))),
      problem: null,
    }));
}
