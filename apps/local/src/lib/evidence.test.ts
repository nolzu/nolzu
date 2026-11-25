import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, spendReport, writeSetting } from '@nolzu/core/node';
import { KB_MAINTENANCE_KEY, NO_EVIDENCE } from '@nolzu/protocol';
import { branchName } from '@nolzu/runner';
import { render } from 'svelte/server';
import { afterEach, beforeEach, expect, it } from 'vitest';
import EvidenceDay from './EvidenceDay.svelte';
import { evidenceFor, runPhases, standupFor } from './evidence.ts';

// One day, pinned, because the whole feature is about which day a thing belongs to. The suite runs
// with TZ=UTC, so a stamp written here is the stamp the fold reads.
const DAY = '2026-03-04';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-evidence-'));
  db = openDatabase(dir);
  card('APP-1', 'Add a search box');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function card(key: string, title: string, stage = 'implement'): void {
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, 'idle', ?)").run(key, stage, title);
}

// A run with its times set by hand. The columns are stamped by the database clock, and this test is
// about the day, so both stamps are written after the insert the way the cost report's test does it.
function run(over: { card?: string; phase?: string; started?: string | null; ended?: string | null; cost?: number | null; state?: string; verdict?: string }): number {
  const written = db
    .prepare("INSERT INTO runs (card_key, phase, engine, log_path, state) VALUES (?, ?, 'claude-code', ?, ?)")
    .run(over.card ?? 'APP-1', over.phase ?? 'implement', join(dir, 'run.ndjson'), over.state ?? 'complete');
  const id = Number(written.lastInsertRowid);
  db.prepare('UPDATE runs SET started_at = ?, ended_at = ?, cost_estimate = ?, duration_ms = ?, verdict = ? WHERE id = ?').run(
    over.started ?? null,
    over.ended ?? null,
    over.cost ?? null,
    over.ended == null ? null : 60_000,
    over.verdict ?? null,
    id,
  );
  return id;
}

function move(over: { card?: string; from?: string | null; to: string; at: string }): void {
  db.prepare('INSERT INTO card_events (card_key, from_stage, to_stage, who, at) VALUES (?, ?, ?, ?, ?)').run(
    over.card ?? 'APP-1',
    over.from ?? null,
    over.to,
    'you',
    over.at,
  );
}

/**
 * The project's own repository, made in the temp folder and set as the project path.
 *
 * Empty config files and a fixed author, so the developer's own git config never reaches a fixture
 * and the suite answers the same on every machine.
 */
function project(): Record<string, string> {
  const work = join(dir, 'project');
  const config = join(dir, 'gitconfig');
  const hooks = join(dir, 'empty-hooks');
  mkdirSync(work, { recursive: true });
  mkdirSync(hooks, { recursive: true });
  writeFileSync(config, '');
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: config,
    GIT_AUTHOR_NAME: 'Demo',
    GIT_AUTHOR_EMAIL: 'demo@example.invalid',
    GIT_COMMITTER_NAME: 'Demo',
    GIT_COMMITTER_EMAIL: 'demo@example.invalid',
  };
  execFileSync('git', ['init', '-q', '-b', 'main', work], { env });
  writeSetting(db, 'projectPath', work);
  return env;
}

