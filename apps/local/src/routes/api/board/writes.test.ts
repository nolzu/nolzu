import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, readRun, writeSetting } from '@nolzu/core/node';
import { DEFAULT_PROFILE } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoop, type Loop } from '../../../lib/loop.ts';
import { overviewFor } from '../../../lib/overview.ts';
import { answer, minimize, move, promote, retry, stop, stopThenMove } from './writes.ts';

let dir = '';
let live: Loop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-writes-'));
  // Scale one, so a run takes long enough that a route answering before it ends is a real answer
  // and not a race the test happened to win.
  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '1' });
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, stage = 'inbox', state = 'idle') =>
  live.db.prepare('INSERT INTO cards (key, board, stage, state, title) VALUES (?, ?, ?, ?, ?)').run(key, 'delivery', stage, state, `${key} title`);

const post = (body: unknown) => new Request('http://localhost/api/board', { method: 'POST', body: JSON.stringify(body) });
const card = (key: string) => live.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get(key) as { stage: string; state: string };

it('answers the move as soon as the job is queued, not when the run ends', async () => {
  addCard('APP-1', 'inbox');

  const response = await move(live, post({ key: 'APP-1', to: 'refine' }));

  expect(response.status).toBe(200);
  // The engine is still going. A route that waited for the run would make the board follow the
  // click for as long as an agent takes.
  expect(live.scheduler.queue().running).toHaveLength(1);
  expect(readRun(live.db, 1)?.state).not.toBe('complete');
  expect(card('APP-1').stage).toBe('refine');
});

it('answers 409 with the reason a refused move gives, and no stack trace', async () => {
  addCard('APP-1', 'inbox');

  // Two stages forward is not a legal move. The message is core's, because it is the one that knows
  // the rule, and a person reads it on the board.
  const response = await move(live, post({ key: 'APP-1', to: 'plan' }));

  expect(response.status).toBe(409);
  const said = await response.json();
  expect(said.message).toMatch(/APP-1 cannot move/);
  expect(JSON.stringify(said)).not.toMatch(/at .*\.ts:\d+|Error:/);
});

it('refuses to move a card that is queued, in the words core uses', async () => {
  addCard('APP-1', 'refine', 'queued');

  // Both directions. The Move forward button sends the same request a drop does, so a card that
  // belongs to its run is refused here whatever the screen still showed.
  for (const to of ['plan', 'inbox']) {
    const response = await move(live, post({ key: 'APP-1', to }));

    expect(response.status).toBe(409);
    expect((await response.json()).message).toMatch(/while it is queued/);
  }
  expect(card('APP-1')).toEqual({ stage: 'refine', state: 'queued' });
});

it('answers 409 for a card that is not there', async () => {
  const response = await move(live, post({ key: 'APP-404', to: 'refine' }));

  expect(response.status).toBe(409);
  expect((await response.json()).message).toMatch(/APP-404/);
});

it('stops a running job, and the card can move again', async () => {
  addCard('APP-1', 'inbox');
  await move(live, post({ key: 'APP-1', to: 'refine' }));
  const runId = live.scheduler.queue().running[0]!.runId;

  const response = await stop(live, post({ runId }));

  expect(response.status).toBe(200);
  await vi.waitFor(() => {
    expect(readRun(live.db, runId)?.state).toBe('stopped');
  });
  // Stopping is not a failure, so the card goes back to idle and is movable again.
  expect(card('APP-1').state).toBe('idle');
});

it('is not an error to stop a job that already ended', async () => {
  addCard('APP-1', 'inbox');

  // Nothing with that id is running. A person pressing stop on a run that just finished has done
  // nothing wrong, and an error here would read as one.
  expect((await stop(live, post({ runId: 999 }))).status).toBe(200);
});

it('promotes a waiting job, and the queue shows it first', async () => {
  // One slot, written before the loop is built: the scheduler reads the count once, when it is
  // made, so a setting written afterwards sizes nothing and both jobs would simply run.
  live.close();
  const narrow = openDatabase(dir);
  writeSetting(narrow, 'agentSlots', 1);
  narrow.close();
  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '1' });
  addCard('APP-1', 'inbox');
  addCard('APP-2', 'inbox');
  addCard('APP-3', 'inbox');
  await move(live, post({ key: 'APP-1', to: 'refine' }));
  await move(live, post({ key: 'APP-2', to: 'refine' }));
  await move(live, post({ key: 'APP-3', to: 'refine' }));
  // Two waiting, so the one being promoted is not already first. Promoting the head is a no-op the
  // queue refuses by design, and a test that did that would pass whether or not the call happened.
  const waiting = live.scheduler.queue().waiting;
  expect(waiting.map((job) => job.cardKey)).toEqual(['APP-2', 'APP-3']);

  const response = await promote(live, post({ runId: waiting[1]!.runId }));

  expect(response.status).toBe(200);
  expect(live.scheduler.queue().waiting.map((job) => job.cardKey)).toEqual(['APP-3', 'APP-2']);
});

