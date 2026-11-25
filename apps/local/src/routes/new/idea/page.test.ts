import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { FREE } from '$lib/display.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';

// A recorded gh: signed out, or signed in as `you` with one organisation. Its `repo create` pushes the
// source to a bare stand-in under <home>/github, with origin as gh writes it, and the clone reads the
// stand-in back. The real gh is never spawned.
const gh = vi.hoisted(() => ({ signedIn: false, calls: [] as string[][] }));
vi.mock('@nolzu/runner', async (real) => {
  const runner = await real<typeof import('@nolzu/runner')>();
  const { execFileSync } = await import('node:child_process');
  const { join: joined } = await import('node:path');
  const bare = (name: string) => joined(process.env.HOME ?? '', 'github', `${name}.git`);
  return {
    ...runner,
    loginShellPath: () => '',
    runVersion: () => async () => (gh.signedIn ? { code: 0, stdout: '  ✓ Logged in to github.com account you (keyring)\n' } : { code: 1, stdout: '', stderr: 'You are not logged into any GitHub hosts.\n' }),
    ghRunner: () => async (args: readonly string[]) => {
      gh.calls.push([...args]);
      if (!gh.signedIn) throw new Error('gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.');
      if (args[0] === 'api') return { code: 0, stdout: args[1] === 'user' ? '{"login":"you"}' : '[{"login":"kitchen"}]', stderr: '' };
      if (args[1] === 'view') return { code: 1, stdout: '', stderr: `GraphQL: Could not resolve to a Repository with the name '${args[2]}'. (repository)\n` };
      const [owner, name] = args[2]!.split('/');
      const source = args[args.indexOf('--source') + 1]!;
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare(name!)]);
      execFileSync('git', ['-C', source, 'remote', 'add', 'origin', `https://github.com/${owner}/${name}.git`]);
      execFileSync('git', ['-C', source, 'push', '-q', bare(name!), 'HEAD']);
      return { code: 0, stdout: '', stderr: '' };
    },
    cloneRepository: async (options: import('@nolzu/runner').CloneOptions) => {
      const target = runner.cloneTarget(options.url, options.taken);
      if (!target.ok) return target;
      execFileSync('git', ['clone', '-q', bare(target.name), joined(options.workspace, target.name)]);
      return { ok: true, name: target.name, path: joined(options.workspace, target.name) };
    },
  };
});

// The loop's Epics board, with what a drop on Refine starts and its estimate from the preset.
const changed = vi.hoisted(() => vi.fn());
vi.mock('$lib/loop.ts', () => ({
  loop: () => ({
    changed,
    snapshot: () => ({ stages: [{ id: 'inbox', starts: null }, { id: 'refine', starts: { estimate: { costUsd: 0.03, lowMs: 20_000, highMs: 40_000, from: 'preset', runs: 0 } } }] }),
  }),
}));

const dir = mkdtempSync(join(tmpdir(), 'nolzu-idea-route-'));
const home = mkdtempSync(join(tmpdir(), 'nolzu-idea-home-'));
process.env.NOLZU_DATA_DIR = dir;
const before = { ...process.env };
Object.assign(process.env, { HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });

const { actions, load } = await import('./+page.server.ts');
const { default: Page } = await import('./+page.svelte');

type Loaded = { made: unknown; owners: Promise<{ owners: string[] } | { problem: string } | null>; refine: string | null };
const loaded = () => load({} as never) as unknown as Loaded;
const create = async (body: Record<string, string>) => {
  const request = new Request('http://localhost/new/idea', { method: 'POST', body: new URLSearchParams(body) });
  return (await actions.create!({ request } as never)) as { status?: number; data?: { message: string; waiting: boolean } };
};
const IDEA = { idea: 'A meal planner\nOne shopping list for the week.', decided: 'SvelteKit', name: 'meal-planner', folder: '~/code/new/meal-planner', owner: 'you', repo: 'meal-planner' };
const at = (...parts: string[]) => join(home, ...parts);
const setting = <K extends 'projectPath' | 'repos' | 'onboarding'>(key: K) => {
  const db = openDatabase(dir);
  try {
    return getSetting(db, key);
  } finally {
    db.close();
  }
};
const page = (data: Record<string, unknown> = {}, form: unknown = null) =>
  render(Page as never, { props: { data: { display: FREE, made: null, gh: Promise.resolve({ found: true, signedIn: false, account: null }), owners: Promise.resolve(null), refine: null, ...data }, form } } as never).body;
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

beforeEach(() => {
  drawnAt('/new/idea');
  changed.mockClear();
  gh.calls = [];
});

