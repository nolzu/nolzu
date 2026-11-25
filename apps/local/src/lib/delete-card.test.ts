import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { deletedKey, linkCards, openDatabase, writeSetting } from '@nolzu/core/node';
import { ensureWorktree } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeleteCheck } from './delete-card.ts';
import { deleteCard, deleteCheck } from './delete-card.ts';
import type { Loop } from './loop.ts';

// The app this process holds is private to stack-action.ts, so the test says which keys it holds.
// `late` holds a key from its second ask on, as a press that began while git was read.
const held = vi.hoisted(() => new Set<string>());
const late = vi.hoisted(() => ({ key: '', asked: 0 }));
vi.mock('./stack-action.ts', () => ({ appHeld: (key: string) => held.has(key) || (key === late.key && ++late.asked > 1) }));

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const env = Object.fromEntries(Object.entries(ENV).filter((entry): entry is [string, string] => entry[1] !== undefined));
const git = (at: string, ...args: string[]) => execFileSync('git', args, { cwd: at, env: ENV, encoding: 'utf8' }).trim();

let dir = '';
let project = '';
let db: DatabaseSync;
let told = 0;
let queue: { running: { cardKey: string }[]; waiting: { cardKey: string }[] } = { running: [], waiting: [] };
const live = () => ({ db, scheduler: { queue: () => queue }, changed: () => (told += 1) }) as unknown as Pick<Loop, 'db' | 'scheduler' | 'changed'>;

const card = (key: string, over: { board?: string; state?: string; source?: string; ref?: string; stack?: string; branch?: string | null } = {}): void => {
  db.prepare("INSERT INTO cards (key, board, stage, state, title, source, source_ref, branch, stack_state) VALUES (?, ?, 'implement', ?, 'Add a search box', ?, ?, ?, ?)").run(
    key,
    over.board ?? 'delivery',
    over.state ?? 'idle',
    over.source ?? 'local',
    over.ref ?? null,
    over.branch === undefined ? `${key}-work` : over.branch,
    over.stack ?? null,
  );
};

