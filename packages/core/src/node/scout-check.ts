import type { DatabaseSync } from 'node:sqlite';
import type { ScoutSourceKind } from '@nolzu/protocol';
import { fetchPaste } from '../scout-paste.ts';
import type { SentryFetch } from '../scout-sentry.ts';
import type { SearchFetch } from '../scout-search.ts';
import type { TicketFetch } from '../scout-tickets.ts';
import { dedup, type ScoutGroup } from '../scout.ts';
import { saveScoutFindings, type ScoutFindingChange } from './scout-findings.ts';
import { finishScoutCheck, type ScoutSource, scoutSource } from './scout-sources.ts';

/**
 * What one check did, as the button that started it reports it.
 *
 * `added` and `met` are what a person wants to know: two new problems, or the same one forty times
 * again. `muted` is the events whose finding was dismissed, which the check met and left alone.
 * `error` carries the sentence when the check did not run at all, and then nothing was written.
 */
export interface ScoutCheck extends ScoutFindingChange {
  error: string | null;
}

const refused = (error: string): ScoutCheck => ({ added: 0, met: 0, muted: 0, error });

/**
 * One paste source, checked.
 *
 * The whole Scout pipeline, and no engine in it: read the source, fetch from its
 * cursor, fold the occurrences into events, write the findings, stamp the check. Nothing new means
 * no group, which means no write to a finding and no run row anywhere. The agent is what the
 * findings board starts later, on a finding a person picked.
 *
 * One source, because the screen has one button per source. A check of all of them would read a
 * paste box that belongs to one of them.
 */
export function checkPasteSource(db: DatabaseSync, id: number, text: string): ScoutCheck {
  const source = scoutSource(db, id);
  // Refused with a sentence and not a throw, because the accessors next door answer with nothing
  // for a row that is not there, and a screen whose source was removed in another tab needs to be
  // able to say so.
  if (source === null) return refused('That source is gone. Pick one from the sources on the Scout page.');
  if (!source.enabled) return refused(`The source "${source.label}" is turned off. Turn it on in the source on the Scout page to check it.`);
  // A source of another kind has a cursor of its own, from its own pages, and a real error worth
  // keeping. Checking it from a box of text would overwrite both.
  if (source.kind !== 'paste') return refused(`The source "${source.label}" is not a pasted source, so there is no text to read. Check it from its own screen.`);

  const fetched = fetchPaste(text, source.cursor);
  return store(db, id, dedup(fetched.items), fetched.cursor);
}

/**
 * What a ticket query answered, and where the next one starts.
 *
 * Injected rather than imported: reaching GitHub means running `gh` and reaching Jira means a
 * request, and this package may do neither. The caller in the app builds the read, and this file
 * keeps the guards, the transaction and the stamp that both adapters share.
 */
export type TicketFetcher = (source: ScoutSource) => Promise<TicketFetch>;

/**
 * One ticket query source, checked.
 *
 * Both ticket systems answer rows and no grouping of their own, so their occurrences go through
 * `dedup` here. What that gives, and the guards and the stamp around it, are `overNetwork` below.
 */
export async function checkTicketSource(db: DatabaseSync, id: number, read: TicketFetcher): Promise<ScoutCheck> {
  return overNetwork(db, id, {
    kind: 'tickets',
    wrongKind: (label) => `The source "${label}" is not a ticket query, so there is nothing to ask a ticket system. Check it from its own screen.`,
    silent: 'The ticket system did not answer.',
    read: async (source) => {
      const fetched: TicketFetch = await read(source);
      return { groups: dedup(fetched.items), cursor: fetched.cursor };
    },
  });
}

/**
 * What a Sentry project answered, and where the next check starts.
 *
 * Injected the way the ticket read is, because reaching Sentry is a request and this package makes
 * none.
 */
export type SentryFetcher = (source: ScoutSource) => Promise<SentryFetch>;

/**
 * One Sentry source, checked.
 *
 * Its own action and no branch inside the ticket check, because the two answer different shapes:
 * Sentry has already grouped its events, so the adapter hands over groups and `dedup` is not run over
 * them. Everything else, the guards, the fetch outside the transaction and the stamp, is shared below.
 */
export async function checkSentrySource(db: DatabaseSync, id: number, read: SentryFetcher): Promise<ScoutCheck> {
  return overNetwork(db, id, {
    kind: 'sentry',
    wrongKind: (label) => `The source "${label}" is not a Sentry project, so there is nothing to ask Sentry. Check it from its own screen.`,
    silent: 'Sentry did not answer.',
    read,
  });
}

