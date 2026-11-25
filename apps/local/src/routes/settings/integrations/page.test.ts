import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterAll, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';
import Page from './+page.svelte';

// The keychain is a Map, gh is a fixed answer and Jira is a fake fetch, so nothing here reaches this
// machine's keychain, runs gh or opens a socket.
const held = vi.hoisted(() => new Map<string, string>());
vi.mock('@nolzu/runner', async (real) => ({
  ...(await real<object>()),
  createKeychain: () => ({
    read: async (name: string) => held.get(name) ?? null,
    write: async (name: string, secret: string) => void held.set(name, secret),
    remove: async (name: string) => void held.delete(name),
  }),
}));
vi.mock('$lib/new-project.ts', () => ({ ghLogin: async () => ({ found: true, signedIn: true, account: 'dana' }) }));
const jira = vi.hoisted(() => ({ projects: [] as string[], asked: [] as string[] }));
vi.stubGlobal('fetch', async (url: string) => {
  jira.asked.push(url);
  const keys = new URL(url).searchParams.getAll('keys');
  return new Response(JSON.stringify({ values: jira.projects.filter((key) => keys.includes(key)).map((key) => ({ key })) }));
});

// Not fake mode: fake mode ignores NOLZU_DATA_DIR on purpose.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-integrations-route-'));
process.env.NOLZU_DATA_DIR = dir;
const { actions, load } = await import('./+page.server.ts');

const TOKEN = 'ATATT3xFfGF0-recipe-token';
const post = (body: Record<string, string>) => ({ request: new Request('http://localhost/settings/integrations', { method: 'POST', body: new URLSearchParams(body) }) });
const loaded = () => load({} as never) as unknown as { gh: Promise<unknown>; jira: { site: string | null; email: string | null } };

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('connects, edits and disconnects Jira, and never hands the token back', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', '/home/dev/recipes');
  await expect(loaded().gh).resolves.toEqual({ found: true, signedIn: true, account: 'dana' });
  expect(loaded().jira).toEqual({ site: null, email: null });

  const refused = (await actions.jira!(post({ site: 'http://you.atlassian.net', email: 'dana@example.com', token: TOKEN }) as never)) as { status: number; data: object };
  expect(refused.status).toBe(400);
  expect(refused.data).toMatchObject({ field: 'jira', site: 'http://you.atlassian.net', email: 'dana@example.com' });
  expect(JSON.stringify(refused)).not.toContain(TOKEN);
  expect(held.size).toBe(0);

  expect(await actions.jira!(post({ site: 'https://you.atlassian.net', email: 'dana@example.com', token: TOKEN }) as never)).toEqual({ field: 'jira', saved: true });
  expect(loaded().jira).toEqual({ site: 'https://you.atlassian.net', email: 'dana@example.com' });
  expect([...held]).toEqual([['jira-token', TOKEN]]);
  expect(JSON.stringify(loaded())).not.toContain(TOKEN);
  // The open project reads no Jira, so Jira was not asked about its prefix, and it still reads none.
  expect(jira.asked).toEqual([]);
  expect(getSetting(db, 'ticketSystem')).toBe('local');

  // Edit with the token box empty keeps the token for the same site, and asks for it again for another.
  expect(await actions.jira!(post({ site: 'https://you.atlassian.net', email: 'sam@example.com', token: '' }) as never)).toEqual({ field: 'jira', saved: true });
  expect(loaded().jira).toEqual({ site: 'https://you.atlassian.net', email: 'sam@example.com' });
  expect(held.get('jira-token')).toBe(TOKEN);
  expect(await actions.jira!(post({ site: 'https://kitchen.atlassian.net', email: 'sam@example.com', token: '' }) as never)).toMatchObject({ status: 400 });
  expect(loaded().jira).toEqual({ site: 'https://you.atlassian.net', email: 'sam@example.com' });

  expect(await actions.disconnect!({} as never)).toEqual({ field: 'disconnect', saved: true });
  expect(loaded().jira).toEqual({ site: null, email: null });
  expect(held.size).toBe(0);
  db.close();
});

// A connect asks Jira about the open project's prefix when the project reads Jira.
it('keeps the clash a connect finds for a project that reads Jira', async () => {
  const db = openDatabase(dir);
  writeSetting(db, 'ticketSystem', 'jira');
  writeSetting(db, 'localKeyPrefix', 'WORK');
  jira.projects = ['WORK'];

  await actions.jira!(post({ site: 'https://you.atlassian.net', email: 'dana@example.com', token: TOKEN }) as never);

  expect(jira.asked).toHaveLength(1);
  expect(getSetting(db, 'jiraKeyClash')).toEqual({ prefix: 'WORK', site: 'https://you.atlassian.net', suggestion: 'WRK' });
  db.close();
});

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const drawn = (jiraLogin: { site: string | null; email: string | null }, gh: object = { found: true, signedIn: true, account: 'dana' }, form: object | null = null) => {
  drawnAt('/settings/integrations');
  return render(Page as never, { props: { data: { gh, jira: jiraLogin }, form } } as never);
};

it('draws GitHub read only, and Jira connected with Edit and Disconnect', () => {
  const { body, head } = drawn({ site: 'https://you.atlassian.net', email: 'dana@example.com' });
  const row = (id: string) => text(body.slice(body.indexOf(`data-integration="${id}"`), body.indexOf('</div>', body.indexOf(`data-integration="${id}"`) + 400)));

  expect(head).toContain('<title>Integrations · Settings · Nolzu</title>');
  expect(text(body)).toContain('Signed in with gh as dana');
  expect(text(body)).toContain('Connected to you.atlassian.net as dana@example.com');
  expect(row('jira')).toContain('Jira');
  expect(body).toMatch(/>\s*Edit\s*</);
  expect(body).toMatch(/action="\?\/disconnect"[^]*?>\s*Disconnect\s*</);
  // The fields stay shut until Edit.
  expect(body).not.toContain('data-jira-form');
  expect(body).not.toContain('Time trackers');
});

it('offers Connect when Jira is not connected, and says what to run when gh is not signed in', () => {
  const body = drawn({ site: null, email: null }, { found: true, signedIn: false, account: null }).body;

  expect(text(body)).toContain('Jira Not connected');
  expect(body).toMatch(/>\s*Connect\s*</);
  expect(body).not.toContain('?/disconnect');
  expect(text(body)).toContain('Not signed in. Run gh auth login in a terminal.');
  expect(text(drawn({ site: null, email: null }, { found: false, signedIn: false, account: null }).body)).toContain('gh is not installed.');
});

it('opens the fields on a refusal with what was typed and the reason, and an empty token box', () => {
  const body = drawn({ site: null, email: null }, undefined, { field: 'jira', message: 'A Jira site address starts with https.', site: 'http://you.atlassian.net', email: 'dana@example.com' }).body;

  expect(body).toContain('data-jira-form');
  expect(body).toContain('value="http://you.atlassian.net"');
  expect(body).toContain('value="dana@example.com"');
  expect(text(body)).toContain('A Jira site address starts with https.');
  expect(body).toMatch(/id="jira-token"[^>]*type="password"/);
  expect(body).not.toMatch(/id="jira-token"[^>]*value=/);
});
