import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CARD_FILE_CAP, listCardFiles, makeCardFolder, readCardFile, readCardText, removeCardFile, sharedFiles, stripSharedAttribution, writeCardFile, writeOwnFile, writerOf } from './card-files.ts';
import { DISCOVERIES_FILE, QA_CHECKS_FILE } from './prompt.ts';

let root = '';
let dir = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nolzu-files-'));
  dir = join(root, 'project', '.tasks', 'APP-1');
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const put = (path: string, content: string | Buffer) => {
  mkdirSync(join(dir, path, '..'), { recursive: true });
  writeFileSync(join(dir, path), content);
};

// The listing's own fields, without the modified time, which a test cannot write down.
const listed = () => listCardFiles(dir).map((group) => ({ ...group, files: group.files.map((file) => ({ ...file, modified: undefined })) }));

it('lists the files by subfolder in phase order, share apart from the rest, with size, type and the phase that wrote each', () => {
  put('refine/summary.md', 'Clearer.\n');
  put('refine/refined.md', '# Refined\n');
  put('share/screenshot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  put('implement/pr.md', 'feat: search\n');
  put('implement/notes.ts', 'export {};\n');

  expect(listed()).toEqual([
    { folder: 'refine', share: false, files: [
      { path: 'refine/refined.md', name: 'refined.md', size: 10, kind: 'markdown', phase: 'refine' },
      { path: 'refine/summary.md', name: 'summary.md', size: 9, kind: 'markdown', phase: 'refine' },
    ] },
    { folder: 'implement', share: false, files: [
      { path: 'implement/notes.ts', name: 'notes.ts', size: 11, kind: 'text', phase: 'implement' },
      { path: 'implement/pr.md', name: 'pr.md', size: 13, kind: 'markdown', phase: 'implement' },
    ] },
    { folder: 'share', share: true, files: [{ path: 'share/screenshot.png', name: 'screenshot.png', size: 4, kind: 'image', phase: null }] },
  ]);
});

// The folder names the phase, because every skill writes to `<card folder>/<phase>/`. The one file a
// phase writes elsewhere is the list of checks Plan leaves in QA's folder, which QA reads there.
it('groups by the phase folder, credits the QA checks to Plan, and names no phase for a file a person put in', () => {
  put('qa/report.md', '# Report\n');
  put('qa/checks.md', '1. Search\n');
  put('plan/plan.md', '# Plan\n');
  put('wrapup/changes.md', 'x');
  put('notes/plan.md', 'x');
  put('sentry.log', 'x');

  expect(listed().map((group) => [group.folder, group.files.map((file) => `${file.path} ${file.phase}`)])).toEqual([
    ['plan', ['plan/plan.md plan']],
    ['qa', ['qa/checks.md plan', 'qa/report.md qa']],
    ['wrapup', ['wrapup/changes.md wrapup']],
    ['', ['sentry.log null']],
    ['notes', ['notes/plan.md null']],
  ]);
  expect(writerOf(QA_CHECKS_FILE)).toBe('plan');
  expect(writerOf('plan/qa/checks.md')).toBe('plan');
  expect(writerOf('share/plan.md')).toBeNull();
});

// Only share/ is share. Git excludes the card folder and the hub never gets a file body, so no phase
// folder, and no file a person put in, is meant for other people.
it('calls only the share folder share', () => {
  for (const path of ['refine/a.md', 'plan/a.md', 'qa/checks.md', 'implement/a.md', 'wrapup/a.md', 'notes/a.md', 'share/a.md', 'top.md']) put(path, 'x');

  expect(listCardFiles(dir).map((group) => [group.folder, group.share])).toEqual(
    expect.arrayContaining([['refine', false], ['plan', false], ['qa', false], ['implement', false], ['wrapup', false], ['notes', false], ['', false], ['share', true]]),
  );
  expect(listCardFiles(dir).filter((group) => group.share)).toHaveLength(1);
});

// A folder a person names after something every object has is still no phase.
it('names no phase for a folder named after an inherited key', () => {
  expect(['constructor/notes.md', 'toString/a.md', '__proto__/b.md'].map(writerOf)).toEqual([null, null, null]);
});

it('gives each file the time it last changed', () => {
  put('plan/plan.md', '# Plan\n');
  const at = new Date('2026-10-15T13:32:00Z');
  utimesSync(join(dir, 'plan/plan.md'), at, at);

  expect(listCardFiles(dir)[0]?.files[0]?.modified).toBe(at.getTime());
});

// The viewer reads text up to the cap and refuses the rest, so a bigger note is a download from the list.
it('lists a text file over the cap a page shows as a download, and a picture of any size as a picture', () => {
  put('implement/progress.md', 'x'.repeat(CARD_FILE_CAP + 1));
  put('implement/small.md', 'x'.repeat(CARD_FILE_CAP));
  put('qa/shot.png', Buffer.alloc(CARD_FILE_CAP + 1));
  put('qa/trace.zip', Buffer.alloc(CARD_FILE_CAP + 1));

  expect(listed().flatMap((group) => group.files.map((file) => `${file.name} ${file.kind}`))).toEqual(['progress.md download', 'small.md markdown', 'shot.png image', 'trace.zip download']);
  // Only the note is too big: the viewer has no view for a zip at any size.
  expect(listed().flatMap((group) => group.files.filter((file) => file.tooBig === true).map((file) => file.name))).toEqual(['progress.md']);
});

// A run once left an npm cache of five thousand files in the card folder, and the tab listed each one.
// A cache folder is counted and never listed, with the group of the folder that holds it.
it('counts a cache folder at any depth instead of listing it, and leaves its files out of the groups', () => {
  put('plan/plan.md', '# Plan\n');
  for (const path of ['.npm/_cacache/a', '.npm/_cacache/b', '.npm/x.json']) put(path, 'x');
  put('implement/node_modules/left-pad/index.js', 'x');
  put('implement/.yarn/cache/a.zip', 'x');
  put('implement/notes.md', 'x');
  put('implement/cache/kept.md', 'x');

  const groups = listed();
  expect(groups.map((group) => [group.folder, group.files.map((file) => file.path), group.caches])).toEqual([
    ['plan', ['plan/plan.md'], undefined],
    ['implement', ['implement/cache/kept.md', 'implement/notes.md'], [{ path: 'implement/.yarn/cache', count: 1 }, { path: 'implement/node_modules', count: 1 }]],
    ['', [], [{ path: '.npm', count: 3 }]],
  ]);
});

it('lists nothing for an empty folder, and for a card folder that is not there yet', () => {
  expect(listCardFiles(dir)).toEqual([]);
  expect(listCardFiles(join(root, 'nowhere'))).toEqual([]);
});

it('reads a markdown file as text with its type', () => {
  put('refine/refined.md', '# Refined\n');
  expect(readCardFile(dir, 'refine/refined.md')).toEqual({ ok: true, kind: 'markdown', type: 'text/markdown; charset=utf-8', bytes: Buffer.from('# Refined\n') });
});

it('reads a png as image bytes with the image type', () => {
  put('share/a.png', Buffer.from([1, 2, 3]));
  const read = readCardFile(dir, 'share/a.png');
  expect(read).toMatchObject({ ok: true, kind: 'image', type: 'image/png' });
});

// A mockup is only useful drawn, so the page frames it, and the route sends it as a page.
it('reads an html file as a page with its type, .htm too', () => {
  put('mockups/main-page.html', '<h1>Recipes</h1>');
  put('mockups/old.HTM', '<p>old</p>');
  expect(readCardFile(dir, 'mockups/main-page.html')).toEqual({ ok: true, kind: 'html', type: 'text/html; charset=utf-8', bytes: Buffer.from('<h1>Recipes</h1>') });
  expect(readCardFile(dir, 'mockups/old.HTM')).toMatchObject({ ok: true, kind: 'html', type: 'text/html; charset=utf-8' });
});

// The design takes the place mockups had, right after architecture, and an old epic's mockups folder still
// shows, named for the phase that wrote it. Its tokens read as text and go out as CSS, so a screen in
// the frame can apply them.
it('lists the design after architecture and the old mockups beside it, and sends tokens.css as css', () => {
  put('plan/plan.md', '1. Store\n');
  put('design/tokens.css', ':root {}');
  put('design/main-page.html', '<h1>Recipes</h1>');
  put('mockups/week.html', '<p>week</p>');
  put('architecture/architecture.md', '## The shape\n');

  expect(listed().map((group) => group.folder)).toEqual(['plan', 'architecture', 'design', 'mockups']);
  expect(listed().find((group) => group.folder === 'design')?.files.map((file) => [file.name, file.kind, file.phase])).toEqual([
    ['main-page.html', 'html', 'design'],
    ['tokens.css', 'text', 'design'],
  ]);
  expect(writerOf('mockups/week.html')).toBe('mockups');
  expect(readCardFile(dir, 'design/tokens.css')).toMatchObject({ ok: true, kind: 'text', type: 'text/css; charset=utf-8' });
  expect(readCardFile(dir, 'design/notes.txt')).toMatchObject({ ok: false, status: 404 });
});

it('lists an html file over the cap a page shows as a download, and refuses to show it', () => {
  put('mockups/big.html', 'x'.repeat(CARD_FILE_CAP + 1));
  put('mockups/small.html', 'x'.repeat(CARD_FILE_CAP));

  expect(listed().flatMap((group) => group.files.map((file) => `${file.name} ${file.kind}`))).toEqual(['big.html download', 'small.html html']);
  expect(readCardFile(dir, 'mockups/big.html')).toMatchObject({ ok: false, status: 413 });
});

it('offers anything else as a download', () => {
  put('share/bundle.zip', 'zip');
  expect(readCardFile(dir, 'share/bundle.zip')).toMatchObject({ ok: true, kind: 'download', type: 'application/octet-stream' });
});

it.each([
  ['../../etc/passwd', 'leaves the card folder'],
  ['/etc/passwd', 'leaves the card folder'],
  ['refine/a\0.md', 'null byte'],
])('refuses %s with 400 and says why', (path, why) => {
  const read = readCardFile(dir, path);
  expect(read).toMatchObject({ ok: false, status: 400 });
  if (!read.ok) expect(read.reason).toContain(why);
});

it('refuses a link inside the folder that points outside it', () => {
  writeFileSync(join(root, 'secret.txt'), 'secret');
  symlinkSync(join(root, 'secret.txt'), join(dir, 'link.txt'));
  mkdirSync(join(root, 'elsewhere'));
  writeFileSync(join(root, 'elsewhere', 'x.md'), 'x');
  symlinkSync(join(root, 'elsewhere'), join(dir, 'folder'));

  for (const path of ['link.txt', 'folder/x.md']) {
    const read = readCardFile(dir, path);
    expect(read).toMatchObject({ ok: false, status: 400 });
    if (!read.ok) expect(read.reason).toContain('leaves the card folder');
  }
});

it('refuses a file over the cap, and names the size and the cap', () => {
  put('share/big.md', 'x'.repeat(2048));
  const read = readCardFile(dir, 'share/big.md', 1024);
  expect(read).toMatchObject({ ok: false, status: 413 });
  if (!read.ok) expect(read.reason).toMatch(/2 kB.*1 kB/);
});

it('answers 404 for a file that is not there', () => {
  expect(readCardFile(dir, 'refine/none.md')).toMatchObject({ ok: false, status: 404 });
});

it('lists no link, so the listing never walks or names anything outside the folder', () => {
  put('refine/summary.md', 'x');
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'secret.md'), 'secret');
  symlinkSync(join(root, 'outside'), join(dir, 'linked'));
  symlinkSync(join(root, 'outside', 'secret.md'), join(dir, 'refine', 'link.md'));

  expect(listCardFiles(dir).flatMap((group) => group.files.map((file) => file.path))).toEqual(['refine/summary.md']);
});

