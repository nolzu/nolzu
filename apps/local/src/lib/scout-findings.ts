import type { DatabaseSync } from 'node:sqlite';
import { boardFor } from '@nolzu/core';
import {
  allScoutFindings,
  canStartFinding,
  dismissScoutFinding,
  ENDED,
  getSetting,
  scoutFinding,
  type ScoutFinding,
  type ScoutFindingStatus,
  type ScoutStartBoard,
  scoutSources,
  startScoutFinding,
  unmuteScoutFinding,
  writeSetting,
} from '@nolzu/core/node';
import { assessKey, BOARD_LABELS, type BoardKind, isBoardKind, isResearchKind, ticketRefProblem } from '@nolzu/protocol';
import { dayKey, dayMonth, shortWhen, when } from '$lib/scout-sources.ts';

/**
 * One finding, with every word the screen prints already in it.
 *
 * The two messages are the lines as they were pasted, so a log pasted with a token in it keeps that
 * token here. Drawing them back to the person who pasted them is right. Putting one into a page
 * title, a URL, an aria-label or a log line is not, so neither the row nor the component does that.
 */
export interface ScoutFindingRow {
  id: number;
  // The first line of the newest occurrence. A message can hold a whole stack trace, so the row shows
  // the line and the detail shows the rest.
  title: string;
  // The label of the source that found it.
  source: string;
  // How often it was seen, and when it was seen last. The same word as the detail's labels and as the
  // sentence the Settings screen answers a check with.
  seen: string;
  // The two times, written out, one beside each line on the detail.
  first: string;
  last: string;
  firstMessage: string;
  lastMessage: string;
  // Empty wherever the source names no place, which pasted text never does.
  location: string;
  fingerprint: string;
  // How often and over how long, in the words that follow the source on a row: "seen 12 times in 2
  // days".
  often: string;
  // When it was seen last, in the few characters the row's right edge has: "13:02", "Sat", "9 Oct".
  at: string;
  // The column the finding sits in, in the words a person reads. Printed on the row now that a
  // second word is written: with one word on every row it was furniture.
  status: string;
  // The state pill the inbox draws. Assessing only while the assessment run is going, read off its run
  // rows, because the status word stays `assess` after the run ends. The card key of a started finding
  // is its detail.
  pill: RowPill;
  // Whether an assessment can be started on it. Only a finding nobody has assessed yet, because the
  // status writer moves it out of `new` and a second run of the same finding is a decision a person
  // makes on the detail, not a button that repeats itself.
  canAssess: boolean;
  // The card this finding was started as, or null when it was never started. `here` is false for a
  // card that was deleted: the key is still on the finding, and a link to it would answer nothing,
  // so the screens name it and offer Start again. The board and the column are the words a person
  // reads on the board, and both are empty for a card that is gone, which `here` already says.
  card: { key: string; here: boolean; board: string; stage: string } | null;
  // Whether Start as Delivery can be pressed. The writer in core answers this, so the button cannot
  // appear where the write would refuse it.
  canStart: boolean;
  // Why no card can be made from this finding, or null when one can. A finding a ticket query found
  // carries that ticket's key, and its card takes the key, so a key the card writer refuses means
  // this finding has no card to offer. Worked out from the finding's own columns and not stored, so
  // the row still says it after a reload and says it with no button pressed.
  cardProblem: string | null;
}

/** A row's pill: a `StatePill` state and the word it shows. */
export interface RowPill {
  state: 'new' | 'running' | 'ready' | 'idle';
  word: string;
  detail: string | null;
}

export interface ScoutFindingsView {
  // The one seen last first, as the reader comes off Check now. A muted finding is not here.
  rows: ScoutFindingRow[];
  // The muted findings, for the Muted fold at the end of the list. Same shape and same order, because a
  // muted row says the same two things a listed one does, what it is and how often it was seen.
  memory: ScoutFindingRow[];
  // The line an empty list shows once a source exists, from `noFindingsLine`. Null with no source.
  empty?: string | null;
  // The findings first seen after the seen marker, muted ones left out: new since the last visit.
  fresh: number;
}

/**
 * The quiet line of an empty Scout list: no findings, and what Scout last checked
 * ("No findings. Scout checked 3 sources at 14:00."). Null with no source, where the screen
 * says to add one.
 *
 * No time zone is passed outside a test, because Nolzu runs on the person's own machine and the server
 * is in their zone, as `when` in scout-sources.ts has it.
 */
