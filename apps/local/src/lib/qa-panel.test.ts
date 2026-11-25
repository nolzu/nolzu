import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, openDatabase, saveVerdict, setCardRepos, setCardStack, startRun, writeSetting } from '@nolzu/core/node';
import { TAKEN_DOWN } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { qaInputFor, qaPanelFor, stackLane, stackStatusFor } from './qa-panel.ts';
import { browserEntry, writeMcpList } from './mcp-store.ts';

// A real project folder with a real checkout, because the status command runs in it. What the
// command prints is read back through the panel, so nothing here is a stub of a shell.
let project = '';
let data = '';
let db: DatabaseSync;

const CHECKOUT = () => join(project, 'worktrees', 'APP-1');

// Own commands under `*`, which run in the card's checkout root, as the stack hook they replace did.
const own = ({ start = 'true', status = null }: { start?: string; status?: string | null }) =>
  writeSetting(db, 'qaApp', { '*': { mode: 'own', start, stop: null, status } });

const card = (key = 'APP-1') => createCard(db, { key, board: 'delivery', stage: 'qa', title: `${key} title` });

const qaRun = (over: { state?: string } = {}) => {
  const id = startRun(db, { cardKey: 'APP-1', phase: 'qa', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'stack' });
  db.prepare('UPDATE runs SET state = ? WHERE id = ?').run(over.state ?? 'complete', id);
  return id;
};

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'nolzu-qa-panel-project-'));
  data = mkdtempSync(join(tmpdir(), 'nolzu-qa-panel-data-'));
  db = openDatabase(data);
  writeSetting(db, 'projectPath', project);
  mkdirSync(CHECKOUT(), { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the status command', () => {
  // A real script, run for real, in the card's own checkout. The words it prints are what the
  // panel shows, so a change that started parsing them would fail here.
  it('shows what the project prints, word for word', async () => {
    card();
    const script = join(project, 'status.sh');
    writeFileSync(script, 'echo "api  running"\necho "db   exited (1)"\n');
    own({ status: `sh ${script} {key}` });

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.stack.status).toBe('api  running\ndb   exited (1)');
    expect(view.stack.statusNote).toBeNull();
    expect(view.stack.command).toContain('APP-1');
  });

  it('runs it in the card checkout, which is the only folder its answer can be about', async () => {
    card();
    own({ status: 'printf %s "$PWD"' });

    const view = await qaPanelFor(db, 'APP-1', { env: { PATH: process.env.PATH, PWD: '/somewhere/else' } });

    expect(view.stack.status).toBe(CHECKOUT());
  });

  it('hands it the card key, the project folder and its repositories', async () => {
    card();
    own({ status: `printf '%s|%s|%s' "$NOLZU_CARD_KEY" "$NOLZU_PROJECT" "$NOLZU_REPOS"` });

    const view = await qaPanelFor(db, 'APP-1', { env: { PATH: process.env.PATH } });

    expect(view.stack.status).toBe(`APP-1|${project}|.`);
  });

  // A second card, so a key fixed to the first one anywhere on the way shows. The caller's own
  // variables still reach the command, or a hook could not find docker on the PATH.
  it('hands a second card its own key and keeps the caller environment', async () => {
    card('APP-2');
    mkdirSync(join(project, 'worktrees', 'APP-2'), { recursive: true });
    own({ status: `printf '%s|%s' "$NOLZU_CARD_KEY" "$KEPT"` });

    const view = await qaPanelFor(db, 'APP-2', { env: { PATH: process.env.PATH, KEPT: 'yes' } });

    expect(view.stack.status).toBe('APP-2|yes');
  });

  // The other side of the branch, and the point of it: nothing is run, and the panel still says
  // something true.
  it('says not reported for own commands with no Status command, and runs nothing', async () => {
    card();
    const ran = join(project, 'ran.txt');
    own({ start: `touch ${ran}` });

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.stack.statusNote).toBe("Not reported. None of this card's own commands has a Status command.");
    expect(view.stack.status).toBeNull();
    // The start command was never run either. The panel asks one question only.
    expect(existsSync(ran)).toBe(false);
  });

  it('keeps the output of a status command that failed, and says it failed', async () => {
    card();
    own({ status: 'echo "no compose file" >&2; exit 3' });

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.stack.status).toBe('no compose file');
    expect(view.stack.statusNote).toBe('The status command exited 3.');
  });

  it('says the status command was stopped when it runs past its timeout', async () => {
    card();
    own({ status: 'sleep 30; true' });

    const view = await qaPanelFor(db, 'APP-1', { env: process.env, timeoutMs: 150 });

    expect(view.stack.statusNote).toContain('still running after the timeout');
  });

  it('says a card with no checkout has nowhere to run the command', async () => {
    card();
    rmSync(CHECKOUT(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    own({ status: 'echo up' });

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.stack.statusNote).toContain('This card has no checkout, so the Status command has nowhere to run.');
  });
});