it('lists nothing when the card folder is a file', () => {
  rmSync(dir, { recursive: true });
  writeFileSync(dir, 'not a folder');
  expect(listCardFiles(dir)).toEqual([]);
});

// Every phase adds to the discoveries and the wrap-up reads them first, so the list opens with them.
// The other files at the top of the card folder come with them, after them.
it('lists the discoveries first, above the phase folders, and the top of the card folder last without them', () => {
  put('plan/plan.md', '# Plan\n');
  put('sentry.log', 'x');
  put('aaa.md', 'x');
  expect(listed().map((group) => group.folder)).toEqual(['plan', '']);

  put(DISCOVERIES_FILE, '- The list sorts before it filters, in api/src/recipes.ts: the order is free (plan)\n');
  expect(listed().map((group) => [group.folder, group.files.map((file) => `${file.path} ${file.phase}`)])).toEqual([
    ['', ['discoveries.md null', 'aaa.md null', 'sentry.log null']],
    ['plan', ['plan/plan.md plan']],
  ]);
});

// A real pull request text ended on the engine's own line. The shared files lose such lines after every
// run, and every other file of the card stays as the run left it.
it('takes the lines that name a tool as the writer out of share/ and pr.md only', () => {
  const tail = `\n\n\u{1F916} ${['Generated', 'with'].join(' ')} Claude Code\n`;
  put('implement/pr.md', `Search\n\n## What changed\n\nA box.${tail}`);
  put('share/SUMMARY.md', `The list has a search box.${tail}`);
  put('share/TESTING.md', 'Open the list.\n');
  put('implement/progress.md', `Base: abc${tail}`);

  expect(sharedFiles(dir)).toEqual(['share/SUMMARY.md', 'share/TESTING.md', 'implement/pr.md']);
  expect(stripSharedAttribution(dir)).toEqual(['share/SUMMARY.md', 'implement/pr.md']);
  expect(readFileSync(join(dir, 'implement/pr.md'), 'utf8')).toBe('Search\n\n## What changed\n\nA box.\n');
  expect(readFileSync(join(dir, 'share/SUMMARY.md'), 'utf8')).toBe('The list has a search box.\n');
  expect(readFileSync(join(dir, 'implement/progress.md'), 'utf8')).toBe(`Base: abc${tail}`);
  expect(stripSharedAttribution(dir)).toEqual([]);
});

