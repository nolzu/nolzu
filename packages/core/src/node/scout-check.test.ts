import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDatabase } from './db.ts';
import type { ScoutItem } from '../scout.ts';
import type { TicketFetch } from '../scout-tickets.ts';
import { fetchSearch } from '../scout-search.ts';
import { checkPasteSource, checkSearchSource, checkSentrySource, checkTicketSource, type SearchFetcher, type TicketFetcher } from './scout-check.ts';
import { dismissScoutFinding, scoutFindings } from './scout-findings.ts';
import { addScoutSource, scoutSource, setScoutSource } from './scout-sources.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-check-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const source = () => addScoutSource(db, { kind: 'paste', label: 'Pasted by hand' });
const count = (table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

// One event, three times, told apart only by the numbers the fingerprint reads past.
const PASTE = ['Timeout after 5000ms calling /api/recipes', 'Timeout after 7000ms calling /api/recipes', 'Timeout after 9000ms calling /api/recipes'].join('\n');

const old = '2020-01-01T00:00:00.000Z';

/**
 * The test this module exists for: no LLM call anywhere in a check.
 *
 * It asserts on the runs table and not on a spy, because a spy only proves that the one engine it
 * wraps was left alone. An empty runs table proves nothing started at all, whichever way a later
 * version reaches an engine.
 */
it('updates the counters and starts no run when a check finds nothing new', () => {
  const id = source();
  expect(checkPasteSource(db, id, PASTE)).toEqual({ added: 1, met: 0, muted: 0, error: null });
  const cursor = scoutSource(db, id)?.cursor;
  // Pushed back, because sqlite's clock counts milliseconds and both checks can land in the same one.
  db.exec(`UPDATE scout_sources SET last_checked = '${old}'`);

  expect(checkPasteSource(db, id, PASTE)).toEqual({ added: 0, met: 0, muted: 0, error: null });

  expect(count('runs')).toBe(0);
  const checked = scoutSource(db, id);
  expect(checked?.lastChecked).not.toBe(old);
  // The same text was read, so the marker stays where it was and the count does not grow.
  expect(checked?.cursor).toBe(cursor);
  expect(scoutFindings(db, id).map((one) => one.occurrences)).toEqual([3]);
});

it('makes one finding with the occurrences the paste held', () => {
  const id = source();

  expect(checkPasteSource(db, id, PASTE)).toEqual({ added: 1, met: 0, muted: 0, error: null });

  const findings = scoutFindings(db, id);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ occurrences: 3, status: 'new', kind: 'bug', firstMessage: 'Timeout after 5000ms calling /api/recipes' });
  expect(findings[0]?.fingerprint).toMatch(/^paste:[0-9a-f]{16}$/);
  expect(count('runs')).toBe(0);
});

// A paste that grew is read again, so the three lines already counted are counted a second time.
// That is the paste adapter's own rule, and the point here is that it folds into the one row.
it('adds to the finding it already has when the same event comes back', () => {
  const id = source();
  checkPasteSource(db, id, PASTE);
  db.exec(`UPDATE scout_findings SET first_seen = '${old}', last_seen = '${old}'`);

  expect(checkPasteSource(db, id, `${PASTE}\nTimeout after 11000ms calling /api/recipes`)).toEqual({ added: 0, met: 1, muted: 0, error: null });

  const findings = scoutFindings(db, id);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.occurrences).toBe(7);
  expect(findings[0]?.firstSeen).toBe(old);
  expect(findings[0]?.lastSeen).not.toBe(old);
  expect(count('runs')).toBe(0);
});

it('makes a finding each for two events in one paste', () => {
  const id = source();

  expect(checkPasteSource(db, id, `${PASTE}\nCannot read property name of undefined`)).toEqual({ added: 2, met: 0, muted: 0, error: null });

  expect(
    scoutFindings(db, id)
      .map((one) => one.occurrences)
      .sort(),
  ).toEqual([1, 3]);
});

// A source turned off is not checked at all, so its cursor stays where it was and turning it back on
// does not replay what it has already seen.
it('does not check a source that is turned off, and writes nothing', () => {
  const id = source();
  setScoutSource(db, id, { enabled: false });

  expect(checkPasteSource(db, id, PASTE)).toEqual({ added: 0, met: 0, muted: 0, error: expect.stringContaining('turned off') });

  expect(scoutFindings(db, id)).toEqual([]);
  expect(scoutSource(db, id)).toMatchObject({ cursor: null, lastChecked: null });
  expect(count('runs')).toBe(0);
});

