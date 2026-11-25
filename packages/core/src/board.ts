import { type Board, type BoardKind, type CardSize, type CardState, type DeliveryFlow, type DeliveryPhase, missingProfileText, type Stage, type StageView, type Ticket } from '@nolzu/protocol';
import { goneText } from './models.ts';

export type PhaseOutcome = 'complete' | 'needs_input' | 'failed';

// Pull requests are the one flow left, so every project gets the same board.
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the setting stays, so callers keep passing it
export function deliveryBoard(flow: DeliveryFlow): Board {
  // QA chains on to review on a PASS alone (`chainTo`), and a FAIL or a missing verdict leaves the
  // card ready on qa for a person to read and drag. Wrap-up chains on to the archive. Implement
  // carries no advanceOn on purpose: QA is an agent column, so a person drags the card there.
  return {
    kind: 'delivery',
    stages: [
      { id: 'inbox', label: 'Inbox', role: 'you' },
      { id: 'refine', label: 'Refine', role: 'agent', phase: 'refine' },
      { id: 'plan', label: 'Plan', role: 'agent', phase: 'plan' },
      { id: 'implement', label: 'Implement', role: 'agent', phase: 'implement' },
      { id: 'qa', label: 'QA', role: 'agent', phase: 'qa', advanceOn: 'review' },
      { id: 'review', label: 'Review', role: 'you' },
      // The label changed and the id stays, so stored cards keep their column.
      { id: 'pr-watch', label: 'Pull request', role: 'auto' },
      { id: 'wrapup', label: 'Wrap-up', role: 'agent', phase: 'wrapup', advanceOn: 'closed' },
      { id: 'closed', label: 'Closed', role: 'archive' },
    ],
  };
}

/**
 * The four boards that are not Delivery, as data.
 *
 * Their stage lists are fixed, and a test in this package holds them by writing them out
 * again. Keeping a board as data is what lets one page, one drag rule and one
 * route serve five of them, and what later allows a board builder.
 *
 * Every agent stage names the phase a forward drop starts. A phase name is not the stage id here:
 * Epics reuses Delivery's refine and plan rather than growing two skills that would say the same
 * thing, an investigation runs `investigate` on the stage called Research, and Agent pre-review runs
 * `pr-review`.
 *
 * An `advanceOn` row is where a finished run of the stage takes its card by itself (`chainTo`), and
 * every row here lands on a person's column or the archive, where nothing starts. A chain onto an
 * agent column would have to start that run, which costs money, so Epics keeps refine through design
 * manual and a person drags those cards. The chain a person may allow in advance is
 * `smallChain` below, and it covers Delivery's Plan alone.
 */
function researchStages(phase: DeliveryPhase): readonly Stage[] {
  return [
    { id: 'inbox', label: 'Inbox', role: 'you' },
    { id: 'research', label: 'Research', role: 'agent', phase, advanceOn: 'review' },
    { id: 'review', label: 'Review', role: 'you' },
    { id: 'wrapup', label: 'Wrap-up', role: 'agent', phase: 'wrapup', advanceOn: 'done' },
    { id: 'done', label: 'Done', role: 'archive' },
  ];
}

