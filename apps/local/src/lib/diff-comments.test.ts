import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, openDatabase, setCardRepos, writeSetting } from '@nolzu/core/node';
import { numberedLines, placeComments } from '@nolzu/ui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commitFor, patchFor } from './changes.ts';
import { addComment, COMMENT_LIMIT, commentsOf, deleteComment, editComment } from './diff-comments.ts';
import { lineNow } from './send-back.ts';

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
const write = (path: string, content: string) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

const card = () => join(project, 'worktrees', 'APP-1');
const RECIPE = ['<article>', '  {#if !failed}', '    <img />', '  {:else}', '    <div class="img-missing"></div>', '  {/if}', '</article>'];

// A recipe app on main, and APP-1's checkout on its own branch with one changed file, one new file
// that is not committed yet, and one deleted file.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-comments-'));
  project = join(dir, 'recipes');
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  write(join(project, 'src/RecipeCard.svelte'), '<article>\n  <img />\n</article>\n');
  write(join(project, 'src/old.ts'), 'export const old = 1;\n');
  write(join(project, 'README.md'), 'Recipes\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'first');
  git(project, 'worktree', 'add', '-q', '-b', 'APP-1-image', card());
  write(join(card(), 'src/RecipeCard.svelte'), `${RECIPE.join('\n')}\n`);
  git(card(), 'rm', '-q', 'src/old.ts');
  git(card(), 'commit', '-q', '-am', 'placeholder');
  write(join(card(), 'src/placeholder.svg'), '<svg></svg>\n');

  db = openDatabase(join(dir, 'data'));
  writeSetting(db, 'projectPath', project);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'implement', title: 'Show a placeholder for a broken image' });
});

