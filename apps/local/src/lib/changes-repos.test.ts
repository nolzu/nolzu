import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, openDatabase, setCardRepos, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { changeGroups, changesCount, changesFor, commitChanges, commitFor, messageFor, patchAsk, patchFor } from './changes.ts';
import { noCheckout } from './checkout.ts';
import { publishFor, pushFor } from './publish.ts';

let dir = '';
let project = '';
let db: DatabaseSync;

const env = {
  ...(process.env as Record<string, string>),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'dev',
  GIT_AUTHOR_EMAIL: 'dev@example.com',
  GIT_COMMITTER_NAME: 'dev',
  GIT_COMMITTER_EMAIL: 'dev@example.com',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

const repoAt = (at: string, branch: string, file: string): void => {
  mkdirSync(at, { recursive: true });
  git(at, 'init', '-q', '-b', branch);
  writeFileSync(join(at, file), 'first\n');
  git(at, 'add', '-A');
  git(at, 'commit', '-q', '-m', 'first');
};

const root = () => join(project, 'worktrees', 'APP-1');
const api = () => join(root(), 'api');
// A new file in both checkouts, so each repository has work and gets its push facts.
const touchBoth = () => {
  writeFileSync(join(root(), 'notes.md'), 'a\n');
  writeFileSync(join(api(), 'notes.md'), 'a\n');
};

// A root repository on main that ignores its child api, which branches from develop. The card works
// in both, with one checkout each on the card's one branch, the way a run makes them.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-changes-repos-'));
  project = join(dir, 'recipes');
  repoAt(project, 'main', 'list.ts');
  writeFileSync(join(project, '.gitignore'), 'api/\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'ignore api');
  repoAt(join(project, 'api'), 'develop', 'server.ts');
  git(project, 'worktree', 'add', '-q', '-b', 'APP-1-search', root());
  git(join(project, 'api'), 'worktree', 'add', '-q', '-b', 'APP-1-search', api());

  db = openDatabase(join(dir, 'data'));
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'repos', [{ path: '.', base: null }, { path: 'api', base: 'develop' }]);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'implement', title: 'Add a search box' });
  setCardRepos(db, 'APP-1', ['.', 'api'], 'person');
});

