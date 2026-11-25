import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoKnowledge } from '@nolzu/core';
import { openDatabase, recordKnowledgeChanges, saveQuestionOptions, saveRun, startRun, writeSetting } from '@nolzu/core/node';
import { KB_MAINTENANCE_KEY, learnRepoKey } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { answerLearnPost, learnAsking, learnReposOffer, startLearnPost, startLearnReposPost } from './knowledge-learn.ts';

// The posts of Learn this project and the question it waits on. The run itself is proved against a
// real repository in orient-run.test.ts; this is the post and the read alone.
const post = (fields: Record<string, string>): FormData => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return form;
};

let dir = '';
let db: ReturnType<typeof openDatabase>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-learn-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// A run under the reserved key that ended the way the arguments say.
function ran(phase: string, question: string | null, state: 'complete' | 'failed' = 'complete'): number {
  const id = startRun(db, { cardKey: KB_MAINTENANCE_KEY, phase, engine: 'claude-code', model: 'sonnet', effort: 'low', sessionId: 'session-1', logPath: '', lane: 'knowledge' });
  saveRun(db, id, { sessionId: 'session-1', model: 'sonnet', costUsd: null, durationMs: null, tokens: null, question, failureReason: null, failureStatus: null, state, cardState: question === null ? 'ready' : 'blocked', retry: null });
  return id;
}

it('reads the question the newest Learn this project run asked, with its answers', () => {
  const id = ran('orient', 'Is a folder off limits?');
  saveQuestionOptions(db, id, [
    { label: 'The tickets folder', means: 'no run may change it.' },
    { label: 'Skip', means: 'nothing to add.' },
  ]);

  expect(learnAsking(db)).toEqual({
    runId: id,
    question: 'Is a folder off limits?',
    options: [
      { label: 'The tickets folder', means: 'no run may change it.' },
      { label: 'Skip', means: 'nothing to add.' },
    ],
    sessionId: 'session-1',
    engine: 'claude-code',
  });
});

// Only the newest run under the key counts: an Optimize after it, even one that asked, a run that
// ended without asking, or one that failed leaves no question waiting.
it('finds no question when the newest run did not stop to ask', () => {
  expect(learnAsking(db)).toBeNull();
  ran('orient', 'Is a folder off limits?');
  ran('optimize', 'Keep the part about the list?');
  expect(learnAsking(db)).toBeNull();
  ran('orient', null);
  expect(learnAsking(db)).toBeNull();
  ran('orient', 'Asked, then failed.', 'failed');
  expect(learnAsking(db)).toBeNull();
});

it('starts the run, with the repository the post names, and says where its questions wait', () => {
  const asked: (string | undefined)[] = [];
  const live = { learn: (repo?: string) => (asked.push(repo), true), answer: () => true };

  const first = startLearnPost(live, post({}));
  const second = startLearnPost(live, post({ repo: 'api' }));

  expect(asked).toEqual([undefined, 'api']);
  expect(first.ok).toBe(true);
  expect(first.message).toContain('Knowledge');
  expect(second.message).toContain('api');
});

it('gives the refusal back as the sentence the screen shows', () => {
  const live = {
    learn: () => {
      throw new Error('Knowledge from an earlier run is still waiting for a person.');
    },
    answer: () => true,
  };
  expect(startLearnPost(live, post({}))).toEqual({ ok: false, message: 'Knowledge from an earlier run is still waiting for a person.' });
  expect(startLearnPost({ learn: () => false, answer: () => true }, post({})).ok).toBe(false);
});

it('sends the answer to the run that asked, and refuses an empty one before anything starts', () => {
  const sent: [string, string][] = [];
  const live = { learn: () => true, answer: (key: string, text: string) => (sent.push([key, text]), true) };

  expect(answerLearnPost(live, post({ answer: '  ' })).ok).toBe(false);
  expect(sent).toEqual([]);
  expect(answerLearnPost(live, post({ answer: 'The tickets folder' })).ok).toBe(true);
  expect(sent).toEqual([[KB_MAINTENANCE_KEY, 'The tickets folder']]);
});

// Learn your repositories: what Knowledge offers before the press, and the post that queues the runs.
it('lists each repository with whether it has only its first lines, and the row each run starts on', () => {
  const project = join(dir, 'project');
  const folder = join(project, '.nolzu', 'knowledge');
  for (const repo of ['api', 'web']) mkdirSync(join(folder, repo), { recursive: true });
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'repos', [
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
    { path: 'docs', base: 'main' },
  ]);
  writeFileSync(join(folder, 'api', 'repository.md'), repoKnowledge({ path: 'api', base: 'main' }));
  writeFileSync(join(folder, 'web', 'repository.md'), '# The web repository\n\nThe recipe list. (from README.md)\n');
  // Docs was learned and its result waits in Pending review, so its file still holds the stub.
  const runId = startRun(db, { cardKey: KB_MAINTENANCE_KEY, phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
  recordKnowledgeChanges(db, { cardKey: KB_MAINTENANCE_KEY, runId, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/docs/repository.md', summary: 'learned' }] });

  const offer = learnReposOffer(db, { 'claude-code': ['haiku', 'sonnet', 'opus'] }, { ready: true });

  expect(offer.repos).toEqual([
    { path: 'api', stub: true, waiting: false },
    { path: 'web', stub: false, waiting: false },
    { path: 'docs', stub: true, waiting: true },
  ]);
  // No Learn run measured yet, so the Refine run on haiku at low effort stands in as the low end.
  expect(offer.starts).toEqual({ engine: 'claude-code', model: 'haiku', effort: 'low', severalProfiles: false, like: { costUsd: 0.048, lowMs: 21_000, highMs: 21_000, from: 'preset', runs: 0 } });
  expect(offer.refusal).toBeNull();
  // A Learn run that runs or waits marks its repository, so the screen does not offer it again.
  const queue = { running: [{ cardKey: learnRepoKey('api') }], waiting: [{ cardKey: learnRepoKey('docs') }, { cardKey: 'APP-1' }] };
  expect(learnReposOffer(db, { 'claude-code': ['haiku'] }, { ready: true }, queue).repos).toEqual([
    { path: 'api', stub: true, waiting: false, queued: 'running' },
    { path: 'web', stub: false, waiting: false },
    { path: 'docs', stub: true, waiting: true, queued: 'waiting' },
  ]);
  // A model the engine stopped offering is the sentence Settings, Models shows on that row.
  expect(learnReposOffer(db, { 'claude-code': ['sonnet'] }, { ready: true }).refusal).toMatch(/Learn your repositories will not start until you pick another/);
});

it('queues the ticked repositories and gives a refusal back as the sentence the screen shows', () => {
  const asked: (readonly string[])[] = [];
  const live = { learnRepos: (repos: readonly string[]) => (asked.push(repos), repos.length) };
  const form = new FormData();
  form.append('repo', 'api');
  form.append('repo', 'web');

  const answer = startLearnReposPost(live, form);

  expect(asked).toEqual([['api', 'web']]);
  expect(answer).toEqual({ ok: true, message: 'Learning 2 repositories, one after another. What each run writes waits here for your review, and nothing is applied before you approve it.' });
  const refused = {
    learnRepos: () => {
      throw new Error('No repository was picked, so there is nothing to learn. Tick one or more, then start again.');
    },
  };
  expect(startLearnReposPost(refused, new FormData())).toEqual({ ok: false, message: 'No repository was picked, so there is nothing to learn. Tick one or more, then start again.' });
});