afterEach(() => {
  vi.doUnmock('./db.ts');
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const on = (line: number, over: Record<string, unknown> = {}) => ({
  file: 'src/RecipeCard.svelte',
  line,
  lineText: RECIPE[line - 1],
  text: 'Use the placeholder from assets, not a grey box.',
  ...over,
});

describe('the diff_comments table', () => {
  it('keeps a comment with its repository, file, line, the line as it read, its text and the commit it was made on', async () => {
    const said = await addComment(db, 'APP-1', on(5), env);

    expect(said.status).toBe(201);
    const [saved] = commentsOf(db, 'APP-1');
    expect(saved).toMatchObject({
      repo: '.',
      file: 'src/RecipeCard.svelte',
      line: 5,
      lineText: '    <div class="img-missing"></div>',
      text: 'Use the placeholder from assets, not a grey box.',
      commit: git(card(), 'rev-parse', 'HEAD'),
      sentAt: null,
    });
    expect(Date.parse(saved!.createdAt)).not.toBeNaN();
    expect(said.body).toEqual({ ok: true, comment: saved });
  });

  it('takes a comment on a file that is not committed yet, because the diff runs to the folder', async () => {
    const said = await addComment(db, 'APP-1', { file: 'src/placeholder.svg', line: 1, lineText: '<svg></svg>', text: 'Draw a plate here.' }, env);

    expect(said.status).toBe(201);
  });

  it('edits the text and keeps the line, and deletes a comment', async () => {
    await addComment(db, 'APP-1', on(5), env);
    const [first] = commentsOf(db, 'APP-1');

    const edited = editComment(db, 'APP-1', String(first!.id), { text: '  Use recipe-placeholder.svg.  ' });
    expect(edited).toEqual({ status: 200, body: { ok: true, comment: { ...first, text: 'Use recipe-placeholder.svg.' } } });

    expect(deleteComment(db, 'APP-1', String(first!.id))).toEqual({ status: 200, body: { ok: true } });
    expect(commentsOf(db, 'APP-1')).toEqual([]);
  });

  it('refuses to edit a comment that was sent back, and keeps the text Implement got', async () => {
    await addComment(db, 'APP-1', on(5), env);
    const [first] = commentsOf(db, 'APP-1');
    db.prepare('UPDATE diff_comments SET sent_at = ? WHERE id = ?').run('2026-10-15T09:00:00.000Z', first!.id);

    expect(editComment(db, 'APP-1', String(first!.id), { text: 'Something else.' })).toEqual({
      status: 409,
      body: { ok: false, reason: 'That comment was sent back already, so it keeps the text Implement got. Write a new comment instead.' },
    });
    expect(commentsOf(db, 'APP-1')[0]?.text).toBe('Use the placeholder from assets, not a grey box.');
  });

  it("refuses to edit or delete another card's comment, and an id that is no number", async () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Fix the footer' });
    await addComment(db, 'APP-1', on(5), env);
    const [first] = commentsOf(db, 'APP-1');
    const id = String(first!.id);

    expect(editComment(db, 'APP-2', id, { text: 'mine now' })).toEqual({ status: 404, body: { ok: false, reason: `APP-2 has no comment ${id}. Read the page again.` } });
    expect(deleteComment(db, 'APP-2', id).status).toBe(404);
    expect(deleteComment(db, 'APP-1', '1 OR 1=1').status).toBe(404);
    expect(commentsOf(db, 'APP-1')).toHaveLength(1);
  });

  it('refuses a file the card does not touch', async () => {
    expect(await addComment(db, 'APP-1', on(1, { file: 'README.md', lineText: 'Recipes' }), env)).toEqual({
      status: 422,
      body: { ok: false, reason: 'APP-1 does not change README.md, so it takes no comment.' },
    });
    expect(await addComment(db, 'APP-1', on(1, { file: '../outside.txt' }), env)).toMatchObject({ status: 422 });
    expect(commentsOf(db, 'APP-1')).toEqual([]);
  });

  it('refuses a file the card deletes, which has no line in the folder', async () => {
    expect(await addComment(db, 'APP-1', on(1, { file: 'src/old.ts', lineText: 'export const old = 1;' }), env)).toEqual({
      status: 422,
      body: { ok: false, reason: 'APP-1 deletes src/old.ts, so it has no line to comment on.' },
    });
  });

  it('refuses a repository the card does not work in', async () => {
    expect(await addComment(db, 'APP-1', on(5, { repo: 'api' }), env)).toEqual({
      status: 422,
      body: { ok: false, reason: 'APP-1 has no repository named "api".' },
    });
  });

  it('refuses a comment with no text, one over the limit, and a line that is no line', async () => {
    expect((await addComment(db, 'APP-1', on(5, { text: '  ' }), env)).body).toEqual({ ok: false, reason: 'A comment needs a text. Write what should change on this line.' });
    expect((await addComment(db, 'APP-1', on(5, { text: 'x'.repeat(COMMENT_LIMIT + 1) }), env)).status).toBe(400);
    for (const line of [0, -2, 1.5, '5']) expect((await addComment(db, 'APP-1', on(5, { line }), env)).status).toBe(400);
    expect((await addComment(db, 'APP-1', null, env)).status).toBe(400);
    expect(commentsOf(db, 'APP-1')).toEqual([]);
  });
});

// A second card with its own checkout: the comment is checked against the checkout of the card in the
// address and saved under that card, not under APP-1, which most tests use alone.
describe('a second card', () => {
  beforeEach(() => {
    git(project, 'worktree', 'add', '-q', '-b', 'APP-2-readme', join(project, 'worktrees', 'APP-2'));
    write(join(project, 'worktrees', 'APP-2', 'README.md'), 'Recipes, better\n');
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'implement', title: 'Fix the readme' });
  });

  it('checks a comment against its own card checkout and saves it under that card', async () => {
    const said = await addComment(db, 'APP-2', { file: 'README.md', line: 1, lineText: 'Recipes, better', text: 'Say what it is.' }, env);
    expect(said.status).toBe(201);
    expect(commentsOf(db, 'APP-2').map((one) => one.file)).toEqual(['README.md']);
    expect(commentsOf(db, 'APP-1')).toEqual([]);
    // APP-1 changes the recipe card and APP-2 does not.
    expect((await addComment(db, 'APP-2', on(5), env)).status).toBe(422);
    expect(commentsOf(db, 'APP-2')).toHaveLength(1);
  });
});

describe('a workspace of two repositories', () => {
  beforeEach(() => {
    const api = join(project, 'api');
    mkdirSync(api);
    git(api, 'init', '-q', '-b', 'main');
    write(join(api, 'server.ts'), 'serve();\n');
    git(api, 'add', '-A');
    git(api, 'commit', '-q', '-m', 'first');
    write(join(project, '.gitignore'), 'api/\n');
    writeSetting(db, 'repos', [{ path: '.', base: null }, { path: 'api', base: null }]);
    setCardRepos(db, 'APP-1', ['.'], 'person');
  });

  // The card works in the root only, so api is a repository of the workspace it does not touch.
  it('refuses a comment on a repository of the workspace the card does not work in', async () => {
    expect(await addComment(db, 'APP-1', { repo: 'api', file: 'server.ts', line: 1, lineText: 'serve();', text: 'Log the port.' }, env)).toEqual({
      status: 422,
      body: { ok: false, reason: 'APP-1 has no repository named "api".' },
    });
    expect((await addComment(db, 'APP-1', on(5), env)).status).toBe(201);
  });
});

