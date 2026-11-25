import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSetting } from '@nolzu/core/node';
import { afterAll, expect, it } from 'vitest';

// The route opens the database of the data folder the environment names, so it points at a temp one
// before the module is imported.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-file-route-'));
process.env.NOLZU_DATA_DIR = join(dir, 'data');
const { GET } = await import('./+server.ts');
const { database } = await import('$lib/db.ts');

const project = join(dir, 'project');
const card = join(project, '.tasks', 'APP-1');
writeSetting(database(), 'projectPath', project);
mkdirSync(join(card, 'refine'), { recursive: true });
writeFileSync(join(card, 'refine', 'sketch.pdf'), 'pdf');
mkdirSync(join(project, '.tasks', 'APP-2', 'refine'), { recursive: true });
writeFileSync(join(project, '.tasks', 'APP-2', 'refine', 'two.pdf'), 'two');
writeFileSync(join(project, 'secret.md'), 'secret');
symlinkSync(join(project, 'secret.md'), join(card, 'refine', 'link.md'));

afterAll(() => {
  database().close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const download = (path: string, key = 'APP-1') =>
  (GET as unknown as (event: { params: { key: string }; url: URL }) => Response)({
    params: { key },
    url: new URL(`http://localhost/api/card/${key}/file?path=${encodeURIComponent(path)}&download=1`),
  });

it('downloads a file of the card folder as an attachment', async () => {
  const answer = download('refine/sketch.pdf');

  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-disposition')).toContain('attachment; filename="sketch.pdf"');
  expect(await answer.text()).toBe('pdf');
});

it('downloads from the card folder of the key it is asked for', async () => {
  const answer = download('refine/two.pdf', 'APP-2');

  expect(answer.status).toBe(200);
  expect(await answer.text()).toBe('two');
});

// Download is the Files tab's one way to a file it cannot show, so it keeps the jail of the viewer.
it.each(['../../secret.md', join(project, 'secret.md'), 'refine/link.md'])('refuses to download %s, outside the card folder, with a sentence', async (path) => {
  const answer = download(path);

  expect(answer.status).toBe(400);
  expect(await answer.text()).toBe(`${path} leaves the card folder, so it is not shown.`);
});

it('refuses a key that is no card folder, with a sentence', async () => {
  const answer = download('secret.md', '..');

  expect(answer.status).toBe(400);
  expect(await answer.text()).toBe('The card key ".." is not one plain name.');
});
