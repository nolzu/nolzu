import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, getSetting, openDatabase, saveCardPull, saveRun, savePlainSummary, startRun, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changesFor, commitAndPush } from './changes.ts';
import { publishFor, pullFor, pullRequestBody, pushFor } from './publish.ts';

let dir = '';
let project = '';
let card = '';
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-publish-'));
  project = join(dir, 'recipes');
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'list.ts'), 'export const list = [];\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'first');
  card = join(project, 'worktrees', 'APP-1');
  git(project, 'worktree', 'add', '-q', '-b', 'APP-1-add-a-search-box', card);
  writeFileSync(join(card, 'list.ts'), 'export const list = [1];\n');
  git(card, 'commit', '-qam', 'feat(api): filter recipes');

  db = openDatabase(join(dir, 'data'));
  writeSetting(db, 'projectPath', project);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'implement', title: 'Add a search box' });
  const run = startRun(db, { cardKey: 'APP-1', phase: 'implement', engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  saveRun(db, run, { sessionId: null, model: 'haiku', costUsd: 0, durationMs: 1, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });
  savePlainSummary(db, run, 'The list has a search box now.');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('says a pull request needs a GitHub remote when the project has none', async () => {
  const found = await publishFor(db, 'APP-1', env);

  expect(found.ok && found.remote).toBeNull();
  expect(found.ok && found.compare).toEqual({ ok: false, reason: 'This project has no remote, and a pull request needs a GitHub remote.' });
});

it('builds the compare URL for a GitHub remote, from the commit subject and the plain summary, while the branch is not pushed', async () => {
  git(project, 'remote', 'add', 'origin', 'https://github.com/example/recipe-workspace.git');

  const found = await publishFor(db, 'APP-1', env);

  expect(found.ok && found.pushed).toBe(false);
  expect(found.ok && found.confirmation).toBe('Push APP-1-add-a-search-box to origin at https://github.com/example/recipe-workspace.git.');
  const url = found.ok && found.compare.ok ? new URL(found.compare.url) : null;
  expect(url?.pathname).toBe('/example/recipe-workspace/compare/main...APP-1-add-a-search-box');
  // The key once, in front of the subject.
  expect(url?.searchParams.get('title')).toBe('APP-1 feat(api): filter recipes');
  expect(url?.searchParams.get('body')).toBe('The list has a search box now.');
});

// The plain summary for every reader first, then the implement run's pull request text without its title,
// which is the commit subject's job.
it('puts the pull request text under the plain summary, without its title line', async () => {
  git(project, 'remote', 'add', 'origin', 'https://github.com/example/recipe-workspace.git');
  mkdirSync(join(project, '.tasks', 'APP-1', 'implement'), { recursive: true });
  writeFileSync(join(project, '.tasks', 'APP-1', 'implement', 'pr.md'), 'Search recipes by title\n\n## What changed\n\nA q option.\n\n## How to test\n\nnpm test\n');

  const found = await publishFor(db, 'APP-1', env);

  const url = found.ok && found.compare.ok ? new URL(found.compare.url) : null;
  expect(url?.searchParams.get('body')).toBe('The list has a search box now.\n\n## What changed\n\nA q option.\n\n## How to test\n\nnpm test');
});

describe('pullRequestBody', () => {
  it('takes the summary alone when there is no pull request text, or only its title', () => {
    expect(pullRequestBody('The list has a search box now.', null)).toBe('The list has a search box now.');
    expect(pullRequestBody('The list has a search box now.', '# Search recipes by title\n')).toBe('The list has a search box now.');
  });

  // An old pr.md is a title and free text, and reads the same way.
  it('drops the first line that has text, and keeps an old free text as it is', () => {
    expect(pullRequestBody('Done.', '\nSearch recipes by title\n\nAdds a box.\n\nTest: npm test\n')).toBe('Done.\n\nAdds a box.\n\nTest: npm test');
  });

  it('takes the text alone when there is no summary', () => {
    expect(pullRequestBody('  ', 'Search\n\nAdds a box.')).toBe('Adds a box.');
  });

  // A real pr.md ended on the engine's own line, and the compare page must never carry it.
  it('leaves out a line that names a tool as the writer, and keeps the rest', () => {
    const line = `\u{1F916} ${['Generated', 'with'].join(' ')} [Claude Code](https://claude.com/claude-code)`;
    expect(pullRequestBody('Done.', `Search\n\nAdds a box.\n\n${line}\n`)).toBe('Done.\n\nAdds a box.');
  });
});

// The whole address, so a change to the order or the encoding of a part shows here.
it('builds the same compare URL for a project of one repository, byte for byte', async () => {
  git(project, 'remote', 'add', 'origin', 'https://github.com/example/recipe-workspace.git');

  const found = await publishFor(db, 'APP-1', env);

  expect(found.ok && found.compare).toEqual({
    ok: true,
    url: 'https://github.com/example/recipe-workspace/compare/main...APP-1-add-a-search-box?expand=1&title=APP-1%20feat(api)%3A%20filter%20recipes&body=The%20list%20has%20a%20search%20box%20now.',
  });
});

it('pushes nothing without the confirmation, and pushes the branch with it', async () => {
  const bare = join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', bare);
  git(project, 'remote', 'add', 'origin', bare);

  expect(await pushFor(db, 'APP-1', false, env)).toEqual({ ok: false, reason: 'A push needs the confirmation first. Nothing was sent.' });
  expect(git(bare, 'branch', '--list')).toBe('');

  expect((await pushFor(db, 'APP-1', true, env)).ok).toBe(true);
  expect(git(bare, 'branch', '--list')).toContain('APP-1-add-a-search-box');
  const after = await publishFor(db, 'APP-1', env);
  expect(after.ok && after.pushed).toBe(true);
});

// Getting started's last step turns done from a push that went, and from nothing before it.
it('marks the first push for Getting started only once a push went', async () => {
  writeSetting(db, 'gettingStarted', []);
  const bare = join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', bare);
  git(project, 'remote', 'add', 'origin', bare);

  await pushFor(db, 'APP-1', false, env);
  db.prepare("UPDATE cards SET state = 'running' WHERE key = 'APP-1'").run();
  expect((await pushFor(db, 'APP-1', true, env)).ok).toBe(false);
  expect(getSetting(db, 'gettingStarted')).toEqual([]);

  db.prepare("UPDATE cards SET state = 'ready' WHERE key = 'APP-1'").run();
  expect((await pushFor(db, 'APP-1', true, env)).ok).toBe(true);
  expect(getSetting(db, 'gettingStarted')).toEqual(['push']);
});

it('does not mark the first push when the remote refuses it', async () => {
  writeSetting(db, 'gettingStarted', []);
  git(project, 'remote', 'add', 'origin', join(dir, 'no-such-remote.git'));
  expect((await pushFor(db, 'APP-1', true, env)).ok).toBe(false);
  expect(getSetting(db, 'gettingStarted')).toEqual([]);
});

it('refuses to push while the card is running', async () => {
  db.prepare("UPDATE cards SET state = 'running' WHERE key = 'APP-1'").run();
  const found = await pushFor(db, 'APP-1', true, env);
  expect(found.ok).toBe(false);
  if (!found.ok) expect(found.reason).toContain('running');
});

it('counts a pushed branch as not pushed again once it has a new commit', async () => {
  const bare = join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', bare);
  git(project, 'remote', 'add', 'origin', bare);
  await pushFor(db, 'APP-1', true, env);
  writeFileSync(join(card, 'list.ts'), 'export const list = [2];\n');
  git(card, 'commit', '-qam', 'fix(api): keep the order');

  const found = await publishFor(db, 'APP-1', env);
  expect(found.ok && found.pushed).toBe(false);
});

it('picks origin over a remote that is listed before it', async () => {
  git(project, 'remote', 'add', 'backup', 'https://example.com/recipes.git');
  git(project, 'remote', 'add', 'origin', 'https://github.com/example/recipe-workspace.git');

  const found = await publishFor(db, 'APP-1', env);
  expect(found.ok && found.remote?.name).toBe('origin');
});

it('keeps a credential in the remote URL out of everything the page gets', async () => {
  git(project, 'remote', 'add', 'origin', 'https://x-access-token:secret-token@github.com/example/recipe-workspace.git');

  const found = await publishFor(db, 'APP-1', env);

  expect(JSON.stringify(found)).not.toContain('secret-token');
});

it('takes the first remote when there is no origin', async () => {
  git(project, 'remote', 'add', 'upstream', 'https://github.com/example/recipe-workspace.git');
  const found = await publishFor(db, 'APP-1', env);
  expect(found.ok && found.remote?.name).toBe('upstream');
});

it('puts the key in front of a subject that only holds a longer key', async () => {
  git(project, 'remote', 'add', 'origin', 'https://github.com/example/recipe-workspace.git');
  git(card, 'commit', '-q', '--allow-empty', '-m', 'fix(api): follow up on APP-12');

  const found = await publishFor(db, 'APP-1', env);
  const url = found.ok && found.compare.ok ? new URL(found.compare.url) : null;
  expect(url?.searchParams.get('title')).toBe('APP-1 fix(api): follow up on APP-12');
});

it('takes the card title when the branch has no commit of its own', async () => {
  git(project, 'remote', 'add', 'origin', 'https://github.com/example/recipe-workspace.git');
  git(card, 'reset', '-q', '--hard', 'main');

  const found = await publishFor(db, 'APP-1', env);
  const url = found.ok && found.compare.ok ? new URL(found.compare.url) : null;
  expect(url?.searchParams.get('title')).toBe('APP-1 Add a search box');
});

// The push confirm names where the branch goes: the host by its name and the repository's address.
it('names the host and the place of the remote for the push confirm, with no credential', async () => {
  git(project, 'remote', 'add', 'origin', 'https://x-access-token:secret-token@github.com/example/recipe-workspace.git');

  const found = await publishFor(db, 'APP-1', env);

  expect(found.ok && { host: found.host, place: found.place, branch: found.branch }).toEqual({ host: 'GitHub', place: 'github.com/example/recipe-workspace', branch: 'APP-1-add-a-search-box' });
});

it('names no host it does not know, and still names the place', async () => {
  git(project, 'remote', 'add', 'origin', 'https://git.example.com/team/recipes.git');

  const found = await publishFor(db, 'APP-1', env);

  expect(found.ok && { host: found.host, place: found.place }).toEqual({ host: null, place: 'git.example.com/team/recipes' });
});

it("names the card's open pull request from this remote, and no merged one or one of another repository", async () => {
  git(project, 'remote', 'add', 'origin', 'https://github.com/Example/Recipe-Workspace.git');
  saveCardPull(db, 'APP-1', { repo: 'example/other', number: 3, url: null, foundBy: 'attached', state: 'open' });
  saveCardPull(db, 'APP-1', { repo: 'example/recipe-workspace', number: 7, url: null, foundBy: 'attached', state: 'merged' });
  expect((await publishFor(db, 'APP-1', env)).ok && (await publishFor(db, 'APP-1', env) as { pull: unknown }).pull).toBeNull();

  saveCardPull(db, 'APP-1', { repo: 'example/recipe-workspace', number: 12, url: null, foundBy: 'attached', state: null });
  expect((await publishFor(db, 'APP-1', env) as { pull: unknown }).pull).toBeNull();
  saveCardPull(db, 'APP-1', { repo: 'example/recipe-workspace', number: 12, url: null, foundBy: 'attached', state: 'open' });
  const found = await publishFor(db, 'APP-1', env);

  expect(found.ok && found.pull).toEqual({ number: 12, url: 'https://github.com/Example/Recipe-Workspace/pull/12' });
});

it('matches no pull request for a remote off GitHub with the same name', async () => {
  git(project, 'remote', 'add', 'origin', 'https://gitlab.com/example/recipe-workspace.git');
  saveCardPull(db, 'APP-1', { repo: 'example/recipe-workspace', number: 12, url: null, foundBy: 'attached', state: 'open' });

  expect((await publishFor(db, 'APP-1', env) as { pull: unknown }).pull).toBeNull();
});

// A push turned down because someone else pushed to the branch, then "Pull into the checkout". The
// remote is a bare repository in the temp folder, so nothing here needs a network.
describe('pull into the checkout', () => {
  const branch = 'APP-1-add-a-search-box';

  // The card's branch is on the remote, another machine pushed to it, and the card committed again.
  async function movedOn(theirs: { file: string; text: string }, mine: { file: string; text: string }): Promise<void> {
    const bare = join(dir, 'remote.git');
    git(dir, 'init', '-q', '--bare', bare);
    git(project, 'remote', 'add', 'origin', bare);
    expect((await pushFor(db, 'APP-1', true, env)).ok).toBe(true);
    const other = join(dir, 'other');
    git(dir, 'clone', '-q', bare, other);
    git(other, 'checkout', '-q', branch);
    writeFileSync(join(other, theirs.file), theirs.text);
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'from another machine');
    git(other, 'push', '-q', 'origin', branch);
    writeFileSync(join(card, mine.file), mine.text);
    git(card, 'add', '-A');
    git(card, 'commit', '-q', '-m', 'the card kept working');
  }

  // The person's own folder: its branch, its commit and what git sees in it.
  const own = () => ({ branch: git(project, 'branch', '--show-current'), head: git(project, 'rev-parse', 'HEAD'), status: git(project, 'status', '--porcelain') });

  it('marks the push as rejected, pulls into the card checkout only, and then the push goes', async () => {
    await movedOn({ file: 'search.ts', text: 'export const search = true;\n' }, { file: 'sort.ts', text: 'export const sort = true;\n' });
    const before = own();

    expect(await pushFor(db, 'APP-1', true, env)).toMatchObject({ ok: false, rejected: true, command: `git -c push.default=current push --no-follow-tags -u origin refs/heads/${branch}` });
    expect(await pullFor(db, 'APP-1', env)).toEqual({ ok: true, upToDate: false });

    expect(git(card, 'log', '--format=%s', '-3')).toContain('from another machine');
    expect(own()).toEqual(before);
    expect((await pushFor(db, 'APP-1', true, env)).ok).toBe(true);
  });

  it('stops on a conflict, and the Changes tab names the files', async () => {
    await movedOn({ file: 'list.ts', text: 'export const list = [2];\n' }, { file: 'list.ts', text: 'export const list = [3];\n' });
    const before = own();

    const pulled = await pullFor(db, 'APP-1', env);

    expect(pulled).toMatchObject({ ok: false, conflicts: ['list.ts'] });
    const changes = await changesFor(db, 'APP-1', env);
    expect(changes.ok && changes.conflicted).toEqual(['list.ts']);
    expect(own()).toEqual(before);
  });

  it('refuses while the card is running, and fetches nothing', async () => {
    await movedOn({ file: 'search.ts', text: 'x\n' }, { file: 'sort.ts', text: 'y\n' });
    db.prepare("UPDATE cards SET state = 'running' WHERE key = 'APP-1'").run();
    const fetched = () => git(card, 'rev-parse', `origin/${branch}`);
    const seen = fetched();

    const pulled = await pullFor(db, 'APP-1', env);

    expect(pulled).toEqual({ ok: false, reason: 'APP-1 is running, and its run writes into this checkout. Pull once the run ends.', conflicts: [] });
    expect(fetched()).toBe(seen);
  });

  it('says there is nowhere to pull from with no remote', async () => {
    expect(await pullFor(db, 'APP-1', env)).toEqual({ ok: false, reason: 'This project has no remote, so there is nowhere to pull from. Add one with git remote add, then try again.', conflicts: [] });
  });

  // Two cards, each with its own checkout and branch. The pull names one card, and only that card's
  // checkout takes the other machine's commits.
  it("pulls into the checkout of the card asked for, never another card's", async () => {
    const second = join(project, 'worktrees', 'APP-2');
    git(project, 'worktree', 'add', '-q', '-b', 'APP-2-fix-the-footer', second);
    writeFileSync(join(second, 'footer.ts'), 'export const footer = 1;\n');
    git(second, 'add', '-A');
    git(second, 'commit', '-q', '-m', 'feat: footer');
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Fix the footer' });
    const bare = join(dir, 'remote.git');
    git(dir, 'init', '-q', '--bare', bare);
    git(project, 'remote', 'add', 'origin', bare);
    expect((await pushFor(db, 'APP-1', true, env)).ok).toBe(true);
    expect((await pushFor(db, 'APP-2', true, env)).ok).toBe(true);
    const other = join(dir, 'other');
    git(dir, 'clone', '-q', bare, other);
    git(other, 'checkout', '-q', 'APP-2-fix-the-footer');
    writeFileSync(join(other, 'search.ts'), 'export const search = true;\n');
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'from another machine');
    git(other, 'push', '-q', 'origin', 'APP-2-fix-the-footer');
    const first = git(card, 'rev-parse', 'HEAD');

    expect(await pullFor(db, 'APP-2', env)).toEqual({ ok: true, upToDate: false });

    expect(git(second, 'log', '--format=%s', '-1')).toBe('from another machine');
    expect(git(card, 'rev-parse', 'HEAD')).toBe(first);
    expect(git(card, 'status', '--porcelain')).toBe('');
  });
});