afterEach(() => {
  vi.doUnmock('./db.ts');
  vi.doUnmock('./loop.ts');
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('reads the change of the repository asked for, against its own base', async () => {
  writeFileSync(join(api(), 'server.ts'), 'second\n');

  const found = await changesFor(db, 'APP-1', env, undefined, 'api');
  const rootFound = await changesFor(db, 'APP-1', env);

  expect(found.ok && [found.row.repo, found.row.base, found.uncommitted?.stat.files]).toEqual(['api', 'develop', 1]);
  expect(rootFound.ok && [rootFound.row.base, rootFound.uncommitted?.stat.files]).toEqual(['main', 0]);
});

it('loads one group per card repository, the root first, and push facts only where the card did something', async () => {
  writeFileSync(join(api(), 'server.ts'), 'second\n');
  const groups = await changeGroups(db, 'APP-1', env);

  // The root goes by the project folder's name, the others by their path.
  expect(groups.map((one) => [one.repo, one.name, one.changes.ok, one.publish.ok])).toEqual([
    ['.', 'recipes', true, false],
    ['api', 'api', true, true],
  ]);
  expect(groups[0]?.publish).toEqual({ ok: false, reason: 'APP-1 has nothing to push in recipes.' });
});

// The Changes tab's count in the head is what Not committed shows, the view the tab opens on: the api's
// work in the folder, untracked files in, and not the root's commit. A card with no checkout yet says
// so, as "Changes none yet".
it('counts what is not committed in every card repository for the tab, and says none yet before a checkout', async () => {
  expect(await changesCount(db, 'APP-1', env)).toEqual({});
  writeFileSync(join(root(), 'list.ts'), 'first\nsecond\n');
  git(root(), 'commit', '-q', '-am', 'second line');
  // A commit alone leaves nothing to commit, so the tab shows no count.
  expect(await changesCount(db, 'APP-1', env)).toEqual({});
  writeFileSync(join(api(), 'server.ts'), 'changed\n');
  writeFileSync(join(api(), 'notes.md'), 'a\nb\n');
  writeFileSync(join(root(), 'list.ts'), 'first\n');

  expect(await changesCount(db, 'APP-1', env)).toEqual({ changes: '+3 -2' });
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Fix the footer' });
  setCardRepos(db, 'APP-2', ['.'], 'person');
  expect(await changesCount(db, 'APP-2', env)).toEqual({ changes: 'none yet' });
});

// The diff the tab draws and a comment is made on: one tree from the base to the folder.
it('hands the tab the base to the folder as one tree', async () => {
  writeFileSync(join(api(), 'server.ts'), 'changed\n');
  git(api(), 'commit', '-q', '-am', 'change the server');
  writeFileSync(join(api(), 'notes.md'), 'a\n');

  const found = await changesFor(db, 'APP-1', env, undefined, 'api');

  expect(found.ok && found.diff).toEqual({
    stat: { files: 2, added: 2, removed: 1 },
    tree: [
      { name: 'notes.md', path: 'notes.md', children: [], entry: { path: 'notes.md', oldPath: null, status: 'added', added: 1, removed: 0, binary: false } },
      { name: 'server.ts', path: 'server.ts', children: [], entry: { path: 'server.ts', oldPath: null, status: 'changed', added: 1, removed: 1, binary: false } },
    ],
  });
});

it('commits with repo api only in the api checkout', async () => {
  writeFileSync(join(root(), 'list.ts'), 'second\n');
  writeFileSync(join(api(), 'server.ts'), 'second\n');

  const done = await commitFor(db, 'APP-1', 'feat(api): search', [], env, undefined, 'api');

  expect(done.ok).toBe(true);
  expect(git(api(), 'rev-list', '--count', 'develop..HEAD')).toBe('1');
  expect(git(root(), 'rev-list', '--count', 'main..HEAD')).toBe('0');
  expect(git(root(), 'status', '--porcelain')).toBe('M list.ts');
});

it('hands the engine only the change in the repository asked for', async () => {
  writeFileSync(join(root(), 'list.ts'), 'root change\n');
  writeFileSync(join(api(), 'server.ts'), 'api change\n');
  const asked: { prompt: string; repo: string | undefined }[] = [];
  const write = async (_key: string, prompt: string, _signal?: AbortSignal, repo?: string) => {
    asked.push({ prompt, repo });
    return { ok: true as const, answer: 'feat(api): search' };
  };

  expect(await messageFor(db, 'APP-1', true, write, env, undefined, 'api')).toEqual({ ok: true, message: 'feat(api): search' });
  expect(asked[0]?.prompt).toContain('+api change');
  expect(asked[0]?.prompt).not.toContain('root change');
  expect(asked[0]?.repo).toBe('api');
});

it('refuses a patch for a file in the other repository', async () => {
  writeFileSync(join(api(), 'server.ts'), 'second\n');
  writeFileSync(join(root(), 'list.ts'), 'second\n');

  expect(await patchFor(db, 'APP-1', { path: '../list.ts', oldPath: null, group: 'uncommitted' }, env, undefined, 'api')).toEqual({
    ok: false,
    reason: "../list.ts is not inside the card's checkout, so it is not shown.",
  });
  expect(await patchFor(db, 'APP-1', { path: 'api/server.ts', oldPath: null, group: 'uncommitted' }, env)).toEqual({
    ok: false,
    reason: 'api/server.ts is in the checkout of api, so it is shown in that group.',
  });
  expect(await patchFor(db, 'APP-1', { path: 'server.ts', oldPath: null, group: 'uncommitted' }, env, undefined, 'api')).toMatchObject({ ok: true });
  expect(await patchFor(db, 'APP-1', { path: 'list.ts', oldPath: null, group: 'uncommitted' }, env)).toMatchObject({ ok: true });
});

// Ticked in the root, the child's folder would go in as a pointer to the card's own checkout of it.
it("refuses to commit the child's folder in the root", async () => {
  writeFileSync(join(root(), 'list.ts'), 'second\n');

  expect(await commitFor(db, 'APP-1', 'feat: search', ['api/'], env)).toEqual({
    ok: false,
    reason: 'api/ is in the checkout of api, so it is committed in that group.',
  });
  expect(git(root(), 'rev-list', '--count', 'main..HEAD')).toBe('0');
  expect(await commitFor(db, 'APP-1', 'feat: search', [], env, undefined, '.', false, ['list.ts', 'api/'])).toEqual({
    ok: false,
    reason: 'api/ is in the checkout of api, so it is committed in that group.',
  });
});

// The composer sends every ticked path, and the commit takes exactly those.
it('commits exactly the ticked paths of a repository, and leaves the rest in the folder', async () => {
  writeFileSync(join(api(), 'server.ts'), 'second\n');
  writeFileSync(join(api(), 'notes.md'), 'a\n');
  writeFileSync(join(api(), 'left.md'), 'b\n');

  expect((await commitFor(db, 'APP-1', 'feat(api): notes', [], env, undefined, 'api', false, ['notes.md'])).ok).toBe(true);
  expect(git(api(), 'show', '--name-only', '--format=', 'HEAD')).toBe('notes.md');
  expect(git(api(), 'status', '--porcelain').split('\n').map((line) => line.trim()).sort()).toEqual(['?? left.md', 'M server.ts']);
});

it.each(['../x', 'web', '', '..'])('refuses the repository %j in every request', async (repo) => {
  const reason = `APP-1 has no repository named ${JSON.stringify(repo)}.`;
  const write = vi.fn();

  expect(await changesFor(db, 'APP-1', env, undefined, repo)).toEqual({ ok: false, reason });
  expect(await patchFor(db, 'APP-1', { path: 'x', oldPath: null, group: 'uncommitted' }, env, undefined, repo)).toEqual({ ok: false, reason });
  expect(await commitFor(db, 'APP-1', 'feat: x', [], env, undefined, repo)).toEqual({ ok: false, reason });
  expect(await messageFor(db, 'APP-1', true, write, env, undefined, repo)).toEqual({ ok: false, reason });
  expect(await publishFor(db, 'APP-1', env, repo)).toEqual({ ok: false, reason });
  expect(await pushFor(db, 'APP-1', true, env, undefined, repo)).toEqual({ ok: false, reason });
  expect(write).not.toHaveBeenCalled();
});

it('says so when the card has no repository list yet', async () => {
  setCardRepos(db, 'APP-1', [], 'person');

  expect(await changesFor(db, 'APP-1', env)).toEqual({ ok: false, reason: 'APP-1 has no repository list yet.' });
});

it("names that repository's remote in the push confirmation, and pushes there", async () => {
  const apiRemote = join(dir, 'recipe-api.git');
  const rootRemote = join(dir, 'recipe-web.git');
  git(dir, 'init', '-q', '--bare', apiRemote);
  git(dir, 'init', '-q', '--bare', rootRemote);
  git(join(project, 'api'), 'remote', 'add', 'origin', apiRemote);
  // A different name on the root, so a push that took the root's remote would miss in api.
  git(project, 'remote', 'add', 'upstream', rootRemote);
  writeFileSync(join(api(), 'server.ts'), 'second\n');
  git(api(), 'commit', '-qam', 'feat(api): search');

  const found = await publishFor(db, 'APP-1', env, 'api');

  expect(found.ok && found.confirmation).toBe(`Push APP-1-search to origin at ${apiRemote}.`);
  expect(await pushFor(db, 'APP-1', true, env, undefined, 'api')).toMatchObject({ ok: true });
  expect(git(apiRemote, 'branch', '--list', 'APP-1-search')).toContain('APP-1-search');
  expect(git(rootRemote, 'branch', '--list', 'APP-1-search')).toBe('');
});

it('compares against the base of the repository asked for, and names it when it has no remote', async () => {
  expect(await pushFor(db, 'APP-1', true, env, undefined, 'api')).toEqual({
    ok: false,
    reason: 'api has no remote, so there is nowhere to push. Add one with git remote add, then try again.',
  });

  git(join(project, 'api'), 'remote', 'add', 'origin', 'git@github.com:example/recipe-api.git');
  const found = await publishFor(db, 'APP-1', env, 'api');

  expect(found.ok && found.compare.ok && found.compare.url).toContain('/example/recipe-api/compare/develop...APP-1-search?');
});

it('gives each repository its own compare link, on its own remote and base, with the one branch as head', async () => {
  git(project, 'remote', 'add', 'origin', 'https://github.com/example/recipe-web.git');
  git(join(project, 'api'), 'remote', 'add', 'origin', 'https://github.com/example/recipe-api.git');
  touchBoth();

  const links = (await changeGroups(db, 'APP-1', env)).map((one) => {
    const url = one.publish.ok && one.publish.compare.ok ? new URL(one.publish.compare.url) : null;
    return [one.repo, url?.pathname, url?.searchParams.get('title'), url?.searchParams.get('body')];
  });

  // No commit on the branch yet, so the title is the card title, and no summary is saved.
  expect(links).toEqual([
    ['.', '/example/recipe-web/compare/main...APP-1-search', 'APP-1 Add a search box', ''],
    ['api', '/example/recipe-api/compare/develop...APP-1-search', 'APP-1 Add a search box', ''],
  ]);
});

it('names the repository with no remote in its own group, and the other link still shows', async () => {
  git(join(project, 'api'), 'remote', 'add', 'origin', 'https://github.com/example/recipe-api.git');
  touchBoth();

  const [rootGroup, apiGroup] = await changeGroups(db, 'APP-1', env);

  expect(rootGroup?.publish.ok && rootGroup.publish.compare).toEqual({ ok: false, reason: 'This project has no remote, and a pull request needs a GitHub remote.' });
  expect(apiGroup?.publish.ok && apiGroup.publish.compare.ok && apiGroup.publish.compare.url).toContain('/example/recipe-api/compare/develop...APP-1-search?');

  git(join(project, 'api'), 'remote', 'remove', 'origin');
  git(project, 'remote', 'add', 'origin', 'https://github.com/example/recipe-web.git');
  const [rootAgain, apiAgain] = await changeGroups(db, 'APP-1', env);

  expect(apiAgain?.publish.ok && apiAgain.publish.compare).toEqual({ ok: false, reason: 'api has no remote, and a pull request needs a GitHub remote.' });
  expect(rootAgain?.publish.ok && rootAgain.publish.compare.ok && rootAgain.publish.compare.url).toContain('/example/recipe-web/compare/main...APP-1-search?');
});

// The repository comes from the request, the card from the address.
it('reads the repository from the body of a commit and from the query of a patch', async () => {
  writeFileSync(join(api(), 'server.ts'), 'second\n');
  vi.doMock('./db.ts', () => ({ database: () => db }));
  const commit = (await import('../routes/api/card/[key]/commit/+server.ts')).POST as unknown as (event: unknown) => Promise<Response>;
  const patch = (await import('../routes/api/card/[key]/patch/+server.ts')).GET as unknown as (event: unknown) => Promise<Response>;

  const bad = await patch({ params: { key: 'APP-1' }, url: new URL('http://localhost/api?path=x&group=uncommitted&repo=../x'), request: new Request('http://localhost/api') });
  expect(await bad.json()).toEqual({ ok: false, reason: 'APP-1 has no repository named "../x".' });
  // An empty name is a name, not the root: only a missing one means the root.
  const empty = await patch({ params: { key: 'APP-1' }, url: new URL('http://localhost/api?path=x&group=uncommitted&repo='), request: new Request('http://localhost/api') });
  expect(await empty.json()).toEqual({ ok: false, reason: 'APP-1 has no repository named "".' });

  // The route hands git the process environment, and a CI machine has no git name or email there.
  for (const [name, value] of Object.entries(env)) if (name.startsWith('GIT_')) vi.stubEnv(name, value);
  const request = new Request('http://localhost/api', { method: 'POST', body: JSON.stringify({ message: 'feat(api): search', repo: 'api' }) });
  const done = await commit({ params: { key: 'APP-1' }, request });
  vi.unstubAllEnvs();
  expect({ status: done.status, body: await done.text() }).toMatchObject({ status: 200 });
  expect(git(api(), 'rev-list', '--count', 'develop..HEAD')).toBe('1');
});

it('reads the repository from the body of a push and of a message request', async () => {
  const write = vi.fn();
  vi.doMock('./db.ts', () => ({ database: () => db }));
  vi.doMock('./loop.ts', () => ({ loop: () => ({ writeMessage: write }) }));
  const push = (await import('../routes/api/card/[key]/push/+server.ts')).POST as unknown as (event: unknown) => Promise<Response>;
  const message = (await import('../routes/api/card/[key]/commit-message/+server.ts')).POST as unknown as (event: unknown) => Promise<Response>;
  const post = (body: string | undefined) => new Request('http://localhost/api', { method: 'POST', ...(body === undefined ? {} : { body }) });

  expect(await (await push({ params: { key: 'APP-1' }, request: post(JSON.stringify({ confirmed: true, repo: '../x' })) })).json()).toEqual({
    ok: false,
    reason: 'APP-1 has no repository named "../x".',
  });
  expect(await (await push({ params: { key: 'APP-1' }, request: post(undefined) })).json()).toEqual({
    ok: false,
    reason: 'A push needs the confirmation first. Nothing was sent.',
  });
  expect(await (await message({ params: { key: 'APP-1' }, request: post(JSON.stringify({ short: true, repo: 'web' })) })).json()).toEqual({
    ok: false,
    reason: 'APP-1 has no repository named "web".',
  });
  expect(write).not.toHaveBeenCalled();
});

// "Pull into the checkout" reads the card from the address and the repository from the body, so a
// pull asked for one card never reaches another card's checkout.
it('reads the card from the address and the repository from the body of a pull', async () => {
  vi.doMock('./db.ts', () => ({ database: () => db }));
  const pull = (await import('../routes/api/card/[key]/pull/+server.ts')).POST as unknown as (event: unknown) => Promise<Response>;
  const post = (body: unknown) => new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) });
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Fix the footer' });
  setCardRepos(db, 'APP-2', ['.'], 'person');

  const second = await pull({ params: { key: 'APP-2' }, request: post({}) });
  expect({ status: second.status, body: await second.json() }).toEqual({ status: 422, body: { ok: false, reason: noCheckout('APP-2', '.'), conflicts: [] } });
  const named = await pull({ params: { key: 'APP-1' }, request: post({ repo: '../x' }) });
  expect({ status: named.status, body: await named.json() }).toEqual({ status: 422, body: { ok: false, reason: 'APP-1 has no repository named "../x".', conflicts: [] } });
});

