import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { boardFor, cleanSummary, phaseStrip } from '@nolzu/core';
import { cardRuns, getSetting, NOT_A_PASS, retryWait, shownRunState } from '@nolzu/core/node';
import { type BoardKind, type RunEvent, tokensSoFar } from '@nolzu/protocol';
import { activityLine, readCardText, runLogTime, tailLog } from '@nolzu/runner';
import { clockTime, logRows, type PeekView, type TimedEvent } from '@nolzu/ui';
import { implementSession, openCommentCount } from './diff-comments.ts';
import { cardFolder } from './files.ts';

// The rows the sheet shows.
const SHOWN = 6;

const LIVE = ['queued', 'waiting_lane', 'waiting_review', 'running', 'retrying'];
// The loop removes the last run's file only when a run starts, so a run still in the queue has none.
const STARTED = ['running', 'retrying'];

// The running phase's summary file: the skill rewrites it after each file it changes. Read
// only for a run that started, so a file there is this run's.
function liveSummary(folder: string | null, phase: string): PeekView['summary'] {
  if (folder === null) return null;
  const path = join(folder, phase, 'summary.md');
  try {
    const read = readCardText(folder, join(phase, 'summary.md'));
    if (read === null) return null;
    const text = cleanSummary(read);
    return text === '' ? null : { text, at: statSync(path).mtime.toISOString(), live: true };
  } catch {
    return null;
  }
}

/**
 * What the peek sheet shows of one card, or null for a card that is not there.
 *
 * Limit: the newest run's whole log is read and parsed on each call, and the sheet asks again as
 * the run works. Read from the end of the file if a log ever grows past what that costs.
 */
export async function peekFor(db: DatabaseSync, key: string, parse: (line: string, engine: string) => RunEvent[], now = Date.now()): Promise<PeekView | null> {
  const card = db.prepare('SELECT board FROM cards WHERE key = ?').get(key) as { board: BoardKind } | undefined;
  if (card === undefined) return null;
  const newest = db.prepare(`SELECT id, phase, state, engine, log_path, cwd FROM runs WHERE card_key = ? AND ${NOT_A_PASS} ORDER BY id DESC LIMIT 1`).get(key) as
    | { id: number; phase: string; state: string | null; engine: string; log_path: string | null; cwd: string | null }
    | undefined;

  const live = newest !== undefined && LIVE.includes(newest.state ?? '');
  const stored = db.prepare('SELECT plain_summary FROM runs WHERE card_key = ? AND plain_summary IS NOT NULL ORDER BY id DESC LIMIT 1').get(key) as { plain_summary: string } | undefined;
  // While a phase runs, only its own words: the last phase's summary would read as this one's.
  const started = live && STARTED.includes(newest.state ?? '');
  const summary = started ? liveSummary(cardFolder(db, key), newest.phase) : live || stored === undefined ? null : { text: stored.plain_summary, at: null, live: false };

  let log: PeekView['log'] = null;
  let tokens: number | null = null;
  if (newest !== undefined && (newest.log_path ?? '') !== '') {
    // Each event keeps the time the runner noted in front of its line, as the log route sends it, so a
    // row can say when it came. A log from before the runner noted times has none.
    const events: TimedEvent[] = [];
    let at: number | null = null;
    for await (const line of tailLog(newest.log_path!, new AbortController().signal, { follow: false })) {
      const noted = runLogTime(line);
      if (noted !== null) at = noted;
      else events.push(...parse(line, newest.engine).map((event) => (at === null ? event : { ...event, at: at })));
    }
    tokens = tokensSoFar(events);
    // A tool reads as the card's activity line does, "Reading src/list.ts", and never with its input:
    // a write's input is the whole file.
    const named = events.map((event): TimedEvent => (event.type === 'tool' ? { type: 'tool', name: activityLine(event, newest.cwd ?? '') ?? event.name, input: undefined, at: event.at } : event));
    // A wait counts down only while the run is in it. A run stopped during one has no later line.
    const rows = logRows(named, now, !live, null, (ms) => clockTime(ms)).map(({ kind, text, aside, time }) => ({ kind, text, ...(aside === undefined ? {} : { aside }), ...(time === undefined ? {} : { time }) }));
    log = { runId: newest.id, rows: rows.slice(-SHOWN), total: rows.length };
  }

  // The trail in the state a person is shown, as the board says it.
  const shown = shownRunState(db);
  return {
    key,
    summary,
    log,
    tokens,
    trail: phaseStrip(boardFor(card.board, getSetting(db, 'deliveryFlow')), cardRuns(db, key).map((run) => ({ ...run, state: shown(run.state) }))),
    retry: newest === undefined ? null : retryWait(db, newest.id),
    openComments: openCommentCount(db, key),
    session: implementSession(db, key),
  };
}