it('refuses a write that does not say what to act on', async () => {
  // A body with nothing in it is a caller mistake, not a refused move, so it reads 400 rather than
  // 409 and says which field is missing.
  expect((await move(live, post({}))).status).toBe(400);
  expect((await stop(live, post({}))).status).toBe(400);
  expect((await promote(live, post({}))).status).toBe(400);
  expect((await move(live, post({ key: 'APP-1' }))).status).toBe(400);
});

const oneSlot = () => {
  live.close();
  const narrow = openDatabase(dir);
  writeSetting(narrow, 'agentSlots', 1);
  narrow.close();
  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '1' });
};

it('stops a job that is still waiting, and the card can move again', async () => {
  oneSlot();
  addCard('APP-1', 'inbox');
  addCard('APP-2', 'inbox');
  addCard('APP-3', 'inbox');
  await move(live, post({ key: 'APP-1', to: 'refine' }));
  await move(live, post({ key: 'APP-2', to: 'refine' }));
  await move(live, post({ key: 'APP-3', to: 'refine' }));
  // Two waiting, and the one being stopped is the second. With only one in the queue, a stop that
  // simply took the first job it found would read as correct.
  const queued = live.scheduler.queue().waiting;
  expect(queued.map((job) => job.cardKey)).toEqual(['APP-2', 'APP-3']);
  const waiting = queued[1]!;

  expect((await stop(live, post({ runId: waiting.runId }))).status).toBe(200);

  // The one in front of it is untouched and still waiting for its slot.
  expect(live.scheduler.queue().waiting.map((job) => job.cardKey)).toEqual(['APP-2']);
  expect(card('APP-2').state).toBe('queued');

  // A waiting job never reaches the runner, so nothing else will ever close this row. Left queued,
  // the card refuses every drag in both directions and nothing will pick it up either.
  expect(readRun(live.db, waiting.runId)?.state).toBe('stopped');
  expect(card('APP-3').state).toBe('idle');
  expect((await move(live, post({ key: 'APP-3', to: 'inbox' }))).status).toBe(200);
});

it('stops the run it was given, and leaves the other one going', async () => {
  addCard('APP-1', 'inbox');
  addCard('APP-2', 'inbox');
  await move(live, post({ key: 'APP-1', to: 'refine' }));
  await move(live, post({ key: 'APP-2', to: 'refine' }));
  const running = live.scheduler.queue().running;
  expect(running).toHaveLength(2);
  const first = running.find((job) => job.cardKey === 'APP-1')!;

  await stop(live, post({ runId: first.runId }));

  // With one run in flight a route that stopped anything at all would read as correct.
  await vi.waitFor(() => {
    expect(readRun(live.db, first.runId)?.state).toBe('stopped');
  });
  expect(live.scheduler.queue().running.map((job) => job.cardKey)).toEqual(['APP-2']);
});

it('tells the board about a move that starts no run', async () => {
  addCard('APP-1', 'refine');
  let told = 0;
  live.onChange(() => {
    told += 1;
  });

  // Back to the inbox. Nothing is queued, so the scheduler is never touched, and the scheduler is
  // what tells the open boards.
  const response = await move(live, post({ key: 'APP-1', to: 'inbox' }));

  expect(response.status).toBe(200);
  expect(told).toBeGreaterThan(0);
});

