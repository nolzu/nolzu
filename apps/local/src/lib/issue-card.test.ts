import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addScoutSource, readRun, scoutFindings, startScoutFinding, writeSetting } from '@nolzu/core/node';
import type { Keychain, RunGh, RunGlab } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { moveTo } from '../routes/api/board/writes.ts';
import { createCardFrom } from './create-card.ts';
import { createLoop, type Loop } from './loop.ts';
import { checkTicketQuery } from './scout-tickets.ts';

// A card made from a GitHub issue, end to end. Its key used to be owner/repo#n, and every run refused
// a key with a slash in it, so the card sat on the board and never ran.

let dir = '';
let project = '';
let live: Loop;

const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, ...env }, encoding: 'utf8' }).trim();

// The issue answer recorded in create-card.test.ts.
const ISSUE = '{"data":{"t0":{"issueOrPullRequest":{"__typename":"Issue","number":12,"title":"Search by ingredient","body":"Match ingredients too.","state":"OPEN","url":"https://github.com/cook/recipes/issues/12","parent":null}}}}';
const gh: RunGh = async () => ({ code: 0, stdout: ISSUE, stderr: '' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-issue-card-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-issue-project-'));
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  live = createLoop(dir, { ...process.env, ...env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
  writeSetting(live.db, 'projectPath', project);
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('makes an issue card as recipes#12, gives it a checkout and runs refine on the fake engine', async () => {
  const made = await createCardFrom(live.db, { github: async () => ({ run: gh, defaultOwner: null }) }, { input: 'cook/recipes#12' });
  expect(made.key).toBe('recipes#12');

  expect(await moveTo(live, 'recipes#12', 'refine')).toBeNull();
  const runId = (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
  await vi.waitFor(() => expect(readRun(live.db, runId)?.state).toBe('complete'), { timeout: 30_000, interval: 20 });

  const checkout = join(project, 'worktrees', 'recipes#12');
  expect(existsSync(join(checkout, '.git'))).toBe(true);
  expect(git('-C', checkout, 'branch', '--show-current')).toMatch(/^feature\/recipes-12-/);
  expect(live.db.prepare("SELECT stage, state, source_ref FROM cards WHERE key = 'recipes#12'").get()).toEqual({ stage: 'refine', state: 'ready', source_ref: 'cook/recipes#12' });
});

// A card Scout starts from a GitLab issue, end to end. Its key used to be group/project#n, so it sat on
// the board and never ran, like the issue card above.
it('starts a GitLab issue from Scout as recipes#12, gives it a checkout and runs refine on the fake engine', async () => {
  const source = addScoutSource(live.db, { kind: 'tickets', label: 'The recipe app on GitLab', config: { system: 'gitlab', project: 'Cook/Kitchen/recipes', query: '' } });
  // The shape `scout-tickets.test.ts` hands in, written from GitLab's documented answer and not recorded.
  const answer = '[{"id":400012,"iid":12,"title":"Search by ingredient","description":"Match ingredients too.","state":"opened","web_url":"https://gitlab.com/cook/kitchen/recipes/-/issues/12"}]';
  const glab: RunGlab = async () => ({ code: 0, stdout: answer, stderr: '' });
  // A GitLab source stores no credential, so a keychain call here is a bug.
  const keychain: Keychain = { read: () => Promise.reject(new Error('no keychain')), write: () => Promise.reject(new Error('no keychain')), remove: () => Promise.reject(new Error('no keychain')) };
  const form = new FormData();
  form.set('id', String(source));
  expect(await checkTicketQuery(live.db, keychain, form, { glab })).toMatchObject({ ok: true });
  const finding = scoutFindings(live.db, source)[0]?.id ?? 0;

  expect(startScoutFinding(live.db, finding)).toEqual({ ok: true, key: 'recipes#12' });

  expect(await moveTo(live, 'recipes#12', 'refine')).toBeNull();
  const runId = (live.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
  await vi.waitFor(() => expect(readRun(live.db, runId)?.state).toBe('complete'), { timeout: 30_000, interval: 20 });

  const checkout = join(project, 'worktrees', 'recipes#12');
  expect(existsSync(join(checkout, '.git'))).toBe(true);
  expect(git('-C', checkout, 'branch', '--show-current')).toMatch(/^feature\/recipes-12-/);
  expect(live.db.prepare("SELECT stage, state, source_ref FROM cards WHERE key = 'recipes#12'").get()).toEqual({ stage: 'refine', state: 'ready', source_ref: 'cook/kitchen/recipes#12' });
});