export function noFindingsLine(sources: readonly { lastChecked: string | null }[], now: Date, timeZone?: string): string | null {
  if (sources.length === 0) return null;
  const checked = sources.map((one) => one.lastChecked).filter((stamp) => stamp !== null);
  if (checked.length === 0) {
    return `No findings. Scout has not checked ${sources.length === 1 ? 'its source' : `its ${sources.length} sources`} yet. Press Check now on a source under Sources.`;
  }
  const last = new Date(Math.max(...checked.map((stamp) => Date.parse(stamp))));
  const day = (date: Date) => new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' }).format(date);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(last);
  const when = day(last) === day(now) ? `at ${clock}` : `on ${day(last)} at ${clock}`;
  return `No findings. Scout checked ${checked.length} ${checked.length === 1 ? 'source' : 'sources'} ${when}.`;
}

// What a person is shown where a finding's column is named. Every word of the CHECK has one, so a
// row of a column this screen does not draw yet still says where it is.
const STATUS_LABELS: Readonly<Record<ScoutFindingStatus, string>> = {
  new: 'New',
  assess: 'In assessment',
  decide: 'To decide',
  started: 'Started',
  done: 'Done',
  parked: 'Parked',
  dismissed: 'Muted',
};

/**
 * How often a finding was seen and over how long, as the inbox row and Now's teaser print it after the
 * source: "seen once", "seen 3 times today", "seen 3 times on 9 Oct", "seen 12 times in 2 days".
 *
 * The days are the time from the first sighting to the last, rounded, so a Saturday evening to a
 * Monday noon is two days. The zone is for tests only.
 */
export function seenOften(occurrences: number, firstSeen: string, lastSeen: string, now: Date, timeZone?: string): string {
  if (occurrences === 1) return 'seen once';
  const first = new Date(firstSeen);
  const last = new Date(lastSeen);
  if (dayKey(first, timeZone) === dayKey(last, timeZone)) {
    return dayKey(last, timeZone) === dayKey(now, timeZone) ? `seen ${occurrences} times today` : `seen ${occurrences} times on ${dayMonth(last, timeZone)}`;
  }
  const days = Math.max(1, Math.round((last.getTime() - first.getTime()) / 86_400_000));
  return `seen ${occurrences} times in ${days === 1 ? 'a day' : `${days} days`}`;
}

// The pill of each status. New is blue, an assessment that runs is the running pill, one that ended
// waits on the person as To decide, and the rest are words with no colour: started, done, parked and
// muted ask nothing of anybody.
function pillOf(one: ScoutFinding, running: boolean): RowPill {
  if (one.status === 'new') return { state: 'new', word: 'New', detail: null };
  if (one.status === 'assess' && running) return { state: 'running', word: 'Assessing', detail: null };
  if (one.status === 'assess' || one.status === 'decide') return { state: 'ready', word: 'To decide', detail: null };
  return { state: 'idle', word: STATUS_LABELS[one.status], detail: one.status === 'started' ? one.cardKey : null };
}

/**
 * One row, from the finding and the label of the source that found it.
 *
 * The detail screen reads it through this too, so the two screens cannot end up printing different
 * words for one status or different times for one finding.
 *
 * `cards` says where the cards these findings name are sitting. It is handed in rather than read
 * here, because the list draws many rows off one query and this stays free of the database, and so is
 * `running`, whether the finding's assessment run is going now. `now` is the clock the short times
 * are written against.
 */
export const scoutRow = (one: ScoutFinding, source: string, cards: ReadonlyMap<string, CardPlace>, running = false, now: Date = new Date()): ScoutFindingRow => {
  const at = one.cardKey === null ? undefined : cards.get(one.cardKey);
  const card = one.cardKey === null ? null : { key: one.cardKey, here: at !== undefined, board: at?.board ?? '', stage: at?.stage ?? '' };
  // Only where no card is on the board. A finding whose card is there was started before this check
  // existed, and the shape of its ticket key is nothing a person can act on any more. A finding
  // whose card somebody removed by hand is back to needing one, and `canStart` offers Start again,
  // so the reason has to be on the row there too.
  // The same check Start makes, on the key it writes and the reference it keeps.
  const cardProblem = one.externalKey === null || card?.here === true ? null : ticketRefProblem(one.externalKey);
  return {
    id: one.id,
    title: one.lastMessage.split('\n')[0] ?? '',
    source,
    // Two branches, because "Seen 1 times" is not English.
    seen: one.occurrences === 1 ? `Seen once, on ${when(one.lastSeen)}.` : `Seen ${one.occurrences} times, last on ${when(one.lastSeen)}.`,
    often: seenOften(one.occurrences, one.firstSeen, one.lastSeen, now),
    at: shortWhen(one.lastSeen, now),
    first: when(one.firstSeen),
    last: when(one.lastSeen),
    firstMessage: one.firstMessage,
    lastMessage: one.lastMessage,
    location: one.location,
    fingerprint: one.fingerprint,
    status: STATUS_LABELS[one.status],
    pill: pillOf(one, running),
    canAssess: one.status === 'new',
    card,
    canStart: cardProblem === null && canStartFinding(one.status, card?.here === true),
    cardProblem,
  };
};

