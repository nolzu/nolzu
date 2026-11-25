import { type EvidenceBlock, type EvidenceDay, oneLine, utcDay } from './evidence.ts';

/**
 * A standup a person pastes to their team: Yesterday, Today and Blocked.
 *
 * Pure, the way `evidence.ts` and `timesheet.ts` are. It takes what the screen already gathered and
 * gives back one string, so the text and the screen can never say different things.
 *
 * Every line under Yesterday is the block's own `description`, word for word. The gatherer wrote
 * those words and this module does not write a second version of them: no phase is read back, no
 * verdict is parsed out of English, and nothing is folded into a count. The one day worked out here
 * is the previous working day, and it goes through `utcDay` like every other day.
 *
 * No number goes into the text. Minutes belong to the timesheet and cost belongs to the cost view,
 * and what a run cost is the freelancer's figure, not their team's.
 */

// An empty section says so, rather than leaving a heading with nothing under it. Shorter than
// `NO_EVIDENCE` on purpose: the screen's sentence explains what a block is to somebody using Nolzu,
// and this text is read by people who have never seen it.
export const NO_STANDUP = 'Nothing recorded on this day.';
export const NO_TODAY = 'No card in progress.';
export const NO_BLOCKED = 'Nothing is waiting on an answer.';

// The heading for the blocks of yesterday that belong to no card: a maintenance run, a run whose
// card was deleted, a commit on a branch that matches no card.
export const NO_CARD_GROUP = 'Not on a card';

// Said when the day could not be read whole. Never `EvidenceDay.problem` itself: that sentence
// carries the project folder path, and this text goes to other people. The panel above the box shows
// the full problem to the one person who can fix it.
export const STANDUP_SHORT = 'The commits of this day could not be read, so this list is short of them.';

// The key and the title are both flattened. A person types the title or a ticket adapter writes it,
// and a newline inside one would push the rest onto a line of its own, where it reads as another
// group. The key is usually shape checked, but not on every path: `scoutFindingToCard` in
// `packages/core/src/node/scout-findings.ts` writes an adapter's own key straight through.
const heading = (block: EvidenceBlock): string => {
  if (block.card === null) return NO_CARD_GROUP;
  return block.cardTitle === null ? oneLine(block.card) : `${oneLine(block.card)}, ${oneLine(block.cardTitle)}`;
};

// The source word first, the same word the screen prints beside the block. One rule for all three,
// so a reader never has to tell a move from a run by reading the sentence: a commit subject comes
// from outside the app and can itself start with "Moved". A commit also carries its short sha, which
// is the one thing the standup shows that the timeline does not.
//
// The description is flattened for the same reason the heading is. A commit subject is written by
// whoever made the commit, and a multi line one would otherwise write lines this list never counted.
const line = (block: EvidenceBlock): string =>
  `- ${block.source}${block.source === 'commit' ? ` ${block.ref}` : ''}: ${oneLine(block.description)}`;

/**
 * A card on the board as it stands now, for Today and Blocked. The gatherer picks the cards that are
 * past their board's first stage and not archived, and writes the stage the way the board names it.
 */
export interface StandupCard {
  key: string;
  title: string;
  stage: string;
  // Waiting on a question a run asked, which is the card state `blocked`.
  blocked: boolean;
}

export interface Standup {
  // The day the standup is for, `YYYY-MM-DD` in UTC.
  day: string;
  // The blocks of `previousWorkingDay(day)`.
  yesterday: EvidenceDay;
  cards: readonly StandupCard[];
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const at = (day: string): Date => new Date(`${day}T00:00:00Z`);

/**
 * The working day before `day`. Monday, Saturday and Sunday all read Friday, because a standup on
 * Monday is about the work before the weekend.
 */
export function previousWorkingDay(day: string): string {
  const date = at(day);
  // Limit: Monday to Friday is the working week. A person with another week or a public holiday
  // edits the box; a setting for it waits until somebody asks.
  const back = { 0: 2, 1: 3, 6: 1 }[date.getUTCDay()] ?? 1;
  date.setUTCDate(date.getUTCDate() - back);
  return utcDay(date.toISOString());
}

const cardLine = (card: StandupCard): string => `- ${oneLine(card.key)}, ${oneLine(card.title)} (${oneLine(card.stage)})`;

/**
 * The standup as text.
 *
 * Yesterday is the previous working day's blocks grouped by card, because a standup is about work
 * items. Inside a group the blocks keep the order `evidenceDays` put them in: sorting again would be
 * a second rule that can disagree with the timeline. The group with no card comes last, because it
 * is not work anybody is waiting for.
 *
 * Today and Blocked are the board as it stands now, never the board on the day. A blocked card is
 * under Blocked only, so a team does not read it as work that is moving.
 */
export function standupText(standup: Standup): string {
  return standupTextOf(standupLists(standup));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The three lists the Evidence screen draws, each the lines under its heading in `standupText`.
 * `yesterdayLabel` is the day as the screen's label says it, "Fri 9 Oct".
 */
export interface StandupLists {
  day: string;
  yesterdayDay: string;
  yesterdayLabel: string;
  yesterday: string;
  today: string;
  blocked: string;
}

export function standupLists(standup: Standup): StandupLists {
  const { yesterday } = standup;
  // Limit: a linear scan per block, because a day holds dozens of blocks. Group into a Map keyed
  // by card if a day ever holds thousands.
  const groups: { card: string | null; lines: string[] }[] = [];
  for (const block of yesterday.blocks) {
    const mine = groups.find((one) => one.card === block.card);
    if (mine === undefined) groups.push({ card: block.card, lines: [heading(block), line(block)] });
    else mine.lines.push(line(block));
  }
  const ordered = [...groups].sort((a, b) => (a.card === null ? 1 : b.card === null ? -1 : 0));

  const past = [...(yesterday.problem === null ? [] : [STANDUP_SHORT]), ...(ordered.length === 0 ? [NO_STANDUP] : ordered.flatMap((one) => one.lines))];
  const moving = standup.cards.filter((card) => !card.blocked).map(cardLine);
  const stuck = standup.cards.filter((card) => card.blocked).map(cardLine);
  const date = at(yesterday.day);

  return {
    day: standup.day,
    yesterdayDay: yesterday.day,
    yesterdayLabel: `${WEEKDAYS[date.getUTCDay()]?.slice(0, 3)} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`,
    yesterday: past.join('\n'),
    today: (moving.length === 0 ? [NO_TODAY] : moving).join('\n'),
    blocked: (stuck.length === 0 ? [NO_BLOCKED] : stuck).join('\n'),
  };
}

// The three lists as the one text a person pastes, the lists as they stand, edits and all.
export function standupTextOf(lists: StandupLists): string {
  // No trailing newline: the person pastes this into a message box.
  return [
    `Standup, ${lists.day}, the UTC day`,
    `Yesterday (${WEEKDAYS[at(lists.yesterdayDay).getUTCDay()]} ${lists.yesterdayDay}):\n${lists.yesterday}`,
    `Today:\n${lists.today}`,
    `Blocked:\n${lists.blocked}`,
  ].join('\n\n');
}
