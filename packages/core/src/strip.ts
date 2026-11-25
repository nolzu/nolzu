import { type Board, phaseLabel, type Segment, spendOf, type Stage, type StripRun } from '@nolzu/protocol';

/**
 * One segment per phase an agent stage of this board runs, in board order.
 *
 * Every agent stage of the five boards that ship names a phase, so the fallback to the stage id is
 * for a board somebody builds later: an agent stage with no phase still gets a segment, rather than
 * dropping out of the trail with nothing saying why. The label is the stage's own, because a stage
 * id such as `running` reads as a state and not as a phase.
 *
 * Two stages of one phase share a segment, because drawing that phase twice would say a card had two
 * different phases when both are the same method over the same run rows. Such a segment takes the
 * phase's own name, because neither stage's name is true of both. No board that ships has two such
 * stages since Agent pre-review runs every PR review round, so this is for a board built later.
 */
export function phaseStrip(board: Board, runs: readonly StripRun[]): Segment[] {
  const agent = board.stages.filter((stage) => stage.role === 'agent');
  // `Stage`, so a phase name that is not one of the table's turns red here rather than passing as a
  // loose string and drawing a segment no run can match.
  const phaseOf = (stage: Stage): string => stage.phase ?? stage.id;
  const drawn = new Set<string>();

  return agent.flatMap((stage) => {
    const phase = phaseOf(stage);
    if (drawn.has(phase)) return [];
    drawn.add(phase);
    const mine = runs.filter((run) => run.phase === phase);
    const newest = mine.reduce<StripRun | null>((best, run) => (best === null || run.id > best.id ? run : best), null);
    const shared = agent.filter((one) => phaseOf(one) === phase).length > 1;
    return [
      {
        phase,
        label: shared ? phaseLabel(phase) : stage.label,
        run: newest,
        count: mine.length,
        spend: spendOf(mine),
      },
    ];
  });
}