export function scoutFindingsFor(db: DatabaseSync, now: Date = new Date()): ScoutFindingsView {
  // The cascade of migration 10 takes a source's findings with it, so every finding has its source.
  const sources = scoutSources(db);
  const names = new Map(sources.map((source) => [source.id, source.label]));
  const all = allScoutFindings(db);
  const live = cardsOnBoard(db, all);
  const going = assessing(db);
  const row = (one: ScoutFinding): ScoutFindingRow => scoutRow(one, names.get(one.sourceId) ?? '', live, going.has(assessKey(one.id)), now);
  const seen = getSetting(db, 'scoutSeen');
  // Split here and not in two queries, because the two panels are one read of one order and a second
  // query could disagree with the first about where a finding belongs.
  return {
    rows: all.filter((one) => one.status !== 'dismissed').map(row),
    memory: all.filter((one) => one.status === 'dismissed').map(row),
    empty: noFindingsLine(sources, now),
    fresh: all.filter((one) => one.status !== 'dismissed' && (seen === null || one.firstSeen > seen)).length,
  };
}

/**
 * The keys of the assessment runs going now, in one query for the whole list.
 *
 * The run rows and not the status word, which stays `assess` after the run ends. `ENDED` is the same
 * list the detail page reads a going run with, so the two screens agree.
 */
export function assessing(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare(`SELECT DISTINCT card_key FROM runs WHERE card_key LIKE 'assess-%' AND (state IS NULL OR state NOT IN (${ENDED.map(() => '?').join(', ')}))`)
    .all(...ENDED) as { card_key: string }[];
  return new Set(rows.map((row) => row.card_key));
}

/**
 * The seen marker, moved up to the newest finding there is. The Scout page calls it on every load, so
 * the rail's dot and Now's count mean new since the last visit.
 *
 * True when it moved. A visit with nothing newer writes nothing, so it does not wake every open stream
 * for a number that stayed the same. Both stamps come from sqlite in one ISO form, so the later string
 * is the later time.
 */
export function markScoutSeen(db: DatabaseSync): boolean {
  const newest = (db.prepare('SELECT max(first_seen) AS at FROM scout_findings').get() as { at: string | null }).at;
  const seen = getSetting(db, 'scoutSeen');
  if (newest === null || (seen !== null && newest <= seen)) return false;
  writeSetting(db, 'scoutSeen', newest);
  return true;
}

/** What one Dismiss or Unmute did, as the screen prints it. */
export interface ScoutMuteAnswer {
  ok: boolean;
  message: string;
}

/**
 * Mute one finding, or bring it back.
 *
 * A sentence and never a throw for an id that is not there, the way the source actions answer: the
 * finding may have gone with its source in another tab, and the person still has to read why their
 * button did nothing.
 */
export function muteScoutFinding(db: DatabaseSync, form: FormData, muted: boolean): ScoutMuteAnswer {
  const typed = (form.get('id')?.toString() ?? '').trim();
  // A blank or a word is not finding 0, which is what Number() would look up. It means the form posted
  // no id, so the sentence says to load the screen again rather than printing a number nobody typed.
  if (!/^\d+$/.test(typed)) return { ok: false, message: 'That button posted no finding id. Load the Scout screen again and press it once more.' };
  if (scoutFinding(db, Number(typed)) === null)
    return { ok: false, message: `There is no finding ${typed} on this machine. It may have gone with the source that found it.` };

  // The four sentences name no panel and no place on the screen. They print beside the finding they
  // are about, which may sit on the list or in the Muted fold, so a sentence that says where would be
  // wrong half the time.
  if (muted)
    return dismissScoutFinding(db, Number(typed))
      ? { ok: true, message: 'That finding is muted. A later check leaves it muted.' }
      : { ok: false, message: 'That finding is muted already. Unmute it to bring it back.' };

  return unmuteScoutFinding(db, Number(typed))
    ? { ok: true, message: 'That finding is back on the list, with the count it had.' }
    : { ok: false, message: 'That finding is not muted, so nothing changed.' };
}

