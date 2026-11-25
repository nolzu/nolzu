// The chain suggestion on Now, as pure rules over stored events. The database read is in
// `chain-store.ts`, so this file stays safe for the page to import.

/**
 * How many plans in a row a person approved as they came before Now suggests the chain.
 *
 * Five is about a week of steady use on one project: enough that one lucky card does not count, and
 * low enough that the card shows while the habit is still forming. The chain it offers covers only
 * cards the person ticked, and it can be turned off from the same place.
 */
export const CHAIN_SUGGEST_AFTER = 5;

// One stage move, as `card_events` stores it.
export interface PlanMove {
  id: number;
  key: string;
  from: string | null;
  to: string;
  who: string;
  startedPhase: string | null;
  at: string;
}

// A person's move out of Plan, named by that move's id, and whether the plan went on as it came.
export interface PlanDecision {
  id: number;
  unchanged: boolean;
}

// What Now's suggestion slot shows: the chain is on, or the suggestion with the count it says, or
// nothing at all.
export interface ChainView {
  on: boolean;
  // The unchanged approvals in a row when the suggestion shows, and null when it does not.
  approved: number | null;
}

/**
 * Every plan a person decided, oldest first.
 *
 * A round is the time a card spends in the chain's first stage after a forward move started its phase.
 * The person's move out of it decides: on to the next stage is an approval, and anything else sends
 * the plan back. An approval counts as unchanged when the round held one run of the phase, because an
 * answer, a discussion message and a retry each start one more. A plan edited by hand outside Nolzu
 * leaves no event, so it reads as unchanged.
 *
 * `moves` come in id order, and `runs` are the start times of the phase's runs (the end time for a run
 * stopped before it started). A chain's own move is not a person's decision, and a card moved back into
 * the stage holds the plan approved before, so neither counts.
 */
export function planDecisions(moves: readonly PlanMove[], runs: readonly { key: string; at: string | null }[], chain: { from: string; to: string }): PlanDecision[] {
  const open = new Map<string, PlanMove>();
  const decided: PlanDecision[] = [];
  for (const move of moves) {
    if (move.from === chain.from) {
      const entry = open.get(move.key);
      open.delete(move.key);
      if (entry === undefined || move.who !== 'you') continue;
      // Both columns are written by sqlite in one ISO form, so the later string is the later time.
      const ran = runs.filter((one) => one.key === move.key && one.at !== null && one.at >= entry.at && one.at <= move.at).length;
      decided.push({ id: move.id, unchanged: move.to === chain.to && ran === 1 });
    }
    if (move.to === chain.from && move.startedPhase !== null) open.set(move.key, move);
  }
  return decided;
}

/**
 * The count the suggestion says, or null when it does not show.
 *
 * It counts back from the newest decision until the first changed plan. `notNow` is the newest move
 * when the person pressed Not now: the card comes back only once enough plans decided after it were
 * approved as they came, and it then says the whole run, older ones included.
 */
export function suggestAfter(decisions: readonly PlanDecision[], notNow: number): number | null {
  let streak = 0;
  let fresh = 0;
  for (const decision of [...decisions].reverse()) {
    if (!decision.unchanged) break;
    streak += 1;
    if (decision.id > notNow) fresh += 1;
  }
  return fresh >= CHAIN_SUGGEST_AFTER ? streak : null;
}

// The sentence with the real count, which is never below the threshold, so always plural.
export const suggestionText = (approved: number): string =>
  `You approved ${approved} of the last ${approved} plans without a change. Let Implement start right after Plan on the cards you tick?`;