// A link could point out of the card folder, and a folder named like a note cannot be read, so neither
// is touched and neither stops the files after it.
it('skips a link and a folder named like a note, and still strips the rest', () => {
  const tail = `\n\n\u{1F916} ${['Generated', 'with'].join(' ')} Claude Code\n`;
  const outside = join(root, 'outside.md');
  writeFileSync(outside, `Not the card's.${tail}`);
  mkdirSync(join(dir, 'share', 'a.md'), { recursive: true });
  symlinkSync(outside, join(dir, 'share', 'b.md'));
  put('share/c.md', `Ours.${tail}`);
  mkdirSync(join(dir, 'implement'), { recursive: true });
  symlinkSync(outside, join(dir, 'implement', 'pr.md'));

  expect(sharedFiles(dir)).toEqual(['share/c.md']);
  expect(stripSharedAttribution(dir)).toEqual(['share/c.md']);
  expect(readFileSync(outside, 'utf8')).toBe(`Not the card's.${tail}`);
});

// The plan an epic's Plan writes for colleagues sits in share/ too, so it loses such a line the same way.
it('takes the tool line out of the plan for other people', () => {
  const tail = `\n\n\u{1F916} ${['Generated', 'with'].join(' ')} Claude Code\n`;
  put('share/PLAN.md', `## Tasks\n\n### 1. Filter by title\nThe api filters.${tail}`);

  expect(stripSharedAttribution(dir)).toEqual(['share/PLAN.md']);
  expect(readFileSync(join(dir, 'share/PLAN.md'), 'utf8')).toBe('## Tasks\n\n### 1. Filter by title\nThe api filters.\n');
});