// A sentence, the way the accessors next door answer with nothing rather than throwing. The screen
// whose source was removed in another tab has to be able to say what happened.
it('refuses a source that is not there and names what to do', () => {
  expect(checkPasteSource(db, 404, PASTE)).toEqual({ added: 0, met: 0, muted: 0, error: expect.stringContaining('on the Scout page') });

  expect(count('scout_findings')).toBe(0);
});

/**
 * A source of another kind keeps its own cursor and its own error.
 *
 * Its cursor is a page marker its own adapter wrote, and its error is one a person still needs to
 * read. A check from a box of text would overwrite both with a paste digest and a clean slate, and
 * hang a `paste:` finding off it.
 */
it('refuses a source that is not a pasted one, and leaves its cursor and its error alone', () => {
  const id = addScoutSource(db, { kind: 'sentry', label: 'The recipe app' });
  db.prepare('UPDATE scout_sources SET cursor = ?, last_error = ? WHERE id = ?').run('sentry-page-7', 'The Sentry token expired.', id);

  expect(checkPasteSource(db, id, PASTE)).toEqual({ added: 0, met: 0, muted: 0, error: expect.stringContaining('not a pasted source') });

  expect(scoutSource(db, id)).toMatchObject({ cursor: 'sentry-page-7', lastError: 'The Sentry token expired.', lastChecked: null });
  expect(count('scout_findings')).toBe(0);
});

/**
 * The findings and the cursor land together or not at all.
 *
 * A trigger refuses the second write, the way a full disk would. If the cursor moved while only the
 * first finding was stored, the events that were skipped would never come back and the ones that were
 * stored would be counted twice on the next check, so the whole check has to roll back.
 */
it('stores nothing and moves nothing when a finding will not write', () => {
  const id = source();
  db.exec(`CREATE TRIGGER refuse_second BEFORE INSERT ON scout_findings WHEN (SELECT count(*) FROM scout_findings) >= 1
           BEGIN SELECT raise(ABORT, 'disk is full'); END`);

  const answer = checkPasteSource(db, id, `${PASTE}\nCannot read property name of undefined`);

  expect(answer).toEqual({ added: 0, met: 0, muted: 0, error: expect.stringContaining('could not be stored') });
  // Its own sentence first, then sqlite's words, which name nothing a person can act on.
  expect(answer.error).toContain('disk is full');
  expect(count('scout_findings')).toBe(0);
  expect(scoutSource(db, id)).toMatchObject({ cursor: null, lastChecked: null });
  expect(count('runs')).toBe(0);
});

/**
 * The promise of a mute: a dismissed finding never comes back.
 *
 * The paste grows by one more occurrence of the same event, because the cursor makes the same text a
 * read that finds nothing. So the check really does meet the muted event, and still writes no column
 * of its row: not the count, and not `last_seen`, which is what both lists are ordered by.
 */
it('leaves a dismissed finding where it is when the same event is met again', () => {
  const id = source();
  checkPasteSource(db, id, PASTE);
  const [only] = scoutFindings(db, id);
  dismissScoutFinding(db, only?.id ?? 0);
  db.exec(`UPDATE scout_findings SET first_seen = '${old}', last_seen = '${old}'`);
  // Read before the act: the first check already left a cursor, so "not null" after the second one
  // would hold even if this check wrote nothing.
  const before = scoutSource(db, id)?.cursor;

  const answer = checkPasteSource(db, id, `${PASTE}\nTimeout after 11000ms calling /api/recipes`);

  // The check met it and says so with its own number, because nothing on the list moved.
  expect(answer).toEqual({ added: 0, met: 0, muted: 1, error: null });
  expect(scoutFindings(db, id)).toEqual([{ ...only, status: 'dismissed', firstSeen: old, lastSeen: old }]);
  // The cursor still moved, so the same text is not read again on the next check.
  expect(before).not.toBeNull();
  expect(scoutSource(db, id)?.cursor).not.toBe(before);
  expect(count('runs')).toBe(0);
});

/**
 * A different problem is a different fingerprint, and a mute is per fingerprint.
 *
 * Different words, not different numbers: `normalize` takes ids, timestamps and numbers out, so a
 * line that only counts differently is the same event. The two ids are asserted to differ, because a
 * fixture that failed to make a new event would pass this test for the wrong reason.
 */
