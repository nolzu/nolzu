import { ASK_PHASE, CONFIG_DIR_VAR, DELIVERY_PHASES, type DeliveryPhase, type EngineName, isPass, phaseLabel } from '@nolzu/protocol';

/**
 * The discussion threads a card has.
 *
 * One per phase that ran, one per review action, and one "ask" thread that belongs to no phase and
 * holds a read-only session of its own.
 * A phase that never ran has no thread, because a thread with nothing in it and no session behind
 * it is a box that cannot send.
 */
export const ASK_THREAD = 'ask';

export type ThreadKind = 'phase' | 'review' | 'ask' | 'feedback';

export interface Thread {
  // The stored id: a phase id, a review ref such as `F1`, a pull request comment ref such as `T3`, or `ask`.
  id: string;
  kind: ThreadKind;
  label: string;
  // The session a message in this thread continues, or null when there is none. A thread with no
  // session takes no message: there is nothing to resume.
  sessionId: string | null;
  // The engine profile that session belongs to. A resume runs on the profile the run recorded,
  // never on what the action table says at that moment, because a session lives inside one login.
  engine: string | null;
  // The run the session came from, so a message can be stored against it.
  runId: number | null;
}

// One finished run, as the thread list reads it.
export interface RunRow {
  id: number;
  phase: string;
  sessionId: string | null;
  engine: string;
}

// The phase names come off the one map in the protocol, so a phase added to a board gets its name
// here without a second table to remember.
export const threadLabel = (id: string): string =>
  id === ASK_THREAD ? 'Ask' : isAskThread(id) ? `Ask ${askNumber(id)}` : phaseLabel(id);

// `ask` is the first discussion and `ask-<n>` every later one, from 2 up. One spelling per number, so
// a URL cannot open the same discussion under two ids.
export const isAskThread = (id: string): boolean => id === ASK_THREAD || /^ask-(?:[2-9]|[1-9]\d+)$/.test(id);

// A discussion on the card's own pull requests, as the PRs tab names it. Discuss opens a read-only
// session about it under that ref, which goes on like an ask discussion.
export const isFeedbackRef = (id: string): boolean => /^T[1-9]\d*$/.test(id);

const askNumber = (id: string): number => (id === ASK_THREAD ? 1 : Number(id.slice(ASK_THREAD.length + 1)));

/**
 * The ask discussions of one card, newest first, and the id a new one takes.
 *
 * `stored` is every thread id the card has messages in. A discussion exists once something is
 * written in it, so the next one is listed only while the URL opens it, and an empty one left
 * behind costs nothing. The first one is always there, as it was before there could be more.
 */
export function askThreads(stored: readonly string[], wanted: string | null): { ids: string[]; next: string } {
  const numbers = new Set([1, ...stored.filter(isAskThread).map(askNumber)]);
  const next = Math.max(...numbers) + 1;
  if (wanted !== null && isAskThread(wanted) && askNumber(wanted) === next) numbers.add(next);
  const ids = [...numbers].sort((one, two) => two - one).map((n) => (n === 1 ? ASK_THREAD : `${ASK_THREAD}-${n}`));
  return { ids, next: `${ASK_THREAD}-${next}` };
}

/**
 * The threads for one card, newest run per phase.
 *
 * A phase that ran more than once keeps the newest run's session, because that is the
 * conversation a person is looking at. The rows come newest first. `askRuns` is the run each ask
 * discussion goes on in, by its id, which the caller reads off the run rows. `feedback` is the pull
 * request comment refs a Discuss opened, and each goes on in its Ask run the same way.
 */
