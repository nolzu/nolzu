import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSetting } from '@nolzu/core/node';
import { afterAll, expect, it } from 'vitest';

// The route opens the database of the data folder the environment names, so it points at a temp one
// before the module is imported.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-files-route-'));
process.env.NOLZU_DATA_DIR = join(dir, 'data');
const { GET } = await import('./+server.ts');
const { database } = await import('$lib/db.ts');
const { FILE_POLICY } = await import('$lib/files.ts');

const project = join(dir, 'project');
const card = join(project, '.tasks', 'APP-1');
writeSetting(database(), 'projectPath', project);
mkdirSync(join(card, 'design'), { recursive: true });
writeFileSync(join(card, 'design', 'main-page.html'), '<link rel="stylesheet" href="tokens.css"><h1>Recipes</h1>');
writeFileSync(join(card, 'design', 'tokens.css'), ':root { --ink: #1f2328; }');
writeFileSync(join(project, 'secret.css'), 'secret');
symlinkSync(join(project, 'secret.css'), join(card, 'design', 'link.css'));

afterAll(() => {
  database().close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const get = (path: string, key = 'APP-1') => (GET as unknown as (event: { params: { key: string; path: string } }) => Response)({ params: { key, path } });

// The frame's own address is design/main-page.html, so the browser asks for the tokens at
// design/tokens.css, and this route answers them as a stylesheet it may apply under nosniff.
it('answers the tokens a design screen links beside it, as CSS under the file policy', async () => {
  const answer = get('design/tokens.css');

  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('text/css; charset=utf-8');
  expect(answer.headers.get('content-security-policy')).toBe(FILE_POLICY);
  expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
  expect(answer.headers.get('content-disposition')).toBeNull();
  expect(await answer.text()).toBe(':root { --ink: #1f2328; }');
});

it('answers the screen as a page under the same policy, which lets it link a stylesheet of this app', async () => {
  const answer = get('design/main-page.html');

  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('text/html; charset=utf-8');
  expect(answer.headers.get('content-security-policy')).toBe(FILE_POLICY);
  expect(FILE_POLICY).toContain("style-src 'self' 'unsafe-inline'");
  expect(FILE_POLICY).toContain("default-src 'none'");
  expect(await answer.text()).toContain('href="tokens.css"');
});

it.each(['../../secret.css', join(project, 'secret.css'), 'design/link.css'])('refuses %s, outside the card folder, with a sentence', async (path) => {
  const answer = get(path);

  expect(answer.status).toBe(400);
  expect(await answer.text()).toBe(`${path} leaves the card folder, so it is not shown.`);
});

it('refuses a key that is no card folder and an empty path', async () => {
  expect(get('design/tokens.css', '..').status).toBe(400);
  const empty = get('');
  expect(empty.status).toBe(400);
  expect(await empty.text()).toBe('A file needs a path.');
});
