import type { CardState, CardView, RunActivity, StageView } from '@nolzu/protocol';
import { elapsed } from './elapsed.ts';
import { ordinal } from './ordinal.ts';

export interface Live {
  // The run's last tool action, or null before its first tool.
  line: string | null;
  // How long the run has printed nothing, such as "6m", once that passes the setting. Null while it
  // is live.
  quiet: string | null;
  // How long ago the run last printed, such as "2s ago", while it is live. Null once it reads Quiet,
  // where the pill says it, and with no clock.
  since: string | null;
}

/**
 * What a running card shows of its run's own stream. Null when the activity is about another run or
 * the card is not running, so a line from the last run never sits on this one.
 *
 * Quiet only changes what is shown. Nothing stops a quiet run: the run timeout does that, much later.
 */
export function liveOf(
  card: Pick<CardView, 'state' | 'runId' | 'runState'>,
  activity: RunActivity | null | undefined,
  now: Date | undefined,
  quietAfterMs: number | undefined,
): Live | null {
  if (activity === null || activity === undefined || card.state !== 'running' || card.runId !== activity.runId) return null;
  const silent = now === undefined ? 0 : now.getTime() - activity.outputAt;
  // A retry wait has a known end, so it is not a run that went silent.
  const quiet = quietAfterMs !== undefined && card.runState === 'running' && silent >= quietAfterMs;
  // Seconds and then minutes, the units of "2s ago" and "Quiet 6m". The floor at zero is for
  // a browser clock a moment behind the server's.
  const seconds = Math.max(0, Math.floor(silent / 1000));
  const since = now === undefined || quiet ? null : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;
  return { line: activity.line, quiet: quiet ? `${Math.floor(silent / 60_000)}m` : null, since };
}

export interface Pill {
  // New is a push on a pull request since its last review round, in the blue StatePill gives it.
  state: CardState | 'quiet' | 'new';
  // The screen's own word for the state, or null for the pill's default.
  word: string | null;
  detail: string | null;
  // A check in place of the dot, for a closed card. Left out on every other pill.
  check?: true;
}

/**
 * The state pill words of a card, one rule for the board card and the card page head so
 * the two never disagree. A running pill holds the run time ("0m 40s") and a queued one its place.
 * Quiet replaces Running once the run printed nothing for the set time. QA's FAIL ends its run as
 * complete, so the card is ready, but a person reads a failed card. An epic with every task done is
 * idle, and a person reads a card that waits on them. An idle pull request card the author pushed to
 * since its last review round says how many commits are new. With the card's stage, a card ready
 * after an agent's phase names it ("Plan ready", "Implement done"), and a card in the archive column
 * reads Closed. A page that has no stage keeps the older words.
 */
export function cardPill(
  card: Pick<CardView, 'state' | 'runStartedAt' | 'queuePosition' | 'verdict' | 'finished' | 'pull'> & Partial<Pick<CardView, 'runState' | 'afterLearn'>>,
  live: Live | null,
  now: Date | undefined,
  stage?: Pick<StageView, 'id' | 'label' | 'role'> | null,
): Pill {
  if (live !== null && live.quiet !== null) return { state: 'quiet', word: null, detail: live.quiet };
  // Held by Learn and then start: it moves on by itself once Learn ends, counted from the press.
  if (card.afterLearn !== undefined && card.state !== 'running' && card.state !== 'queued')
    return { state: 'queued', word: `Starts ${card.afterLearn.column} after Learn`, detail: now === undefined ? null : elapsed(card.afterLearn.since, now) };
  if (card.state === 'running') return { state: 'running', word: null, detail: card.runStartedAt !== null && now !== undefined ? elapsed(card.runStartedAt, now) : null };
  // A wrap-up held until a knowledge change is applied or returned waits on the person, not on the queue.
  if (card.state === 'queued' && card.runState === 'waiting_review') return { state: 'ready', word: 'Waits for your review', detail: null };
  if (card.state === 'queued') return { state: 'queued', word: null, detail: card.queuePosition === null ? null : ordinal(card.queuePosition) };
  if (card.state === 'blocked') return { state: 'blocked', word: 'Asks you', detail: null };
  if (card.state === 'ready' && card.verdict === 'FAIL') return { state: 'failed', word: 'QA failed', detail: null };
  // Implement reads done, since its result is code and not a document to read.
  if (card.state === 'ready' && stage?.role === 'agent') return { state: 'ready', word: `${stage.label} ${stage.id === 'implement' ? 'done' : 'ready'}`, detail: null };
  if (card.state === 'ready') return { state: 'ready', word: 'Ready for you', detail: null };
  if (card.state === 'idle' && stage?.role === 'archive') return { state: 'idle', word: 'Closed', detail: null, check: true };
  if (card.finished === true) return { state: 'ready', word: 'Tasks done', detail: null };
  // Only on an idle card: the card waits, and the push is why a
  // person may move it on. A card that waited on the author went back to Incoming on that push.
  const pushed = card.state === 'idle' && card.pull?.ended === undefined ? (card.pull?.newCommits ?? 0) : 0;
  if (pushed > 0) return { state: 'new', word: pushed === 1 ? '1 new commit' : `${pushed} new commits`, detail: null };
  return { state: card.state, word: null, detail: null };
}
