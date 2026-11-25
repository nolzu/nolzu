import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase, writeSetting } from '@nolzu/core/node';
import { fakeEngine } from '@nolzu/runner';
import { parsePlan } from '@nolzu/ui';
import { parseQaChecklist } from '@nolzu/ui/qa';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { cardFolder, FILE_POLICY, fileResponse, filesFor } from './files.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-files-app-'));
  db = openDatabase(join(dir, 'data'));
  writeSetting(db, 'projectPath', join(dir, 'project'));
  mkdirSync(join(dir, 'project', '.tasks', 'APP-1', 'refine'), { recursive: true });
  writeFileSync(join(dir, 'project', '.tasks', 'APP-1', 'refine', 'refined.md'), '# Refined\n');
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('finds the card folder in the project, where the loop writes it', () => {
  expect(cardFolder(db, 'APP-1')).toBe(join(dir, 'project', '.tasks', 'APP-1'));
  expect(cardFolder(db, '..')).toBeNull();
  expect(filesFor(db, 'APP-1').map((group) => group.folder)).toEqual(['refine']);
});

// The row and the preview header say when the file last changed, in the trail's words, and which
// phase wrote it.
it('says when each file last changed and which phase wrote it', () => {
  const file = join(dir, 'project', '.tasks', 'APP-1', 'refine', 'refined.md');
  const then = new Date(2026, 9, 15, 15, 32);
  utimesSync(file, then, then);

  const [refine] = filesFor(db, 'APP-1', process.env, new Date(2026, 9, 15, 18, 0));

  expect(refine?.files[0]).toMatchObject({ path: 'refine/refined.md', phase: 'refine', when: '15:32' });
});

it('sends a markdown file as text, sandboxed and with no sniffing', async () => {
  const answer = fileResponse(db, 'APP-1', 'refine/refined.md', false);
  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
  expect(answer.headers.get('content-security-policy')).toBe(FILE_POLICY);
  expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
  expect(answer.headers.get('content-disposition')).toBeNull();
  expect(await answer.text()).toBe('# Refined\n');
});

// The Files tab frames a design screen. The policy keeps it from running script or reaching the
// network, lets it link its tokens from this app, and lets only this app frame it.
it('sends an html file as a page that runs nothing and loads nothing from the network', async () => {
  writeFileSync(join(dir, 'project', '.tasks', 'APP-1', 'refine', 'page.html'), '<h1>Recipes</h1>');
  const answer = fileResponse(db, 'APP-1', 'refine/page.html', false);

  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(answer.headers.get('content-disposition')).toBeNull();
  expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
  const policy = answer.headers.get('content-security-policy') ?? '';
  expect(policy.split('; ')).toEqual(['sandbox', "default-src 'none'", "style-src 'self' 'unsafe-inline'", 'img-src data:', 'font-src data:', "frame-ancestors 'self'"]);
  expect(await answer.text()).toBe('<h1>Recipes</h1>');
  expect(fileResponse(db, 'APP-1', 'refine/page.html', true).headers.get('content-disposition')).toBe(`attachment; filename="page.html"; filename*=UTF-8''page.html`);
});

it('refuses an html file over the page cap, as any other file the page shows', () => {
  writeFileSync(join(dir, 'project', '.tasks', 'APP-1', 'refine', 'big.html'), 'x'.repeat(300 * 1024));
  expect(fileResponse(db, 'APP-1', 'refine/big.html', false).status).toBe(413);
});

it('sends a file as an attachment when a download is asked for', () => {
  expect(fileResponse(db, 'APP-1', 'refine/refined.md', true).headers.get('content-disposition')).toBe(`attachment; filename="refined.md"; filename*=UTF-8''refined.md`);
});

it('passes a refusal on with its status and reason', async () => {
  const answer = fileResponse(db, 'APP-1', '../../../etc/passwd', false);
  expect(answer.status).toBe(400);
  expect(await answer.text()).toContain('leaves the card folder');
});

it('sends a file the page cannot show as an attachment, even when no download was asked for', () => {
  writeFileSync(join(dir, 'project', '.tasks', 'APP-1', 'refine', 'bundle.zip'), 'zip');
  expect(fileResponse(db, 'APP-1', 'refine/bundle.zip', false).headers.get('content-disposition')).toBe(`attachment; filename="bundle.zip"; filename*=UTF-8''bundle.zip`);
});

