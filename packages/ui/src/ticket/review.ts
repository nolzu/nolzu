import { blockPlace, type PullDecision, type ReviewBlock } from '@nolzu/protocol';

// The round file's reader lives in the protocol package, so the output check counts the same blocks
// the page draws. Here are the page's rules over its blocks.
export { blockPlace, isBlocking, normaliseRound, parseRound, ROUND_DECORATIONS, ROUND_LABELS, type ReviewBlock, type RoundLabel, type RoundRead } from '@nolzu/protocol';

// The word carries the decision, because colour alone says nothing to a reader who cannot tell the
// chips apart. "Waiting on review" and not an empty chip: a pull request nobody has decided on must
// never read as one that is approved. It is not "No review yet" either, because GitHub answers no
// decision for a review left as a comment and for an approval that was dismissed, and both of those
// are reviews.
export const DECISION_WORD: Record<PullDecision, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  REVIEW_REQUIRED: 'Waiting on review',
};

// One round's blocks with its number, as the page hands them over.
export interface RoundBlocks {
  number: number;
  blocks: readonly ReviewBlock[];
}

// A finding of the newest round, with the round that first raised it.
export interface OpenFinding {
  block: ReviewBlock;
  since: number;
}

// A finding an earlier round raised and a later one no longer did: the round that raised it, and the
// round it went in. The block is the last one that carried it.
export interface FixedFinding extends OpenFinding {
  fixedIn: number;
}

export interface RoundsDiff {
  // The newest round's blocks, in the order that round wrote them.
  open: readonly OpenFinding[];
  // Oldest fix first. Never a praise block: praise is nothing to fix, so a round that does not repeat
  // it fixed nothing.
  fixed: readonly FixedFinding[];
}

/**
 * Which block of `now` is which block of `before`, as pairs of their places in each list.
 *
 * What a round stores for a finding is its label, its file, its line and its words. Two blocks are
 * the same finding when the label and the file match, and of those the nearest line wins. The line
 * only ranks: the author edits the file between two rounds, so every line below the edit moves. The
 * words take no part, because a second round rewords what it found. The place in the list takes no
 * part either; it only breaks a tie between two lines equally near.
 *
 * Limit: greedy, nearest pair first. Two findings of one label in one file that an edit swapped
 * can pair the wrong way round. The counts stay right and only which one reads as fixed is off; the
 * body is what would tell them apart, and that is what a round rewrites.
 */
function pairs(before: readonly ReviewBlock[], now: readonly ReviewBlock[]): Map<number, number> {
  const near: { now: number; before: number; distance: number }[] = [];
  now.forEach((block, at) => {
    before.forEach((other, from) => {
      if (block.label === other.label && block.path === other.path) near.push({ now: at, before: from, distance: Math.abs((block.line ?? 0) - (other.line ?? 0)) });
    });
  });
  near.sort((one, other) => one.distance - other.distance);
  const paired = new Map<number, number>();
  const taken = new Set<number>();
  for (const one of near) {
    if (paired.has(one.now) || taken.has(one.before)) continue;
    paired.set(one.now, one.before);
    taken.add(one.before);
  }
  return paired;
}

/**
 * The last round given, against every round before it.
 *
 * The rounds come oldest first, and each is compared with the one before it in the list, so a
 * finding carried through three rounds is open since the first. A round missing from the list, such
 * as one that cannot be read, is passed over rather than read as empty, which would call every
 * finding before it fixed. Nothing is read here.
 */
export function diffRounds(rounds: readonly RoundBlocks[]): RoundsDiff {
  let open: OpenFinding[] = [];
  const fixed: FixedFinding[] = [];
  for (const round of rounds) {
    const before = open;
    const paired = pairs(
      before.map((one) => one.block),
      round.blocks,
    );
    const kept = new Set(paired.values());
    before.forEach((one, at) => {
      if (!kept.has(at) && one.block.label !== 'praise') fixed.push({ ...one, fixedIn: round.number });
    });
    open = round.blocks.map((block, at) => ({ block, since: before[paired.get(at) ?? -1]?.since ?? round.number }));
  }
  return { open, fixed };
}

// The words beside a finding of the shown round.
export const ageWord = (one: OpenFinding, round: number): string => (one.since === round ? `new in round ${round}` : `open since round ${one.since}`);

// The one line the fixed findings fold into, named by the round that raised them.
export function fixedLine(fixed: readonly FixedFinding[]): string {
  const from = new Set(fixed.map((one) => one.since));
  const where = from.size === 1 ? `round ${fixed[0]?.since ?? ''}` : 'earlier rounds';
  return fixed.length === 1 ? `1 finding from ${where} is fixed` : `${fixed.length} findings from ${where} are fixed`;
}

/**
 * A round as one text for a pull request on GitHub: every block as a conventional comment with its
 * place on the line above it, one blank line between two. One comment pasted on its own is its text
 * alone; in one text for the whole round the place says where each one is.
 */
export const conventionalComments = (blocks: readonly ReviewBlock[]): string =>
  blocks.map((block) => (block.subject === null ? block.text : `${blockPlace(block) ?? ''}\n${block.text}`)).join('\n\n');

export interface RereviewFacts {
  // The pull request author's login.
  author: string | null;
  // The round the last review wrote, null before the first.
  round: number | null;
  // The commits pushed since that round read the head: 0 when the last read saw the same head, and
  // null when no head is known for the round.
  pushed: number | null;
  // The findings that round left open, praise not counted.
  open: number;
}

const counted = (count: number, word: string): string => (count === 1 ? `1 ${word}` : `${count} ${word}s`);

/**
 * Why another review round makes sense, or why it reads the same code, for the decision panel. Null when
 * there is nothing to say: before the first round, or with no push known and nothing left open.
 */
export function rereviewWhy(facts: RereviewFacts): string | null {
  const { author, round, pushed, open } = facts;
  if (round === null) return null;
  const said = [
    pushed === null
      ? null
      : pushed > 0
        ? `${author ?? 'The author'} pushed ${counted(pushed, 'commit')} after round ${round}.`
        : `The last Read pull requests saw no push after round ${round}. Another round would read the same code.`,
    open > 0 ? `${counted(open, 'finding')} from round ${round} ${open === 1 ? 'is' : 'are'} still open.` : null,
  ].filter((one) => one !== null);
  return said.length === 0 ? null : said.join(' ');
}
