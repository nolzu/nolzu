import { SYNCED_DATA } from '@nolzu/protocol';
import { expect, it, vi } from 'vitest';
import { column, NO_DATA, TEAM_CARD_STATE } from './data-leaves.ts';

// Scout and Evidence are off as shipped. This file pins the columns once the switch is on again, and
// coming-soon.test.ts pins the off state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), SCOUT_AND_EVIDENCE: true }));

// The eight runner messages, by hand. Reading them off `RUNNER_MESSAGES` would pass whatever that list
// held, and a message that started travelling with no place on the page is what this file is for.
const SENDS = ['card.state', 'evidence.blocks', 'finding.results', 'knowledge.proposals', 'project.sync', 'scout.schedule', 'report.weekly', 'run.cost'];

const rows = (to: 'hub' | 'team') => column(to).flatMap((group) => group.rows);

it('puts every SYNCED_DATA entry in a column', () => {
  const placed = new Set([...rows('hub'), ...rows('team')].map((row) => row.type));

  expect([...placed].sort()).toEqual([...SENDS].sort());
  expect(Object.keys(SYNCED_DATA).sort()).toEqual([...SENDS].sort());
});

// The personal hub gets the protocol's own sentence, so the page and the wire cannot drift apart.
it('says what the protocol says for each message to your hub', () => {
  for (const row of rows('hub')) expect(row.says).toBe(SYNCED_DATA[row.type]);
});

// The order and the groups of the list, the board first and the project last.
it('groups your hub column in that order', () => {
  expect(column('hub').map((group) => [group.name, group.rows.map((row) => row.type)])).toEqual([
    ['Board and runs', ['card.state']],
    ['Evidence and reports', ['evidence.blocks', 'report.weekly']],
    ['Scout', ['finding.results', 'scout.schedule']],
    ['Project', ['project.sync']],
  ]);
});

// `run.cost` and `knowledge.proposals` go up the team socket only, and `card.state` goes up both.
it('puts the cards, the run costs and the knowledge proposals in the team column, and nothing else', () => {
  expect(column('team').map((group) => [group.name, group.rows.map((row) => row.type)])).toEqual([
    ['Cards and stage moves', ['card.state']],
    ['For each run', ['run.cost']],
    ['For each knowledge proposal', ['knowledge.proposals']],
  ]);
  expect(rows('hub').map((row) => row.type)).not.toContain('run.cost');
  expect(rows('hub').map((row) => row.type)).not.toContain('knowledge.proposals');
});

// The team socket sends `card.state` without its runs, so its line there is not the protocol's,
// which names the runs. Written out whole, so it cannot drift back to the line with the question in it.
it('says the team gets the cards without the runs', () => {
  const card = rows('team').find((row) => row.type === 'card.state');

  expect(card?.says).toBe(TEAM_CARD_STATE);
  expect(TEAM_CARD_STATE).toBe("The cards and stage moves of the team project, without the runs or the next start. A run's question with its answers, its plain summary, verdict reason and failure stay with your own hub.");
  for (const row of rows('team').filter((one) => one.type !== 'card.state')) expect(row.says).toBe(SYNCED_DATA[row.type]);
});

// The frames that carry nothing still leave the machine, so the page names them too.
it('names the frames that carry no data', () => {
  expect([...NO_DATA]).toEqual(['job.ack', 'ping', 'pong']);
});
