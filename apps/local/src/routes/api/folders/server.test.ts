import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { handle } from '../../../hooks.server.ts';
import { GET } from './+server.ts';
import { database } from '$lib/db.ts';
import { acceptTerms } from '$lib/terms.ts';

// The server answers only the terms page until they are accepted, and this file tests what comes after.
acceptTerms(database(), true);

// A temp folder holds the home folder and a folder beside it that is outside home.
let top = '';
let home = '';
let saved: string | undefined;

beforeEach(() => {
  top = mkdtempSync(join(tmpdir(), 'nolzu-folders-'));
  home = join(top, 'home');
  mkdirSync(join(home, 'code', 'recipes'), { recursive: true });
  mkdirSync(join(home, 'Documents'));
  mkdirSync(join(home, '.cache'));
  writeFileSync(join(home, 'notes.txt'), 'never read\n');
  mkdirSync(join(top, 'outside', 'secret'), { recursive: true });
  symlinkSync(join(home, 'code'), join(home, 'work'));
  symlinkSync(join(top, 'outside'), join(home, 'out'));
  symlinkSync(join(home, 'notes.txt'), join(home, 'note-link'));
  saved = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  process.env.HOME = saved;
  rmSync(top, { recursive: true, force: true });
});

const ask = async (path: string | null, host = 'localhost:5173') => {
  const address = `http://localhost:5173/api/folders${path === null ? '' : `?path=${encodeURIComponent(path)}`}`;
  const event = { request: new Request(address, { headers: { host } }), url: new URL(address) };
  // Through the server hook, as every request goes, so the host check of the app stands in front.
  const answer = (await handle({ event, resolve: () => GET(event as unknown as Parameters<typeof GET>[0]) } as unknown as Parameters<typeof handle>[0])) as Response;
  return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
};

it('lists the folders inside the home folder by name, with links that lead to a folder in it', async () => {
  const { realpathSync } = await import('node:fs');
  const real = realpathSync(home);

  expect(await ask(null)).toEqual({ status: 200, body: { path: real, parent: null, folders: ['code', 'Documents', 'work'] } });
  expect(await ask(join(home, 'code'))).toEqual({ status: 200, body: { path: join(real, 'code'), parent: real, folders: ['recipes'] } });
});

it('refuses a request addressed to another name before the folder is read', async () => {
  expect(await ask(null, 'evil.example:5173')).toMatchObject({ status: 403 });
});

it.each([
  ['a folder outside home', () => join(top, 'outside')],
  ['the root of the disk', () => '/'],
  ['a path that climbs out with ..', () => join(home, 'code', '..', '..', 'outside')],
  ['a link in home that points out of it', () => join(home, 'out')],
  ['a folder inside such a link', () => join(home, 'out', 'secret')],
])('refuses %s', async (_what, path) => {
  expect(await ask(path())).toEqual({ status: 403, body: { problem: 'Browse shows only folders inside your home folder.' } });
});

// Refused as typed, so the answer does not tell whether something outside home is there.
it('answers the same for a path outside home that is not there', async () => {
  expect(await ask(join(top, 'nothing'))).toEqual({ status: 403, body: { problem: 'Browse shows only folders inside your home folder.' } });
});

// Written out with the dots, because join() would take them out before the endpoint saw them.
it('resolves .. before the check, so a climb to a missing place outside home is refused too', async () => {
  expect(await ask(`${home}/code/../../nothing`)).toEqual({ status: 403, body: { problem: 'Browse shows only folders inside your home folder.' } });
});

it('refuses a path that is not whole, one that is not there and a file', async () => {
  expect(await ask('code')).toEqual({ status: 400, body: { problem: 'Give the folder as a full path.' } });
  expect(await ask(join(home, 'gone'))).toEqual({ status: 404, body: { problem: 'There is no folder at ~/gone.' } });
  expect(await ask(join(home, 'notes.txt'))).toEqual({ status: 400, body: { problem: '~/notes.txt is a file, not a folder.' } });
});
