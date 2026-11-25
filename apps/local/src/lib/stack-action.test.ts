import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { boardVersion, cardStack, createCard, openDatabase, setCardRepos, setCardStack, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appHeld, isStackAction, pressStack, releaseAll, releaseHeld } from './stack-action.ts';

// Real commands in a real checkout. What each button did is read back from the files the commands
// wrote, so nothing here is a stub of a shell.
let project = '';
let data = '';
let db: DatabaseSync;

const CHECKOUT = () => join(project, 'worktrees', 'APP-1');
const trail = () => join(project, 'trail.txt');
const wrote = (): string[] => (existsSync(trail()) ? readFileSync(trail(), 'utf8').trim().split('\n') : []);

// Own commands under `*`, which run in the card's checkout root, as the stack hook they replace did.
const own = (start: string, stop: string | null = `echo "unload {key}" >> ${trail()}`) => writeSetting(db, 'qaApp', { '*': { mode: 'own', start, stop, status: null } });

const FREE = { lanes: [{ name: 'stack', heldBy: null }] };
const HELD = { lanes: [{ name: 'stack', heldBy: 'APP-2' }] };

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'nolzu-stack-button-project-'));
  data = mkdtempSync(join(tmpdir(), 'nolzu-stack-button-data-'));
  db = openDatabase(data);
  writeSetting(db, 'projectPath', project);
  own(`echo "load {key}" >> ${trail()}`, `echo "unload {key}" >> ${trail()}`);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'qa', title: 'APP-1 title' });
  mkdirSync(CHECKOUT(), { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('runs the start command and leaves the card saying its app is up', async () => {
  const before = boardVersion(db);

  const answer = await pressStack(db, FREE, 'APP-1', 'load', process.env);

  expect(answer.ok).toBe(true);
  expect(wrote()).toEqual(['load APP-1']);
  expect(cardStack(db, 'APP-1')).toEqual({ state: 'up', reason: null });
  // The board carries the card's stack, so a press a person made has to reach the boards and the
  // tabs that are already open.
  expect(boardVersion(db)).toBeGreaterThan(before);
});

// A key the command will not take ends the press with the reason, never with the card stuck loading.
it('says why a key cannot go into the command, and leaves the card failed, not loading', async () => {
  own('echo "load {key}"', null);
  createCard(db, { key: 'APP;2', board: 'delivery', stage: 'qa', title: 'APP;2 title' });
  mkdirSync(join(project, 'worktrees', 'APP;2'), { recursive: true });

  const loaded = await pressStack(db, FREE, 'APP;2', 'load', process.env);
  expect(loaded).toMatchObject({ ok: false, said: expect.stringContaining('holds a character a shell reads') });
  expect(cardStack(db, 'APP;2')?.state).toBe('failed');

  const stopped = await pressStack(db, FREE, 'APP;2', 'unload', process.env);
  expect(stopped.ok).toBe(false);
  expect(cardStack(db, 'APP;2')?.state).not.toBe('unloading');
});

// The same variables a QA run gives the hook, so a script behaves the same from a button.
it('hands the command the card key and the repositories it picked, the root first', async () => {
  writeSetting(db, 'repos', [
    { path: '.', base: 'main' },
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
  ]);
  setCardRepos(db, 'APP-1', ['web'], 'person');
  own(`printf '%s|%s|%s' "$NOLZU_CARD_KEY" "$NOLZU_PROJECT" "$NOLZU_REPOS" > ${trail()}`, `printf '%s' "$NOLZU_REPOS" > ${trail()}`);

  await pressStack(db, FREE, 'APP-1', 'load', process.env);
  expect(readFileSync(trail(), 'utf8')).toBe(`APP-1|${project}|.\nweb`);

  await pressStack(db, FREE, 'APP-1', 'force', process.env);
  expect(readFileSync(trail(), 'utf8')).toBe('.\nweb');
});

// Two cards with different picks, so a key or a list fixed to the first card shows.
it('hands a second card its own key and its own repositories', async () => {
  writeSetting(db, 'repos', [
    { path: '.', base: 'main' },
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
  ]);
  createCard(db, { key: 'APP-2', board: 'delivery', stage: 'qa', title: 'APP-2 title' });
  mkdirSync(join(project, 'worktrees', 'APP-2'), { recursive: true });
  setCardRepos(db, 'APP-1', ['api'], 'person');
  setCardRepos(db, 'APP-2', ['web'], 'person');
  own(`printf '%s|%s' "$NOLZU_CARD_KEY" "$NOLZU_REPOS" > ${trail()}`);

  await pressStack(db, FREE, 'APP-2', 'load', process.env);

  expect(readFileSync(trail(), 'utf8')).toBe('APP-2|.\nweb');
});

// A card whose repositories are not picked yet has none to start, so nothing runs.
it('starts nothing for a card whose repositories are not picked yet', async () => {
  writeSetting(db, 'repos', [
    { path: '.', base: 'main' },
    { path: 'api', base: 'main' },
  ]);
  own(`printf '[%s]' "$NOLZU_REPOS" > ${trail()}`);

  const answer = await pressStack(db, FREE, 'APP-1', 'load', process.env);

  expect(answer.ok).toBe(false);
  expect(existsSync(trail())).toBe(false);
});

it('runs the Stop command on an app that is up, and says the app is down', async () => {
  setCardStack(db, 'APP-1', { state: 'up', reason: null });

  const answer = await pressStack(db, FREE, 'APP-1', 'unload', process.env);

  expect(answer).toEqual({ ok: true, said: 'The app was stopped.' });
  expect(wrote()).toEqual(['unload APP-1']);
  expect(cardStack(db, 'APP-1')?.state).toBe('off');
});

// Both sides of the state check. Unload takes down what Nolzu brought up, and Force is the button
// for a stack an earlier run left behind.
it('refuses Stop with nothing up and points at Force, which runs anyway', async () => {
  const refused = await pressStack(db, FREE, 'APP-1', 'unload', process.env);
  expect(refused.ok).toBe(false);
  expect(refused.said).toContain('Press Force');
  expect(wrote()).toEqual([]);

  const forced = await pressStack(db, FREE, 'APP-1', 'force', process.env);
  expect(forced.ok).toBe(true);
  expect(wrote()).toEqual(['unload APP-1']);
});

// One QA run at a time owns the stack. Taking it down under a running check would make its verdict
// meaningless, so the lane refuses Force too.
it('refuses every button while a QA run holds the stack lane', async () => {
  setCardStack(db, 'APP-1', { state: 'up', reason: null });

  for (const button of ['load', 'unload', 'force'] as const) {
    const answer = await pressStack(db, HELD, 'APP-1', button, process.env);
    expect(answer.ok).toBe(false);
    expect(answer.said).toContain('APP-2 is running QA');
  }
  expect(wrote()).toEqual([]);
});

// The write before the command runs. A second tab on this card reads the panel and not a stale one.
it('says the app is starting while the start command runs', async () => {
  own(`sleep 1; echo "load {key}" >> ${trail()}`);

  const press = pressStack(db, FREE, 'APP-1', 'load', process.env);
  await vi.waitFor(() => expect(cardStack(db, 'APP-1')?.state).toBe('loading'));

  expect((await press).ok).toBe(true);
  expect(cardStack(db, 'APP-1')?.state).toBe('up');
});

// The panel draws this rule too, but a tab opened before the press still offers live buttons. Two
// load commands over one stack would fight over the same containers.
it('refuses a second press while a start or stop of this card runs, and points at Force', async () => {
  setCardStack(db, 'APP-1', { state: 'loading', reason: null });

  const refused = await pressStack(db, FREE, 'APP-1', 'load', process.env);

  expect(refused.ok).toBe(false);
  expect(refused.said).toContain('already running');
  expect(wrote()).toEqual([]);
});

// The other side: a card whose command never came back is stuck in that state, and Force is the
// only way out of it.
it('runs Force on a card the state says is mid command', async () => {
  setCardStack(db, 'APP-1', { state: 'unloading', reason: null });

  const forced = await pressStack(db, FREE, 'APP-1', 'force', process.env);

  expect(forced.ok).toBe(true);
  expect(wrote()).toEqual(['unload APP-1']);
});

it('carries the command\'s own words when it fails, and marks the app failed', async () => {
  own('echo "no compose file for APP-1" >&2; exit 3');

  const answer = await pressStack(db, FREE, 'APP-1', 'load', process.env);

  expect(answer.ok).toBe(false);
  expect(answer.said).toContain('no compose file for APP-1');
  expect(cardStack(db, 'APP-1')?.state).toBe('failed');
});

// The QA run is not involved, so a failed unload leaves the stack up and says so.
it('says the app is still up when the Stop command fails', async () => {
  setCardStack(db, 'APP-1', { state: 'up', reason: null });
  own('true', 'echo "no such container" >&2; exit 1');

  const answer = await pressStack(db, FREE, 'APP-1', 'unload', process.env);

  expect(answer.ok).toBe(false);
  expect(answer.said).toContain('still up');
  expect(cardStack(db, 'APP-1')?.state).toBe('up');
});

it('refuses a button the project has no command for, and runs nothing', async () => {
  writeSetting(db, 'qaApp', { '*': { mode: 'code' } });

  const answer = await pressStack(db, FREE, 'APP-1', 'load', process.env);

  // The sentence names the two places own commands are set.
  expect(answer.said).toBe('No repository of this card has its own start commands. Add them in the QA question, or under Start the app in Settings, Project.');
  expect(wrote()).toEqual([]);
});

it('refuses a card with no checkout, because the command has nowhere to run', async () => {
  rmSync(CHECKOUT(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

  const answer = await pressStack(db, FREE, 'APP-1', 'load', process.env);

  expect(answer.said).toContain('This card has no checkout, so the command has nowhere to run.');
  expect(wrote()).toEqual([]);
});

// A Start that keeps running is held by the Nolzu server until Stop, Force or the card's next QA ends.
it('holds a start that keeps running until Stop, and until the end of QA', async () => {
  // The server's process and not its port, as in the test below: a freed port can be taken at once by
  // anything else on a busy machine.
  const pidFile = join(project, 'pid.txt');
  writeFileSync(
    join(project, 'server.mjs'),
    `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
createServer((request, response) => response.end('ok')).listen(Number(process.env.PORT), () => writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));
`,
  );
  own(`node ${join(project, 'server.mjs')}`, null);
  const alive = () => {
    try {
      process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
      return true;
    } catch {
      return false;
    }
  };

  expect((await pressStack(db, FREE, 'APP-1', 'load', process.env)).ok).toBe(true);
  await vi.waitFor(() => expect(alive()).toBe(true));
  expect(await pressStack(db, FREE, 'APP-1', 'unload', process.env)).toEqual({ ok: true, said: 'The app was stopped.' });
  await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 2000 });
  rmSync(pidFile);

  expect((await pressStack(db, FREE, 'APP-1', 'load', process.env)).ok).toBe(true);
  // The port can answer a moment before the server's listen callback writes its id.
  await vi.waitFor(() => expect(alive()).toBe(true));
  await releaseHeld('APP-1');
  await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 2000 });
});

