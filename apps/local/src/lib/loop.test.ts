import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { presetModels, READ_GIT_COMMANDS } from '@nolzu/core';
import { cardDiscussions, followPreset, getSetting, markDiscussion, notifications, saveCardPull, storeDiscussions, openDatabase, outputCheckOf, readOnlyBreakOf, readRun, retryWait, setCardModels, startRun, writeSetting } from '@nolzu/core/node';
import { DEFAULT_PROFILE, type Job, type RunActivity } from '@nolzu/protocol';
import { type Engine, gitAfter, gitBefore, recordedRepos, type RunGh, spawnClaude } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoop, type Loop, nolzuWrites } from './loop.ts';
import { emptyEntry } from './mcp-list.ts';
import { browserEntry, readMcpList, writeMcpList } from './mcp-store.ts';

// A packaged app that cannot resolve the skills folder reads no skill, and every phase then has no
// method. Nothing in a checkout can produce that, so the one test of it turns the reading off here.
// Every other test in this file gets the real text.
const skills = vi.hoisted(() => ({ unreadable: false }));
vi.mock('@nolzu/skills', async (importOriginal) => {
  const real = await importOriginal<typeof import('@nolzu/skills')>();
  return { ...real, phaseInstructions: (...args: Parameters<typeof real.phaseInstructions>) => (skills.unreadable ? null : real.phaseInstructions(...args)) };
});

let dir = '';
let loop: Loop;
// Whether the wall starts on this machine, pinned so a test reads the same on every machine.
const WALL = { ready: true } as const;
const NO_WALL = { ready: false, reason: 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.' } as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-loop-'));
  // The fake engine, handed in rather than set on the process, so one test cannot change what
  // another one runs against.
  // Delay scale zero, so a run finishes in microtasks and no test waits on a clock.
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { wall: WALL });
});

afterEach(() => {
  loop.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const addCard = (key: string, stage = 'inbox') =>
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', ?, 'idle', ?)").run(key, stage, `${key} title`);

// A second login, of a vendor this version has an adapter for. A row that names it runs on it, and
// a row that names nothing stays on the default profile.
const CODEX = { id: 'codex#work', label: 'Codex work', vendor: 'codex' as const, configDir: '/tmp/nolzu-loop-codex' };
const bothProfiles = () => writeSetting(loop.db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

// The vendor that runs implement and nothing else, which is what the phase rule is measured with.
const CURSOR = { id: 'cursor#work', label: 'Cursor work', vendor: 'cursor' as const, configDir: '/tmp/nolzu-loop-cursor' };

// Antigravity is no engine since 0.1.0: Google's terms do not allow third-party apps on its consumer
// plans. A machine that used it still stores its profile and a row pinned to it. The loop reads them
// the way it reads a removed profile: no model list is asked, and no job is built on the row.
it('reads a stored Antigravity profile as a removed one', () => {
  addCard('APP-1');
  const stored = [DEFAULT_PROFILE, { id: 'antigravity', label: 'Mine', vendor: 'antigravity', configDir: null }];
  loop.db.prepare('INSERT OR REPLACE INTO machine.settings (key, value) VALUES (?, ?)').run('engineProfiles', JSON.stringify(stored));
  setCardModels(loop.db, 'APP-1', { implement: { engine: 'antigravity', model: 'gemini-3.8-flash-medium' } });

  expect(loop.snapshot().cards.map((card) => card.key)).toEqual(['APP-1']);
  expect(Object.keys(loop.models())).toEqual(['claude-code']);
  expect(() => loop.buildJob('APP-1', 'implement', 1)).toThrow('APP-1 runs implement on the engine profile antigravity, which this machine has no login for.');
});

it('serves a snapshot of the board it opened', () => {
  addCard('APP-1');

  const snap = loop.snapshot();

  expect(snap.kind).toBe('delivery');
  expect(snap.cards.map((card) => card.key)).toEqual(['APP-1']);
  expect(snap.slots.total).toBeGreaterThan(0);
});

it('tells every listener when something changes, and stops when one leaves', () => {
  let heard = 0;
  const leave = loop.onChange(() => {
    heard += 1;
  });

  loop.changed();
  expect(heard).toBe(1);

  leave();
  loop.changed();
  // A listener that left must not be called again. A stream that closed is gone, and writing to it
  // throws inside whatever triggered the change.
  expect(heard).toBe(1);
});

it('moves the version when the queue changes, not only when the database does', () => {
  addCard('APP-1');
  const before = loop.snapshot().version;

  // The queue lives in memory, so nothing about this reaches the database on its own. Without the
  // scheduler bumping, two different boards would ship under the same event id and a stream keyed
  // on it would never resend.
  loop.scheduler.add({
    runId: 1,
    cardKey: 'APP-1',
  engine: 'claude-code',
    phase: 'implement',
    cwd: dir,
    prompt: 'do the thing',
    model: 'sonnet',
    effort: 'medium',
    sessionId: null,
    resumeFrom: null,
    timeoutMs: 60_000,
    logPath: join(dir, 'logs', 'APP-1.ndjson'),
    taskDir: join(dir, '.tasks', 'APP-1'),
    lane: null,
    mcpConfigPath: null,
    settingsPath: null,
    tools: ['Read'],
  });

  expect(loop.snapshot().version).toBeGreaterThan(before);
});

it('opens one loop per data directory, so a reload cannot build two schedulers on one database', () => {
  const again = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });

  expect(again).toBe(loop);
});

it('resolves the model, the effort and the timeout onto the job it builds', () => {
  addCard('APP-1');

  const job = loop.buildJob('APP-1', 'plan', 7);

  expect(job.runId).toBe(7);
  expect(job.cardKey).toBe('APP-1');
  expect(job.phase).toBe('plan');
  expect(job.model).toBe('sonnet');
  expect(job.effort).toBe('medium');
  expect(job.timeoutMs).toBeGreaterThan(0);
  // The prompt carries the card, so the agent is told what it is working on.
  expect(job.prompt).toContain('APP-1');
});

// The card's Settings tab moved it onto Heavy, so its run is Heavy's and not the project's.
it('builds the job on the preset the card follows', () => {
  addCard('APP-1');
  followPreset(loop.db, 'APP-1', 'heavy');

  const job = loop.buildJob('APP-1', 'plan', 7);

  expect(job.model).toBe('opus');
  expect(job.effort).toBe('high');
});

// Another card on the project's preset keeps its model, so the preset is read for the card asked about.
it('builds the job of each card on its own preset', () => {
  addCard('APP-1');
  addCard('APP-2');
  followPreset(loop.db, 'APP-2', 'heavy');

  expect(loop.buildJob('APP-1', 'plan', 7).model).toBe('sonnet');
  expect(loop.buildJob('APP-2', 'plan', 8).model).toBe('opus');
});

// The card folder sits in the project, next to the worktrees, so the artifacts outlive the checkout
// that cleanup removes. The prompt names it from the working folder, so no machine path reaches it.
it('puts the card folder in the project and names it from the working folder', () => {
  addCard('APP-1');
  writeSetting(loop.db, 'projectPath', '/work/recipes');

  const job = loop.buildJob('APP-1', 'refine', 3);

  expect(job.cwd).toBe(join('/work/recipes', 'worktrees', 'APP-1'));
  expect(job.taskDir).toBe(join('/work/recipes', '.tasks', 'APP-1'));
  expect(job.prompt).toContain('The card folder is `../../.tasks/APP-1/`.');
  expect(job.prompt).not.toContain('/work/recipes');
});

// Measured on Claude Code 2.1.278: a run working in the card's checkout reads neither the project's
// own settings nor a CLAUDE_PROJECT_DIR that points at the project, so a job has to name the file
// that holds the guard, or a read-only phase runs with nothing holding it to the card folder.
it('hands the run a settings file that names the guard by its full path', () => {
  addCard('APP-1');
  const project = join(dir, 'recipes');
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, '.claude', 'hooks', 'nolzu-phase-guard.mjs'), 'export {};\n');
  writeSetting(loop.db, 'projectPath', project);

  const job = loop.buildJob('APP-1', 'refine', 3);

  expect(job.settingsPath).toBe(join(dir, 'engine-settings.json'));
  const settings = JSON.parse(readFileSync(job.settingsPath ?? '', 'utf8')) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
  expect(settings.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(join(project, '.claude', 'hooks', 'nolzu-phase-guard.mjs'));
});

// A project the wizard never set up has no guard file, and a hook naming a file that is not there
// refuses nothing and fails on every tool call. The run still gets the file, because it is also what
// turns Claude Code's attribution off, and a pull request text once ended on that line.
it('hands a settings file with attribution off and no hook when the project has no guard', () => {
  addCard('APP-1');
  writeSetting(loop.db, 'projectPath', join(dir, 'recipes'));

  const job = loop.buildJob('APP-1', 'refine', 3);
  const settings = JSON.parse(readFileSync(job.settingsPath ?? '', 'utf8')) as { hooks?: unknown; attribution?: unknown };
  expect(settings.hooks).toBeUndefined();
  expect(settings.attribution).toEqual({ commit: '', pr: '' });
});

// Read from the project folder on every build, so an edit on the settings screen reaches the next run.
it("puts the project's instructions for the phase into the prompt only while the file is there", () => {
  addCard('APP-1');
  const project = join(dir, 'recipes');
  mkdirSync(join(project, '.nolzu', 'phases'), { recursive: true });
  writeSetting(loop.db, 'projectPath', project);
  expect(loop.buildJob('APP-1', 'refine', 3).prompt).not.toContain('## Project instructions');

  writeFileSync(join(project, '.nolzu', 'phases', 'refine.md'), 'Use my brainstorming skill first.\n');

  expect(loop.buildJob('APP-1', 'refine', 3).prompt).toContain('## Project instructions for Refine\n\nUse my brainstorming skill first.');
  expect(loop.buildJob('APP-1', 'plan', 3).prompt).not.toContain('## Project instructions');
});

it('keeps the card folder in the data directory when there is no project, which is the fake engine case', () => {
  addCard('APP-1');

  const job = loop.buildJob('APP-1', 'refine', 3);

  expect(job.taskDir).toBe(join(dir, '.tasks', 'APP-1'));
  expect(job.prompt).toContain('The card folder is `.tasks/APP-1/`.');
});

// A task added from an epic keeps the epic's notes in its card folder, and every run
// of the task reads them.
it('names the epic notes of a task in every run, and none for a card without them', () => {
  addCard('APP-1');
  expect(loop.buildJob('APP-1', 'refine', 3).prompt).not.toContain('from-epic.md');
  mkdirSync(join(dir, '.tasks', 'APP-1'), { recursive: true });
  writeFileSync(join(dir, '.tasks', 'APP-1', 'from-epic.md'), '- Files: api/list.ts\n');

  for (const phase of ['refine', 'plan', 'implement'] as const) expect(loop.buildJob('APP-1', phase, 3).prompt).toContain("`.tasks/APP-1/from-epic.md` holds the epic's notes for this task");
});

// The project folder comes from the project setting, never from the card key, so Claude Code's Read
// rule for AGENTS.md names the file the project's CLAUDE.md points at.
it('names the project folder on the job, and none when there is no project', () => {
  addCard('APP-1');
  expect(loop.buildJob('APP-1', 'refine', 3).projectDir).toBeNull();

  writeSetting(loop.db, 'projectPath', '/work/recipes');
  expect(loop.buildJob('APP-1', 'refine', 3).projectDir).toBe('/work/recipes');
});

// A preset naming a model the engine does not offer would ship a board whose drop says the model is
// gone before anybody changed a setting. Core cannot see the engine, so this is where both meet.
// Claude Code only: `loop.engine` is the fake one here, and it answers with the Claude list
// whatever vendor it stands in for. `preset-models.test.ts` measures the other two vendors against
// what their own commands printed.
it('offers every model the built-in Claude Code presets name', () => {
  for (const model of presetModels('claude-code')) expect(loop.engine.listModels()).toContain(model);
});

// The board asks the engine which models exist, so a model the engine stops offering reads as gone.
it('reads what exists from the engine, not from the presets', () => {
  const refine = () => loop.snapshot().stages.find((stage) => stage.id === 'refine')?.starts;
  expect(refine()?.modelState).toBe('ok');

  const model = refine()?.model;
  const offered = loop.engine.listModels;
  loop.engine.listModels = () => offered().filter((name) => name !== model);
  try {
    expect(refine()?.modelState).toBe('gone');
  } finally {
    loop.engine.listModels = offered;
  }
});

// QA owns the local stack while it runs, so its job takes the stack lane. It gets a command, and the
// guard holds its Write and Edit to the card folder: fixing is a separate run on the implement phase.
it('builds a QA job in the stack lane, with a command', () => {
  addCard('APP-1');

  const job = loop.buildJob('APP-1', 'qa', 1);

  expect(job.lane).toBe('stack');
  expect(job.tools).toContain('Bash');
});

// A workspace's repositories clone after the project is saved, so the list is still unfilled when the
// stacks land, and the Settings page was the only other place that filled it. A person who dismissed
// Confirm the run commands never opened it, and Implement was refused npm test. The first run that may
// use the shell fills it now, from the stacks, the way a project save does; an emptied list stays empty.
it('fills a list never filled from the repositories at the first run with a shell', () => {
  addCard('APP-1');
  const project = join(dir, 'recipes');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  writeSetting(loop.db, 'projectPath', project);
  expect(getSetting(loop.db, 'allowedCommands')).toBeNull();

  expect(loop.buildJob('APP-1', 'plan', 1).allowedCommands).toEqual([]);
  expect(getSetting(loop.db, 'allowedCommands')).toBeNull();
  const implement = loop.buildJob('APP-1', 'implement', 2).allowedCommands;

  expect(implement).toContain('npm test');
  expect(getSetting(loop.db, 'allowedCommands')).toEqual(implement);

  writeSetting(loop.db, 'allowedCommands', []);
  expect(loop.buildJob('APP-1', 'implement', 3).allowedCommands).toEqual([]);
});

// The list belongs to the project, so every card's run gets the same one, and only a phase
// that holds Bash carries it. A list that was never filled allows no command.
it('hands the project list of allowed commands to a phase with a shell, and to no other', () => {
  addCard('APP-1');

  expect(loop.buildJob('APP-1', 'implement', 1).allowedCommands).toEqual([]);

  writeSetting(loop.db, 'allowedCommands', ['npm install', 'ng test --watch=false']);

  expect(loop.buildJob('APP-1', 'implement', 1).allowedCommands).toEqual(['npm install', 'ng test --watch=false']);
  // QA reads git as well, to check a criterion against the branch, and a project command it holds
  // already is not named twice.
  expect(loop.buildJob('APP-1', 'qa', 2).allowedCommands).toEqual(['npm install', 'ng test --watch=false', ...READ_GIT_COMMANDS]);
  expect(loop.buildJob('APP-1', 'plan', 3).allowedCommands).toEqual([]);

  writeSetting(loop.db, 'allowedCommands', []);

  expect(loop.buildJob('APP-1', 'implement', 4).allowedCommands).toEqual([]);
  expect(loop.buildJob('APP-1', 'qa', 5).allowedCommands).toEqual(READ_GIT_COMMANDS);
  writeSetting(loop.db, 'allowedCommands', ['git status']);
  expect(loop.buildJob('APP-1', 'qa', 6).allowedCommands?.filter((command) => command === 'git status')).toHaveLength(1);
});

// The servers come from the project's list, and the run reads them with their secrets when it starts
// (`runMcp`), so the job a queue holds carries no config. The prompt names the servers a phase is on
// for: QA's as its browser, and any other phase's with their descriptions.
it('names in the prompt the servers of the list a phase is on for', () => {
  addCard('APP-1');
  const project = join(dir, 'recipes');
  mkdirSync(project, { recursive: true });
  writeSetting(loop.db, 'projectPath', project);
  writeMcpList(project, [browserEntry(), { ...emptyEntry(), name: 'db', description: 'The test database', command: 'db-mcp', phases: ['refine'] }]);

  const qa = loop.buildJob('APP-1', 'qa', 1);
  expect(qa.prompt).toContain('as the MCP server `playwright`.');
  expect(qa.mcpConfigPath).toBeNull();
  const refine = loop.buildJob('APP-1', 'refine', 2).prompt;
  expect(refine).toContain('This run has the MCP server `db` (The test database).');
  expect(refine).not.toContain('A browser is configured');
});

// A crash leaves Claude Code's config with its secrets in `mcp-runs`, and maybe a Cursor merge. The boot
// of the data folder, under its lock, puts the merge back and clears the folder.
it('clears what a crash left in mcp-runs when the data folder boots, a Cursor QA merge too', () => {
  const left = join(dir, 'mcp-runs', '1-9');
  mkdirSync(left, { recursive: true });
  writeFileSync(join(left, 'claude-x.json'), '{"mcpServers":{}}');
  // Quit during a Cursor QA run: the merge sits in a QA copy the boot sweeps away too.
  const copy = join(dir, 'qa-copies', 'qa-APP-1-0a1b2c3d');
  mkdirSync(join(copy, '.cursor'), { recursive: true });
  writeFileSync(join(copy, '.cursor', 'mcp.json'), 'merged');
  const quit = join(dir, 'mcp-runs', '1-10');
  mkdirSync(quit);
  writeFileSync(join(quit, 'cursor-restore.json'), JSON.stringify({ file: join(copy, '.cursor', 'mcp.json'), before: null, madeFolder: join(copy, '.cursor'), exclude: null }));
  loop.close();
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { wall: WALL });
  expect(readdirSync(join(dir, 'mcp-runs'))).toEqual([]);
  expect(existsSync(join(copy, '.cursor'))).toBe(false);
});

// The old per-project path reaches no run any more: the loop moves it into the list once.
it('moves the old QA browser setting into the list when the loop starts', async () => {
  const project = join(dir, 'recipes');
  mkdirSync(project, { recursive: true });
  writeSetting(loop.db, 'projectPath', project);
  const config = join(dir, 'their-mcp.json');
  writeFileSync(config, JSON.stringify({ mcpServers: { browser: { command: 'npx', args: ['b'] } } }));
  writeSetting(loop.db, 'qaMcpConfigPath', config);
  loop.close();
  loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { wall: WALL });

  await vi.waitFor(() => expect(getSetting(loop.db, 'qaMcpConfigPath')).toBeNull());
  expect(readMcpList(project).servers).toMatchObject([{ name: 'browser', phases: ['qa'] }]);
});

it('refuses to build a job for a card that is not there, and names it', () => {
  expect(() => loop.buildJob('APP-404', 'plan', 1)).toThrow(/APP-404/);
});

// The run row holds the engine profile, which is what a resume is read back under.
const begin = (key: string, phase: string) =>
  startRun(loop.db, {
    cardKey: key,
    phase,
    engine: DEFAULT_PROFILE.id,
    model: 'sonnet',
    effort: 'medium',
    sessionId: null,
    logPath: join(dir, 'logs', `${key}-${phase}.ndjson`),
    lane: null,
  });

