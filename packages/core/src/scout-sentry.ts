/**
 * The adapter behind a Sentry project: its issues, as findings.
 *
 * Pure and synchronous, the way `scout-tickets.ts` is. It takes issues a caller has already fetched,
 * so the call to Sentry stays in the package that may make one.
 *
 * NOT RECORDED. Every field name in `SentryIssue` is written from Sentry's documented shape, not from
 * an answer this project has read. `scout-sentry.test.ts` names what a first real call has to confirm.
 * Until then treat a Sentry finding as unverified.
 */

import type { ScoutSourceKind } from '@nolzu/protocol';
import { fingerprint, type ScoutGroup, type ScoutItem } from './scout.ts';

// Pinned to the kind list, the same way the paste and ticket adapters pin theirs. This kind is the
// prefix of every finding id this adapter makes, so a rename later is a data migration, not an edit.
const SENTRY: ScoutSourceKind = 'sentry';

/**
 * One Sentry issue, cut down to what a finding shows.
 *
 * Sentry groups events into issues itself, so an issue is one event here and Nolzu's own fingerprint
 * is not used for it: the fingerprint is the issue id, which outlives a reworded title.
 *
 * Fields Sentry also answers with and nothing here reads, such as `firstSeen`, `lastSeen` and
 * `metadata`, are left out. A finding stamps its own first and last seen from the check that met it,
 * and a field nobody reads is a field that rots.
 */
export interface SentryIssue {
  // The stable numeric id, as a string. It is the fingerprint, so it may never be the short id: a
  // short id carries the project slug, and renaming the project in Sentry would rewrite it.
  id: string;
  // The readable name, such as `RECIPES-API-7F`. Evidence, and the stand-in when the title is empty.
  shortId: string;
  title: string;
  // Where Sentry thinks it happens, such as a route or a function. Empty where Sentry names none.
  culprit: string;
  // `error`, `warning`, `info` and the rest. It is the error class this source names.
  level: string;
  // How many events Sentry has folded into this issue, over the issue's whole life and not since the
  // last check. The delta below is what makes that a count a finding can add.
  count: number;
  // The page in Sentry, so the finding's evidence can point back at it.
  permalink: string;
}

export interface SentryFetch {
  /**
   * The issues that have moved, already grouped.
   *
   * Groups and not items, because one item per event would mean building forty thousand objects for
   * an issue Sentry has already counted for us. `dedup` is skipped for this source: Sentry did the
   * grouping, and an issue appears once per answer.
   */
  groups: ScoutGroup[];
  /**
   * `<issue id>:<event count>` per issue, sorted, or null when no total has been reported yet.
   *
   * The count is here because Sentry's own count is a total and a finding adds what a check reports.
   * Without the last total every check would add the whole count again, and a finding seen forty
   * times would read as eighty after the second check.
   *
   * A total the answer did not mention is carried forward, and never dropped because the answer left
   * the issue out. `query=is:unresolved` leaves out an issue somebody resolved, and resolve then
   * regress is the ordinary Sentry loop, so forgetting that total would report the issue's whole
   * lifetime count again the moment it comes back. It is also what `finishScoutCheck` asks for: a
   * check that read nothing hands back the cursor it was given.
   *
   * Limit: the list is cut at `MAX_PAIRS`, and which total goes is decided by where its id sorts and
   * not by age, because the cursor carries no time and an age would be a second field on every pair. A
   * project that has held more issues than that can lose one total, and that one issue reports its whole
   * count again when it next moves. The way out is a store of its own for what has been reported, which
   * is a second findings table in disguise, so raise `MAX_PAIRS` before writing that.
   */
  cursor: string | null;
}

const SEPARATOR = ' ';
const PAIR = ':';

/**
 * How many totals the cursor keeps.
 *
 * Carried totals never expire on their own, so without a ceiling the cursor grows by a page on every
 * check, and `migrations.ts` promises the column is short text and not a blob. Over six times the page
 * `apps/local` asks for, so a project has to have held that many issues before anything is dropped.
 */
const MAX_PAIRS = 200;

// The totals the last check reported, by issue id. A pair this cannot read is dropped: a cursor a
// person or an older version wrote is text, and reading half a number as a total would subtract.
function reported(cursor: string | null): Map<string, number> {
  const seen = new Map<string, number>();
  for (const pair of (cursor ?? '').split(SEPARATOR)) {
    const at = pair.lastIndexOf(PAIR);
    if (at <= 0) continue;
    const count = Number(pair.slice(at + 1));
    if (Number.isInteger(count) && count >= 0) seen.set(pair.slice(0, at), count);
  }
  return seen;
}

/**
 * One answered page of issues, as the occurrences behind it.
 *
 * An issue whose count has not moved since the last check carries nothing: the check met the same
 * events again, and both lists on the Scout screen are ordered by when a finding was last seen, so
 * reporting it would push an issue nobody has hit to the top of the screen on every press.
 *
 * An issue met for the first time always carries at least one occurrence, even where the answer says
 * zero. An issue exists in Sentry because an event made it, so a count of zero is a field this
 * version read wrong, and reporting nothing would hide the issue whole. The cursor then keeps the one
 * occurrence that was reported and not the zero, or the finding would stay one ahead of Sentry.
 *
 * A count that went down carries nothing either. Sentry can merge or delete events, and taking the
 * difference away would leave the finding claiming fewer occurrences than a person already read on it.
 */
export function fetchSentry(issues: readonly SentryIssue[], cursor: string | null): SentryFetch {
  const before = reported(cursor);
  const groups: ScoutGroup[] = [];
  const answered = new Map<string, number>();

  for (const issue of issues) {
    const total = Number.isInteger(issue.count) && issue.count > 0 ? issue.count : 0;
    const last = before.get(issue.id);
    const count = last === undefined ? Math.max(total, 1) : total - last;
    // What the findings have been told, and never what this answer claimed. A count that fell, and a
    // count this version read as zero because the field was not there, would otherwise lower the
    // baseline and let the next answer report every one of those events a second time.
    answered.set(issue.id, Math.max(total, last ?? count));
    if (count <= 0) continue;

    const item: ScoutItem = {
      sourceKind: SENTRY,
      errorType: issue.level,
      // The title, and the address under it, because a finding page draws these lines as text and the
      // address is how a person gets from the finding to the issue in Sentry.
      message: [issue.title === '' ? issue.shortId : issue.title, issue.permalink].filter((part) => part !== '').join('\n'),
      location: issue.culprit,
      // What makes the fingerprint the issue id instead of a hash of the message, which is the rule
      // for a source that groups its own events.
      sourceId: issue.id,
    };
    // `first` and `last` are the same item. Sentry hands over one row per issue, so there are no two
    // occurrences to keep apart, and the finding shows one block of evidence rather than two equal ones.
    groups.push({ fingerprint: fingerprint(item), count, first: item, last: item });
  }

  // The issues this answer carried keep their totals, and then as many of the rest as fit. The rest go
  // first, because the issue Sentry has just counted is the one whose total is about to be needed.
  const older = [...before].filter(([id]) => !answered.has(id)).slice(0, Math.max(MAX_PAIRS - answered.size, 0));
  const pairs = [...answered, ...older].map(([id, total]) => `${id}${PAIR}${total}`).sort();
  return { groups, cursor: pairs.length === 0 ? null : pairs.join(SEPARATOR) };
}