// Each card has its own list: a second card that works only in the root has no api checkout to read,
// whatever the first card's list says. Its api group only says it has no changes there.
it("reads the list of the card asked for, not another card's", async () => {
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Fix the footer' });
  setCardRepos(db, 'APP-2', ['.'], 'person');

  const groups = await changeGroups(db, 'APP-2', env);
  expect(groups.map((one) => [one.repo, one.name])).toEqual([
    ['.', 'recipes'],
    ['api', 'api'],
  ]);
  expect(groups[1]?.changes).toEqual({ ok: false, reason: "APP-2 does not work in api, so it has no changes there. The card's repositories are on its Settings tab." });
  expect(await changesFor(db, 'APP-2', env, undefined, 'api')).toEqual({ ok: false, reason: 'APP-2 has no repository named "api".' });
  // APP-2 has no checkout yet, so nothing of APP-1's is read, committed or pushed in its name.
  const none = { ok: false, reason: 'APP-2 has no checkout. A run makes one. A closed card has none once its checkouts are removed.' };
  writeFileSync(join(root(), 'list.ts'), 'second\n');
  expect(await changesFor(db, 'APP-2', env)).toEqual(none);
  expect(await commitFor(db, 'APP-2', 'feat: footer', [], env)).toEqual(none);
  expect(await publishFor(db, 'APP-2', env)).toEqual(none);
  expect(git(root(), 'rev-list', '--count', 'main..HEAD')).toBe('0');
});