const OTHER_BOARDS: Readonly<Record<Exclude<BoardKind, 'delivery'>, readonly Stage[]>> = {
  epics: [
    { id: 'inbox', label: 'Inbox', role: 'you' },
    { id: 'refine', label: 'Refine', role: 'agent', phase: 'refine' },
    { id: 'architecture', label: 'Architecture', role: 'agent', phase: 'architecture' },
    { id: 'design', label: 'Design', role: 'agent', phase: 'design' },
    { id: 'plan', label: 'Plan', role: 'agent', phase: 'plan', advanceOn: 'review' },
    { id: 'review', label: 'Review', role: 'you' },
    { id: 'in-delivery', label: 'In delivery', role: 'auto' },
    { id: 'wrapup', label: 'Wrap-up', role: 'agent', phase: 'wrapup', advanceOn: 'done' },
    { id: 'done', label: 'Done', role: 'archive' },
  ],
  // The two kinds of the Research board share their stage ids, so one board draws the cards of both in
  // the same columns. Only the phase the Research column starts differs.
  investigations: researchStages('investigate'),
  questions: researchStages('research'),
  prreview: [
    { id: 'incoming', label: 'Incoming', role: 'you' },
    // Agent pre-review runs every round, and each one hands the card to the person who reviews it,
    // so a finished round is read before anything else happens to the card. A new push while the
    // card waits on the author sends it back to Incoming (`refreshPulls`), and the next drop runs the
    // next round.
    //
    // Every round writes into `<card folder>/pr-review/`. The skill writes the first round as
    // `round.md` and every later one as `round-<n>.md` beside it, so a later round lands beside the
    // first as long as the run counts the rounds already there. The name comes from that count, and
    // `review.ts` reads every round it finds.
    { id: 'pre-review', label: 'Agent pre-review', role: 'agent', phase: 'pr-review', advanceOn: 'my-review' },
    { id: 'my-review', label: 'My review', role: 'you' },
    { id: 'awaiting-author', label: 'Awaiting author', role: 'auto' },
    { id: 'approved', label: 'Approved', role: 'you' },
    { id: 'wrapup', label: 'Wrap-up', role: 'agent', phase: 'wrapup', advanceOn: 'closed' },
    { id: 'closed', label: 'Closed', role: 'archive' },
  ],
};

/**
 * The line under the name of a person's column or an auto column, as the board shows it.
 *
 * Kept apart from the stage rows, which the board test holds one field at a time. An
 * agent column says what a drop starts, which the models decide, and an archive column says nothing.
 */
const SAYS: Readonly<Record<BoardKind, Readonly<Record<string, string>>>> = {
  delivery: { inbox: 'you pick what goes next', review: 'you read the change, then push', 'pr-watch': 'waits on GitHub' },
  epics: { inbox: 'you pick what goes next', review: 'you read, then send the tasks', 'in-delivery': 'follows its tasks on Delivery' },
  investigations: { inbox: 'you pick what goes next', review: 'you read the answer or the report' },
  questions: { inbox: 'you pick what goes next', review: 'you read the answer or the report' },
  prreview: {
    incoming: 'you pick what to review',
    'my-review': 'you read the findings, then post',
    'awaiting-author': 'back to Incoming on a new push, on to Approved when you approve',
    approved: 'waits for the author to merge',
  },
};

export function stageSays(kind: BoardKind, stage: string): string | undefined {
  return Object.hasOwn(SAYS[kind], stage) ? SAYS[kind][stage] : undefined;
}

/**
 * The board of one kind.
 *
 * Delivery is the one kind that takes a flow, so every caller asks this rather than knowing which
 * board needs one. The flow is why it is a function here.
 */
export function boardFor(kind: BoardKind, flow: DeliveryFlow): Board {
  if (kind === 'delivery') return deliveryBoard(flow);
  return { kind, stages: OTHER_BOARDS[kind] };
}

const indexOf = (board: Board, id: string) => board.stages.findIndex((stage) => stage.id === id);

export function canMove(board: Board, card: { stage: string; state: CardState }, to: string): boolean {
  // A queued or running card belongs to its run, so a drag would collide with the agent.
  if (card.state === 'queued' || card.state === 'running') return false;
  const from = indexOf(board, card.stage);
  const target = indexOf(board, to);
  if (from < 0 || target < 0 || target === from) return false;
  return target < from || target === from + 1;
}

export function phaseOnEnter(board: Board, from: string, to: string): DeliveryPhase | undefined {
  const origin = indexOf(board, from);
  const target = indexOf(board, to);
  // Moving back never starts an agent, it only returns the card for more work.
  if (origin < 0 || target <= origin) return undefined;
  return board.stages[target]?.phase;
}

// The one forward move a card may make, which is what a Move forward button sends.
export function nextStage(board: Board, from: string): Stage | undefined {
  const origin = indexOf(board, from);
  return origin < 0 ? undefined : board.stages[origin + 1];
}

