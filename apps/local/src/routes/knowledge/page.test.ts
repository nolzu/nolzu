import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting, openDatabase, recordKnowledgeChanges, startRun, writeSetting } from '@nolzu/core/node';
import type { KnowledgeView } from '@nolzu/ui/knowledge';
import { afterAll, beforeAll, expect, it } from 'vitest';

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported and opens anything. Not fake mode: fake mode ignores NOLZU_DATA_DIR on purpose.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-route-'));
process.env.NOLZU_DATA_DIR = dir;

const { actions, load } = await import('./+page.server.ts');
const { keepHeld } = await import('$lib/knowledge-review.ts');
// The view is streamed, so the load hands it as a promise.
type Loader = (event: { url: URL }) => Promise<{ knowledge: Promise<KnowledgeView>; review: boolean }>;
const page = load as unknown as Loader;
const open = (file?: string) => page({ url: new URL(`http://localhost/knowledge${file === undefined ? '' : `?file=${file}`}`) });
type Answer = { ok?: boolean; message?: string; status?: number; data?: { message: string } };
const post = (body: Record<string, string>) => ({ request: new Request('http://localhost/knowledge', { method: 'POST', body: new URLSearchParams(body) }) });
const said = (answer: Answer): string => answer.data?.message ?? answer.message ?? '';

const project = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-route-repo-'));
const folder = join(project, '.nolzu', 'knowledge');
const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();

let db = openDatabase(dir);
beforeAll(() => {
  db.close();
  db = openDatabase(dir);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('says there is no project before one is set', async () => {
  expect((await (await open()).knowledge).problem).toMatch(/no project set/);
});

it('opens the file the query names, with the diff git holds for it', async () => {
  writeSetting(db, 'projectPath', project);
  git('init', '-b', 'main');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'search.md'), 'Run the list first.\n');
  git('add', '-A');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'knowledge: APP-1 run 1');
  const sha = git('rev-parse', 'HEAD');
  const runId = startRun(db, { cardKey: 'APP-1', phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
  recordKnowledgeChanges(db, { cardKey: 'APP-1', runId, commitSha: sha, status: 'applied', files: [{ path: '.nolzu/knowledge/search.md', summary: 'added' }] });

  const view = await (await open('search.md')).knowledge;

  expect(view.files.map((file) => file.name)).toEqual(['search.md']);
  expect(view.open?.body).toContain('Run the list first.');
  expect(view.open?.history[0]?.diff).toContain('+Run the list first.');
  // Nothing is writing, so the folder is not locked.
  expect(view.busy).toBeNull();
});

// A change that waits shows the lines Apply would write. The kept copy is in the data folder.
it('reads a change that waits against its kept copy in the data folder', async () => {
  const runId = startRun(db, { cardKey: 'APP-1', phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
  recordKnowledgeChanges(db, { cardKey: 'APP-1', runId, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/search.md', summary: 'corrected' }] });
  keepHeld(dir, { cardKey: 'APP-1', runId, files: [{ path: '.nolzu/knowledge/search.md', kind: 'corrected', content: 'Run the list first.\nThen open one recipe.\n' }] });

  const view = await (await open('search.md')).knowledge;

  expect(view.pending.find((change) => change.runId === runId)?.held).toEqual([{ removed: [], added: ['Then open one recipe.'] }]);
  // A change that waits holds the knowledge lane's next run back, so it is answered before the tests below.
  expect(((await actions.return!(post({ run: String(runId), note: 'Write it again.' }) as never)) as Answer).ok).toBe(true);
});

// The switch at the foot of the screen writes the one setting Settings, Runs writes.
it('turns the review switch on and off, and the next load reads it', async () => {
  const on = (await actions.review!(post({ field: 'reviewKnowledge', value: 'on' }) as never)) as Answer;

  expect(on.ok).toBe(true);
  expect(getSetting(db, 'reviewKnowledge')).toBe(true);
  const loaded = await open();
  expect(loaded.review).toBe(true);
  // The streamed view is read too, so no git call outlives the test.
  await loaded.knowledge;

  // A checkbox that is off posts no value, which is how the switch turns off.
  await actions.review!(post({ field: 'reviewKnowledge' }) as never);
  expect(getSetting(db, 'reviewKnowledge')).toBe(false);
});

it('refuses a switch post that names another setting', async () => {
  const answer = (await actions.review!(post({ field: 'projectPath', value: '/' }) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(said(answer)).toContain('projectPath');
});

// The two buttons of the pending list post to this page. Whatever they answer, the person reads a
// sentence: a button that does nothing is worse than a refusal.
it('refuses an approve of a run that has no change waiting, and names the run', async () => {
  const answer = (await actions.approve!(post({ run: '999' }) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(said(answer)).toContain('999');
});

it('refuses a return with no note', async () => {
  const answer = (await actions.return!(post({ run: '999', note: '' }) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(said(answer)).not.toBe('');
});

// Revert posts from the change history of the open file. The rules and the real commit are in
// knowledge-revert.test.ts; this is the button reaching them through the route.
it('refuses a revert of a change that is not there, and names it', async () => {
  const answer = (await actions.revert!(post({ change: '999' }) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(said(answer)).toContain('999');
});

// Optimize is the one button on this screen that starts a run. The run itself is proved in
// optimize-run.test.ts; this is the button reaching the loop through the route.
it('refuses an optimize of a file the folder does not hold, and names it', async () => {
  const answer = (await actions.optimize!(post({ file: 'gone.md' }) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(said(answer)).toContain('gone.md');
});

it('refuses an optimize that named no file', async () => {
  const answer = (await actions.optimize!(post({}) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(said(answer)).toContain('named no knowledge file');
});

// Nothing here starts a run: this route test runs on the real engine, and the queued run is proved
// against the fake one in optimize-run.test.ts.

// Learn this project starts a run, and its answer resumes one. The runs are proved against the fake
// engine in orient-run.test.ts; here each button reaches the loop, and the refusal comes back as a
// sentence. This project has no run guard, so nothing starts.
it('refuses Learn this project without a run guard, and an answer when nothing asked', async () => {
  const loaded = (await open()) as unknown as { learn: unknown; knowledge: Promise<unknown> };
  expect(loaded.learn).toBeNull();
  await loaded.knowledge;

  const learn = (await actions.learn!(post({}) as never)) as Answer;
  expect(learn.status).toBe(400);
  expect(said(learn)).toContain('no run guard');

  const answer = (await actions.answer!(post({ answer: 'The tickets folder' }) as never)) as Answer;
  expect(answer.status).toBe(400);
  expect(said(answer)).toContain('not waiting for an answer');
});