// Accept anyway on a QA FAIL: the move on to Review carries one line of reason, and the trail and the
// closed card's record read it off the move.
describe('a move with a reason', () => {
  it('keeps the reason on the move, where the trail reads it', async () => {
    addCard('APP-1', 'qa', 'ready');

    const response = await move(live, post({ key: 'APP-1', to: 'review', reason: '  The empty list is fine\nuntil the api has a status page.  ' }));

    expect(response.status).toBe(200);
    expect(card('APP-1')).toEqual({ stage: 'review', state: 'idle' });
    expect(live.db.prepare('SELECT to_stage, reason FROM card_events WHERE card_key = ?').all('APP-1')).toEqual([
      { to_stage: 'review', reason: 'The empty list is fine until the api has a status page.' },
    ]);
    expect(overviewFor(live.db, 'APP-1')?.moves).toEqual([
      expect.objectContaining({ label: 'Review', from: 'qa', reason: 'The empty list is fine until the api has a status page.' }),
    ]);
  });

  it.each(['', '   ', 7])('refuses the reason %j with a sentence, and leaves the card in QA', async (reason) => {
    addCard('APP-1', 'qa', 'ready');

    const response = await move(live, post({ key: 'APP-1', to: 'review', reason }));

    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe('Write one line on why APP-1 goes on, for the trail. The reviewer reads it there.');
    expect(card('APP-1')).toEqual({ stage: 'qa', state: 'ready' });
  });

  it('takes a reason of 500 characters and refuses one longer, leaving the card in QA', async () => {
    addCard('APP-1', 'qa', 'ready');

    const long = await move(live, post({ key: 'APP-1', to: 'review', reason: 'a'.repeat(501) }));
    expect(long.status).toBe(400);
    expect((await long.json()).message).toBe('The reason is over 500 characters. One line is enough.');
    expect(card('APP-1')).toEqual({ stage: 'qa', state: 'ready' });

    expect((await move(live, post({ key: 'APP-1', to: 'review', reason: 'a'.repeat(500) }))).status).toBe(200);
    expect(card('APP-1')).toEqual({ stage: 'review', state: 'idle' });
  });

  it('keeps no reason on a move that sent none', async () => {
    addCard('APP-1', 'refine');

    await move(live, post({ key: 'APP-1', to: 'inbox' }));

    expect(live.db.prepare('SELECT reason FROM card_events').all()).toEqual([{ reason: null }]);
  });
});

