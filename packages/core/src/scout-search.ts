/**
 * The Elasticsearch and OpenSearch adapter: raw log lines, as occurrences.
 *
 * Nothing here was measured. No real cluster was queried, so the request below and every
 * fixture in the test file beside it are written by hand from the documented shape of `_search`: a
 * POST to `/{index}/_search` with a JSON query, answered with
 * `{ hits: { total: { value: n }, hits: [ { _id, _index, _source: {...} } ] } }`. OpenSearch is a
 * fork of Elasticsearch 7, so the same call fits both, and the version endpoint at `/` is what tells
 * them apart. `FIRST REAL QUERY` below names every field a first real answer has to confirm.
 *
 * This is the one source that runs Nolzu's own fingerprint for real. Sentry and a ticket each carry
 * an identity of their own, so `fingerprint` hands that id straight back and the text is never read.
 * A log line carries none. So `normalize`, `fingerprint` and `dedup` are what turn ten thousand
 * lines into the handful of events behind them, on text nobody shaped for Nolzu. That is also why no
 * `sourceId` is set below: `_id` names one document, which is one line, so using it would open a
 * finding per line and walk around the pipeline this source exists to exercise.
 *
 * FIRST REAL QUERY. When a cluster is finally there, one query has to confirm, in this order:
 *  1. `hits.hits` is an array, and each element carries `_source` as an object. Everything here
 *     hangs off that.
 *  2. The log line sits in `_source` under one of MESSAGE_FIELDS. Which one, and whether the index
 *     uses a name that is not on the list at all. That is the one answer that would change this file.
 *  3. `_source['@timestamp']` is a string a `Date` can parse, because the cursor is that string and
 *     the next query asks for lines newer than it.
 *  4. `sort` with `unmapped_type` is accepted on an index whose timestamp field has another name,
 *     rather than refused with a 400.
 *  5. `query_string` takes the query the form collects (`level:error`) on both products.
 *  6. A refused key answers 401 and not 404, which is the trap Jira turned out to have.
 *  7. An index that is not there answers 404 with `error.type` of `index_not_found_exception`.
 *  8. `error.reason` is where a refused query says what is wrong with it.
 *  9. Whether the cluster takes `search_after` with `[@timestamp, _id]`, and whether it sorts on
 *     `_id` at all on the version it runs. That is what closes the hole SEARCH_LIMIT names, and it
 *     cannot be chosen from documentation alone: `_id` needs fielddata, and `_shard_doc` needs a
 *     point in time to go with it.
 */

import type { ScoutSourceKind } from '@nolzu/protocol';
import type { ScoutItem } from './scout.ts';
import { visible } from './scout.ts';

// Pinned to the kind list, the way the paste and the ticket adapters pin theirs. This kind is the
// prefix of every finding id this adapter makes, so a rename later is a data migration, not an edit.
const SEARCH: ScoutSourceKind = 'search';

/**
 * How many lines one check reads.
 *
 * Lines are not findings: five hundred lines of one timeout are one finding with a count of five
 * hundred, so this bounds the answer and not the list a person reads. It is also what makes the
 * cursor safe to move: a check that hits the ceiling leaves the rest for the next one, because the
 * page is ordered oldest first and the cursor stops where the page stops.
 *
 * The ceiling and the cursor together have one hole. A full page whose last lines share one timestamp
 * moves the cursor to that timestamp, and the next query asks for lines after it, so the rest of those
 * lines are never read. An index stamped to the second and a burst larger than this number inside one
 * second is what reaches it. The way out is paging on `search_after`, and which tiebreaker a real
 * cluster takes is question 9 of FIRST REAL QUERY.
 *
 * Limit: not a setting. The source form collects no limit, and a field added to a source form
 * becomes required on every save. Make it a setting when somebody asks for another number.
 */
export const SEARCH_LIMIT = 500;

/**
 * The field the cursor and the order are read from.
 *
 * `@timestamp` in both products: it is what a data stream, ECS and the Logstash template all write,
 * and what every dashboard sorts by. An index that names it something else is the ceiling of this
 * source, and `sort` carries `unmapped_type` so such an index is answered rather than refused.
 */
export const SEARCH_TIME_FIELD = '@timestamp';

