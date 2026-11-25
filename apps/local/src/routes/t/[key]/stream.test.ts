import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardFor, tabsFor } from '@nolzu/core';
import { createCard, getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

// The card page navigates at once: the loaders hand SvelteKit every part that runs git or a project
// command as a promise, and await only the database. Here git never answers, and the loads still do.
const never = () => new Promise<never>(() => {});
vi.mock('$lib/changes.ts', async (original) => ({ ...(await original<typeof import('$lib/changes.ts')>()), changesCount: vi.fn(never), changeGroups: vi.fn(never) }));
// A long run's log, read for the discussion's tool calls, which never finishes here.
vi.mock('$lib/discussion.ts', async (original) => ({ ...(await original<typeof import('$lib/discussion.ts')>()), withTools: vi.fn(never) }));
vi.mock('$lib/overview.ts', async (original) => {
  const real = await original<typeof import('$lib/overview.ts')>();
  return {
    ...real,
    cardFacts: vi.fn(never),
    // The rows come off the database at once; the patches ask git, which never answers.
    cardKnowledge: vi.fn((...args: Parameters<typeof real.cardKnowledge>) => (args[3] === false ? real.cardKnowledge(...args) : never())),
  };
});

const dir = mkdtempSync(join(tmpdir(), 'nolzu-card-stream-'));
process.env.NOLZU_DATA_DIR = dir;
const project = mkdtempSync(join(tmpdir(), 'nolzu-card-stream-project-'));

const { createLoop } = await import('$lib/loop.ts');
const { load: layoutLoad } = await import('./+layout.server.ts');
const { load: pageLoad } = await import('./[tab]/+page.server.ts');

type Loaded = Record<string, unknown>;
const layout = layoutLoad as unknown as (event: { params: { key: string } }) => Promise<Loaded>;
const page = pageLoad as unknown as (event: { params: { key: string; tab: string }; parent: () => Promise<unknown>; request: Request; url: URL }) => Promise<Loaded>;

const stop = new AbortController();
const open = (key: string, tab: string, stage = 'qa') =>
  page({
    params: { key, tab },
    parent: async () => ({ tabs: tabsFor('delivery'), ticket: { key, board: 'delivery', stage, state: 'ready' } }),
    request: new Request(`http://localhost/t/${key}/${tab}`, { signal: stop.signal }),
    url: new URL(`http://localhost/t/${key}/${tab}`),
  });

// Whether a promise is still on its way after the loader returned.
const pending = async (value: unknown) => {
  expect(value).toBeInstanceOf(Promise);
  return (await Promise.race([(value as Promise<unknown>).then(() => 'settled'), new Promise((done) => setTimeout(() => done('pending'), 50))])) === 'pending';
};

let live: ReturnType<typeof createLoop>;
let archive = '';
beforeAll(() => {
  openDatabase(dir).close();
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  writeSetting(live.db, 'projectPath', project);
  // A status command that outlasts the test, so the QA panels have to draw without its answer.
  writeSetting(live.db, 'qaApp', { '*': { mode: 'own', start: 'true', stop: null, status: 'sleep 30' } });
  createCard(live.db, { key: 'APP-1', board: 'delivery', stage: 'qa', title: 'APP-1 title' });
  archive = boardFor('delivery', getSetting(live.db, 'deliveryFlow')).stages.find((stage) => stage.role === 'archive')?.id ?? '';
  createCard(live.db, { key: 'APP-2', board: 'delivery', stage: archive, title: 'APP-2 title' });
  // A second open card and a second closed one, so a part that asks about a fixed key is seen.
  createCard(live.db, { key: 'APP-3', board: 'delivery', stage: 'qa', title: 'APP-3 title' });
  createCard(live.db, { key: 'APP-4', board: 'delivery', stage: archive, title: 'APP-4 title' });
  mkdirSync(join(project, 'worktrees', 'APP-3'), { recursive: true });
  mkdirSync(join(project, 'worktrees', 'APP-1'), { recursive: true });
});
afterAll(() => {
  stop.abort();
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('returns the card layout before git counts the changes', async () => {
  const data = await layout({ params: { key: 'APP-1' } });

  expect(data.ticket).toMatchObject({ key: 'APP-1' });
  // The other tabs' counts come off the database and are there at once.
  expect(data.counts).toEqual(expect.any(Object));
  expect(await pending(data.changes)).toBe(true);
});

it('returns the overview before the facts, the status command and the knowledge patches', async () => {
  const data = await open('APP-1', 'overview');

  expect(data.overview).not.toBeNull();
  expect(data.qa).toMatchObject({ cardKey: 'APP-1', hasStatus: true, status: null });
  expect(await pending(data.facts)).toBe(true);
  expect(await pending(data.qaStatus)).toBe(true);

  const closed = await open('APP-2', 'overview', archive);
  expect(closed.knowledge).toEqual([]);
  expect(await pending(closed.knowledgePatches)).toBe(true);
});

it('returns the Changes tab before git reads the changes', async () => {
  const data = await open('APP-1', 'changes');

  expect(data.comments).toEqual([]);
  expect(await pending(data.groups)).toBe(true);
});

it('returns the discussion before the run logs are read for its tool calls', async () => {
  const data = await open('APP-1', 'discussion');

  expect(data.discussion).toMatchObject({ messages: [] });
  expect(await pending(data.discussionTools)).toBe(true);
});

it('asks git and the status command about the card that was opened, and a closed card is not counted', async () => {
  const { changesCount, changeGroups } = await import('$lib/changes.ts');
  const { cardFacts, cardKnowledge } = await import('$lib/overview.ts');
  const [counted, grouped, factsOf, knowledgeOf] = [vi.mocked(changesCount), vi.mocked(changeGroups), vi.mocked(cardFacts), vi.mocked(cardKnowledge)] as const;
  for (const one of [counted, grouped, factsOf, knowledgeOf]) one.mockClear();
  writeSetting(live.db, 'qaApp', { '*': { mode: 'own', start: 'true', stop: null, status: 'printf %s {key}' } });

  const layoutData = await layout({ params: { key: 'APP-3' } });
  expect(layoutData.changes).toBeInstanceOf(Promise);
  expect(counted).toHaveBeenCalledTimes(1);
  expect(counted.mock.calls[0]?.[1]).toBe('APP-3');
  // A closed card's tag comes from its pull request, so git is not asked to count its changes.
  expect((await layout({ params: { key: 'APP-4' } })).changes).toBeNull();
  expect(counted).toHaveBeenCalledTimes(1);

  const overview = await open('APP-3', 'overview');
  expect(overview.qa).toMatchObject({ cardKey: 'APP-3' });
  expect(factsOf.mock.calls.map((call) => call[1])).toEqual(['APP-3']);
  const said = (await overview.qaStatus) as { status: { output: string } };
  expect(said.status.output).toBe('APP-3');

  await open('APP-3', 'changes');
  expect(grouped.mock.calls.map((call) => call[1])).toEqual(['APP-3']);

  await open('APP-4', 'overview', archive);
  expect(knowledgeOf.mock.calls.map((call) => call[1])).toEqual(['APP-4', 'APP-4']);
  writeSetting(live.db, 'qaApp', { '*': { mode: 'own', start: 'true', stop: null, status: 'sleep 30' } });
});