// Nolzu merges nothing. The drag from review goes to PR watch and leaves the base branch as it was,
// and the person pushes from the Changes tab.
describe('a drag from review', () => {
  let project = '';

  // A project with one card in review on its own branch. The git identity comes from the
  // environment, because a CI runner has no git configuration.
  beforeEach(() => {
    for (const [name, value] of Object.entries({
      GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
      GIT_CONFIG_SYSTEM: join(dir, 'gitconfig'),
      GIT_AUTHOR_NAME: 'Demo',
      GIT_AUTHOR_EMAIL: 'demo@example.invalid',
      GIT_COMMITTER_NAME: 'Demo',
      GIT_COMMITTER_EMAIL: 'demo@example.invalid',
    })) {
      vi.stubEnv(name, value);
    }
    writeFileSync(join(dir, 'gitconfig'), '');
    project = join(dir, 'project');
    const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    mkdirSync(project, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main', project);
    writeFileSync(join(project, 'recipes.md'), 'soup\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'add the recipe list');
    writeFileSync(join(project, '.git', 'info', 'exclude'), '/worktrees/\n');

    writeSetting(live.db, 'projectPath', project);
    writeSetting(live.db, 'baseBranch', 'main');
    addCard('APP-1', 'review');
    const at = join(project, 'worktrees', 'APP-1');
    git(project, 'worktree', 'add', '-q', '-b', 'APP-1-work', at);
    writeFileSync(join(at, 'search.md'), 'find a recipe\n');
    git(at, 'add', '-A');
    git(at, 'commit', '-q', '-m', 'APP-1 adds the search page');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const main = () => execFileSync('git', ['rev-parse', 'main'], { cwd: project, encoding: 'utf8' }).trim();

  it('moves the card to pr watch and merges nothing', async () => {
    const before = main();

    const response = await move(live, post({ key: 'APP-1', to: 'pr-watch' }));

    expect(response.status).toBe(200);
    expect(card('APP-1')).toEqual({ stage: 'pr-watch', state: 'idle' });
    expect(main()).toBe(before);
  });

  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  const checkout = () => join(project, 'worktrees', 'APP-1');
  const said = async (to: string) => {
    const response = await move(live, post({ key: 'APP-1', to }));
    return { status: response.status, message: (await response.json()).message as string | undefined };
  };

  // Opening the pull request is the person's step, so a drag must not close a card whose work never
  // left its checkout.
  it('keeps a card with files not committed and no pull request in Review', async () => {
    writeFileSync(join(checkout(), 'search.md'), 'find a recipe fast\n');
    writeFileSync(join(checkout(), 'filter.md'), 'by cooking time\n');

    expect(await said('pr-watch')).toEqual({
      status: 409,
      message: 'APP-1 has 2 files not committed and no pull request, so it stays in Review. Commit them and push on its Changes tab first.',
    });
    expect(card('APP-1')).toEqual({ stage: 'review', state: 'idle' });

    // A linked pull request is the person's own call on what goes in it.
    live.db.prepare("INSERT INTO card_pulls (card_key, repo, number, found_by) VALUES ('APP-1', 'demo/recipes', 4, 'branch')").run();
    expect((await said('pr-watch')).status).toBe(200);
  });

  it('counts commits no remote has once the repository has one, and moves once they are pushed', async () => {
    git(dir, 'init', '-q', '--bare', join(dir, 'remote.git'));
    git(project, 'remote', 'add', 'origin', join(dir, 'remote.git'));
    git(project, 'push', '-q', 'origin', 'main');

    expect((await said('pr-watch')).message).toBe('APP-1 has 1 commit not pushed and no pull request, so it stays in Review. Commit them and push on its Changes tab first.');

    git(checkout(), 'push', '-q', 'origin', 'APP-1-work');
    expect((await said('pr-watch')).status).toBe(200);
  });

  // Nolzu merges nothing, but a person may merge the branch into the base by hand and never push it.
  // Its commits are then in the base, so nothing is left to send and the card goes on to Wrap-up.
  it('lets a card whose branch was merged into the base by hand go on to Wrap-up', async () => {
    git(dir, 'init', '-q', '--bare', join(dir, 'remote.git'));
    git(project, 'remote', 'add', 'origin', join(dir, 'remote.git'));
    git(project, 'push', '-q', 'origin', 'main');
    live.db.prepare("UPDATE cards SET stage = 'pr-watch' WHERE key = 'APP-1'").run();
    expect((await said('wrapup')).message).toContain('1 commit not pushed');

    git(project, 'merge', '-q', '--ff-only', 'APP-1-work');

    expect((await said('wrapup')).status).toBe(200);
    expect(card('APP-1').stage).toBe('wrapup');
  });

  it('holds a card in Pull request the same way, and lets it go back to Review', async () => {
    live.db.prepare("UPDATE cards SET stage = 'pr-watch' WHERE key = 'APP-1'").run();
    writeFileSync(join(checkout(), 'search.md'), 'find a recipe fast\n');

    expect((await said('wrapup')).message).toBe('APP-1 has 1 file not committed and no pull request, so it stays in Pull request. Commit them and push on its Changes tab first.');
    expect(card('APP-1').stage).toBe('pr-watch');
    expect((await said('review')).status).toBe(200);
  });

  it('refuses a drop on merge, because the board has no such column', async () => {
    const before = main();

    const response = await move(live, post({ key: 'APP-1', to: 'merge' }));

    // The regression guard: if the merge path comes back with its column, this drop merges into main.
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('The delivery board has no merge column');
    expect(card('APP-1')).toEqual({ stage: 'review', state: 'idle' });
    expect(main()).toBe(before);
  });
});

it('says so when the move committed but the run could not start', async () => {
  addCard('APP-1', 'inbox');
  live.start = () => {
    throw new Error('the engine is not installed');
  };

  const response = await move(live, post({ key: 'APP-1', to: 'refine' }));

  // The card did move, so 409 would tell a person the opposite of what happened. The sentence is
  // ours rather than whatever threw, because what threw names our files.
  expect(response.status).toBe(500);
  const said = await response.json();
  expect(said.message).toMatch(/moved to refine/);
  expect(said.message).not.toMatch(/engine is not installed/);
  expect(card('APP-1')).toEqual({ stage: 'refine', state: 'failed' });
});

const parked = (key: string) => (live.db.prepare('SELECT minimized FROM cards WHERE key = ?').get(key) as { minimized: number }).minimized;

it('minimizes a card, restores it, and tells the board both times', async () => {
  addCard('APP-1', 'plan');
  const heard = vi.fn();
  live.onChange(heard);

  expect((await minimize(live, post({ key: 'APP-1', minimized: true }))).status).toBe(200);
  expect(parked('APP-1')).toBe(1);
  expect(live.snapshot().cards.find((found) => found.key === 'APP-1')?.minimized).toBe(true);

  expect((await minimize(live, post({ key: 'APP-1', minimized: false }))).status).toBe(200);
  expect(parked('APP-1')).toBe(0);
  expect(heard).toHaveBeenCalledTimes(2);
});

it('minimizes a card whose run is going, because parking a card is not a move', async () => {
  addCard('APP-1', 'inbox');
  await move(live, post({ key: 'APP-1', to: 'refine' }));

  expect((await minimize(live, post({ key: 'APP-1', minimized: true }))).status).toBe(200);
  expect(parked('APP-1')).toBe(1);
});

it('answers 404 for a card that is not there, names it, and tells nobody', async () => {
  const heard = vi.fn();
  live.onChange(heard);

  const response = await minimize(live, post({ key: 'APP-404', minimized: true }));

  expect(response.status).toBe(404);
  expect((await response.json()).message).toMatch(/APP-404/);
  expect(heard).not.toHaveBeenCalled();
});

// Only a missing card is a 404. A database that cannot be written is not a card that does not
// exist, and saying so would send the person looking for a card that is there.
it('does not report a failed write as a missing card', async () => {
  addCard('APP-1', 'plan');
  live.db.exec("CREATE TRIGGER no_parking BEFORE UPDATE OF minimized ON cards BEGIN SELECT RAISE(ABORT, 'disk is full'); END");

  await expect(minimize(live, post({ key: 'APP-1', minimized: true }))).rejects.toThrow(/disk is full/);
});

// "true" as a string is what a form sends. Read loosely it would minimize on "false" as well.
it.each([{ key: 'APP-1' }, { minimized: true }, { key: 'APP-1', minimized: 'false' }, { key: 'APP-1', minimized: 1 }])(
  'refuses %j, because it does not say which card or which way',
  async (asked) => {
    addCard('APP-1', 'plan');

    expect((await minimize(live, post(asked))).status).toBe(400);
    expect(parked('APP-1')).toBe(0);
  },
);

it('sweeps a crash and takes the writer lock when the loop opens', () => {
  // Left behind by a crash: a card claiming a run, and a run claiming to be going.
  addCard('APP-1', 'refine', 'running');
  live.db.prepare("INSERT INTO runs (card_key, phase, engine, state) VALUES ('APP-1', 'refine', 'fake', 'running')").run();
  live.close();

  live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '1' });

  // Without the sweep the card refuses every drag for good, which is why the sweep exists.
  expect(card('APP-1').state).toBe('failed');
  expect(live.db.prepare('SELECT pid FROM writer WHERE id = 1').get()).toBeTruthy();
});

it('wires each endpoint to its own write', () => {
  // The handlers cannot be called here: they build the loop from the real environment, which would
  // open the person's own board. Read instead, the way the colour and force checks already do.
  for (const name of ['move', 'stop', 'promote', 'minimize']) {
    const source = readFileSync(new URL(`./${name}/+server.ts`, import.meta.url), 'utf8');

    expect(source).toContain(`${name}(loopOf(url), request)`);
    expect(source).toContain('export const POST');
  }
});

// A blocked card as a run leaves it: the question and the session on the newest run row.
const blocked = (key: string, sessionId: string | null = '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7') => {
  addCard(key, 'plan', 'blocked');
  live.db
    .prepare("INSERT INTO runs (card_key, phase, engine, model, effort, session_id, question, state) VALUES (?, 'plan', 'claude-code', 'sonnet', 'medium', ?, 'Titles only?', 'complete')")
    .run(key, sessionId);
};
const said = async (response: Response) => ((await response.json()) as { message?: string }).message ?? '';

it('continues a blocked card with the answer and answers once the run is queued', async () => {
  blocked('APP-1');

  const response = await answer(live, 'APP-1', post({ answer: 'Titles only.' }));

  expect(response.status).toBe(200);
  expect(card('APP-1').state).toMatch(/queued|running/);
  const newest = live.db.prepare('SELECT session_id FROM runs ORDER BY id DESC LIMIT 1').get() as { session_id: string };
  expect(newest.session_id).toBe('9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7');
});

it('refuses an answer to a card that is not blocked, naming its state', async () => {
  addCard('APP-1', 'plan', 'ready');

  const response = await answer(live, 'APP-1', post({ answer: 'Titles only.' }));

  expect(response.status).toBe(409);
  expect(await said(response)).toContain('is ready');
});

it.each([{}, { answer: 3 }, { text: 'Titles only.' }])('refuses a body with no answer text %j', async (body) => {
  blocked('APP-1');

  const response = await answer(live, 'APP-1', post(body));

  expect(response.status).toBe(400);
  expect(card('APP-1').state).toBe('blocked');
});

it('says the card failed when the session cannot be continued, and the board hears of it', async () => {
  blocked('APP-1', null);
  const told = vi.fn();
  live.onChange(told);

  const response = await answer(live, 'APP-1', post({ answer: 'Titles only.' }));

  expect(response.status).toBe(500);
  expect(await said(response)).toMatch(/failed/);
  expect(card('APP-1').state).toBe('failed');
  expect(told).toHaveBeenCalled();
});

it('wires the answer endpoint to its write', () => {
  const source = readFileSync(new URL('../card/[key]/answer/+server.ts', import.meta.url), 'utf8');

  expect(source).toContain('answer(loopOf(url), params.key, request)');
  expect(source).toContain('export const POST');
});

it('retries a failed card and answers once the run is queued', async () => {
  addCard('APP-1', 'refine', 'failed');

  const response = await retry(live, 'APP-1');

  expect(response.status).toBe(200);
  expect(card('APP-1').state).toMatch(/queued|running/);
});

it('refuses to retry a card with no failed run, naming its state', async () => {
  addCard('APP-1', 'refine', 'idle');

  const response = await retry(live, 'APP-1');

  expect(response.status).toBe(409);
  expect(await said(response)).toContain('is idle');
});

it('says the card failed again when the retry could not be handed over', async () => {
  addCard('APP-1', 'refine', 'failed');
  live.scheduler.add = () => {
    throw new Error('The queue is closed.');
  };

  const response = await retry(live, 'APP-1');

  expect(response.status).toBe(500);
  expect(card('APP-1').state).toBe('failed');
});

it('stops a running card, and the next snapshot shows it idle in its stage', async () => {
  addCard('APP-1', 'inbox');
  await move(live, post({ key: 'APP-1', to: 'refine' }));
  const runId = live.snapshot().cards[0]!.runId;

  const response = await stop(live, post({ runId }));

  expect(response.status).toBe(200);
  await vi.waitFor(() => expect(live.snapshot().cards[0]).toMatchObject({ stage: 'refine', state: 'idle' }));
});

it('wires the retry endpoint to its write', () => {
  const source = readFileSync(new URL('../card/[key]/retry/+server.ts', import.meta.url), 'utf8');

  expect(source).toContain('retry(loopOf(url), params.key, request)');
  expect(source).toContain('export const POST');
});

// "Run on" is the same write with the login to start on, so one route serves both.
it('starts a failed card on the engine profile the body names', async () => {
  addCard('APP-1', 'refine', 'failed');
  writeSetting(live.db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'claude-code#work', label: 'Claude work', vendor: 'claude-code', configDir: '/tmp/nolzu-test-claude-work' }]);

  const response = await retry(live, 'APP-1', post({ engine: 'claude-code#work' }));

  expect(response.status).toBe(200);
  expect(live.db.prepare('SELECT engine FROM runs ORDER BY id DESC LIMIT 1').get()).toEqual({ engine: 'claude-code#work' });
});