/**
 * Where the line is looked for, in order.
 *
 * Neither product promises a field name, so one has to be chosen. A list in order, because the first
 * four names cover what a collector writes: `message` is ECS and the Logstash default, `msg` is what
 * the common structured loggers write, `log` is what Docker's json-file driver writes, and
 * `error.message` is where ECS puts the text of an exception.
 *
 * A field a person names on the form loses because that field would be asked of every source, and
 * most of them are the plain case that needs no answer, while a person who does need it has to go
 * and read their own mapping first. The whole document as the line loses because it carries every
 * field that varies by machine: a host name, a pod name and a container id are words, not numbers,
 * so `normalize` keeps them and one event becomes one finding per pod. It is still the fallback
 * below, because a source that finds nothing at all is worse than one whose findings are wide.
 */
const MESSAGE_FIELDS = ['message', 'msg', 'log', 'error.message'];

// The level, which becomes `errorType` and so part of the fingerprint. One statement logs at one
// level, so this splits nothing that belongs together, and the same words at error and at warning
// really are two events. `log.level` is ECS, the other two are what a plain logger writes.
const LEVEL_FIELDS = ['log.level', 'level', 'severity'];

/**
 * What the finding says about where it happens.
 *
 * The service and nothing else. It is part of the fingerprint, so every candidate had to be one that
 * does not change under the same event: a host or a pod name would give a finding per machine, and
 * `_index` would give one per day on an index that rolls daily. Empty where the document names no
 * service, which is honest: the finding then says nothing about where instead of something wrong.
 */
const SERVICE_FIELDS = ['service.name', 'service'];

// How much of a document the fallback keeps: how many fields, and how much of one value. Counted in
// fields and not in characters over the whole string, because a character cut landed in a different
// place for every set of digit counts. A number one digit shorter earlier in the document moved the
// cut, the half-written field name at the end survived `normalize`, and one event opened a finding per
// length. The value cap is what keeps one field holding a blob from becoming the message.
const FIELD_CAP = 40;
const VALUE_CAP = 200;

// The field names a request log writes a credential under, at any depth. The fallback below puts every
// field it keeps into `first_message` and `last_message` in sqlite and into the body of a card, and
// AGENTS.md rule 7 says a secret never goes there. The list is the headers and the field names that
// carry one, and it is the reason the search form may promise what it promises.
const SECRET_FIELD = /^(proxy-)?authorization$|^(set-)?cookie$|^x-api-key$|^api[_-]?key$|^(access|refresh|id)[_-]?token$|^token$|^password$|^passwd$|^secret$|^credentials?$|^session$/i;

// How much of the cluster's own words about a refused query travel into the sentence a person reads.
const REASON_CAP = 200;

/**
 * One field of `_source`, under either of the two ways a mapping may hold it.
 *
 * `{"service.name":"api"}` and `{"service":{"name":"api"}}` are the same field to both products, and
 * which one arrives depends on the collector. Reading only one of them would leave half of real
 * indices with no service and no level.
 */
function raw(source: Readonly<Record<string, unknown>>, path: string): unknown {
  const flat = source[path];
  if (flat !== undefined) return flat;
  let held: unknown = source;
  for (const part of path.split('.')) {
    if (typeof held !== 'object' || held === null || Array.isArray(held)) return undefined;
    held = (held as Record<string, unknown>)[part];
  }
  return held;
}

/**
 * The same field, printed.
 *
 * A number and a boolean are printed and not dropped, because a level is often a number: one common
 * structured logger writes `level: 30` and a syslog shipper writes `severity: 3`. Dropped, they left
 * `errorType` empty, and an error and a warning carrying the same words then folded into one finding,
 * which is the over-grouping half of the trade this file exists to get right. The number stays a
 * number in the sentence: which number is which level is the logger's own table, and guessing it
 * would name the wrong level on the other logger.
 */
function at(source: Readonly<Record<string, unknown>>, path: string): string {
  const value = raw(source, path);
  // The invisible characters go here and not only on the message, because the level and the service are
  // part of the fingerprint too. One of them anywhere in the three would give the same event a second
  // finding that can never merge, and a cluster passes them through whenever the field holds text a
  // person typed or pasted.
  if (typeof value === 'string') return visible(value);
  return typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

const firstOf = (source: Readonly<Record<string, unknown>>, paths: readonly string[]): string => {
  for (const path of paths) {
    const value = at(source, path);
    if (value.trim() !== '') return value;
  }
  return '';
};

// A field name is read without its path, so `http.request.headers.authorization` is caught as well as
// `authorization`. The replacer catches the same names inside a nested object.
const secret = (name: string): boolean => SECRET_FIELD.test(name.split('.').at(-1) ?? name);

/**
 * The whole document as the line, for a document no known field describes.
 *
 * Field by field, so two occurrences of one event keep the same fields whatever their numbers are
 * long. Every field a person may need is here except the ones that hold a credential, and those are
 * dropped rather than cut: a source form cannot promise what reaches the database if this line copies
 * a header in.
 */
function whole(document: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(document)) {
    if (parts.length === FIELD_CAP) break;
    if (secret(name) || value === undefined) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value, (key: string, held: unknown) => (secret(key) ? undefined : held));
    if (text.trim() === '' || text === '{}' || text === 'null') continue;
    parts.push(`${name}: ${text.slice(0, VALUE_CAP)}`);
  }
  return parts.join(' ');
}