it('sends a file with a name beyond Latin 1, which a plain header cannot hold', async () => {
  writeFileSync(join(dir, 'project', '.tasks', 'APP-1', 'refine', '报告.zip'), 'zip');
  const answer = fileResponse(db, 'APP-1', 'refine/报告.zip', false);
  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-disposition')).toBe(`attachment; filename="__.zip"; filename*=UTF-8''${encodeURIComponent('报告.zip')}`);
});

it('lets a file over the page cap be downloaded, though not shown', () => {
  writeFileSync(join(dir, 'project', '.tasks', 'APP-1', 'refine', 'big.md'), 'x'.repeat(300 * 1024));
  expect(fileResponse(db, 'APP-1', 'refine/big.md', false).status).toBe(413);
  expect(fileResponse(db, 'APP-1', 'refine/big.md', true).status).toBe(200);
});

// A QA screenshot of a full page is bigger than the text cap, and the panel links it without the
// download flag. Capped at a quarter of a megabyte it would answer the click with its size.
it('shows a screenshot over the page cap', () => {
  mkdirSync(join(dir, 'project', '.tasks', 'APP-1', 'qa'), { recursive: true });
  writeFileSync(join(dir, 'project', '.tasks', 'APP-1', 'qa', 'search.png'), 'x'.repeat(300 * 1024));

  const answer = fileResponse(db, 'APP-1', 'qa/search.png', false);

  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('image/png');
  expect(answer.headers.get('content-disposition')).toBeNull();
});

/**
 * What a fake plan run and a fake QA run leave in the card folder, read the way the page reads it.
 *
 * Plan writes the list of what QA will check, and QA reports one row per check in that order. The
 * runner may not import the parser, so the two texts meet here. The list is QA's input, so it sits
 * in the qa folder and is badged internal, like every folder but share.
 */
it('shows the checks a fake plan writes, and reads the rows a fake QA reports on them', async () => {
  const folder = join(dir, 'project', '.tasks', 'APP-1');
  for (const phase of ['plan', 'qa']) {
    for await (const line of fakeEngine(0).spawn({ phase, taskDir: folder }, new AbortController().signal)) void line;
  }

  const qa = filesFor(db, 'APP-1').find((group) => group.folder === 'qa');
  expect(qa?.share).toBe(false);
  expect(qa?.files.map((file) => file.path)).toEqual(expect.arrayContaining(['qa/checks.md', 'qa/report.md']));
  expect(qa?.files.find((file) => file.path === 'qa/checks.md')?.phase).toBe('plan');

  const steps = readFileSync(join(folder, 'qa', 'checks.md'), 'utf8')
    .trim()
    .split('\n')
    // A How line under a check is not a check, and the row keeps the id but not its level.
    .filter((line) => /^\d+\. /.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, '').replace(/^(AC\d+) \((?:must|should)\):/, '$1:'));
  const checklist = parseQaChecklist(readFileSync(join(folder, 'qa', 'report.md'), 'utf8'));
  expect(steps.length).toBeGreaterThan(1);
  // The checks keep their AC ids, and the report row carries the same id beside its step.
  expect(checklist?.rows?.map((row) => (row.ac === undefined ? row.step : `${row.ac}: ${row.step}`))).toEqual(steps);
  expect(checklist?.rows?.map((row) => row.ac)).toEqual([undefined, 'AC1', 'AC2']);
  expect(checklist?.rows?.every((row) => row.result === 'pass')).toBe(true);
});

// The plan a fake run leaves, read with the parser the Overview draws its steps with. The runner may not
// import the parser either, so the two meet here, on one repository and on several.
it('reads the steps and files of the plan a fake plan run writes', async () => {
  const folder = join(dir, 'project', '.tasks', 'APP-1');
  const steps = [
    { text: 'Add filterRecipes(recipes, query) to the recipe list module.', files: ['services/api/src/recipes/list.ts'], covers: ['AC1', 'AC2'] },
    { text: 'Test an empty query and a title match.', files: ['services/api/src/recipes/list.test.ts'], covers: ['AC1', 'AC2'] },
  ];
  for (const repositories of [undefined, ['api', 'web']]) {
    for await (const line of fakeEngine(0).spawn({ phase: 'plan', taskDir: folder, ...(repositories === undefined ? {} : { repositories }) }, new AbortController().signal)) void line;

    expect(parsePlan(readFileSync(join(folder, 'plan', 'plan.md'), 'utf8'))).toEqual({ steps, text: null });
  }
});