it('stops what every hand Start left running on releaseAll, which Nolzu awaits on shutdown', async () => {
  // The server's process and not its port: a freed port can be taken at once by anything else on a
  // busy machine, and a request there would read a stranger's answer as the app still up.
  const pidFile = join(project, 'pid.txt');
  writeFileSync(join(project, 'server.mjs'), `import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
createServer((request, response) => response.end('ok')).listen(Number(process.env.PORT), () => writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)));
`);
  own(`node ${join(project, 'server.mjs')}`, null);
  expect((await pressStack(db, FREE, 'APP-1', 'load', process.env)).ok).toBe(true);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  expect(alive()).toBe(true);

  await releaseAll();

  await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 2000 });
});

// With no Stop command and nothing held, what the start began may still run, so the line says so.
it('says the app is still up when Stop has no command and nothing is held', async () => {
  own(`echo "load {key}" >> ${trail()}`, null);
  setCardStack(db, 'APP-1', { state: 'up', reason: null });

  const answer = await pressStack(db, FREE, 'APP-1', 'unload', process.env);

  expect(answer).toEqual({ ok: false, said: `No Stop command is set, so what echo "load APP-1" >> ${trail()} started is still up.` });
  expect(cardStack(db, 'APP-1')?.state).toBe('up');
});

