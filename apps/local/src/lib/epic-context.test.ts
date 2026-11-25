import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkCards, writeSetting } from '@nolzu/core/node';
import { GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createLoop, type Loop } from './loop.ts';

// A task of an epic runs with the epic's documents as read-only context, so its Refine starts from
// what the epic's phases found and not from one line.
let dir = '';
let project = '';
let live: Loop;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-epic-context-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-project-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env: GIT_ENV });
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
  writeSetting(live.db, 'projectPath', project);
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes.\n');
  live.db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-1', 'epics', 'delivery', 'Meal plans')").run();
  live.db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-2', 'delivery', 'refine', 'Show a week view')").run();
  live.db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-3', 'delivery', 'refine', 'Print the week')").run();
  linkCards(live.db, 'APP-1', 'APP-2');
  // The epic wrote a brief and a plan, and no architecture or design.
  for (const doc of ['refine/refined.md', 'plan/plan.md']) {
    mkdirSync(join(project, '.tasks', 'APP-1', doc, '..'), { recursive: true });
    writeFileSync(join(project, '.tasks', 'APP-1', doc), '# APP-1\n');
  }
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it.each(['refine', 'implement'] as const)("names the epic's documents that exist in a task's %s run, and hands them to the engine", (phase) => {
  const job = live.buildJob('APP-2', phase, 99);

  expect(job.prompt).toContain('## The epic');
  expect(job.prompt).toContain('This card is a task of APP-1: Meal plans.');
  expect(job.prompt).toContain('- `../../.tasks/APP-1/refine/refined.md`');
  expect(job.prompt).toContain('- `../../.tasks/APP-1/plan/plan.md`');
  expect(job.prompt).not.toContain('architecture.md');
  expect(job.prompt).not.toContain('design.md');
  expect(job.epicFiles).toEqual([join(project, '.tasks', 'APP-1', 'refine', 'refined.md'), join(project, '.tasks', 'APP-1', 'plan', 'plan.md')]);
});

// A task's wrap-up turns the epic's discoveries into knowledge too, so the file goes with the documents.
it("names the epic's discoveries after its documents, when the epic has them", () => {
  writeFileSync(join(project, '.tasks', 'APP-1', 'discoveries.md'), '- The week starts on Monday, in web/src/week.ts: a Sunday plan lands in the wrong week (plan)\n');

  const job = live.buildJob('APP-2', 'wrapup', 99);

  expect(job.prompt).toContain('- `../../.tasks/APP-1/plan/plan.md`\n- `../../.tasks/APP-1/discoveries.md`');
  expect(job.epicFiles?.at(-1)).toBe(join(project, '.tasks', 'APP-1', 'discoveries.md'));
});

// The epic's QA checks say what QA checks across all its tasks, so a task's run reads them with the plan.
it("names the epic's QA checks after its plan, with a read rule for the engine", () => {
  mkdirSync(join(project, '.tasks', 'APP-1', 'qa'), { recursive: true });
  writeFileSync(join(project, '.tasks', 'APP-1', 'qa', 'checks.md'), '1. AC1 (must): The week view lists seven days\n');

  const job = live.buildJob('APP-2', 'refine', 99);

  expect(job.prompt).toContain('- `../../.tasks/APP-1/plan/plan.md`\n- `../../.tasks/APP-1/qa/checks.md`');
  expect(job.epicFiles).toContain(join(project, '.tasks', 'APP-1', 'qa', 'checks.md'));
});

it('gives a card with no epic no epic paragraph and no files', () => {
  const job = live.buildJob('APP-3', 'refine', 99);

  expect(job.prompt).not.toContain('## The epic');
  expect(job).not.toHaveProperty('epicFiles');
});

it('gives the epic itself nothing, though it is linked to its task', () => {
  const job = live.buildJob('APP-1', 'refine', 99);

  expect(job.prompt).not.toContain('## The epic');
  expect(job).not.toHaveProperty('epicFiles');
});

it('reads the documents of the epic a task is linked to when there are two epics', () => {
  live.db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-5', 'epics', 'delivery', 'Shopping list')").run();
  live.db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-6', 'delivery', 'refine', 'Group by aisle')").run();
  linkCards(live.db, 'APP-5', 'APP-6');
  mkdirSync(join(project, '.tasks', 'APP-5', 'design'), { recursive: true });
  writeFileSync(join(project, '.tasks', 'APP-5', 'design', 'design.md'), '# APP-5\n');

  const job = live.buildJob('APP-6', 'refine', 99);

  expect(job.prompt).toContain('This card is a task of APP-5: Shopping list.');
  expect(job.prompt).toContain('- `../../.tasks/APP-5/design/design.md`');
  expect(job.prompt).not.toContain('APP-1');
  expect(job.epicFiles).toEqual([join(project, '.tasks', 'APP-5', 'design', 'design.md')]);
});

// Implement reuses the epic's tokens and matches its screens, and QA compares with them, so each file of
// the design goes with its list. An epic drawn before Design keeps its mockups.
it.each(['implement', 'qa'] as const)("hands a task's %s run the epic's design screens and tokens, and the old mockups", (phase) => {
  const epic = join(project, '.tasks', 'APP-1');
  const written: [string, string][] = [
    ['design/design.md', '- main-page.html\n'],
    ['design/main-page.html', '<link rel="stylesheet" href="tokens.css">'],
    ['design/tokens.css', ':root {}'],
    ['mockups/mockups.md', '- week.html\n'],
    ['mockups/week.html', '<p>week</p>'],
  ];
  for (const [path, body] of written) {
    mkdirSync(join(epic, path, '..'), { recursive: true });
    writeFileSync(join(epic, path), body);
  }

  const job = live.buildJob('APP-2', phase, 99);

  expect(job.epicFiles).toEqual(
    ['refine/refined.md', 'mockups/mockups.md', 'mockups/week.html', 'design/design.md', 'design/main-page.html', 'design/tokens.css', 'plan/plan.md'].map((doc) => join(epic, ...doc.split('/'))),
  );
  // QA starts in its throwaway copy, so its prompt names the epic's real folder in full.
  const from = phase === 'qa' ? realpathSync(epic) : '../../.tasks/APP-1';
  expect(job.qaCopy == null).toBe(phase !== 'qa');
  expect(job.prompt).toContain(`- \`${from}/design/design.md\`\n- \`${from}/design/main-page.html\`\n- \`${from}/design/tokens.css\``);
});

it("gives an Ask on a task nothing of its epic's documents", () => {
  const job = live.buildJob('APP-2', 'ask', 99);

  expect(job.prompt).not.toContain('## The epic');
  expect(job).not.toHaveProperty('epicFiles');
});

it('takes only an epic for the epic: a card linked to another task or to another epic gets nothing', () => {
  live.db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-5', 'epics', 'delivery', 'Shopping list')").run();
  linkCards(live.db, 'APP-3', 'APP-2');
  linkCards(live.db, 'APP-1', 'APP-5');
  // Each one has a document, so a wrong pick would show.
  for (const other of ['APP-2', 'APP-5']) {
    mkdirSync(join(project, '.tasks', other, 'plan'), { recursive: true });
    writeFileSync(join(project, '.tasks', other, 'plan', 'plan.md'), '# plan\n');
  }

  for (const key of ['APP-3', 'APP-1']) {
    const job = live.buildJob(key, 'refine', 99);
    expect(job.prompt, key).not.toContain('## The epic');
    expect(job, key).not.toHaveProperty('epicFiles');
  }
});