afterAll(() => {
  process.env = before;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The tests below run in order on one data folder: signed out first, then signed in.
it('reads no owners while gh is signed out, and says what the drag to Refine costs', async () => {
  const data = loaded();

  expect(await data.owners).toBeNull();
  expect(data.refine).toBe('about $0.03');
  expect(gh.calls).toEqual([]);
});

it('refuses while gh is signed out, and leaves no folder', async () => {
  expect(await create(IDEA)).toEqual({ status: 400, data: { message: 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.', waiting: false } });
  expect(existsSync(at('code'))).toBe(false);
  expect(setting('projectPath')).toBeNull();
});

it('reads the account and its organisations once gh is signed in', async () => {
  gh.signedIn = true;

  expect(await loaded().owners).toEqual({ owners: ['you', 'kitchen'] });
});

// The folder typed is the project's own, and the folders above it are made too.
it('makes the workspace, the private repository cloned into it and the epic, then opens the Epics board', async () => {
  let thrown: unknown = null;
  try {
    await create(IDEA);
  } catch (redirect) {
    thrown = redirect;
  }

  expect(thrown).toMatchObject({ status: 303, location: '/b/epics' });
  expect(setting('projectPath')).toBe(at('code', 'new', 'meal-planner'));
  expect(setting('repos')).toEqual([{ path: 'meal-planner', base: 'main' }]);
  expect(setting('onboarding')).toEqual({ done: true });
  expect(gh.calls.find((call) => call[1] === 'create')?.slice(0, 4)).toEqual(['repo', 'create', 'you/meal-planner', '--private']);
  const db = openDatabase(dir);
  try {
    expect(db.prepare('SELECT key, board, stage, title, extra_context AS extra FROM cards').all()).toEqual([{ key: 'PLAN-1', board: 'epics', stage: 'inbox', title: 'A meal planner', extra: 'SvelteKit' }]);
  } finally {
    db.close();
  }
  // The new card reaches the open boards, as Add card tells them.
  expect(changed).toHaveBeenCalledTimes(1);
});

it('draws the page with the estimate on the Refine step', () => {
  const shown = text(page({ refine: 'about $0.03' }));

  for (const words of [
    'New project no code yet',
    'What do you want to build?',
    'Describe it the way you would to a friend.',
    'Your idea',
    'Project name',
    'Folder',
    'Anything already decided? Optional',
    'Repository',
    'I have repositories already',
    'What happens next',
    'A private repository',
    'Your idea becomes a card',
    'You drag it to Refine The agent asks what it needs to know and writes the idea down clearly. About $0.03.',
    'A plan you can read',
    'No code is written until you drag a task to Implement.',
  ]) {
    expect(shown, words).toContain(words);
  }
  expect(page()).toContain('href="../new"');
  // With nothing measured, the step names no figure.
  expect(text(page())).toMatch(/writes the idea down clearly\. 4 A plan you can read/);
});

it('names the folder Nolzu made when a project waits on New project, and keeps its name and folder', () => {
  const html = page({ made: { path: '~/dev/recipes', name: 'recipes', location: '~/dev', repos: [] } });

  expect(text(html)).toMatch(/Nolzu made ~\/dev\/recipes already, so the new repository goes into it\./);
  expect(html).toMatch(/id="name"[^>]*value="recipes"[^>]*readonly|value="recipes"[^>]*id="name"[^>]*readonly/);
  expect(html).toMatch(/id="folder"[^>]*value="~\/dev\/recipes"[^>]*readonly/);
  expect(html).not.toContain('Goes in');
  expect(text(html)).toContain('It lands as RECI-1 on the Epics board');
});

// Amber only where an agent starts work, and this page starts none.
it('draws the button as the cream main button with its key, and nothing amber', () => {
  const html = page();

  expect(html).toMatch(/class="btn primary lg[^"]*"[^>]*>(<!--[^>]*-->| )*Create the repository and the project/);
  expect(html).not.toContain('btn go');
  expect(readFileSync(new URL('./+page.svelte', import.meta.url), 'utf8')).not.toMatch(/var\(--amber/);
});

// A refusal once the workspace is made leaves the project on New project, and a failed action draws
// the page with no new load, so the answer carries the link there.
it('links New project when a refusal leaves the project waiting there', async () => {
  const db = openDatabase(dir);
  try {
    writeSetting(db, 'onboarding', { done: false });
  } finally {
    db.close();
  }
  gh.signedIn = false;

  expect(await create(IDEA)).toEqual({ status: 400, data: { message: 'gh is not logged in to GitHub. Run gh auth login in a terminal, then try again.', waiting: true } });
  const waiting = page({}, { message: 'The clone failed.', waiting: true });
  // A space of its own, because a tag reads as none and the words would run together.
  expect(waiting).toMatch(/The clone failed\.(<!--[^>]*-->)* (<!--[^>]*-->)*<a class="link[^"]*" href="\.\.\/new">Open New project<\/a>/);
  expect(page({}, { message: 'The clone failed.', waiting: false })).not.toContain('Open New project');
});
