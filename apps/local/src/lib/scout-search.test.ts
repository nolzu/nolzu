import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { allScoutFindings, openDatabase, scoutSources } from '@nolzu/core/node';
import type { Keychain } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkLogQuery, clusterAuth, clusterOrigin, type ClusterFetch, type SearchSeams } from './scout-search.ts';
import { saveScoutSource, scoutEntry } from './scout-sources.ts';

/**
 * The log query source, wired to a `fetch` this test hands in.
 *
 * Nothing here opens a socket and nothing runs the keychain tool. Every body below is written by hand
 * from the documented `_search` shape, because no cluster has answered this machine. What is tested
 * here is the part this file owns: the address, the header, the keychain and every refusal a person
 * meets on their first try.
 */

// Not a key to anything. It only has to be a string nothing else here writes.
const KEY = 'ZXhhbXBsZWtleQ';

let dir = '';
let db: DatabaseSync;
let kept = new Map<string, string>();

const keychain: Keychain = {
  read: (name) => Promise.resolve(kept.get(name) ?? null),
  write: (name, secret) => {
    kept.set(name, secret);
    return Promise.resolve();
  },
  remove: (name) => {
    kept.delete(name);
    return Promise.resolve();
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-search-'));
  db = openDatabase(dir);
  kept = new Map();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const add = (over: Record<string, string> = {}) => {
  const form = new FormData();
  for (const [name, value] of Object.entries({
    do: 'add',
    form: 'search',
    label: 'The recipe app logs',
    endpoint: 'https://logs.example.com:9200',
    index: 'logs-*',
    query: 'level:error',
    secret: KEY,
    ...over,
  }))
    form.set(name, value);
  // Registered nowhere, so nothing here builds a schedule frame. What a remove sends is tested in
  // `scout-sources.test.ts`.
  return saveScoutSource(db, keychain, form, { projectId: null, send: () => false });
};

const id = () => scoutSources(db)[0]?.id ?? 0;

const check = (seams: SearchSeams) => {
  const form = new FormData();
  form.set('id', String(id()));
  return checkLogQuery(db, keychain, form, seams);
};

/** A cluster that answers each call in turn, and records what it was asked. */
const cluster = (...answers: { status?: number; contentType?: string; body: string }[]) => {
  const calls: { url: string; authorization: string; body: string }[] = [];
  const fetcher: ClusterFetch = (url, init) => {
    const at = Math.min(calls.length, answers.length - 1);
    calls.push({ url, authorization: init.headers.authorization ?? '', body: init.body });
    const answer = answers[at] ?? { body: '{}' };
    return Promise.resolve(new Response(answer.body, { status: answer.status ?? 200, headers: { 'content-type': answer.contentType ?? 'application/json' } }));
  };
  return { fetcher, calls };
};

const logs = (...lines: [string, string][]) =>
  JSON.stringify({
    took: 5,
    timed_out: false,
    hits: {
      total: { value: lines.length, relation: 'eq' },
      hits: lines.map(([at, message], n) => ({ _index: 'logs-2026.09.28', _id: `a${n}`, _source: { '@timestamp': at, 'log.level': 'error', 'service.name': 'recipes-api', message } })),
    },
  });

const TWO = logs(['2026-09-28T09:04:11.482Z', 'Timeout after 9000ms calling /api/recipes'], ['2026-09-28T09:00:00.000Z', 'Timeout after 5000ms calling /api/recipes']);

it('reads the cluster and leaves one finding for the two lines of one event', async () => {
  await add();
  const asked = cluster({ body: TWO });

  const answer = await check({ fetcher: asked.fetcher });

  expect(answer).toEqual({ ok: true, checked: expect.stringContaining('1 new finding'), message: null });
  const findings = allScoutFindings(db);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ occurrences: 2, location: 'recipes-api' });
  expect(answer.checked).toBe('Checked. 1 new finding.');
  expect(asked.calls).toHaveLength(1);
  expect(asked.calls[0]?.url).toBe('https://logs.example.com:9200/logs-*/_search');
  expect(asked.calls[0]?.authorization).toBe(`ApiKey ${KEY}`);
});