// Under this a number cannot be milliseconds of any year a log line is from, so it is read as seconds.
// Both are documented date formats and a mapping says which one it wrote.
const EPOCH_SECONDS = 1e11;
// What `Date` can hold. A number past it would throw on the way to a string.
const TIME_MAX = 8.64e15;

// How far ahead of this machine's clock a line may be stamped and still move the marker. Two healthy
// clocks differ by seconds, and a writer with no time service differs by minutes or hours.
const CLOCK_GRACE_MS = 5 * 60_000;

/**
 * The timestamp of one hit, as a string the cursor can be.
 *
 * A number is a documented date too: a `date` field takes `epoch_millis`, and several loggers write
 * that instead of a string. Read as nothing it left the cursor null for good, and then every check
 * asked for the newest page again and added its lines to the same findings, so the occurrence count
 * became a count of presses.
 */
function stampOf(document: Readonly<Record<string, unknown>>): string {
  const value = raw(document, SEARCH_TIME_FIELD);
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const ms = Math.abs(value) < EPOCH_SECONDS ? value * 1000 : value;
  return Math.abs(ms) <= TIME_MAX ? new Date(ms).toISOString() : '';
}

/** What one call needs: the path under the cluster address, and the body to post. */
export interface SearchRequest {
  path: string;
  body: string;
}

/**
 * What an index may be called.
 *
 * Both products allow letters, digits and `_ . + -`, a `*` in a pattern and a comma between two
 * names. The check is here because this string goes into a path: without it an index of `../_cluster`
 * would post to another endpoint of the cluster, and a name with a space would fail somewhere far
 * from the form that collected it.
 */
const INDEX_NAME = /^[a-zA-Z0-9_.*,+-]+$/;

// A name of only dots. `.` and `..` pass the character class above, and `new URL` then folds
// `/../_search` into `/_search`, so the query would read every index the key may read instead of the
// one the person named. Both products refuse such a name themselves.
const ONLY_DOTS = /^\.+$/;

/**
 * The query one check sends.
 *
 * Oldest first, which is the part worth reading twice. Newest first with a ceiling would move the
 * cursor to the newest line of the page and leave everything older than the page behind for good.
 * Oldest first moves the cursor only as far as the page reached, so a burst larger than the ceiling
 * is read by the checks that follow and nothing is lost.
 *
 * The first check has no cursor and so no lower bound, and there newest first is what a person
 * wants: what is happening now, not the oldest lines the index still holds. `fetchSearch` puts that
 * page back into time order before it makes items, so a finding's first line is its oldest.
 */
export function searchRequest(index: string, query: string, cursor: string | null): SearchRequest {
  if (!INDEX_NAME.test(index) || index.split(',').some((one) => ONLY_DOTS.test(one))) {
    throw new Error(`"${index}" is not an index name. Open the source on the Scout page and write it the way the cluster spells it, such as logs-* or logs-app.`);
  }
  const filter: unknown[] = [];
  if (query.trim() !== '') filter.push({ query_string: { query } });
  // Greater than and not at least, so the line the cursor names is not read a second time. A line
  // written in the same millisecond as the last one of a page is missed, which is the price: the
  // other way counts one line again on every check, for as long as the source exists.
  if (cursor !== null) filter.push({ range: { [SEARCH_TIME_FIELD]: { gt: cursor } } });
  return {
    path: `/${index}/_search`,
    body: JSON.stringify({
      size: SEARCH_LIMIT,
      // `unmapped_type`, so an index whose timestamp field has another name answers with its lines
      // instead of refusing the whole query. The cursor then stays where it was, which the comment
      // on `fetchSearch` explains.
      sort: [{ [SEARCH_TIME_FIELD]: { order: cursor === null ? 'desc' : 'asc', unmapped_type: 'date' } }],
      query: filter.length === 0 ? { match_all: {} } : { bool: { filter } },
    }),
  };
}

