import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createKeychain, type Keychain, runKeychain } from '../keychain.ts';
import { basicAuth } from '@nolzu/core';
import { JIRA_TOKEN_NAME, jiraCall, jiraFromKeychain, type JiraFetch } from './jira-http.ts';

// A made-up site and a made-up account. Nothing from a real Jira site is in this repository.
const SITE = { url: 'https://example.atlassian.net', email: 'someone@example.com' };

// The shape a real API token has: 192 characters, `ATATT` first, then base64url, then `=` and a
// short checksum. Built here rather than written out, so no long secret-shaped string sits in the
// repository.
const TOKEN = `ATATT${'x'.repeat(184)}=Ab`;

const answered = (status: number, body: string, headers: Record<string, string> = {}): JiraFetch => async () =>
  new Response(body, { status, headers });

/**
 * Everything the caller hands back or throws, so a test can look for the token in all of it.
 *
 * `inspect` and not the message, because that is what a log and a crash report print. It walks the
 * whole error, the cause chain included, which is where a transport error keeps the request it was
 * given, headers and all.
 */
const everything = async (fetcher: JiraFetch, path = '/rest/api/3/issue/PROJ-123'): Promise<string> => {
  const call = jiraCall(SITE, TOKEN, fetcher);
  try {
    return inspect(await call(path, AbortSignal.timeout(1000)), { depth: null });
  } catch (error) {
    return `${inspect(error, { depth: null })} ${(error as Error).stack ?? ''}`;
  }
};

describe('the call', () => {
  it('asks the site for the path it was given, and asks for JSON', async () => {
    const asked: { url: string; headers: Record<string, string> }[] = [];
    const fetcher: JiraFetch = async (url, init) => {
      asked.push({ url, headers: init.headers });
      return new Response('{}', { status: 200 });
    };

    await jiraCall(SITE, TOKEN, fetcher)('/rest/api/3/issue/PROJ-123', AbortSignal.timeout(1000));

    expect(asked[0]?.url).toBe('https://example.atlassian.net/rest/api/3/issue/PROJ-123');
    expect(asked[0]?.headers.accept).toBe('application/json');
    expect(asked[0]?.headers.authorization).toBe(basicAuth(SITE.email, TOKEN));
  });

  it('hands the status, the body and the headers on, in lower case', async () => {
    const fetcher = answered(404, 'no', { 'X-Seraph-LoginReason': 'AUTHENTICATED_FAILED', 'X-RateLimit-Remaining': '999' });

    const answer = await jiraCall(SITE, TOKEN, fetcher)('/rest/api/3/issue/PROJ-1', AbortSignal.timeout(1000));

    expect(answer.status).toBe(404);
    expect(answer.body).toBe('no');
    expect(answer.headers['x-seraph-loginreason']).toBe('AUTHENTICATED_FAILED');
    expect(answer.headers['x-ratelimit-remaining']).toBe('999');
  });

  it('names the site when it cannot be reached, and does not repeat what fetch was given', async () => {
    const fetcher: JiraFetch = () => Promise.reject(new TypeError('fetch failed'));

    await expect(jiraCall(SITE, TOKEN, fetcher)('/rest/api/3/issue/PROJ-1', AbortSignal.timeout(1000))).rejects.toThrow(
      /could not reach example\.atlassian\.net/,
    );
  });

  it('says the read timed out when the signal is the reason it failed', async () => {
    const signal = AbortSignal.abort();
    const fetcher: JiraFetch = () => Promise.reject(new Error('This operation was aborted'));

    await expect(jiraCall(SITE, TOKEN, fetcher)('/rest/api/3/issue/PROJ-1', signal)).rejects.toThrow(/did not answer in time/);
  });
});

/**
 * The token never leaves the header.
 *
 * This is an effect and not a promise: it proves that nothing this module hands back or throws
 * carries the token, on the paths below. It cannot prove what a caller does with the token itself.
 */
