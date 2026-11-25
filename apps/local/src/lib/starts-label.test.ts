import { deliveryBoard, startsLabel } from '@nolzu/core';
import type { StageView, StartsDescriptor } from '@nolzu/protocol';
import { dropLabel } from '@nolzu/ui';
import { expect, it } from 'vitest';

// packages/ui may not import core, so the drop target and the Move forward button each write the
// sentence themselves. This is the one place that can see both, and it holds them to one wording.
// The refusal travels with the `vendor` state, so the two are one case here.
const STATES: readonly { modelState: StartsDescriptor['modelState']; refusal: string | null }[] = [
  { modelState: 'ok', refusal: null },
  { modelState: 'gone', refusal: null },
  { modelState: 'no-profile', refusal: null },
  { modelState: 'vendor', refusal: 'The qa phase runs the project\'s own checks, and Codex holds a read-only run to the card folder, so a check that writes anything in the project fails. Run this phase on a Claude Code profile.' },
];

it('the button and the drop target say the same thing', () => {
  const board = deliveryBoard('pull-request');
  let compared = 0;

  for (const { modelState, refusal } of STATES) {
    const stages: readonly StageView[] = board.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      role: stage.role,
      count: 0,
      cadence: null,
      starts: stage.phase === undefined ? null : { phase: stage.phase, model: 'sonnet', effort: 'medium', engine: 'codex#work', modelState, refusal },
    }));

    for (const from of board.stages) {
      for (const to of stages) {
        const said = startsLabel(board, from.id, to.id, stages);
        if (said === undefined) continue;
        expect(said).toBe(dropLabel(to, true));
        compared += 1;
      }
    }
  }

  // Seventeen forward pairs end in a stage that starts a phase, in four model states: six into
  // refine, plan and implement, four into QA, and seven into the wrap-up, which every earlier
  // stage can reach. A loop that compared nothing would pass.
  expect(compared).toBe(68);
});
