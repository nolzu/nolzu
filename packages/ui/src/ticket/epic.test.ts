import { describe, expect, it } from 'vitest';
import { boardFixture, cardFixture } from '../board/fixture.ts';
import { epicProgress, epicTaskRows, landLine } from './epic.ts';

const now = new Date('2026-10-15T10:00:40Z');

// One task in each state the table names: done, running with its phase, in Inbox, and not added yet.
const delivery = boardFixture('pull-request', [
  cardFixture({ key: 'APP-10', title: 'Store meal plans in the api', stage: 'closed', state: 'ready' }),
  cardFixture({ key: 'APP-18', title: 'Add tags to recipes', stage: 'refine', state: 'running', runStartedAt: '2026-10-15T10:00:00Z' }),
  cardFixture({ key: 'APP-22', title: 'Build the shopping list for a week', stage: 'inbox', state: 'idle' }),
]);
const linked = [
  { key: 'APP-10', title: 'Store meal plans in the api', done: true },
  { key: 'APP-18', title: 'Add tags to recipes', done: false },
  { key: 'APP-22', title: 'Build the shopping list for a week', done: false },
];
const planned = ['Store meal plans in the api', 'Add tags to recipes', 'Build the shopping list for a week', "Copy last week's plan"];

describe('epicTaskRows', () => {
  it('reads each task of the plan off Delivery, and proposes a key for the one not added yet', () => {
    expect(epicTaskRows({ planned, linked, delivery, nextKey: 'APP-23', now })).toEqual([
      { key: 'APP-10', title: 'Store meal plans in the api', added: true, pill: { state: 'ready', word: 'Done', detail: null } },
      { key: 'APP-18', title: 'Add tags to recipes', added: true, pill: { state: 'running', word: 'Refine', detail: '0m 40s' } },
      { key: 'APP-22', title: 'Build the shopping list for a week', added: true, pill: { state: 'idle', word: 'Inbox', detail: null } },
      { key: 'APP-23', title: "Copy last week's plan", added: false },
    ]);
  });

  it('counts the proposed keys up from the next one, past a key a Delivery card holds', () => {
    const rows = epicTaskRows({ planned: ['Add a recipe', 'Search by ingredient'], linked: [], delivery, nextKey: 'APP-9', now });

    expect(rows.map((row) => row.key)).toEqual(['APP-9', 'APP-11']);
  });

  it('says what a task waits on in a stage past Inbox', () => {
    const board = boardFixture('pull-request', [
      cardFixture({ key: 'APP-2', stage: 'plan', state: 'ready' }),
      cardFixture({ key: 'APP-3', stage: 'implement', state: 'failed' }),
      cardFixture({ key: 'APP-4', stage: 'refine', state: 'blocked' }),
      cardFixture({ key: 'APP-5', stage: 'qa', state: 'queued', queuePosition: 2 }),
    ]);
    const tasks = ['APP-2', 'APP-3', 'APP-4', 'APP-5'].map((key) => ({ key, title: key, done: false }));

    expect(epicTaskRows({ planned: [], linked: tasks, delivery: board, nextKey: null, now }).map((row) => (row.added ? row.pill : null))).toEqual([
      { state: 'ready', word: 'Plan', detail: 'ready' },
      { state: 'failed', word: 'Implement', detail: 'failed' },
      { state: 'blocked', word: 'Refine', detail: 'asks you' },
      { state: 'queued', word: 'QA', detail: 'queued' },
    ]);
  });

  // A task the person typed, or one the plan no longer names, is still the epic's.
  it("keeps a linked task the plan does not name, after the plan's own tasks", () => {
    const rows = epicTaskRows({ planned: ['Add tags to recipes'], linked, delivery, nextKey: 'APP-23', now });

    expect(rows.map((row) => row.key)).toEqual(['APP-18', 'APP-10', 'APP-22']);
  });

  // Before the first snapshot the page has only what the server read, so it says no more than that.
  it('falls back to done or open while no snapshot holds the card', () => {
    const rows = epicTaskRows({ planned: [], linked, delivery: null, nextKey: null, now });

    expect(rows.map((row) => (row.added ? row.pill.word : null))).toEqual(['Done', 'Open', 'Open']);
  });

  it('leaves the key empty when there is no next key to count from', () => {
    expect(epicTaskRows({ planned: ['Add a recipe'], linked: [], delivery, nextKey: null, now })).toEqual([{ key: '', title: 'Add a recipe', added: false }]);
  });
});