/** What a log query answered, injected the same way and for the same reason as `TicketFetcher`. */
export type SearchFetcher = (source: ScoutSource) => Promise<SearchFetch>;

/**
 * One log query source, checked.
 *
 * The source that puts real text through `normalize`, `fingerprint` and `dedup`: a log line carries no
 * identity of its own, so the same error at two timestamps folds into one finding with two occurrences
 * here. Sentry and the ticket systems each carry an id, so this is the only source whose findings the
 * pipeline has to work out for itself.
 */
export async function checkSearchSource(db: DatabaseSync, id: number, read: SearchFetcher): Promise<ScoutCheck> {
  return overNetwork(db, id, {
    kind: 'search',
    wrongKind: (label) => `The source "${label}" is not a log query, so there is no cluster to ask. Check it from its own screen.`,
    silent: 'The cluster did not answer.',
    read: async (source) => {
      const fetched: SearchFetch = await read(source);
      return { groups: dedup(fetched.items), cursor: fetched.cursor };
    },
  });
}

/** What one fetch carried, in the shape the write below takes: events already grouped, and a cursor. */
interface Fetched {
  groups: readonly ScoutGroup[];
  cursor: string | null;
}

interface OverNetwork {
  kind: ScoutSourceKind;
  // Said about a source of another kind, which is the one refusal that differs per adapter.
  wrongKind: (label: string) => string;
  // Said when the read threw something that is not an Error, so there is no sentence to pass on.
  silent: string;
  read: (source: ScoutSource) => Promise<Fetched>;
}

/**
 * The guards, the fetch and the stamp every source read over the network shares.
 *
 * The fetch happens before the transaction and never inside it. `DatabaseSync` is synchronous and
 * `BEGIN IMMEDIATE` takes sqlite's write lock at once, so an awaited call between it and the COMMIT
 * would hold the write lock of the whole database across a network call and every other writer would
 * wait out the busy timeout.
 *
 * A fetch that worked and a write that failed rolls back whole, so the cursor stays where it was: the
 * same events come back on the next check and are counted once. The other order cannot be recovered,
 * because a cursor moved past an event that was never stored never reports it again.
 *
 * Unlike a pasted source, a failed fetch is stamped on the row: `gh` may not be logged in and a token
 * may be refused, and those are sentences a person has to be able to read later on the Scout page. The
 * cursor is written back as it was, so a network blip does not replay the whole query.
 */
async function overNetwork(db: DatabaseSync, id: number, adapter: OverNetwork): Promise<ScoutCheck> {
  const source = scoutSource(db, id);
  if (source === null) return refused('That source is gone. Pick one from the sources on the Scout page.');
  if (!source.enabled) return refused(`The source "${source.label}" is turned off. Turn it on in the source on the Scout page to check it.`);
  if (source.kind !== adapter.kind) return refused(adapter.wrongKind(source.label));

  let fetched: Fetched;
  try {
    fetched = await adapter.read(source);
  } catch (error) {
    // The adapters answer with whole sentences that name a fix, so the sentence travels as it is. A
    // tool's own output never does: on macOS a refused command echoes what it was given.
    const said = error instanceof Error ? error.message : adapter.silent;
    finishScoutCheck(db, id, { cursor: source.cursor, error: said });
    return refused(said);
  }
  return store(db, id, fetched.groups, fetched.cursor);
}

/**
 * The findings and the cursor, written together or not at all.
 *
 * Half the findings with a moved cursor cannot be recovered: the events that were skipped never come
 * back, and the ones that were stored are counted twice on the next check. Shared by every check
 * because they all owe exactly this, and a copy of it would be a second chance to get the order wrong.
 */
function store(db: DatabaseSync, id: number, groups: readonly ScoutGroup[], cursor: string | null): ScoutCheck {
  db.exec('BEGIN IMMEDIATE');
  try {
    const change = saveScoutFindings(db, id, groups);
    finishScoutCheck(db, id, { cursor });
    db.exec('COMMIT');
    return { ...change, error: null };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    // sqlite's own words name nothing a person can act on, so they come after a sentence that does.
    return refused(`The findings could not be stored, so nothing was checked. ${error instanceof Error ? error.message : 'The database refused the write.'}`);
  }
}