it('refuses a login this machine does not hold, and leaves the card failed', async () => {
  addCard('APP-1', 'refine', 'failed');

  const response = await retry(live, 'APP-1', post({ engine: 'codex#gone' }));

  expect(response.status).toBe(409);
  expect(await said(response)).toContain('codex#gone');
  expect(card('APP-1').state).toBe('failed');
});

it('refuses a body whose engine is not the id of a profile', async () => {
  addCard('APP-1', 'refine', 'failed');

  const response = await retry(live, 'APP-1', post({ engine: 7 }));

  expect(response.status).toBe(400);
  expect(await said(response)).toContain('id of that profile');
});

/**
 * A move happens on the card's own board.
 *
 * `moveCard` reads the card against the board it is handed, so the Delivery board finds no Epics
 * card at all and the move is refused. Stage ids repeat across boards, so the board has to come
 * from the card and not from the endpoint.
 */
it('moves a card that is on a board other than Delivery', async () => {
  live.db.prepare('INSERT INTO cards (key, board, stage, state, title) VALUES (?, ?, ?, ?, ?)').run('EPIC-1', 'epics', 'inbox', 'idle', 'A search that finds recipes');

  const response = await move(live, post({ key: 'EPIC-1', to: 'refine' }));

  expect(response.status).toBe(200);
  expect(card('EPIC-1').stage).toBe('refine');
  // The drop starts the stage's phase, which on the Epics board is Delivery's own refine: the
  // Epics refine reads and tidies a ticket the same way, so the board reuses that skill.
  expect(live.scheduler.queue().running.map((job) => job.cardKey)).toEqual(['EPIC-1']);
});