// The epic overview's Progress panel, read off the same rows as the table, so the two never disagree.
describe('epicProgress', () => {
  const extra = boardFixture('pull-request', [
    ...delivery.cards,
    cardFixture({ key: 'APP-12', title: 'Show a week view at /plan', stage: 'closed', state: 'ready' }),
    cardFixture({ key: 'APP-13', title: 'Drag a recipe into a day', stage: 'closed', state: 'ready' }),
  ]);
  const all = [...linked, { key: 'APP-12', title: 'Show a week view at /plan', done: true }, { key: 'APP-13', title: 'Drag a recipe into a day', done: true }];

  it('counts done, running with its key and stage, waiting by stage, and not added yet', () => {
    const rows = epicTaskRows({ planned: [...planned, 'Merge the same ingredient'], linked: all, delivery: extra, nextKey: 'APP-23', now });

    expect(epicProgress(rows)).toEqual({
      done: 3,
      total: 7,
      legend: [
        { tone: 'done', text: '3 done' },
        { tone: 'running', text: '1 running, APP-18 in Refine' },
        { tone: 'waiting', text: '1 in Inbox' },
        { tone: 'new', text: '2 not added yet' },
      ],
      bar: ['done', 'done', 'done', 'running', 'waiting', 'new', 'new'],
      foot: 'Wrap-up opens when all 7 are done.',
    });
  });

  it('does not count a stage that is named Done but holds a ready card as done', () => {
    const rows = [
      { key: 'APP-1', title: 'a', added: true, pill: { state: 'ready', word: 'Done', detail: 'ready' } },
      { key: 'APP-2', title: 'b', added: true, pill: { state: 'ready', word: 'Done', detail: null } },
    ] as unknown as Parameters<typeof epicProgress>[0];

    expect(epicProgress(rows)).toMatchObject({ done: 1, bar: ['done', 'waiting'] });
  });

  it('says the epic waits on the person once every task is done', () => {
    const rows = epicTaskRows({ planned: [], linked: [linked[0]!], delivery, nextKey: null, now });

    expect(epicProgress(rows)).toMatchObject({ done: 1, total: 1, legend: [{ tone: 'done', text: '1 done' }], foot: 'Every task is done. Move the epic to Wrap-up.' });
  });
});

// The line beside Add counts the tasks by kind, and a linked ticket is only read.
describe('landLine', () => {
  it('says all local, mixed and all linked, in the plural and the singular', () => {
    expect(landLine([null, null], 'Jira')).toBe('They land in Inbox as local tickets. Nothing starts.');
    expect(landLine([null], null)).toBe('It lands in Inbox as a local ticket. Nothing starts.');
    expect(landLine([null, 'PROJ-123', null, null, 'PROJ-124', null], 'Jira')).toBe(
      '4 land in Inbox as local tickets, 2 as Jira tickets (PROJ-123, PROJ-124). Nothing starts, and nothing is written to Jira.',
    );
    expect(landLine([null, 'PROJ-123'], 'Jira')).toBe('1 lands in Inbox as a local ticket, 1 as a Jira ticket (PROJ-123). Nothing starts, and nothing is written to Jira.');
    expect(landLine(['PROJ-123', 'PROJ-124'], 'Jira')).toBe('They land in Inbox as Jira tickets. Nothing starts, and nothing is written to Jira.');
    expect(landLine(['PROJ-123'], 'Jira')).toBe('It lands in Inbox as a Jira ticket. Nothing starts, and nothing is written to Jira.');
    expect(landLine([null, 'recipes#12'], 'GitHub')).toBe('1 lands in Inbox as a local ticket, 1 as a GitHub issue (recipes#12). Nothing starts, and nothing is written to GitHub.');
  });
});
