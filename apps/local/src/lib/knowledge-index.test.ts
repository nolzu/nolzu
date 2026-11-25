import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { writeSetting } from '@nolzu/core/node';
import { ASK_PHASE } from '@nolzu/protocol';
import { GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { knowledgeIndexFiles } from './knowledge-page.ts';
import { createLoop, type Loop } from './loop.ts';

// Every phase that reads code gets the index of the project's knowledge folder, and Claude Code a
// Read rule for the folder.
let dir = '';
let project = '';
let knowledge = '';
let live: Loop;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-knowledge-index-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-project-'));
  knowledge = join(project, '.nolzu', 'knowledge');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env: GIT_ENV });
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', ...GIT_ENV });
  writeSetting(live.db, 'projectPath', project);
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes.\n');
  live.db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-2', 'delivery', 'plan', 'Search recipes')").run();
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const write = (path: string, text: string) => {
  mkdirSync(join(knowledge, path, '..'), { recursive: true });
  writeFileSync(join(knowledge, path), text);
};

it("reads each file's description, or its first line when it has none", () => {
  write('importer.md', '---\ndescription: Read before changing the importer.\n---\n\n# Importer\n');
  write('notes.md', '\n# Notes on search\n\nMore.\n');
  write('empty.md', '');
  write('logo.png', 'not text');

  expect(knowledgeIndexFiles(knowledge).map(({ path, about }) => ({ path, about }))).toEqual([
    { path: 'empty.md', about: 'No description.' },
    { path: 'importer.md', about: 'Read before changing the importer.' },
    { path: 'notes.md', about: 'Notes on search' },
  ]);
  expect(knowledgeIndexFiles(join(project, 'nowhere'))).toEqual([]);
});

it('lists the knowledge files for a phase that reads code, with a read rule for each', () => {
  write('repository.md', '---\ndescription: Where the project folder sits.\n---\n');

  const job = live.buildJob('APP-2', 'plan', 99);

  expect(job.prompt).toContain("## Project knowledge\n\nThe project's knowledge folder is `../../.nolzu/knowledge/`.");
  expect(job.prompt).toContain('- `repository.md`: Where the project folder sits.');
  expect(job.knowledgeReadDir).toBe(knowledge);
  expect(job).not.toHaveProperty('readFiles');
  expect(job.knowledgeDir).toBeNull();
  expect(live.buildJob('APP-2', 'implement', 98).prompt).toContain('## Project knowledge');
  expect(live.buildJob('APP-2', ASK_PHASE, 97).prompt).not.toContain('Project knowledge');
  // The wrap-up writes knowledge, so it has the folder through `--add-dir` and no index.
  const wrapup = live.buildJob('APP-2', 'wrapup', 96);
  expect(wrapup.prompt).not.toContain('Project knowledge');
  expect(wrapup).not.toHaveProperty('knowledgeReadDir');
});

// QA starts in its throwaway copy, so the folder is named in full there and still lands on the project's.
it('names the folder from the place the run starts, and in full from the copy', () => {
  write('run-recipe.md', '---\ndescription: How to test.\n---\n');

  for (const phase of ['plan', 'qa'] as const) {
    const job = live.buildJob('APP-2', phase, 90);
    const folder = /The project's knowledge folder is `([^`]+)\/`/.exec(job.prompt)?.[1] ?? '';
    expect(phase === 'qa' ? folder : resolve(job.cwd, folder)).toBe(phase === 'qa' ? realpathSync(knowledge) : knowledge);
    expect(job.qaCopy === undefined).toBe(phase !== 'qa');
  }
});

it('adds nothing when the folder is empty or missing', () => {
  expect(live.buildJob('APP-2', 'plan', 99).prompt).not.toContain('Project knowledge');
  mkdirSync(knowledge, { recursive: true });
  const job = live.buildJob('APP-2', 'plan', 98);
  expect(job.prompt).not.toContain('Project knowledge');
  expect(job).not.toHaveProperty('readFiles');
  expect(job).not.toHaveProperty('knowledgeReadDir');
});

// A card lists the notes of its own repositories. A card with no list yet gets every repository.
it("lists the card's repositories and counts the files of the others", () => {
  writeSetting(live.db, 'repos', [
    { path: 'api', base: 'main' },
    { path: 'web', base: 'main' },
  ]);
  for (const repo of ['api', 'web']) mkdirSync(join(project, repo));
  write('api/repository.md', '---\ndescription: The api repository.\n---\n');
  write('api/search.md', '---\ndescription: Read before changing search.\n---\n');
  write('web/repository.md', '---\ndescription: The web repository.\n---\n');
  write('web/form.md', '---\ndescription: Read before changing the form.\n---\n');

  const unlisted = live.buildJob('APP-2', 'plan', 99).prompt;
  expect(unlisted).toContain('- `web/form.md`: Read before changing the form.');
  expect(unlisted).not.toContain('about other repositories');

  live.db.prepare(`UPDATE cards SET repos = '["api"]', repos_by = 'plan' WHERE key = 'APP-2'`).run();
  const prompt = live.buildJob('APP-2', 'plan', 98).prompt;
  expect(prompt).toContain('- `api/repository.md`: The api repository.\n- `api/search.md`: Read before changing search.');
  expect(prompt).not.toContain('web/form.md');
  expect(prompt).toContain('2 files about other repositories are left out.');
});