// With no project, the job's folder is the data directory, which only the fake engine may use. A real
// engine there would run with write access inside Nolzu's own data.
it('refuses a real run when no project is set', () => {
  const real = mkdtempSync(join(tmpdir(), 'nolzu-loop-'));
  const live = createLoop(real, {});
  try {
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'inbox', 'idle', 'A card')").run();

    expect(live.engine.name).toBe('claude-code');
    expect(() => live.buildJob('APP-1', 'refine', 1)).toThrow('There is no project set, so APP-1 has no checkout to run in. Make a project on New project at /new.');
  } finally {
    live.close();
    rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The fake engine may run in the data directory, so a wrap-up with no project gets past the checkout
// check and stops one step later, at the knowledge folder. That folder lives in the person's own
// repository, so with no project there is nowhere to write what the run learned.
it('refuses a wrap-up when no project is set', () => {
  addCard('APP-1');

  expect(() => loop.buildJob('APP-1', 'wrapup', 1)).toThrow(
    'There is no project set, so APP-1 has no knowledge folder to write into. Make a project on New project at /new.',
  );
});

// The move is committed before the job is built, so a job that cannot be built leaves a card that
// moved and started nothing. The reason goes on a run row, which is where the card reads it from.
it('shows why a real run could not start, and queues nothing', () => {
  const real = mkdtempSync(join(tmpdir(), 'nolzu-loop-'));
  const live = createLoop(real, {});
  try {
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'refine', 'queued', 'A card')").run();

    live.start('APP-1', 'refine');

    const card = live.snapshot().cards.find((found) => found.key === 'APP-1');
    expect(card?.state).toBe('failed');
    expect(card?.failureReason).toMatch(/no project/i);
    expect(live.scheduler.queue().waiting).toHaveLength(0);
    // The bell keeps it, as it keeps a run that failed once started.
    expect(notifications(live.db).map((one) => [one.kind, one.card, one.text.startsWith('Refine failed: There is no project set')])).toEqual([['error', 'APP-1', true]]);
  } finally {
    live.close();
    rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// A row on a profile of a vendor this version has no model list for. Nothing here knows what that
// CLI offers, so the row must not be called gone: no model a person could pick would repair it.
// Where the wall cannot start, plan on Cursor is refused by the vendor rule instead, which is a
// different word and a different sentence, and that is what the board says.
it('calls a row of a vendor with no model list refused and never gone', () => {
  const real = mkdtempSync(join(tmpdir(), 'nolzu-loop-'));
  const seeded = openDatabase(real);
  writeSetting(seeded, 'engineProfiles', [DEFAULT_PROFILE, { id: 'cursor#work', label: 'Cursor work', vendor: 'cursor', configDir: '/tmp/nolzu-loop-cursor' }]);
  writeSetting(seeded, 'models', { plan: { engine: 'cursor#work', model: 'composer' } });
  seeded.close();
  const live = createLoop(real, {}, { wall: NO_WALL });
  try {
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'inbox', 'idle', 'A card')").run();

    // The vendor rule stops the job before anything is made, which is what the board says too. A
    // run that reached the spawn instead would already have a run row, a branch and a checkout.
    expect(() => live.buildJob('APP-1', 'plan', 1)).toThrow(/only Nolzu's wall holds Cursor to reading/);
    const starts = live.snapshot().stages.find((stage) => stage.id === 'plan')?.starts;
    expect(starts?.modelState).toBe('vendor');
    expect(starts?.refusal).toContain(NO_WALL.reason);
  } finally {
    live.close();
    rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The key names the card's checkout and its card folder. A key that is not one plain name would put
// the agent in another folder, `..` in the project's own checkout.
it.each(['..', '.', 'APP-1/../..', 'APP\\1', ''])('refuses to build a job for the key %j', (key) => {
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES (?, 'delivery', 'inbox', 'idle', 'A card')").run(key);

  expect(() => loop.buildJob(key, 'refine', 1)).toThrow(/key/);
});

it('closes the database when the loop cannot be built', () => {
  const failed = mkdtempSync(join(tmpdir(), 'nolzu-loop-'));

  // A fake delay nobody can read, which the engine refuses while the loop is built, after the
  // database is already open. The route builds a loop on every request, so a leak here is one
  // connection per retry until the process runs out of files.
  expect(() => createLoop(failed, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: 'later' })).toThrow(/NOLZU_FAKE_DELAY_SCALE/);

  // sqlite removes its sidecars when the last connection closes. A handle left behind leaves them,
  // and the attached machine database closes with the project's connection.
  expect(readdirSync(failed).sort()).toEqual(['machine.db', 'nolzu.db']);
  rmSync(failed, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// The Engines screen adds a profile of any vendor and removes any profile, so a person can end up
// with one login Nolzu has no adapter for. The loop is built on every request, so a first profile
// it cannot spawn used to throw here and take the settings screen with it, which is the one screen
// that could remove the profile again.
it('builds when no profile it can run is left, so the screens stay open', () => {
  const stuck = mkdtempSync(join(tmpdir(), 'nolzu-loop-'));
  const seeded = openDatabase(stuck);
  writeSetting(seeded, 'engineProfiles', [{ id: 'cursor#work', label: 'Cursor work', vendor: 'cursor', configDir: null }]);
  seeded.close();
  const live = createLoop(stuck, {});
  try {
    expect(live.snapshot().stages.length).toBeGreaterThan(0);
    // Nothing runs, and the row says which login it wants rather than the app saying nothing.
    expect(live.models()).toEqual({});
  } finally {
    live.close();
    rmSync(stuck, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('runs a job and writes what the engine said onto the run and the card', async () => {
  addCard('APP-1', 'plan');
  const runId = begin('APP-1', 'plan');

  loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

  await vi.waitFor(() => {
    expect(readRun(loop.db, runId)?.state).toBe('complete');
  });
  // The row and the board read one fold of one event list, so they cannot tell different stories.
  expect(loop.snapshot().cards[0]?.state).toBe('ready');
});

// The output check runs when a run ends and keeps what it found on the row, and a problem moves
// nothing: the card still lands ready.
it('stores what the output check found on a run that ended ready', async () => {
  const fake = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = async function* (job: Job, signal: AbortSignal) {
    yield* fake(job, signal);
    rmSync(join(job.taskDir, 'qa', 'checks.md'), { force: true });
  };
  addCard('APP-1', 'plan');
  const runId = begin('APP-1', 'plan');

  loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

  await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'));
  expect(outputCheckOf(loop.db, runId)).toEqual({ problems: [{ file: 'qa/checks.md', problem: 'The file is missing.' }], note: null });
  expect(loop.snapshot().cards[0]?.state).toBe('ready');
});

// The plan of an epic writes the plan for other people, and the check holds it to
// that file. This epic has no architecture, so the fake writes no such file and the check names it.
it('tells the plan of an epic to write the plan for other people, and checks for it', async () => {
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('EPIC-1', 'epics', 'plan', 'idle', 'A search that finds recipes')").run();
  addCard('APP-1', 'plan');
  const runId = begin('EPIC-1', 'plan');
  const job = loop.buildJob('EPIC-1', 'plan', runId);

  expect(job.prompt).toContain('This card is an epic. Write the plan for other people to');
  expect(loop.buildJob('APP-1', 'plan', 99).prompt).not.toContain('PLAN.md');
  loop.scheduler.add(job);
  await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'));
  expect(outputCheckOf(loop.db, runId)?.problems).toEqual([{ file: 'share/PLAN.md', problem: 'The file is missing.' }]);
});

// An engine ends a pull request text with its own line by habit. Nolzu takes it out after the run, so
// the compare page and the share files never say a tool wrote them.
it('takes the tool line out of the shared files after a run', async () => {
  const fake = loop.engine.spawn.bind(loop.engine);
  const line = `\u{1F916} ${['Generated', 'with'].join(' ')} [Claude Code](https://claude.com/claude-code)`;
  loop.engine.spawn = async function* (job: Job, signal: AbortSignal) {
    yield* fake(job, signal);
    mkdirSync(join(job.taskDir, 'share'), { recursive: true });
    writeFileSync(join(job.taskDir, 'share', 'SUMMARY.md'), `The plan is ready.\n\n${line}\n`);
  };
  addCard('APP-1', 'plan');
  const runId = begin('APP-1', 'plan');

  loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

  await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'));
  const job = loop.buildJob('APP-1', 'plan', runId);
  expect(readFileSync(join(job.taskDir, 'share', 'SUMMARY.md'), 'utf8')).toBe('The plan is ready.\n');
});

// The Engines screen shows what a run last read, so the line that keeps it has to run inside a real
// run and not only in a test's own call. The fake engine replays a rate limit line for it.
it('keeps what a run read about the usage windows, under the profile that ran', async () => {
  const fake = loop.engine.spawn.bind(loop.engine);
  let first = true;
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    const replay = first ? { ...job, phase: 'rate-limit' } : job;
    first = false;
    return fake(replay, signal);
  };
  addCard('APP-1', 'plan');
  const runId = begin('APP-1', 'plan');

  loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

  await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'));
  expect(getSetting(loop.db, 'engineLimits')['claude-code']?.windows).toEqual([
    { name: 'five_hour', used: 0.62, resetsAt: 1789551000, status: 'allowed' },
    { name: 'seven_day', used: 0.41, resetsAt: 1789830000, status: null },
  ]);
});

// The near-limit toast says which card saw the line, so the reading keeps the card of the run that read it.
it('keeps the card whose run read the usage windows', async () => {
  const fake = loop.engine.spawn.bind(loop.engine);
  let first = true;
  loop.engine.spawn = (job: Job, signal: AbortSignal) => {
    const replay = first ? { ...job, phase: 'rate-limit' } : job;
    first = false;
    return fake(replay, signal);
  };
  addCard('APP-1', 'plan');
  addCard('APP-2', 'plan');
  const runId = begin('APP-2', 'plan');

  loop.scheduler.add(loop.buildJob('APP-2', 'plan', runId));

  await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'));
  expect(getSetting(loop.db, 'engineLimits')['claude-code']?.card).toBe('APP-2');
});

it('leaves a stopped card idle, the way the run row already says', async () => {
  addCard('APP-1', 'plan');
  const runId = begin('APP-1', 'plan');

  loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));
  // On the same tick, so the signal is already aborted when the engine takes its first step.
  loop.scheduler.stop(runId);

  await vi.waitFor(() => {
    expect(readRun(loop.db, runId)?.state).toBe('stopped');
  });
  // Assumption C: a person pressing stop is not the machine failing, so the card goes back to idle
  // rather than reading as a failure the board would ask them to retry.
  expect(loop.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get()).toEqual({ state: 'idle' });
});

// Ctrl+C. The engine is a real child process this test starts, spawned the way a Claude Code run is,
// so the stop is seen reaching each process group through the runner, and nothing else is signalled.
describe('shutting down', () => {
  let stub = '';
  const pids = (file: string): string[] => (existsSync(join(stub, file)) ? readFileSync(join(stub, file), 'utf8').split('\n').filter(Boolean).sort() : []);

  beforeEach(() => {
    stub = mkdtempSync(join(tmpdir(), 'nolzu-shutdown-'));
    const engine = join(stub, 'engine');
    // Ready only once it listens, so the stop always meets the handler and never the default kill. It
    // takes a moment to stop, as a real engine does, so a shutdown that does not wait for it ends first.
    writeFileSync(
      engine,
      [
        '#!/usr/bin/env node',
        "const fs = require('fs');",
        `process.on('SIGTERM', () => setTimeout(() => { fs.appendFileSync(${JSON.stringify(join(stub, 'stopped'))}, process.pid + '\\n'); process.exit(143); }, 200));`,
        `fs.appendFileSync(${JSON.stringify(join(stub, 'ready'))}, process.pid + '\\n');`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );
    chmodSync(engine, 0o755);
    // The engine starts as it came: CI has no bubblewrap, and the wall is not what this test is about.
    loop.engine.spawn = (job: Job, signal: AbortSignal) => spawnClaude(engine, job, signal, { killGraceMs: 2000, wall: (_spec, command, args) => ({ command, args: [...args] }) });
  });

  afterEach(() => rmSync(stub, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('stops each live run once, and ends after each has written its stop', async () => {
    loop.scheduler.resize(2);
    const runs = ['APP-1', 'APP-2', 'APP-3'].map((key) => {
      addCard(key, 'plan');
      const runId = begin(key, 'plan');
      loop.scheduler.add(loop.buildJob(key, 'plan', runId));
      return runId;
    });
    await vi.waitFor(() => expect(pids('ready')).toHaveLength(2), { timeout: 5000 });

    const ending = loop.shutdown();
    // A job the hub or an open page sends while the runs end, which no freed slot may start.
    addCard('APP-4', 'plan');
    loop.scheduler.add(loop.buildJob('APP-4', 'plan', begin('APP-4', 'plan')));
    await ending;

    // One stop per process, and neither the waiting run nor the late one started an engine.
    expect(pids('stopped')).toEqual(pids('ready'));
    expect(pids('ready')).toHaveLength(2);
    // Recorded as a Stop press records it, so the cards read stopped and idle after the next start,
    // not cut off by a restart.
    expect(runs.map((runId) => readRun(loop.db, runId)?.state)).toEqual(['stopped', 'stopped', 'stopped']);
    expect(loop.db.prepare("SELECT DISTINCT state FROM cards WHERE key LIKE 'APP-%'").all()).toEqual([{ state: 'idle' }]);
    // The late one waits for good, and the next start's sweep closes its row.
    expect(loop.scheduler.queue()).toMatchObject({ running: [], waiting: [{ cardKey: 'APP-4' }] });
  }, 15000);

  it('does not stop again a run a Stop press already ends, nor on a second Ctrl+C', async () => {
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));
    await vi.waitFor(() => expect(pids('ready')).toHaveLength(1), { timeout: 5000 });
    const stop = vi.spyOn(loop.scheduler, 'stop');

    loop.stop(runId);
    await Promise.all([loop.shutdown(), loop.shutdown()]);

    expect(pids('stopped')).toEqual(pids('ready'));
    expect(readRun(loop.db, runId)?.state).toBe('stopped');
    // The press and both shutdowns reach the scheduler, which sends the stop once (`scheduler.test.ts`).
    expect(stop).toHaveBeenCalledTimes(3);
  }, 15000);

  // Neither takes a slot, so the queue does not hold them. Ctrl+C stops them all the same.
  it('stops an Ask run and a commit message pass too, and ends after the Ask run has written its stop', async () => {
    addCard('APP-1', 'plan');
    loop.discuss('APP-1', { id: 'ask', sessionId: null, engine: null }, 'Where does the list come from?');
    const message = loop.writeMessage('APP-1', 'Write the commit message.');
    await vi.waitFor(() => expect(pids('ready')).toHaveLength(2), { timeout: 5000 });

    await loop.shutdown();

    expect(pids('stopped')).toEqual(pids('ready'));
    expect(loop.db.prepare("SELECT state FROM runs WHERE phase = 'ask'").get()).toEqual({ state: 'stopped' });
    expect(loop.db.prepare("SELECT body FROM messages WHERE thread = 'ask' AND author = 'agent'").get()).toEqual({ body: expect.stringMatching(/^No answer came\./) });
    await expect(message).resolves.toMatchObject({ ok: false });
    expect(loop.db.prepare("SELECT state FROM runs WHERE phase = 'commit-message'").get()).toEqual({ state: 'stopped' });
  }, 15000);

  // A commit message pass alone: nothing in the queue and no Ask run, so only the pass itself holds the
  // shutdown until its process has written its stop.
  it('ends after a commit message pass has written its stop', async () => {
    addCard('APP-1', 'plan');
    const message = loop.writeMessage('APP-1', 'Write the commit message.');
    await vi.waitFor(() => expect(pids('ready')).toHaveLength(1), { timeout: 5000 });

    await loop.shutdown();

    expect(pids('stopped')).toEqual(pids('ready'));
    await expect(message).resolves.toMatchObject({ ok: false });
  }, 15000);

  it('ends at once when nothing runs', async () => {
    await expect(loop.shutdown()).resolves.toBeUndefined();
    expect(loop.listeners()).toBe(0);
  });
});

it('ends the run and frees the card when the engine cannot start', async () => {
  // An engine whose spawn throws at once. The scheduler swallows what the port throws, so without
  // handling it the row and the card stayed exactly as the move left them: queued, which refuses every
  // drag for good.
  loop.engine.spawn = () => {
    throw new Error('The claude engine was not found at claude.');
  };
  addCard('APP-1', 'implement');
  const runId = begin('APP-1', 'implement');

  loop.scheduler.add(loop.buildJob('APP-1', 'implement', runId));

  await vi.waitFor(() => {
    expect(readRun(loop.db, runId)?.state).toBe('failed');
  });
  const card = loop.snapshot().cards[0];
  expect(card?.state).toBe('failed');
  // The engine said why. A failure with nothing in it leaves the person guessing.
  expect(card?.failureReason).toBeTruthy();
});

// The bell keeps each end the toast raises, so it is still there after the person was away.
describe('notifications of a run end', () => {
  const kept = () => notifications(loop.db).map((one) => [one.id, one.kind, one.card, one.text]);

  it('keeps a finished run once, under its run', async () => {
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('ready'));
    expect(kept()).toEqual([[`run:${runId}`, 'success', 'APP-1', 'Plan finished']]);
  });

  it('keeps a failed run with its reason', async () => {
    loop.engine.spawn = () => {
      throw new Error('The claude engine was not found at claude.');
    };
    addCard('APP-1', 'implement');
    const runId = begin('APP-1', 'implement');
    loop.scheduler.add(loop.buildJob('APP-1', 'implement', runId));

    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('failed'));
    expect(kept()).toEqual([[`run:${runId}`, 'error', 'APP-1', 'Implement failed: The claude engine was not found at claude.']]);
  });

  it('keeps the question of a card that asks', async () => {
    const fake = loop.engine.spawn.bind(loop.engine);
    loop.engine.spawn = (job: Job, signal: AbortSignal) => fake({ ...job, phase: 'needs-input' }, signal);
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('blocked'));
    expect(kept()).toEqual([[`run:${runId}`, 'warning', 'APP-1', expect.stringMatching(/^Plan asks you: \S/)]]);
  });

  it('keeps nothing for a stop', async () => {
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));
    loop.scheduler.stop(runId);

    await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('stopped'));
    expect(kept()).toEqual([]);
  });
});

it('writes nothing once the loop is closed', () => {
  const other = mkdtempSync(join(tmpdir(), 'nolzu-loop-'));
  const closing = createLoop(other, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });

  closing.close();

  // The scheduler can still be told things after the loop is gone: a run that was going reports its
  // end from its own finally, where nothing can catch what a write to a closed database throws, and
  // that takes the process down rather than one request.
  expect(() => closing.scheduler.promote(1)).not.toThrow();
  rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A laptop that sleeps in the middle of a run stops it without a sign, so every run holds it awake
// for as long as the run goes, and not a moment longer.
describe('keeping the machine awake', () => {
  const helpers: { killed: boolean }[] = [];
  const awake = { platform: 'darwin', has: () => false, pid: 1, spawn: () => {
    const helper = { killed: false };
    helpers.push(helper);
    return { kill: () => (helper.killed = true) };
  } };
  let held: Loop;
  let folder = '';

  beforeEach(() => {
    helpers.length = 0;
    folder = mkdtempSync(join(tmpdir(), 'nolzu-awake-'));
    held = createLoop(folder, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { awake });
    held.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'plan', 'idle', 'A card')").run();
  });

  afterEach(() => {
    held.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const runToEnd = async () => {
    held.start('APP-1', 'plan');
    const runId = (held.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
    await vi.waitFor(() => expect(['complete', 'failed']).toContain(readRun(held.db, runId)?.state));
  };

  it('holds one helper while a run goes and ends it when the run ends', async () => {
    await runToEnd();

    expect(helpers).toEqual([{ killed: true }]);
  });

  it('ends the helper when the run fails', async () => {
    held.engine.spawn = () => {
      throw new Error('The claude engine was not found at claude.');
    };

    await runToEnd();

    expect(helpers).toEqual([{ killed: true }]);
  });

  it('holds nothing when keep-awake is off', async () => {
    writeSetting(held.db, 'keepAwake', false);

    await runToEnd();

    expect(helpers).toEqual([]);
  });
});

// An API error a later try can change is waited out and the session resumed, and while the run waits the
// board says so, instead of a run that looks stuck.
describe('retrying an API error', () => {
  const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7', model: 'sonnet', apiKeySource: 'none' });
  const OVERLOADED = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'API Error: 529 Overloaded' });
  const DONE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, duration_ms: 10, usage: {} });

  it('shows the run as retrying during the wait, resumes it, and ends ready', async () => {
    writeSetting(loop.db, 'retryWaitsMs', [400]);
    const plays = [[INIT, OVERLOADED], [INIT, DONE]];
    let calls = 0;
    loop.engine.spawn = async function* (job: Job) {
      // No summary is written, so the ready run is followed by the extraction pass, which is not a try.
      if (job.phase === 'extract-summary') return;
      for (const line of plays[calls++] ?? []) yield line;
    };
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.runState).toBe('retrying'));
    expect(loop.snapshot().cards[0]?.state).toBe('running');
    await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'), { timeout: 5000 });

    expect(calls).toBe(2);
    expect(loop.snapshot().cards[0]?.state).toBe('ready');
  });

  // Now and the card count down to the next try, so the wait is stored with its reason and its time,
  // and the log carries the same wait between the two attempts.
  it('stores the wait with its reason and when the next try starts, and drops it at the resume', async () => {
    writeSetting(loop.db, 'retryWaitsMs', [400]);
    const plays = [[INIT, OVERLOADED], [INIT, DONE]];
    let calls = 0;
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'extract-summary') return;
      for (const line of plays[calls++] ?? []) yield line;
    };
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    const before = Date.now();
    const job = loop.buildJob('APP-1', 'plan', runId);
    loop.scheduler.add(job);

    await vi.waitFor(() => expect(retryWait(loop.db, runId)).not.toBeNull());
    const wait = retryWait(loop.db, runId)!;
    expect(wait).toMatchObject({ attempt: 1, maxRetries: 1, reason: 'API Error: 529 Overloaded' });
    expect(wait.until).toBeGreaterThanOrEqual(before + 400);
    expect(wait.until).toBeLessThanOrEqual(Date.now() + 400);
    await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'), { timeout: 5000 });
    expect(retryWait(loop.db, runId)).toBeNull();
    expect(readFileSync(job.logPath, 'utf8')).toContain('"nolzu.retry"');
  });

  // The resumed attempt is live work, which the board shows as running and not as a wait.
  it('shows the run as running again once the resumed attempt starts', async () => {
    writeSetting(loop.db, 'retryWaitsMs', [100]);
    let release: () => void = () => undefined;
    let calls = 0;
    loop.engine.spawn = async function* () {
      calls += 1;
      if (calls === 1) {
        yield INIT;
        yield OVERLOADED;
        return;
      }
      yield INIT;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield DONE;
    };
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

    await vi.waitFor(() => expect(calls).toBe(2));
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.runState).toBe('running'));
    release();
    await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'));
  });

  // The engine's own sub-second retries are its business. Saved as Nolzu waits, the row read retrying
  // for as long as the attempt ran.
  it('saves nothing for the retries the engine makes on its own', async () => {
    const own = JSON.stringify({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 600, error_status: 529, error: 'overloaded' });
    let release: () => void = () => undefined;
    loop.engine.spawn = async function* () {
      yield INIT;
      yield own;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield DONE;
    };
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

    await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('running'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(loop.snapshot().cards[0]?.runState).toBe('running');
    release();
    await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'));
  });
});

