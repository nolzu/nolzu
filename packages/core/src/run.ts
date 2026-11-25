import type { CardState, RunEvent, RunRecord, RunTokens } from '@nolzu/protocol';

// The counts of a run's own model calls added up, or null when it reported none. A call named on
// several lines counts once, with its last line, as in `tokensSoFar`.
function usageTotal(events: readonly RunEvent[]): RunTokens | null {
  const calls = new Map<string | number, RunTokens>();
  events.forEach((event, at) => {
    if (event.type === 'usage') calls.set(event.id ?? at, event.tokens);
  });
  if (calls.size === 0) return null;
  const total = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  for (const one of calls.values()) {
    total.input += one.input;
    total.output += one.output;
    total.cacheRead += one.cacheRead;
    total.cacheCreation += one.cacheCreation;
  }
  return total;
}

export function stateAfterRun(events: readonly RunEvent[]): CardState {
  const has = (type: RunEvent['type']) => events.some((event) => event.type === type);
  // A failed run needs a retry before anyone answers a question it asked.
  if (has('failed')) return 'failed';
  // A run that asks a question still ends with complete, so the question decides first.
  if (has('needs_input')) return 'blocked';
  // A stream that ends with no result stopped early, and a card must never look done by accident.
  return has('complete') ? 'ready' : 'failed';
}

// A run a person stopped is reported by the caller, because the engine sends no event for it.
export function foldRun(events: readonly RunEvent[], stopped = false): RunRecord {
  let sessionId: string | null = null;
  let model: string | null = null;
  let costUsd: number | null = null;
  let durationMs: number | null = null;
  let tokens: RunRecord['tokens'] = null;
  let question: string | null = null;
  let failureReason: string | null = null;
  let failureStatus: number | null = null;
  let retry: RunRecord['retry'] = null;
  let sessionTotal = false;
  let state: RunRecord['state'] = 'running';
  let ended = false;

  for (const event of events) {
    switch (event.type) {
      case 'session':
        sessionId = event.sessionId;
        model = event.model;
        break;
      case 'needs_input':
        question = event.question;
        break;
      case 'api_retry':
        // The wait the run is sitting in. Cleared by whatever ends the run, so a finished record
        // never shows a countdown that already passed.
        // A wait Nolzu holds says when the next try starts, which is what a countdown reads.
        retry = { attempt: event.attempt, delayMs: event.delayMs, reason: event.reason, ...(event.until === undefined ? {} : { until: event.until, maxRetries: event.maxRetries }) };
        state = 'retrying';
        break;
      case 'complete':
        costUsd = event.costUsd;
        sessionTotal = event.sessionTotal === true;
        durationMs = event.durationMs;
        tokens = event.tokens;
        retry = null;
        state = 'complete';
        ended = true;
        break;
      case 'failed':
        failureReason = event.reason;
        failureStatus = event.status;
        // A failed run keeps what it spent. Dropping it would take real money out of every roll-up
        // above, and the run is still a failure either way.
        if (event.costUsd !== undefined) {
          costUsd = event.costUsd;
          sessionTotal = event.sessionTotal === true;
        }
        if (event.durationMs !== undefined) durationMs = event.durationMs;
        if (event.tokens !== undefined) tokens = event.tokens;
        retry = null;
        state = 'failed';
        ended = true;
        break;
      default:
        break;
    }
  }

  // An end that names no counts, and a stream that stopped early: what
  // the run's own calls reported is what it spent.
  tokens ??= usageTotal(events);

  // A stream that stopped early reported no result, and a run must never look finished by
  // accident. A run still waiting on a retry has not ended and is not a failure yet.
  if (!ended && state !== 'retrying') state = 'failed';

  // The card keeps its own six states: a run that ended complete leaves a card blocked when it
  // asked something, which is why this is not copied from the run state.
  const cardState = state === 'retrying' ? 'running' : stateAfterRun(events);

  // A person pressing stop is not the machine failing, so the card goes back to
  // idle in its stage. Nothing is reported as spent: the engine sends no result for a stopped
  // run, so a cost here would be invented.
  // A run a check after it stopped stays failed even when a person stopped it too: what it left on
  // disk must be looked at before the card runs again.
  if (stopped && !events.some((event) => event.type === 'failed' && event.halted === true)) {
    return { sessionId, model, costUsd: null, durationMs: null, tokens: null, question, failureReason, failureStatus, state: 'stopped', cardState: 'idle', retry: null };
  }

  return { sessionId, model, costUsd, durationMs, tokens, question, failureReason, failureStatus, state, cardState, retry, ...(sessionTotal ? { costIsSessionTotal: true } : {}) };
}
