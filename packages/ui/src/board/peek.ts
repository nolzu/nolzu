import { type CardView, ENGINE_LABELS, formatCost, formatDuration, formatTokens, isEngineName, mergeSpend, ranOn, type RunState, type Segment } from '@nolzu/protocol';
import type { LogRow, RetryWait } from '../ticket/log.ts';
import { elapsed } from './elapsed.ts';

/**
 * What the peek sheet reads from the server about one card: what its runs left on this machine.
 *
 * The summary is the running phase's own file while it runs, which the skill rewrites after each file
 * it changes, and else the newest one a run stored. Null when no run wrote one,
 * which the sheet says in words and never fills with a made-up line.
 */
export interface PeekView {
  key: string;
  summary: { text: string; at: string | null; live: boolean } | null;
  // The newest phase run's last rows, and how many rows its log has.
  log: { runId: number; rows: readonly LogRow[]; total: number } | null;
  // Input and output so far of that run, or null when its engine reported none yet.
  tokens: number | null;
  trail: readonly Segment[];
  // The wait that run sits in after an API error.
  retry: RetryWait | null;
  // For the Next step block, as the card page loads them: the diff comments not sent back yet, and the
  // newest Implement session shortened as the facts show it, or null when none is left.
  openComments: number;
  session: string | null;
}

export interface TrailStep {
  phase: string;
  label: string;
  state: 'done' | 'failed' | 'stopped' | 'now' | 'next' | 'later';
  model: string | null;
  // The phase's time, or where it stands for a phase that has not run.
  time: string | null;
  // What its runs reported, and nothing for a run that reported none or a phase still to run.
  cost: string | null;
}

const LIVE: readonly (RunState | null)[] = ['queued', 'waiting_lane', 'waiting_review', 'running', 'retrying'];

/**
 * The trail: the phases done with their time and cost, the one that runs
 * with its time so far, and the ones to come. Only measured cost: the running phase reports its cost
 * when it ends, and an estimate is no figure of this card. `models` names
 * the model each phase to come would start on, read off the board's columns.
 */
export function trailSteps(trail: readonly Segment[], card: Pick<CardView, 'runStartedAt'>, now: Date, models: Readonly<Record<string, string>> = {}): TrailStep[] {
  let ran = true;
  let before: string | null = null;
  return trail.map((segment) => {
    const run = segment.run;
    let step: TrailStep;
    if (run !== null && LIVE.includes(run.state)) {
      step = { phase: segment.phase, label: segment.label, state: 'now', model: ranOn(run.engine, run.model, null) || null, time: card.runStartedAt === null ? null : elapsed(card.runStartedAt, now), cost: null };
    } else if (run !== null) {
      const spend = segment.spend;
      const took = spend.durationMs > 0 ? formatDuration(spend.durationMs) : null;
      // Red for a phase that failed and neutral for one that was stopped, and the word beside it, so
      // the mark is never the only sign.
      const state = run.state === 'failed' || run.verdict === 'FAIL' ? 'failed' : run.state === 'stopped' || run.state === 'interrupted' ? 'stopped' : 'done';
      const word = state === 'failed' ? 'failed' : state === 'stopped' ? run.state : null;
      step = {
        phase: segment.phase,
        label: segment.label,
        state,
        // The engine as well, because one phase can run on another engine than the one before it.
        model: ranOn(run.engine, run.model, null) || null,
        time: word === null ? took : [word, took].filter((part) => part !== null).join(' · '),
        cost: spend.costUsd === null ? null : formatCost(spend.costUsd),
      };
    } else {
      // The first phase after the last one that ran is next; the rest come after the one before them.
      const state = ran ? 'next' : 'later';
      step = { phase: segment.phase, label: segment.label, state, model: models[segment.phase] ?? null, time: state === 'next' ? 'next' : `after ${before ?? ''}`, cost: null };
    }
    ran = run !== null;
    before = segment.label;
    return step;
  });
}

// What every run on the trail reported, added up, or null when none reported a cost.
export function trailTotal(trail: readonly Segment[]): string | null {
  const total = mergeSpend(trail.map((segment) => segment.spend)).costUsd;
  return total === null ? null : formatCost(total);
}

// The line under the title: the engine by its vendor's name, the model and the effort, then the
// tokens so far. No running cost: only Claude Code reports a cost, at the end.
export function peekFacts(card: Pick<CardView, 'engine' | 'model' | 'effort'>, tokens: number | null): string[] {
  const vendor = card.engine?.split('#')[0] ?? '';
  const run = [isEngineName(vendor) ? ENGINE_LABELS[vendor] : null, card.model, card.effort].filter((part) => part !== null && part !== '');
  return [...(run.length === 0 ? [] : [run.join(' · ')]), ...(tokens === null ? [] : [`${formatTokens(tokens)} tok`])];
}

const WORDS = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

// "30s ago", then minutes, then hours, for the summary's time. Null for a time that cannot be read.
// With `words` it reads "12 seconds ago" up to "3 hours ago", then "yesterday" and "4 days ago", for
// the trail, where there is room and a day must be told apart. Days count local dates, not 24 hour
// blocks, so two events of one evening read the same day and Saturday is not "yesterday" on Monday.
export function ago(at: string, now: Date, words = false): string | null {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (words) {
    if (seconds < 60) return WORDS.format(-seconds, 'second');
    if (seconds < 3600) return WORDS.format(-Math.floor(seconds / 60), 'minute');
    if (seconds < 86_400) return WORDS.format(-Math.floor(seconds / 3600), 'hour');
    const day = (time: Date) => new Date(time.getFullYear(), time.getMonth(), time.getDate()).getTime();
    // Rounded, as a summer time change makes one day 23 or 25 hours long.
    return WORDS.format(-Math.round((day(now) - day(new Date(then))) / 86_400_000), 'day');
  }
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  // Two days and more in days, so a pull request merged last week does not read "170h ago".
  if (seconds < 172_800) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