it('lists nothing through a share folder that is a link', () => {
  const elsewhere = join(root, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'x.md'), 'x\n');
  symlinkSync(elsewhere, join(dir, 'share'));
  expect(sharedFiles(dir)).toEqual([]);
});

it('strips nothing in a card folder with no shared files', () => {
  expect(stripSharedAttribution(dir)).toEqual([]);
});

// A run may leave a named pipe where a file is read. Opened the normal way, it waits for a writer
// and holds the whole app, which no page or Ctrl+C then reaches.
it('answers at once for a named pipe in the card folder, and shows nothing of it', () => {
  mkdirSync(join(dir, 'plan'), { recursive: true });
  execFileSync('mkfifo', [join(dir, 'plan', 'plan.md')]);

  expect(readCardFile(dir, 'plan/plan.md')).toMatchObject({ ok: false, status: 404, reason: 'plan/plan.md is not a plain file, so it is not shown.' });
});

// Every run may write its card folder, so a run can leave a link there that aims Nolzu's own write or
// read at a file outside it. The helpers neither write, read nor delete through one.
const outsideFile = (name: string, text: string): string => {
  const path = join(root, name);
  writeFileSync(path, text);
  return path;
};

it('writes a file of the card folder, making the folders it sits in', () => {
  writeCardFile(dir, 'refine/prompt.md', 'the prompt\n');
  writeCardFile(dir, 'refine/prompt.md', 'shorter\n');
  expect(readFileSync(join(dir, 'refine', 'prompt.md'), 'utf8')).toBe('shorter\n');
  expect(readCardText(dir, 'refine/prompt.md')).toBe('shorter\n');
  expect(readCardText(dir, 'refine/none.md')).toBeNull();
});