it('lets a line with different words through while the first one is muted', () => {
  const id = source();
  checkPasteSource(db, id, PASTE);
  const [muted] = scoutFindings(db, id);
  dismissScoutFinding(db, muted?.id ?? 0);

  expect(checkPasteSource(db, id, 'Cannot read property name of undefined')).toEqual({ added: 1, met: 0, muted: 0, error: null });

  const findings = scoutFindings(db, id);
  expect(findings).toHaveLength(2);
  const fresh = findings.find((one) => one.id !== muted?.id);
  expect(fresh?.fingerprint).not.toBe(muted?.fingerprint);
  expect(fresh?.status).toBe('new');
  expect(fresh?.lastMessage).toBe('Cannot read property name of undefined');
});

/**
 * The ticket query check.
 *
 * The fetch is handed in, so nothing here runs `gh` or opens a socket. What is tested is the part
 * this file owns: the three guards, the transaction, the cursor and the stamp.
 */
const tickets = () => addScoutSource(db, { kind: 'tickets', label: 'The recipe app', config: { repo: 'acme/app', query: '', system: 'github' } });

const answering = (...answers: TicketFetch[]): { read: TicketFetcher; cursors: (string | null)[] } => {
  const cursors: (string | null)[] = [];
  let at = 0;
  return {
    cursors,
    read: (source) => {
      cursors.push(source.cursor);
      const answer = answers[Math.min(at, answers.length - 1)];
      at += 1;
      return Promise.resolve(answer ?? { items: [], cursor: null });
    },
  };
};

const item = (key: string, title: string): ScoutItem => ({ sourceKind: 'tickets', errorType: '', message: title, location: key, sourceId: key });

it('makes one finding per ticket, and stamps the ids it reported on the source', async () => {
  const id = tickets();
  const { read } = answering({ items: [item('acme/app#1', 'Cache drops rows')], cursor: 'acme/app#1' });

  expect(await checkTicketSource(db, id, read)).toEqual({ added: 1, met: 0, muted: 0, error: null });

  const findings = scoutFindings(db, id);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({ occurrences: 1, status: 'new', firstMessage: 'Cache drops rows' });
  expect(findings[0]?.fingerprint).toBe('tickets:acme%2Fapp%231');
  expect(scoutSource(db, id)).toMatchObject({ cursor: 'acme/app#1', lastError: null });
  expect(count('runs')).toBe(0);
});

// The same ticket met again updates the one finding. Its id is the ticket's own key, so a reworded
// title cannot make a second one.
it('updates the finding it has when the same ticket comes back under a new title', async () => {
  const id = tickets();
  const first = answering({ items: [item('acme/app#1', 'Cache drops rows')], cursor: 'acme/app#1' });
  await checkTicketSource(db, id, first.read);

  const again = answering({ items: [item('acme/app#1', 'The recipe cache drops rows')], cursor: 'acme/app#1' });
  expect(await checkTicketSource(db, id, again.read)).toEqual({ added: 0, met: 1, muted: 0, error: null });

  const findings = scoutFindings(db, id);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.occurrences).toBe(2);
  expect(findings[0]?.lastMessage).toBe('The recipe cache drops rows');
  // The second check was handed the cursor the first one wrote, which is what makes it incremental.
  expect(again.cursors).toEqual(['acme/app#1']);
});

it('says so and writes nothing when the query answers nothing', async () => {
  const id = tickets();
  const { read } = answering({ items: [], cursor: null });

  expect(await checkTicketSource(db, id, read)).toEqual({ added: 0, met: 0, muted: 0, error: null });

  expect(scoutFindings(db, id)).toEqual([]);
  // Checked, and with nothing to remember. The row says it was checked, so the screen does not claim
  // the source was never read.
  expect(scoutSource(db, id)?.lastChecked).not.toBeNull();
});

/**
 * A fetch that failed writes no finding, leaves the cursor and says what to do.
 *
 * The cursor is the part that matters. Clearing it would replay the whole query as new findings after
 * one network blip, and moving it past tickets that were never stored would lose them for good.
 */
it('writes no finding and moves no cursor when the fetch fails, and keeps the sentence', async () => {
  const id = tickets();
  await checkTicketSource(db, id, answering({ items: [item('acme/app#1', 'Cache drops rows')], cursor: 'acme/app#1' }).read);

  const answer = await checkTicketSource(db, id, () => Promise.reject(new Error('gh is not logged in to GitHub. Run gh auth login in a terminal, then check the source again.')));

  expect(answer).toEqual({ added: 0, met: 0, muted: 0, error: expect.stringContaining('gh auth login') });
  expect(scoutFindings(db, id)).toHaveLength(1);
  expect(scoutSource(db, id)).toMatchObject({ cursor: 'acme/app#1', lastError: expect.stringContaining('gh auth login') });
  expect(count('runs')).toBe(0);
});