// What a Move forward button says before the click. The drop target shares its refusals and names
// the engine where this names the phase. The direction comes from phaseOnEnter, the rule moveCard
// itself asks, and the model and the effort come from the snapshot, which resolved them with the
// call that builds the job. `dropLabel` in packages/ui writes the same two sentences, and a test in
// apps/local holds the two together, because ui may not import core.
export function startsLabel(board: Board, from: string, to: string, stages: readonly StageView[]): string | undefined {
  if (phaseOnEnter(board, from, to) === undefined) return undefined;
  const starts = stages.find((stage) => stage.id === to)?.starts ?? null;
  if (starts === null) return undefined;

  if (starts.modelState === 'no-profile') return `${missingProfileText(starts.engine)} Set the row back to inherit in the card settings, or in Settings, Models.`;
  if (starts.refusal !== null) return starts.refusal;
  if (starts.modelState === 'gone') return `${goneText(starts.model)} Pick another model in the card settings, or in Settings, Models.`;
  return `Starts: /${starts.phase} · ${starts.model} · ${starts.effort}`;
}

export function advanceTo(board: Board, from: string, outcome: PhaseOutcome): string | undefined {
  // A question or a failure waits for a person, so only a completed phase chains.
  if (outcome !== 'complete') return undefined;
  return board.stages[indexOf(board, from)]?.advanceOn;
}

/**
 * Where a finished run takes its card by itself, or undefined when the card stays where it ran.
 *
 * One stage on, by the stage's `advanceOn`, and only onto a person's column or the archive: nothing
 * starts there, so the move needs no run behind it. Only a run that ended ready, and only the run of
 * the stage's own phase: a message on the refine thread runs refine while the card sits on Plan. QA
 * goes on with a PASS alone. `waits` says the run left something the person still has to act on, such
 * as a knowledge change waiting for review, and the archive would hide it, so that card stays.
 */
export function chainTo(board: Board, stage: string, run: { phase: string; state: string; verdict: string | null; waits: boolean }): string | undefined {
  const from = board.stages[indexOf(board, stage)];
  if (from === undefined || run.state !== 'ready' || from.phase !== run.phase) return undefined;
  if (run.phase === 'qa' && run.verdict !== 'PASS') return undefined;
  const to = board.stages.find((one) => one.id === advanceTo(board, stage, 'complete'));
  if (to?.role === 'archive' && run.waits) return undefined;
  return to?.role === 'you' || to?.role === 'archive' ? to.id : undefined;
}

/**
 * The one chain a person may allow in advance: on a board they turned it on
 * for, a card they ticked "Go on to Implement after Plan" on goes on from Plan to Implement by itself.
 * The tick is stored as the size small, and a card with no tick stores no size, so it never chains.
 *
 * Kept apart from the `advanceOn` rows, which never land on an agent column. This one does, so whoever
 * fires it starts that run too, through the path a drop takes. Each chain is one step onto
 * an agent stage, so it never passes a stage that waits for a person.
 */
export const SMALL_CHAINS = { delivery: { from: 'plan', to: 'implement' } } as const satisfies Partial<Record<BoardKind, { from: string; to: string }>>;

// Where a card goes after a run of `phase` ended ready, or undefined when it stays. Only the run of the
// stage's own phase chains: a message on the refine thread runs refine while the card sits on Plan.
export function smallChain(board: Board, card: { stage: string; size: CardSize | null }, phase: string, allowed: readonly BoardKind[]): string | undefined {
  const chain = Object.hasOwn(SMALL_CHAINS, board.kind) ? SMALL_CHAINS[board.kind as keyof typeof SMALL_CHAINS] : undefined;
  if (chain === undefined || card.size !== 'small' || card.stage !== chain.from || !allowed.includes(board.kind)) return undefined;
  return board.stages.find((stage) => stage.id === chain.from)?.phase === phase ? chain.to : undefined;
}

// The siblings a new card can be offered: the tickets under the same parent, without the one the
// card is being made from and without the ones already on the board. A ticket whose source reports
// no parent offers nothing, because nothing says what belongs with it.
export function relatedByParent(
  from: Ticket,
  candidates: readonly Ticket[],
  onBoard: readonly string[],
): readonly Ticket[] {
  if (from.parentKey === null) return [];

  return candidates.filter(
    (candidate) => candidate.parentKey === from.parentKey && candidate.key !== from.key && !onBoard.includes(candidate.key),
  );
}
