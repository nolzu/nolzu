import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  allKnowledgeChanges,
  type KnowledgeChangeRow,
  type KnowledgeStatus,
  openDatabase,
  recordKnowledgeChanges,
  revertKnowledgeChange,
  startRun,
  writeSetting,
} from '@nolzu/core/node';
import { KB_MAINTENANCE_KEY } from '@nolzu/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerRevert, revertable, revertKnowledge } from './knowledge-revert.ts';

// Revert, the one click on the Knowledge screen. The pure part is which row can be reverted at all.
// The rest is proved against a real repository, because the effect is what the knowledge file says
// afterwards.
const row = (over: Partial<KnowledgeChangeRow> = {}): KnowledgeChangeRow => ({
  id: 1,
  cardKey: 'APP-1',
  runId: 7,
  filePath: '.nolzu/knowledge/stack.md',
  commitSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  summary: 'corrected',
  status: 'applied',
  note: null,
  movedFrom: null,
  ...over,
});

const no = (one: KnowledgeChangeRow | null, id = 1): string => {
  const said = revertable(one, id);
  return said.ok ? '' : said.message;
};

describe('which change can be reverted', () => {
  it('lets an applied change through, with the commit it was applied as', () => {
    expect(revertable(row(), 1)).toEqual({ ok: true, row: row() });
  });

  it('refuses a change that was reverted already, naming the commit that is gone from the files', () => {
    expect(no(row({ status: 'reverted' }))).toBe(
      'The change to .nolzu/knowledge/stack.md was reverted already. Commit a1b2c3d is not in the knowledge files any more.',
    );
  });

  it('refuses a change that waits for review, because it was never applied', () => {
    expect(no(row({ status: 'pending', commitSha: null }))).toContain('waits for review, so it was never applied');
  });

  it('refuses a change that was returned, because it was never applied', () => {
    expect(no(row({ status: 'returned', commitSha: null }))).toContain('was returned, so it was never applied');
  });

  // The commit is in the repository that moved into the workspace, not in the folder in use.
  it('refuses a change made in a knowledge folder the project no longer uses, naming that folder', () => {
    expect(no(row({ movedFrom: '/work/recipes/app/.nolzu/knowledge' }))).toBe(
      'The change to .nolzu/knowledge/stack.md was committed in /work/recipes/app/.nolzu/knowledge, before this project became a workspace. Commit a1b2c3d is not in the knowledge folder in use now, so Nolzu cannot revert it here. Revert it in that folder with git revert.',
    );
  });

  it('refuses a change that is not there, naming what was asked for', () => {
    expect(no(null, 42)).toBe('There is no knowledge change 42.');
  });

  // A post nobody wrote by hand always names a change. This is the other kind, and a sentence about
  // change NaN would say nothing to whoever reads it.
  it('answers a form that names no change', () => {
    expect(no(row(), Number.NaN)).toBe('That form named no change, so there was nothing to revert.');
  });
});

