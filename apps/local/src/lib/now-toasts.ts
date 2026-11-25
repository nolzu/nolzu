import { SCOUT_AND_EVIDENCE, shortReason } from '@nolzu/protocol';
import { nearLimits, type ToastItem } from '@nolzu/ui';
import type { NowSnapshot, RunEnd } from './now.ts';
import { type BoardState, NO_LIMITS } from './snapshot-client.ts';

/**
 * What one tab has heard on the Now stream, so each event raises its toast once.
 *
 * The first snapshot and the first limits event replay what was already so when the page loaded, so
 * they set this and raise nothing. Each tab keeps its own, so a second tab's first snapshot raises
 * nothing either.
 */
export interface Heard {
  // Every ended run seen, and the newest end at the page load. A run that ended before the load and
  // comes back into the list, as when a newer run's card is removed, is not news.
  runs: ReadonlySet<number>;
  since: string;
  // Scout's count of findings new since the last visit.
  fresh: number;
  // The windows near their limit in the last reading, by profile, window and reset time. Null until the
  // first limits event.
  near: ReadonlySet<string> | null;
}

export interface ToastHrefs {
  card: (key: string) => string;
  scout: string;
  // Settings, Engines, where each profile's limit block is.
  engines: string;
}

// The words of a run's end. A QA run that printed no verdict is neither a pass nor a fail: the card
// waits for the person with the reason, so it warns.
function runToast(run: RunEnd, hrefs: ToastHrefs): ToastItem {
  const card = { key: run.key, href: hrefs.card(run.key) };
  const said = { run: { engine: run.engine, model: run.model, durationMs: run.durationMs, costUsd: run.costUsd } };
  if (run.state === 'failed' || run.verdict === 'FAIL') {
    return { kind: 'error', card, headline: `${run.phase} failed`, message: run.reason === null ? 'It gave no reason. Read its log.' : shortReason(run.reason), ...said };
  }
  if (run.verdict === null && run.reason !== null) return { kind: 'warning', card, headline: `${run.phase} gave no verdict`, message: shortReason(run.reason), ...said };
  return { kind: 'success', card, headline: run.verdict === 'PASS' ? `${run.phase} passed` : `${run.phase} finished`, message: '', ...said };
}

// Every window near its limit, each with the toast it raises. The key of the toast is the profile and
// the window, so a second profile's warning does not take the first one's place in the stack.
function nearToasts(state: BoardState<NowSnapshot>, now: number, hrefs: ToastHrefs, timeZone?: string): Map<string, ToastItem> {
  const toasts = new Map<string, ToastItem>();
  for (const [id, limit] of Object.entries(state.limits)) {
    const label = state.snapshot?.profiles.find((profile) => profile.id === id)?.label ?? id;
    for (const near of nearLimits(limit, now, timeZone)) {
      toasts.set(`${id}\n${near.window}\n${near.resetsAt ?? ''}`, {
        kind: 'warning',
        card: { key: `${label}, ${near.name}`, href: hrefs.engines },
        title: near.text,
        message: '',
        note: limit.card === undefined ? label : `${label} · seen on ${limit.card}`,
      });
    }
  }
  return toasts;
}

/**
 * The toasts one state of the Now stream raises, and what the tab has heard after it: one per run that
 * ended, one when Scout's count of new findings rises, and one when a usage window crosses 90%.
 */
export function nowToasts(before: Heard | null, state: BoardState<NowSnapshot>, now: number, hrefs: ToastHrefs, timeZone?: string): { heard: Heard | null; toasts: ToastItem[] } {
  const snapshot = state.snapshot;
  if (snapshot === null) return { heard: before, toasts: [] };
  const ended = snapshot.ended ?? [];
  // The connection's own empty set until the first limits event, which is a server's object even when
  // it holds no reading.
  const near = state.limits === NO_LIMITS ? null : nearToasts(state, now, hrefs, timeZone);
  const heardNear = near === null ? null : new Set(near.keys());
  if (before === null) {
    return { heard: { runs: new Set(ended.map((run) => run.runId)), since: ended.reduce((newest, run) => (run.endedAt > newest ? run.endedAt : newest), ''), fresh: snapshot.scout.fresh, near: heardNear }, toasts: [] };
  }

  // Oldest first, so the newest ends at the bottom of the stack.
  const runs = ended.filter((run) => !before.runs.has(run.runId) && run.endedAt >= before.since).reverse();
  const toasts = runs.map((run) => runToast(run, hrefs));
  // The count drops to 0 when the person opens Scout, which is no finding. No toast while Scout waits
  // for a later version: it would point at a page that is not there.
  const found = snapshot.scout.fresh - before.fresh;
  if (SCOUT_AND_EVIDENCE && found > 0) {
    const title = `Scout: ${found} new ${found === 1 ? 'finding' : 'findings'}`;
    toasts.push({ kind: 'info', card: { key: 'Scout', href: hrefs.scout }, title, message: '', note: snapshot.scout.newest?.source ?? null });
  }
  // The first limits event replays the readings, so a window already near its limit then is not news.
  const seen = before.near;
  if (near !== null && seen !== null) for (const [key, toast] of near) if (!seen.has(key)) toasts.push(toast);
  return { heard: { runs: new Set([...before.runs, ...runs.map((run) => run.runId)]), since: before.since, fresh: snapshot.scout.fresh, near: heardNear ?? before.near }, toasts };
}