// The stage list is that board's own, so a move to a stage of another board is refused rather than
// silently taken because the two boards share an id.
it("refuses a move to a stage the card's own board does not have", async () => {
  live.db.prepare('INSERT INTO cards (key, board, stage, state, title) VALUES (?, ?, ?, ?, ?)').run('EPIC-2', 'epics', 'inbox', 'idle', 'A search that finds recipes');

  const response = await move(live, post({ key: 'EPIC-2', to: 'implement' }));

  expect(response.status).toBe(409);
  // The column, not the card. The rule that catches this otherwise blames the card's state for a
  // stage that was never on its board, which sends a person looking at the card.
  expect(await response.text()).toContain('The epics board has no implement column');
});

// Peek's Move back on a running card: the run is stopped, the move waits for the run row to end,
// and only then moves the card. An engine that takes a moment to go after its stop is the race: a move
// sent at once would meet a card that still says running and be refused.
describe('moving a running card back', () => {
  // Runs until stopped, then takes a moment to go, as a real engine does.
  const slowToStop = () => {
    live.engine.spawn = async function* (_job, signal) {
      yield JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a1b2c3d4-0000-4000-8000-000000000001', model: 'sonnet', apiKeySource: 'none' });
      // A stop that landed while the line above was read has fired already, and a listener added now
      // would wait for ever.
      await new Promise<void>((resolve) => (signal.aborted ? setTimeout(resolve, 30) : signal.addEventListener('abort', () => setTimeout(resolve, 30), { once: true })));
    };
  };
  const lastMove = (key: string) =>
    live.db.prepare('SELECT to_stage, at FROM card_events WHERE card_key = ? ORDER BY id DESC LIMIT 1').get(key) as { to_stage: string; at: string };

  it('stops the run, waits for its row to end, then moves the card, every time', async () => {
    slowToStop();
    addCard('APP-1', 'inbox');
    for (let round = 0; round < 5; round += 1) {
      await move(live, post({ key: 'APP-1', to: 'refine' }));
      const runId = live.scheduler.queue().running[0]!.runId;
      await vi.waitFor(() => expect(card('APP-1').state).toBe('running'));

      const response = await move(live, post({ key: 'APP-1', to: 'inbox', stop: true }));

      expect(response.status).toBe(200);
      expect(card('APP-1')).toEqual({ stage: 'inbox', state: 'idle' });
      const run = readRun(live.db, runId)!;
      expect(run.state).toBe('stopped');
      // The row ended before the move: the move waited for it.
      expect(run.endedAt).not.toBeNull();
      expect(lastMove('APP-1').to_stage).toBe('inbox');
      expect(run.endedAt! <= lastMove('APP-1').at).toBe(true);
      expect(live.scheduler.queue().running).toEqual([]);
    }
  });

  // The move waits for the run's row to end, and not only for the run to leave the queue: a queue
  // that lets go of the job first must not let the move meet a card that still says running.
  it('keeps waiting for the row to end after the run has left the queue', async () => {
    slowToStop();
    addCard('APP-1', 'inbox');
    await move(live, post({ key: 'APP-1', to: 'refine' }));
    await vi.waitFor(() => expect(card('APP-1').state).toBe('running'));
    const runId = live.scheduler.queue().running[0]!.runId;
    const queue = live.scheduler.queue.bind(live.scheduler);
    let stopped = false;
    vi.spyOn(live.scheduler, 'queue').mockImplementation(() => (stopped ? { ...queue(), running: [], waiting: [] } : queue()));
    const stop = live.stop.bind(live);
    vi.spyOn(live, 'stop').mockImplementation((id: number) => {
      stopped = true;
      return stop(id);
    });

    const response = await move(live, post({ key: 'APP-1', to: 'inbox', stop: true }));

    expect(response.status).toBe(200);
    expect(card('APP-1')).toEqual({ stage: 'inbox', state: 'idle' });
    expect(readRun(live.db, runId)?.state).toBe('stopped');
  });

  it('takes a waiting run out of the queue and moves the card back', async () => {
    live.close();
    const narrow = openDatabase(dir);
    writeSetting(narrow, 'agentSlots', 1);
    narrow.close();
    live = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '1' });
    slowToStop();
    addCard('APP-1', 'inbox');
    addCard('APP-2', 'inbox');
    await move(live, post({ key: 'APP-1', to: 'refine' }));
    await move(live, post({ key: 'APP-2', to: 'refine' }));
    const waiting = live.scheduler.queue().waiting[0]!.runId;

    const response = await move(live, post({ key: 'APP-2', to: 'inbox', stop: true }));

    expect(response.status).toBe(200);
    expect(card('APP-2')).toEqual({ stage: 'inbox', state: 'idle' });
    expect(readRun(live.db, waiting)?.state).toBe('stopped');
    expect(live.scheduler.queue().running.map((job) => job.cardKey)).toEqual(['APP-1']);
  });

  // A stop is the way back and never the way on: the next stage starts a run of its own.
  it('refuses to stop a run for a move forward, and leaves it running', async () => {
    slowToStop();
    addCard('APP-1', 'inbox');
    await move(live, post({ key: 'APP-1', to: 'refine' }));
    await vi.waitFor(() => expect(card('APP-1').state).toBe('running'));

    const response = await move(live, post({ key: 'APP-1', to: 'plan', stop: true }));

    expect(response.status).toBe(409);
    expect((await response.json()).message).toBe('APP-1 is running, and only a move back stops its run first. Stop it, or wait for it to end.');
    expect(card('APP-1')).toEqual({ stage: 'refine', state: 'running' });
    expect(live.scheduler.queue().running).toHaveLength(1);
  });

  it('does not stop a run for a move to the column it is already in', async () => {
    slowToStop();
    addCard('APP-1', 'inbox');
    await move(live, post({ key: 'APP-1', to: 'refine' }));
    await vi.waitFor(() => expect(card('APP-1').state).toBe('running'));

    const response = await move(live, post({ key: 'APP-1', to: 'refine', stop: true }));

    expect(response.status).toBe(409);
    expect(card('APP-1')).toEqual({ stage: 'refine', state: 'running' });
    expect(live.scheduler.queue().running).toHaveLength(1);
  });

  // Most tests here use APP-1 alone. A second card in another column tells its stage and its run apart.
  it('stops and moves the card it was asked about, not another', async () => {
    slowToStop();
    addCard('APP-1', 'inbox');
    addCard('APP-2', 'inbox');
    await move(live, post({ key: 'APP-2', to: 'refine' }));
    await vi.waitFor(() => expect(card('APP-2').state).toBe('running'));

    const response = await move(live, post({ key: 'APP-2', to: 'inbox', stop: true }));

    expect(response.status).toBe(200);
    expect(card('APP-2')).toEqual({ stage: 'inbox', state: 'idle' });
    expect(card('APP-1')).toEqual({ stage: 'inbox', state: 'idle' });
  });

  it('says so, and moves nothing, when the run does not end in time', async () => {
    // An engine that never goes, which the contract forbids and the wait has to survive.
    live.engine.spawn = async function* () {
      yield JSON.stringify({ type: 'system', subtype: 'init', session_id: 'a1b2c3d4-0000-4000-8000-000000000002', model: 'sonnet', apiKeySource: 'none' });
      await new Promise<never>(() => {});
    };
    addCard('APP-1', 'inbox');
    await move(live, post({ key: 'APP-1', to: 'refine' }));
    await vi.waitFor(() => expect(card('APP-1').state).toBe('running'));

    const refused = await stopThenMove(live, 'APP-1', 'inbox', 50);

    expect(refused).toEqual({ status: 409, message: 'APP-1 did not stop in time, so it stayed in Refine. Stop it again, then move it back.' });
    expect(card('APP-1').stage).toBe('refine');
  });

  it('moves a card that runs nothing at once, as a plain move back', async () => {
    addCard('APP-1', 'plan', 'ready');

    const response = await move(live, post({ key: 'APP-1', to: 'refine', stop: true }));

    expect(response.status).toBe(200);
    expect(card('APP-1')).toEqual({ stage: 'refine', state: 'idle' });
  });
});