// What a running agent did last, read off its own stream and told apart from the board's changes.
describe('the activity of a run', () => {
  const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7', model: 'sonnet', apiKeySource: 'none' });
  const READ = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'services/api/src/recipes/list.ts' } }] } });
  const SAID = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The list maps every recipe to its title.' }] } });
  const OVERLOADED = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 529, result: 'API Error: 529 Overloaded' });
  const DONE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, duration_ms: 10, usage: {} });
  const told: RunActivity[] = [];
  beforeEach(() => {
    told.length = 0;
    loop.onActivity((activity) => told.push(activity));
  });

  it('tells each engine event as activity, keeps the last tool over a text line, and forgets the run at its end', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'extract-summary') return;
      yield INIT;
      yield READ;
      yield SAID;
      await held;
      yield DONE;
    };
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

    await vi.waitFor(() => expect(told).toHaveLength(4));
    // The start, then the session, the tool and the text. The text keeps the tool's line.
    expect(told.map((activity) => activity.line)).toEqual([null, null, 'Reading services/api/src/recipes/list.ts', 'Reading services/api/src/recipes/list.ts']);
    expect(told.every((activity) => activity.runId === runId && activity.cardKey === 'APP-1')).toBe(true);
    expect(loop.activity()).toEqual([told.at(-1)]);

    release();
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('ready'));
    expect(loop.activity()).toEqual([]);
  });

  // A change moves the version, sends whole boards and makes the hub diff. An engine event does none.
  it('moves no board version and tells no change listener on an engine event', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let next = () => {};
    const step = () => new Promise<void>((resolve) => (next = resolve));
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'extract-summary') return;
      yield INIT;
      await step();
      yield READ;
      yield SAID;
      await held;
      yield DONE;
    };
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));
    await vi.waitFor(() => expect(told).toHaveLength(2));
    const before = loop.snapshot().version;
    let changes = 0;
    const leave = loop.onChange(() => (changes += 1));

    next();
    await vi.waitFor(() => expect(told).toHaveLength(4));

    expect(changes).toBe(0);
    expect(loop.snapshot().version).toBe(before);
    leave();
    release();
    await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'));
  });

  // A page that listens must never fail the run it watches.
  it('drops a listener that throws, and the run goes on', async () => {
    let calls = 0;
    loop.onActivity(() => {
      calls += 1;
      throw new Error('The page went away.');
    });
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'extract-summary') return;
      yield INIT;
      yield READ;
      yield DONE;
    };
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

    await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'));
    expect(calls).toBe(1);
    // The other listener heard every event.
    expect(told.length).toBeGreaterThanOrEqual(3);
  });

  // Without the reset a run that came back from a long wait, and had not printed yet, read Quiet at once.
  it('counts the output time again from the resume after a retry wait', async () => {
    writeSetting(loop.db, 'retryWaitsMs', [300]);
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'extract-summary') return;
      calls += 1;
      if (calls === 1) {
        yield INIT;
        yield OVERLOADED;
        return;
      }
      await held;
      yield INIT;
      yield DONE;
    };
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

    await vi.waitFor(() => expect(calls).toBe(2));
    // The wait's own event, then the resume, 300 ms later, with nothing printed between them.
    const [wait, resume] = told.slice(-2);
    expect((resume?.outputAt ?? 0) - (wait?.outputAt ?? 0)).toBeGreaterThanOrEqual(290);
    release();
    await vi.waitFor(() => expect(readRun(loop.db, runId)?.state).toBe('complete'));
  });

  // Two cards at once, each reading a file by its full path inside its own job folder. Each line names
  // the card and the run it came from, and the path is read against that run's folder.
  it('keeps each running card to its own run, its own line and its own folder', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const folders = new Map<string, string>();
    // A real project, so each card runs in its own checkout and not in the data folder.
    const project = join(dir, 'recipes');
    mkdirSync(project);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
    git('init', '-q', '-b', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'first');
    writeSetting(loop.db, 'projectPath', project);
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'extract-summary') return;
      folders.set(job.cardKey, job.cwd);
      yield INIT;
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: join(job.cwd, 'src', `${job.cardKey}.ts`) } }] } });
      await held;
      yield DONE;
    };
    addCard('APP-1', 'plan');
    addCard('APP-2', 'plan');
    const first = begin('APP-1', 'plan');
    const second = begin('APP-2', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', first));
    loop.scheduler.add(loop.buildJob('APP-2', 'plan', second));

    // Each card builds its checkout under the repository's lock, one after the other, so the second
    // line can come well after the first. Waited for on the activity itself.
    const both = () => loop.activity().filter((one) => one.line !== null).length === 2;
    await new Promise<void>((done) => {
      const look = (): void => {
        if (!both()) return;
        leave();
        done();
      };
      const leave = loop.onActivity(look);
      look();
    });
    // Each card in a folder of its own, inside the data folder, so a path read against the wrong one shows.
    expect(folders.get('APP-1')?.startsWith(`${dir}/`)).toBe(true);
    expect(folders.get('APP-2')).not.toBe(folders.get('APP-1'));
    const byRun = new Map(loop.activity().map((one) => [one.runId, one]));
    expect(byRun.get(Number(first))).toMatchObject({ cardKey: 'APP-1', line: 'Reading src/APP-1.ts' });
    expect(byRun.get(Number(second))).toMatchObject({ cardKey: 'APP-2', line: 'Reading src/APP-2.ts' });
    expect(told.every((one) => one.cardKey === (one.runId === Number(first) ? 'APP-1' : 'APP-2'))).toBe(true);

    release();
    await vi.waitFor(() => expect(readRun(loop.db, Number(second))?.state).toBe('complete'));
  });
});

// Quiet only changes what the card shows. The run ends on the run timeout, never on the quiet time.
it('gives a job the run timeout and not the quiet time', () => {
  addCard('APP-1');
  writeSetting(loop.db, 'quietAfterMs', 60_000);
  writeSetting(loop.db, 'runTimeoutMs', 45 * 60_000);

  expect(loop.buildJob('APP-1', 'plan', 7).timeoutMs).toBe(45 * 60_000);
});

describe('the plain summary after a run', () => {
  const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7', model: 'haiku', apiKeySource: 'none' });
  const DONE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, duration_ms: 10, usage: {} });
  const summaryOf = (runId: number) => (loop.db.prepare('SELECT plain_summary FROM runs WHERE id = ?').get(runId) as { plain_summary: string | null }).plain_summary;

  it('never takes a summary an earlier run of the phase left in the card folder', async () => {
    addCard('APP-1', 'refine');
    const runId = begin('APP-1', 'refine');
    const job = loop.buildJob('APP-1', 'refine', runId);
    mkdirSync(join(job.taskDir, 'refine'), { recursive: true });
    writeFileSync(join(job.taskDir, 'refine', 'summary.md'), 'What the first refine said.\n');
    // This run writes no summary, and the extraction pass says nothing.
    loop.engine.spawn = async function* (asked: Job) {
      if (asked.phase === 'extract-summary') return;
      yield INIT;
      yield DONE;
    };
    loop.scheduler.add(job);

    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('ready'));
    expect(summaryOf(runId)).toBeNull();
  });

  it('keeps the card running while the extraction pass holds its slot, so it cannot be dragged away', async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    loop.engine.spawn = async function* (asked: Job) {
      if (asked.phase === 'extract-summary') {
        await held;
        yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'The ticket is clearer now.' }] } });
        yield DONE;
        return;
      }
      yield INIT;
      yield DONE;
    };
    addCard('APP-1', 'refine');
    const runId = begin('APP-1', 'refine');
    loop.scheduler.add(loop.buildJob('APP-1', 'refine', runId));

    await vi.waitFor(() => expect(loop.db.prepare("SELECT count(*) AS n FROM runs WHERE phase = 'extract-summary'").get()).toEqual({ n: 1 }));
    expect(loop.snapshot().cards[0]?.state).toBe('running');
    release();

    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('ready'));
    expect(summaryOf(runId)).toBe('The ticket is clearer now.');
    // The card shows the phase run, not the pass.
    expect(loop.snapshot().cards[0]?.runId).toBe(runId);
  });
});

// A blocked card goes on in the session its question came from, as a new run whose prompt is the
// answer, so the question stays on the row that asked it.
describe('answering a blocked card', () => {
  const FAKE_QUESTION = /NOLZU: needs_input: ([^"\\]+)/.exec(readFileSync(new URL('../../../../packages/runner/fake/needs-input.ndjson', import.meta.url), 'utf8'))![1]!.trim();
  const FAKE_SESSION = 'e93a6d12-8b4f-4c07-a2d5-6f1e0c9b8a03';

  // Replays the needs-input scenario for the first run and the phase's own scenario after that, and
  // keeps every job the engine was handed.
  function blockFirstRun(): Job[] {
    const jobs: Job[] = [];
    const fake = loop.engine.spawn.bind(loop.engine);
    loop.engine.spawn = (job: Job, signal: AbortSignal) => {
      jobs.push(job);
      return fake(jobs.length === 1 ? { ...job, phase: 'needs-input' } : job, signal);
    };
    return jobs;
  }

  async function blockedCard(): Promise<{ jobs: Job[]; runId: number }> {
    const jobs = blockFirstRun();
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('blocked'));
    return { jobs, runId };
  }

  const runCount = () => (loop.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n;

  // An epic's body names its tasks by number alone, and the run cannot reach GitHub. The first run gets
  // their titles, read once; the answer resumes a session that has them already.
  it("gives a GitHub card's first run the titles of the issues its text names, and the resumed run none", async () => {
    let asked = 0;
    const gh: RunGh = async () => {
      asked += 1;
      return { code: 0, stdout: JSON.stringify({ data: { t0: { issueOrPullRequest: { __typename: 'Issue', number: 1, title: 'Tier limits', body: '', state: 'OPEN', url: null, parent: null } } } }), stderr: '' };
    };
    loop.close();
    loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { wall: WALL, gh });
    const jobs = blockFirstRun();
    loop.db
      .prepare("INSERT INTO cards (key, board, stage, state, title, summary, source, source_ref) VALUES ('app#5', 'delivery', 'plan', 'idle', 'Tiers', ?, 'github', 'acme/app#5')")
      .run('Members get tiers.\n\n- [ ] #1');
    const runId = begin('app#5', 'plan');
    loop.scheduler.add(loop.buildJob('app#5', 'plan', runId));
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('blocked'));
    expect(loop.answer('app#5', 'Titles only.')).toBe(true);
    await vi.waitFor(() => expect(jobs).toHaveLength(2));

    expect(jobs[0]?.prompt).toContain('## Issues the ticket names');
    expect(jobs[0]?.prompt).toContain('- #1: Tier limits');
    expect(jobs[1]?.prompt).not.toContain('## Issues the ticket names');
    expect(asked).toBe(1);
  });

  it('shows the question the engine asked, word for word', async () => {
    await blockedCard();

    expect(loop.snapshot().cards[0]?.question).toBe(FAKE_QUESTION);
  });

  it('continues the blocked session with the answer, as a new run, and queues the card', async () => {
    const jobs = blockFirstRun();
    addCard('APP-1', 'plan');
    // An older run of the card with its own session, so only the newest run can be the one that asked.
    const older = begin('APP-1', 'refine');
    loop.db.prepare("UPDATE runs SET state = 'complete', session_id = '0a0a0a0a-0000-4000-8000-000000000000' WHERE id = ?").run(older);
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('blocked'));

    expect(loop.answer('APP-1', 'Titles only.')).toBe(true);

    const newest = loop.db.prepare('SELECT id, phase FROM runs ORDER BY id DESC LIMIT 1').get() as { id: number; phase: string };
    expect(newest.id).not.toBe(runId);
    expect(newest.phase).toBe('plan');
    await vi.waitFor(() => expect(jobs).toHaveLength(2));
    expect(jobs[1]).toMatchObject({ runId: newest.id, phase: 'plan', resumeFrom: FAKE_SESSION, sessionId: null, prompt: expect.stringMatching(/^Titles only\.\n\n## Before you end\n[\s\S]*`plan\/summary\.md`/) });
    // The question stays on the run that asked it.
    expect(readRun(loop.db, runId)?.question).toBe(FAKE_QUESTION);
    // And the exchange is in the phase's thread, on the run that asked.
    const said = loop.db.prepare("SELECT author, body, run_id FROM messages WHERE card_key = 'APP-1' AND thread = 'plan' ORDER BY id").all();
    expect(said.slice(0, 2)).toEqual([
      { author: 'agent', body: FAKE_QUESTION, run_id: runId },
      { author: 'person', body: 'Titles only.', run_id: runId },
    ]);
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('ready'));
  });

  // A commit message asked for while the card waits is a newer row, and is not the run that asked.
  it('continues the asking session when a commit message pass ran after it', async () => {
    const jobs = blockFirstRun();
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('blocked'));
    startRun(loop.db, { cardKey: 'APP-1', phase: 'commit-message', engine: DEFAULT_PROFILE.id, model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });

    expect(loop.answer('APP-1', 'Titles only.')).toBe(true);

    await vi.waitFor(() => expect(jobs).toHaveLength(2));
    expect(jobs[1]).toMatchObject({ phase: 'plan', resumeFrom: FAKE_SESSION, prompt: expect.stringMatching(/^Titles only\.\n/) });
  });

  it('marks the card queued at once, before the run takes its slot', async () => {
    await blockedCard();
    const states: string[] = [];
    loop.onChange(() => states.push(loop.snapshot().cards[0]!.state));

    loop.answer('APP-1', 'Titles only.');

    expect(states[0]).toBe('queued');
  });

  it.each([
    ['idle', 'idle'],
    ['ready', 'ready'],
    ['queued', 'queued'],
  ])('refuses an answer to a card that is %s, names the state and writes nothing', (_, state) => {
    addCard('APP-1', 'plan');
    loop.db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(state, 'APP-1');
    const before = runCount();

    expect(() => loop.answer('APP-1', 'Titles only.')).toThrow(new RegExp(`is ${state}`));
    expect(runCount()).toBe(before);
    expect(loop.snapshot().cards[0]?.state).toBe(state);
  });

  it('refuses an answer to a card that is not there, and names it', () => {
    expect(() => loop.answer('APP-9', 'Titles only.')).toThrow(/APP-9/);
  });

  it.each(['', '   \n '])('refuses an empty answer %j and leaves the card blocked', async (text) => {
    await blockedCard();
    const before = runCount();

    expect(() => loop.answer('APP-1', text)).toThrow(/empty/);
    expect(runCount()).toBe(before);
    expect(loop.snapshot().cards[0]?.state).toBe('blocked');
  });

  // A card that stayed blocked for good could never be moved again. Failed can be moved, and says why.
  it('leaves the card failed and movable when the session cannot be continued', async () => {
    const { runId } = await blockedCard();
    loop.db.prepare('UPDATE runs SET session_id = NULL WHERE id = ?').run(runId);

    expect(loop.answer('APP-1', 'Titles only.')).toBe(false);

    const card = loop.snapshot().cards[0];
    expect(card?.state).toBe('failed');
    expect(card?.failureReason).toMatch(/session/);
    expect(loop.scheduler.queue().waiting).toHaveLength(0);
  });

  // The needs-input scenario for every run, with the question file a skill writes beside its question.
  // Written while the engine runs, the way a skill writes it, so the loop's own clean-up at the start
  // has already happened.
  function askWithFile(text: string | null): Job[] {
    const jobs: Job[] = [];
    const fake = loop.engine.spawn.bind(loop.engine);
    loop.engine.spawn = (job: Job, signal: AbortSignal) => {
      jobs.push(job);
      if (text !== null) {
        mkdirSync(join(job.taskDir, job.phase), { recursive: true });
        writeFileSync(join(job.taskDir, job.phase, 'question.md'), text);
      }
      return fake({ ...job, phase: 'needs-input' }, signal);
    };
    return jobs;
  }

  async function ask(): Promise<number> {
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('blocked'));
    return runId;
  }

  const STARS = { label: '1 to 5 stars', means: 'A new column in recipes, one migration' };
  const THUMBS = { label: 'Thumbs up and down', means: 'Reuses the likes table, no migration' };
  const optionsOf = (runId: number) => (loop.db.prepare('SELECT question_options FROM runs WHERE id = ?').get(runId) as { question_options: string | null }).question_options;

  it('keeps the answers the run offered beside its question', async () => {
    askWithFile(`- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}\n`);
    const runId = await ask();

    const card = loop.snapshot().cards[0];
    expect(card?.question).toBe(FAKE_QUESTION);
    expect(card?.questionOptions).toEqual([STARS, THUMBS]);
    expect(JSON.parse(optionsOf(runId)!)).toEqual([STARS, THUMBS]);
  });

  // The file sits in the folder of the phase that asked, and that is not always plan.
  it('reads the answers from the folder of the phase that asked', async () => {
    askWithFile(`- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}\n`);
    addCard('APP-1', 'refine');
    const runId = begin('APP-1', 'refine');
    loop.scheduler.add(loop.buildJob('APP-1', 'refine', runId));
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('blocked'));

    expect(loop.snapshot().cards[0]?.questionOptions).toEqual([STARS, THUMBS]);
  });

  // Two cards ask. The answers belong to the run that wrote them, in its own card folder, so the card
  // that offered none stays plain text beside the one that did.
  it('keeps the answers on the card whose run offered them', async () => {
    const fake = loop.engine.spawn.bind(loop.engine);
    loop.engine.spawn = (job: Job, signal: AbortSignal) => {
      if (job.cardKey === 'APP-2') {
        mkdirSync(join(job.taskDir, job.phase), { recursive: true });
        writeFileSync(join(job.taskDir, job.phase, 'question.md'), `- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}\n`);
      }
      return fake({ ...job, phase: 'needs-input' }, signal);
    };
    addCard('APP-1', 'plan');
    addCard('APP-2', 'plan');
    const plain = begin('APP-1', 'plan');
    const offered = begin('APP-2', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', plain));
    loop.scheduler.add(loop.buildJob('APP-2', 'plan', offered));
    await vi.waitFor(() => expect(loop.snapshot().cards.map((card) => card.state)).toEqual(['blocked', 'blocked']));

    const card = (key: string) => loop.snapshot().cards.find((one) => one.key === key);
    expect(card('APP-2')?.questionOptions).toEqual([STARS, THUMBS]);
    expect(card('APP-1')).not.toHaveProperty('questionOptions');
    expect(optionsOf(plain)).toBeNull();
  });

  // Half a list shown as the whole list would hide the answer the agent meant. Plain text is safe.
  it('keeps the question as plain text when the options file is broken', async () => {
    askWithFile(`- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}\n`);
    const runId = await ask();

    expect(loop.snapshot().cards[0]?.question).toBe(FAKE_QUESTION);
    expect(loop.snapshot().cards[0]).not.toHaveProperty('questionOptions');
    expect(optionsOf(runId)).toBeNull();
  });

  // A file from the last question of this phase is not this question's. The answer resumes the same
  // phase, so without the clean-up a second question would show the first one's buttons.
  it('drops the answers an earlier question left before the next run starts', async () => {
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    const job = loop.buildJob('APP-1', 'plan', runId);
    mkdirSync(join(job.taskDir, 'plan'), { recursive: true });
    writeFileSync(join(job.taskDir, 'plan', 'question.md'), `- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}\n`);
    askWithFile(null);
    loop.scheduler.add(job);
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('blocked'));

    expect(existsSync(join(job.taskDir, 'plan', 'question.md'))).toBe(false);
    expect(loop.snapshot().cards[0]).not.toHaveProperty('questionOptions');
    expect(optionsOf(runId)).toBeNull();
  });

  // The answer resumes the same phase, and the run it starts may ask again with nothing to offer.
  // The buttons of the first question must not come back under the second.
  it('drops the answers of the question an answer resumed from', async () => {
    const jobs: Job[] = [];
    const fake = loop.engine.spawn.bind(loop.engine);
    loop.engine.spawn = (job: Job, signal: AbortSignal) => {
      jobs.push(job);
      if (jobs.length === 1) {
        mkdirSync(join(job.taskDir, job.phase), { recursive: true });
        writeFileSync(join(job.taskDir, job.phase, 'question.md'), `- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}\n`);
      }
      return fake({ ...job, phase: 'needs-input' }, signal);
    };
    const first = await ask();
    expect(loop.snapshot().cards[0]?.questionOptions).toEqual([STARS, THUMBS]);

    expect(loop.answer('APP-1', THUMBS.label)).toBe(true);
    await vi.waitFor(() => {
      expect(jobs).toHaveLength(2);
      expect(loop.snapshot().cards[0]?.state).toBe('blocked');
    });

    const second = (loop.db.prepare('SELECT id FROM runs ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
    expect(second).not.toBe(first);
    expect(jobs[1]?.resumeFrom).not.toBeNull();
    expect(loop.snapshot().cards[0]).not.toHaveProperty('questionOptions');
    expect(optionsOf(second)).toBeNull();
    expect(JSON.parse(optionsOf(first)!)).toEqual([STARS, THUMBS]);
  });

  // The clean-up reads the folder of the card and the phase that run, not one card's plan folder.
  it('drops the old answers of any card and phase', async () => {
    addCard('APP-2', 'refine');
    const runId = begin('APP-2', 'refine');
    const job = loop.buildJob('APP-2', 'refine', runId);
    mkdirSync(join(job.taskDir, 'refine'), { recursive: true });
    writeFileSync(join(job.taskDir, 'refine', 'question.md'), `- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}\n`);
    askWithFile(null);
    loop.scheduler.add(job);
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('blocked'));

    expect(existsSync(join(job.taskDir, 'refine', 'question.md'))).toBe(false);
    expect(optionsOf(runId)).toBeNull();
  });

  // A run that finished is no question, even when the skill wrote the file first.
  it('stores no answers for a run that ends complete', async () => {
    const jobs: Job[] = [];
    const fake = loop.engine.spawn.bind(loop.engine);
    loop.engine.spawn = (job: Job, signal: AbortSignal) => {
      jobs.push(job);
      mkdirSync(join(job.taskDir, job.phase), { recursive: true });
      writeFileSync(join(job.taskDir, job.phase, 'question.md'), `- ${STARS.label}: ${STARS.means}\n- ${THUMBS.label}: ${THUMBS.means}\n`);
      return fake(job, signal);
    };
    addCard('APP-1', 'plan');
    const runId = begin('APP-1', 'plan');
    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('ready'));

    expect(jobs).toHaveLength(1);
    expect(optionsOf(runId)).toBeNull();
  });
});