// One commit on one branch, at the time given. A card's work sits on the card's own branch, which
// is what the day has to reach.
const commitOn = (env: Record<string, string>, branch: string, message: string, at: string): void => {
  const work = join(dir, 'project');
  const run = (args: string[], over: Record<string, string> = {}) =>
    execFileSync('git', ['-c', `core.hooksPath=${join(dir, 'empty-hooks')}`, ...args], { cwd: work, env: { ...env, ...over } });
  run(['checkout', '-q', '-B', branch]);
  writeFileSync(join(work, 'work.txt'), `${branch} ${at}`);
  run(['add', '-A']);
  // The empty message is allowed on purpose: a commit written without one is a real thing to read.
  run(['commit', '-q', '--allow-empty-message', '-m', message], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
};

const lines = (day: { blocks: readonly { source: string; description: string }[] }) => day.blocks.map((one) => `${one.source}: ${one.description}`);

// The case the plan names, end to end and against real rows.
it('reads a day of three runs, two moves and a commit in the order they happened', async () => {
  const env = project();
  commitOn(env, 'main', 'chore: start the project', '2026-03-01T09:00:00Z');
  commitOn(env, branchName('{type}/{key}/{desc}', 'APP-1', 'Add a search box'), 'feat(search): add the search box', `${DAY}T16:20:00Z`);

  move({ from: 'inbox', to: 'implement', at: `${DAY}T09:00:00.000Z` });
  run({ started: `${DAY}T09:00:01.000Z`, ended: `${DAY}T09:20:00.000Z`, cost: 0.02 });
  move({ from: 'implement', to: 'qa', at: `${DAY}T12:10:00.000Z` });
  run({ phase: 'qa', started: `${DAY}T12:10:02.000Z`, ended: `${DAY}T12:30:00.000Z`, cost: 0.01, verdict: 'PASS' });
  run({ phase: 'wrapup', started: `${DAY}T14:45:00.000Z`, ended: `${DAY}T15:00:00.000Z`, cost: 0.03 });

  const day = await evidenceFor(db, { day: DAY, env });

  expect(day.problem).toBeNull();
  expect(lines(day)).toEqual([
    'move: Moved from Inbox to Implement',
    'run: Implement run, finished',
    'move: Moved from Implement to QA',
    'run: QA run, passed',
    'run: Wrap-up run, finished',
    'commit: feat(search): add the search box',
  ]);
  // The commit came off a card branch, so it carries the card and the screen can link it.
  expect(day.blocks.at(-1)?.card).toBe('APP-1');
  expect(day.spend.runs).toBe(3);
});

it('links a commit to the card whose branch it sits on, not to another card', async () => {
  const env = project();
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-2', 'delivery', 'implement', 'idle', 'Print the shopping list')").run();
  commitOn(env, 'main', 'chore: start the project', '2026-03-01T09:00:00Z');
  commitOn(env, branchName('{type}/{key}/{desc}', 'APP-2', 'Print the shopping list'), 'feat(list): print it', `${DAY}T16:20:00Z`);

  const day = await evidenceFor(db, { day: DAY, env });

  expect(day.blocks.find((one) => one.source === 'commit')?.card).toBe('APP-2');
});

it('links a commit to a started card by the branch its checkout is on, after the template changed', async () => {
  const env = project();
  const work = join(dir, 'project');
  commitOn(env, 'main', 'chore: start the project', '2026-03-01T09:00:00Z');
  commitOn(env, 'APP-1-add-a-search-box', 'feat(search): add the search box', `${DAY}T16:20:00Z`);
  execFileSync('git', ['checkout', '-q', 'main'], { cwd: work, env });
  execFileSync('git', ['worktree', 'add', '-q', join(work, 'worktrees', 'APP-1'), 'APP-1-add-a-search-box'], { cwd: work, env });

  // The project stored no template, so the default now names a different branch for APP-1.
  const day = await evidenceFor(db, { day: DAY, env });

  expect(day.blocks.find((one) => one.source === 'commit')?.card).toBe('APP-1');
});

it('keeps the commits of a day when the stored template names no placeholder it knows', async () => {
  const env = project();
  // The settings screen refuses this, so only a hand edit stores it.
  writeSetting(db, 'branchTemplate', '{key}/{nope}');
  commitOn(env, 'APP-1/work', 'feat(search): add the search box', `${DAY}T16:20:00Z`);

  const day = await evidenceFor(db, { day: DAY, env });

  expect(day.problem).toBeNull();
  expect(day.blocks.find((one) => one.source === 'commit')).toMatchObject({ description: 'feat(search): add the search box', card: null });
});

// The word each timeline block prints is the run's phase, read off the row and never out of the
// sentence, which is written for people.
it('names the phase of each run of the day, and only of that day', async () => {
  run({ phase: 'qa', started: `${DAY}T09:00:00.000Z`, ended: `${DAY}T09:10:00.000Z` });
  run({ phase: 'wrapup', started: `${DAY}T10:00:00.000Z`, ended: `${DAY}T10:05:00.000Z` });
  run({ phase: 'plan', started: '2026-03-05T09:00:00.000Z', ended: '2026-03-05T09:10:00.000Z' });

  expect(runPhases(db, await evidenceFor(db, { day: DAY }))).toEqual({ 1: 'qa', 2: 'wrap-up' });
});

// The day drawn: one lane per card with its key and title linked to the card's log, and each run a
// block with its phase. Every figure the old list printed is in the block's name.
it('draws one lane per card, each block with its phase and its figures', async () => {
  card('APP-2', 'Store a rating per recipe');
  run({ phase: 'plan', started: `${DAY}T09:00:00.000Z`, ended: `${DAY}T09:10:00.000Z`, cost: 0.11 });
  run({ card: 'APP-2', phase: 'refine', started: `${DAY}T10:00:00.000Z`, ended: `${DAY}T10:05:00.000Z` });
  move({ card: 'APP-2', from: 'inbox', to: 'refine', at: `${DAY}T09:59:00.000Z` });
  const day = await evidenceFor(db, { day: DAY });

  const body = render(EvidenceDay, { props: { day, cardHref: (key: string) => `/t/${key}/log`, phases: runPhases(db, day) } }).body;

  expect(body.match(/data-lane=/g)).toHaveLength(2);
  // The ruler and the blocks print UTC clocks, so the screen says so where a person reads them.
  expect(body).toContain('>Hours in UTC<');
  expect(body).toMatch(/<div class="lab[^"]*">[\s\S]*?<a href="\/t\/APP-1\/log"/);
  expect(body).toMatch(/<div class="lab[^"]*">[\s\S]*?<a href="\/t\/APP-2\/log"/);
  expect(body).toContain('Add a search box');
  expect(body).toContain('aria-label="APP-1 Plan run, finished, 09:00, 1m 00s, $0.11"');
  expect(body).toMatch(/>plan<\/span>/);
  expect(body).toContain('aria-label="APP-2 Moved from Inbox to Refine, 09:59"');
  expect(body).toContain('aria-label="APP-2 Refine run, finished, 10:00, 1m 00s, no cost reported"');
});

// The second half of the plan's test. The words are in the view, so no component has to be mounted
// to read them, and the list is not drawn at all rather than drawn empty.
it('says a day with nothing on it is empty, and draws no row', async () => {
  const day = await evidenceFor(db, { day: DAY });

  expect(day.blocks).toEqual([]);
  const body = render(EvidenceDay, { props: { day, cardHref: (key: string) => `/t/${key}/log` } }).body;
  expect(body).toContain(NO_EVIDENCE);
  expect(body).not.toContain('<li');
  expect(body).not.toContain('<ol');
});

// The rule, asserted against the cost report itself so the two cannot drift apart.
it('groups a day the way the cost report does', async () => {
  run({ started: `${DAY}T23:30:00.000Z`, ended: `${DAY}T23:40:00.000Z`, cost: 0.05 });
  run({ started: '2026-03-05T00:30:00.000Z', ended: '2026-03-05T00:40:00.000Z', cost: 0.07 });

  const first = await evidenceFor(db, { day: DAY });
  const second = await evidenceFor(db, { day: '2026-03-05' });
  const byDay = spendReport(db).byDay;

  expect(first.day).toBe(DAY);
  expect(first.blocks.map((one) => one.ref)).toEqual(['1']);
  expect(second.blocks.map((one) => one.ref)).toEqual(['2']);
  expect(first.spend).toEqual(byDay.get(DAY));
  expect(second.spend).toEqual(byDay.get('2026-03-05'));
});

// A run over midnight belongs to the day it started and to no other, which is the timesheet's rule
// as well as the cost report's.
it('keeps a run that crossed midnight on the day it started', async () => {
  run({ started: `${DAY}T23:50:00.000Z`, ended: '2026-03-05T00:20:00.000Z', cost: 0.04 });

  expect((await evidenceFor(db, { day: DAY })).blocks.map((one) => one.ref)).toEqual(['1']);
  expect((await evidenceFor(db, { day: '2026-03-05' })).blocks).toEqual([]);
});

// A run still going says so, and shows no cost and no duration rather than a nought that reads as
// free and instant.
it('says a run is still going, and shows it no cost and no duration', async () => {
  run({ started: `${DAY}T09:00:00.000Z`, ended: null, state: 'running' });

  const block = (await evidenceFor(db, { day: DAY })).blocks[0];

  expect(block?.description).toBe('Implement run, still going');
  expect(block?.running).toBe(true);
  expect(block?.durationMs).toBeNull();
  expect(block?.spend?.costUsd).toBeNull();
});

// The other two verdicts of a QA run. BLOCKED is the one that matters most: QA could not get far
// enough to judge, so reading it as a failure tells a person their code is wrong when nobody looked.
it('gives a failed QA run and a blocked one each their own word', async () => {
  run({ phase: 'qa', started: `${DAY}T09:00:00.000Z`, ended: `${DAY}T09:10:00.000Z`, verdict: 'FAIL' });
  run({ phase: 'qa', started: `${DAY}T10:00:00.000Z`, ended: `${DAY}T10:10:00.000Z`, verdict: 'BLOCKED' });

  expect(lines(await evidenceFor(db, { day: DAY }))).toEqual(['run: QA run, failed', 'run: QA run, blocked']);
});

// A run that ended in one of the states that is not complete. The line names that state, here and in
// the standup a person pastes, rather than one word for every way a run can stop.
it('names the state a run that did not complete ended in', async () => {
  run({ started: `${DAY}T09:00:00.000Z`, ended: `${DAY}T09:10:00.000Z`, state: 'failed' });

  expect(lines(await evidenceFor(db, { day: DAY }))).toEqual(['run: Implement run, failed']);
});

// The runs and the commits are both cut to the day. The moves are the third source, and a move of
// another day reaches today's timeline and today's pasted standup. The move after this day is what
// says so out loud: the fold hands back the newest day it was given, so the screen would answer for a
// day nobody asked for.
it('leaves a card move of the day before and the day after off the day', async () => {
  move({ from: 'inbox', to: 'implement', at: '2026-03-03T09:00:00.000Z' });
  move({ from: 'implement', to: 'qa', at: `${DAY}T09:00:00.000Z` });
  move({ from: 'qa', to: 'review', at: '2026-03-05T09:00:00.000Z' });

  const day = await evidenceFor(db, { day: DAY });

  expect(day.day).toBe(DAY);
  expect(lines(day)).toEqual(['move: Moved from Implement to QA']);
});

// A card's first move comes from no column, so it reads as one short sentence.
it('says where a first move went, and names no column it came from', async () => {
  move({ to: 'implement', at: `${DAY}T09:00:00.000Z` });

  expect(lines(await evidenceFor(db, { day: DAY }))).toEqual(['move: Moved to Implement']);
});

// A board this version does not know, which a hand edit can write. Read through another board's
// columns the move would be drawn with a label that board never had.
it('falls back to the stored stage id on a board it does not know', async () => {
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-2', 'nonsense', 'implement', 'idle', 'Print the shopping list')").run();
  move({ card: 'APP-2', to: 'implement', at: `${DAY}T09:00:00.000Z` });

  expect(lines(await evidenceFor(db, { day: DAY }))).toEqual(['move: Moved to implement']);
});

// The ref is what the standup line carries, so it is the short sha a person can read and type, and
// not the whole forty character hash.
it('carries a commit by its short sha', async () => {
  const env = project();
  commitOn(env, 'main', 'chore: start the project', `${DAY}T09:00:00Z`);

  expect((await evidenceFor(db, { day: DAY, env })).blocks[0]?.ref).toHaveLength(7);
});

// A commit written with no message at all. Left empty the line would be a dash and a sha and nothing
// a person can read.
it('says a commit carries no message rather than showing an empty line', async () => {
  const env = project();
  commitOn(env, 'main', '', `${DAY}T09:00:00Z`);

  expect(lines(await evidenceFor(db, { day: DAY, env }))).toEqual(['commit: A commit with no message']);
});

// A queued run never started, so it is on no day. The cost report drops it the same way, and
// putting it under today would invent a day it never ran on.
it('leaves a run that never started off every day', async () => {
  run({ started: null, state: 'queued' });

  expect((await evidenceFor(db, { day: DAY })).blocks).toEqual([]);
  expect(spendReport(db).byDay.size).toBe(0);
});

// Neither of these two can be linked, so the block carries no card and its line names the owner.
// Left out they would make the day's run count disagree with the cost report for the same day.
it('keeps a maintenance run and a run whose card is gone, with no link on either', async () => {
  run({ card: KB_MAINTENANCE_KEY, phase: 'optimize', started: `${DAY}T09:00:00.000Z`, ended: `${DAY}T09:10:00.000Z`, cost: 0.01 });
  run({ card: 'APP-9', started: `${DAY}T10:00:00.000Z`, ended: `${DAY}T10:10:00.000Z`, cost: 0.02 });

  const day = await evidenceFor(db, { day: DAY });

  expect(lines(day)).toEqual(['run: Optimize run for maintenance, finished', 'run: Implement run for APP-9, finished']);
  expect(day.blocks.map((one) => one.card)).toEqual([null, null]);
  expect(day.spend.runs).toBe(2);
});

// git's %cI carries the committer's own offset. Read as digits it would put this commit on the next
// day, away from the runs it belongs beside.
it('reads a commit made in another time zone onto its UTC day', async () => {
  const env = project();
  commitOn(env, 'main', 'chore: late in the evening', '2026-03-05T01:30:00+05:00');

  const day = await evidenceFor(db, { day: DAY, env });

  expect(day.blocks.map((one) => one.start)).toEqual([`${DAY}T20:30:00.000Z`]);
  expect((await evidenceFor(db, { day: '2026-03-05', env })).blocks).toEqual([]);
});

// A folder git will not answer for is never drawn as a day with no commits: that tells a person
// nothing happened on a day they worked. The runs and the moves are still there. git refuses a
// folder that holds no repository with an exit code and a folder that is gone with a throw, so both
// are asked for here.
it('says so when the commits cannot be read, and keeps the rest of the day', async () => {
  mkdirSync(join(dir, 'plain'), { recursive: true });
  writeSetting(db, 'projectPath', join(dir, 'plain'));
  run({ started: `${DAY}T09:00:00.000Z`, ended: `${DAY}T09:10:00.000Z`, cost: 0.01 });

  const day = await evidenceFor(db, { day: DAY });

  expect(day.problem).toContain('could not be read');
  expect(day.blocks).toHaveLength(1);

  writeSetting(db, 'projectPath', join(dir, 'gone'));
  expect((await evidenceFor(db, { day: DAY })).problem).toContain('could not be read');
});

// The standup reads the board as it stands now. Inbox is not started and Closed is done, so neither
// is in progress. The blocked card is the one a run asked a question on, and it says it is blocked
// rather than being dropped. The stage is the board's own label.
it('lists the cards in progress for the standup, and marks the blocked one', async () => {
  card('APP-2', 'Fix the login redirect', 'inbox');
  card('APP-3', 'Sort the recipes', 'closed');
  card('APP-4', 'Add a print view', 'plan');
  db.prepare("UPDATE cards SET state = 'blocked' WHERE key = 'APP-4'").run();
  card('APP-5', 'Tag a recipe', 'somewhere');
  // A failed run is not a question, so only the state `blocked` counts as blocked.
  db.prepare("UPDATE cards SET state = 'failed' WHERE key = 'APP-5'").run();

  const standup = await standupFor(db, { day: '2026-03-05' });

  expect(standup.cards).toEqual([
    { key: 'APP-1', title: 'Add a search box', stage: 'Implement', blocked: false },
    { key: 'APP-4', title: 'Add a print view', stage: 'Plan', blocked: true },
    // A stage a hand edit wrote: still on the board, so still in the standup, under its stored id.
    { key: 'APP-5', title: 'Tag a recipe', stage: 'somewhere', blocked: false },
  ]);
});

// The plan's case through the gatherer: a Monday standup reads Friday's blocks, and not Sunday's.
it('reads the Friday before as yesterday on a Monday', async () => {
  run({ started: '2026-03-06T09:00:00.000Z', ended: '2026-03-06T09:10:00.000Z' });
  run({ started: '2026-03-08T09:00:00.000Z', ended: '2026-03-08T09:10:00.000Z' });

  const standup = await standupFor(db, { day: '2026-03-09' });

  expect(standup.day).toBe('2026-03-09');
  expect(standup.yesterday.day).toBe('2026-03-06');
  expect(standup.yesterday.blocks.map((one) => one.ref)).toEqual(['1']);
});

// Today has its own empty line in the States design: the day is not over, so blocks are still to come.
it('says today is empty yet, and keeps the plain line for a day that is over', async () => {
  const day = await evidenceFor(db, { day: DAY });
  const draw = (today: boolean) => render(EvidenceDay, { props: { day, today, cardHref: (key: string) => `/t/${key}/log` } }).body;

  expect(draw(true)).toContain('Nothing yet today. Every run and move lands here.');
  expect(draw(true)).not.toContain(NO_EVIDENCE);
  expect(draw(false)).toContain(NO_EVIDENCE);
});