// Each repository with own commands of its own, in the card's copy of it, under its name.
describe('own commands per repository', () => {
  it('lists them, and runs each Status in its own copy, one block under each name', async () => {
    writeSetting(db, 'repos', [
      { path: 'api', base: null },
      { path: 'web', base: null },
    ]);
    card();
    setCardRepos(db, 'APP-1', ['api', 'web'], 'person');
    for (const repo of ['api', 'web']) mkdirSync(join(CHECKOUT(), repo), { recursive: true });
    writeSetting(db, 'qaApp', {
      api: { mode: 'own', start: 'docker compose up -d', stop: null, status: 'basename "$PWD"' },
      web: { mode: 'own', start: 'npm start', stop: null, status: 'echo "web up"' },
    });

    const input = qaInputFor(db, 'APP-1', { env: process.env });
    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(input).toMatchObject({ hasLoad: true, hasUnload: true, hasStatus: true, loadCommand: null });
    expect(view.stack.apps).toEqual([
      { name: 'api', start: 'docker compose up -d' },
      { name: 'web', start: 'npm start' },
    ]);
    expect(view.stack.status).toBe('api\napi\n\nweb\nweb up');
  });

  it('says a card with no own commands has none, and points to where they are set', async () => {
    card();
    writeSetting(db, 'qaApp', { '.': { mode: 'code' } });

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.stack.reason).toBe('No repository of this card has its own start commands. Add them in the QA question, or under Start the app in Settings, Project.');
    expect(view.stack.buttons.every((button) => button.refused !== null)).toBe(true);
  });
});

// The panels draw at once from the database, and the status command's answer comes after.
describe('the panels in two parts', () => {
  it('reads the input without running the status command, and says nothing for a project with none', async () => {
    card();
    rmSync(CHECKOUT(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    expect(await stackStatusFor(db, 'APP-1', { env: process.env })).toEqual({ status: null, statusProblem: null });
    own({ status: 'echo up' });
    expect(qaInputFor(db, 'APP-1', { env: process.env })).toMatchObject({ cardKey: 'APP-1', hasStatus: true, status: null, statusProblem: null });
    expect(await stackStatusFor(db, 'APP-1', { env: process.env })).toMatchObject({ status: null, statusProblem: expect.stringContaining('no checkout') });
  });
});

describe('the panel', () => {
  it('shows the stack state the last command left on the card', async () => {
    card();
    setCardStack(db, 'APP-1', { state: 'up', reason: null });

    expect((await qaPanelFor(db, 'APP-1', { env: process.env })).stack.state).toBe('up');
  });

  // A hand edited row must not put a word nobody wrote on the screen.
  it('reads a state outside the five as nothing stored', async () => {
    card();
    db.prepare("UPDATE cards SET stack_state = 'banana' WHERE key = 'APP-1'").run();

    expect((await qaPanelFor(db, 'APP-1', { env: process.env })).stack.state).toBe('off');
  });

  it('shows the verdict of the newest QA run and its reason', async () => {
    card();
    saveVerdict(db, qaRun(), { verdict: 'FAIL', reason: 'An empty search shows no recipes.' });
    const newest = qaRun();
    saveVerdict(db, newest, { verdict: 'PASS', reason: null });

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.verdict.verdict).toBe('PASS');
    expect(view.verdict.runId).toBe(newest);
  });

  // The run died before it wrote anything, so there is no verdict and no sentence either.
  it('says the run ended before deciding when it left neither a verdict nor a reason', async () => {
    card();
    qaRun({ state: 'failed' });

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.verdict.verdict).toBeNull();
    expect(view.verdict.note).toContain('ended before it decided anything');
  });

  it('finds the report and the screenshots the run left in the card folder', async () => {
    card();
    const folder = join(project, '.tasks', 'APP-1', 'qa');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'report.md'), '# QA\n');
    writeFileSync(join(folder, 'search.png'), 'not really a png');

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.verdict.report).toBe('qa/report.md');
    expect(view.verdict.screenshots).toEqual([{ path: 'qa/search.png', name: 'search.png' }]);
  });

  it('reads the checklist out of the report in the card folder', async () => {
    card();
    const folder = join(project, '.tasks', 'APP-1', 'qa');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'report.md'), '## 2. What QA checked\n\n1. pass: Open the list\n2. fail: Type a word, the list filters\n   Reason: every recipe stays\n');

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.verdict.checklist?.rows).toEqual([
      { step: 'Open the list', result: 'pass', reason: null, ran: null },
      { step: 'Type a word, the list filters', result: 'fail', reason: 'every recipe stays', ran: null },
    ]);
  });

  // Ticket-QA: the app line names the start command.
  it('names the start command', async () => {
    card();
    own({ start: 'npm run dev' });
    setCardStack(db, 'APP-1', { state: 'off', reason: TAKEN_DOWN });

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.stack.said).toEqual({ text: 'Started with ', command: 'npm run dev', tail: ' for QA, stopped after.' });
  });

  // The panel has to tell the two empty cases apart, so it reads the servers QA gets.
  it('says the run took none when the project has a browser', async () => {
    card();
    writeMcpList(project, [browserEntry()]);

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.verdict.screenshotNote).toBe('This run took no screenshots.');
  });

  it('blames the missing setup when the project points at no browser', async () => {
    card();

    const view = await qaPanelFor(db, 'APP-1', { env: process.env });

    expect(view.verdict.screenshotNote).toContain('once a browser is set up');
  });

  it('carries the card the stack lane holds into the button rules', async () => {
    card();
    own({ start: 'up' });

    const view = await qaPanelFor(db, 'APP-1', { env: process.env, busy: 'APP-2' });

    expect(view.stack.buttons.every((button) => button.refused !== null)).toBe(true);
  });
});

it('reads the stack lane out of the board snapshot and nowhere else', () => {
  const lanes = [
    { name: 'stack', heldBy: 'APP-2' },
    { name: 'knowledge', heldBy: null },
  ];

  expect(stackLane({ lanes })).toBe('APP-2');
  expect(stackLane({ lanes: [{ name: 'knowledge', heldBy: 'APP-3' }] })).toBeNull();
});
