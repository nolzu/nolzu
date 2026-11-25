import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cardRuns, ENDED, scoutFinding, type ScoutFinding, scoutSource } from '@nolzu/core/node';
import { assessKey, formatCost, formatDuration } from '@nolzu/protocol';
import { readCardFile } from '@nolzu/runner';
import { engineName } from '@nolzu/ui';
import { cardFolder } from './files.ts';
import { type Assessment, readAssessment } from './scout-assess.ts';
import { assessing, cardsOnBoard, scoutRow, type ScoutFindingRow } from './scout-findings.ts';

/**
 * One finding as its own page reads it: the row the list draws, the assessment a run wrote, and the
 * buttons this status may be offered.
 *
 * The evidence and the status word come from the row, so the list and this page cannot disagree
 * about either. What this file adds is the assessment, which is a file in the run's own folder and
 * no column, and which of the four writers can take this finding now.
 */
export interface ScoutFindingDetail {
  row: ScoutFindingRow;
  // The five parts, or null when there are none to draw.
  assessment: Assessment | null;
  // The line above the parts, or the reason there are no parts. Null when the five parts are the
  // whole answer, and set beside them while a second run is going, because the parts are then the
  // round before it.
  // `refused` marks a file that is there and cannot be read, which is a problem, against a finding
  // nobody has assessed, which is only a state.
  note: { text: string; refused: boolean } | null;
  // The read-only run that wrote the parts, as the Assessment heading names it: "read-only run, Claude
  // Code · haiku · 41s · $0.02". Null before a run completed.
  run: string | null;
  // Dismiss on anything but a muted finding: `dismissScoutFinding` refuses a second mute, so on a
  // muted one the button could only answer that it is muted already.
  canDismiss: boolean;
  // Unmute on a muted finding alone, because `unmuteScoutFinding` moves that one word and no other.
  canUnmute: boolean;
}

export type ScoutDetailResult = { ok: true; detail: ScoutFindingDetail } | { ok: false; status: number; message: string };

// Where the assess skill writes its answer, under the phase folder of the run's own folder. The
// skill names this path and this reads it, so a test that renames one catches the other.
const ASSESSMENT_FILE = 'assess/assessment.md';

/**
 * The assessment of one finding, read back off disk.
 *
 * No file is the normal case before the first run, so it reads as a state and not as a problem.
 * Anything else is the reader's own sentence, about a file that is there and cannot be shown.
 */
function assessmentOf(db: DatabaseSync, one: ScoutFinding, env: Record<string, string | undefined>): Pick<ScoutFindingDetail, 'assessment' | 'note'> {
  const key = assessKey(one.id);
  const dir = cardFolder(db, key, env);
  // The key is built from the id, so it is always one plain name and this cannot fire. It is here
  // because a folder nobody can name is not a finding nobody assessed, and the two read differently.
  if (dir === null) {
    return { assessment: null, note: { text: `The run folder of finding ${one.id} has no name this app can read, so its assessment cannot be found.`, refused: true } };
  }

  // The run rows and not the status word. Dismiss writes `dismissed` over any column and Unmute
  // writes `new` back, so a finding that reached the assessment column can carry either word, and
  // the page would claim a run nobody started or hide one that did.
  const runs = cardRuns(db, key);
  const going = runs.some((run) => run.state === null || !ENDED.includes(run.state));

  // Asked before the read and not off its answer: the reader says 404 both for a file that is not
  // there and for a folder with that name, and those two are a state and a problem.
  if (!existsSync(join(dir, ASSESSMENT_FILE))) {
    const text =
      runs.length === 0
        ? 'No assessment has been written for this finding.'
        : going
          ? 'An assessment of this finding was started. What it found shows here once it has been written.'
          : 'An assessment of this finding was started and ended without writing anything.';
    return { assessment: null, note: { text, refused: false } };
  }

  // The card folder's own reader, so a file that is a folder, a link out of the folder or bigger than
  // a page shows answers with its own sentence instead of reaching the parser. A run writes what it
  // likes into its folder.
  const read = readCardFile(dir, ASSESSMENT_FILE);
  if (!read.ok) return { assessment: null, note: { text: read.reason, refused: true } };

  const found = readAssessment(read.bytes.toString('utf8'));
  // Half an assessment is refused whole by the reader, and its sentence names the section that is
  // missing. Printing the parts it did find would read as an answer beside the part a person decides on.
  if (!found.ok) return { assessment: null, note: { text: found.problem, refused: true } };

  // A second run writes over the same file, so while one is going the text below is the round before
  // it. Said above the parts and not instead of them: they are still the newest answer there is.
  return {
    assessment: found.parts,
    note: going ? { text: 'A new assessment of this finding is running. What is below is the round before it.', refused: false } : null,
  };
}

/**
 * The newest completed assessment run, in the words the Assessment heading prints.
 *
 * Completed and not the newest, because a run that is going has written nothing yet and the parts on
 * the page are the round before it. A part the run never reported is left out, and a cost nobody
 * reported is never $0.00.
 */
function runLine(db: DatabaseSync, one: ScoutFinding): string | null {
  const run = cardRuns(db, assessKey(one.id)).findLast((each) => each.state === 'complete');
  if (run === undefined) return null;
  const parts = [engineName(run.engine), run.model, run.durationMs === null ? null : formatDuration(run.durationMs), run.costUsd === null ? null : formatCost(run.costUsd)];
  return `read-only run, ${parts.filter((part) => part !== null).join(' · ')}`;
}

/**
 * One finding by the id in its address.
 *
 * A word, or a number no finding has, is a page that is not there. Both answer the same sentence,
 * the way the ticket page answers for a key no card has: an empty screen would read as one that
 * broke, and a redirect to the list would hide that the address was wrong.
 */
export function scoutFindingDetail(db: DatabaseSync, asked: string | undefined, env: Record<string, string | undefined> = process.env): ScoutDetailResult {
  const typed = (asked ?? '').trim();
  // A blank or a word is not finding 0, which is what Number() would look up. No leading zero
  // either: `01` and `0000001` are the same row to Number(), so they would give one finding an
  // address a person can spell in as many ways as they like.
  const isNumber = /^[1-9]\d*$/.test(typed);
  const gone: ScoutDetailResult = {
    ok: false,
    status: 404,
    // A number is named as it was asked for. Anything else is quoted, because a word in the middle
    // of the sentence would read as part of it.
    message: `There is no finding ${isNumber ? typed : JSON.stringify(typed)} here. Check the address, or open the Scout screen to see what Scout found.`,
  };
  if (!isNumber) return gone;

  const one = scoutFinding(db, Number(typed));
  if (one === null) return gone;
  return {
    ok: true,
    detail: {
      // The label and not the source row: the page says which source found this, and the rest of
      // that row belongs to the Settings screen.
      // The card the finding was started as is on the row, so this page and the list name it the
      // same way, and a key whose card was deleted reads as gone on both.
      // Whether the assessment runs comes from the list's own reader, so the two pills agree.
      row: scoutRow(one, scoutSource(db, one.sourceId)?.label ?? '', cardsOnBoard(db, [one]), assessing(db).has(assessKey(one.id))),
      ...assessmentOf(db, one, env),
      run: runLine(db, one),
      canDismiss: one.status !== 'dismissed',
      canUnmute: one.status === 'dismissed',
    },
  };
}