// The push dialog's one press: the commit with the message as the person left it, then the push of the
// card's branch. A bare repository in the temp folder is the remote, so nothing leaves the machine.
describe('commit and push', () => {
  const branch = 'APP-1-add-a-search-box';
  const message = 'feat(search): add a search box\n\nFilters by title, ignores case.';
  let bare = '';

  beforeEach(() => {
    bare = join(dir, 'remote.git');
    git(dir, 'init', '-q', '--bare', bare);
    git(project, 'remote', 'add', 'origin', bare);
    writeFileSync(join(card, 'list.ts'), 'export const list = [1, 2];\n');
    writeFileSync(join(card, 'search.ts'), 'export const search = true;\n');
  });

  const refs = () => git(bare, 'for-each-ref', '--format=%(refname:short)');

  it('commits nothing and pushes nothing without the press', async () => {
    const head = git(card, 'rev-parse', 'HEAD');

    const done = await commitAndPush(db, 'APP-1', false, { message, include: ['search.ts'] }, env);

    expect(done).toEqual({ ok: false, reason: 'A push needs the confirmation first. Nothing was committed or sent.' });
    expect(git(card, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(card, 'status', '--porcelain')).not.toBe('');
    expect(refs()).toBe('');
  });

  it("commits with the edited message and pushes the card's branch only", async () => {
    // Another card with a commit of its own, which the press leaves on this machine.
    const second = join(project, 'worktrees', 'APP-2');
    git(project, 'worktree', 'add', '-q', '-b', 'APP-2-fix-the-footer', second);
    writeFileSync(join(second, 'footer.ts'), 'export const footer = 1;\n');
    git(second, 'add', '-A');
    git(second, 'commit', '-q', '-m', 'feat: footer');
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Fix the footer' });

    const done = await commitAndPush(db, 'APP-1', true, { message, include: ['search.ts'] }, env);

    expect(done).toEqual({ ok: true, alreadyUpToDate: false });
    expect(refs()).toBe(branch);
    expect(git(bare, 'log', '-1', '--format=%B', branch)).toBe(message);
    expect(git(bare, 'show', '--name-only', '--format=', branch).split('\n').sort()).toEqual(['list.ts', 'search.ts']);
    expect(git(card, 'status', '--porcelain')).toBe('');
  });

  it('commits and pushes the card it was asked for, not the first card', async () => {
    const second = join(project, 'worktrees', 'APP-2');
    git(project, 'worktree', 'add', '-q', '-b', 'APP-2-fix-the-footer', second);
    writeFileSync(join(second, 'footer.ts'), 'export const footer = 1;\n');
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Fix the footer' });
    const first = git(card, 'rev-parse', 'HEAD');

    const done = await commitAndPush(db, 'APP-2', true, { message: 'feat: footer', include: ['footer.ts'] }, env);

    expect(done.ok).toBe(true);
    expect(refs()).toBe('APP-2-fix-the-footer');
    expect(git(bare, 'log', '-1', '--format=%s', 'APP-2-fix-the-footer')).toBe('feat: footer');
    expect(git(card, 'rev-parse', 'HEAD')).toBe(first);
    expect(git(card, 'status', '--porcelain')).not.toBe('');
  });

  // An agent wrote the work, so the repository's hooks run only on a press with Run hooks ticked.
  it('skips the commit and push hooks unless Run hooks is ticked for that press', async () => {
    const hooks = join(dir, 'hooks');
    mkdirSync(hooks);
    // The list is kept in the shared git folder: a commit's hook runs inside the git wall, which allows the repository only.
    const list = join(project, '.git', 'ran');
    for (const name of ['pre-commit', 'pre-push']) writeFileSync(join(hooks, name), `#!/bin/sh\necho ${name} >> "${list}"\n`, { mode: 0o755 });
    git(project, 'config', 'core.hooksPath', hooks);
    const ran = () => (existsSync(list) ? readFileSync(list, 'utf8').trim().split('\n') : []);

    expect((await commitAndPush(db, 'APP-1', true, { message, include: ['search.ts'] }, env)).ok).toBe(true);
    expect(ran()).toEqual([]);

    writeFileSync(join(card, 'list.ts'), 'export const list = [1, 2, 3];\n');
    expect((await commitAndPush(db, 'APP-1', true, { message: 'feat: three', include: [], hooks: true }, env)).ok).toBe(true);
    expect(ran()).toEqual(['pre-commit', 'pre-push']);
  });

  it('pushes nothing when git refuses the commit', async () => {
    const done = await commitAndPush(db, 'APP-1', true, { message: '  ', include: [] }, env);

    expect(done.ok).toBe(false);
    expect(refs()).toBe('');
  });

  it("still ticks Getting started's first push", async () => {
    writeSetting(db, 'gettingStarted', []);

    expect((await commitAndPush(db, 'APP-1', true, { message, include: ['search.ts'] }, env)).ok).toBe(true);

    expect(getSetting(db, 'gettingStarted')).toEqual(['push']);
  });

  // The route takes the commit from the body, and a push that went tells the open streams, because the
  // rail's Getting started reads the step off them.
  it('commits and pushes through the route, and tells the loop', async () => {
    // The route runs git with the process environment, so the author comes from the repository.
    git(project, 'config', 'user.name', 'dev');
    git(project, 'config', 'user.email', 'dev@example.com');
    const changed = vi.fn();
    const watchPulls = vi.fn();
    vi.doMock('./db.ts', () => ({ database: () => db }));
    vi.doMock('./loop.ts', () => ({ loop: () => ({ changed, watchPulls }) }));
    const { POST } = await import('../routes/api/card/[key]/push/+server.ts');
    const post = (body: unknown, key = 'APP-1') =>
      (POST as unknown as (event: unknown) => Promise<Response>)({ params: { key }, request: new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) }) });

    const refused = await post({ confirmed: true, message: 7 });
    expect(refused.status).toBe(400);
    expect(refs()).toBe('');

    const answer = await post({ confirmed: true, message, include: ['search.ts'] });

    expect(answer.status).toBe(200);
    expect(git(bare, 'log', '-1', '--format=%B', branch)).toBe(message);
    expect(changed).toHaveBeenCalledOnce();
    // The push went, so the card's pull request is looked for at once.
    expect(watchPulls).toHaveBeenCalledWith('APP-1');

    // A second card goes by its own key, not the first card's.
    const second = join(project, 'worktrees', 'APP-2');
    git(project, 'worktree', 'add', '-q', '-b', 'APP-2-fix-the-footer', second);
    writeFileSync(join(second, 'footer.ts'), 'export const footer = 1;\n');
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Fix the footer' });
    expect((await post({ confirmed: true, message: 'feat: footer', include: ['footer.ts'] }, 'APP-2')).status).toBe(200);
    expect(git(bare, 'log', '-1', '--format=%s', 'APP-2-fix-the-footer')).toBe('feat: footer');
    vi.doUnmock('./db.ts');
    vi.doUnmock('./loop.ts');
  });
});
