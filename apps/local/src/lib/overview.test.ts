import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, linkCards, setCardModels, setCardRepos, openDatabase, recordKnowledgeChanges, recordMove, saveQuestionOptions, saveRun, savePlainSummary, startRun, writeSetting } from '@nolzu/core/node';
import { CARD_FILE_CAP } from '@nolzu/runner';
import { Overview } from '@nolzu/ui';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Segment } from '@nolzu/protocol';
import { architectureExcerpt, cardFacts, cardKnowledge, CONTEXT_LIMIT, overviewFor, reportSources, saveContext, sourceTicket, tabCounts, unlink } from './overview.ts';
import { whenSaid } from './when-said.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-overview-'));
  db = openDatabase(dir);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'plan', title: 'Add a search box', summary: 'The list has no way to find a recipe.' });
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'inbox', title: 'Sort the list' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const run = (phase: string, state: 'complete' | 'running', summary: string | null) => {
  const id = startRun(db, { cardKey: 'APP-1', phase, engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  saveRun(db, id, { sessionId: null, model: 'haiku', costUsd: 0.01, durationMs: 1, tokens: null, question: null, failureReason: null, failureStatus: null, state, cardState: state === 'complete' ? 'ready' : 'running', retry: null });
  if (summary !== null) savePlainSummary(db, id, summary);
  return id;
};

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const request = (body: unknown) => new Request('http://localhost/api', { method: 'PATCH', body: typeof body === 'string' ? body : JSON.stringify(body) });

/**
 * The card total is taken over the card's runs and never over the strip's segments.
 *
 * The summary pass runs under a phase that is no stage of any board, so it has no segment. A total
 * built from the segments would leave its cost out and still call itself complete, which is the one
 * thing the spend rules exist to prevent.
 */
it('counts a run whose phase is no stage of the board in the card total', () => {
  run('implement', 'complete', null);
  run('extract-summary', 'complete', null);

  const view = overviewFor(db, 'APP-1');

  expect(view?.strip.flatMap((segment: Segment) => (segment.run === null ? [] : [segment.run.phase]))).not.toContain('extract-summary');
  expect(view?.spend).toMatchObject({ runs: 2, reported: 2, partial: false });
  expect(view?.spend.costUsd).toBeCloseTo(0.02);
});

it('reads refinedAt off this card, and is null when only another card was refined', () => {
  const other = startRun(db, { cardKey: 'APP-2', phase: 'refine', engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  saveRun(db, other, { sessionId: null, model: 'haiku', costUsd: 0.01, durationMs: 1, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });

  expect(overviewFor(db, 'APP-1')?.refinedAt).toBeNull();
  expect(overviewFor(db, 'APP-2')?.refinedAt).toEqual(expect.any(String));
});

it('shows the plain summary of the newest finished run, the ticket text, the context and the related cards', () => {
  run('refine', 'complete', 'The ticket is clearer now.');
  run('plan', 'complete', 'There is a plan now.');
  run('implement', 'running', null);
  linkCards(db, 'APP-1', 'APP-2');

  expect(overviewFor(db, 'APP-1')).toEqual({
    summary: 'There is a plan now.',
    // Which phase wrote it and when the run ended, which the page draws as a time ago.
    summaryFrom: 'Written after Plan',
    summaryAt: expect.any(String),
    summaryPhase: 'plan',
    built: { summary: 'There is a plan now.', phase: 'plan', at: expect.any(String) },
    ticketSource: 'local',
    refinedAt: expect.any(String),
    // Only an epic has documents and a solution.
    docs: null,
    solution: null,
    // The card is still in Plan with a run going, so there is no plan to show yet.
    plan: null,
    // Plan works from it, so the plan starts open once there is one.
    planOpen: true,
    ticket: 'The list has no way to find a recipe.',
    extra: null,
    related: [{ key: 'APP-2', title: 'Sort the list' }],
    // A Delivery card delivers no tasks of its own.
    tasks: null,
    blocked: null,
    strip: expect.any(Array),
    // Every run of the card, not the segments added up. Asserted on its own below.
    spend: expect.any(Object),
    // No move was made through the board here.
    moves: [],
    // No read-only run changed files.
    readOnlyBreak: null,
    // No Implement run committed or pushed.
    commitWarning: null,
    // The newest run is still going, so there is no review block to show yet.
    gate: null,
  });
});

it('has no summary before a run finished with one', () => {
  expect(overviewFor(db, 'APP-1')?.summary).toBeNull();
});

it('answers nothing for a card that is not there', () => {
  expect(overviewFor(db, 'APP-9')).toBeNull();
});

it('stores the extra context, and clears it with an empty text', async () => {
  expect((await saveContext(db, 'APP-1', request({ text: 'Keep the old page.' }))).status).toBe(200);
  expect(overviewFor(db, 'APP-1')?.extra).toBe('Keep the old page.');
  expect((await saveContext(db, 'APP-1', request({ text: '' }))).status).toBe(200);
  expect(overviewFor(db, 'APP-1')?.extra).toBeNull();
});

it('answers 404 for a card that is not there', async () => {
  const answer = await saveContext(db, 'APP-9', request({ text: 'x' }));
  expect(answer.status).toBe(404);
  expect((await answer.json()).message).toContain('APP-9');
});

it('refuses a body over the limit, and names the limit', async () => {
  const answer = await saveContext(db, 'APP-1', request({ text: 'x'.repeat(100_000) }));
  expect(answer.status).toBe(413);
  expect((await answer.json()).message).toContain(`${CONTEXT_LIMIT / 1000} kB`);
  expect(overviewFor(db, 'APP-1')?.extra).toBeNull();
});

it('measures the limit on the text, so quotes and line breaks do not count twice', async () => {
  const code = 'const a = "b";\n'.repeat(4000);
  expect(code.length).toBeLessThan(CONTEXT_LIMIT);
  expect(JSON.stringify({ text: code }).length).toBeGreaterThan(CONTEXT_LIMIT);

  expect((await saveContext(db, 'APP-1', request({ text: code }))).status).toBe(200);
});

it('refuses a body with no text', async () => {
  expect((await saveContext(db, 'APP-1', request({ other: 1 }))).status).toBe(400);
  expect((await saveContext(db, 'APP-1', request('not json'))).status).toBe(400);
});

it('removes a related card, and answers 404 when there was no link', () => {
  linkCards(db, 'APP-1', 'APP-2');
  expect(unlink(db, 'APP-1', 'APP-2').status).toBe(200);
  expect(overviewFor(db, 'APP-1')?.related).toEqual([]);
  expect(unlink(db, 'APP-1', 'APP-2').status).toBe(404);
});

const ask = (sessionId: string | null, question: string, key = 'APP-1') => {
  const id = startRun(db, { cardKey: key, phase: 'plan', engine: 'fake', model: 'haiku', effort: 'low', sessionId, logPath: '', lane: null });
  saveRun(db, id, { sessionId, model: 'haiku', costUsd: 0.01, durationMs: 1, tokens: null, question, failureReason: null, failureStatus: null, state: 'complete', cardState: 'blocked', retry: null });
  db.prepare("UPDATE cards SET state = 'blocked' WHERE key = ?").run(key);
  return id;
};
// The phase that asked and what it ran on, which the resume line names.
const RAN = { phase: 'plan', engine: 'fake', model: 'haiku', effort: 'low' };

it('carries the question and the session it continues while the card is blocked', () => {
  ask('11111111-aaaa-4bbb-8ccc-000000000001', 'An older question?');
  const newest = ask('22222222-aaaa-4bbb-8ccc-000000000002', 'Titles only, or ingredients too?');

  // The newest run is the one waiting, and the composer names the session the answer goes on in.
  expect(overviewFor(db, 'APP-1')?.blocked).toEqual({ runId: newest, question: 'Titles only, or ingredients too?', sessionId: '22222222-aaaa-4bbb-8ccc-000000000002' , ...RAN });
});

// A commit message asked for while the card waits is newer than the run that asked, and is no question.
it('keeps the question when a commit message pass ran after it', () => {
  const asked = ask('22222222-aaaa-4bbb-8ccc-000000000002', 'Titles only?');
  startRun(db, { cardKey: 'APP-1', phase: 'commit-message', engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });

  expect(overviewFor(db, 'APP-1')?.blocked).toEqual({ runId: asked, question: 'Titles only?', sessionId: '22222222-aaaa-4bbb-8ccc-000000000002' , ...RAN });
});

// The card page draws these as buttons that fill the answer. A question from before the options, or
// one whose run offered none, has no field and draws as plain text.
it('carries the answers the run offered with its question, and none for a plain question', () => {
  const plain = ask('11111111-aaaa-4bbb-8ccc-000000000001', 'Titles only?');
  expect(overviewFor(db, 'APP-1')?.blocked).not.toHaveProperty('options');

  const asked = ask('22222222-aaaa-4bbb-8ccc-000000000002', 'Stars or thumbs?');
  const options = [{ label: '1 to 5 stars', means: 'A new column' }, { label: 'Thumbs up and down', means: 'Reuses the likes table' }];
  saveQuestionOptions(db, asked, options);

  expect(plain).not.toBe(asked);
  expect(overviewFor(db, 'APP-1')?.blocked).toEqual({ runId: asked, question: 'Stars or thumbs?', sessionId: '22222222-aaaa-4bbb-8ccc-000000000002', options , ...RAN });
});

// Two cards wait. Each page reads its own card's question, and the answers stay with the run that offered them.
it('keeps the answers on the card that was offered them', () => {
  const offered = ask('11111111-aaaa-4bbb-8ccc-000000000001', 'Stars or thumbs?');
  const options = [{ label: '1 to 5 stars', means: 'A new column' }, { label: 'Thumbs up and down', means: 'Reuses the likes table' }];
  saveQuestionOptions(db, offered, options);
  const plain = ask('22222222-aaaa-4bbb-8ccc-000000000002', 'Titles only?', 'APP-2');

  expect(overviewFor(db, 'APP-2')?.blocked).toEqual({ runId: plain, question: 'Titles only?', sessionId: '22222222-aaaa-4bbb-8ccc-000000000002' , ...RAN });
  expect(overviewFor(db, 'APP-1')?.blocked).toEqual({ runId: offered, question: 'Stars or thumbs?', sessionId: '11111111-aaaa-4bbb-8ccc-000000000001', options , ...RAN });
});

it('carries no question once the card is no longer blocked', () => {
  ask('22222222-aaaa-4bbb-8ccc-000000000002', 'Titles only?');
  db.prepare("UPDATE cards SET state = 'queued' WHERE key = 'APP-1'").run();

  expect(overviewFor(db, 'APP-1')?.blocked).toBeNull();
});

it('carries the phase strip, one segment per phase with the newest run of each', () => {
  run('refine', 'complete', null);
  const plan = run('plan', 'complete', null);

  const strip = overviewFor(db, 'APP-1')?.strip ?? [];

  expect(strip.map((segment) => segment.phase)).toEqual(['refine', 'plan', 'implement', 'qa', 'wrapup']);
  expect(strip[1]?.run).toMatchObject({ id: plan, model: 'haiku', effort: 'low', costUsd: 0.01 });
  expect(strip[2]?.run).toBeNull();
});

/**
 * The phase strip follows the card's own board.
 *
 * Stage ids repeat across boards, so the strip built from the Delivery board answered about
 * Delivery's phases for a card that is not on it. An Epics card would have shown refine, plan,
 * implement, QA and wrap-up, three of which that board does not have.
 */
it('names the phases of the board the card is on', () => {
  createCard(db, { key: 'EPIC-1', board: 'epics', stage: 'architecture', title: 'A search that finds recipes' });

  const strip = overviewFor(db, 'EPIC-1')?.strip ?? [];

  expect(strip.map((segment) => segment.phase)).toEqual(['refine', 'architecture', 'design', 'plan', 'wrapup']);
  // The Delivery phases this board does not have.
  expect(strip.map((segment) => segment.phase)).not.toContain('implement');
  expect(strip.map((segment) => segment.phase)).not.toContain('qa');
});

// The other side, so the Delivery card beside it is unchanged.
it('keeps the Delivery phases for a Delivery card', () => {
  expect(overviewFor(db, 'APP-1')?.strip.map((segment) => segment.phase)).toEqual(['refine', 'plan', 'implement', 'qa', 'wrapup']);
});

// The trail of a card on a board where nothing runs yet. Five phases, all of them idle, is what the
// Overview draws for it, and the segment count is the part no other test covers.
it('draws one idle segment per phase of the Epics board', () => {
  createCard(db, { key: 'EPIC-2', board: 'epics', stage: 'inbox', title: 'A search that finds recipes' });
  const view = overviewFor(db, 'EPIC-2');

  const body = render(Overview, {
    props: { summary: view?.summary ?? null, changesHref: null, ticket: view?.ticket ?? null, extra: null, related: [], strip: view?.strip ?? [] },
  }).body;
  // Each idle phase says what it will do, or that it has not run where no line is written for it.
  expect([...body.matchAll(/data-mark="none"/g)]).toHaveLength(5);
  expect(text(body)).toContain('Architecture not run yet');
});

// The epic's own panel, where the person writes the tasks. No run on the Epics board writes
// a breakdown, so this list is the only way in.
it('draws the tasks of an epic, with a word for each state', () => {
  const body = render(Overview, {
    props: {
      summary: null,
      changesHref: null,
      ticket: null,
      extra: null,
      related: [],
      tasks: [
        { key: 'RECI-2', title: 'Add a recipe', done: true },
        { key: 'RECI-3', title: 'Search by ingredient', done: false },
      ],
      // Plan ran and wrote prose with no steps, so the typed list stays.
      plan: 'The recipes get a search box and a form.',
    },
  }).body;

  expect(body).toContain('data-task="RECI-2"');
  expect(text(body)).toContain('RECI-2 Add a recipe Done');
  expect(text(body)).toContain('RECI-3 Search by ingredient Open');
  // Nothing is typed yet, so the button names no number.
  expect(text(body)).toContain('Add tasks to Delivery');
});

// Before Plan ran, an empty box with no word on what a task is left a person guessing. One line says it.
it('explains the tasks of an epic before Plan ran, with no box to type in', () => {
  const body = render(Overview, { props: { summary: null, changesHref: null, ticket: null, extra: null, related: [], tasks: [] } }).body;

  expect(text(body)).toContain('Tasks Plan splits the epic into tasks. Each one you add becomes a card on Delivery.');
  expect(body).not.toContain('id="new-tasks"');
  expect(body).not.toContain('data-add-tasks');
  expect(text(body)).not.toContain('No tasks yet');
});

// A closed epic's plan is never read, so the line about Plan to come would be wrong there.
it('says nothing about Plan to come on a closed epic, and keeps its tasks', () => {
  const closed = { knowledge: [], knowledgeHref: '/knowledge', onpulls: null, onrevert: async () => ({ ok: true, message: '' }) };
  const body = render(Overview, { props: { summary: null, changesHref: null, ticket: null, extra: null, related: [], tasks: [{ key: 'RECI-2', title: 'Add a recipe', done: true }], closed } }).body;

  expect(text(body)).toContain('RECI-2');
  expect(body).not.toContain('data-tasks-wait');
  expect(body).not.toContain('id="new-tasks"');
});

it('draws no task panel on a card that delivers none', () => {
  const body = render(Overview, { props: { summary: null, changesHref: null, ticket: null, extra: null, related: [], tasks: null } }).body;

  expect(body).not.toContain('data-add-tasks');
});

// The facts under the trail: each phase's newest session, never a pass's, and where the ticket came from.
it('lists the newest session of each phase of the board the card is on, and the source', async () => {
  const session = (phase: string, id: string) => {
    const runId = startRun(db, { cardKey: 'APP-1', phase, engine: 'fake', model: 'haiku', effort: 'low', sessionId: id, logPath: '', lane: null });
    saveRun(db, runId, { sessionId: id, model: 'haiku', costUsd: null, durationMs: 1, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });
  };
  session('refine', 'aaaaaaaa1111');
  session('refine', 'bbbbbbbb2222');
  session('extract-summary', 'cccccccc3333');
  session('plan', 'dddddddd4444');

  expect(await cardFacts(db, 'APP-1', {})).toEqual([
    { label: 'Refine session', value: 'bbbbbbbb' },
    { label: 'Plan session', value: 'dddddddd' },
    { label: 'Engine', value: 'fake' },
    { label: 'Source', value: 'local ticket' },
  ]);
});

// The source of a card from a ticket system names the ticket and links its page where the address is known.
it('names the ticket a card came from, and links it on Jira and GitHub', async () => {
  createCard(db, { key: 'PROJ-123', board: 'delivery', stage: 'inbox', title: 'Fix the login', source: 'jira', sourceRef: 'PROJ-123' });
  const source = async () => (await cardFacts(db, 'PROJ-123', {})).find((fact) => fact.label === 'Source');

  // No site set: the key alone, with no link to a guessed address.
  expect(await source()).toEqual({ label: 'Source', value: 'Jira', ticket: { key: 'PROJ-123', href: null } });
  writeSetting(db, 'jiraSite', 'https://you.atlassian.net');
  expect(await source()).toEqual({ label: 'Source', value: 'Jira', ticket: { key: 'PROJ-123', href: 'https://you.atlassian.net/browse/PROJ-123' } });
  // A local card is its own ticket.
  expect((await cardFacts(db, 'APP-1', {})).find((fact) => fact.label === 'Source')).toEqual({ label: 'Source', value: 'local ticket' });

  expect(sourceTicket('github', 'owner/api#42', null)).toEqual({ key: 'owner/api#42', href: 'https://github.com/owner/api/issues/42' });
  expect(sourceTicket('github-pr', 'owner/api#7', null)).toEqual({ key: 'owner/api#7', href: 'https://github.com/owner/api/pull/7' });
  // No owner kept, or a system whose address the card does not keep: the key alone.
  expect(sourceTicket('github', 'api#42', null)).toEqual({ key: 'api#42', href: null });
  expect(sourceTicket('linear', 'PROJ-123', 'https://you.atlassian.net')).toEqual({ key: 'PROJ-123', href: null });
  expect(sourceTicket('external', 'group/api#3', null)).toEqual({ key: 'group/api#3', href: null });
  expect(sourceTicket('local', 'APP-1', null)).toBeNull();
});

// A blocked card: the engine of the card's newest run by its vendor's name, or of the step
// the card runs next when it has not run yet.
it('names the engine of the newest run, or of the next step on a card that never ran', async () => {
  startRun(db, { cardKey: 'APP-1', phase: 'refine', engine: 'codex', model: 'gpt-5', effort: 'low', sessionId: null, logPath: '', lane: null });
  startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'claude-code#work', model: 'sonnet', effort: 'low', sessionId: null, logPath: '', lane: null });

  expect(await cardFacts(db, 'APP-1', {})).toContainEqual({ label: 'Engine', value: 'Claude Code' });
  expect((await cardFacts(db, 'APP-2', {})).map((fact) => fact.label)).not.toContain('Engine');
  expect(await cardFacts(db, 'APP-2', {}, { 'claude-code': ['haiku', 'sonnet'] })).toContainEqual({ label: 'Engine', value: 'Claude Code' });
  // The fallback reads the card's own rows, not another card's.
  setCardModels(db, 'APP-2', { refine: { engine: 'codex', model: 'gpt-5' }, plan: { engine: 'codex', model: 'gpt-5' } });
  expect(await cardFacts(db, 'APP-2', {}, { 'claude-code': ['haiku', 'sonnet'], codex: ['gpt-5'] })).toContainEqual({ label: 'Engine', value: 'Codex' });
});

// A closed card: the repositories the card worked in, before the checkout row.
it('names the repositories a closed card worked in', async () => {
  writeSetting(db, 'projectPath', dir);
  writeSetting(db, 'repos', [{ path: '.', base: null }, { path: 'api', base: 'main' }]);
  db.prepare("UPDATE cards SET stage = 'closed' WHERE key = 'APP-2'").run();
  setCardRepos(db, 'APP-2', ['api'], 'person');

  expect((await cardFacts(db, 'APP-2', {})).slice(0, 2)).toEqual([
    { label: 'Repository', value: 'api' },
    { label: 'Checkout', value: 'none' },
  ]);
  // An open card shows its repositories on the Settings tab, so the facts leave them out.
  setCardRepos(db, 'APP-1', ['api'], 'person');
  expect((await cardFacts(db, 'APP-1', {})).map((fact) => fact.label)).not.toContain('Repository');
});

it('says a card in a project has no checkout yet, and offers to rename the branch its first run takes', async () => {
  writeSetting(db, 'projectPath', dir);

  expect(await cardFacts(db, 'APP-2', {})).toEqual([
    { label: 'Branch', value: 'feature/APP-2/sort-the-list', edit: { locked: null } },
    { label: 'Checkout', value: 'none yet' },
    { label: 'Source', value: 'local ticket' },
  ]);
});

it('says a closed card has no checkout, rather than none yet', async () => {
  writeSetting(db, 'projectPath', dir);
  db.prepare("UPDATE cards SET stage = 'closed' WHERE key = 'APP-2'").run();

  expect(await cardFacts(db, 'APP-2', {})).toContainEqual({ label: 'Checkout', value: 'none' });
});

// A project whose list has no "." keeps each checkout in a child folder of the card root, and the root
// itself is no checkout. The card still has one, and its branch is read off that child.
it('reads the branch off the root checkout, or off a child one when the list has no "."', async () => {
  writeSetting(db, 'projectPath', dir);
  execFileSync('git', ['init', '-q', '-b', 'APP-1-search-box', join(dir, 'worktrees', 'APP-1')]);
  writeSetting(db, 'repos', [{ path: 'api', base: 'main' }]);
  execFileSync('git', ['init', '-q', '-b', 'APP-2-sort', join(dir, 'worktrees', 'APP-2', 'api')]);

  expect((await cardFacts(db, 'APP-2', process.env)).slice(0, 2)).toEqual([
    { label: 'Branch', value: 'APP-2-sort', edit: { locked: null } },
    { label: 'Checkout', value: join('worktrees', 'APP-2') },
  ]);
  writeSetting(db, 'repos', null);
  expect((await cardFacts(db, 'APP-1', process.env)).slice(0, 2)).toEqual([
    { label: 'Branch', value: 'APP-1-search-box', edit: { locked: null } },
    { label: 'Checkout', value: join('worktrees', 'APP-1') },
  ]);
  // A branch with an upstream is known outside this machine, so its name is locked. A local main as
  // the upstream is enough for git, once the branch has a commit.
  const root = join(dir, 'worktrees', 'APP-1');
  execFileSync('git', ['-C', root, '-c', 'user.name=dev', '-c', 'user.email=dev@example.com', 'commit', '-q', '--allow-empty', '-m', 'first']);
  execFileSync('git', ['-C', root, 'branch', 'main']);
  execFileSync('git', ['-C', root, 'branch', '-q', '--set-upstream-to=main']);
  expect((await cardFacts(db, 'APP-1', process.env))[0]).toEqual({ label: 'Branch', value: 'APP-1-search-box', edit: { locked: 'APP-1-search-box has an upstream, so it keeps its name.' } });
});

// The head's "Files 3" and "Discussion 2": counted, and left out at none.
it('counts the card folder files and the discussion messages for the tabs', () => {
  writeSetting(db, 'projectPath', dir);
  mkdirSync(join(dir, '.tasks', 'APP-1', 'plan'), { recursive: true });
  writeFileSync(join(dir, '.tasks', 'APP-1', 'plan', 'plan.md'), '# Plan');
  writeFileSync(join(dir, '.tasks', 'APP-1', 'ticket.md'), '# Ticket');
  // A cache a run left there is nothing a person reads, so its files are not counted.
  mkdirSync(join(dir, '.tasks', 'APP-1', 'npm-cache', '_cacache'), { recursive: true });
  writeFileSync(join(dir, '.tasks', 'APP-1', 'npm-cache', '_cacache', 'index'), 'x');
  const say = db.prepare("INSERT INTO messages (card_key, thread, author, body, at) VALUES (?, 'plan', 'person', 'Why?', '2026-10-15T10:00:00Z')");
  say.run('APP-1');
  say.run('APP-1');

  expect(tabCounts(db, 'APP-1', {})).toEqual({ files: '2', discussion: '2' });
  expect(tabCounts(db, 'APP-2', {})).toEqual({});
});

// "Log 5 runs": every run of the card, as the Log tab lists them.
it('counts the runs of the card for the Log tab', () => {
  run('refine', 'complete', null);
  expect(tabCounts(db, 'APP-1', {}).log).toBe('1 run');
  run('plan', 'complete', null);
  expect(tabCounts(db, 'APP-1', {}).log).toBe('2 runs');
  // Another card's runs are not counted.
  expect(tabCounts(db, 'APP-2', {}).log).toBeUndefined();
});

describe('the card page', () => {
  // Tests run with TZ=UTC, and the clock is fixed, so each time below is the one a person would read.
  const NOW = new Date('2026-10-15T12:00:00.000Z');
  const stamp = (id: number, at: string) => db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run(at, id);
  const moveAt = (at: string) => db.prepare('UPDATE card_events SET at = ? WHERE id = (SELECT max(id) FROM card_events)').run(at);
  const setCard = (stage: string, state: string) => db.prepare('UPDATE cards SET stage = ?, state = ? WHERE key = ?').run(stage, state, 'APP-1');

  it('says a time today, a weekday this week and a date before that', () => {
    expect(whenSaid('2026-10-15T10:10:00.000Z', NOW, 'UTC')).toBe('10:10');
    expect(whenSaid('2026-10-10T13:50:00.000Z', NOW, 'UTC')).toBe('Sat 13:50');
    expect(whenSaid('2026-10-05T13:50:00.000Z', NOW, 'UTC')).toBe('5 Oct 13:50');
    expect(whenSaid('not a time', NOW, 'UTC')).toBeNull();
  });

  it('says which phase wrote the summary and when', () => {
    stamp(run('plan', 'complete', 'There is a plan now.'), '2026-10-15T10:10:00.000Z');

    expect(overviewFor(db, 'APP-1')).toMatchObject({ summaryFrom: 'Written after Plan', summaryAt: '2026-10-15T10:10:00.000Z' });
  });

  // On a closed card the wrap-up's summary is the one of the whole card.
  it('calls the wrap-up summary the whole card once the card is closed', () => {
    stamp(run('wrapup', 'complete', 'The list sorts by cooking time.'), '2026-10-15T10:50:00.000Z');

    expect(overviewFor(db, 'APP-1')).toMatchObject({ summaryFrom: 'Written after Wrap-up', summaryAt: '2026-10-15T10:50:00.000Z' });
    setCard('closed', 'idle');
    expect(overviewFor(db, 'APP-1')?.summaryFrom).toBe('The whole card, written at wrap-up');
  });

  it('reads the plan on a card past Plan, closed too, and not before it', () => {
    writeSetting(db, 'projectPath', dir);
    mkdirSync(join(dir, '.tasks', 'APP-1', 'plan'), { recursive: true });
    writeFileSync(join(dir, '.tasks', 'APP-1', 'plan', 'plan.md'), '1. Add the option.\n');
    const planOf = (stage: string, state: string) => {
      setCard(stage, state);
      return overviewFor(db, 'APP-1')?.plan ?? null;
    };

    expect(planOf('plan', 'ready')).toBe('1. Add the option.\n');
    expect(planOf('implement', 'running')).toBe('1. Add the option.\n');
    expect(planOf('review', 'idle')).toBe('1. Add the option.\n');
    // A closed card keeps its plan as part of the record.
    expect(planOf('closed', 'idle')).toBe('1. Add the option.\n');
    // Plan is still writing it, or never ran.
    expect(planOf('plan', 'running')).toBeNull();
    expect(planOf('refine', 'ready')).toBeNull();
  });

  // Plan and Implement work from the plan, so it starts open there and folded on every other stage.
  it('opens the plan while the card is in Plan or Implement, and folds it after', () => {
    const openOn = (stage: string) => {
      setCard(stage, 'idle');
      return overviewFor(db, 'APP-1')?.planOpen;
    };

    expect(openOn('plan')).toBe(true);
    expect(openOn('implement')).toBe(true);
    expect(openOn('qa')).toBe(false);
    expect(openOn('review')).toBe(false);
    expect(openOn('closed')).toBe(false);
    expect(openOn('inbox')).toBe(false);
  });

  // One entry per list line, as the finish rules write them, with a model's "* " counted too. A heading,
  // a blank line or an indented line is not one, and a card with no file has none.
  // The count is a fact on the right that opens the file on the Files tab.
  const discoveriesOf = async (key: string) => (await cardFacts(db, key, {})).find((fact) => fact.label === 'Discoveries');

  it('counts the entries of the discoveries as a fact, and none without the file', async () => {
    writeSetting(db, 'projectPath', dir);
    expect(await discoveriesOf('APP-1')).toBeUndefined();

    mkdirSync(join(dir, '.tasks', 'APP-1'), { recursive: true });
    writeFileSync(join(dir, '.tasks', 'APP-1', 'discoveries.md'), '# Discoveries\n\n- The list sorts first, in api/src/recipes.ts: order is free (plan)\n- The page caches, in web/src/list.ts: a reload is needed (implement)\n  - a note under it\n* The api pages at 50, in api/src/page.ts: a long list stops early (qa)\n');

    expect(await discoveriesOf('APP-1')).toEqual({ label: 'Discoveries', value: '3', file: 'discoveries.md' });
    // Just above the source, the last fact.
    expect((await cardFacts(db, 'APP-1', {})).map((fact) => fact.label).slice(-2)).toEqual(['Discoveries', 'Source']);
  });

  // Each card reads its own folder: a second card with a file must not show its count on the first.
  it('counts the discoveries of the card asked for and not of another card', async () => {
    writeSetting(db, 'projectPath', dir);
    mkdirSync(join(dir, '.tasks', 'APP-2'), { recursive: true });
    writeFileSync(join(dir, '.tasks', 'APP-2', 'discoveries.md'), '- One, in a.ts: why (plan)\n- Two, in b.ts: why (qa)\n');

    expect((await discoveriesOf('APP-2'))?.value).toBe('2');
    expect(await discoveriesOf('APP-1')).toBeUndefined();
  });

  it('has no plan to show while the file is not there', () => {
    writeSetting(db, 'projectPath', dir);
    setCard('implement', 'idle');

    expect(overviewFor(db, 'APP-1')?.plan).toBeNull();
  });

  // The plan is read the way the Files tab reads it, so a link out of the card folder or a file over
  // the cap is not sent to the page.
  it('shows no plan that links out of the card folder or is over the cap', () => {
    writeSetting(db, 'projectPath', dir);
    setCard('implement', 'idle');
    const file = join(dir, '.tasks', 'APP-1', 'plan', 'plan.md');
    mkdirSync(join(dir, '.tasks', 'APP-1', 'plan'), { recursive: true });
    writeFileSync(join(dir, 'outside.md'), '1. Not the plan.\n');
    symlinkSync(join(dir, 'outside.md'), file);

    expect(overviewFor(db, 'APP-1')?.plan).toBeNull();
    rmSync(file);
    writeFileSync(file, `1. ${'a'.repeat(CARD_FILE_CAP)}\n`);
    expect(overviewFor(db, 'APP-1')?.plan).toBeNull();
  });

  // Who moved the card and when, from the card events, in the board's own stage names.
  it('lists every move with who made it and when, and the phase each one started', () => {
    recordMove(db, 'APP-1', 'inbox', 'refine', 'you', 'refine');
    moveAt('2026-10-10T14:02:00.000Z');
    recordMove(db, 'APP-1', 'refine', 'plan', 'auto', 'plan');
    moveAt('2026-10-15T10:10:00.000Z');
    recordMove(db, 'APP-1', 'plan', 'review', 'you', null);
    moveAt('2026-10-15T11:30:00.000Z');

    expect(overviewFor(db, 'APP-1')?.moves).toEqual([
      { label: 'Refine', said: 'moved by you', at: '2026-10-10T14:02:00.000Z', phase: 'refine' },
      { label: 'Plan', said: 'moved by Nolzu', at: '2026-10-15T10:10:00.000Z', phase: 'plan' },
      { label: 'Review', said: 'moved by you', at: '2026-10-15T11:30:00.000Z', phase: null },
    ]);
  });

  // Parity line 459: the Review row of a closed card reads the person's move on out of Review.
  it('says who approved a card out of Review and when', () => {
    recordMove(db, 'APP-1', 'qa', 'review', 'auto', null);
    moveAt('2026-10-15T09:28:00.000Z');
    recordMove(db, 'APP-1', 'review', 'pr-watch', 'you', null);
    moveAt('2026-10-15T09:58:00.000Z');

    expect(overviewFor(db, 'APP-1')?.moves.map((one) => [one.label, one.said, one.at])).toEqual([
      ['Review', 'approved by you', '2026-10-15T09:58:00.000Z'],
      ['Pull request', 'moved by you', '2026-10-15T09:58:00.000Z'],
    ]);
  });

  // A note on a move back is Send back from the web or the phone, which the trail says in its own words.
  it('marks a move back that carries a note, and leaves a reason on a forward move unmarked', () => {
    recordMove(db, 'APP-1', 'qa', 'review', 'you', null, 'The empty list is fine for now.');
    moveAt('2026-10-15T10:10:00.000Z');
    recordMove(db, 'APP-1', 'review', 'implement', 'you', null, 'Rename the button to Save recipe.');
    moveAt('2026-10-15T11:30:00.000Z');

    expect(overviewFor(db, 'APP-1')?.moves).toEqual([
      { label: 'Review', said: 'moved by you', at: '2026-10-15T10:10:00.000Z', phase: null, reason: 'The empty list is fine for now.', from: 'qa' },
      { label: 'Implement', said: 'moved by you', at: '2026-10-15T11:30:00.000Z', phase: null, reason: 'Rename the button to Save recipe.', from: null, back: true },
    ]);
  });

  // Each card reads its own moves and its own runs, never another card's.
  it('keeps the moves and the totals of one card apart from another', () => {
    recordMove(db, 'APP-1', 'inbox', 'refine', 'you', 'refine');
    recordMove(db, 'APP-2', 'inbox', 'plan', 'auto', 'plan');
    run('refine', 'complete', null);
    const id = startRun(db, { cardKey: 'APP-2', phase: 'plan', engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
    saveRun(db, id, { sessionId: null, model: 'haiku', costUsd: 0.5, durationMs: 1, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });

    const two = overviewFor(db, 'APP-2');

    expect(two?.moves.map((one) => one.label)).toEqual(['Plan']);
    expect(two?.spend).toMatchObject({ runs: 1 });
    expect(two?.spend.costUsd).toBeCloseTo(0.5);
  });

  it('reads the knowledge change of the newest wrap-up of the card, with the patch its commit made', async () => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    writeSetting(db, 'projectPath', dir);
    mkdirSync(join(dir, '.nolzu', 'knowledge'), { recursive: true });
    writeFileSync(join(dir, '.nolzu', 'knowledge', 'api.md'), 'Sort them in the web app.\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(dir, '.nolzu', 'knowledge', 'api.md'), 'The server sorts.\n');
    git('commit', '-q', '-am', 'wrap-up');
    const sha = git('rev-parse', 'HEAD');
    const older = run('wrapup', 'complete', null);
    const newer = run('wrapup', 'complete', null);
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: older, commitSha: null, status: 'returned', files: [{ path: '.nolzu/knowledge/old.md', summary: null }] });
    recordKnowledgeChanges(db, { cardKey: 'APP-1', runId: newer, commitSha: sha, status: 'applied', files: [{ path: '.nolzu/knowledge/api.md', summary: 'Sorting' }] });
    const other = startRun(db, { cardKey: 'APP-2', phase: 'wrapup', engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
    recordKnowledgeChanges(db, { cardKey: 'APP-2', runId: other, commitSha: sha, status: 'applied', files: [{ path: '.nolzu/knowledge/other.md', summary: null }] });

    const [change, ...rest] = await cardKnowledge(db, 'APP-1', env);

    expect(rest).toEqual([]);
    expect(change).toMatchObject({ path: '.nolzu/knowledge/api.md', status: 'applied', summary: 'Sorting' });
    expect(change?.diff).toContain('-Sort them in the web app.');
    expect(change?.diff).toContain('+The server sorts.');
    // Without patches git is not asked: the rows come at once and the card page streams the patches.
    const [quick] = await cardKnowledge(db, 'APP-1', env, false);
    expect(quick).toMatchObject({ path: '.nolzu/knowledge/api.md', status: 'applied', summary: 'Sorting', diff: null, applied: null });
    // Parity line 456: when the commit was made, read with the same git call, which the page draws as a time ago.
    expect(change?.applied).toBe(git('show', '-s', '--format=%cI', sha));
    expect((await cardKnowledge(db, 'APP-2', env)).map((one) => one.path)).toEqual(['.nolzu/knowledge/other.md']);
  });

  it('reads no knowledge change for a card whose wrap-up made none', async () => {
    expect(await cardKnowledge(db, 'APP-1', {})).toEqual([]);
  });
});

// The ticket's meta, which phase wrote the summary, and an epic's documents and solution.
describe('what the overview says beside its parts', () => {
  const stamp = (id: number, at: string) => db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run(at, id);

  it('names the source and the end of the newest Refine run for the ticket meta', () => {
    expect(overviewFor(db, 'APP-1')).toMatchObject({ ticketSource: 'local', refinedAt: null });
    stamp(run('refine', 'complete', null), '2026-10-15T11:40:00.000Z');
    stamp(run('refine', 'complete', null), '2026-10-15T11:50:00.000Z');

    expect(overviewFor(db, 'APP-1')?.refinedAt).toBe('2026-10-15T11:50:00.000Z');
  });

  it('says which phase wrote the summary', () => {
    expect(overviewFor(db, 'APP-1')?.summaryPhase).toBeNull();
    run('plan', 'complete', 'There is a plan now.');

    expect(overviewFor(db, 'APP-1')?.summaryPhase).toBe('plan');
  });

  // A QA FAIL shows what the build changed last. The QA run's own summary only says the verdict again.
  it('keeps the newest summary a run other than QA wrote', () => {
    expect(overviewFor(db, 'APP-1')?.built).toBeNull();
    const built = run('implement', 'complete', 'The list has a search box.');
    db.prepare('UPDATE runs SET ended_at = ? WHERE id = ?').run('2026-10-15T16:02:00.000Z', built);
    run('qa', 'complete', 'Typing a word leaves every recipe, so QA failed.');

    // When the build ended, for the time in the block's meta, not when QA did.
    expect(overviewFor(db, 'APP-1')).toMatchObject({
      summary: 'Typing a word leaves every recipe, so QA failed.',
      summaryPhase: 'qa',
      built: { summary: 'The list has a search box.', phase: 'implement', at: '2026-10-15T16:02:00.000Z' },
    });
  });

  it('lists the documents an epic wrote, the design and the old mockups with their count, and the excerpt of architecture.md', () => {
    writeSetting(db, 'projectPath', dir);
    createCard(db, { key: 'APP-4', board: 'epics', stage: 'in-delivery', title: 'Plan a week of meals' });
    const folder = join(dir, '.tasks', 'APP-4');
    const written: [string, string][] = [
      ['architecture/architecture.md', '# Architecture\n\n## Before you approve\n\n- A plan is a new `meal_plans` table, one row per day.\n- D1: keep the week view on the web app.\n\n## The shape\n\nThe shape text.\n'],
      ['plan/plan.md', '1. Store meal plans.\n'],
      ['mockups/week.html', '<p>week</p>'],
      ['mockups/list.html', '<p>list</p>'],
      ['mockups/mockups.md', '- week\n- list\n'],
      ['design/week.html', '<p>week</p>'],
      ['design/tokens.css', ':root { --ink: #222; }'],
      ['design/design.md', '- week\n'],
    ];
    for (const [path, body] of written) {
      mkdirSync(join(folder, path, '..'), { recursive: true });
      writeFileSync(join(folder, path), body);
    }
    const view = overviewFor(db, 'APP-4');

    expect(view?.docs).toEqual([
      { label: 'architecture.md', path: 'architecture/architecture.md', screens: null },
      { label: 'plan.md', path: 'plan/plan.md', screens: null },
      { label: 'Design', path: 'design/design.md', screens: 1 },
      { label: 'Mockups', path: 'mockups/mockups.md', screens: 2 },
    ]);
    expect(view?.solution).toBe('A plan is a new `meal_plans` table, one row per day.');
    // A Delivery card has no documents panel and no solution.
    expect(overviewFor(db, 'APP-1')).toMatchObject({ docs: null, solution: null });
  });

  // The tasks copy what their steps name from these, so the Add tasks button builds their tickets.
  it('reads the epic criteria and the decisions of its architecture and plan for the task seed', () => {
    writeSetting(db, 'projectPath', dir);
    createCard(db, { key: 'APP-6', board: 'epics', stage: 'in-delivery', title: 'Open one recipe' });
    const folder = join(dir, '.tasks', 'APP-6');
    const written: [string, string][] = [
      ['refine/refined.md', '## Acceptance checks\n\n- AC1 (must): A row opens its recipe.\n  Check: a browser test clicks a row.\n'],
      ['architecture/architecture.md', '## The decisions\n\n- D1: One route per recipe. Not: the page picks from the list.\n'],
      ['plan/plan.md', '## Decisions\n\n- D2: The view follows hash changes.\n\n## Steps\n\n1. Add the route.\n   Covers: AC1\n'],
    ];
    for (const [path, body] of written) {
      mkdirSync(join(folder, path, '..'), { recursive: true });
      writeFileSync(join(folder, path), body);
    }

    expect(overviewFor(db, 'APP-6')?.seed).toEqual({
      key: 'APP-6',
      criteria: [{ id: 'AC1', level: 'must', text: 'A row opens its recipe.', check: 'a browser test clicks a row.' }],
      decisions: [
        { id: 'D1', text: 'One route per recipe. Not: the page picks from the list.' },
        { id: 'D2', text: 'The view follows hash changes.' },
      ],
    });
    expect(overviewFor(db, 'APP-1')?.seed).toBeUndefined();
  });

  // The task table takes each row's shareable description from the plan for
  // colleagues, and a row links to the project's ticket system when it has one.
  it('reads the plan for colleagues and the ticket system name on an epic, and neither elsewhere', () => {
    writeSetting(db, 'projectPath', dir);
    createCard(db, { key: 'APP-6', board: 'epics', stage: 'review', title: 'Open one recipe' });
    expect(overviewFor(db, 'APP-6')).not.toHaveProperty('sharePlan');
    // A project of local tickets links its tasks to GitHub issues.
    expect(overviewFor(db, 'APP-6')).toHaveProperty('linkSystem', 'GitHub');
    mkdirSync(join(dir, '.tasks', 'APP-6', 'share'), { recursive: true });
    writeFileSync(join(dir, '.tasks', 'APP-6', 'share', 'PLAN.md'), '## Tasks\n\n### 1. Open a recipe\nA row opens its page.\n');
    writeSetting(db, 'ticketSystem', 'jira');

    expect(overviewFor(db, 'APP-6')).toMatchObject({ sharePlan: '## Tasks\n\n### 1. Open a recipe\nA row opens its page.\n', linkSystem: 'Jira' });
    expect(overviewFor(db, 'APP-1')).not.toHaveProperty('linkSystem');
  });

  it('has no solution and no chips for an epic whose phases wrote nothing yet', () => {
    writeSetting(db, 'projectPath', dir);
    createCard(db, { key: 'APP-5', board: 'epics', stage: 'inbox', title: 'Share a recipe' });

    expect(overviewFor(db, 'APP-5')).toMatchObject({ docs: [], solution: null });
  });

  // An architecture written before the review block existed still has its shape to show.
  it('falls back to the first paragraph of The shape when the architecture has no review block', () => {
    expect(architectureExcerpt('# Architecture\n\n## The shape\n\nA new table.\nOne row per day.\n\nMore.\n\n## The pieces\n\n- api\n')).toBe('A new table.\nOne row per day.');
    expect(architectureExcerpt('## The pieces\n\n- api\n')).toBeNull();
    // A bullet under a later heading is not the review block's.
    expect(architectureExcerpt('## Before you approve\n\nNone yet.\n\n## The shape\n\nShape.\n\n## Interfaces\n\n- api\n')).toBe('Shape.');
  });
});

// A Research card's whole work is its answer or its report, so the card page shows it, with the
// sources split off into chips, and Make a Delivery card and Ask a follow-up under it.
describe('the answer of a Research card', () => {
  const write = (key: string, file: string, body: string) => {
    mkdirSync(join(dir, '.tasks', key, file.split('/')[0]!), { recursive: true });
    writeFileSync(join(dir, '.tasks', key, file), body);
  };

  it('reads the answer of a question and the report of an investigation, and nothing on another board', () => {
    writeSetting(db, 'projectPath', dir);
    createCard(db, { key: 'Q-1', board: 'questions', stage: 'review', title: 'Where is the title checked?' });
    createCard(db, { key: 'INV-1', board: 'investigations', stage: 'review', title: 'Why do uploads fail?' });
    write('Q-1', 'research/answer.md', 'In `api/src/validate.ts`.\n\n## Sources\n\n- `api/src/validate.ts:14` the length check\n');
    write('INV-1', 'investigate/report.md', 'The proxy cuts the body at 1 MB.\n');
    write('APP-1', 'research/answer.md', 'Not this card.\n');

    expect(overviewFor(db, 'Q-1')?.research).toEqual({ title: 'The answer', file: 'research/answer.md', body: 'In `api/src/validate.ts`.', sources: [{ at: 'api/src/validate.ts:14', note: 'the length check' }] });
    expect(overviewFor(db, 'INV-1')?.research).toMatchObject({ title: 'The report', file: 'investigate/report.md', body: 'The proxy cuts the body at 1 MB.\n', sources: [] });
    expect(overviewFor(db, 'APP-1')?.research).toBeUndefined();
  });

  it('shows nothing before the run wrote the file', () => {
    writeSetting(db, 'projectPath', dir);
    createCard(db, { key: 'Q-1', board: 'questions', stage: 'inbox', title: 'Where is the title checked?' });

    expect(overviewFor(db, 'Q-1')?.research).toBeUndefined();
  });

  it('draws the answer with its sources, Make a Delivery card and the follow-up link', () => {
    const research = { title: 'The answer', file: 'research/answer.md', body: 'In `api/src/validate.ts`.', sources: [{ at: 'api/src/validate.ts:14', note: 'the length check' }] };
    const body = render(Overview, {
      props: { summary: null, changesHref: null, ticket: null, extra: null, related: [], research: { research, fileHref: '/t/Q-1/files?file=research', followHref: '/t/Q-1/discussion?thread=research', ondeliver: async () => '' } },
    }).body;

    expect(text(body)).toContain('The answer Open answer.md');
    expect(text(body)).toContain('Sources api/src/validate.ts:14 the length check');
    expect(body).toContain('href="/t/Q-1/discussion?thread=research"');
    expect(text(body)).toContain('Make a Delivery card');
    expect(render(Overview, { props: { summary: null, changesHref: null, ticket: null, extra: null, related: [] } }).body).not.toContain('data-research-answer');
  });
});

// The research and investigate skills end their file with a "## Sources" list, one `path:line` a line.
describe('reportSources', () => {
  it('splits the list off the report and keeps each path with its line and its note', () => {
    const report = 'In `api/src/validate.ts`, line 14.\n\n## Sources\n\n- `api/src/validate.ts:14`\n- web/src/routes/new/+page.svelte:31, where the form posts\n* api/test/validate.test.ts\n';

    expect(reportSources(report)).toEqual({
      body: 'In `api/src/validate.ts`, line 14.',
      sources: [
        { at: 'api/src/validate.ts:14', note: null },
        { at: 'web/src/routes/new/+page.svelte:31', note: 'where the form posts' },
        { at: 'api/test/validate.test.ts', note: null },
      ],
    });
  });

  it('keeps the note after the path, with or without a dash or a colon between them', () => {
    expect(reportSources('A.\n\n## Sources\n\n- a.ts:1 the form posts here\n- `b.ts:2` - the check\n- c.ts:3: the guard: it stops here\n- d.ts:4 \u2014 the cut\n').sources).toEqual([
      { at: 'a.ts:1', note: 'the form posts here' },
      { at: 'b.ts:2', note: 'the check' },
      { at: 'c.ts:3', note: 'the guard: it stops here' },
      { at: 'd.ts:4', note: 'the cut' },
    ]);
  });

  it('keeps a section written after the list', () => {
    expect(reportSources('Answer.\n\n## Sources\n\n- a.ts:1\n\n## Next\n\nMore.')).toEqual({ body: 'Answer.\n\n## Next\n\nMore.', sources: [{ at: 'a.ts:1', note: null }] });
  });

  // The answer as the skills write it now: the answer and its confidence first, and a card draft with
  // its own list items before the sources, which stay last.
  it('reads an answer with a confidence line and a card draft, and takes chips from the sources only', () => {
    const answer = 'The api returns every recipe.\n\nConfidence: high, because the route was read.\n\n## Searched and not found\n\n- a query, in api/src/server.ts\n\n## If this becomes a card\n\nProblem: the api sends every recipe.\n- AC1 (must): The api filters by title.\n  Check: a request counts the rows.\nChange: api/src/recipes.ts listRecipes.\n\n## Sources\n\n- api/src/recipes.ts:14 listRecipes returns every row\n';
    const read = reportSources(answer);
    expect(read.sources).toEqual([{ at: 'api/src/recipes.ts:14', note: 'listRecipes returns every row' }]);
    expect(read.body).toBe(answer.slice(0, answer.indexOf('\n\n## Sources')));
  });

  it('shows no chips for a file with no such list', () => {
    expect(reportSources('Sources are named in the text, a.ts:1.')).toEqual({ body: 'Sources are named in the text, a.ts:1.', sources: [] });
    expect(reportSources('Answer.\n\n## Sources\n\nNone found.')).toEqual({ body: 'Answer.', sources: [] });
  });
});