it('writes nothing through a link at the file, at a folder above it, or in place of the card folder', () => {
  const target = outsideFile('zshenv', 'mine\n');
  put('refine/x.md', 'x');
  symlinkSync(target, join(dir, 'refine', 'prompt.md'));
  expect(() => writeCardFile(dir, 'refine/prompt.md', 'echo planted\n')).toThrow(/link/);

  const folder = join(root, 'elsewhere');
  mkdirSync(folder);
  symlinkSync(folder, join(dir, 'plan'));
  expect(() => writeCardFile(dir, 'plan/prompt.md', 'echo planted\n')).toThrow(/link/);
  expect(() => writeCardFile(dir, 'plan/deeper/prompt.md', 'echo planted\n')).toThrow(/link/);
  expect(() => makeCardFolder(dir, 'plan/evidence')).toThrow(/link/);

  const moved = join(root, 'moved-card');
  mkdirSync(moved);
  const card = join(root, 'project', '.tasks', 'APP-2');
  symlinkSync(moved, card);
  expect(() => writeCardFile(card, 'refine/prompt.md', 'echo planted\n')).toThrow(/link/);
  writeFileSync(join(moved, 'brief.md'), 'not-a-real-key\n');
  expect(readCardText(card, 'brief.md')).toBeNull();
  rmSync(join(moved, 'brief.md'));

  expect(readFileSync(target, 'utf8')).toBe('mine\n');
  expect(readdirSync(folder)).toEqual([]);
  expect(readdirSync(moved)).toEqual([]);
});

// A hard link is a second name of a file outside, and a plain open follows it. It is refused before
// anything in the file changes.
it('writes and reads nothing through a hard link', () => {
  const target = outsideFile('notes.txt', 'mine\n');
  mkdirSync(join(dir, 'qa'));
  linkSync(target, join(dir, 'qa', 'report.md'));
  expect(() => writeCardFile(dir, 'qa/report.md', 'over\n')).toThrow(/plain file/);
  expect(readCardText(dir, 'qa/report.md')).toBeNull();
  expect(readFileSync(target, 'utf8')).toBe('mine\n');
});

