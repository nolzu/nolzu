import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cardHolds, knowledgeChangesOfRun, readRun, writeSetting } from '@nolzu/core/node';
import { CLOUD_OPEN, hubEnvelope, type RunnerMessageType, SCOUT_AND_EVIDENCE } from '@nolzu/protocol';
import type { Keychain } from '@nolzu/runner';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { column } from './data-leaves.ts';
import { FREE } from './display.ts';
import { currentDisplay } from './display-sync.ts';
import { closeHubLink, hubStatus, startHubLink } from './hub-link.ts';
import { takeHubJob } from './hub-jobs.ts';
import { createHubSync } from './hub-sync.ts';
import { createLoop, type Loop } from './loop.ts';
import { movedTo, SECTIONS, sectionOf } from './settings-sections.ts';

// The client as shipped: the cloud closed and Evidence hidden (`packages/protocol/src/soon.ts`). The
// files that test the cloud code itself set both switches on.

let dir = '';
let live: Loop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-cloud-closed-'));
  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
});

afterEach(() => {
  closeHubLink();
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('ships with the cloud closed and Evidence hidden', () => {
  expect(CLOUD_OPEN).toBe(false);
  expect(SCOUT_AND_EVIDENCE).toBe(false);
});

it('has no Cloud section, and sends its old links to Project', () => {
  expect(SECTIONS.map((section) => section.id)).not.toContain('cloud');
  expect(sectionOf('cloud')).toBeNull();
  expect(movedTo('connection')).toBe('/settings/project');
  expect(movedTo('data')).toBe('/settings/project');
});

// No account means no token to read, so a Linux machine with no keyring tool says nothing at start.
it('dials no hub and reads no keychain outside the fake engine', async () => {
  let reads = 0;
  const keychain: Keychain = {
    read: async () => {
      reads += 1;
      return 'device-token-1';
    },
    write: async () => undefined,
    remove: async () => undefined,
  };

  startHubLink(live, {}, { keychain, say: () => {} });
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(reads).toBe(0);
  expect(hubStatus()).not.toBe('open');
});

it('sends no evidence and answers no weekly report while Evidence is hidden', async () => {
  const sent: RunnerMessageType[] = [];
  const send = (type: RunnerMessageType) => {
    sent.push(type);
    return true;
  };
  writeSetting(live.db, 'projectId', 'project-1');
  // A move today, which is evidence the hub would get with the switch on.
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'inbox', 'idle', 'Add a search box')").run();
  live.db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, started_phase) VALUES ('APP-1', NULL, 'inbox', 'you', NULL)").run();
  const sync = createHubSync(live.db, send);
  const days = sync.board();
  sent.length = 0;

  expect(days).toHaveLength(1);
  await sync.evidence(days);
  await takeHubJob(live, hubEnvelope('report.write', 1, { week: '2026-03-05' }), send, 'hubJobDone');

  expect(sent).toEqual([]);
});

it('lists no Evidence and reports group under what leaves this machine', () => {
  expect(column('hub').map((group) => group.name)).toEqual(['Board and runs', 'Project']);
});

// The display document comes from the hosted server, so a closed cloud asks for none: no keychain
// read, no call, on every page load and on Scout and Evidence alike.
it('asks for no display document, and reads no keychain', async () => {
  let reads = 0;
  let calls = 0;
  const keychain: Keychain = {
    read: async () => {
      reads += 1;
      return 'device-token-1';
    },
    write: async () => undefined,
    remove: async () => undefined,
  };
  const fetch = async () => {
    calls += 1;
    return { ok: false, status: 500, json: async () => null };
  };

  expect(await currentDisplay({ keychain, baseUrl: 'http://127.0.0.1:1', machine: 'test', say: () => {} }, fetch)).toBe(FREE);
  expect([reads, calls]).toEqual([0, 0]);
});

// A team id a join stored stays on disk, and no team hub can be reached: a held change waits for this
// person, and a package a sign-in left behind does not load.
it('treats a stored team as none, and loads no installed package', async () => {
  writeSetting(live.db, 'teamProjectId', 'team-project-1');
  live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'wrapup', 'ready', 'Add a search box')").run();
  live.db.prepare("INSERT INTO runs (card_key, phase, engine, log_path) VALUES ('APP-1', 'wrapup', 'fake', '')").run();
  live.db.prepare("INSERT INTO knowledge_changes (card_key, run_id, file_path, commit_sha, summary, status) VALUES ('APP-1', 1, '.nolzu/knowledge/a.md', NULL, 'added', 'pending')").run();
  expect(cardHolds(live.db, 'APP-1')).toBe('A knowledge change waits for your review on Knowledge.');

  const was = process.env.NOLZU_DATA_DIR;
  process.env.NOLZU_DATA_DIR = dir;
  try {
    mkdirSync(join(dir, 'packages'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'current'), 'entry.js');
    writeFileSync(join(dir, 'packages', 'entry.js'), 'console.log("paid");\n');
    const { GET } = await import('../routes/api/package/entry/+server.ts');
    expect(await (await GET({} as never)).text()).toBe('export {};\n');
  } finally {
    if (was === undefined) delete process.env.NOLZU_DATA_DIR;
    else process.env.NOLZU_DATA_DIR = was;
  }
});

// The wrap-up of a machine that once joined a team commits its knowledge as any free one does, since
// no team hub can take the change while the cloud is closed.
it('commits a wrap-up on a machine with a stored team, as a free one does', async () => {
  const clean = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
  const home = mkdtempSync(join(tmpdir(), 'nolzu-cloud-closed-team-'));
  const project = mkdtempSync(join(tmpdir(), 'nolzu-cloud-closed-project-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, ...clean } });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  const team = createLoop(home, { ...process.env, ...clean, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  try {
    writeSetting(team.db, 'projectPath', project);
    writeSetting(team.db, 'teamProjectId', 'team-project-1');
    team.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'pr-watch', 'idle', 'Add a search box')").run();

    team.start('APP-1', 'wrapup');
    const runId = (team.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
    await vi.waitFor(() => expect(readRun(team.db, runId)?.state).toBe('complete'), { timeout: 10_000 });

    expect(knowledgeChangesOfRun(team.db, runId).map((row) => row.status)).toEqual(['applied']);
  } finally {
    team.close();
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The card page's phone line, a cloud feature, is mounted both ways in routes/layout.mount.test.ts.

// A typed /team lands on Now, as Scout and Evidence do, and names no plan to buy.
it('sends /team to Now', async () => {
  const { load } = await import('../routes/team/+page.ts');
  const opened = (load as unknown as (event: { parent: () => Promise<unknown> }) => Promise<unknown>)({ parent: async () => ({ display: FREE, cloud: 'https://cloud.example/' }) });

  await expect(opened).rejects.toMatchObject({ status: 303, location: '/' });
});