describe('answering, when the run cannot be handed over', () => {
  // A card left queued with no job behind it refuses every move until a restart.
  it('fails the card with the reason instead of leaving it queued', () => {
    addCard('APP-1', 'plan');
    loop.db.prepare("UPDATE cards SET state = 'blocked' WHERE key = 'APP-1'").run();
    const asked = begin('APP-1', 'plan');
    loop.db.prepare("UPDATE runs SET state = 'complete', session_id = 'e93a6d12-8b4f-4c07-a2d5-6f1e0c9b8a03' WHERE id = ?").run(asked);
    loop.scheduler.add = () => {
      throw new Error('The queue is closed.');
    };

    expect(loop.answer('APP-1', 'Titles only.')).toBe(false);

    const card = loop.snapshot().cards[0];
    expect(card?.state).toBe('failed');
    expect(card?.failureReason).toContain('The queue is closed.');
  });
});

// A failed card starts the phase of its stage again, fresh, as a new run.
describe('retrying a failed card', () => {
  const failed = (key: string, stage: string) => {
    addCard(key, stage);
    loop.db.prepare("UPDATE cards SET state = 'failed' WHERE key = ?").run(key);
  };
  const runCount = () => (loop.db.prepare('SELECT count(*) AS n FROM runs').get() as { n: number }).n;

  it('queues one fresh run of the stage phase, and the board shows it queued at once', async () => {
    const jobs: Job[] = [];
    const fake = loop.engine.spawn.bind(loop.engine);
    loop.engine.spawn = (job: Job, signal: AbortSignal) => {
      jobs.push(job);
      return fake(job, signal);
    };
    failed('APP-1', 'plan');
    const states: string[] = [];
    loop.onChange(() => states.push(loop.snapshot().cards[0]!.state));

    expect(loop.retry('APP-1')).toBe(true);

    expect(states[0]).toBe('queued');
    expect(runCount()).toBe(1);
    await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('ready'));
    expect(jobs.filter((job) => job.phase === 'plan')).toHaveLength(1);
    // A fresh run: a failed session has nothing worth continuing.
    expect(jobs[0]).toMatchObject({ phase: 'plan', resumeFrom: null, sessionId: null });
  });

  it.each(['idle', 'ready', 'blocked', 'queued', 'running'])('refuses to retry a card that is %s, names the state and writes nothing', (state) => {
    addCard('APP-1', 'plan');
    loop.db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(state, 'APP-1');

    expect(() => loop.retry('APP-1')).toThrow(new RegExp(`is ${state}`));
    expect(runCount()).toBe(0);
    expect(loop.snapshot().cards[0]?.state).toBe(state);
  });

  // A stopped run leaves the card idle with nothing on the page that starts its stage again.
  it('starts the stage again on an idle card whose run in that stage was stopped', () => {
    addCard('APP-1', 'plan');
    const id = startRun(loop.db, { cardKey: 'APP-1', phase: 'plan', engine: DEFAULT_PROFILE.id, model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
    loop.db.prepare("UPDATE runs SET state = 'stopped' WHERE id = ?").run(id);
    loop.db.prepare("UPDATE cards SET state = 'idle' WHERE key = ?").run('APP-1');

    expect(loop.retry('APP-1')).toBe(true);
    expect(runCount()).toBe(2);
  });

  // A finished run leaves nothing to start again, and a run stopped in another stage, as on a card moved
  // back after the stop, would start a run nobody asked for.
  it.each([
    ['an idle card whose newest run finished', 'idle', 'plan', 'complete'],
    ['an idle card whose newest run was stopped in another stage', 'idle', 'implement', 'stopped'],
    ['a ready card whose newest run was stopped', 'ready', 'plan', 'stopped'],
  ])('refuses %s', (_, cardState, phase, state) => {
    addCard('APP-1', 'plan');
    const id = startRun(loop.db, { cardKey: 'APP-1', phase: phase as 'plan', engine: DEFAULT_PROFILE.id, model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
    loop.db.prepare('UPDATE runs SET state = ? WHERE id = ?').run(state, id);
    loop.db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(cardState, 'APP-1');

    expect(() => loop.retry('APP-1')).toThrow(new RegExp(`is ${cardState}`));
    expect(runCount()).toBe(1);
  });

  it('refuses to retry a card in a stage that starts no run, and says to move it instead', () => {
    failed('APP-1', 'review');

    expect(() => loop.retry('APP-1')).toThrow(/starts no run/);
    expect(runCount()).toBe(0);
  });

  it('refuses a card that is not there, and names it', () => {
    expect(() => loop.retry('APP-9')).toThrow(/APP-9/);
  });

  it('fails the card again with the reason when the run cannot be handed over', () => {
    failed('APP-1', 'plan');
    loop.scheduler.add = () => {
      throw new Error('The queue is closed.');
    };

    expect(loop.retry('APP-1')).toBe(false);
    expect(loop.snapshot().cards[0]?.failureReason).toContain('The queue is closed.');
    expect(loop.snapshot().cards[0]?.state).toBe('failed');
  });
});

// A card's own models reach the job, card over project over preset.
describe('the models a job runs on', () => {
  it('runs a phase on the card override, and the rest on the preset', () => {
    addCard('APP-1', 'plan');
    setCardModels(loop.db, 'APP-1', { plan: { engine: 'claude-code', model: 'opus', effort: 'high' } });

    expect(loop.buildJob('APP-1', 'plan', 1)).toMatchObject({ model: 'opus', effort: 'high' });
    expect(loop.buildJob('APP-1', 'implement', 1)).toMatchObject({ model: 'sonnet', effort: 'medium' });
  });

  it('runs a phase on the project value when the card leaves it alone', () => {
    addCard('APP-1', 'plan');
    writeSetting(loop.db, 'models', { plan: { effort: 'high' } });

    expect(loop.buildJob('APP-1', 'plan', 1)).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('refuses to start on a model the engine no longer offers, and names the tab that fixes it', () => {
    addCard('APP-1', 'plan');
    setCardModels(loop.db, 'APP-1', { plan: { engine: 'claude-code', model: 'sonnet-3' } });

    expect(() => loop.buildJob('APP-1', 'plan', 1)).toThrow(/sonnet-3.*Settings tab/);
  });

  it('refuses to start on an engine this version cannot run', () => {
    addCard('APP-1', 'plan');
    setCardModels(loop.db, 'APP-1', { plan: { engine: 'codex', model: 'gpt-9' } });

    expect(() => loop.buildJob('APP-1', 'plan', 1)).toThrow(/codex.*Settings tab/);
  });

  it('runs the summary pass on its own row', async () => {
    const jobs: Job[] = [];
    loop.engine.spawn = async function* (job: Job) {
      jobs.push(job);
      if (job.phase === 'extract-summary') return;
      yield JSON.stringify({ type: 'system', subtype: 'init', session_id: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7', model: 'sonnet', apiKeySource: 'none' });
      yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
    };
    addCard('APP-1', 'plan');
    setCardModels(loop.db, 'APP-1', { 'extract-summary': { engine: 'claude-code', model: 'haiku', effort: 'medium' } });
    const runId = begin('APP-1', 'plan');

    loop.scheduler.add(loop.buildJob('APP-1', 'plan', runId));

    await vi.waitFor(() => expect(jobs.find((job) => job.phase === 'extract-summary')).toMatchObject({ model: 'haiku', effort: 'medium' }));
  });
});

// The snapshot and the per-card reader the move endpoint uses draw the same Delivery board: PR watch
// after review, and no Merge.
it('draws pr watch and no merge for every snapshot and every move', () => {
  addCard('APP-9');
  for (const ids of [loop.snapshot().stages, loop.boardOf('APP-9').stages].map((stages) => stages.map((stage) => stage.id))) {
    expect(ids).toContain('pr-watch');
    expect(ids).not.toContain('merge');
  }
});

describe('a message in a discussion thread', () => {
  // A finished run, which is what gives a thread its session and its profile.
  const ranPlan = (sessionId = 's-2', engine = 'claude-code'): number => {
    const id = startRun(loop.db, {
      cardKey: 'APP-1',
      phase: 'plan',
      engine,
      model: 'sonnet',
      effort: 'medium',
      sessionId,
      logPath: '',
      lane: null,
    });
    loop.db.prepare("UPDATE runs SET state = 'complete' WHERE id = ?").run(id);
    return id;
  };
  const thread = (over: Record<string, unknown> = {}) => ({ id: 'plan', sessionId: 's-2', engine: 'claude-code', ...over });
  const runsNow = () => (loop.db.prepare('SELECT count(*) as n FROM runs').get() as { n: number }).n;
  const setState = (state: string) => loop.db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(state, 'APP-1');

  beforeEach(() => {
    addCard('APP-1', 'plan');
    loop.db.prepare("UPDATE cards SET state = 'ready' WHERE key = ?").run('APP-1');
  });

  // The effect, not the call: a run row that names the thread's own session and its own profile.
  it('continues the thread session on the profile the run recorded', () => {
    writeSetting(loop.db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/nolzu-loop-codex' }]);
    ranPlan('s-2', 'codex#work');

    expect(loop.discuss('APP-1', thread({ engine: 'codex#work' }), 'use the other index')).toBe(true);

    const row = loop.db.prepare('SELECT phase, engine, session_id FROM runs ORDER BY id DESC LIMIT 1').get() as {
      phase: string;
      engine: string;
      session_id: string | null;
    };
    expect(row.phase).toBe('plan');
    // The profile off the thread, not the one the action table names now.
    expect(row.engine).toBe('codex#work');
    expect(row.session_id).toBe('s-2');
  });

  it('takes the model picked for this one message', () => {
    ranPlan();

    loop.discuss('APP-1', thread(), 'try haiku', 'haiku');

    const row = loop.db.prepare('SELECT model FROM runs ORDER BY id DESC LIMIT 1').get() as { model: string };
    expect(row.model).toBe('haiku');
  });

  // Every state a card can be in that must not take a message, and none of them starts a run.
  // `restart` writes `queued` whatever the card was, so a message into a blocked card would clear
  // the question nobody had answered.
  it.each(['queued', 'running', 'blocked', 'failed'])('refuses a card that is %s, and starts nothing', (state) => {
    ranPlan();
    const before = runsNow();
    setState(state);

    expect(() => loop.discuss('APP-1', thread(), 'go on')).toThrow(new RegExp(state));
    expect(runsNow()).toBe(before);
  });

  // A review ref belongs to no phase, so a message in it continues nothing. An ask discussion starts
  // a read-only session of its own, which `ask-run.test.ts` covers.
  it('refuses a thread that starts no run', () => {
    ranPlan();
    const before = runsNow();

    expect(() => loop.discuss('APP-1', thread({ id: 'F1', sessionId: null, engine: null }), 'a note')).toThrow(
      /starts no run/,
    );
    expect(runsNow()).toBe(before);
  });

  it('refuses a card that is not there', () => {
    expect(() => loop.discuss('APP-9', thread(), 'hello')).toThrow(/no card APP-9/);
  });

  // A thread with no session cannot continue one. The run row is written and fails with the
  // reason, which is what a person reads on the card.
  it('fails the card with the reason when the thread kept no session', () => {
    ranPlan();

    expect(loop.discuss('APP-1', thread({ sessionId: null }), 'go on')).toBe(false);

    const row = loop.db.prepare('SELECT error FROM runs ORDER BY id DESC LIMIT 1').get() as { error: string | null };
    expect(row.error).toMatch(/session/i);
  });
});

// Claude Code reads the method from the same file as every other engine, built from the installed
// skill. The slash command it once got opened the copy committed in the project, which kept the old
// method after every upgrade until someone wrote the project files again and committed them.
it('hands a Claude Code run the phase method as a file, like every other engine', () => {
  addCard('APP-1');
  writeSetting(loop.db, 'projectPath', '/work/recipes');

  const job = loop.buildJob('APP-1', 'refine', 3);

  expect(job.instructions).toContain('refine phase');
  expect(job.instructions).toContain('<card folder>/refine/refined.md');
  expect(job.prompt.split('\n')[0]).toBe('Read `../../.tasks/APP-1/refine/instructions.md` first. It holds the method for this phase, and this run follows it.');
  expect(job.prompt).not.toContain('/nolzu-');
});

// A skill the person changed in the project's own skills folder is the method, on every engine. One
// that is still what Nolzu last wrote there is an old copy, and the installed skill wins over it.
describe('a phase skill the person edited in the project', () => {
  let project = '';
  const skillsDir = () => join(project, '.claude', 'skills');
  const put = (path: string, text: string) => {
    mkdirSync(join(skillsDir(), path, '..'), { recursive: true });
    writeFileSync(join(skillsDir(), path), text);
  };
  const record = (paths: Record<string, string>) =>
    writeFileSync(join(skillsDir(), '.nolzu-skills.json'), JSON.stringify(Object.fromEntries(Object.entries(paths).map(([path, text]) => [path, createHash('sha256').update(text).digest('hex')]))));
  const jobOn = (engine?: string) => {
    if (engine !== undefined) {
      bothProfiles();
      writeSetting(loop.db, 'models', { refine: { engine, model: 'gpt-5.6-terra' } });
    }
    writeSetting(loop.db, 'projectPath', project);
    addCard('APP-1');
    return loop.buildJob('APP-1', 'refine', 1);
  };
  const OLD = '---\nname: nolzu-refine\n---\nAn old refine method. See [finish](finish.md).\n';
  const MINE = '---\nname: nolzu-refine\n---\nMy own refine method. See [finish](finish.md) and [style](style.md).\n';

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'nolzu-loop-skills-'));
  });
  afterEach(() => rmSync(project, { recursive: true, force: true }));

  it('uses the edited skill, and the shipped copy of a linked file the project does not change', () => {
    put('nolzu-refine/SKILL.md', MINE);
    put('nolzu-refine/style.md', 'Short sentences.\n');
    record({ 'nolzu-refine/SKILL.md': OLD });

    const job = jobOn();

    expect(job.instructions).toContain('My own refine method.');
    expect(job.instructions).toContain("They come from this project's own copy in .claude/skills/nolzu-refine");
    expect(job.instructions).toContain('Linked file: style.md\n\nShort sentences.');
    // finish.md is not in the project folder, so the shipped one is copied in.
    expect(job.instructions).toContain('Linked file: finish.md');
    expect(job.instructions).not.toContain('<card folder>/refine/refined.md');
  });

  it('takes the edit from .claude when .agents has none, and names that folder', () => {
    put('nolzu-refine/SKILL.md', OLD);
    record({ 'nolzu-refine/SKILL.md': OLD });
    mkdirSync(join(project, '.claude', 'skills', 'nolzu-refine'), { recursive: true });
    writeFileSync(join(project, '.claude', 'skills', 'nolzu-refine', 'SKILL.md'), MINE);

    const job = jobOn();

    expect(job.instructions).toContain('My own refine method.');
    expect(job.instructions).toContain("They come from this project's own copy in .claude/skills/nolzu-refine, which");
  });

  it('hands a Codex run the same edited skill', () => {
    put('nolzu-refine/SKILL.md', MINE);
    record({});

    expect(jobOn(CODEX.id).instructions).toContain('My own refine method.');
  });

  it('ignores a copy that is still what Nolzu last wrote', () => {
    put('nolzu-refine/SKILL.md', OLD);
    record({ 'nolzu-refine/SKILL.md': OLD });

    const job = jobOn();

    expect(job.instructions).not.toContain('An old refine method.');
    expect(job.instructions).not.toContain("this project's own copy");
    expect(job.instructions).toContain('<card folder>/refine/refined.md');
  });

  // No record means Nolzu never wrote this folder, so every file in it is the person's, as the sync
  // itself reads it.
  it('takes a changed skill as the person\'s when there is no record at all', () => {
    put('nolzu-refine/SKILL.md', MINE);

    expect(jobOn().instructions).toContain('My own refine method.');
  });
});

// Codex finds no skill, so the method travels on the job. Without it such a run gets the card and
// no method, and it invents its own shape for the brief.
it('hands a Codex run the phase method, built from the skill', () => {
  bothProfiles();
  writeSetting(loop.db, 'models', { refine: { engine: CODEX.id, model: 'gpt-5.6-terra' } });
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  addCard('APP-1');

  const job = loop.buildJob('APP-1', 'refine', 1);

  // The words are the refine skill's own, so a run reading this file has the whole method.
  expect(job.instructions).toContain('refine phase');
  expect(job.instructions).toContain('<card folder>/refine/refined.md');
  // The run starts in the checkout, so the method file is named from there.
  expect(job.prompt.split('\n')[0]).toBe('Read `../../.tasks/APP-1/refine/instructions.md` first. It holds the method for this phase, and this run follows it.');
});

/**
 * A read-only phase on Codex starts in the checkout, like on every other engine.
 *
 * Codex runs inside Nolzu's wall with its own sandbox off, and the wall holds the run to the card
 * folder. The job says where the process starts, so the paths in the prompt and the spawn agree.
 */
it('leaves a Codex refine run in the checkout, inside the wall', () => {
  bothProfiles();
  writeSetting(loop.db, 'models', { refine: { engine: CODEX.id, model: 'gpt-5.6-terra' } });
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  addCard('APP-1');

  const job = loop.buildJob('APP-1', 'refine', 1);

  expect(job.prompt).toContain('The card folder is `../../.tasks/APP-1/`');
  expect(job.prompt).not.toContain('the project is at');
  expect(job.cwd).toBe('/work/recipes/worktrees/APP-1');
  expect(job.startsInCardFolder).toBe(false);
});

/**
 * A resume of a run made when Codex still held a read-only phase in the card folder.
 *
 * That session wrote its paths from the card folder, so it resumes there, and the prompt names the
 * project beside it as it did then. A row made before the column has no answer of its own, so the
 * rule of that day answers for it. A row made under the wall says the checkout, and resumes there.
 */
it('resumes an old Codex card folder run in the card folder, and a new one in the checkout', () => {
  bothProfiles();
  writeSetting(loop.db, 'models', { refine: { engine: CODEX.id, model: 'gpt-5.6-terra' } });
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  addCard('APP-1');
  const row = (sessionId: string) => startRun(loop.db, { cardKey: 'APP-1', phase: 'refine', engine: CODEX.id, model: 'gpt-5.6-terra', effort: 'low', sessionId, logPath: '', lane: null });
  loop.db.prepare('UPDATE runs SET cwd = ? WHERE id = ?').run('/work/recipes/worktrees/APP-1', row('old-1'));
  loop.db.prepare('UPDATE runs SET cwd = ?, in_card_folder = 0 WHERE id = ?').run('/work/recipes/worktrees/APP-1', row('new-1'));

  const old = loop.buildJob('APP-1', 'refine', 5, null, CODEX.id, null, 'old-1');
  expect(old.startsInCardFolder).toBe(true);
  expect(old.prompt).toContain('The card folder is `./`');
  expect(old.prompt).toContain('the project is at `../../worktrees/APP-1/`');
  expect(old.cwd).toBe('/work/recipes/worktrees/APP-1');

  const fresh = loop.buildJob('APP-1', 'refine', 6, null, CODEX.id, null, 'new-1');
  expect(fresh.startsInCardFolder).toBe(false);
  expect(fresh.prompt).toContain('The card folder is `../../.tasks/APP-1/`');
});

// The run row keeps where the process started, so a later resume starts there too.
it('records on the run row whether a Codex run started in the card folder, on an answer and on an Ask', async () => {
  bothProfiles();
  writeSetting(loop.db, 'models', { refine: { engine: CODEX.id, model: 'gpt-5.6-terra' } });
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  addCard('APP-1');
  const old = startRun(loop.db, { cardKey: 'APP-1', phase: 'refine', engine: CODEX.id, model: 'gpt-5.6-terra', effort: 'low', sessionId: 'old-1', logPath: '', lane: null });
  // A run of the old rule, which started in the card folder.
  loop.db.prepare("UPDATE runs SET in_card_folder = 1, state = 'complete' WHERE id = ?").run(old);
  loop.db.prepare("UPDATE cards SET state = 'blocked' WHERE key = 'APP-1'").run();
  const last = () => loop.db.prepare('SELECT in_card_folder AS v FROM runs ORDER BY id DESC LIMIT 1').get();

  expect(loop.answer('APP-1', 'Yes.')).toBe(true);
  expect(last()).toEqual({ v: 1 });

  loop.discuss('APP-1', { id: 'ask', sessionId: 'old-1', engine: CODEX.id }, 'Where does the list come from?');
  expect(last()).toEqual({ v: 1 });
  await loop.shutdown();
});

// The row says which wall held the run. The fake engine runs inside this process, so its rows say
// none; the mapping for real engines is `wallKind`'s test.
it('stores the wall on the run row, on an answer and on an Ask', async () => {
  bothProfiles();
  writeSetting(loop.db, 'models', { refine: { engine: CODEX.id, model: 'gpt-5.6-terra' } });
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  addCard('APP-1');
  const old = startRun(loop.db, { cardKey: 'APP-1', phase: 'refine', engine: CODEX.id, model: 'gpt-5.6-terra', effort: 'low', sessionId: 'old-1', logPath: '', lane: null });
  loop.db.prepare("UPDATE runs SET state = 'complete' WHERE id = ?").run(old);
  loop.db.prepare("UPDATE cards SET state = 'blocked' WHERE key = 'APP-1'").run();
  const walls = () => loop.db.prepare('SELECT wall FROM runs ORDER BY id').all().map((one) => one.wall);

  expect(loop.answer('APP-1', 'Yes.')).toBe(true);
  loop.discuss('APP-1', { id: 'ask', sessionId: 'old-1', engine: CODEX.id }, 'Where does the list come from?');
  expect(walls()).toEqual([null, 'none', 'none']);
  await loop.shutdown();
});

// Outside fake mode the row reads the real probe. Pinned to a wall that cannot start, a Claude Code
// row says none; a row that ignored the probe would say macos or bubblewrap. No slot is free, so no
// engine starts.
it('stores the wall the probe found on a real engine row', () => {
  const folder = mkdtempSync(join(tmpdir(), 'nolzu-loop-probe-'));
  const real = createLoop(folder, {}, { wall: NO_WALL });
  try {
    writeSetting(real.db, 'projectPath', folder);
    real.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'refine', 'idle', 'A card')").run();
    real.scheduler.resize(0);
    expect(real.start('APP-1', 'refine')).toBe(true);
    expect(real.db.prepare('SELECT wall FROM runs').all()).toEqual([{ wall: 'none' }]);
  } finally {
    real.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Another card with the same session id must not answer for this one.
it('reads where a resumed session started from its own card', () => {
  bothProfiles();
  writeSetting(loop.db, 'models', { refine: { engine: CODEX.id, model: 'gpt-5.6-terra' } });
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  addCard('APP-1');
  addCard('APP-2');
  const row = (cardKey: string) => startRun(loop.db, { cardKey, phase: 'refine', engine: CODEX.id, model: 'gpt-5.6-terra', effort: 'low', sessionId: 'shared', logPath: '', lane: null });
  loop.db.prepare('UPDATE runs SET in_card_folder = 0 WHERE id = ?').run(row('APP-1'));
  row('APP-2'); // an old row: in_card_folder is NULL

  expect(loop.buildJob('APP-2', 'refine', 5, null, CODEX.id, null, 'shared').startsInCardFolder).toBe(true);
});

// The other path of the same rule. Implement may change the project, so it starts in the checkout
// and the prompt reaches the card folder from there.
it('leaves a Codex implement run in the checkout', () => {
  bothProfiles();
  writeSetting(loop.db, 'models', { implement: { engine: CODEX.id, model: 'gpt-5.6-terra' } });
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  addCard('APP-1');

  const job = loop.buildJob('APP-1', 'implement', 1);

  expect(job.prompt).toContain('The card folder is `../../.tasks/APP-1/`');
  expect(job.prompt).not.toContain('You start in the card folder');
});

// Claude Code holds a read-only run with its own guard, and that guard lets the run write its notes
// in the card folder, so nothing moves its working folder.
it('leaves a Claude Code refine run in the checkout', () => {
  addCard('APP-1');
  writeSetting(loop.db, 'projectPath', '/work/recipes');

  const job = loop.buildJob('APP-1', 'refine', 3);

  expect(job.prompt).toContain('The card folder is `../../.tasks/APP-1/`');
  expect(job.prompt).not.toContain('You start in the card folder');
});

// With no method the run would spend the person's quota on the card alone. It is refused before it
// starts instead, on every engine.
it('refuses a Codex run when it cannot read the skill the phase needs', () => {
  bothProfiles();
  writeSetting(loop.db, 'models', { refine: { engine: CODEX.id, model: 'gpt-5.6-terra' } });
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  addCard('APP-1');
  skills.unreadable = true;
  try {
    expect(() => loop.buildJob('APP-1', 'refine', 1)).toThrow(/refine skill/);
  } finally {
    skills.unreadable = false;
  }
});

// Claude Code reads the same file now, so the same unreadable folder refuses its run too.
it('refuses a Claude Code run when it cannot read the skill the phase needs', () => {
  addCard('APP-1');
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  skills.unreadable = true;
  try {
    expect(() => loop.buildJob('APP-1', 'refine', 3)).toThrow(/refine skill/);
  } finally {
    skills.unreadable = false;
  }
});

/**
 * Each action row names the engine profile it runs on.
 *
 * The runs here are the fake engine's, which replays Claude Code's own lines whatever profile a row
 * names, so both profiles answer with the same model list. That is enough to prove the routing: the
 * job, the adapter and the run row all follow the profile. A run of two real vendors on one card
 * costs real quota, so no test makes one.
 */
describe('an engine profile per action row', () => {
  const runRows = () =>
    loop.db.prepare('SELECT phase, engine FROM runs ORDER BY id').all() as unknown as { phase: string; engine: string }[];
  const settled = (key: string) => vi.waitFor(() => expect(loop.snapshot().cards.find((card) => card.key === key)?.state).toBe('ready'));
  // Every job the engine was handed, with the vendor of the adapter that was handed it. One fake
  // engine serves every vendor, so without the vendor nothing here could tell whether a job ran on
  // the adapter of its own profile or on the one every row falls back to.
  const spawned = (): { job: Job; vendor: string }[] => {
    const runs: { job: Job; vendor: string }[] = [];
    const replay = loop.engine.spawn.bind(loop.engine);
    loop.engine.spawn = function (this: Engine, job: Job, signal: AbortSignal) {
      runs.push({ job, vendor: this.vendor });
      return replay(job, signal);
    };
    return runs;
  };

  // The routing in miniature: one card, two actions, two logins, read back off the run rows.
  it('runs refine on one profile and plan on another, and each run row names its own', async () => {
    bothProfiles();
    writeSetting(loop.db, 'models', { plan: { engine: 'codex#work', model: 'gpt-5.6-sol' } });
    addCard('APP-1', 'refine');
    const jobs = spawned();

    expect(loop.start('APP-1', 'refine')).toBe(true);
    await settled('APP-1');
    expect(loop.start('APP-1', 'plan')).toBe(true);
    await settled('APP-1');

    expect(runRows()).toEqual([
      { phase: 'refine', engine: 'claude-code' },
      { phase: 'plan', engine: 'codex#work' },
    ]);
    expect(jobs.map((one) => [one.job.phase, one.job.engine, one.job.model])).toEqual([
      ['refine', 'claude-code', 'haiku'],
      ['plan', 'codex#work', 'gpt-5.6-sol'],
    ]);
    // The adapter each job was handed, which is what makes the profile more than a label on a row.
    expect(jobs.map((one) => one.vendor)).toEqual(['claude-code', 'codex']);
    // Where each run started, written on the row. A row left empty would resume by the old rule,
    // which sends a Codex plan session to the card folder it never started in.
    expect(loop.db.prepare('SELECT phase, in_card_folder FROM runs ORDER BY id').all()).toEqual([
      { phase: 'refine', in_card_folder: 0 },
      { phase: 'plan', in_card_folder: 0 },
    ]);
  });

  // The summary pass is a run of its own, on the row it has of its own. Without this the pass took
  // the profile of the phase it summarises and nothing said so.
  it('runs the summary pass on its own row\'s profile', async () => {
    bothProfiles();
    writeSetting(loop.db, 'models', { 'extract-summary': { engine: 'codex#work', model: 'gpt-5.6-luna' } });
    addCard('APP-1', 'refine');
    const jobs: { job: Job; vendor: string }[] = [];
    // A run that writes no summary file, which is what the extraction pass is for.
    loop.engine.spawn = async function* (this: Engine, job: Job) {
      jobs.push({ job, vendor: this.vendor });
      yield JSON.stringify({ type: 'system', subtype: 'init', session_id: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7', model: 'sonnet', apiKeySource: 'none' });
      yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
    };

    expect(loop.start('APP-1', 'refine')).toBe(true);
    await settled('APP-1');

    const summary = jobs.find((one) => one.job.phase === 'extract-summary');
    expect(summary?.job.engine).toBe('codex#work');
    expect(summary?.vendor).toBe('codex');
    expect(runRows()).toContainEqual({ phase: 'extract-summary', engine: 'codex#work' });
  });

  // The refusal of a profile with no login, through the screens that read it. A person who removed a login
  // still has the row, and nothing about it starts.
  it('refuses a row whose profile was removed, and names the profile', () => {
    bothProfiles();
    writeSetting(loop.db, 'models', { plan: { engine: 'codex#work', model: 'opus' } });
    addCard('APP-1', 'plan');
    writeSetting(loop.db, 'engineProfiles', [DEFAULT_PROFILE]);

    // What the board reads to refuse the drop, before anything is sent.
    expect(loop.snapshot().stages.find((stage) => stage.id === 'plan')?.starts).toMatchObject({ modelState: 'no-profile', engine: 'codex#work' });
    expect(loop.start('APP-1', 'plan')).toBe(false);
    expect(loop.snapshot().cards[0]?.failureReason).toContain('codex#work');
  });

  // The hole this change closes. The table moves the phase to another profile between the run and
  // the message, and the resume still runs a model the login that holds the session can run.
  it('resumes on the profile that holds the session, with a model of that profile', async () => {
    bothProfiles();
    addCard('APP-1', 'plan');
    const jobs = spawned();
    expect(loop.start('APP-1', 'plan')).toBe(true);
    await settled('APP-1');
    const first = loop.db.prepare('SELECT engine, session_id FROM runs ORDER BY id DESC LIMIT 1').get() as {
      engine: string;
      session_id: string;
    };

    // Somebody moves the plan row to the other login, and to a model they picked there.
    writeSetting(loop.db, 'models', { plan: { engine: 'codex#work', model: 'opus' } });

    expect(loop.discuss('APP-1', { id: 'plan', sessionId: first.session_id, engine: first.engine }, 'go on')).toBe(true);
    await settled('APP-1');

    const resumed = loop.db.prepare('SELECT engine FROM runs ORDER BY id DESC LIMIT 1').get() as { engine: string };
    expect(resumed.engine).toBe('claude-code');
    // The preset's model under that profile, not the opus the Codex row now names.
    expect(jobs.map((one) => [one.job.engine, one.job.model])).toEqual([
      ['claude-code', 'sonnet'],
      ['claude-code', 'sonnet'],
    ]);
    expect(jobs.map((one) => one.vendor)).toEqual(['claude-code', 'claude-code']);
  });

  // The model the person picked in the composer is the one the run uses, so it is the one the
  // check reads. Measured against the table instead, a resume refused the very model they chose.
  it('resumes on the model the message carries, not the one the table resolves', async () => {
    bothProfiles();
    addCard('APP-1', 'plan');
    setCardModels(loop.db, 'APP-1', { plan: { engine: 'codex#work', model: 'gpt-5.6-terra' } });
    const jobs = spawned();
    expect(loop.start('APP-1', 'plan')).toBe(true);
    await settled('APP-1');
    const first = loop.db.prepare('SELECT session_id FROM runs ORDER BY id DESC LIMIT 1').get() as { session_id: string };

    // The row moves to a model this engine does not offer, which is what the table says by the time
    // the message arrives. The person picked one the composer offered, and that one is the run's.
    setCardModels(loop.db, 'APP-1', { plan: { engine: 'codex#work', model: 'gpt-9' } });

    expect(loop.discuss('APP-1', { id: 'plan', sessionId: first.session_id, engine: 'codex#work' }, 'go on', 'gpt-5.6-terra')).toBe(true);
    await settled('APP-1');

    expect(jobs.map((one) => [one.job.engine, one.job.model, one.vendor])).toEqual([
      ['codex#work', 'gpt-5.6-terra', 'codex'],
      ['codex#work', 'gpt-5.6-terra', 'codex'],
    ]);
  });

  // A model nobody's login offers is still refused, wherever it came from.
  it('refuses a message model the profile does not offer', () => {
    bothProfiles();
    addCard('APP-1', 'plan');

    expect(() => loop.buildJob('APP-1', 'plan', 1, null, 'codex#work', 'gpt-9')).toThrow(/gpt-9.*Settings tab/);
  });

  // A thread whose login was removed. The message fails the card with the profile named, rather
  // than resuming on some other login that never held the session.
  it('fails a message in a thread whose profile was removed, and names it', () => {
    bothProfiles();
    addCard('APP-1', 'plan');

    expect(loop.discuss('APP-1', { id: 'plan', sessionId: 'b7f0c1d2-1f2e-4a3b-8c4d-5e6f7a8b9c0d', engine: 'codex#gone' }, 'go on')).toBe(false);

    const row = loop.db.prepare('SELECT error FROM runs ORDER BY id DESC LIMIT 1').get() as { error: string | null };
    expect(row.error).toContain('codex#gone');
  });
});

/**
 * The vendor rule is asked where every run is built, not only where a person drags.
 *
 * A chained advance, Retry, an answer to a blocked card and a discussion message never pass a drop
 * target. Without this gate such a run reaches the spawn, and by then it has a run row, a branch
 * and a checkout of its own.
 */
it('refuses a run whose vendor cannot run the phase where the wall cannot start, before anything is made', () => {
  const folder = mkdtempSync(join(tmpdir(), 'nolzu-loop-nowall-'));
  createLoop(folder, {}).close();
  const bare = createLoop(folder, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { wall: NO_WALL });
  try {
    bare.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'inbox', 'idle', 'A card')").run();
    writeSetting(bare.db, 'projectPath', '/work/recipes');
    writeSetting(bare.db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR, CODEX]);
    setCardModels(bare.db, 'APP-1', { plan: { engine: CURSOR.id, model: 'composer-2.5' }, qa: { engine: CODEX.id, model: 'gpt-5.6-terra' }, refine: { engine: CODEX.id, model: 'gpt-5.6-terra' } });

    expect(() => bare.buildJob('APP-1', 'plan', 1)).toThrow(/only Nolzu's wall holds Cursor to reading/);
    // The sentence names the card and the profile, so a person who never saw the board knows which
    // row to change.
    expect(() => bare.buildJob('APP-1', 'plan', 1)).toThrow(/APP-1 cannot run plan on cursor#work/);
    // Codex falls back to its own sandbox and runs QA on its throwaway copy.
    const qa = bare.buildJob('APP-1', 'qa', 2);
    expect(qa.engine).toBe(CODEX.id);
    expect(qa.qaCopy).toEqual(expect.any(String));
    // A read-only phase that writes notes starts in the card folder.
    const refine = bare.buildJob('APP-1', 'refine', 3);
    expect(refine.startsInCardFolder).toBe(true);
    expect(refine.prompt).toContain('The card folder is `./`');
  } finally {
    bare.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Where the wall starts, the same rows build their jobs.
it('builds a read-only Cursor job and a Codex QA job inside the wall', () => {
  addCard('APP-1');
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  writeSetting(loop.db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR, CODEX]);
  setCardModels(loop.db, 'APP-1', { plan: { engine: CURSOR.id, model: 'composer-2.5' }, qa: { engine: CODEX.id, model: 'gpt-5.6-terra' } });

  expect(loop.buildJob('APP-1', 'plan', 1).engine).toBe(CURSOR.id);
  expect(loop.buildJob('APP-1', 'qa', 2).engine).toBe(CODEX.id);
});

// The other path. Implement is the phase Cursor runs, so the same profile builds a job.
it('builds a job on the phase that vendor can run', () => {
  addCard('APP-1');
  writeSetting(loop.db, 'projectPath', '/work/recipes');
  writeSetting(loop.db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
  setCardModels(loop.db, 'APP-1', { implement: { engine: CURSOR.id, model: 'composer-2.5' } });

  expect(loop.buildJob('APP-1', 'implement', 1).engine).toBe(CURSOR.id);
});

/**
 * A card is read against its own board.
 *
 * `plan` and `review` are stages of Epics as well as of Delivery, and `wrapup` is on four of the
 * five, so a card read against the Delivery board answers about another board's columns rather than
 * answering nothing. The move endpoint, the chain after a finished run and Retry all go through
 * here.
 */
it('answers with the board a card is on, not with Delivery', () => {
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('EPIC-1', 'epics', 'plan', 'idle', 'A search that finds recipes')").run();

  expect(loop.boardOf('EPIC-1').kind).toBe('epics');
  expect(loop.boardOf('EPIC-1').stages.map((stage) => stage.id)).toContain('architecture');
});

// The other side. A Delivery card still reads against Delivery, flow and all.
it('answers with Delivery for a Delivery card', () => {
  addCard('APP-1');

  expect(loop.boardOf('APP-1').kind).toBe('delivery');
});

// A card that is gone answers with Delivery, because the caller is about to find no card either and
// the board it asked with changes nothing about that.
it('answers with Delivery for a card that is not there', () => {
  expect(loop.boardOf('APP-404').kind).toBe('delivery');
});

/**
 * Retry reads the phase off the card's own board.
 *
 * Architecture is a stage of Epics and of no other board, so a retry read against Delivery would
 * have found no stage and refused a card that has a perfectly good phase to run again.
 */
it('retries the phase of the card own board', () => {
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('EPIC-2', 'epics', 'architecture', 'failed', 'A search that finds recipes')").run();

  expect(loop.retry('EPIC-2')).toBe(true);

  // The run row, not the end of the run: the fake engine has no recording of this phase, and what
  // this is about is which phase the retry chose.
  expect(readRun(loop.db, 1)?.phase).toBe('architecture');
});

// The other side: a stage that starts nothing still refuses, whatever board it is on.
it('refuses a retry on a stage that starts no phase', () => {
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('EPIC-3', 'epics', 'in-delivery', 'failed', 'A search that finds recipes')").run();

  expect(() => loop.retry('EPIC-3')).toThrow(/starts no run/);
});

/**
 * A finished run on Epics goes on by itself only onto a person's column. Refine leads to Architecture,
 * an agent column whose run costs money, so the card stays on Refine, ready for a person to drag. Plan
 * leads to Review, where nothing starts, so the card moves there and reads ready for the person.
 */
describe('the chains of Epics', () => {
  const epic = (stage: string) => loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('EPIC-9', 'epics', ?, 'idle', 'A search that finds recipes')").run(stage);
  const card = () => loop.db.prepare('SELECT stage, state FROM cards WHERE key = ?').get('EPIC-9');

  it('leaves a card on Refine, because Architecture starts a run', async () => {
    epic('refine');

    expect(loop.start('EPIC-9', 'refine')).toBe(true);
    await vi.waitFor(() => expect(card()).toEqual({ stage: 'refine', state: 'ready' }));
  });

  it('moves a card from Plan to Review after its plan run', async () => {
    epic('plan');

    expect(loop.start('EPIC-9', 'plan')).toBe(true);
    await vi.waitFor(() => expect(card()).toEqual({ stage: 'review', state: 'ready' }));
    expect(loop.db.prepare("SELECT from_stage, to_stage, who FROM card_events WHERE card_key = 'EPIC-9'").all()).toEqual([{ from_stage: 'plan', to_stage: 'review', who: 'auto' }]);
  });

  // A message on the refine thread runs refine while the card sits on Plan. That is no plan result.
  it('leaves a card on Plan after a run of another phase', async () => {
    epic('plan');

    expect(loop.start('EPIC-9', 'refine')).toBe(true);
    await vi.waitFor(() => expect(card()).toEqual({ stage: 'plan', state: 'ready' }));
  });
});

// The one chain that always runs, for the contrast: Delivery QA reads its verdict and moves the card.
// Without this the test above would pass as well on a build where no run lands any card at all.
it('moves a Delivery card off QA when the run passed', async () => {
  addCard('APP-9', 'qa');

  expect(loop.start('APP-9', 'qa')).toBe(true);
  await vi.waitFor(() => expect(loop.snapshot().cards[0]?.state).toBe('ready'));

  expect(loop.db.prepare('SELECT stage FROM cards WHERE key = ?').get('APP-9')).toEqual({ stage: 'review' });
});

// The PR reviews board in fake mode, with no gh. No card a run in fake mode can make carries a
// pull request: the only writer of a source ref is the GitHub read in `create-card.ts`, and that needs a login. An
// earlier diff writer read the ref before the fake branch, which failed this run before the engine
// and left the board unusable without gh.
it('runs pr-review in fake mode on a card that names no pull request', async () => {
  loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-9', 'prreview', 'pre-review', 'idle', 'Cache the recipe list')").run();

  expect(loop.start('APP-9', 'pr-review')).toBe(true);
  const runId = (loop.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
  await vi.waitFor(() => expect(['complete', 'failed']).toContain(readRun(loop.db, runId)?.state));

  expect(readRun(loop.db, runId)?.state).toBe('complete');
  expect(readFileSync(join(dir, '.tasks', 'APP-9', 'pr-review', 'diff.patch'), 'utf8')).toContain('diff --git');
});

/**
 * A pr-review run reads the pull request's diff from the card folder, and the runner writes it
 * there. The writer runs once per run, after the checkout and before the engine, so
 * a diff that cannot be read costs no engine call.
 *
 * The `gh` here is a stub. No test calls GitHub, and `gh pr diff` has not been recorded against the
 * real CLI, which `pr-diff.test.ts` says beside its own stub.
 */
describe('the diff a pr-review run reads', () => {
  const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: '3b1c8f44-2d6e-4a91-8f0b-7c5e9a2d1b60', model: 'sonnet', apiKeySource: 'none' });
  const DONE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, duration_ms: 10, usage: {} });
  const FIRST = 'diff --git a/src/list.ts b/src/list.ts\n-one\n+two\n';
  const SECOND = 'diff --git a/src/list.ts b/src/list.ts\n-two\n+three\n';

  let pr: Loop;
  let folder = '';
  // What the stub answers, changed by a test that needs a second answer or a failure.
  let answer = { code: 0, stdout: FIRST, stderr: '' };
  let calls: string[][] = [];
  // What the diff file held at the moment the engine was spawned, one entry per spawn. A run that
  // never spawned leaves it empty, which is how a failed fetch is proved to cost no engine call.
  let seen: (string | null)[] = [];
  let spawned: Engine['spawn'];

  const gh: RunGh = (args) => {
    calls.push([...args]);
    return Promise.resolve(answer);
  };

  const patchPath = () => join(folder, '.tasks', 'recipes#41', 'pr-review', 'diff.patch');

  beforeEach(() => {
    answer = { code: 0, stdout: FIRST, stderr: '' };
    calls = [];
    seen = [];
    folder = mkdtempSync(join(tmpdir(), 'nolzu-pr-diff-loop-'));
    pr = createLoop(folder, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { gh });
    // A pull request card, keyed repo#number, with the owner kept on the card as its source ref.
    pr.db.prepare("INSERT INTO cards (key, board, stage, state, title, source, source_ref) VALUES ('recipes#41', 'prreview', 'pre-review', 'idle', 'Cache the recipe list', 'github-pr', 'cook/recipes#41')").run();
    spawned = pr.engine.spawn.bind(pr.engine);
    pr.engine.spawn = async function* (job: Job) {
      // The extraction pass is not the phase run, and it reads no diff.
      if (job.phase === 'extract-summary') return;
      seen.push(existsSync(patchPath()) ? readFileSync(patchPath(), 'utf8') : null);
      yield INIT;
      yield DONE;
    };
  });

  afterEach(() => {
    pr.engine.spawn = spawned;
    pr.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const runPhase = async () => {
    expect(pr.start('recipes#41', 'pr-review')).toBe(true);
    const runId = (pr.db.prepare('SELECT max(id) AS id FROM runs').get() as { id: number }).id;
    await vi.waitFor(() => expect(['complete', 'failed']).toContain(readRun(pr.db, runId)?.state));
    return runId;
  };

  it('has the diff on disk with gh bytes before the engine starts, and ends the run complete', async () => {
    const runId = await runPhase();

    expect(seen).toEqual([FIRST]);
    // The head first, so the round saves the head the diff was read at, then the diff.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.slice(0, 2)).toEqual(['api', 'graphql']);
    expect(calls[0]?.join(' ')).toContain('repository(owner: "cook", name: "recipes")');
    expect(calls[1]).toEqual(['pr', 'diff', '41', '--repo', 'cook/recipes', '--color', 'never']);
    expect(readRun(pr.db, runId)?.state).toBe('complete');
  });

  it('fails the run with the pull request in the reason when gh fails, and spawns nothing', async () => {
    answer = { code: 1, stdout: '', stderr: 'could not find any pull request\n' };

    const runId = await runPhase();

    expect(readRun(pr.db, runId)?.state).toBe('failed');
    expect(pr.snapshot('prreview').cards[0]?.failureReason).toContain('cook/recipes#41');
    expect(seen).toEqual([]);
    expect(existsSync(patchPath())).toBe(false);
  });

  // A second round reads the head as it is now. The first round's patch left in place would be the
  // diff of code the author has already changed.
  it('writes the diff again on the next run of the card', async () => {
    await runPhase();
    answer = { code: 0, stdout: SECOND, stderr: '' };

    await runPhase();

    expect(seen).toEqual([FIRST, SECOND]);
    expect(readFileSync(patchPath(), 'utf8')).toBe(SECOND);
  });
});

// The two message buttons ask the engine of the plain summary row. The pass has its own run
// row, so its cost shows, and it never stands in for the card's own newest run.
it('writes a commit message as a pass of its own, and leaves the card on the run that asked', async () => {
  addCard('APP-1');
  loop.db.prepare("UPDATE cards SET state = 'blocked' WHERE key = 'APP-1'").run();
  const asked = startRun(loop.db, { cardKey: 'APP-1', phase: 'implement', engine: DEFAULT_PROFILE.id, model: 'sonnet', effort: 'high', sessionId: 's-1', logPath: '', lane: null });
  loop.db.prepare("UPDATE runs SET question = 'Which index name?' WHERE id = ?").run(asked);
  // Two rows set apart, so the pass shows which one it ran on.
  writeSetting(loop.db, 'models', { 'extract-summary': { model: 'haiku', effort: 'low' }, implement: { model: 'opus', effort: 'high' } });

  const seen: Job[] = [];
  const spawn = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = (job: Job, signal: AbortSignal) => (seen.push(job), spawn(job, signal));

  const written = await loop.writeMessage('APP-1', 'Write a commit message for the change below.');
  // Read only: the pass reads the checkout and changes nothing in it.
  expect(seen[0]?.tools).toEqual(['Read']);

  // The model as the row names it, and the cost the pass reported, which the push dialog shows.
  expect(written).toEqual({ ok: true, answer: 'feat(recipes): filter the list by title\n\nThe list was too long to scan by eye.', model: 'haiku', cost: 0.0021 });
  const pass = readRun(loop.db, asked + 1);
  expect(pass).toMatchObject({ phase: 'commit-message', state: 'complete', costUsd: 0.0021 });
  expect(loop.db.prepare('SELECT effort FROM runs WHERE id = ?').get(asked + 1)).toEqual({ effort: 'low' });
  expect(loop.snapshot().cards.find((card) => card.key === 'APP-1')?.runId).toBe(asked);
});

it('refuses a commit message for a key that names no plain folder, and starts nothing', async () => {
  expect(await loop.writeMessage('../APP-1', 'x')).toMatchObject({ ok: false, reason: expect.stringContaining('not one plain name') });
  expect(loop.db.prepare('SELECT count(*) AS n FROM runs').get()).toEqual({ n: 0 });
});

// The tool list alone does not hold a run to reading on every engine. The guard does, so the pass
// gets it like a read-only phase.
it('hands the commit message pass the guard settings of the project', async () => {
  addCard('APP-1');
  const project = join(dir, 'recipes');
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  mkdirSync(join(project, 'worktrees', 'APP-1'), { recursive: true });
  writeFileSync(join(project, '.claude', 'hooks', 'nolzu-phase-guard.mjs'), 'export {};\n');
  writeSetting(loop.db, 'projectPath', project);
  const seen: Job[] = [];
  const spawn = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = (job: Job, signal: AbortSignal) => (seen.push(job), spawn(job, signal));

  await loop.writeMessage('APP-1', 'Write a commit message for the change below.');

  expect(seen[0]?.settingsPath).toBe(join(dir, 'engine-settings.json'));
});

// Each card runs in its own checkout. Every other test here uses APP-1, so a path built from a
// fixed or wrong key would pass them all.
it('starts each card in the checkout named by its own key', () => {
  addCard('APP-1');
  addCard('APP-2');
  writeSetting(loop.db, 'projectPath', '/work/recipes');

  expect(loop.buildJob('APP-2', 'refine', 1).cwd).toBe(join('/work/recipes', 'worktrees', 'APP-2'));
  expect(loop.buildJob('APP-1', 'refine', 2).cwd).toBe(join('/work/recipes', 'worktrees', 'APP-1'));
});

// The pass reads the card's own checkout, so the message is about that card's change and not about
// the person's own tree or another card.
it('runs the commit message pass in the checkout of the card it is for', async () => {
  addCard('APP-2');
  const project = join(dir, 'recipes');
  mkdirSync(join(project, 'worktrees', 'APP-2'), { recursive: true });
  writeSetting(loop.db, 'projectPath', project);
  const seen: Job[] = [];
  const spawn = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = (job: Job, signal: AbortSignal) => (seen.push(job), spawn(job, signal));

  await loop.writeMessage('APP-2', 'Write a commit message for the change below.');

  expect(seen[0]?.cwd).toBe(join(project, 'worktrees', 'APP-2'));
});

// The pass runs in a card checkout too, so it needs the project folder for the two Read rules. It is
// the project itself, not the checkout and not the card folder.
it('names the project folder on the commit message pass', async () => {
  addCard('APP-2');
  const project = join(dir, 'recipes');
  mkdirSync(join(project, 'worktrees', 'APP-2'), { recursive: true });
  writeSetting(loop.db, 'projectPath', project);
  const seen: Job[] = [];
  const spawn = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = (job: Job, signal: AbortSignal) => (seen.push(job), spawn(job, signal));

  await loop.writeMessage('APP-2', 'Write a commit message for the change below.');

  expect(seen[0]?.projectDir).toBe(project);
});

// A message for one repository of a second card: the pass starts in that repository's checkout, and
// its task folder is still the card's own.
it('runs the commit message pass of one repository in that checkout of that card', async () => {
  addCard('APP-2');
  const project = join(dir, 'recipes');
  mkdirSync(join(project, 'worktrees', 'APP-2', 'api'), { recursive: true });
  writeSetting(loop.db, 'projectPath', project);
  const seen: Job[] = [];
  const spawn = loop.engine.spawn.bind(loop.engine);
  loop.engine.spawn = (job: Job, signal: AbortSignal) => (seen.push(job), spawn(job, signal));

  await loop.writeMessage('APP-2', 'Write a commit message for the change below.', undefined, 'api');

  expect(seen[0]?.cwd).toBe(join(project, 'worktrees', 'APP-2', 'api'));
  expect(seen[0]?.taskDir).toBe(join(project, '.tasks', 'APP-2'));
});

// The estimates read first runs only, so every start writes which kind it is.
describe('the resumed marker on a run', () => {
  const SESSION = 'e93a6d12-8b4f-4c07-a2d5-6f1e0c9b8a03';
  const newest = () => loop.db.prepare('SELECT phase, resumed, asked_model FROM runs ORDER BY id DESC LIMIT 1').get();
  const setState = (state: string) => loop.db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(state, 'APP-1');

  // The row is written before the job is handed over, so nothing has to run for the marker to show.
  beforeEach(() => {
    loop.scheduler.add = () => {};
    addCard('APP-1', 'plan');
  });

  it('writes 0 on a first run, with the model the run asked for', () => {
    expect(loop.start('APP-1', 'plan')).toBe(true);

    expect(newest()).toEqual({ phase: 'plan', resumed: 0, asked_model: 'sonnet' });
  });

  it('writes 1 on an answer to a blocked card', () => {
    setState('blocked');
    const asked = begin('APP-1', 'plan');
    loop.db.prepare("UPDATE runs SET state = 'complete', session_id = ? WHERE id = ?").run(SESSION, asked);

    expect(loop.answer('APP-1', 'Titles only.')).toBe(true);

    expect(newest()).toMatchObject({ phase: 'plan', resumed: 1 });
  });

  it('writes 1 on a discussion message', () => {
    setState('ready');

    expect(loop.discuss('APP-1', { id: 'plan', sessionId: SESSION, engine: DEFAULT_PROFILE.id }, 'go on')).toBe(true);

    expect(newest()).toMatchObject({ phase: 'plan', resumed: 1 });
  });

  it('writes 1 on a retry and on Run on', () => {
    setState('failed');
    expect(loop.retry('APP-1')).toBe(true);
    expect(newest()).toMatchObject({ phase: 'plan', resumed: 1 });

    setState('failed');
    expect(loop.retry('APP-1', DEFAULT_PROFILE.id)).toBe(true);
    expect(newest()).toMatchObject({ phase: 'plan', resumed: 1 });
  });

  // Its prompt says to go on from step 2, so it finishes what a stopped run left.
  it('writes 1 on a fresh run that goes on from the progress file', () => {
    const folder = join(dir, '.tasks', 'APP-1', 'implement');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'progress.md'), '1. Add the recipe list\n');

    expect(loop.start('APP-1', 'implement')).toBe(true);

    expect(newest()).toMatchObject({ phase: 'implement', resumed: 1 });
  });

  // Only the file of this card and this phase counts, and only with a step done in it. The prompt of
  // any other run starts fresh, so the run is a first run.
  it('writes 0 when the progress file is another card’s, another phase’s, or lists no step', () => {
    addCard('APP-2', 'plan');
    const progress = (key: string, phase: string, text: string) => {
      const folder = join(dir, '.tasks', key, phase);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'progress.md'), text);
    };
    progress('APP-1', 'implement', '1. Add the recipe list\n');

    expect(loop.start('APP-2', 'implement')).toBe(true);
    expect(newest()).toMatchObject({ phase: 'implement', resumed: 0 });

    expect(loop.start('APP-1', 'plan')).toBe(true);
    expect(newest()).toMatchObject({ phase: 'plan', resumed: 0 });

    progress('APP-2', 'implement', 'Nothing finished yet.\n');
    expect(loop.start('APP-2', 'implement')).toBe(true);
    expect(newest()).toMatchObject({ phase: 'implement', resumed: 0 });
  });
});

// A card made from a whole idea showed the idea as its title. Refine writes a short one
// on the first heading of refined.md, and a local card takes it.
describe('the title Refine wrote', () => {
  const card = (key: string) => loop.db.prepare('SELECT title, summary FROM cards WHERE key = ?').get(key) as { title: string; summary: string | null };
  const refine = async (key: string) => {
    const runId = begin(key, 'refine');
    loop.scheduler.add(loop.buildJob(key, 'refine', runId));
    await vi.waitFor(() => expect(readRun(loop.db, Number(runId))?.state).toBe('complete'));
  };
  const insert = (key: string, title: string, source: string) =>
    loop.db.prepare("INSERT INTO cards (key, board, stage, state, title, source) VALUES (?, 'delivery', 'refine', 'idle', ?, ?)").run(key, title, source);

  it('becomes a local card title, and the old title goes into the empty description', async () => {
    insert('APP-1', 'A habit tracker where a person ticks off each habit every day', 'local');
    await refine('APP-1');
    expect(card('APP-1')).toEqual({ title: 'Search the recipe list', summary: 'A habit tracker where a person ticks off each habit every day' });
    expect(loop.snapshot().cards.find((one) => one.key === 'APP-1')?.title).toBe('Search the recipe list');
  });

  it('sets the title of the card that ran and no other local card', async () => {
    insert('APP-1', 'First idea', 'local');
    insert('APP-2', 'Second idea', 'local');
    await refine('APP-2');
    expect(card('APP-2')).toEqual({ title: 'Search the recipe list', summary: 'Second idea' });
    expect(card('APP-1')).toEqual({ title: 'First idea', summary: null });
  });

  it('leaves a GitHub or Jira card and a title the person set', async () => {
    insert('recipes#4', 'Issue title', 'github');
    insert('PROJ-123', 'Jira title', 'jira');
    insert('APP-1', 'My own title', 'local');
    loop.db.prepare("UPDATE cards SET title_by = 'person' WHERE key = 'APP-1'").run();
    for (const key of ['recipes#4', 'PROJ-123', 'APP-1']) await refine(key);
    expect(['recipes#4', 'PROJ-123', 'APP-1'].map((key) => card(key))).toEqual([
      { title: 'Issue title', summary: null },
      { title: 'Jira title', summary: null },
      { title: 'My own title', summary: null },
    ]);
  });

  it('takes no title from a run that is not a refine run', async () => {
    insert('APP-1', 'Old title', 'local');
    const runId = begin('APP-1', 'plan');
    const job = loop.buildJob('APP-1', 'plan', runId);
    loop.engine.spawn = async function* () {
      mkdirSync(join(job.taskDir, 'refine'), { recursive: true });
      writeFileSync(join(job.taskDir, 'refine', 'refined.md'), '# APP-1: Title from a plan run\n');
      yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
    };
    loop.scheduler.add(job);
    await vi.waitFor(() => expect(readRun(loop.db, Number(runId))?.state).toBe('complete'));
    expect(card('APP-1').title).toBe('Old title');
  });

  it('takes nothing from a brief an earlier run left', async () => {
    insert('APP-1', 'Old title', 'local');
    const runId = begin('APP-1', 'refine');
    const job = loop.buildJob('APP-1', 'refine', runId);
    mkdirSync(join(job.taskDir, 'refine'), { recursive: true });
    writeFileSync(join(job.taskDir, 'refine', 'refined.md'), '# APP-1: Stale title\n');
    const { utimesSync } = await import('node:fs');
    utimesSync(join(job.taskDir, 'refine', 'refined.md'), new Date(2000, 0, 1), new Date(2000, 0, 1));
    loop.engine.spawn = async function* () {
      yield JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });
    };
    loop.scheduler.add(job);
    await vi.waitFor(() => expect(readRun(loop.db, Number(runId))?.state).toBe('complete'));
    expect(card('APP-1').title).toBe('Old title');
  });
});

// QA runs the project's checks on a throwaway copy of the card's checkout, made right before the run
// and deleted after it, however it ends.
describe('QA on a throwaway copy', () => {
  const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: '5d2e8a10-3c4b-4f6e-9a7d-1b2c3d4e5f60', model: 'sonnet', apiKeySource: 'none' });
  const DONE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, duration_ms: 10, usage: {} });
  let project = '';

  beforeEach(() => {
    project = join(dir, 'recipes');
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src/list.ts'), 'committed');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    writeSetting(loop.db, 'projectPath', project);
    addCard('APP-1', 'qa');
  });

  const runQa = (spawn: Engine['spawn']) => {
    loop.engine.spawn = async function* (job: Job, signal: AbortSignal) {
      if (job.phase === 'extract-summary') return;
      yield* spawn(job, signal);
    };
    const runId = begin('APP-1', 'qa');
    const job = loop.buildJob('APP-1', 'qa', runId);
    loop.scheduler.add(job);
    return { runId: Number(runId), job };
  };
  // Ended, and out of the queue: the summary pass and the git compare after it still hold the slot.
  const ended = (runId: number, state: string) =>
    vi.waitFor(() => {
      expect(readRun(loop.db, runId)?.state).toBe(state);
      expect((loop.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get() as { state: string }).state).not.toMatch(/^(queued|running)$/);
    }, { timeout: 10_000 });

  // From the copy the card folder is `../../../recipes/.tasks/APP-1`, which Codex wrote one or two
  // folders too high. The full path is physical, because the wall and the guard hold that spelling.
  it('names the real card folder in the prompt by its full path, and keeps the job in the real checkout', () => {
    mkdirSync(join(project, '.tasks/APP-1/plan'), { recursive: true });
    writeFileSync(join(project, '.tasks/APP-1/plan/plan.md'), '# APP-1\n');
    const card = realpathSync(join(project, '.tasks/APP-1'));
    const job = loop.buildJob('APP-1', 'qa', 1);
    expect(job.cwd).toBe(join(project, 'worktrees/APP-1'));
    expect(job.qaCopy).toMatch(/\/qa-copies\/qa-APP-1-[0-9a-f]{8}$/);
    expect(job.qaCopy?.startsWith(`${project}/`)).toBe(false);
    expect(job.prompt).toContain(`The card folder is \`${card}/\`.`);
    expect(job.prompt).toContain(`Write what you produce to \`${card}/qa/\``);
    expect(job.prompt).toContain(`- \`${card}/plan/plan.md\``);
    expect(job.prompt).toContain('Every path this prompt names outside `./` is a full path.');
    expect(job.prompt).not.toContain('../');
    // The code is still read in the copy, not in the project folder the full path goes through.
    expect(job.prompt).toContain(`The code of this card is in the folder you start in, \`./\`, its own checkout.`);
    expect(job.prompt.replace(/\s+/g, ' ')).toContain(`The card folder lies in the project folder \`${dirname(dirname(card))}/\`, outside the checkout`);
    // Every other phase works where it always did, with paths from its checkout.
    const implement = loop.buildJob('APP-1', 'implement', 2);
    expect(implement.qaCopy).toBeUndefined();
    expect(implement.prompt).toContain('The card folder is `../../.tasks/APP-1/`.');
    expect(implement.prompt).not.toContain(card);
    expect(implement.prompt).not.toContain('full path');
    expect(loop.buildJob('APP-1', 'plan', 3).qaCopy).toBeUndefined();
  });

  it('gives each card its own copy, and its own real card folder in the prompt', () => {
    addCard('APP-2', 'qa');
    const one = loop.buildJob('APP-1', 'qa', 1);
    const two = loop.buildJob('APP-2', 'qa', 2);
    expect(two.qaCopy).toMatch(/\/qa-copies\/qa-APP-2-[0-9a-f]{8}$/);
    expect(two.qaCopy).not.toBe(one.qaCopy);
    expect(two.cwd).toBe(join(project, 'worktrees/APP-2'));
    // Not made yet, and still physical: the wall holds that spelling, and macOS keeps tmp behind a symlink.
    expect(existsSync(join(project, '.tasks/APP-2'))).toBe(false);
    expect(two.prompt).toContain(`The card folder is \`${join(realpathSync(project), '.tasks/APP-2')}/\`.`);
    expect(one.prompt).not.toContain('.tasks/APP-2');
  });

  // The same on a system whose temp folder is no symlink: a project reached through one is named by
  // its real folder, which is the spelling the guard holds a Claude Code write to.
  it('names the card folder by its real path when the project is reached through a symlink', () => {
    const link = join(dir, 'link-to-recipes');
    symlinkSync(project, link);
    writeSetting(loop.db, 'projectPath', link);
    const job = loop.buildJob('APP-1', 'qa', 1);
    expect(job.prompt).toContain(`The card folder is \`${join(realpathSync(project), '.tasks/APP-1')}/\`.`);
    expect(job.prompt).not.toContain(link);
  });

  it('holds the uncommitted work of the checkout, and is deleted after a run that ends ready', async () => {
    // The first run makes the card's checkout.
    const first = runQa(async function* () {
      yield DONE;
    });
    await ended(first.runId, 'complete');
    const checkout = first.job.cwd;
    writeFileSync(join(checkout, 'src/list.ts'), 'changed, not committed');
    writeFileSync(join(checkout, 'src/new.ts'), 'untracked');
    const seen: string[] = [];

    const second = runQa(async function* (job) {
      const copy = job.qaCopy ?? '';
      seen.push(readFileSync(join(copy, 'src/list.ts'), 'utf8'), readFileSync(join(copy, 'src/new.ts'), 'utf8'));
      yield INIT;
      yield DONE;
    });
    await ended(second.runId, 'complete');

    expect(seen).toEqual(['changed, not committed', 'untracked']);
    expect(existsSync(second.job.qaCopy ?? '')).toBe(false);
    const log = readFileSync(second.job.logPath, 'utf8');
    expect(log).toMatch(/QA works on a throwaway copy of .* made by (APFS clone|reflink|plain copy) in \d+\.\d s\./);
  });

  it('is deleted after a run that fails', async () => {
    let there = false;
    const { runId, job } = runQa(async function* (one) {
      there = existsSync(join(one.qaCopy ?? '', 'src/list.ts'));
      yield INIT;
      throw new Error('The Claude Code engine stopped with exit code 1.');
    });
    await ended(runId, 'failed');

    expect(there).toBe(true);
    expect(existsSync(job.qaCopy ?? '')).toBe(false);
  });

  it('is deleted after a run that is stopped', async () => {
    const { runId, job } = runQa(async function* (_one, signal) {
      yield INIT;
      // The Stop can land before the run asks for its next line, and an aborted signal fires no more.
      if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    });
    await vi.waitFor(() => expect(existsSync(job.qaCopy ?? '') && readRun(loop.db, runId)?.state === 'running').toBe(true));

    loop.stop(runId);
    await ended(runId, 'stopped');

    expect(existsSync(job.qaCopy ?? '')).toBe(false);
  });

  it('sweeps a copy a crash left when Nolzu starts, and nothing else', () => {
    const copies = join(dir, 'qa-copies');
    mkdirSync(join(copies, 'qa-APP-1-0a1b2c3d/src'), { recursive: true });
    writeFileSync(join(copies, 'notes.txt'), 'kept');
    loop.close();

    // A fresh boot of the data folder.
    loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { wall: WALL });

    expect(existsSync(join(copies, 'qa-APP-1-0a1b2c3d'))).toBe(false);
    expect(existsSync(join(copies, 'notes.txt'))).toBe(true);
    expect(existsSync(join(project, 'src/list.ts'))).toBe(true);
  });

  // A forced card removal moves the checkout into .git/nolzu-removing and deletes it after its locks. A
  // crash in between leaves it there, and the boot deletes it, in the background, saying so.
  it('deletes a checkout a crashed removal left in the repository when Nolzu starts', async () => {
    const left = join(project, '.git', 'nolzu-removing', 'APP-1-0a1b2c3d');
    mkdirSync(join(left, 'src'), { recursive: true });
    writeFileSync(join(left, 'src', 'list.ts'), 'old');
    loop.close();
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      loop = createLoop(dir, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { wall: WALL });

      await vi.waitFor(() => expect(existsSync(left)).toBe(false), { timeout: 10_000 });
      expect(said).toHaveBeenCalledWith(`Removed ${left}, a checkout an earlier removal moved aside and did not delete.`);
      expect(existsSync(join(project, 'src/list.ts'))).toBe(true);
    } finally {
      said.mockRestore();
    }
  });

  it('sweeps the data folder\'s copies at boot also when no project is set', () => {
    const bare = mkdtempSync(join(tmpdir(), 'nolzu-loop-bare-'));
    try {
      createLoop(bare, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }).close();
      const copy = join(bare, 'qa-copies', 'qa-APP-1-0a1b2c3d');
      mkdirSync(join(copy, 'src'), { recursive: true });

      const again = createLoop(bare, { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
      again.close();

      expect(existsSync(copy)).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// After every read-only run the git state is compared with the one before. Nolzu
// puts back its own checkout and leaves the person's folder alone.
describe('the git compare after a read-only run', () => {
  const INIT = JSON.stringify({ type: 'system', subtype: 'init', session_id: '5d2e8a10-3c4b-4f6e-9a7d-1b2c3d4e5f60', model: 'sonnet', apiKeySource: 'none' });
  const DONE = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.04, duration_ms: 10, usage: {} });
  let project = '';

  beforeEach(() => {
    project = join(dir, 'recipes');
    mkdirSync(join(project, 'src'), { recursive: true });
    writeFileSync(join(project, 'src/list.ts'), 'committed');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    writeSetting(loop.db, 'projectPath', project);
  });

  const run = (phase: 'qa' | 'implement', spawn: Engine['spawn']) => {
    loop.engine.spawn = async function* (job: Job, signal: AbortSignal) {
      if (job.phase === 'extract-summary') return;
      yield* spawn(job, signal);
    };
    const runId = Number(begin('APP-1', phase));
    const job = loop.buildJob('APP-1', phase, runId);
    loop.scheduler.add(job);
    return { runId, job };
  };
  // Complete, and out of the queue, so the next run of the card can start.
  const ended = (runId: number) =>
    vi.waitFor(() => {
      expect(readRun(loop.db, runId)?.state).toBe('complete');
      expect(loop.db.prepare("SELECT state FROM cards WHERE key = 'APP-1'").get()).toEqual({ state: 'ready' });
    }, { timeout: 10_000 });

  it('compares the real checkout for QA and puts back what the run changed there, not what it wrote in its copy', async () => {
    addCard('APP-1', 'qa');
    const first = run('qa', async function* (job) {
      writeFileSync(join(job.qaCopy ?? '', 'src/list.ts'), 'the copy is the run\'s to write');
      yield INIT;
      yield DONE;
    });
    await ended(first.runId);
    expect(readOnlyBreakOf(loop.db, 'APP-1')).toBeNull();

    const second = run('qa', async function* (job) {
      writeFileSync(join(job.cwd, 'src/list.ts'), 'changed by a read-only run');
      writeFileSync(join(job.cwd, 'stray.txt'), 'left by the run');
      yield INIT;
      yield DONE;
    });
    await ended(second.runId);

    const checkout = second.job.cwd;
    expect(readFileSync(join(checkout, 'src/list.ts'), 'utf8')).toBe('committed');
    expect(existsSync(join(checkout, 'stray.txt'))).toBe(false);
    expect(readOnlyBreakOf(loop.db, 'APP-1')).toMatchObject({ phase: 'qa', restored: true, undone: ['Put back src/list.ts.', 'Removed stray.txt, which the run made.'], left: [] });
    expect(readFileSync(second.job.logPath, 'utf8')).toContain("This read-only run changed the card's checkout, so Nolzu put it back.");
  });

  it('never touches the person\'s own folder, and keeps the mark and the diff for the card page', async () => {
    addCard('APP-1', 'plan');
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(project, '.claude', 'hooks', 'nolzu-phase-guard.mjs'), 'export {};\n');
    let at = '';
    loop.engine.spawn = async function* (job: Job) {
      // The subject pass that follows the answer runs in a scratch folder and writes nothing here.
      if (job.phase === 'ask') {
        at = job.cwd;
        writeFileSync(join(job.cwd, 'src/list.ts'), 'changed by Ask');
      }
      yield INIT;
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'It comes from the API.' }] } });
      yield DONE;
    };
    loop.discuss('APP-1', { id: 'ask', sessionId: null, engine: null }, 'Where does the list come from?');
    await vi.waitFor(() => expect(loop.db.prepare("SELECT state FROM runs WHERE phase = 'ask'").get()).toEqual({ state: 'complete' }), { timeout: 10_000 });

    expect(at).toBe(project);
    expect(readFileSync(join(project, 'src/list.ts'), 'utf8')).toBe('changed by Ask');
    const mark = readOnlyBreakOf(loop.db, 'APP-1');
    expect(mark).toMatchObject({ phase: 'ask', restored: false, undone: [], left: [] });
    expect(mark?.diff).toContain('+changed by Ask');
    // Named inside the project, not by the long real path.
    expect(mark?.diff.split('\n')[0]).toBe('In the project folder:');
  });

  // Turning on the QA browser commits the MCP list in `.nolzu/` while a read-only run goes. Nolzu's own
  // config commit moves main, and neither its file nor that move is the run's.
  it('does not mark a commit Nolzu makes to its own .nolzu folder', async () => {
    addCard('APP-1', 'plan');
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(project, '.claude', 'hooks', 'nolzu-phase-guard.mjs'), 'export {};\n');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'ask') {
        mkdirSync(join(project, '.nolzu'), { recursive: true });
        writeFileSync(join(project, '.nolzu', 'mcp-servers.json'), '{"servers":[]}\n');
        git('add', '.nolzu/mcp-servers.json');
        git('commit', '-q', '-m', 'chore: update the MCP servers');
      }
      yield INIT;
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
      yield DONE;
    };
    loop.discuss('APP-1', { id: 'ask', sessionId: null, engine: null }, 'Where does the list come from?');
    await vi.waitFor(() => expect(loop.db.prepare("SELECT state FROM runs WHERE phase = 'ask'").get()).toEqual({ state: 'complete' }), { timeout: 10_000 });

    expect(readOnlyBreakOf(loop.db, 'APP-1')).toBeNull();
  });

  // Another card's wrap-up commits to the knowledge folder while a read-only run goes. That is Nolzu's
  // own write, so this run is not marked for it.
  it('does not mark what another card writes to the knowledge folder', async () => {
    addCard('APP-1', 'plan');
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(project, '.claude', 'hooks', 'nolzu-phase-guard.mjs'), 'export {};\n');
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'ask') {
        mkdirSync(join(project, '.nolzu', 'knowledge'), { recursive: true });
        writeFileSync(join(project, '.nolzu', 'knowledge', 'importer.md'), '# Importer\n');
      }
      yield INIT;
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
      yield DONE;
    };
    loop.discuss('APP-1', { id: 'ask', sessionId: null, engine: null }, 'Where does the list come from?');
    await vi.waitFor(() => expect(loop.db.prepare("SELECT state FROM runs WHERE phase = 'ask'").get()).toEqual({ state: 'complete' }), { timeout: 10_000 });

    expect(readOnlyBreakOf(loop.db, 'APP-1')).toBeNull();
  });

  it('tells nobody the run ended before the checkout is put back', async () => {
    addCard('APP-1', 'qa');
    // Seen by whoever listens to the run, at each line it hears.
    const stray: boolean[] = [];
    let checkout = '';
    loop.onActivity(() => stray.push(existsSync(join(checkout, 'stray.txt'))));
    const { runId, job } = run('qa', async function* (one) {
      checkout = one.cwd;
      writeFileSync(join(one.cwd, 'stray.txt'), 'left by the run');
      yield INIT;
      yield DONE;
    });
    await ended(runId);

    expect(job.cwd).toBe(checkout);
    expect(stray.length).toBeGreaterThan(1);
    expect(stray.at(-1)).toBe(false);
  });

  it('does not mark a file the person\'s own tools ignore, in the person\'s folder', async () => {
    addCard('APP-1', 'plan');
    writeFileSync(join(project, '.gitignore'), 'dist/\n');
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(project, '.claude', 'hooks', 'nolzu-phase-guard.mjs'), 'export {};\n');
    loop.engine.spawn = async function* (job: Job) {
      mkdirSync(join(job.cwd, 'dist'), { recursive: true });
      writeFileSync(join(job.cwd, 'dist', 'app.js'), 'built');
      yield INIT;
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
      yield DONE;
    };
    loop.discuss('APP-1', { id: 'ask', sessionId: null, engine: null }, 'Where does the list come from?');
    await vi.waitFor(() => expect(loop.db.prepare("SELECT state FROM runs WHERE phase = 'ask'").get()).toEqual({ state: 'complete' }), { timeout: 10_000 });

    expect(existsSync(join(project, 'dist', 'app.js'))).toBe(true);
    expect(readOnlyBreakOf(loop.db, 'APP-1')).toBeNull();
  });

  // An Implement or a Fix of the same card writes the checkouts while an Ask message goes. The compare
  // cannot tell that change from the Ask run's, so it neither puts back nor marks.
  const askWriting = (other: 'start' | 'end' | 'queued' | 'inside') => {
    addCard('APP-1', 'plan');
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(project, '.claude', 'hooks', 'nolzu-phase-guard.mjs'), 'export {};\n');
    const another = () => {
      const id = startRun(loop.db, { cardKey: 'APP-1', phase: 'implement', engine: DEFAULT_PROFILE.id, model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
      loop.db.prepare("UPDATE runs SET state = 'running' WHERE id = ?").run(id);
      return id;
    };
    // Going at the start and done before the end, started meanwhile and still going at the end, queued
    // at the start and still queued, or started and ended while the read-only run went.
    const first = other === 'start' || other === 'queued' ? another() : null;
    if (other === 'queued') loop.db.prepare("UPDATE runs SET state = 'queued' WHERE id = ?").run(first);
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'ask') {
        writeFileSync(join(job.cwd, 'src/list.ts'), 'changed by the other run');
        if (other === 'start') loop.db.prepare("UPDATE runs SET state = 'complete' WHERE id = ?").run(first);
        else if (other === 'end') another();
        else if (other === 'inside') loop.db.prepare("UPDATE runs SET state = 'complete', ended_at = ? WHERE id = ?").run(new Date().toISOString(), another());
      }
      yield INIT;
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
      yield DONE;
    };
    loop.discuss('APP-1', { id: 'ask', sessionId: null, engine: null }, 'Where does the list come from?');
  };
  const askEnded = () => vi.waitFor(() => expect(loop.db.prepare("SELECT state, log_path FROM runs WHERE phase = 'ask'").get()).toMatchObject({ state: 'complete' }), { timeout: 10_000 });

  it.each(['start', 'end', 'queued', 'inside'] as const)('does not mark a read-only run when another run of the card is going beside it (%s)', async (other) => {
    askWriting(other);
    await askEnded();

    expect(readOnlyBreakOf(loop.db, 'APP-1')).toBeNull();
    expect(readFileSync(join(project, 'src/list.ts'), 'utf8')).toBe('changed by the other run');
    const { log_path } = loop.db.prepare("SELECT log_path FROM runs WHERE phase = 'ask'").get() as { log_path: string };
    expect(readFileSync(log_path, 'utf8')).toContain('Another run of this card went at the same time');
  });

  it('clears the mark when a later read-only run of the card compares clean', async () => {
    addCard('APP-1', 'plan');
    mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(project, '.claude', 'hooks', 'nolzu-phase-guard.mjs'), 'export {};\n');
    let write = true;
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'ask' && write) writeFileSync(join(job.cwd, 'src/list.ts'), 'changed by Ask');
      yield INIT;
      yield JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } });
      yield DONE;
    };
    const asked = (count: number) => vi.waitFor(() => expect(loop.db.prepare("SELECT count(*) AS n FROM runs WHERE phase = 'ask' AND state = 'complete'").get()).toEqual({ n: count }), { timeout: 10_000 });
    loop.discuss('APP-1', { id: 'ask', sessionId: null, engine: null }, 'Where does the list come from?');
    await asked(1);
    expect(readOnlyBreakOf(loop.db, 'APP-1')).not.toBeNull();

    // The person keeps the change, so the next compare starts from it and finds nothing new.
    write = false;
    loop.discuss('APP-1', { id: 'ask', sessionId: null, engine: null }, 'And the import?');
    await asked(2);
    expect(readOnlyBreakOf(loop.db, 'APP-1')).toBeNull();
  });

  it('runs no compare for implement', async () => {
    addCard('APP-1', 'implement');
    const { runId, job } = run('implement', async function* (one) {
      writeFileSync(join(one.cwd, 'src/list.ts'), 'the change implement makes');
      yield INIT;
      yield DONE;
    });
    await ended(runId);

    expect(readFileSync(join(job.cwd, 'src/list.ts'), 'utf8')).toBe('the change implement makes');
    expect(readOnlyBreakOf(loop.db, 'APP-1')).toBeNull();
  });
});