it('reads nothing through a link at the file or at a folder above it, and no pipe', () => {
  const secret = outsideFile('id_test', 'not-a-real-key\n');
  mkdirSync(join(dir, 'qa'));
  symlinkSync(secret, join(dir, 'qa', 'report.md'));
  expect(readCardText(dir, 'qa/report.md')).toBeNull();

  const folder = join(root, 'keys');
  mkdirSync(folder);
  writeFileSync(join(folder, 'report.md'), 'not-a-real-key\n');
  symlinkSync(folder, join(dir, 'review'));
  expect(readCardText(dir, 'review/report.md')).toBeNull();

  execFileSync('mkfifo', [join(dir, 'qa', 'pipe.md')]);
  expect(readCardText(dir, 'qa/pipe.md')).toBeNull();
  expect(() => writeCardFile(dir, 'qa/pipe.md', 'x')).toThrow();
});

it('removes a link as a link, and nothing through a link above the file', () => {
  const target = outsideFile('summary.md', 'mine\n');
  mkdirSync(join(dir, 'plan'));
  symlinkSync(target, join(dir, 'plan', 'summary.md'));
  removeCardFile(dir, 'plan/summary.md');
  expect(existsSync(join(dir, 'plan', 'summary.md'))).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe('mine\n');

  const folder = join(root, 'elsewhere');
  mkdirSync(folder);
  writeFileSync(join(folder, 'summary.md'), 'mine\n');
  symlinkSync(folder, join(dir, 'refine'));
  removeCardFile(dir, 'refine/summary.md');
  expect(readFileSync(join(folder, 'summary.md'), 'utf8')).toBe('mine\n');
});

// The card folder itself may be a link a run put in its place. Nothing in the folder it points to is
// removed or listed.
it('removes and lists nothing through a link in place of the card folder', () => {
  const moved = join(root, 'moved-card');
  mkdirSync(join(moved, 'plan'), { recursive: true });
  writeFileSync(join(moved, 'brief.md'), 'mine\n');
  writeFileSync(join(moved, 'plan', 'summary.md'), 'mine\n');
  const card = join(root, 'project', '.tasks', 'APP-2');
  symlinkSync(moved, card);
  removeCardFile(card, 'brief.md');
  removeCardFile(card, 'plan/summary.md');
  expect(readdirSync(moved).sort()).toEqual(['brief.md', 'plan']);
  expect(readdirSync(join(moved, 'plan'))).toEqual(['summary.md']);
  expect(listCardFiles(card)).toEqual([]);
  expect(listCardFiles(moved)).not.toEqual([]);
});

// The swap a run could make between Nolzu's check of the folders and the open: the folder found inside
// is a link to one outside by the time the file opens. The open file is checked against the folder
// found, before anything is written.
it('writes nothing when a folder on the way became a link after the check', () => {
  const target = outsideFile('prompt.md', 'mine\n');
  mkdirSync(join(dir, 'plan'));
  const checked = realpathSync(join(dir, 'plan'));
  rmSync(join(dir, 'plan'), { recursive: true });
  symlinkSync(dirname(target), join(dir, 'plan'));
  expect(() => writeOwnFile(join(dir, 'plan', 'prompt.md'), 'echo planted\n', 'plan/prompt.md', checked)).toThrow(/moved out of its folder/);
  expect(readFileSync(target, 'utf8')).toBe('mine\n');
});

it('refuses a path that leaves the card folder', () => {
  expect(() => writeCardFile(dir, '../APP-2/x.md', 'x')).toThrow(/inside the card folder/);
  expect(() => writeCardFile(dir, join(root, 'x.md'), 'x')).toThrow(/inside the card folder/);
  expect(readCardText(dir, '../../x.md')).toBeNull();
});