// The cursor is in the second request and not only in the database, which is the whole point of it.
it('asks the next check for the lines after the newest one it read', async () => {
  await add();
  const asked = cluster({ body: TWO }, { body: logs() });

  await check({ fetcher: asked.fetcher });
  const answer = await check({ fetcher: asked.fetcher });

  expect(answer.checked).toContain('no line this source has not read already');
  expect(JSON.parse(asked.calls[1]?.body ?? '{}')).toMatchObject({
    sort: [{ '@timestamp': { order: 'asc', unmapped_type: 'date' } }],
    query: { bool: { filter: [{ query_string: { query: 'level:error' } }, { range: { '@timestamp': { gt: '2026-09-28T09:04:11.482Z' } } }] } },
  });
});

/**
 * Every refusal a person meets, each with a next step.
 *
 * The sentence is written onto the source as well, because the settings screen shows it until a check
 * works, and a check that failed may not look like one that found nothing.
 */
describe('refusals', () => {
  const failing = async (answer: { status?: number; contentType?: string; body: string }) => {
    await add();
    const said = await check({ fetcher: cluster(answer).fetcher });
    expect(said.ok).toBe(false);
    expect(scoutSources(db)[0]?.lastError).toBe(said.message);
    // The rule this file is most likely to break. The sentence is written into sqlite and shown on
    // the settings screen until a check works, so the key may not be anywhere in it.
    expect(said.message).not.toContain(KEY);
    expect(scoutSources(db)[0]?.lastError).not.toContain(KEY);
    return said.message ?? '';
  };

  it('names what to do when there is no key in the keychain', async () => {
    await add();
    kept.clear();
    const asked = cluster({ body: TWO });

    const answer = await check({ fetcher: asked.fetcher });

    expect(answer.message).toContain('Open the source on the Scout page');
    // The full entry and the stop after it, so a bare name does not pass.
    expect(answer.message).toContain(`under ${scoutEntry(`logs-logs-example-com-9200-${id()}`)}.`);
    // Nothing was asked of the cluster, so no call was made with no key on it.
    expect(asked.calls).toEqual([]);
  });

  it('names the key on a 401', async () => {
    expect(await failing({ status: 401, body: '{"error":{"reason":"unable to authenticate user"}}' })).toContain('API key');
  });

  it('names the index rights on a 403', async () => {
    expect(await failing({ status: 403, body: '{"error":{"reason":"action [indices:data/read/search] is unauthorized"}}' })).toContain('may not read that index');
  });

  it('names the index on a 404', async () => {
    expect(await failing({ status: 404, body: '{"error":{"type":"index_not_found_exception","reason":"no such index [logs-typo]"}}' })).toContain('no index by that name');
  });

  it('passes the cluster words on for a query it will not parse', async () => {
    const said = await failing({ status: 400, body: '{"error":{"type":"parsing_exception","reason":"Failed to parse query [level:]"}}' });
    expect(said).toContain('refused the query');
    expect(said).toContain('Failed to parse query');
  });

  it('names a proxy for a web page', async () => {
    expect(await failing({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body>Sign in</body></html>' })).toContain('proxy');
  });

  it('says what it expected for an answer of another shape', async () => {
    expect(await failing({ body: '{"count":12}' })).toContain('hits.hits');
  });

  /**
   * The other half of the reach sentence.
   *
   * The timeout is handed in here, because the real one is thirty seconds and a test may not wait for
   * it. Without this the branch was never run and a change that printed the wrong one of the two
   * sentences passed the whole suite.
   */
  it('names the timeout when the cluster does not answer in time', async () => {
    await add();

    const answer = await check({
      timeoutMs: 1,
      fetcher: (_url, init) => new Promise((_keep, refuse) => init.signal.addEventListener('abort', () => refuse(new Error('This operation was aborted')))),
    });

    expect(answer.message).toContain('did not answer in time');
    expect(answer.message).toContain('logs.example.com');
    expect(answer.message).not.toContain(KEY);
  });

  it('names the host when the cluster cannot be reached', async () => {
    await add();

    const answer = await check({ fetcher: () => Promise.reject(new Error('getaddrinfo ENOTFOUND logs.example.com')) });

    expect(answer.message).toContain('logs.example.com');
    expect(answer.message).toContain('Check the cluster address');
    // The transport error's own words never travel: they can carry the request, headers and all.
    expect(answer.message).not.toContain('ENOTFOUND');
  });

  // The cheap checks happen before the keychain, because a keychain read can put an OS password
  // dialog in front of a person who only mistyped a port.
  it('refuses a cluster address that is not https, and asks the keychain nothing', async () => {
    await add({ endpoint: 'http://logs.example.com:9200' });
    let read = 0;
    const asked = cluster({ body: TWO });

    const answer = await checkLogQuery(
      db,
      {
        ...keychain,
        read: (name) => {
          read += 1;
          return keychain.read(name);
        },
      },
      (() => {
        const form = new FormData();
        form.set('id', String(id()));
        return form;
      })(),
      { fetcher: asked.fetcher },
    );

    expect(answer.message).toContain('https');
    expect(read).toBe(0);
    expect(asked.calls).toEqual([]);
  });
});

describe('clusterOrigin', () => {
  it('keeps the host and the port', () => {
    expect(clusterOrigin(' https://logs.example.com:9200 ').toString()).toBe('https://logs.example.com:9200/');
  });

  /**
   * A path is refused and not dropped.
   *
   * Dropped, the query went to the host root, the proxy answered 404 and the sentence a person read
   * sent them to fix the index, which was the one field that was right. Nothing said the address they
   * typed had been shortened.
   */
  it('refuses an address that carries a path', () => {
    expect(() => clusterOrigin('https://logs.example.com/es')).toThrow(/with nothing after them/);
    expect(() => clusterOrigin('https://logs.example.com:9200/?pretty')).toThrow(/with nothing after them/);
  });

  // The one case where there is no wire to put the key on.
  it('allows http for a cluster on this machine only', () => {
    expect(clusterOrigin('http://localhost:9200').host).toBe('localhost:9200');
    expect(clusterOrigin('http://127.0.0.1:9200').host).toBe('127.0.0.1:9200');
    // A URL keeps the brackets on an ipv6 host, which is the form the check has to match.
    expect(clusterOrigin('http://[::1]:9200').host).toBe('[::1]:9200');
    expect(() => clusterOrigin('http://logs.example.com:9200')).toThrow(/in the clear/);
  });

  it('refuses an address with a credential in it', () => {
    expect(() => clusterOrigin('https://reader:secret@logs.example.com:9200')).toThrow(/goes into the keychain/);
  });

  /**
   * What a refusal may not carry.
   *
   * An address that will not parse is often one a paste broke, and the password the person meant to
   * keep out of Scout is in it. The sentence goes into sqlite and onto the screen, so the value the
   * person typed never travels with it.
   */
  it('refuses something that is not an address, and repeats nothing of it', () => {
    expect(() => clusterOrigin('logs.example.com')).toThrow(/is not a cluster address/);
    expect(() => clusterOrigin('file:///etc/passwd')).toThrow(/starts with https/);
    expect(() => clusterOrigin('https://reader:not-a-password@lo gs.example.com:9200')).toThrow(/is not a cluster address/);
    expect(() => clusterOrigin('https://reader:not-a-password@lo gs.example.com:9200')).not.toThrow(/not-a-password/);
  });
});

/**
 * The header, which is the one thing about this source that documentation alone decides.
 *
 * Elasticsearch takes an API key, a plain OpenSearch takes basic auth, and an encoded API key is
 * base64, which can hold no colon. So the key tells the two apart with no second field on the form.
 */
describe('clusterAuth', () => {
  it('sends an encoded key as an API key', () => {
    expect(clusterAuth(` ${KEY} `)).toBe(`ApiKey ${KEY}`);
  });

  it('sends a key written as user and password as basic auth', () => {
    expect(clusterAuth('reader:not-a-password')).toBe(`Basic ${Buffer.from('reader:not-a-password', 'utf8').toString('base64')}`);
  });

  it('leaves a key that names its own scheme alone', () => {
    expect(clusterAuth('Bearer abc123notatoken')).toBe('Bearer abc123notatoken');
    expect(clusterAuth(`ApiKey ${KEY}`)).toBe(`ApiKey ${KEY}`);
  });
});