/** Where one card sits, in the words a person reads on the board. */
export interface CardPlace {
  board: string;
  stage: string;
}

/**
 * Of the cards these findings name, the ones still on a board, and where each one sits.
 *
 * One query for the whole list, because a card row per finding would be a read per row. The detail
 * screen asks about its one finding through the same function, so the two screens cannot disagree
 * about whether a card is there. Nothing deletes a card today, so this answers everything on most
 * machines, and a key that is missing from the answer is what tells the screens a card is gone.
 *
 * The board and the column come back as words and not as ids, because the screens
 * say where a started finding's card is, and a stage label is only in the board.
 */
export function cardsOnBoard(db: DatabaseSync, findings: readonly ScoutFinding[]): Map<string, CardPlace> {
  const keys = [...new Set(findings.map((one) => one.cardKey).filter((key): key is string => key !== null))];
  if (keys.length === 0) return new Map();
  const rows = db.prepare(`SELECT key, board, stage FROM cards WHERE key IN (${keys.map(() => '?').join(', ')})`).all(...keys) as {
    key: string;
    board: string;
    stage: string;
  }[];
  const flow = getSetting(db, 'deliveryFlow');
  return new Map(
    rows.map((row) => {
      // A board word this version does not know, or a column a later version dropped,
      // is printed as it is stored. A row a person cannot place is worse than an unfamiliar word.
      const kind: BoardKind | null = isBoardKind(row.board) ? row.board : null;
      const stage = kind === null ? row.stage : (boardFor(kind, flow).stages.find((one) => one.id === row.stage)?.label ?? row.stage);
      return [row.key, { board: kind === null ? row.board : BOARD_LABELS[kind], stage }];
    }),
  );
}

// What the Start as Delivery form needs: the database to write in, and the way to tell the open
// boards. A new card is a change no run announces, so without `changed` a board in another tab draws
// the old columns until somebody reloads it.
export interface StartPost {
  db: DatabaseSync;
  changed: () => void;
}

// The two boards the buttons offer, and the word each form posts. Checked against the posted value
// rather than cast, because a form field is text from the page and a board Scout may not start on
// would reach `createLocalTicket` as a column nobody can draw.
const START_BOARDS: Readonly<Record<string, ScoutStartBoard>> = { delivery: 'delivery', investigations: 'investigations' };

/**
 * Start one finding as a card, on the board its button named.
 *
 * A sentence and never a throw, the way Dismiss, Unmute and Assess answer on these screens. The
 * writer's own refusals are handed on as they are: each one names the finding or the card and says
 * what to do next. Anything the write throws becomes a sentence too: the write takes the database
 * lock, and another process holding it is a refusal a person can act on and not a 500 page.
 */
export function answerStart(live: StartPost, form: FormData): ScoutMuteAnswer {
  const typed = (form.get('id')?.toString() ?? '').trim();
  // A blank or a word is not finding 0, which is what Number() would look up.
  if (!/^\d+$/.test(typed)) return { ok: false, message: 'That button posted no finding id. Load the Scout screen again and press it once more.' };
  const asked = (form.get('board')?.toString() ?? '').trim();
  const board = START_BOARDS[asked];
  if (board === undefined) return { ok: false, message: 'That button posted no board to start on. Load the Scout screen again and press it once more.' };

  let start;
  try {
    start = startScoutFinding(live.db, Number(typed), board);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  if (!start.ok) return { ok: false, message: start.message };
  live.changed();
  // A ticket that was already on the board gets its own sentence, and it names no board: the card
  // may sit on another one than the button asked for, and nothing moved it.
  if (start.alreadyOnBoard === true) {
    return {
      ok: true,
      message: `Finding ${typed} is the ticket ${start.key}, and that card is already on the board. The finding points at it now, and no second card was made.`,
    };
  }
  // Three things, because all three surprise a person. No run starts, so the card waits in the first
  // column until somebody moves it. And the assessment is offered from New alone, so starting the
  // finding is the end of that offer, which no button on the screen says.
  return {
    ok: true,
    // An investigation sits on Research, the one place the rail lists for it.
    message: `Finding ${typed} is on ${isResearchKind(board) ? 'Research' : `the ${BOARD_LABELS[board]} board`} as ${start.key}. Nothing is running yet: move that card forward when you want the work to start. The read-only assessment is not offered on this finding any more, because it runs from New alone.`,
  };
}