/** What the cluster answered, as the caller read it off the response. */
export interface SearchAnswer {
  status: number;
  // Lower case, the way `fetch` gives it back. Empty when the answer carried none.
  contentType: string;
  body: string;
}

export interface SearchFetch {
  items: ScoutItem[];
  // The timestamp of the newest line this answer carried, which the next query asks for lines after.
  // An answer that carried no timestamp at all leaves the marker where it was.
  cursor: string | null;
}

/**
 * The cluster's own words about a query it refused.
 *
 * The body and never the request: the key travels in a header, so nothing the cluster echoes back
 * here can hold it, while the query it echoes is what a person needs in order to fix theirs.
 */
function reason(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    const error = (parsed as { error?: unknown }).error;
    const said = typeof error === 'string' ? error : typeof error === 'object' && error !== null ? (error as { reason?: unknown }).reason : undefined;
    return typeof said === 'string' && said !== '' ? `The cluster said: ${said.slice(0, REASON_CAP)}` : '';
  } catch {
    return '';
  }
}

/**
 * Why this answer cannot be read, as a sentence with a next step in it, or null when it can.
 *
 * Every one of these is a state a person meets on their first try, and each needs its own next step:
 * a wrong key, a key with no rights, an index that is not there, a query the cluster will not parse,
 * and a proxy or a login page answering instead of the cluster.
 */
function refuse(answer: SearchAnswer): string | null {
  // Before the status for everything but a server error, because a proxy and a login page both answer
  // 200 or 401 with a page, and a 401 from a proxy is not the cluster refusing the key. A 5xx page is
  // the other thing: the load balancer in front of a cluster that is down. There the status is what
  // tells the two apart, so such an answer falls through to the branch that says it.
  if ((answer.contentType.includes('text/html') || /^\s*</.test(answer.body)) && answer.status < 500) {
    return 'The cluster address answered a web page and not JSON, so something other than the cluster is answering: a proxy, or a login page. Open the source on the Scout page and check the cluster address and its port.';
  }
  if (answer.status === 401) {
    return 'The cluster refused the API key (401). Open the source on the Scout page, paste a key that is still valid, and save it.';
  }
  if (answer.status === 403) {
    return 'The API key may not read that index (403). Give the key read rights on the index, or name an index it may read, in the source on the Scout page.';
  }
  if (answer.status === 404) {
    return 'The cluster has no index by that name (404). Open the source on the Scout page and write the index the way the cluster spells it, such as logs-*.';
  }
  if (answer.status === 400) {
    return `The cluster refused the query (400). Open the source on the Scout page and fix the query. ${reason(answer.body)}`.trim();
  }
  if (answer.status !== 200) {
    return `The cluster answered ${answer.status}, so nothing was read. Check that the cluster is up and that the address in the source on the Scout page names it. ${reason(answer.body)}`.trim();
  }
  return null;
}

const SHAPE = 'The answer is not what a search answers with. Nolzu reads hits.hits out of it, and this answer has no such list. Check that the cluster address names an Elasticsearch or OpenSearch cluster.';

const NO_DOCUMENT =
  'The cluster answered lines, and not one of them carried a document. A proxy that drops _source, or a saved query that asks for none, does that. Nothing was read and the marker did not move. Check the cluster address and the query in the source on the Scout page.';

/**
 * Why a 200 may not be read, for the two answers that carry only part of the index.
 *
 * A search can time out inside the cluster, and a shard can be unassigned while a node restarts, and
 * both come back as a 200 with the hits of the shards that did answer. Stamping the cursor on the
 * newest of those lines would step over every line the missing shard held, for good, and the screen
 * would say the check worked. So it is refused and the cursor stays where it was: the person presses
 * again, which costs a page read twice and loses nothing.
 */
function partial(parsed: unknown): string | null {
  const held = typeof parsed === 'object' && parsed !== null ? (parsed as { timed_out?: unknown; _shards?: { failed?: unknown } }) : {};
  const failed = typeof held._shards?.failed === 'number' ? held._shards.failed : 0;
  if (failed > 0) {
    return `The cluster could not search ${failed === 1 ? 'one of its shards' : `${failed} of its shards`}, so the answer holds only part of the lines. Nothing was read and the marker did not move. Check that the cluster is healthy and press Check now again.`;
  }
  if (held.timed_out === true) {
    return 'The search timed out inside the cluster, so the answer holds only part of the lines. Nothing was read and the marker did not move. Press Check now again, or narrow the query in the source on the Scout page.';
  }
  return null;
}