describe('the token in what a person or a log sees', () => {
  it('stays out of the answer, the path and the message, on every way a call can end', async () => {
    const ends: Record<string, JiraFetch> = {
      'a read that worked': answered(200, JSON.stringify({ key: 'PROJ-123' })),
      'a refused token': answered(404, 'nope', { 'x-seraph-loginreason': 'AUTHENTICATED_FAILED' }),
      'a server error': answered(500, 'boom'),
      // A transport error can carry the whole request that caused it.
      'a site that is not there': () => Promise.reject(new TypeError(`fetch failed for ${SITE.url} with ${basicAuth(SITE.email, TOKEN)}`)),
    };

    // Or an end that quietly went missing would leave the test green and one path unchecked.
    expect(Object.keys(ends)).toHaveLength(4);

    for (const [end, fetcher] of Object.entries(ends)) {
      const said = await everything(fetcher);
      expect(said, end).not.toContain(TOKEN);
      expect(said, end).not.toContain(basicAuth(SITE.email, TOKEN));
    }
  });
});

describe('jiraFromKeychain', () => {
  const stub = (token: string | null): Keychain => ({
    read: async () => token,
    write: async () => undefined,
    remove: async () => undefined,
  });

  it('builds the adapter with the token the keychain holds', async () => {
    const adapter = await jiraFromKeychain(SITE, stub(TOKEN), answered(200, JSON.stringify({ key: 'PROJ-123', self: `${SITE.url}/rest/api/3/issue/1`, fields: { summary: 'Search by ingredient' } })));

    const [found] = await adapter.get([{ kind: 'external', key: 'PROJ-123' }], AbortSignal.timeout(1000));

    expect(adapter.name).toBe('jira');
    expect(found?.ticket?.title).toBe('Search by ingredient');
  });

  // Reading the keychain can ask a person for their keychain password. A typo in the site setting
  // is the cheap thing to catch first.
  it('refuses a site address that is not one before it touches the keychain', async () => {
    const asked: string[] = [];
    const keychain: Keychain = { ...stub(TOKEN), read: async (name) => { asked.push(name); return TOKEN; } };

    await expect(jiraFromKeychain({ ...SITE, url: 'example.atlassian.net' }, keychain, answered(200, '{}'))).rejects.toThrow(
      /is not a site address/,
    );
    expect(asked).toEqual([]);
  });

  it('says there is no token rather than calling the site without one', async () => {
    const calls: string[] = [];
    const fetcher: JiraFetch = async (url) => {
      calls.push(url);
      return new Response('{}');
    };

    await expect(jiraFromKeychain(SITE, stub(null), fetcher)).rejects.toThrow(/no Jira API token on this machine/);
    expect(calls).toEqual([]);
  });
});

/**
 * The one test here that touches the machine it runs on.
 *
 * The token goes into the OS keychain and nowhere else, so the round trip is proved against the
 * real keychain rather than a stub. Under a name of its own, so a token a person stored is never
 * read, overwritten or removed. macOS only: `security` always ships with the system, while the
 * Linux keyring needs a package and a session bus that a CI runner has neither of.
 */
describe('a Jira token in the real keychain', () => {
  const OWN_NAME = 'jira-token-test';
  // A folder that is not the default one, so the test never reaches an entry from before the folder tag.
  const real = createKeychain(process.platform, runKeychain, join(tmpdir(), 'nolzu-jira-token-test'));
  const onMac = process.platform === 'darwin';

  /**
   * The test setup points HOME at a temp folder, and macOS resolves the login keychain from HOME.
   * Left alone, `security` finds no default keychain there and every call is refused, which would
   * make this test prove nothing about the real one. `userInfo` reads the account database, so it
   * still gives the real home, the same way the vitest setup finds the live data folder.
   */
  const withRealHome = async <T>(work: () => Promise<T>): Promise<T> => {
    const swapped = process.env.HOME;
    process.env.HOME = userInfo().homedir;
    try {
      return await work();
    } finally {
      process.env.HOME = swapped;
    }
  };

  afterEach(async () => {
    if (onMac) await withRealHome(() => real.remove(OWN_NAME)).catch(() => undefined);
  });

  it.runIf(onMac)('takes a token of the shape Jira issues and gives it back unchanged', async () => {
    // Never the name a person's own token lives under, so this reads and removes nothing of theirs.
    expect(OWN_NAME).not.toBe(JIRA_TOKEN_NAME);
    expect(TOKEN).toHaveLength(192);

    await withRealHome(async () => {
      // `write` stores it and reads it back itself, so a write that landed in another keychain
      // fails here rather than at the next call.
      await real.write(OWN_NAME, TOKEN);
      expect(await real.read(OWN_NAME)).toBe(TOKEN);

      await real.remove(OWN_NAME);
      expect(await real.read(OWN_NAME)).toBeNull();
    });
  }, 30_000);
});