// Run triage on the PRs tab: the comments file goes into the card folder before the run, and the fake
// engine's verdicts come back onto the open rows. A row a person marked done keeps what it had.
describe('triage', () => {
  // The newest triage has ended and the card was handed back, whatever state that gave it.
  const stateOf = (key: string) => loop.snapshot().cards.find((one) => one.key === key)?.state;
  const triaged = (key = 'APP-1') =>
    vi.waitFor(() => {
      const run = loop.db.prepare("SELECT state FROM runs WHERE card_key = ? AND phase = 'feedback' ORDER BY id DESC LIMIT 1").get(key) as { state: string };
      expect(['complete', 'failed', 'stopped']).toContain(run.state);
      expect(['queued', 'running']).not.toContain(stateOf(key));
    });
  const comment = (githubId: string, createdAt: string) => ({ kind: 'comment' as const, githubId, path: null, line: null, resolved: false, outdated: false, messages: [{ githubId, author: 'dana', body: `said ${githubId}`, createdAt }] });

  it('writes the comments file, runs feedback on the card where it sits and applies the verdicts', async () => {
    addCard('APP-1', 'pr-watch');
    const pull = saveCardPull(loop.db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' });
    storeDiscussions(loop.db, pull, 'pat', [comment('I1', '2026-10-01T00:00:00Z'), comment('I2', '2026-10-02T00:00:00Z'), comment('I3', '2026-10-03T00:00:00Z')]);
    markDiscussion(loop.db, 'APP-1', 'T2', 'done');

    expect(loop.triage('APP-1')).toBe(true);
    await triaged();

    const comments = readFileSync(join(dir, '.tasks', 'APP-1', 'feedback', 'discussions.md'), 'utf8');
    expect(comments).toContain('## T1');
    expect(comments).not.toContain('## T2');
    expect(cardDiscussions(loop.db, 'APP-1').map((one) => [one.ref, one.status, one.verdict])).toEqual([
      ['T1', 'new', 'fix'],
      ['T2', 'done', null],
      ['T3', 'new', 'clarify'],
    ]);
    expect(loop.snapshot().cards[0]?.stage).toBe('pr-watch');
    const run = loop.db.prepare("SELECT phase, cost_estimate FROM runs WHERE card_key = 'APP-1' AND phase = 'feedback'").get() as { phase: string; cost_estimate: number | null };
    expect(run.cost_estimate).toBeGreaterThan(0);
  });

  // A side run: the card goes back to the state it had, so a card waiting for approval still waits and
  // an idle one is not turned into one, and its summary of the comments is not the card's summary.
  it('leaves the card state, the summary and the threads as they were', async () => {
    for (const [key, before, number] of [['APP-1', 'idle', 12], ['APP-2', 'ready', 13]] as const) {
      addCard(key, 'pr-watch');
      loop.db.prepare('UPDATE cards SET state = ? WHERE key = ?').run(before, key);
      const pull = saveCardPull(loop.db, key, { repo: 'cook/recipes', number, url: null, foundBy: 'branch' });
      storeDiscussions(loop.db, pull, 'pat', [comment(`I${number}`, '2026-10-01T00:00:00Z')]);

      expect(loop.triage(key)).toBe(true);
      await triaged(key);
      expect([key, stateOf(key)]).toEqual([key, before]);
    }
    const summaries = loop.db.prepare("SELECT plain_summary FROM runs WHERE phase = 'feedback'").all() as { plain_summary: string | null }[];
    expect(summaries.map((one) => one.plain_summary)).toEqual([null, null]);
    expect(loop.db.prepare("SELECT count(*) AS n FROM runs WHERE phase = 'extract-summary'").get()).toEqual({ n: 0 });
  });

  it('applies nothing from a run that ends with a question, and leaves the card idle', async () => {
    addCard('APP-1', 'pr-watch');
    const pull = saveCardPull(loop.db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' });
    storeDiscussions(loop.db, pull, 'pat', [comment('I1', '2026-10-01T00:00:00Z')]);
    const asks = readFileSync(new URL('../../../../packages/runner/fake/needs-input.ndjson', import.meta.url), 'utf8').split('\n').filter((line) => line.trim() !== '');
    loop.engine.spawn = async function* (job: Job) {
      if (job.phase === 'extract-summary') return;
      writeFileSync(join(job.taskDir ?? '', 'feedback', 'triage.md'), 'T1: fix\nSummary: s\nReason: r\nReply: x\n');
      yield* asks;
    };

    expect(loop.triage('APP-1')).toBe(true);
    await triaged();
    expect(loop.snapshot().cards[0]?.state).toBe('idle');
    expect(cardDiscussions(loop.db, 'APP-1')[0]?.verdict).toBeNull();
  });

  it('leaves a failed triage to Run triage, not to Retry, which would start the stage', async () => {
    addCard('APP-1', 'implement');
    const pull = saveCardPull(loop.db, 'APP-1', { repo: 'cook/recipes', number: 12, url: null, foundBy: 'branch' });
    storeDiscussions(loop.db, pull, 'pat', [comment('I1', '2026-10-01T00:00:00Z')]);
    const failed = startRun(loop.db, { cardKey: 'APP-1', phase: 'feedback', engine: DEFAULT_PROFILE.id, model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
    loop.db.prepare("UPDATE runs SET state = 'failed' WHERE id = ?").run(failed);
    loop.db.prepare("UPDATE cards SET state = 'failed' WHERE key = 'APP-1'").run();

    expect(() => loop.retry('APP-1')).toThrow('The triage of APP-1 failed. Run triage again on its PRs tab, or move the card.');
    expect(loop.triage('APP-1')).toBe(true);
    await triaged();
    expect(loop.snapshot().cards[0]?.state).toBe('idle');
    expect(cardDiscussions(loop.db, 'APP-1')[0]?.verdict).toBe('fix');
  });

  it('refuses a card with nothing open, one a run holds, and one off Delivery', () => {
    addCard('APP-1', 'pr-watch');
    expect(() => loop.triage('APP-1')).toThrow('APP-1 has no open discussion to triage.');
    loop.db.prepare("UPDATE cards SET state = 'running' WHERE key = 'APP-1'").run();
    expect(() => loop.triage('APP-1')).toThrow('APP-1 is running. Run triage once nothing else holds the card.');
    loop.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('Q-1', 'research', 'inbox', 'idle', 'A question')").run();
    expect(() => loop.triage('Q-1')).toThrow('Q-1 is not on Delivery.');
  });
});

// A Delivery card's pull request is looked for without a press, once per card per interval, and
// at once for the card a push just went out for. The stub stands in for gh, which a test never runs.
describe('the pull request found by itself', () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  let folder = '';
  let live: Loop;
  let asked = 0;
  const gh: RunGh = async () => {
    asked += 1;
    return { code: 0, stdout: JSON.stringify({ data: { viewer: { login: 'pat' }, t0: { pullRequests: { nodes: [] } } } }), stderr: '' };
  };

  beforeEach(() => {
    asked = 0;
    folder = mkdtempSync(join(tmpdir(), 'nolzu-pull-watch-'));
    const project = join(folder, 'recipes');
    mkdirSync(project, { recursive: true });
    git(project, 'init', '-q', '-b', 'main');
    git(project, 'remote', 'add', 'origin', 'https://github.com/cook/recipes.git');
    writeFileSync(join(project, 'list.ts'), 'export const list = [];\n');
    writeFileSync(join(project, '.gitignore'), '/worktrees/\n');
    git(project, 'add', '-A');
    git(project, 'commit', '-q', '-m', 'first');
    const at = join(project, 'worktrees', 'APP-1');
    git(project, 'worktree', 'add', '-q', '-b', 'APP-1-search', at);
    git(at, 'update-ref', 'refs/remotes/origin/APP-1-search', 'HEAD');
    git(at, 'branch', '--set-upstream-to=origin/APP-1-search');
    live = createLoop(join(folder, 'data'), { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { gh });
    writeSetting(live.db, 'projectPath', project);
    live.db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'review', 'idle', 'Search')").run();
  });

  afterEach(() => {
    live.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('asks once per card per interval, and at once after a push', async () => {
    live.watchPulls();
    await vi.waitFor(() => expect(asked).toBe(1));
    live.watchPulls();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toBe(1);

    live.watchPulls('APP-1');
    await vi.waitFor(() => expect(asked).toBe(2));
  });

  it('asks nothing once the loop is closed', async () => {
    live.close();
    live.watchPulls('APP-1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toBe(0);
    live = createLoop(join(folder, 'data'), { NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { gh });
  });
});

// A Research card's folder holds checkouts and no `.git`, so its compare reads the project's own
// repository, ignored files too. A Cursor run of another card merges its servers into the project
// folder's `.cursor/mcp.json` meanwhile, which is Nolzu's write, not this run's.
describe('nolzuWrites', () => {
  let folder = '';
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it('leaves out the .cursor/mcp.json Nolzu merges at the project folder, and still finds the run\'s own file', async () => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-writes-')));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } as Record<string, string>;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, env });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(folder, '.gitignore'), '/worktrees/\n/.tasks/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'first');
    const card = join(folder, 'worktrees', 'Q-1');
    mkdirSync(card, { recursive: true });
    const before = await gitBefore(recordedRepos({ project: folder, repos: ['.'], key: 'Q-1', cardRepos: ['.'], cwd: card }), { exclude: await nolzuWrites(folder, join(folder, '.tasks', 'Q-1', 'research'), [null], env), ignored: true, env });

    mkdirSync(join(folder, '.cursor'));
    writeFileSync(join(folder, '.cursor', '.gitignore'), '/mcp.json\n/.gitignore\n');
    writeFileSync(join(folder, '.cursor', 'mcp.json'), '{"mcpServers":{}}\n');
    expect(await gitAfter(before, { ownFolder: join(folder, 'worktrees'), env })).toBeNull();

    writeFileSync(join(folder, 'stray.txt'), 'left by the run\n');
    expect((await gitAfter(before, { ownFolder: join(folder, 'worktrees'), env }))?.diff).toContain('stray.txt');
    expect(existsSync(join(folder, '.cursor', 'mcp.json'))).toBe(true);
  });

  // Nolzu merges nothing into a tracked file, so a change to it is the run's.
  it('still finds a change to a .cursor/mcp.json the project tracks', async () => {
    folder = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-writes-')));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } as Record<string, string>;
    const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, env });
    git('init', '-q', '-b', 'main');
    mkdirSync(join(folder, '.cursor'));
    writeFileSync(join(folder, '.cursor', 'mcp.json'), '{"mcpServers":{}}\n');
    writeFileSync(join(folder, '.gitignore'), '/worktrees/\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    const card = join(folder, 'worktrees', 'Q-1');
    mkdirSync(card, { recursive: true });
    const before = await gitBefore(recordedRepos({ project: folder, repos: ['.'], key: 'Q-1', cardRepos: ['.'], cwd: card }), { exclude: await nolzuWrites(folder, join(folder, '.tasks', 'Q-1', 'research'), [null], env), ignored: true, env });

    writeFileSync(join(folder, '.cursor', 'mcp.json'), '{"mcpServers":{"x":{"command":"sh"}}}\n');
    expect((await gitAfter(before, { ownFolder: join(folder, 'worktrees'), env }))?.diff).toContain('.cursor/mcp.json');
  });
});