describe('revert in a real repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-revert-data-'));
  const project = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-revert-repo-'));
  const folder = join(project, '.nolzu', 'knowledge');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'dev',
    GIT_AUTHOR_EMAIL: 'dev@example.com',
    GIT_COMMITTER_NAME: 'dev',
    GIT_COMMITTER_EMAIL: 'dev@example.com',
  } as Record<string, string>;
  const cli = (...args: string[]) => execFileSync('git', args, { cwd: project, env, encoding: 'utf8' }).trim();
  const read = (name: string) => readFileSync(join(folder, name), 'utf8');
  const free = { snapshot: () => ({ lanes: [{ name: 'knowledge' as const, heldBy: null }] }) };
  const post = (changeId: number): FormData => {
    const form = new FormData();
    form.append('change', String(changeId));
    return form;
  };

  let db: DatabaseSync;

  // One knowledge commit, with the row a wrap-up run would have written for it.
  const taught = (name: string, text: string, status: KnowledgeStatus = 'applied'): number => {
    writeFileSync(join(folder, name), text);
    cli('add', '--', `.nolzu/knowledge/${name}`);
    cli('commit', '-q', '-m', `knowledge: APP-1 run ${name}`);
    const runId = startRun(db, { cardKey: 'APP-1', phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
    recordKnowledgeChanges(db, {
      cardKey: 'APP-1',
      runId,
      commitSha: cli('rev-parse', 'HEAD'),
      status,
      files: [{ path: `.nolzu/knowledge/${name}`, summary: 'corrected' }],
    });
    return allKnowledgeChanges(db).at(-1)?.id ?? 0;
  };

  const of = (id: number) => allKnowledgeChanges(db).find((one) => one.id === id);
  const statusOf = (id: number) => of(id)?.status;

  beforeAll(() => {
    db = openDatabase(dir);
    writeSetting(db, 'projectPath', project);
    mkdirSync(folder, { recursive: true });
    cli('init', '-q', '-b', 'main');
    // In the repository itself, not only in the environment above, because `answerRevert` commits
    // with the person's own git configuration. A machine with none, which is every CI runner,
    // refuses the commit, and this test read as a revert that did not work.
    cli('config', 'user.name', 'dev');
    cli('config', 'user.email', 'dev@example.com');
    writeFileSync(join(folder, 'stack.md'), 'The stack is TypeScript.\n');
    cli('add', '-A');
    cli('commit', '-q', '-m', 'a knowledge file that was already there');
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('puts the file back to what it was and marks the change reverted', async () => {
    const id = taught('stack.md', 'The stack is TypeScript, and we deploy on Friday.\n');

    const answer = await answerRevert(db, free, post(id));

    expect(answer.ok).toBe(true);
    expect(read('stack.md')).toBe('The stack is TypeScript.\n');
    expect(statusOf(id)).toBe('reverted');
    expect(cli('status', '--porcelain', '-uall')).toBe('');
    expect(cli('log', '-1', '--pretty=%s')).toBe(`knowledge revert: .nolzu/knowledge/stack.md from APP-1 run ${of(id)?.runId}`);
  });

  it('refuses a second revert of the same change, and names the commit', async () => {
    const id = taught('importer.md', 'The importer skips a row it cannot parse.\n');
    const sha = of(id)?.commitSha ?? '';
    await revertKnowledge(db, { changeId: id, env });

    const again = await revertKnowledge(db, { changeId: id, env });

    expect(again.ok).toBe(false);
    expect(again.message).toContain(sha.slice(0, 7));
    expect(again.message).toContain('reverted already');
    expect(existsSync(join(folder, 'importer.md'))).toBe(false);
  });

  // Somebody rewrote the history of their own repository. The row still names a commit that is
  // gone, and the person reads which one.
  it('refuses a revert whose commit is gone from the repository, and names it', async () => {
    const gone = 'c'.repeat(40);
    const runId = startRun(db, { cardKey: 'APP-2', phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
    recordKnowledgeChanges(db, { cardKey: 'APP-2', runId, commitSha: gone, status: 'applied', files: [{ path: '.nolzu/knowledge/stack.md', summary: null }] });
    const id = allKnowledgeChanges(db).at(-1)?.id ?? 0;

    const answer = await revertKnowledge(db, { changeId: id, env });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain(`no commit ${gone.slice(0, 7)}`);
    // The row is untouched, so the screen still says what happened to that change.
    expect(statusOf(id)).toBe('applied');
  });

  // The file moved on after that commit. Taking the commit back on its own would drop the later
  // work, so the folder is left as it is.
  it('leaves the folder alone when the file carries an edit nobody committed', async () => {
    const id = taught('search.md', 'Run the list first.\n');
    writeFileSync(join(folder, 'search.md'), 'Run the list first, then the detail.\n');

    const answer = await revertKnowledge(db, { changeId: id, env });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('carries an edit nobody committed');
    expect(read('search.md')).toBe('Run the list first, then the detail.\n');
    expect(statusOf(id)).toBe('applied');
    cli('checkout', '--', '.nolzu/knowledge/search.md');
  });

  // Two tabs, or a click nobody waited for. The row moved while git was working, so the revert
  // commit goes back and the folder reads as it did before the click.
  it('takes the revert commit back when the change was answered in between', async () => {
    const id = taught('deploy.md', 'Deploy on Friday.\n');
    const head = cli('rev-parse', 'HEAD');
    const going = revertKnowledge(db, { changeId: id, env });
    revertKnowledgeChange(db, id);

    const answer = await going;

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('answered while this revert was being made');
    expect(read('deploy.md')).toBe('Deploy on Friday.\n');
    expect(cli('rev-parse', 'HEAD')).toBe(head);
    expect(cli('status', '--porcelain', '-uall')).toBe('');
  });

  // A maintenance run belongs to no card, and its reserved key is never shown to a person.
  it('names a maintenance run in words while it holds the knowledge lane', async () => {
    const id = taught('optimize.md', 'The notes are sorted by area.\n');
    const busy = { snapshot: () => ({ lanes: [{ name: 'knowledge' as const, heldBy: KB_MAINTENANCE_KEY }] }) };

    const answer = await answerRevert(db, busy, post(id));

    expect(answer.ok).toBe(false);
    expect(answer.message).toBe('A maintenance run is writing the knowledge folder right now. Revert .nolzu/knowledge/optimize.md once that run has ended.');
    expect(answer.message).not.toContain(KB_MAINTENANCE_KEY);
    expect(statusOf(id)).toBe('applied');
  });

  // The rule AGENTS names: busy state comes from the board snapshot and from nowhere else. A commit
  // in a folder a run is writing would fight that run over the index.
  it('refuses a revert while the board snapshot says a card holds the knowledge lane', async () => {
    const id = taught('testing.md', 'The suite runs on Node 24.\n');
    const busy = { snapshot: () => ({ lanes: [{ name: 'knowledge' as const, heldBy: 'APP-2' }] }) };

    const answer = await answerRevert(db, busy, post(id));

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('APP-2');
    expect(statusOf(id)).toBe('applied');
    expect(read('testing.md')).toBe('The suite runs on Node 24.\n');
  });
});

// No project at all, so there is no folder to be relative to and none to name in the sentence.
it('refuses a revert when no project folder is set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-revert-none-'));
  const db = openDatabase(dir);
  const runId = startRun(db, { cardKey: 'APP-1', phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
  recordKnowledgeChanges(db, { cardKey: 'APP-1', runId, commitSha: 'd'.repeat(40), status: 'applied', files: [{ path: 'stack.md', summary: null }] });

  const answer = await revertKnowledge(db, { changeId: allKnowledgeChanges(db).at(-1)?.id ?? 0 });

  expect(answer.ok).toBe(false);
  expect(answer.message).toBe('There is no knowledge folder to commit in. Make a project on New project at /new.');
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The other side of the folder check: a project that is set and a folder that is not there.
it('refuses a revert when there is no knowledge folder to commit in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-revert-empty-'));
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', join(dir, 'recipes'));
  const runId = startRun(db, { cardKey: 'APP-1', phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
  recordKnowledgeChanges(db, { cardKey: 'APP-1', runId, commitSha: 'd'.repeat(40), status: 'applied', files: [{ path: 'stack.md', summary: null }] });

  const answer = await revertKnowledge(db, { changeId: allKnowledgeChanges(db).at(-1)?.id ?? 0 });

  expect(answer.ok).toBe(false);
  expect(answer.message).toContain('Make a project on New project at /new.');
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});