// With its api checkout gone, the sentence names api, so it is not read as the root's.
it('names the repository whose checkout is missing', async () => {
  git(join(project, 'api'), 'worktree', 'remove', '--force', api());

  expect(await changesFor(db, 'APP-1', env, undefined, 'api')).toEqual({
    ok: false,
    reason: 'APP-1 has no checkout of api. A run makes one. A closed card has none once its checkouts are removed.',
  });
});

it('gives a card on an empty workspace one group that says there is no repository yet', async () => {
  writeSetting(db, 'repos', null);
  writeSetting(db, 'workspace', true);
  writeSetting(db, 'repos', []);
  const reason = 'This project has no repository yet. Add one in Project settings.';

  const groups = await changeGroups(db, 'APP-1', env);

  expect(groups).toEqual([{ repo: '.', name: 'recipes', changes: { ok: false, reason }, publish: { ok: false, reason } }]);
});

// Not committed lists the commits of each repository with nothing to commit, and only there: a
// repository with work in its folder, or the Whole card view, costs no commit list.
it('reads the commit list only for Not committed, per repository with commits and nothing to commit', async () => {
  writeFileSync(join(api(), 'server.ts'), 'second\n');
  git(api(), 'commit', '-q', '-am', 'change the server');

  const quiet = await changeGroups(db, 'APP-1', env);
  const api1 = quiet.find((one) => one.repo === 'api')?.changes;
  expect(api1?.ok && api1.commits?.list.map((one) => [one.subject, one.pushed])).toEqual([['change the server', false]]);
  expect(api1?.ok && api1.commits?.total).toBe(1);
  // The root has no commit of the card's, so it gets no list.
  const root1 = quiet.find((one) => one.repo === '.')?.changes;
  expect(root1?.ok && root1.commits).toBeUndefined();

  const whole = (await changeGroups(db, 'APP-1', env, undefined, 'all')).find((one) => one.repo === 'api')?.changes;
  expect(whole?.ok && whole.commits).toBeUndefined();

  // Work in the root does not hide the api's commits.
  writeFileSync(join(root(), 'notes.md'), 'a\n');
  const mixed = await changeGroups(db, 'APP-1', env, undefined, 'uncommitted');
  const api2 = mixed.find((one) => one.repo === 'api')?.changes;
  expect(api2?.ok && api2.commits?.total).toBe(1);
  // The api has work in its folder now, so it gets no list.
  writeFileSync(join(api(), 'notes.md'), 'a\n');
  const busy = (await changeGroups(db, 'APP-1', env, undefined, 'uncommitted')).find((one) => one.repo === 'api')?.changes;
  expect(busy?.ok && busy.commits).toBeUndefined();
});

it('reads one commit of a repository as a diff group, and its file patch through the commit group', async () => {
  writeFileSync(join(api(), 'server.ts'), 'second\n');
  git(api(), 'commit', '-q', '-am', 'change the server');
  const sha = git(api(), 'rev-parse', 'HEAD');

  const found = await commitChanges(db, 'APP-1', sha, env, undefined, 'api');
  expect(found.ok && found.diff.stat).toEqual({ files: 1, added: 1, removed: 1 });
  const ask = patchAsk(new URLSearchParams({ path: 'server.ts', group: 'commit', commit: sha }));
  expect(ask).toEqual({ path: 'server.ts', oldPath: null, group: 'commit', commit: sha });
  const patch = ask === null ? null : await patchFor(db, 'APP-1', ask, env, undefined, 'api');
  expect(patch?.ok && patch.text).toContain('+second');
  // The commit group names its commit, or it is no ask at all.
  expect(patchAsk(new URLSearchParams({ path: 'server.ts', group: 'commit' }))).toBeNull();
  expect(await commitChanges(db, 'APP-1', 'HEAD~1', env, undefined, 'api')).toEqual({ ok: false, reason: '"HEAD~1" is not a commit id, so it has no diff to show.' });
});
