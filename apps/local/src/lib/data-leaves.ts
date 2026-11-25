import { JOB_ACK, NEVER_SENT, PING, PONG, type RunnerMessageType, SCOUT_AND_EVIDENCE, SYNCED_DATA } from '@nolzu/protocol';

// What goes to a hub, by where it goes: one list for your own hub and
// one for the team hub, and the never list.
//
// A Record over the runner messages, so a ninth message fails the typecheck here until it has a place
// on the page, the way `SYNCED_DATA` makes it say what it carries. A null group is a hub the message
// never goes to.
const GROUPS: Record<RunnerMessageType, { hub: string | null; team: string | null }> = {
  'card.state': { hub: 'Board and runs', team: 'Cards and stage moves' },
  'evidence.blocks': { hub: 'Evidence and reports', team: null },
  'report.weekly': { hub: 'Evidence and reports', team: null },
  'finding.results': { hub: 'Scout', team: null },
  'scout.schedule': { hub: 'Scout', team: null },
  'project.sync': { hub: 'Project', team: null },
  'run.cost': { hub: null, team: 'For each run' },
  'knowledge.proposals': { hub: null, team: 'For each knowledge proposal' },
};

// The team socket sends `card.state` with `runs: false` and no snapshot (`createHubSync`), so the
// protocol's line, which names the runs and the next start, would say more than the team hub gets.
export const TEAM_CARD_STATE = "The cards and stage moves of the team project, without the runs or the next start. A run's question with its answers, its plain summary, verdict reason and failure stay with your own hub.";

// The frames that carry nothing: the ack of a job, and the heartbeat both ways.
export const NO_DATA = [JOB_ACK, PING, PONG] as const;

export interface LeavesGroup {
  name: string;
  rows: { type: RunnerMessageType; says: string }[];
}

/** One column's groups, in the order of the table above. */
export function column(to: 'hub' | 'team'): LeavesGroup[] {
  const groups: LeavesGroup[] = [];
  for (const [type, where] of Object.entries(GROUPS) as [RunnerMessageType, (typeof GROUPS)[RunnerMessageType]][]) {
    const name = where[to];
    // No Scout source can exist while Scout waits, so nothing goes on these two, and the evidence
    // push and the weekly report send nothing while Evidence waits.
    if (name === null || ((name === 'Scout' || name === 'Evidence and reports') && !SCOUT_AND_EVIDENCE)) continue;
    const says = to === 'team' && type === 'card.state' ? TEAM_CARD_STATE : SYNCED_DATA[type];
    const group = groups.find((one) => one.name === name);
    if (group === undefined) groups.push({ name, rows: [{ type, says }] });
    else group.rows.push({ type, says });
  }
  return groups;
}

// `NEVER_SENT` without its Scout lines while Scout waits: with no source there is no token and
// no line to keep back. The list itself stays whole, because the site quotes it.
export const neverSent = (): readonly string[] => (SCOUT_AND_EVIDENCE ? NEVER_SENT : NEVER_SENT.filter((thing) => !thing.includes('Scout')));
