import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cardRepos, createCard, openDatabase, setCardRepos, writeSetting } from '@nolzu/core/node';
import { SettingsTab } from '@nolzu/ui';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cardReposFor, saveCardRepos } from './card-repos.ts';

let dir = '';
let project = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-card-repos-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-card-repos-project-'));
  db = openDatabase(dir);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'implement', title: 'Add a search box' });
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'repos', [
    { path: '.', base: 'main' },
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
  ]);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const patch = (body: unknown) => new Request('http://localhost/api', { method: 'PATCH', body: JSON.stringify(body) });
const said = async (response: Response) => ((await response.json()) as { message?: string }).message ?? '';
const SETTINGS = { rows: [], preset: 'default', board: 'Delivery', profiles: [] };
const tab = () => render(SettingsTab, { props: { settings: SETTINGS, repos: cardReposFor(db, 'APP-1') } }).body;

describe('saveCardRepos', () => {
  it('saves the ticks as the person\'s list, reads it back, and refuses an unknown repository', async () => {
    expect((await saveCardRepos(db, 'APP-1', patch({ repos: ['api'] }))).status).toBe(200);
    expect(cardRepos(db, 'APP-1')).toEqual({ repos: ['api'], by: 'person' });
    expect(cardReposFor(db, 'APP-1')?.repos).toEqual([
      { path: '.', picked: true, fixed: true },
      { path: 'api', picked: true, fixed: false },
      { path: 'web', picked: false, fixed: false },
    ]);

    const refused = await saveCardRepos(db, 'APP-1', patch({ repos: ['docs'] }));
    expect(refused.status).toBe(400);
    expect(await said(refused)).toBe('The project has no repository docs.');
    expect(cardRepos(db, 'APP-1')).toEqual({ repos: ['api'], by: 'person' });
  });

  it('keeps the pick when a plan run writes its own list after it', async () => {
    await saveCardRepos(db, 'APP-1', patch({ repos: ['web'] }));

    expect(setCardRepos(db, 'APP-1', ['api'], 'plan')).toBe(false);
    expect(cardRepos(db, 'APP-1')).toEqual({ repos: ['web'], by: 'person' });
  });

  it('clears the list and who set it when every tick is cleared', async () => {
    setCardRepos(db, 'APP-1', ['api'], 'refine');

    expect((await saveCardRepos(db, 'APP-1', patch({ repos: [] }))).status).toBe(200);
    expect(cardRepos(db, 'APP-1')).toBeNull();
    expect(db.prepare('SELECT repos, repos_by FROM cards WHERE key = ?').get('APP-1')).toEqual({ repos: null, repos_by: null });
  });

  it('refuses to remove a repository whose checkout is on disk, and leaves the list as it was', async () => {
    setCardRepos(db, 'APP-1', ['api', 'web'], 'plan');
    mkdirSync(join(project, 'worktrees', 'APP-1', 'api'), { recursive: true });
    writeFileSync(join(project, 'worktrees', 'APP-1', 'api', '.git'), 'gitdir: elsewhere\n');

    const refused = await saveCardRepos(db, 'APP-1', patch({ repos: ['web'] }));

    expect(refused.status).toBe(400);
    expect(await said(refused)).toBe('APP-1 has a checkout of api already, so api stays in its list.');
    expect(cardRepos(db, 'APP-1')).toEqual({ repos: ['api', 'web'], by: 'plan' });
    // Web's folder holds no .git, as an empty submodule folder in the root checkout does, so it can go.
    mkdirSync(join(project, 'worktrees', 'APP-1', 'web'));
    expect((await saveCardRepos(db, 'APP-1', patch({ repos: ['api'] }))).status).toBe(200);
    expect(cardRepos(db, 'APP-1')).toEqual({ repos: ['api'], by: 'person' });
  });

  it('adds a repository to a started card', async () => {
    setCardRepos(db, 'APP-1', ['api'], 'plan');
    mkdirSync(join(project, 'worktrees', 'APP-1', 'api'), { recursive: true });
    writeFileSync(join(project, 'worktrees', 'APP-1', 'api', '.git'), 'gitdir: elsewhere\n');

    expect((await saveCardRepos(db, 'APP-1', patch({ repos: ['api', 'web'] }))).status).toBe(200);
    expect(cardRepos(db, 'APP-1')).toEqual({ repos: ['api', 'web'], by: 'person' });
  });

  it('answers 404 for a card that is not there, and 400 for a body that is no list', async () => {
    expect((await saveCardRepos(db, 'APP-9', patch({ repos: [] }))).status).toBe(404);
    expect(await said(await saveCardRepos(db, 'APP-1', patch({ repos: 'api' })))).toBe('Send the repositories as a list of folder names.');
  });
});

describe('the Settings tab', () => {
  it('says which phase set an automatic list, and when the person set it', () => {
    expect(tab()).toContain('Nobody has picked the repositories yet.');
    setCardRepos(db, 'APP-1', ['api'], 'refine');
    expect(tab()).toContain('Refine picked this list.');
    setCardRepos(db, 'APP-1', ['web'], 'plan');
    expect(tab()).toContain('Plan picked this list.');
    setCardRepos(db, 'APP-1', ['web'], 'person');
    expect(tab()).toContain('You picked this list, so refine and plan leave it as it is.');
  });

  it('draws a checkbox per repository, ticked from the card\'s list', () => {
    setCardRepos(db, 'APP-1', ['api'], 'plan');
    const body = tab();

    expect(body).toContain('Repositories for this card');
    expect(body.match(/type="checkbox"/g)).toHaveLength(3);
    // The project folder and api are ticked, and web is not.
    const boxes = [...body.matchAll(/<input type="checkbox"([^>]*)>\s*<span class="mono[^"]*">([^<]*)/g)].map(([, attributes, name]) => [attributes?.includes('checked'), name]);
    expect(boxes).toEqual([
      [true, 'project folder'],
      [true, 'api'],
      [false, 'web'],
    ]);
  });

  it('renders no repository block on a project of one repository', () => {
    writeSetting(db, 'repos', null);

    expect(cardReposFor(db, 'APP-1')).toBeNull();
    expect(tab()).not.toContain('Repositories for this card');
    expect(tab()).not.toContain('type="checkbox"');
  });

  // There is nothing to pick, and a name sent anyway is refused in the card store's words.
  it('renders no repository block on an empty workspace, and refuses a pick there', async () => {
    writeSetting(db, 'repos', null);
    writeSetting(db, 'workspace', true);
    writeSetting(db, 'repos', []);

    expect(cardReposFor(db, 'APP-1')).toBeNull();
    expect(tab()).not.toContain('Repositories for this card');
    const response = await saveCardRepos(db, 'APP-1', patch({ repos: ['api'] }));
    expect(response.status).toBe(400);
    expect(await said(response)).toBe('The project has no repository api.');
  });
});

// The board refuses a run on a card with no list, so an open board has to hear of a change. Read as
// source, as the models route is, because the loop the route reaches is the app's own.
it('tells the open boards after a save', () => {
  const source = readFileSync(new URL('../routes/api/card/[key]/repos/+server.ts', import.meta.url), 'utf8');

  expect(source).toContain('saveCardRepos(database(), params.key, request)');
  expect(source).toContain('if (answer.ok) loop().changed();');
});