const checkout = async (key = 'APP-1'): Promise<string> => (await ensureWorktree({ projectPath: project, key, branch: `${key}-work`, baseBranch: 'main', repo: '.', env })).path;
const commitIn = (at: string, name: string): void => {
  writeFileSync(join(at, name), `${name}\n`);
  git(at, 'add', '-A');
  git(at, 'commit', '-q', '-m', name);
};
const check = async (key = 'APP-1') => (await (await deleteCheck(live(), key, ENV)).json()) as DeleteCheck;
// Sends what a fresh confirm showed, as the dialog does, unless the body names its own.
const remove = async (key = 'APP-1', body: Record<string, unknown> = {}) => {
  const seen = 'seen' in body ? body.seen : ((await check(key)).seen ?? []);
  const answer = await deleteCard(live(), key, { ...body, seen }, ENV);
  return { status: answer.status, body: (await answer.json()) as { ok?: true; said?: string; stays?: string[]; failed?: string[]; message?: string } };
};
const texts = (shown: DeleteCheck) => shown.warnings.map((one) => one.text);
const branches = () => git(project, 'branch', '--format=%(refname:short)').split('\n');
const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-delete-')));
  project = join(dir, 'recipes');
  mkdirSync(project);
  git(project, 'init', '-q', '-b', 'main');
  writeFileSync(join(project, 'README.md'), 'recipes\n');
  writeFileSync(join(project, '.gitignore'), '.tasks/\n.worktrees/\n.env\nnode_modules/\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'first');
  git(dir, 'init', '-q', '--bare', join(dir, 'remote.git'));
  git(project, 'remote', 'add', 'origin', join(dir, 'remote.git'));
  db = openDatabase(dir);
  writeSetting(db, 'projectPath', project);
  writeSetting(db, 'baseBranch', 'main');
  told = 0;
  queue = { running: [], waiting: [] };
  held.clear();
  late.key = '';
  late.asked = 0;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('refusing', () => {
  it('refuses while the card runs or waits in the queue, and deletes nothing', async () => {
    card('APP-1', { state: 'running' });
    expect((await check()).refused).toBe('APP-1 has a run going. Stop the run first, then delete the card.');
    expect(await remove('APP-1', { seen: [] })).toEqual({ status: 409, body: { message: 'APP-1 has a run going. Stop the run first, then delete the card.' } });

    db.prepare("UPDATE cards SET state = 'idle' WHERE key = 'APP-1'").run();
    queue = { running: [], waiting: [{ cardKey: 'APP-1' }] };
    expect((await remove()).status).toBe(409);
    queue = { running: [], waiting: [] };
    // An Ask run holds no queue place and leaves the card's state alone, so its row is read too.
    db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-1', 'ask', 'claude', 'running')").run();
    expect((await remove()).body.message).toBe('APP-1 has a run going. Stop the run first, then delete the card.');
    expect(count('SELECT count(*) AS n FROM cards')).toBe(1);
    expect(told).toBe(0);
  });

  it('answers 404 for a card that is not there', async () => {
    expect((await remove('APP-9', { seen: [] })).status).toBe(404);
    expect((await deleteCheck(live(), 'APP-9', ENV)).status).toBe(404);
  });
});

describe('the app', () => {
  it('refuses while this process holds the app or presses it, and deletes nothing', async () => {
    card('APP-1', { stack: 'up' });
    held.add('APP-1');
    expect((await check()).refused).toBe('APP-1 has its app started. Stop the app first, then delete the card.');
    expect((await remove('APP-1', { seen: [] })).status).toBe(409);
    expect(count('SELECT count(*) AS n FROM cards')).toBe(1);
  });

  it('refuses when a press of the app began while git was read', async () => {
    card('APP-1');
    late.key = 'APP-1';
    expect(await remove('APP-1', { seen: [] })).toEqual({ status: 409, body: { message: 'APP-1 has its app started. Stop the app first, then delete the card.' } });
    expect(count('SELECT count(*) AS n FROM cards')).toBe(1);
  });

  // The state outlives a restart, and often nothing resets it: QA failed before it started anything, a
  // start with no Stop command, a crash in the middle of a press. Such a card can still be deleted.
  it.each(['up', 'loading', 'unloading', 'failed'])('deletes a card whose app state is %s with nothing held, and warns', async (stack) => {
    card('APP-1', { stack });
    const shown = await check();
    expect(shown.refused).toBeNull();
    expect(shown.warnings[0]).toEqual({ text: 'Its app may still be running from an earlier start. Nolzu holds no process for it, so stop it yourself if it is.', loses: true });
    expect((await remove()).status).toBe(200);
    expect(count('SELECT count(*) AS n FROM cards')).toBe(0);
  });

  it('says nothing about an app that is off', async () => {
    card('APP-1', { stack: 'off' });
    expect((await check()).warnings).toEqual([]);
  });
});

describe('the checkout and the branch', () => {
  it('warns about changed files, removes the checkout, and keeps a branch with commits not pushed', async () => {
    card('APP-1');
    const at = await checkout();
    commitIn(at, 'search.ts');
    writeFileSync(join(at, 'draft.ts'), 'draft\n');
    writeFileSync(join(at, 'README.md'), 'changed\n');

    expect(texts(await check())).toEqual([
      'The checkout of the project folder is removed. It has 2 changed files and 1 commit not pushed. The changed files are lost.',
      'The branch APP-1-work stays, so its commits are not lost.',
    ]);
    const done = await remove();

    expect(done.status).toBe(200);
    expect(done.body.said).toBe('Deleted APP-1.');
    expect(done.body.stays).toEqual(['The branch APP-1-work stays, so its commits are not lost.', 'A card added later on this key picks up its branch.']);
    expect(done.body.failed).toEqual([]);
    expect(existsSync(at)).toBe(false);
    expect(branches()).toContain('APP-1-work');
    expect(told).toBe(1);
  });

  // A remote branch is what this clone last fetched, and it may be gone, so only a merge counts.
  it('keeps a branch whose commits are pushed but not merged, and says why', async () => {
    card('APP-1');
    const at = await checkout();
    commitIn(at, 'search.ts');
    git(at, 'push', '-q', '-u', 'origin', 'APP-1-work');

    expect(texts(await check())).toEqual([
      'The checkout of the project folder is removed. git shows nothing in it that is not committed.',
      'The branch APP-1-work stays. Its commits are on the remote as this clone last fetched it, but not in main.',
    ]);
    await remove();
    expect(existsSync(at)).toBe(false);
    expect(branches()).toContain('APP-1-work');
  });

  it('names the files git ignores that go with the checkout, and leaves out dependency folders', async () => {
    card('APP-1');
    const at = await checkout();
    mkdirSync(join(at, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(at, 'node_modules', 'left-pad', 'index.js'), 'x\n');
    expect(texts(await check())[0]).toBe('The checkout of the project folder is removed. git shows nothing in it that is not committed, leaving out build folders such as node_modules/.');

    writeFileSync(join(at, '.env'), 'TOKEN=x\n');
    const shown = await check();
    expect(texts(shown)[0]).toBe('The checkout of the project folder is removed. Files git ignores go with it: .env.');
    expect(shown.warnings[0]?.loses).toBe(true);
    expect(shown.seen).toEqual([{ repo: '.', changed: 0, unpushed: 0, ignored: 1 }]);
  });

  it('refuses a checkout on no branch whose commits nothing else holds, and deletes nothing', async () => {
    card('APP-1');
    const at = await checkout();
    git(at, 'switch', '-q', '--detach');
    commitIn(at, 'search.ts');

    const said = 'The checkout of the project folder is on no branch, and 1 commit is held by nothing else. Put them on a branch first, with git switch -c inside the checkout, then delete the card.';
    expect((await check()).refused).toBe(said);
    expect(await remove()).toEqual({ status: 409, body: { message: said } });
    expect(count('SELECT count(*) AS n FROM cards')).toBe(1);
    expect(existsSync(at)).toBe(true);
  });

  it('refuses a delete when the checkout holds more than the confirm showed', async () => {
    card('APP-1');
    const at = await checkout();
    const shown = (await check()).seen;
    expect(shown).toEqual([{ repo: '.', changed: 0, unpushed: 0, ignored: 0 }]);
    writeFileSync(join(at, 'late.ts'), 'late\n');

    expect(await remove('APP-1', { seen: shown })).toEqual({ status: 409, body: { message: 'The checkout changed since this confirm opened. Read what it holds now, then delete again.' } });
    expect(existsSync(join(at, 'late.ts'))).toBe(true);
    expect(count('SELECT count(*) AS n FROM cards')).toBe(1);
    expect((await remove('APP-1', {})).status).toBe(200);
  });

  it('names an ignored file with a space in its name as it is, never quoted', async () => {
    writeFileSync(join(project, '.gitignore'), '.tasks/\n.worktrees/\n*.local\n');
    git(project, 'commit', '-q', '-am', 'ignore local files');
    card('APP-1');
    const at = await checkout();
    writeFileSync(join(at, 'my notes.local'), 'x\n');
    expect(texts(await check())[0]).toBe('The checkout of the project folder is removed. Files git ignores go with it: my notes.local.');
  });

  // A workspace card's root checkout holds the other repositories' checkouts, which the root ignores.
  it('leaves the other repositories out of the ignored files of a workspace root', async () => {
    writeFileSync(join(project, '.gitignore'), '.tasks/\n.worktrees/\napi/\n');
    git(project, 'commit', '-q', '-am', 'ignore api');
    mkdirSync(join(project, 'api'));
    git(join(project, 'api'), 'init', '-q', '-b', 'main');
    writeFileSync(join(project, 'api', 'README.md'), 'api\n');
    git(join(project, 'api'), 'add', '-A');
    git(join(project, 'api'), 'commit', '-q', '-m', 'first');
    writeSetting(db, 'repos', [
      { path: '.', base: null },
      { path: 'api', base: null },
    ]);
    card('APP-1');
    await checkout();
    await ensureWorktree({ projectPath: project, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'main', repo: 'api', env });

    const lines = texts(await check()).filter((line) => line.startsWith('The checkout'));
    expect(lines).toEqual(['The checkout of the project folder is removed. git shows nothing in it that is not committed.', 'The checkout of api is removed. git shows nothing in it that is not committed.']);
  });

  it('refuses a delete when an ignored file or a whole checkout came after the confirm', async () => {
    card('APP-1');
    const at = await checkout();
    const shown = (await check()).seen;
    writeFileSync(join(at, '.env'), 'TOKEN=x\n');
    expect((await remove('APP-1', { seen: shown })).status).toBe(409);
    // A confirm that opened before the checkout was made showed none.
    expect((await remove('APP-1', { seen: [] })).status).toBe(409);
    expect(existsSync(at)).toBe(true);
  });

  // A checkout a person switched to the base must never take the base down with it, and only the
  // card's own branch is ever deleted.
  it('never deletes the base when the checkout was switched to it, and deletes the card branch instead', async () => {
    git(project, 'branch', 'develop');
    writeSetting(db, 'baseBranch', 'develop');
    card('APP-1');
    const at = (await ensureWorktree({ projectPath: project, key: 'APP-1', branch: 'APP-1-work', baseBranch: 'develop', repo: '.', env })).path;
    git(at, 'switch', '-q', 'develop');

    expect(texts(await check())).toEqual(['The checkout of the project folder is removed. git shows nothing in it that is not committed.', 'The branch APP-1-work is deleted, since it is merged into develop.']);
    await remove();
    expect(branches()).toEqual(['develop', 'main']);
  });

  it('leaves a branch of the person alone when the checkout was switched to it', async () => {
    card('APP-1');
    const at = await checkout();
    git(at, 'switch', '-q', '-c', 'mine');
    commitIn(at, 'mine.ts');
    git(at, 'switch', '-q', 'APP-1-work');
    git(at, 'switch', '-q', 'mine');

    await remove();
    expect(branches()).toContain('mine');
    expect(branches()).not.toContain('APP-1-work');
  });

  it('refuses a delete that sends no seen', async () => {
    card('APP-1');
    expect((await deleteCard(live(), 'APP-1', {}, ENV)).status).toBe(400);
  });

  it('still reads the card when the branch template is broken', async () => {
    card('APP-1', { branch: null });
    // The setting takes any template with {key} in it, and branchName refuses the unknown placeholder.
    writeSetting(db, 'branchTemplate', 'feature/{key}-{nope}');
    expect((await deleteCheck(live(), 'APP-1', ENV)).status).toBe(200);
    expect((await remove()).status).toBe(200);
  });

  it('deletes a merged branch whose checkout is already gone', async () => {
    card('APP-1');
    const at = await checkout();
    commitIn(at, 'search.ts');
    git(project, 'worktree', 'remove', at);
    git(project, 'merge', '-q', '--ff-only', 'APP-1-work');

    expect(texts(await check())).toEqual(['The branch APP-1-work is deleted, since it is merged into main.']);
    await remove();
    expect(branches()).toEqual(['main']);
  });
});

describe('the card folder', () => {
  const folder = () => join(project, '.tasks', 'APP-1');
  beforeEach(() => {
    card('APP-1');
    mkdirSync(folder(), { recursive: true });
    writeFileSync(join(folder(), 'notes.md'), 'notes\n');
  });

  it('keeps the card folder unless asked, and says so', async () => {
    expect((await check()).folder).toBe(join('.tasks', 'APP-1'));
    expect((await remove()).body.stays).toEqual([`The card folder ${join('.tasks', 'APP-1')} stays.`, 'A card added later on this key picks up this folder.']);
    expect(existsSync(folder())).toBe(true);
  });

  it('removes the card folder when asked', async () => {
    expect((await remove('APP-1', { folder: true })).body.stays).toEqual([]);
    expect(existsSync(folder())).toBe(false);
  });

  it('refuses a folder answer that is not true or false', async () => {
    expect((await remove('APP-1', { folder: 'yes' })).status).toBe(400);
    expect(count('SELECT count(*) AS n FROM cards')).toBe(1);
  });
});

describe('the database', () => {
  it('deletes the rows of the card and keeps its runs and time under the deleted key', async () => {
    card('APP-1');
    const log = join(dir, 'APP-1-plan-1.ndjson');
    writeFileSync(log, '{}\n');
    db.prepare("INSERT INTO runs (card_key, phase, engine, state, log_path, duration_ms) VALUES ('APP-1', 'plan', 'claude', 'done', ?, 60000)").run(log);
    db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who) VALUES ('APP-1', 'inbox', 'plan', 'you')").run();
    db.prepare("INSERT INTO messages (card_key, thread, author, body, at) VALUES ('APP-1', 'plan', 'person', 'why?', '2026-11-04T10:00:00Z')").run();
    db.prepare("INSERT INTO diff_comments (card_key, repo, file, line, line_text, body, commit_sha, created_at) VALUES ('APP-1', '.', 'a.ts', 1, 'x', 'fix', 'abc', '2026-11-04T10:00:00Z')").run();
    db.prepare("INSERT INTO notifications (id, at, kind, card_key, text) VALUES ('run:1', '2026-11-04T10:00:00Z', 'success', 'APP-1', 'Plan finished')").run();
    db.prepare("INSERT INTO notifications (id, at, kind, card_key, text) VALUES ('scout:1', '2026-11-04T10:00:00Z', 'info', NULL, 'Scout: 1 new finding')").run();
    db.prepare("INSERT INTO knowledge_changes (card_key, run_id, file_path, status) VALUES ('APP-1', 1, 'knowledge/a.md', 'applied')").run();
    db.prepare("INSERT INTO export_entries (destination, external_id, day, minutes, sent_at, updated_at) VALUES ('toggl', 'nolzu:1:APP-1:2026-11-04', '2026-11-04', 1, '2026-11-04', '2026-11-04')").run();

    await remove();

    for (const table of ['cards WHERE key', 'card_events WHERE card_key', 'messages WHERE card_key', 'diff_comments WHERE card_key', 'notifications WHERE card_key']) {
      expect(count(`SELECT count(*) AS n FROM ${table} = 'APP-1'`), table).toBe(0);
    }
    expect(count('SELECT count(*) AS n FROM notifications')).toBe(1);
    expect(db.prepare('SELECT card_key, log_path, duration_ms FROM runs').get()).toEqual({ card_key: deletedKey('APP-1'), log_path: null, duration_ms: 60000 });
    expect(count('SELECT count(*) AS n FROM knowledge_changes WHERE card_key = ?', deletedKey('APP-1'))).toBe(1);
    expect(db.prepare('SELECT external_id FROM export_entries').get()).toEqual({ external_id: `nolzu:1:${encodeURIComponent(deletedKey('APP-1'))}:2026-11-04` });
    expect(existsSync(log)).toBe(false);
  });

  it('names a removal that failed after the commit, and keeps it in the bell', async () => {
    card('APP-1');
    // A folder where the log file should be, so its removal fails after the rows are gone.
    const log = join(dir, 'held');
    mkdirSync(join(log, 'inner'), { recursive: true });
    db.prepare("INSERT INTO runs (card_key, phase, engine, state, log_path) VALUES ('APP-1', 'plan', 'claude', 'done', ?)").run(log);

    const done = await remove();

    expect(done.status).toBe(200);
    expect(done.body.failed).toHaveLength(1);
    expect(done.body.failed?.[0]).toContain(`The run log ${log} could not be removed.`);
    expect(db.prepare("SELECT kind, card_key, text FROM notifications WHERE id LIKE 'delete:APP-1:%'").get()).toMatchObject({ kind: 'error', card_key: null, text: expect.stringContaining('Deleted APP-1, but not everything went.') });
  });

  it('keeps the tasks of an epic as ordinary cards with no link', async () => {
    card('APP-1', { board: 'epics' });
    card('APP-2');
    card('APP-3');
    linkCards(db, 'APP-1', 'APP-2');
    linkCards(db, 'APP-1', 'APP-3');

    expect(texts(await check())).toEqual(["Its tasks APP-2 and APP-3 stay on the Delivery board as ordinary cards, with no epic, and stop reading the epic's documents."]);
    await remove();

    expect(db.prepare('SELECT key FROM cards ORDER BY key').all()).toEqual([{ key: 'APP-2' }, { key: 'APP-3' }]);
    expect(count('SELECT count(*) AS n FROM card_links')).toBe(0);
  });

  it('records a ticket card, and adding it again by hand takes the record off', async () => {
    card('PROJ-123', { source: 'jira', ref: 'PROJ-123' });
    expect(texts(await check('PROJ-123'))).toEqual(['PROJ-123 is deleted in Nolzu only, never in Jira. The next read of Jira does not bring it back.']);
    await remove('PROJ-123');
    expect(db.prepare('SELECT source_ref, source, card_key FROM deleted_tickets').all()).toEqual([{ source_ref: 'PROJ-123', source: 'jira', card_key: 'PROJ-123' }]);
  });
});