/**
 * One answer, as the occurrences in it.
 *
 * Takes the answer and not a socket, so the whole of it is testable with no cluster and no network.
 * Every refusal is thrown with a sentence a person can act on, because the check next door writes
 * exactly that sentence onto the source and the settings screen shows it until the next check works.
 *
 * The cursor is the newest timestamp the answer carried, and it only ever moves forward and never
 * into the future. A search source has a real cursor, unlike a pasted one: a query can ask for lines
 * newer than a time, so a second check does not report every line again. An answer whose lines carry
 * no `@timestamp` at all leaves the cursor where it was, and then every check reads the same lines
 * again. That costs no second finding, because the fingerprint folds them onto the one they already
 * made, but the occurrence count grows on every check. It is the ceiling of an index that does not
 * use `@timestamp`, and it is the same ceiling a machine whose clock runs behind its writers meets.
 */
export function fetchSearch(answer: SearchAnswer, cursor: string | null): SearchFetch {
  const said = refuse(answer);
  if (said !== null) throw new Error(said);

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.body);
  } catch {
    throw new Error('The cluster answered something that is not JSON. Check that the cluster address names an Elasticsearch or OpenSearch cluster.');
  }
  const half = partial(parsed);
  if (half !== null) throw new Error(half);
  const hits = typeof parsed === 'object' && parsed !== null ? (parsed as { hits?: { hits?: unknown } }).hits?.hits : undefined;
  if (!Array.isArray(hits)) throw new Error(SHAPE);

  const items: ScoutItem[] = [];
  let skipped = 0;
  let newest = cursor;
  // The marker only ever moves forward. Without the floor a line older than the cursor became the new
  // cursor, which an index whose timestamp field is mapped as a keyword produces: the cluster's `gt` is
  // then a text compare, so a line with a zone offset can sort as newer and parse as older. The next
  // check read that hour again and the occurrence counts grew on every press.
  let newestAt = cursor === null ? -Infinity : Date.parse(cursor);
  if (Number.isNaN(newestAt)) newestAt = -Infinity;
  // A line stamped in the future may not become the marker. One writer whose clock runs ahead would
  // otherwise push the marker past everything every other service writes until the clock catches up,
  // and those lines are lost. The grace is the difference two healthy clocks have. A reader clock that
  // is further behind its writers than this leaves the marker where it is, so the same lines are read
  // and counted again, which is the half of the trade that can be undone.
  const ceiling = Date.now() + CLOCK_GRACE_MS;
  for (const hit of hits) {
    const holds = typeof hit === 'object' && hit !== null ? (hit as { _source?: unknown })._source : undefined;
    // A hit with no document is skipped and not refused: one odd hit in a page of good ones is not
    // a reason to lose the page.
    if (typeof holds !== 'object' || holds === null || Array.isArray(holds)) {
      skipped += 1;
      continue;
    }
    const document = holds as Record<string, unknown>;
    // Limit: the whole document as the line when no known field holds it. It is wide, for the
    // reason MESSAGE_FIELDS gives. The way out is a field name on the source form, and that is the
    // upgrade to make when a real index turns out to use a name that is not on the list.
    // `firstOf` reads through `at`, which strips already. The fallback reads the document itself, so it
    // is stripped here.
    const message = firstOf(document, MESSAGE_FIELDS) || visible(whole(document));
    // A document the fallback cannot describe: no known field, and nothing readable left in it either.
    // It would become a finding whose whole evidence is `{}`, which says nothing and which every such
    // document in the cluster would share.
    if (message.trim() === '') {
      skipped += 1;
      continue;
    }
    items.push({
      sourceKind: SEARCH,
      // Lower case, because one index can hold `ERROR` from one collector and `error` from another,
      // and this is part of the fingerprint.
      errorType: firstOf(document, LEVEL_FIELDS).toLowerCase(),
      message,
      location: firstOf(document, SERVICE_FIELDS),
    });
    const stamp = stampOf(document);
    const ms = Date.parse(stamp);
    if (!Number.isNaN(ms) && ms > newestAt && ms <= ceiling) {
      newestAt = ms;
      newest = stamp;
    }
  }
  // The first check asked for the newest lines first, so it is put back into time order here. A
  // finding's first message is then its oldest occurrence, which is what the detail screen says it is.
  if (cursor === null) items.reverse();
  // A page of hits that all carried nothing is not a quiet index, and the sentence the screen prints
  // for nothing at all would say it is.
  if (items.length === 0 && skipped > 0) throw new Error(NO_DOCUMENT);
  return { items, cursor: newest };
}