describe('the comment routes', () => {
  const routes = async () => {
    vi.doMock('./db.ts', () => ({ database: () => db }));
    for (const [name, value] of Object.entries(env)) if (name.startsWith('GIT_')) vi.stubEnv(name, value);
    const list = await import('../routes/api/card/[key]/comments/+server.ts');
    const one = await import('../routes/api/card/[key]/comments/[id]/+server.ts');
    return {
      post: list.POST as unknown as (event: unknown) => Promise<Response>,
      patch: one.PATCH as unknown as (event: unknown) => Promise<Response>,
      remove: one.DELETE as unknown as (event: unknown) => Promise<Response>,
    };
  };
  const request = (method: string, body?: unknown) =>
    new Request('http://localhost/api', { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  const answer = async (response: Response) => ({ status: response.status, body: await response.json() });

  afterEach(() => vi.unstubAllEnvs());

  it('adds, edits and deletes a comment for the card the address names', async () => {
    const { post, patch, remove } = await routes();

    const added = await answer(await post({ params: { key: 'APP-1' }, request: request('POST', on(5)) }));
    expect(added).toMatchObject({ status: 201, body: { ok: true, comment: { line: 5, repo: '.' } } });
    const id = String(added.body.comment.id);

    expect(await answer(await patch({ params: { key: 'APP-1', id }, request: request('PATCH', { text: 'Use recipe-placeholder.svg.' }) }))).toMatchObject({
      status: 200,
      body: { ok: true, comment: { text: 'Use recipe-placeholder.svg.' } },
    });
    expect(await answer(await remove({ params: { key: 'APP-1', id }, request: request('DELETE') }))).toEqual({ status: 200, body: { ok: true } });
    expect(commentsOf(db, 'APP-1')).toEqual([]);
  });

  it('refuses a file or a repository the card does not touch, and a body that is no JSON', async () => {
    const { post } = await routes();

    expect(await answer(await post({ params: { key: 'APP-1' }, request: request('POST', on(1, { file: 'README.md' })) }))).toEqual({
      status: 422,
      body: { ok: false, reason: 'APP-1 does not change README.md, so it takes no comment.' },
    });
    expect(await answer(await post({ params: { key: 'APP-1' }, request: request('POST', on(5, { repo: '../x' })) }))).toEqual({
      status: 422,
      body: { ok: false, reason: 'APP-1 has no repository named "../x".' },
    });
    expect((await post({ params: { key: 'APP-1' }, request: request('POST', '{not json') })).status).toBe(400);
    expect(commentsOf(db, 'APP-1')).toEqual([]);
  });
});

// The comment is made, then an edit in the folder moves its line or rewrites it. Read back the way the
// page reads it: the comments from the table, the file's diff from git, and the placement over both.
describe('a comment after the folder changed', () => {
  const placed = async () => {
    const patch = await patchFor(db, 'APP-1', { path: 'src/RecipeCard.svelte', oldPath: null, group: 'branch' }, env);
    if (!patch.ok) throw new Error(patch.reason);
    const lines = numberedLines(patch.text);
    const where = placeComments(lines, commentsOf(db, 'APP-1'));
    return { at: [...where.at.keys()].map((index) => lines[index]?.new), outdated: where.outdated.map((one) => one.lineText) };
  };

  it('shows a comment at its new line when an edit above moved it', async () => {
    await addComment(db, 'APP-1', on(5), env);
    write(join(card(), 'src/RecipeCard.svelte'), `<script>\n  import Placeholder from './Placeholder.svelte';\n</script>\n${RECIPE.join('\n')}\n`);

    expect(await placed()).toEqual({ at: [8], outdated: [] });
  });

  it('shows a comment whose line is gone as outdated, with the line it was made on, and keeps it', async () => {
    await addComment(db, 'APP-1', on(5), env);
    write(join(card(), 'src/RecipeCard.svelte'), `${RECIPE.join('\n').replace('<div class="img-missing"></div>', '<Placeholder />')}\n`);

    expect(await placed()).toEqual({ at: [], outdated: ['    <div class="img-missing"></div>'] });
    expect(commentsOf(db, 'APP-1')).toHaveLength(1);
  });
});

// A comment not sent yet locks nothing. The person may fix the line by hand and
// commit, and the comment stays open for the next send back.
describe('a comment not sent yet', () => {
  it('refuses no commit, and stays open after it', async () => {
    await addComment(db, 'APP-1', on(5), env);

    const done = await commitFor(db, 'APP-1', 'fix: show the placeholder', ['src/placeholder.svg'], env);

    expect(done).toMatchObject({ ok: true });
    expect(git(card(), 'log', '-1', '--format=%s')).toBe('fix: show the placeholder');
    expect(commentsOf(db, 'APP-1')).toEqual([expect.objectContaining({ line: 5, sentAt: null })]);
  });

  // What Send back reads for the message: the line in the card's checkout, found by its text.
  it('is found at its line in the checkout, and after an edit moved it', () => {
    const placed = { file: 'src/RecipeCard.svelte', line: 5, lineText: RECIPE[4] ?? '' };
    expect(lineNow(card(), placed)).toBe(5);
    write(join(card(), 'src/RecipeCard.svelte'), `<script>\n</script>\n${RECIPE.join('\n')}\n`);
    expect(lineNow(card(), placed)).toBe(7);
  });
});
