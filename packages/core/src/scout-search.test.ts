import { describe, expect, it } from 'vitest';
import { dedup } from './scout.ts';
import { fetchSearch, SEARCH_LIMIT, type SearchAnswer, searchRequest } from './scout-search.ts';

/**
 * Every fixture in this file is written by hand.
 *
 * No real Elasticsearch or OpenSearch cluster answered these, so none of these bodies was
 * recorded. They are the documented shape of `_search`: `hits.hits` with `_id`, `_index` and
 * `_source`, and `error.reason` on a refusal. The header comment of `scout-search.ts` lists what a
 * first real query has to confirm, and this file is the one to walk when it is made.
 */

const ok = (body: unknown): SearchAnswer => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const hit = (id: string, source: Record<string, unknown>) => ({ _index: 'logs-2026.09.28', _id: id, _source: source });

const answer = (...hits: unknown[]) => ok({ took: 5, timed_out: false, hits: { total: { value: hits.length, relation: 'eq' }, hits } });

const line = (at: string, message: string) => ({ '@timestamp': at, log: { level: 'error' }, service: { name: 'recipes-api' }, message });

describe('searchRequest', () => {
  it('asks for the newest lines on the first check, with no lower bound', () => {
    const { path, body } = searchRequest('logs-*', 'level:error', null);

    expect(path).toBe('/logs-*/_search');
    // The literal and not the constant, so a change of the number is a change of this test. Read
    // against the constant it asserted nothing.
    expect(JSON.parse(body)).toEqual({
      size: 500,
      sort: [{ '@timestamp': { order: 'desc', unmapped_type: 'date' } }],
      query: { bool: { filter: [{ query_string: { query: 'level:error' } }] } },
    });
  });

  /**
   * The order is the part worth reading twice.
   *
   * Oldest first with a cursor, so a burst larger than the ceiling is walked by the checks that
   * follow. Newest first there would move the cursor to the newest line of the page and leave
   * everything older than the page unread for good.
   */
  it('asks for the lines after the cursor, oldest first', () => {
    const { body } = searchRequest('logs-*', 'level:error', '2026-09-28T09:00:00.000Z');

    expect(JSON.parse(body)).toEqual({
      size: SEARCH_LIMIT,
      sort: [{ '@timestamp': { order: 'asc', unmapped_type: 'date' } }],
      query: {
        bool: {
          filter: [{ query_string: { query: 'level:error' } }, { range: { '@timestamp': { gt: '2026-09-28T09:00:00.000Z' } } }],
        },
      },
    });
  });

  it('asks for everything the index holds when the query is empty', () => {
    expect(JSON.parse(searchRequest('logs-*', '  ', null).body).query).toEqual({ match_all: {} });
  });

  // The index goes into the path, so a name that could leave it is refused at the form's own words and
  // not somewhere inside the cluster.
  it('refuses an index name that would leave the search path', () => {
    expect(() => searchRequest('../_cluster/settings', 'level:error', null)).toThrow(/is not an index name/);
    expect(() => searchRequest('logs of today', 'level:error', null)).toThrow(/is not an index name/);
  });

  /**
   * A name of only dots leaves the index behind without leaving the endpoint.
   *
   * `new URL('/../_search', origin)` is `origin/_search`, so the query would read every index the key
   * may read and the findings would arrive from indices nobody named. Both products refuse such a
   * name themselves, so refusing it here costs nothing real.
   */
  it('refuses an index name that is only dots', () => {
    expect(() => searchRequest('..', '', null)).toThrow(/is not an index name/);
    expect(() => searchRequest('.', '', null)).toThrow(/is not an index name/);
    expect(() => searchRequest('logs-app,..', '', null)).toThrow(/is not an index name/);
    // A dot inside a name is the daily index, and it stays allowed.
    expect(searchRequest('logs-2026.09.28', '', null).path).toBe('/logs-2026.09.28/_search');
  });

  it('takes the two index shapes a cluster spells', () => {
    expect(searchRequest('logs-app,logs-web', '', null).path).toBe('/logs-app,logs-web/_search');
    expect(searchRequest('logs-2026.09.28', '', null).path).toBe('/logs-2026.09.28/_search');
  });
});

