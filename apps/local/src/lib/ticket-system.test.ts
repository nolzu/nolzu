import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { createKeychain, JIRA_TOKEN_NAME, type JiraFetch, keychainAccount, type KeychainRun } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { checkKeyClash, connectJira, disconnectJira, jiraReader, otherPrefixes, postJira, switchTickets } from './ticket-system.ts';

// Shaped like a token Atlassian issues, and found nowhere but the fake keychain below.
const TOKEN = 'ATATT3xFfGF0-recipe-token-0123456789';
const GOOD = { site: 'https://you.atlassian.net', email: 'dana@example.com', token: TOKEN };

let dir = '';
let db: DatabaseSync;

// The real keychain module over a Map, the way a Linux keyring answers: the account in argv, the
// secret on stdin. Nothing here runs a command or reaches the machine's keychain.
function fakeKeychain() {
  const entries = new Map<string, string>();
  const calls: string[] = [];
  const run: KeychainRun = async (_command, args, input) => {
    const account = args[args.indexOf('account') + 1] ?? '';
    calls.push(`${args[0]} ${account}`);
    if (args[0] === 'store') entries.set(account, input);
    if (args[0] === 'clear') entries.delete(account);
    if (args[0] === 'lookup') {
      const held = entries.get(account);
      return held === undefined ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: held, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { entries, calls, keychain: createKeychain('linux', run, dir) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-tickets-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Both tables, because a machine key's row lives in machine.db.
const stored = () => JSON.stringify(db.prepare('SELECT key, value FROM main.settings UNION ALL SELECT key, value FROM machine.settings').all());

it.each([
  [{ ...GOOD, site: 'http://you.atlassian.net' }, /starts with https/],
  [{ ...GOOD, site: 'you.atlassian.net' }, /not a site address/],
  [{ ...GOOD, email: 'dana' }, /address you sign in to Jira with/],
  [{ ...GOOD, email: TOKEN }, /address you sign in to Jira with/],
  [{ ...GOOD, token: '   ' }, /Paste an API token/],
])('refuses a bad connection and stores nothing: %j', async (form, said) => {
  const { entries, calls, keychain } = fakeKeychain();

  await expect(connectJira(db, keychain, form)).resolves.toMatch(said);

  expect(calls).toEqual([]);
  expect(entries.size).toBe(0);
  expect(getSetting(db, 'ticketSystem')).toBe('local');
  expect(getSetting(db, 'jiraSite')).toBeNull();
});

it("stores the site and the email, and puts the token in this data folder's keychain entry only", async () => {
  const { entries, keychain } = fakeKeychain();

  await expect(connectJira(db, keychain, { ...GOOD, site: 'https://you.atlassian.net/jira/your-work', email: ' dana@example.com ' })).resolves.toBeNull();

  // The login is the machine's. Which project reads Jira is each project's own choice.
  expect(getSetting(db, 'ticketSystem')).toBe('local');
  expect(getSetting(db, 'jiraSite')).toBe('https://you.atlassian.net');
  expect(getSetting(db, 'jiraEmail')).toBe('dana@example.com');
  expect([...entries]).toEqual([[keychainAccount(JIRA_TOKEN_NAME, dir), TOKEN]]);
  expect(stored()).not.toContain(TOKEN);
});

it('says the keychain refused and stores no setting when the keychain refuses the token', async () => {
  const { keychain } = fakeKeychain();

  await expect(connectJira(db, keychain, { ...GOOD, token: 'with "a quote"' })).resolves.toMatch(/printable ASCII/);

  expect(getSetting(db, 'ticketSystem')).toBe('local');
  expect(getSetting(db, 'jiraSite')).toBeNull();
});

// Edit on Settings, Integrations changes the email with the token box left empty.
it('keeps the token it holds when a connected machine saves an empty token for the same site', async () => {
  const { entries, keychain } = fakeKeychain();
  await connectJira(db, keychain, GOOD);

  await expect(connectJira(db, keychain, { site: GOOD.site, email: 'sam@example.com', token: '' })).resolves.toBeNull();

  expect(getSetting(db, 'jiraEmail')).toBe('sam@example.com');
  expect(entries.get(keychainAccount(JIRA_TOKEN_NAME, dir))).toBe(TOKEN);
});

// The token was made for one site. Kept for another, the next call would send it to whoever runs that address.
it('asks for the token again when the site changes', async () => {
  const { keychain } = fakeKeychain();
  await connectJira(db, keychain, GOOD);
  const site = getSetting(db, 'jiraSite');

  await expect(connectJira(db, keychain, { site: 'https://kitchen.atlassian.net', email: 'sam@example.com', token: '' })).resolves.toMatch(/Paste the API token again/);
  expect(getSetting(db, 'jiraSite')).toBe(site);
  await expect(connectJira(db, keychain, { site: 'https://kitchen.atlassian.net', email: 'sam@example.com', token: 'ATATT3xFfGF0-for-kitchen' })).resolves.toBeNull();
});

it('replaces the token when a new one is saved', async () => {
  const { entries, keychain } = fakeKeychain();
  await connectJira(db, keychain, GOOD);

  await connectJira(db, keychain, { ...GOOD, token: 'ATATT3xFfGF0-the-new-one' });

  expect(entries.get(keychainAccount(JIRA_TOKEN_NAME, dir))).toBe('ATATT3xFfGF0-the-new-one');
});

it('switches the system both ways, and refuses Jira before it was connected', async () => {
  expect(switchTickets(db, 'jira')).toBe('Connect Jira first in Settings, Integrations, with the site address, the account email and an API token.');
  expect(switchTickets(db, 'linear')).toBe('The ticket system is local or jira.');
  expect(getSetting(db, 'ticketSystem')).toBe('local');

  await connectJira(db, fakeKeychain().keychain, GOOD);
  expect(switchTickets(db, 'local')).toBeNull();
  expect(getSetting(db, 'ticketSystem')).toBe('local');
  // The connection stays, so Jira is one press away.
  expect(getSetting(db, 'jiraSite')).toBe('https://you.atlassian.net');
  expect(switchTickets(db, 'jira')).toBeNull();
  expect(getSetting(db, 'ticketSystem')).toBe('jira');
});

it('reads no keychain on a local project', async () => {
  const { calls, keychain } = fakeKeychain();

  await expect(jiraReader(db, keychain)).resolves.toBeNull();

  expect(calls).toEqual([]);
});

it('names Settings, Integrations when the token is missing', async () => {
  writeSetting(db, 'ticketSystem', 'jira');
  writeSetting(db, 'jiraSite', 'https://you.atlassian.net');
  writeSetting(db, 'jiraEmail', 'dana@example.com');
  const fetched: string[] = [];
  const fetcher: JiraFetch = async (url) => {
    fetched.push(url);
    return new Response('{}');
  };

  await expect(jiraReader(db, fakeKeychain().keychain, fetcher)).rejects.toThrow(
    'There is no Jira API token on this machine, so nothing can be read from Jira. Connect Jira again in Settings, Integrations at /settings/integrations.',
  );
  expect(fetched).toEqual([]);
});

it('answers Connect Jira with a sentence or nothing, and never with the token', async () => {
  const { keychain } = fakeKeychain();
  const jira = fakeJira([]);
  const post = (body: object) => postJira(db, keychain, new Request('http://localhost/api/tickets/jira', { method: 'POST', body: JSON.stringify(body) }), jira.fetcher);

  const refused = await post({ ...GOOD, email: 'not an email' });
  expect(refused.status).toBe(400);
  expect(await refused.text()).not.toContain(TOKEN);

  const made = await post(GOOD);
  expect(made.status).toBe(200);
  const said = await made.text();
  expect(said).toBe('{"ticketSystem":"jira"}');
  // A Jira link pasted into Add card: this project reads Jira now, and its prefix was checked.
  expect(getSetting(db, 'ticketSystem')).toBe('jira');
  expect(jira.asked).toHaveLength(1);
});

it('disconnects: the token leaves the keychain and the site and email leave the settings', async () => {
  const { entries, keychain } = fakeKeychain();
  await connectJira(db, keychain, GOOD);
  writeSetting(db, 'ticketSystem', 'jira');

  await expect(disconnectJira(db, keychain)).resolves.toBeNull();

  expect(entries.size).toBe(0);
  expect([getSetting(db, 'jiraSite'), getSetting(db, 'jiraEmail')]).toEqual([null, null]);
  // The project keeps its choice, and its Tickets line says Jira is not connected.
  expect(getSetting(db, 'ticketSystem')).toBe('jira');
});

it('keeps the connection when the keychain refuses to remove the token', async () => {
  await connectJira(db, fakeKeychain().keychain, GOOD);
  const refusing = { read: async () => null, write: async () => {}, remove: async () => Promise.reject(new Error('The keychain is locked.')) };

  await expect(disconnectJira(db, refusing)).resolves.toBe('The keychain is locked.');

  expect(getSetting(db, 'jiraSite')).toBe('https://you.atlassian.net');
});

// A fake Jira that answers the project search with the keys it holds of those asked. Never the network.
function fakeJira(projects: readonly string[], status = 200) {
  const asked: { url: string; authorization: string | undefined }[] = [];
  const fetcher: JiraFetch = async (url, init) => {
    asked.push({ url, authorization: init.headers.authorization });
    const keys = new URL(url).searchParams.getAll('keys');
    return new Response(JSON.stringify({ values: projects.filter((key) => keys.includes(key)).map((key) => ({ key })) }), { status });
  };
  return { asked, fetcher };
}

async function onJira(prefix: string) {
  const fake = fakeKeychain();
  await connectJira(db, fake.keychain, GOOD);
  writeSetting(db, 'ticketSystem', 'jira');
  writeSetting(db, 'localKeyPrefix', prefix);
  return fake.keychain;
}

it('offers prefixes in a fixed order, each a valid one other than the prefix', () => {
  expect(otherPrefixes('WORK')).toEqual(['WRK', 'WOR', 'WO', 'WORKL']);
  expect(otherPrefixes('APP')).toEqual(['AP', 'APPL']);
  expect(otherPrefixes('CODING')).toEqual(['CDNG', 'COD', 'CO', 'CODINL']);
});

// One read only GET, which asks for the prefix and the prefixes it would offer.
it('keeps a clash with the first offered prefix Jira does not have', async () => {
  const keychain = await onJira('WORK');
  const jira = fakeJira(['WORK', 'WRK']);

  await checkKeyClash(db, keychain, jira.fetcher);

  expect(jira.asked).toEqual([{ url: 'https://you.atlassian.net/rest/api/3/project/search?keys=WORK&keys=WRK&keys=WOR&keys=WO&keys=WORKL', authorization: expect.stringMatching(/^Basic /) }]);
  expect(getSetting(db, 'jiraKeyClash')).toEqual({ prefix: 'WORK', site: 'https://you.atlassian.net', suggestion: 'WOR' });
});

// Another project on this machine counts with WRK, so it is not offered and Jira is not asked about it.
it('offers no prefix another project counts with', async () => {
  const keychain = await onJira('WORK');
  db.prepare("INSERT INTO seq (name, value) VALUES ('ticket:2:WRK', 3)").run();
  const jira = fakeJira(['WORK']);

  await checkKeyClash(db, keychain, jira.fetcher);

  expect(jira.asked[0]?.url).not.toContain('keys=WRK');
  expect(getSetting(db, 'jiraKeyClash')).toEqual({ prefix: 'WORK', site: 'https://you.atlassian.net', suggestion: 'WOR' });
});

it('keeps no clash when no Jira project has the prefix', async () => {
  const keychain = await onJira('WORK');
  writeSetting(db, 'jiraKeyClash', { prefix: 'WORK', site: 'https://you.atlassian.net', suggestion: 'WRK' });

  await checkKeyClash(db, keychain, fakeJira(['RECIPE']).fetcher);

  expect(getSetting(db, 'jiraKeyClash')).toBeNull();
});

it('keeps the last answer when Jira refuses or does not answer', async () => {
  const keychain = await onJira('WORK');
  const last = { prefix: 'WORK', site: 'https://you.atlassian.net', suggestion: 'WRK' };
  writeSetting(db, 'jiraKeyClash', last);

  await checkKeyClash(db, keychain, fakeJira([], 401).fetcher);
  await checkKeyClash(db, keychain, async () => Promise.reject(new Error('offline')));

  expect(getSetting(db, 'jiraKeyClash')).toEqual(last);
});

it('asks nothing on a project that reads no Jira, or on a machine with no Jira login', async () => {
  const { calls, keychain } = fakeKeychain();
  const jira = fakeJira(['APP']);

  await checkKeyClash(db, keychain, jira.fetcher);
  writeSetting(db, 'ticketSystem', 'jira');
  await checkKeyClash(db, keychain, jira.fetcher);

  expect(jira.asked).toEqual([]);
  expect(calls).toEqual([]);
});
