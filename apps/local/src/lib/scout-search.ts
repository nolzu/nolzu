import type { DatabaseSync } from 'node:sqlite';
import { fetchSearch, type SearchFetch, searchRequest } from '@nolzu/core';
import { checkSearchSource, type ScoutSource } from '@nolzu/core/node';
import type { Keychain } from '@nolzu/runner';
import { type ScoutCheckAnswer, checkedSentence, count, scoutEntry, sourceEntry, sourceSecret } from './scout-sources.ts';

/**
 * The one call the log query source makes, and the API key that goes with it.
 *
 * The adapter in `@nolzu/core` is pure and holds the whole shape of the request and the answer. This
 * file is the socket and the keychain, which that package may not have, and nothing more.
 *
 * Nothing here was measured either. No cluster answered this machine, so the header below is the
 * documented one: an API key for Elasticsearch, and basic auth for a plain OpenSearch.
 */

// The same read timeout the card path and the ticket query use, so one product does not wait two
// different lengths for the same host.
const READ_TIMEOUT_MS = 30_000;

// What this needs from `fetch`, so a test drives the call by hand and opens no socket.
export type ClusterFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

/** The one way out of this process, so a test hands in a closure the way the ticket path does. */
export interface SearchSeams {
  fetcher?: ClusterFetch;
  // The read timeout, so a test can reach the sentence a timeout prints without waiting for it.
  timeoutMs?: number;
}

/**
 * The cluster address a person typed, as an origin.
 *
 * https everywhere but this machine. The key goes into a header, so http would put it on the wire in
 * the clear, and a cluster on localhost is the one case where there is no wire. A user name or a
 * password in the address is refused rather than used, because the credential belongs in the keychain.
 * Nothing the person typed is echoed back: a mistyped address can hold the password they meant to
 * keep out of it, and this sentence is written into sqlite and shown on the Scout page.
 *
 * Limit: an address with a path is refused and not shortened. Dropping the path sent the query to
 * the wrong place and the 404 that came back blamed the index, which is the one field that was right.
 * Carrying the path as a prefix is the upgrade, and it is worth making when somebody runs a cluster
 * behind a proxy at one.
 */
export function clusterOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('That is not a cluster address. Open the source on the Scout page and write it as https://logs.example.com:9200.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('A cluster address starts with https. Open the source on the Scout page and write it as https://logs.example.com:9200.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('A cluster address carries no user name and no password. The API key goes into the keychain.');
  }
  // `[::1]` and not `::1`: a URL keeps the brackets on an ipv6 host.
  const here = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !here) {
    throw new Error('A cluster address starts with https, so the API key is never sent in the clear. http is allowed for a cluster on this machine only.');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('A cluster address is the host and the port, with nothing after them. Open the source on the Scout page and write it as https://logs.example.com:9200.');
  }
  return new URL(url.origin);
}

/**
 * The credential, as one Authorization header.
 *
 * Elasticsearch takes `ApiKey` and an encoded key. A plain OpenSearch takes basic auth, so a key
 * typed as `user:password` is read that way: an encoded Elasticsearch key is base64 and can hold no
 * colon, which is what makes the two cases tell themselves apart with no second field on the form.
 * A key that already names its own scheme is passed on as it is, which is the way out for a cluster
 * that wants something else.
 */
export function clusterAuth(key: string): string {
  const typed = key.trim();
  if (/^(ApiKey|Basic|Bearer) /i.test(typed)) return typed;
  if (typed.includes(':')) return `Basic ${Buffer.from(typed, 'utf8').toString('base64')}`;
  return `ApiKey ${typed}`;
}

/**
 * One log query, read and folded into items.
 *
 * The address and the index are checked before the keychain, because both checks cost nothing and a
 * keychain read can put an OS password dialog in front of the person. A typo in the index should not
 * cost them that.
 */
async function read(source: ScoutSource, keychain: Keychain, seams: SearchSeams): Promise<SearchFetch> {
  const origin = clusterOrigin(source.config.endpoint ?? '');
  const request = searchRequest(source.config.index ?? '', source.config.query ?? '', source.cursor);
  const key = await sourceSecret(keychain, source);
  if (key === null || key.trim() === '') {
    throw new Error(`There is no API key for "${source.label}" in this machine's keychain under ${scoutEntry(sourceEntry(source) ?? '')}. Open the source on the Scout page, paste the key, and save it.`);
  }

  const signal = AbortSignal.timeout(seams.timeoutMs ?? READ_TIMEOUT_MS);
  const fetcher = seams.fetcher ?? ((url, init) => fetch(url, init));
  let answer: Response;
  let body: string;
  try {
    answer = await fetcher(new URL(request.path, origin).toString(), {
      method: 'POST',
      // The key goes here and nowhere else. Never into the path, which reaches a log.
      headers: { authorization: clusterAuth(key), 'content-type': 'application/json', accept: 'application/json' },
      body: request.body,
      signal,
    });
    body = await answer.text();
  } catch {
    // Never the error's own message and never the error as a cause. A transport error can carry the
    // request that caused it, headers and all, and `util.inspect` prints a cause chain whole, so
    // either one would be the key in a log.
    throw new Error(
      signal.aborted
        ? `The cluster at ${origin.host} did not answer in time, so nothing was read. Try again, or narrow the query in the source on the Scout page.`
        : `Nolzu could not reach ${origin.host}. Check the cluster address in the source on the Scout page, and the network.`,
    );
  }

  return fetchSearch({ status: answer.status, contentType: (answer.headers.get('content-type') ?? '').toLowerCase(), body }, source.cursor);
}

/**
 * How many log lines the source can read, for "Test the connection". The same request as a first
 * check, with nothing stored.
 */
export async function logsReadable(source: ScoutSource, keychain: Keychain, seams: SearchSeams = {}): Promise<string> {
  return count((await read(source, keychain, seams)).items.length, 'log line', 'log lines');
}

/**
 * Check one log query source with what its cluster answers.
 *
 * Its own action, the way the ticket query has one: the keychain is needed here and may not be built
 * on the path that renders the Scout page, because a keychain call can put an OS password dialog
 * in front of the person who only opened a page.
 */
export async function checkLogQuery(db: DatabaseSync, keychain: Keychain, form: FormData, seams: SearchSeams = {}): Promise<ScoutCheckAnswer> {
  const id = Number(form.get('id')?.toString() ?? '');
  const answer = await checkSearchSource(db, id, (source) => read(source, keychain, seams));
  if (answer.error !== null) return { ok: false, checked: null, message: answer.error };
  // Nothing at all means the query answered no line written since the last check, which is the
  // honest common case and not a failure. "0 new" alone reads as one.
  if (answer.added === 0 && answer.met === 0 && answer.muted === 0)
    return { ok: true, checked: 'Checked. The cluster answered no line this source has not read already.', message: null };
  return { ok: true, checked: checkedSentence(answer), message: null };
}