describe('fetchSearch', () => {
  it('reads the line, the level and the service out of a document', () => {
    const { items } = fetchSearch(answer(hit('a1', line('2026-09-28T09:00:00.000Z', 'Timeout after 5000ms calling /api/recipes'))), null);

    expect(items).toEqual([
      { sourceKind: 'search', errorType: 'error', message: 'Timeout after 5000ms calling /api/recipes', location: 'recipes-api' },
    ]);
  });

  /**
   * The test this adapter exists for.
   *
   * A log line carries no id of its own, so `fingerprint` has to read the text. The same error at two
   * timestamps differs in the numbers only, and `normalize` takes those out, so the two lines are one
   * event with two occurrences. Sentry and a ticket never reach this code path: their own id is handed
   * straight back.
   */
  it('folds the same error at two timestamps into one event with two occurrences', () => {
    const { items } = fetchSearch(
      answer(
        hit('a1', line('2026-09-28T09:00:00.000Z', 'Timeout after 5000ms calling /api/recipes')),
        hit('a2', line('2026-09-28T09:04:11.482Z', 'Timeout after 9000ms calling /api/recipes')),
      ),
      null,
    );

    const groups = dedup(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(2);
    expect(groups[0]?.fingerprint).toMatch(/^search:[0-9a-f]{16}$/);
    // Two different problems stay two, or the rule above would be a rule that folds everything.
    expect(dedup(fetchSearch(answer(hit('a1', line('2026-09-28T09:00:00.000Z', 'Timeout after 5000ms calling /api/recipes')), hit('a2', line('2026-09-28T09:01:00.000Z', 'Cannot read property name of undefined'))), null).items)).toHaveLength(2);
  });

  // Two services with the same words are two events, because the service is where it happens. A host
  // name is not read for the opposite reason: it would split one event per machine.
  it('keeps two services apart', () => {
    const { items } = fetchSearch(
      answer(
        hit('a1', { '@timestamp': '2026-09-28T09:00:00.000Z', service: { name: 'recipes-api' }, message: 'Out of memory' }),
        hit('a2', { '@timestamp': '2026-09-28T09:00:01.000Z', service: { name: 'recipes-web' }, message: 'Out of memory' }),
      ),
      null,
    );

    expect(dedup(items)).toHaveLength(2);
  });

  // Both mappings of one field, because which one arrives depends on the collector and reading one of
  // them would leave half of real indices with no level and no service.
  it('reads a field written with dots as well as one written as an object', () => {
    const { items } = fetchSearch(answer(hit('a1', { '@timestamp': '2026-09-28T09:00:00.000Z', 'log.level': 'WARN', 'service.name': 'recipes-api', message: 'Slow query' })), null);

    expect(items[0]).toMatchObject({ errorType: 'warn', location: 'recipes-api' });
  });

  it('walks the field list in order when the index does not use message', () => {
    const { items } = fetchSearch(
      answer(
        hit('a1', { '@timestamp': '2026-09-28T09:00:00.000Z', msg: 'Connection reset by peer' }),
        hit('a2', { '@timestamp': '2026-09-28T09:00:01.000Z', log: 'Connection reset by peer' }),
        hit('a3', { '@timestamp': '2026-09-28T09:00:02.000Z', error: { message: 'Connection reset by peer' } }),
      ),
      null,
    );

    expect(items.map((one) => one.message)).toEqual(['Connection reset by peer', 'Connection reset by peer', 'Connection reset by peer']);
  });

  // The order and not only the list: a collector writes both names and they say different things, so
  // which one wins is a decision and not an accident.
  it('takes the first name on the list when a document carries two of them', () => {
    const { items } = fetchSearch(
      answer(hit('a1', { '@timestamp': '2026-09-28T09:00:00.000Z', message: 'GET /api/recipes failed', error: { message: 'Connection reset by peer' } })),
      null,
    );

    expect(items[0]?.message).toBe('GET /api/recipes failed');
  });

  /**
   * A level written as a number.
   *
   * One common structured logger writes `level: 30` for info and `level: 50` for error, and a syslog
   * shipper writes `severity: 3`. Dropped, both lines carried an empty level and the same words, so an
   * info line and an error line folded into one finding.
   */
  it('keeps a numeric level, so two levels stay two events', () => {
    const { items } = fetchSearch(
      answer(
        hit('a1', { '@timestamp': '2026-09-28T09:00:00.000Z', level: 30, msg: 'Connection reset by peer' }),
        hit('a2', { '@timestamp': '2026-09-28T09:00:01.000Z', level: 50, msg: 'Connection reset by peer' }),
      ),
      null,
    );

    expect(items.map((one) => one.errorType)).toEqual(['50', '30']);
    expect(dedup(items)).toHaveLength(2);
  });

  // Invisible in the line and loud in the fingerprint: one of these in front of a line would give the
  // same event a second finding that can never merge, and a cluster passes them through.
  it('folds a line that carries a zero-width character', () => {
    const { items } = fetchSearch(
      answer(hit('a1', line('2026-09-28T09:00:00.000Z', 'disk full')), hit('a2', line('2026-09-28T09:00:01.000Z', '\u200Ddisk full'))),
      null,
    );

    expect(dedup(items)).toHaveLength(1);
  });

  // The fallback reads the document itself and not through the field list, so it is stripped on its own.
  it('folds a document whose own fields carry a zero-width character', () => {
    const { items } = fetchSearch(
      answer(
        hit('a1', { '@timestamp': '2026-09-28T09:00:00.000Z', body: 'disk full', pod: 'web-abc' }),
        hit('a2', { '@timestamp': '2026-09-28T09:00:01.000Z', body: '\u200Bdisk full', pod: 'web-abc' }),
      ),
      null,
    );

    expect(dedup(items)).toHaveLength(1);
  });

  /**
   * The fallback, with its ceiling shown rather than hidden.
   *
   * A document with no known message field becomes the whole document as the line. It is wide: the
   * fields that vary by machine are words, so `normalize` keeps them. The test says so out loud, so
   * that a later change to a named field on the form has a test to change.
   */
  it('falls back to the whole document, and two machines then read as two events', () => {
    const { items } = fetchSearch(
      answer(
        hit('a1', { '@timestamp': '2026-09-28T09:00:00.000Z', body: 'disk full', pod: 'web-abc' }),
        hit('a2', { '@timestamp': '2026-09-28T09:00:01.000Z', body: 'disk full', pod: 'web-xyz' }),
      ),
      null,
    );

    expect(items[0]?.message).toContain('disk full');
    expect(dedup(items)).toHaveLength(2);
  });

  /**
   * The fallback keeps fields and not characters, which is what makes it fold.
   *
   * The two lines below are one event: same host, same path, same status, and only the two numbers
   * differ. Cut at a fixed character offset, the shorter numbers moved the cut, the half-written field
   * name at the end survived `normalize`, and the two opened two findings. Every distinct set of digit
   * counts opened another one, which is the noise this source exists to remove.
   */
  it('folds two occurrences of one event whose numbers are different lengths', () => {
    const access = (bytes: number, took: number) => ({
      '@timestamp': '2026-09-28T09:00:00.000Z',
      'host.name': 'web-1',
      'url.path': '/api/recipes',
      'http.response.status_code': 502,
      bytes_sent: bytes,
      request_time_us: took,
      error_note: 'upstream closed the connection',
      'cloud.provider': 'aws',
      'cloud.region': 'eu-central-1',
      'agent.type': 'the shipper',
    });

    const { items } = fetchSearch(answer(hit('a1', access(812, 41230)), hit('a2', access(91, 7))), null);

    expect(dedup(items)).toHaveLength(1);
  });

  // A field holding a blob may not become the message on a finding, and the cap is per value now, so
  // every field name is still there to read.
  it('caps one long value and keeps the fields after it', () => {
    const { items } = fetchSearch(
      answer(hit('a1', { '@timestamp': '2026-09-28T09:00:00.000Z', body: 'x'.repeat(5_000), pod: 'web-abc' })),
      null,
    );

    expect(items[0]?.message.length).toBeLessThan(500);
    expect(items[0]?.message).toContain('pod: web-abc');
  });

  /**
   * AGENTS.md rule 7: a secret never reaches sqlite.
   *
   * The fallback writes every field it keeps into the finding, and a request log carries a header. The
   * names below are dropped at any depth, so what the form promises is what is stored.
   */
  it('drops the fields that hold a credential out of the fallback', () => {
    const { items } = fetchSearch(
      answer(
        hit('a1', {
          '@timestamp': '2026-09-28T09:00:00.000Z',
          'url.path': '/api/recipes',
          authorization: 'Basic bm90LWEtcGFzc3dvcmQ=',
          http: { request: { headers: { cookie: 'session=not-a-session' } } },
        }),
      ),
      null,
    );

    expect(items[0]?.message).toContain('/api/recipes');
    expect(items[0]?.message).not.toContain('bm90LWEtcGFzc3dvcmQ=');
    expect(items[0]?.message).not.toContain('not-a-session');
  });

  // A document the fallback cannot describe would become a finding whose whole evidence is `{}`, and
  // every such document in the cluster would share it.
  it('skips a hit whose document holds nothing to read', () => {
    const { items } = fetchSearch(answer(hit('a0', {}), hit('a1', line('2026-09-28T09:00:00.000Z', 'Timeout'))), null);

    expect(items).toHaveLength(1);
  });

  // The other half: a page where every hit was skipped is not a quiet index. A proxy that drops
  // `_source`, or a saved query that asks for none, reads like one without this.
  it('refuses a page whose hits all carried nothing', () => {
    expect(() => fetchSearch(answer(hit('a0', {}), hit('a1', {})), '2026-09-28T09:00:00.000Z')).toThrow(/not one of them carried a document/);
  });

  it('carries the newest timestamp as the cursor', () => {
    const { cursor } = fetchSearch(
      answer(hit('a1', line('2026-09-28T09:04:11.482Z', 'Timeout')), hit('a2', line('2026-09-28T09:00:00.000Z', 'Timeout'))),
      null,
    );

    expect(cursor).toBe('2026-09-28T09:04:11.482Z');
  });

  // A zone offset is a documented timestamp too, and a string comparison would read it wrong, so the
  // newest is picked by parsed time.
  it('picks the newest by time and not by text', () => {
    const { cursor } = fetchSearch(
      answer(hit('a1', line('2026-09-28T11:00:00.000+02:00', 'Timeout')), hit('a2', line('2026-09-28T09:30:00.000Z', 'Timeout'))),
      null,
    );

    expect(cursor).toBe('2026-09-28T09:30:00.000Z');
  });

  /**
   * An index that does not use `@timestamp` at all.
   *
   * The lines are still read, because `unmapped_type` keeps the cluster from refusing the query. The
   * cursor stays where it was, so every check reads the same lines again: they fold onto the findings
   * they already made and the counts grow. That is the ceiling of such an index, and it is this test.
   */
  it('leaves the cursor where it was when no line carries a timestamp', () => {
    expect(fetchSearch(answer(hit('a1', { message: 'Timeout after 5000ms' })), '2026-09-28T09:00:00.000Z').cursor).toBe('2026-09-28T09:00:00.000Z');
    expect(fetchSearch(answer(hit('a1', { message: 'Timeout after 5000ms' })), null).cursor).toBeNull();
  });

  // A `date` field takes a number as well, and several loggers write one. Read as nothing, the cursor
  // stayed null for good and every check added the same newest page to the same findings again, so the
  // occurrence count became a count of presses.
  it('reads a timestamp written as epoch milliseconds', () => {
    expect(fetchSearch(answer(hit('a1', { '@timestamp': 1_759_050_251_482, message: 'Timeout after 5000ms' })), null).cursor).toBe('2025-09-28T09:04:11.482Z');
    // Seconds are the other documented form, and no year a log is from is that small in milliseconds.
    expect(fetchSearch(answer(hit('a1', { '@timestamp': 1_759_050_251, message: 'Timeout after 5000ms' })), null).cursor).toBe('2025-09-28T09:04:11.000Z');
  });

  /**
   * The marker only ever moves forward.
   *
   * An index whose timestamp field is mapped as a keyword compares `gt` as text, so a line with a zone
   * offset can sort as newer and parse as older. Without the floor the cursor walked back an hour and
   * the next check counted that hour again.
   */
  it('never moves the cursor back below the one it was handed', () => {
    const { cursor } = fetchSearch(answer(hit('a1', line('2026-09-01T00:00:00.000Z', 'Timeout'))), '2026-09-28T09:00:00.000Z');

    expect(cursor).toBe('2026-09-28T09:00:00.000Z');
  });

  /**
   * One writer whose clock runs ahead may not push the marker past everybody else.
   *
   * With the cursor at that line, every line every other service writes until the clock catches up is
   * older than it, and `gt` never asks for them again. The line itself is still a finding.
   */
  it('does not take a line stamped in the future as the cursor', () => {
    const ahead = new Date(Date.now() + 60 * 60_000).toISOString();
    const behind = new Date(Date.now() - 60 * 60_000).toISOString();

    const { items, cursor } = fetchSearch(answer(hit('a1', line(ahead, 'Timeout')), hit('a2', line(behind, 'Timeout'))), null);

    expect(cursor).toBe(behind);
    expect(items).toHaveLength(2);
  });

  it('answers nothing for an index that matched nothing, and keeps the cursor', () => {
    expect(fetchSearch(answer(), '2026-09-28T09:00:00.000Z')).toEqual({ items: [], cursor: '2026-09-28T09:00:00.000Z' });
  });

  /**
   * The first page arrives newest first, and a finding's first message is its oldest occurrence.
   *
   * Without the turn the detail screen would show the newest line as the first one seen, which is the
   * one thing that column means.
   */
  it('puts the first page back into time order', () => {
    const { items } = fetchSearch(
      answer(hit('a2', line('2026-09-28T09:04:11.482Z', 'Timeout after 9000ms')), hit('a1', line('2026-09-28T09:00:00.000Z', 'Timeout after 5000ms'))),
      null,
    );

    expect(items.map((one) => one.message)).toEqual(['Timeout after 5000ms', 'Timeout after 9000ms']);
  });

  // A later page is asked for oldest first, so it is already in order.
  it('leaves a later page in the order it came', () => {
    const { items } = fetchSearch(
      answer(hit('a1', line('2026-09-28T09:00:00.000Z', 'Timeout after 5000ms')), hit('a2', line('2026-09-28T09:04:11.482Z', 'Timeout after 9000ms'))),
      '2026-09-28T08:00:00.000Z',
    );

    expect(items.map((one) => one.message)).toEqual(['Timeout after 5000ms', 'Timeout after 9000ms']);
  });

  // One odd hit is not a reason to lose a page of good ones.
  it('skips a hit that carries no document', () => {
    const { items } = fetchSearch(answer({ _index: 'logs-2026.09.28', _id: 'a0' }, hit('a1', line('2026-09-28T09:00:00.000Z', 'Timeout'))), null);

    expect(items).toHaveLength(1);
  });
});

/**
 * Every refusal names a next step, because the check writes this sentence onto the source and the
 * settings screen shows it until a check works.
 */
describe('fetchSearch refusals', () => {
  const failed = (status: number, body: string, contentType = 'application/json'): SearchAnswer => ({ status, contentType, body });

  it('names the key on a 401', () => {
    expect(() => fetchSearch(failed(401, '{"error":{"reason":"unable to authenticate user"},"status":401}'), null)).toThrow(/API key.*on the Scout page/s);
  });

  it('names the index rights on a 403', () => {
    expect(() => fetchSearch(failed(403, '{"error":{"reason":"action [indices:data/read/search] is unauthorized"},"status":403}'), null)).toThrow(/may not read that index/);
  });

  it('names the index on a 404', () => {
    expect(() => fetchSearch(failed(404, '{"error":{"type":"index_not_found_exception","reason":"no such index [logs-typo]"},"status":404}'), null)).toThrow(/no index by that name/);
  });

  // The cluster's own reason travels, because it is what a person needs in order to fix their query.
  // It can hold the query and never the key: the key is a header.
  it('passes the reason on for a query the cluster will not parse', () => {
    expect(() => fetchSearch(failed(400, '{"error":{"type":"parsing_exception","reason":"Failed to parse query [level:]"},"status":400}'), null)).toThrow(
      /refused the query \(400\).*Failed to parse query \[level:\]/s,
    );
  });

  it('names a proxy when a web page answers instead of the cluster', () => {
    expect(() => fetchSearch(failed(200, '<!doctype html><html><body>Sign in</body></html>', 'text/html; charset=utf-8'), null)).toThrow(/proxy/);
    // A page with no content type either. The body is what gives it away.
    expect(() => fetchSearch(failed(401, '<html><head><title>Sign in</title></head></html>', ''), null)).toThrow(/proxy/);
  });

  // A page with a server error on it is the load balancer in front of a cluster that is down, not a
  // login page. Read as a proxy, it sent the person to edit an address that was right.
  it('names the status when the page carries a gateway error', () => {
    expect(() => fetchSearch(failed(502, '<html><head><title>502 Bad Gateway</title></head></html>', 'text/html'), null)).toThrow(/answered 502/);
  });

  /**
   * A 200 that carries only part of the index.
   *
   * A search can time out inside the cluster, and a shard can be unassigned while a node restarts.
   * Both answer 200 with the hits of the shards that did answer. Moving the cursor onto the newest of
   * those steps over every line the missing shard held, for good, and the screen says the check
   * worked.
   */
  it('refuses an answer that carries a failed shard or a timeout', () => {
    const page = (over: Record<string, unknown>) =>
      failed(200, JSON.stringify({ took: 5, timed_out: false, _shards: { total: 5, successful: 5, failed: 0 }, hits: { hits: [] }, ...over }));

    expect(() => fetchSearch(page({ _shards: { total: 5, successful: 3, failed: 2 } }), '2026-09-28T09:00:00.000Z')).toThrow(/2 of its shards/);
    expect(() => fetchSearch(page({ timed_out: true }), '2026-09-28T09:00:00.000Z')).toThrow(/timed out inside the cluster/);
    // A whole answer is read as it always was.
    expect(fetchSearch(page({}), '2026-09-28T09:00:00.000Z').cursor).toBe('2026-09-28T09:00:00.000Z');
  });

  // The cluster's own words travel for a plain string error too, which is what a wrong method answers
  // with. The `reason` object is the other shape and has its own test above.
  it('passes on a refusal whose error is a plain string', () => {
    expect(() => fetchSearch(failed(405, '{"error":"Incorrect HTTP method for uri [/logs-*/_search] and method [POST]","status":405}'), null)).toThrow(
      /answered 405.*Incorrect HTTP method/s,
    );
  });

  it('names the status for an answer nothing else covers', () => {
    expect(() => fetchSearch(failed(503, '{"error":{"reason":"no cluster is available"},"status":503}'), null)).toThrow(/answered 503.*no cluster is available/s);
  });

  it('says what it expected when the answer is not JSON', () => {
    expect(() => fetchSearch(failed(200, 'ok'), null)).toThrow(/not JSON/);
  });

  // The shape guard. A cluster that answers 200 with something else, or another product at that
  // address, is a state a person meets by typing the wrong port.
  it('says what it expected when the answer has no hits', () => {
    expect(() => fetchSearch(ok({ count: 12 }), null)).toThrow(/hits\.hits/);
    expect(() => fetchSearch(ok({ hits: { total: { value: 0 } } }), null)).toThrow(/hits\.hits/);
  });
});