// A Start that failed partway can leave the repositories before it up, so Stop runs on a failed card.
it('runs Stop on a card whose Start failed', async () => {
  setCardStack(db, 'APP-1', { state: 'failed', reason: 'exited 3' });

  const answer = await pressStack(db, FREE, 'APP-1', 'unload', process.env);

  expect(answer.ok).toBe(true);
  expect(wrote()).toEqual(['unload APP-1']);
});

// One press of a card at a time, Force included, so Force cannot race a long Start.
it('refuses a second press of the card while one runs, Force included', async () => {
  own(`sleep 1; echo "load {key}" >> ${trail()}`);

  const first = pressStack(db, FREE, 'APP-1', 'load', process.env);
  const forced = await pressStack(db, FREE, 'APP-1', 'force', process.env);

  expect(forced).toEqual({ ok: false, said: "A start or stop of this card's app is already running. Wait for it." });
  expect((await first).ok).toBe(true);
  expect(wrote()).toEqual(['load APP-1']);
});

it('refuses a key that is on no board', async () => {
  const answer = await pressStack(db, FREE, 'APP-9', 'load', process.env);

  expect(answer.said).toContain('There is no card APP-9 here');
});

it('takes the three words the panel sends and nothing else', () => {
  expect(['load', 'unload', 'force'].every(isStackAction)).toBe(true);
  expect(isStackAction('restart')).toBe(false);
  expect(isStackAction(null)).toBe(false);
});

// A start that exits 0, such as `docker compose up -d`, leaves no process to hold, and what it started
// still runs. Delete card asks appHeld, so the card counts as held until a Stop takes the app down.
it('counts a card whose start exited 0 as held until Stop takes the app down', async () => {
  // The memory lives for the process, so a Start an earlier test pressed is cleared first.
  await pressStack(db, FREE, 'APP-1', 'force', process.env);
  expect(appHeld('APP-1')).toBe(false);
  await pressStack(db, FREE, 'APP-1', 'load', process.env);
  expect(appHeld('APP-1')).toBe(true);

  own(`echo "load {key}" >> ${trail()}`, 'exit 1');
  await pressStack(db, FREE, 'APP-1', 'unload', process.env);
  expect(appHeld('APP-1')).toBe(true);

  own(`echo "load {key}" >> ${trail()}`, `echo "unload {key}" >> ${trail()}`);
  await pressStack(db, FREE, 'APP-1', 'force', process.env);
  expect(appHeld('APP-1')).toBe(false);
});
