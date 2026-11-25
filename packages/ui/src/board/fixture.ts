import type { BoardSnapshot, CardView, DeliveryFlow, StageView } from '@nolzu/protocol';

// The board shape, written out by hand. packages/ui may import protocol only, so it cannot
// call deliveryBoard from core. A test in apps/local, which may import both, checks these
// stage ids against the real board, so the fixture cannot drift away from it in silence.
const starts = (phase: 'refine' | 'plan' | 'implement' | 'qa', model: string, effort: 'low' | 'medium' | 'high') => ({
  phase,
  model,
  effort,
  engine: 'claude-code', modelState: 'ok' as const, refusal: null,
});

export function stageFixture(over: Partial<StageView> & Pick<StageView, 'id' | 'label' | 'role'>): StageView {
  return { count: 0, cadence: null, starts: null, ...over };
}

export function cardFixture(over: Partial<CardView> & Pick<CardView, 'key'>): CardView {
  return {
    title: 'Add a search box to the recipe list',
    stage: 'inbox',
    state: 'idle',
    queuePosition: null,
    runId: null,
    runState: null,
    runStartedAt: null,
    lane: null,
    engine: null,
    model: null,
    effort: null,
    costUsd: null,
    totalUsd: null,
    question: null,
    failureReason: null,
    minimized: false,
    verdict: null,
    verdictReason: null,
    pull: null,
    starts: null,
    delivered: null,
    ...over,
  };
}

// Pull request carries no starts descriptor, because it starts no phase of its own. The board has to
// show that rather than promise a run that will not happen. It polls nothing, so it has no cadence.
export function boardFixture(flow: DeliveryFlow, cards: readonly CardView[] = []): BoardSnapshot {
  const handoff = stageFixture({ id: 'pr-watch', label: 'Pull request', role: 'auto', says: 'waits on GitHub' });

  return {
    version: 1,
    kind: 'delivery',
    flow,
    stages: [
      stageFixture({ id: 'inbox', label: 'Inbox', role: 'you', says: 'you pick what goes next' }),
      stageFixture({ id: 'refine', label: 'Refine', role: 'agent', starts: starts('refine', 'haiku', 'low') }),
      stageFixture({ id: 'plan', label: 'Plan', role: 'agent', starts: starts('plan', 'sonnet', 'medium') }),
      stageFixture({ id: 'implement', label: 'Implement', role: 'agent', starts: starts('implement', 'sonnet', 'medium') }),
      stageFixture({ id: 'qa', label: 'QA', role: 'agent', starts: starts('qa', 'sonnet', 'medium') }),
      stageFixture({ id: 'review', label: 'Review', role: 'you', says: 'you read the change, then push' }),
      handoff,
      stageFixture({ id: 'wrapup', label: 'Wrap-up', role: 'agent' }),
      stageFixture({ id: 'closed', label: 'Closed', role: 'archive' }),
    ],
    cards,
    slots: { busy: 0, total: 3 },
    lanes: [
      { name: 'stack', heldBy: null },
      { name: 'knowledge', heldBy: null },
      { name: 'scout', heldBy: null },
    ],
  };
}