// A check that works clears the error the failed one left, or the screen would keep telling the person
// to fix something that is already fixed.
it('clears the last error on the next check that works', async () => {
  const id = tickets();
  await checkTicketSource(db, id, () => Promise.reject(new Error('Jira refused the API token.')));
  expect(scoutSource(db, id)?.lastError).not.toBeNull();

  await checkTicketSource(db, id, answering({ items: [item('PROJ-1', 'Search by ingredient')], cursor: 'PROJ-1' }).read);

  expect(scoutSource(db, id)?.lastError).toBeNull();
});

// The three refusals write nothing at all, not even `last_checked`, the same way the paste check's do.
it('refuses a source that is gone, one that is off and one of another kind', async () => {
  expect(await checkTicketSource(db, 404, answering().read)).toMatchObject({ error: expect.stringContaining('on the Scout page') });

  const off = tickets();
  setScoutSource(db, off, { enabled: false });
  expect(await checkTicketSource(db, off, answering().read)).toMatchObject({ error: expect.stringContaining('turned off') });
  expect(scoutSource(db, off)).toMatchObject({ cursor: null, lastChecked: null });

  const paste = addScoutSource(db, { kind: 'paste', label: 'Pasted by hand' });
  db.prepare('UPDATE scout_sources SET cursor = ?, last_error = ? WHERE id = ?').run('paste-digest', 'The paste was refused.', paste);
  expect(await checkTicketSource(db, paste, answering().read)).toMatchObject({ error: expect.stringContaining('not a ticket query') });
  expect(scoutSource(db, paste)).toMatchObject({ cursor: 'paste-digest', lastError: 'The paste was refused.', lastChecked: null });
  expect(count('scout_findings')).toBe(0);
});

/**
 * The Sentry check owes the same three refusals.
 *
 * It shares `overNetwork` with the ticket check, and a shared helper is where a wrong adapter can be
 * wired in without a test noticing: a Sentry source checked through the ticket branch would overwrite a
 * cursor built from another kind of page.
 */
it('refuses a Sentry source that is gone, one that is off and one of another kind', async () => {
  const nothing = () => Promise.resolve({ groups: [], cursor: null });

  expect(await checkSentrySource(db, 404, nothing)).toMatchObject({ error: expect.stringContaining('on the Scout page') });

  const off = addScoutSource(db, { kind: 'sentry', label: 'The recipe app', config: { org: 'your-org', project: 'recipes-api' } });
  setScoutSource(db, off, { enabled: false });
  expect(await checkSentrySource(db, off, nothing)).toMatchObject({ error: expect.stringContaining('turned off') });
  expect(scoutSource(db, off)).toMatchObject({ cursor: null, lastChecked: null });

  const query = tickets();
  db.prepare('UPDATE scout_sources SET cursor = ?, last_error = ? WHERE id = ?').run('acme/app#7', 'The ticket system refused.', query);
  expect(await checkSentrySource(db, query, nothing)).toMatchObject({ error: expect.stringContaining('is not a Sentry project') });
  expect(scoutSource(db, query)).toMatchObject({ cursor: 'acme/app#7', lastError: 'The ticket system refused.', lastChecked: null });
  expect(count('scout_findings')).toBe(0);
});

// A failed Sentry read is a sentence a person reads later on the Scout page, and the cursor stays where
// it was so a network blip does not report every stored total again.
it('keeps a failed Sentry read on the source and leaves the cursor alone', async () => {
  const id = addScoutSource(db, { kind: 'sentry', label: 'The recipe app', config: { org: 'your-org', project: 'recipes-api' } });
  db.prepare('UPDATE scout_sources SET cursor = ? WHERE id = ?').run('4501:12', id);

  const answer = await checkSentrySource(db, id, () => Promise.reject(new Error('Sentry refused the Auth token.')));

  expect(answer).toEqual({ added: 0, met: 0, muted: 0, error: 'Sentry refused the Auth token.' });
  expect(scoutSource(db, id)).toMatchObject({ cursor: '4501:12', lastError: 'Sentry refused the Auth token.' });
  expect(count('runs')).toBe(0);
});

// Something that is not an Error carries no sentence to pass on, and the screen still has to say which
// system did not answer.
it('names Sentry when the read threw something with no sentence in it', async () => {
  const id = addScoutSource(db, { kind: 'sentry', label: 'The recipe app', config: { org: 'your-org', project: 'recipes-api' } });

  expect(await checkSentrySource(db, id, () => Promise.reject('no'))).toMatchObject({ error: 'Sentry did not answer.' });
});

