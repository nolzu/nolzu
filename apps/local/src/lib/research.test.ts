import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalTicket, relatedCards, writeSetting } from '@nolzu/core/node';
import type { Job } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { moveTo } from '../routes/api/board/writes.ts';
import { createLoop, type Loop } from './loop.ts';
import { researchAction, researchAnswer } from './research.ts';

// The presses of a Research card, on the real loop with the fake engine: Make a
// Delivery card links back. The wrap-up of a question is the drop on its Wrap-up column, and a
// follow-up is a message on the Discussion tab.
const WAIT = { timeout: 10_000 };
// No config of the person's own, and one author, so the test runs the same on every machine.
const CLEAN = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};

let dir = '';
let project = '';
let loop: Loop;
let spawned: Job[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-research-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-research-project-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, ...CLEAN }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  const env = { ...process.env, ...CLEAN, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' };
  loop = createLoop(dir, env);
  writeSetting(loop.db, 'projectPath', project);
  spawned = [];
  const replay = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    spawned.push(job);
    return replay(job, signal);
  };
});

afterEach(() => {
  loop.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const card = (key: string) => loop.db.prepare('SELECT board, stage, state, summary, extra_context AS extra FROM cards WHERE key = ?').get(key) as Record<string, string | null>;
const runs = (key: string) => loop.db.prepare('SELECT phase, state, session_id AS session, resumed FROM runs WHERE card_key = ? ORDER BY id').all(key) as Record<string, unknown>[];
const press = (key: string, body: unknown) =>
  researchAction(loop, key, new Request(`http://localhost/api/card/${key}/research`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

// A question whose research run ended ready, with its answer to read on Review.
async function answered(): Promise<string> {
  const { key } = createLocalTicket(loop.db, { projectId: 1, prefix: 'APP', title: 'Where is the title length checked?', description: '', board: 'questions' });
  expect(await moveTo(loop, key, 'research')).toBeNull();
  await vi.waitFor(() => expect(card(key).state).toBe('ready'), WAIT);
  return key;
}

it('numbers a question under its own prefix and reads what its answering run left', async () => {
  const key = await answered();
  writeFileSync(join(project, '.tasks', key, 'research', 'answer.md'), 'In `api/src/validate.ts`, line 14.\n');

  expect(key).toBe('Q-1');
  expect(researchAnswer(loop.db, key, 'questions')).toMatchObject({ report: 'In `api/src/validate.ts`, line 14.\n', summary: expect.any(String) });
});

it('makes a Delivery card that links back to the research card, with the answer for Refine', async () => {
  const key = await answered();
  writeFileSync(join(project, '.tasks', key, 'research', 'answer.md'), 'checkTitle refuses a title over 120 characters.\n');

  const answer = await press(key, { action: 'deliver' });

  expect(answer.status).toBe(201);
  const made = ((await answer.json()) as { key: string }).key;
  expect(made).toBe('APP-1');
  expect(card(made)).toMatchObject({ board: 'delivery', stage: 'inbox', state: 'idle', summary: 'Made from Q-1 on Research.', extra: 'checkTitle refuses a title over 120 characters.' });
  expect(relatedCards(loop.db, made).map((one) => one.key)).toEqual([key]);
  // The research card stays where it was, and nothing ran.
  expect(card(key)).toMatchObject({ board: 'questions', state: 'ready' });
  expect(runs(made)).toEqual([]);
});

// A question has a Wrap-up column now, as an investigation does. The answer moves the card to Review
// by itself, the drop starts the wrap-up in the knowledge lane, and the finished wrap-up moves the card
// to Done.
it('starts the wrap-up of a question on the drop on Wrap-up', async () => {
  const key = await answered();
  expect(card(key)).toMatchObject({ stage: 'review', state: 'ready' });

  expect(await moveTo(loop, key, 'wrapup')).toBeNull();

  await vi.waitFor(() => expect(runs(key).map((run) => [run.phase, run.state])).toEqual([['research', 'complete'], ['wrapup', 'complete']]), WAIT);
  await vi.waitFor(() => expect(card(key)).toMatchObject({ stage: 'done', state: 'idle' }), WAIT);
  expect(spawned.at(-1)).toMatchObject({ phase: 'wrapup', lane: 'knowledge' });
});

it('refuses a press on a card that is not on Research, and a press it does not know', async () => {
  const { key } = createLocalTicket(loop.db, { projectId: 1, prefix: 'APP', title: 'Add a search box', description: '' });
  mkdirSync(join(project, '.tasks'), { recursive: true });

  expect((await press(key, { action: 'deliver' })).status).toBe(409);
  const question = createLocalTicket(loop.db, { projectId: 1, prefix: 'APP', title: 'Where is it?', description: '', board: 'questions' }).key;
  const unknown = await press(question, { action: 'save' });
  expect(unknown.status).toBe(400);
  expect(((await unknown.json()) as { message: string }).message).toBe('The one Research press here is deliver. Ask a follow-up on the Discussion tab of the card.');
  expect((await press(question, { action: 'follow-up', text: 'And the web form?' })).status).toBe(400);
  expect(runs(question)).toEqual([]);
});