export function threadsFor(
  runs: readonly RunRow[],
  reviewRefs: readonly string[] = [],
  asks: readonly string[] = [ASK_THREAD],
  askRuns: Readonly<Record<string, RunRow>> = {},
  feedback: readonly string[] = [],
): Thread[] {
  const byPhase = new Map<string, RunRow>();
  for (const run of runs) {
    // The first row wins, and the caller orders newest first. A pass is not a phase: it has no
    // stage, nobody talks to it, and its session is not the phase's. An Ask run belongs to the ask
    // discussion that started it, which `askRuns` names. A triage is a side run of the PRs tab, and
    // nobody talks to it either.
    if (isPass(run.phase) || run.phase === ASK_PHASE || run.phase === 'feedback') continue;
    if (!byPhase.has(run.phase)) byPhase.set(run.phase, run);
  }

  const phases: Thread[] = [...byPhase.values()].map((run) => ({
    id: run.phase,
    kind: 'phase' as const,
    label: threadLabel(run.phase),
    sessionId: run.sessionId,
    engine: run.engine,
    runId: run.id,
  }));

  const reviews: Thread[] = reviewRefs.map((ref) => ({
    id: ref,
    kind: 'review' as const,
    label: ref,
    sessionId: null,
    engine: null,
    runId: null,
  }));

  // Each ask discussion goes on in the read-only session its first message started, and one with
  // no run yet starts that session. The caller hands them newest first, from `askThreads`.
  const own: Thread[] = asks.map((id) => {
    const run = askRuns[id];
    return { id, kind: 'ask' as const, label: threadLabel(id), sessionId: run?.sessionId ?? null, engine: run?.engine ?? null, runId: run?.id ?? null };
  });
  const comments: Thread[] = feedback.map((ref) => {
    const run = askRuns[ref];
    return { id: ref, kind: 'feedback' as const, label: ref, sessionId: run?.sessionId ?? null, engine: run?.engine ?? null, runId: run?.id ?? null };
  });
  return [...phases, ...reviews, ...comments, ...own];
}

export type SendRefusal = { ok: false; reason: string } | { ok: true; thread: Thread };

/**
 * Whether a message can be sent to a thread.
 *
 * An ask discussion, and the discussion of a pull request comment, always takes one: it goes on in
 * its read-only session, or starts one. Every
 * other thread continues its phase's own session, and one whose phase never kept a session refuses
 * rather than offering a box that cannot send.
 */
export function canSend(threads: readonly Thread[], threadId: string, text: string): SendRefusal {
  const thread = threads.find((one) => one.id === threadId);
  if (thread === undefined) return { ok: false, reason: `There is no ${threadId} thread on this card.` };
  if (text.trim() === '') return { ok: false, reason: 'The message is empty.' };
  if (thread.kind !== 'ask' && thread.kind !== 'feedback' && thread.sessionId === null) {
    return {
      ok: false,
      reason: `The ${thread.label} thread has no session to continue. Move the card forward to start one.`,
    };
  }
  return { ok: true, thread };
}

// What the composer says it is about to do, so a person sees which session and which login a
// message continues before they send it. The profile is named only when there is one.
export function sendLabel(thread: Thread): string {
  if (thread.kind === 'ask' && thread.sessionId === null) return 'Starts a read-only session that reads the card and its code.';
  if (thread.kind === 'feedback' && thread.sessionId === null) return `Starts a read-only session about ${thread.label} that reads the card and its code.`;
  if (thread.sessionId === null) return `${thread.label} has no session to continue.`;
  return `Continues session ${thread.sessionId} on ${thread.engine ?? 'the recorded profile'}.`;
}

// Whether a name is a phase a stage can start, on any board. The name is the type's, which is
// Delivery's for the reason `packages/protocol/src/board.ts` gives, so this answers true for
// `pr-review`, `investigate` and `research` as well. It is not a question about which board a card is
// on: both callers use it to ask whether a phase runs at all.
export const isDeliveryPhase = (id: string): id is DeliveryPhase => (DELIVERY_PHASES as readonly string[]).includes(id);

// How each vendor CLI continues a session by id in a terminal, read off each binary's own help.
// Codex is the one whose interactive form differs from what a run uses: a run passes `exec resume`,
// and a person at a terminal wants the interactive `resume`.
const RESUME: Readonly<Record<EngineName, string>> = {
  'claude-code': 'claude --resume',
  codex: 'codex resume',
  cursor: 'cursor-agent --resume',
};

// One shell word, whatever is in it. A single quote ends the quoting, so it is closed, escaped and
// opened again.
const shellWord = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The command that continues a phase's session at a terminal.
 *
 * It starts in the folder the run started in, because Claude Code files a session under that
 * folder, and it names the profile's config folder when the profile has one, because a session
 * lives inside one login. No token is in it: the login stays where the vendor keeps it.
 */
export function resumeCommand(at: { vendor: EngineName; sessionId: string; folder: string; configDir: string | null }): string {
  const variable = CONFIG_DIR_VAR[at.vendor];
  const login = at.configDir !== null ? `${variable}=${shellWord(at.configDir)} ` : '';
  return `cd ${shellWord(at.folder)} && ${login}${RESUME[at.vendor]} ${shellWord(at.sessionId)}`;
}