/**
 * The fetch is never inside the transaction.
 *
 * `BEGIN IMMEDIATE` takes sqlite's write lock at once, and an awaited network call between it and the
 * COMMIT would hold the write lock of the whole database for as long as the call takes. The read here
 * asserts on `db.isTransaction` from inside itself, which is the only place that can see it.
 */
it('holds no write lock while the fetch is running', async () => {
  const id = tickets();
  let held = true;

  await checkTicketSource(db, id, () => {
    held = db.isTransaction;
    return Promise.resolve({ items: [item('acme/app#1', 'Cache drops rows')], cursor: 'acme/app#1' });
  });

  expect(held).toBe(false);
});

// The mute rule, and it has to hold for every adapter and not only for paste. The cursor is cleared by
// hand, because a query whose backlog is longer than the page rotates ids out and reports them again.
it('leaves a dismissed finding where it is when a ticket query meets it again', async () => {
  const id = tickets();
  await checkTicketSource(db, id, answering({ items: [item('acme/app#1', 'Cache drops rows')], cursor: 'acme/app#1' }).read);
  const [only] = scoutFindings(db, id);
  dismissScoutFinding(db, only?.id ?? 0);
  db.exec(`UPDATE scout_findings SET first_seen = '${old}', last_seen = '${old}'`);
  db.prepare('UPDATE scout_sources SET cursor = NULL WHERE id = ?').run(id);

  const answer = await checkTicketSource(db, id, answering({ items: [item('acme/app#1', 'Cache drops rows')], cursor: 'acme/app#1' }).read);

  expect(answer).toEqual({ added: 0, met: 0, muted: 1, error: null });
  expect(scoutFindings(db, id)).toEqual([{ ...only, status: 'dismissed', firstSeen: old, lastSeen: old }]);
});

// A failed write rolls the whole check back, so the cursor cannot move past a ticket that was not
// stored. Those tickets would never be reported again.
it('stores nothing and moves nothing when a ticket finding will not write', async () => {
  const id = tickets();
  db.exec(`CREATE TRIGGER refuse_tickets BEFORE INSERT ON scout_findings BEGIN SELECT raise(ABORT, 'disk is full'); END`);

  const answer = await checkTicketSource(db, id, answering({ items: [item('acme/app#1', 'Cache drops rows')], cursor: 'acme/app#1' }).read);

  expect(answer.error).toContain('could not be stored');
  expect(count('scout_findings')).toBe(0);
  expect(scoutSource(db, id)).toMatchObject({ cursor: null, lastChecked: null });
});

/**
 * The log query check, and the one thing this source exists for.
 *
 * The answer below is written by hand from the documented `_search` shape: no real cluster
 * answered it. The adapter is the real one, so the whole pipeline runs here: the two lines go through
 * `normalize`, `fingerprint` and `dedup`, and what reaches the database is one finding with two
 * occurrences. Nothing about the log line carries an identity, which is what makes this the source
 * that exercises the fingerprint rather than walking around it.
 */
const search = () =>
  addScoutSource(db, { kind: 'search', label: 'The recipe app logs', config: { endpoint: 'https://logs.example.com:9200', index: 'logs-*', query: 'level:error' } });

const logs = (...lines: [string, string][]) =>
  JSON.stringify({
    took: 5,
    timed_out: false,
    hits: {
      total: { value: lines.length, relation: 'eq' },
      hits: lines.map(([at, message], n) => ({ _index: 'logs-2026.09.28', _id: `a${n}`, _source: { '@timestamp': at, log: { level: 'error' }, service: { name: 'recipes-api' }, message } })),
    },
  });

const cluster = (body: string): SearchFetcher => (source) => Promise.resolve(fetchSearch({ status: 200, contentType: 'application/json', body }, source.cursor));

