import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changesFor, commitAsk, commitFor, messageAsk, messageFor, patchAsk, patchFor } from './changes.ts';

let project = '';
let db: DatabaseSync;

// No config of the person's own, a fixed author and no hooks, so git answers the same on every machine.
const env = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

const setting = (key: string, value: unknown) => db.prepare('INSERT OR REPLACE INTO settings VALUES (?, ?)').run(key, JSON.stringify(value));

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'nolzu-changes-'));
  git(project, 'init', '-q', '-b', 'main');
  write(join(project, 'src/recipes/list.ts'), 'export const list = [];\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'first');
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec('CREATE TABLE cards (key TEXT PRIMARY KEY, state TEXT NOT NULL)');
});

afterEach(() => {
  db.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The card's checkout as the loop makes it: worktrees/<key> on its own branch.
function checkout(key: string): string {
  const path = join(project, 'worktrees', key);
  git(project, 'worktree', 'add', '-q', '-b', `feat/${key}`, path);
  return path;
}

it('reads the worktree row, the stat of each group and the file trees in one call', async () => {
  setting('projectPath', project);
  // Another card's checkout first, so the row has to be found by its folder and not by its place.
  checkout('APP-0');
  const card = checkout('APP-1');
  write(join(card, 'src/recipes/search.ts'), 'export const search = 1;\nexport const more = 2;\n');
  git(card, 'add', '-A');
  git(card, 'commit', '-q', '-m', 'add search');
  write(join(card, 'src/recipes/list.ts'), 'export const list = [1];\n');
  write(join(card, 'notes.md'), 'a note\n');

  const found = await changesFor(db, 'APP-1', env);

  expect(found.ok).toBe(true);
  if (!found.ok) return;
  expect(found.row.branch).toBe('feat/APP-1');
  expect(found.row.base).toBe('main');
  expect([found.row.ahead, found.row.behind, found.row.changed, found.row.untracked]).toEqual([1, 0, 1, 1]);
  expect(found.committed?.stat).toEqual({ files: 1, added: 2, removed: 0 });
  expect(found.uncommitted?.stat).toEqual({ files: 2, added: 2, removed: 1 });
  // Nothing pushed yet, so the push takes the whole branch.
  expect(found.pushes).toEqual(found.branch);
  expect(found.pushes?.files).toBe(3);
  // One collapsed folder row holding the file, as the tree helper draws it.
  expect(found.committed?.tree.map((node) => node.name)).toEqual(['src/recipes']);
  expect(found.uncommitted?.tree.map((node) => node.name)).toEqual(['src/recipes', 'notes.md']);
});

it('says why there is nothing to show when no project is set', async () => {
  expect(await changesFor(db, 'APP-1', env)).toEqual({ ok: false, reason: 'There is no project set, so this card has no checkout yet.' });
});

it('says the card has no checkout until its first run', async () => {
  setting('projectPath', project);

  expect(await changesFor(db, 'APP-1', env)).toEqual({ ok: false, reason: 'APP-1 has no checkout. A run makes one. A closed card has none once its checkouts are removed.' });
});

it('passes the git error on when the base branch is not there', async () => {
  setting('projectPath', project);
  setting('baseBranch', 'trunk');
  checkout('APP-1');

  const found = await changesFor(db, 'APP-1', env);

  expect(found.ok).toBe(false);
  if (!found.ok) expect(found.reason).toContain('The base branch trunk is not in this repository');
});

it('shows a stale checkout by its row and reads no files from it', async () => {
  setting('projectPath', project);
  const card = checkout('APP-1');
  // A checkout whose link to the repository is broken: git still lists it, and cannot read it.
  writeFileSync(join(card, '.git'), 'gitdir: /nowhere\n');

  const found = await changesFor(db, 'APP-1', env);

  expect(found.ok).toBe(true);
  if (!found.ok) return;
  expect(found.row.stale).toBe(true);
  expect(found.committed).toBeNull();
  expect(found.uncommitted).toBeNull();
});

it('refuses a key that is not one plain name, before it names a folder', async () => {
  setting('projectPath', project);
  checkout('APP-1');

  const found = await changesFor(db, '..', env);

  expect(found).toEqual({ ok: false, reason: 'The card key ".." is not one plain name, so it names no checkout.' });
});

it('finds the checkout when the project is set through a symlink', async () => {
  // Git reports the physical path. Without resolving the link the row is never found.
  const link = join(mkdtempSync(join(tmpdir(), 'nolzu-link-')), 'recipes');
  symlinkSync(project, link);
  setting('projectPath', link);
  checkout('APP-1');

  expect((await changesFor(db, 'APP-1', env)).ok).toBe(true);
  rmSync(join(link, '..'), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('one file patch', () => {
  let card = '';
  beforeEach(() => {
    setting('projectPath', project);
    card = checkout('APP-1');
    write(join(card, 'src/recipes/search.ts'), 'export const search = 1;\n');
    git(card, 'add', '-A');
    git(card, 'commit', '-q', '-m', 'add search');
    write(join(card, 'notes.md'), 'a note\n');
  });

  it('reads the patch of one committed file', async () => {
    const found = await patchFor(db, 'APP-1', { path: 'src/recipes/search.ts', oldPath: null, group: 'committed' }, env);

    expect(found.ok).toBe(true);
    if (found.ok) expect(found.text).toContain('+export const search = 1;');
  });

  it('reads an untracked file as added', async () => {
    const found = await patchFor(db, 'APP-1', { path: 'notes.md', oldPath: null, group: 'uncommitted' }, env);

    expect(found.ok).toBe(true);
    if (found.ok) expect(found.text).toContain('+a note');
  });

  it.each(['../../outside.txt', '/etc/hosts', 'src/../../outside.txt'])('refuses %s, which is not inside the checkout', async (path) => {
    // Written where the climb would land, so a missing guard would show it.
    writeFileSync(join(project, 'outside.txt'), 'secret\n');

    const found = await patchFor(db, 'APP-1', { path, oldPath: null, group: 'uncommitted' }, env);

    expect(found).toEqual({ ok: false, reason: `${path} is not inside the card's checkout, so it is not shown.` });
  });

  it('refuses a path through a folder link that points outside the checkout', async () => {
    // resolve() alone reads the text of the path and never follows the link, and git reads an
    // untracked file straight from the disk.
    mkdirSync(join(project, 'elsewhere'));
    writeFileSync(join(project, 'elsewhere', 'secret.txt'), 'secret\n');
    symlinkSync(join(project, 'elsewhere'), join(card, 'dirlink'));

    const found = await patchFor(db, 'APP-1', { path: 'dirlink/secret.txt', oldPath: null, group: 'uncommitted' }, env);

    expect(found).toEqual({ ok: false, reason: "dirlink/secret.txt is not inside the card's checkout, so it is not shown." });
  });

  it('refuses a checkout folder that is not a git worktree', async () => {
    rmSync(join(card, '.git'));

    const found = await patchFor(db, 'APP-1', { path: 'notes.md', oldPath: null, group: 'uncommitted' }, env);

    expect(found).toEqual({ ok: false, reason: 'The checkout of APP-1 is not a git worktree, so there is no patch to show.' });
  });

  it('refuses an old path that is not inside the checkout either', async () => {
    const found = await patchFor(db, 'APP-1', { path: 'notes.md', oldPath: '../../outside.txt', group: 'uncommitted' }, env);

    expect(found.ok).toBe(false);
  });
});

it('reads the patch question from the query, with the old path of a rename', () => {
  expect(patchAsk(new URLSearchParams('path=b.ts&group=committed&old=a.ts'))).toEqual({ path: 'b.ts', oldPath: 'a.ts', group: 'committed' });
  expect(patchAsk(new URLSearchParams('path=b.ts&group=uncommitted'))).toEqual({ path: 'b.ts', oldPath: null, group: 'uncommitted' });
});

it.each(['group=committed', 'path=&group=committed', 'path=b.ts', 'path=b.ts&group=all'])('answers no question for %s', (query) => {
  expect(patchAsk(new URLSearchParams(query))).toBeNull();
});

describe('the commit composer', () => {
  let card = '';
  beforeEach(() => {
    setting('projectPath', project);
    card = checkout('APP-1');
    write(join(card, 'src/recipes/list.ts'), 'export const list = [1];\n');
  });

  // The engine stands in as a function that answers the way a model does: the message in a fence.
  it('asks for a message from the uncommitted change and gives the box the cleaned answer', async () => {
    const asked: string[] = [];
    const write = async (key: string, prompt: string) => {
      asked.push(`${key}\n${prompt}`);
      return { ok: true as const, answer: '```\nfeat(api): filter recipes\n\nBy title.\n```' };
    };

    expect(await messageFor(db, 'APP-1', false, write, env)).toEqual({ ok: true, message: 'feat(api): filter recipes\n\nBy title.' });
    expect(await messageFor(db, 'APP-1', true, write, env)).toEqual({ ok: true, message: 'feat(api): filter recipes' });
    expect(asked[0]).toContain('+export const list = [1];');
    expect(asked[1]).toMatch(/one line commit message/);
  });

  // The push dialog says which model wrote the message and what the pass cost, as the run reported it.
  it('passes on the model and the cost the pass reported', async () => {
    const write = async () => ({ ok: true as const, answer: 'feat(api): filter recipes', model: 'haiku', cost: 0.0021 });

    expect(await messageFor(db, 'APP-1', false, write, env)).toEqual({ ok: true, message: 'feat(api): filter recipes', model: 'haiku', cost: 0.0021 });
  });

  it('asks nothing while a run writes into the checkout, or when nothing changed', async () => {
    let calls = 0;
    const write = async () => {
      calls += 1;
      return { ok: true as const, answer: 'feat: x' };
    };
    db.prepare("INSERT INTO cards VALUES ('APP-1', 'running')").run();
    expect(await messageFor(db, 'APP-1', false, write, env)).toEqual({ ok: false, reason: 'APP-1 is running, and its run writes into this checkout. Ask for a message once the run ends.' });
    db.prepare("UPDATE cards SET state = 'ready'").run();
    git(card, 'checkout', '--', '.');
    expect(await messageFor(db, 'APP-1', false, write, env)).toMatchObject({ ok: false, reason: expect.stringContaining('no uncommitted change') });
    expect(calls).toBe(0);
  });

  it('passes on the reason the engine did not answer, and refuses an empty answer', async () => {
    expect(await messageFor(db, 'APP-1', false, async () => ({ ok: false, reason: 'The run failed.' }), env)).toEqual({ ok: false, reason: 'The run failed.' });
    expect(await messageFor(db, 'APP-1', false, async () => ({ ok: true, answer: '  ' }), env)).toMatchObject({ ok: false, reason: expect.stringContaining('no message') });
  });

  it('reads the kind a message request asks for', () => {
    expect(messageAsk({ short: true })).toEqual({ short: true });
    expect(messageAsk({ short: 'yes' })).toBeNull();
    expect(messageAsk(null)).toBeNull();
  });

  // The card is the one in the address. A key in the body names nothing, so a request cannot ask
  // for a message about another card's checkout.
  it('asks about the card the route names, whatever the body says', async () => {
    const asked: string[] = [];
    vi.doMock('./db.ts', () => ({ database: () => db }));
    vi.doMock('./loop.ts', () => ({ loop: () => ({ writeMessage: async (key: string) => (asked.push(key), { ok: true, answer: 'feat: x' }) }) }));
    const { POST } = await import('../routes/api/card/[key]/commit-message/+server.ts');
    const request = new Request('http://localhost/api', { method: 'POST', body: JSON.stringify({ short: true, key: 'APP-2' }) });

    const answer = await (POST as unknown as (event: unknown) => Promise<Response>)({ params: { key: 'APP-1' }, request });

    expect(await answer.json()).toEqual({ ok: true, message: 'feat: x' });
    expect(asked).toEqual(['APP-1']);
    vi.doUnmock('./db.ts');
    vi.doUnmock('./loop.ts');
  });

  it('names only the files git does not track, not a new file that is already staged', async () => {
    write(join(card, 'notes.md'), 'a note\n');
    write(join(card, 'staged.md'), 'staged\n');
    git(card, 'add', 'staged.md');
    // Ignored files are neither tracked nor offered.
    write(join(card, '.git-ignored-list'), '');
    git(card, 'config', 'core.excludesFile', join(card, '.git-ignored-list'));
    write(join(card, 'build', 'out.js'), 'x');
    writeFileSync(join(card, '.git-ignored-list'), 'build/\n.git-ignored-list\n');

    const found = await changesFor(db, 'APP-1', env);

    expect(found.ok && found.untracked).toEqual(['notes.md']);
  });

  it.each(['queued', 'running'])('refuses to commit while the card is %s, because its run writes here', async (state) => {
    db.prepare('INSERT OR REPLACE INTO cards (key, state) VALUES (?, ?)').run('APP-1', state);

    const found = await commitFor(db, 'APP-1', 'feat: x', [], env);

    expect(found).toEqual({ ok: false, reason: `APP-1 is ${state}, and its run writes into this checkout. Commit once the run ends.` });
    expect(git(card, 'rev-list', '--count', 'main..HEAD').trim()).toBe('0');
  });

  it('refuses an empty message and makes no commit', async () => {
    const found = await commitFor(db, 'APP-1', '  ', [], env);

    expect(found.ok).toBe(false);
    expect(git(card, 'rev-list', '--count', 'main..HEAD').trim()).toBe('0');
  });

  it('commits the work, and the next read shows one ahead and a clean folder', async () => {
    const found = await commitFor(db, 'APP-1', 'feat(api): filter recipes', [], env);

    expect(found.ok).toBe(true);
    const after = await changesFor(db, 'APP-1', env);
    expect(after.ok && [after.row.ahead, after.row.changed, after.row.untracked]).toEqual([1, 0, 0]);
    expect(git(card, 'log', '-1', '--format=%B').trim()).toBe('feat(api): filter recipes');
  });

  it("passes a failing hook's own words back", async () => {
    const hooks = join(project, 'hooks');
    write(join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint found 2 problems in list.ts" >&2\nexit 1\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(project, 'config', 'core.hooksPath', hooks);

    const found = await commitFor(db, 'APP-1', 'feat(api): filter recipes', [], env, undefined, '.', true);

    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toContain('lint found 2 problems in list.ts');
  });

  it('skips the hooks unless the person ticked Run hooks', async () => {
    const hooks = join(project, 'hooks');
    write(join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint found 2 problems in list.ts" >&2\nexit 1\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(project, 'config', 'core.hooksPath', hooks);

    const found = await commitFor(db, 'APP-1', 'feat(api): filter recipes', [], env);

    expect(found.ok).toBe(true);
  });
});

it('reads the commit request, and nothing that is not one', () => {
  expect(commitAsk({ message: 'feat: x', include: ['notes.md'] })).toEqual({ message: 'feat: x', include: ['notes.md'], hooks: false });
  expect(commitAsk({ message: 'feat: x' })).toEqual({ message: 'feat: x', include: [], hooks: false });
  // Only a literal true turns the hooks on.
  expect(commitAsk({ message: 'feat: x', hooks: true })?.hooks).toBe(true);
  expect(commitAsk({ message: 'feat: x', hooks: 'yes' })?.hooks).toBe(false);
  expect(commitAsk({ message: 'feat: x', only: ['list.ts', 'notes.md'] })).toEqual({ message: 'feat: x', include: [], hooks: false, only: ['list.ts', 'notes.md'] });
  expect(commitAsk({ message: 'feat: x', only: 'list.ts' })).toBeNull();
  expect(commitAsk({ message: 'feat: x', only: [3] })).toBeNull();
  for (const bad of [null, 'text', {}, { message: 1 }, { message: 'x', include: 'notes.md' }, { message: 'x', include: [1] }]) {
    expect(commitAsk(bad)).toBeNull();
  }
});