it('makes one finding with two occurrences out of the same error at two timestamps', async () => {
  const id = search();

  const answer = await checkSearchSource(
    db,
    id,
    // Newest first, because that is the order the first check asks for: it has no cursor, so it asks
    // for what is happening now rather than the oldest lines the index still holds.
    cluster(
      logs(
        ['2026-09-28T09:04:11.482Z', 'Timeout after 9000ms calling /api/recipes'],
        ['2026-09-28T09:00:00.000Z', 'Timeout after 5000ms calling /api/recipes'],
      ),
    ),
  );

  expect(answer).toEqual({ added: 1, met: 0, muted: 0, error: null });
  const findings = scoutFindings(db, id);
  expect(findings).toHaveLength(1);
  // The oldest line is the first one seen and the newest is the last, and the numbers in them differ,
  // which is what makes both worth keeping.
  expect(findings[0]).toMatchObject({
    occurrences: 2,
    status: 'new',
    location: 'recipes-api',
    firstMessage: 'Timeout after 5000ms calling /api/recipes',
    lastMessage: 'Timeout after 9000ms calling /api/recipes',
  });
  expect(findings[0]?.fingerprint).toMatch(/^search:[0-9a-f]{16}$/);
  // The cursor is the newest line's own timestamp, so the next query asks for what came after it.
  expect(scoutSource(db, id)?.cursor).toBe('2026-09-28T09:04:11.482Z');
  expect(count('runs')).toBe(0);
});

// The cursor is what keeps a second check from reporting every line again. The adapter is handed the
// cursor the first check wrote, and a cluster that answers nothing new writes no finding.
it('reads from the cursor on the next check and reports nothing when no line is newer', async () => {
  const id = search();
  await checkSearchSource(db, id, cluster(logs(['2026-09-28T09:00:00.000Z', 'Timeout after 5000ms calling /api/recipes'])));
  const asked: (string | null)[] = [];

  const answer = await checkSearchSource(db, id, (source) => {
    asked.push(source.cursor);
    return Promise.resolve(fetchSearch({ status: 200, contentType: 'application/json', body: logs() }, source.cursor));
  });

  expect(answer).toEqual({ added: 0, met: 0, muted: 0, error: null });
  expect(asked).toEqual(['2026-09-28T09:00:00.000Z']);
  expect(scoutFindings(db, id)).toHaveLength(1);
  expect(scoutSource(db, id)?.cursor).toBe('2026-09-28T09:00:00.000Z');
});

// A refused key is a sentence on the source, and the cursor stays where it was: a key fixed later
// picks up where the last check that worked stopped, instead of replaying the whole index.
it('keeps the cursor and the sentence when the cluster refuses the key', async () => {
  const id = search();
  await checkSearchSource(db, id, cluster(logs(['2026-09-28T09:00:00.000Z', 'Timeout after 5000ms calling /api/recipes'])));

  const answer = await checkSearchSource(db, id, (source) => Promise.resolve(fetchSearch({ status: 401, contentType: 'application/json', body: '{"error":{"reason":"unable to authenticate user"}}' }, source.cursor)));

  expect(answer.error).toContain('401');
  expect(scoutSource(db, id)).toMatchObject({ cursor: '2026-09-28T09:00:00.000Z', lastError: expect.stringContaining('API key') });
  expect(scoutFindings(db, id)).toHaveLength(1);
});

// A source of another kind keeps its own cursor and its own error, the way the other two checks leave
// one alone.
it('refuses a source that is not a log query', async () => {
  const paste = addScoutSource(db, { kind: 'paste', label: 'Pasted by hand' });
  db.prepare('UPDATE scout_sources SET cursor = ?, last_error = ? WHERE id = ?').run('paste-digest', 'The paste was refused.', paste);

  expect(await checkSearchSource(db, paste, cluster(logs()))).toMatchObject({ error: expect.stringContaining('not a log query') });

  expect(scoutSource(db, paste)).toMatchObject({ cursor: 'paste-digest', lastError: 'The paste was refused.', lastChecked: null });
  expect(count('scout_findings')).toBe(0);
});

// The mute rule again, for this adapter: a muted finding is met and nothing on its row moves.
it('leaves a dismissed finding where it is when a log query meets it again', async () => {
  const id = search();
  await checkSearchSource(db, id, cluster(logs(['2026-09-28T09:00:00.000Z', 'Timeout after 5000ms calling /api/recipes'])));
  const [only] = scoutFindings(db, id);
  dismissScoutFinding(db, only?.id ?? 0);
  db.exec(`UPDATE scout_findings SET first_seen = '${old}', last_seen = '${old}'`);

  const answer = await checkSearchSource(db, id, cluster(logs(['2026-09-28T10:00:00.000Z', 'Timeout after 9000ms calling /api/recipes'])));

  expect(answer).toEqual({ added: 0, met: 0, muted: 1, error: null });
  expect(scoutFindings(db, id)).toEqual([{ ...only, status: 'dismissed', firstSeen: old, lastSeen: old }]);
  expect(count('runs')).toBe(0);
});
