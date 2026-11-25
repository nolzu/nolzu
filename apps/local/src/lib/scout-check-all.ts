import type { DatabaseSync } from 'node:sqlite';
import { type ScoutSource, scoutSource, scoutSources } from '@nolzu/core/node';
import type { ScoutSourceKind } from '@nolzu/protocol';
import type { Keychain } from '@nolzu/runner';
import { checkLogQuery } from './scout-search.ts';
import { checkSentryIssues } from './scout-sentry.ts';
import { count, type HubDeps, type ScoutAnswer, type ScoutCheckAnswer, saveScoutSource } from './scout-sources.ts';
import { checkTicketQuery } from './scout-tickets.ts';

/** One source's own check, the one its Check now button posts to. */
type Check = (db: DatabaseSync, keychain: Keychain, form: FormData) => Promise<ScoutCheckAnswer>;

/**
 * The check of each kind a press can read. A pasted text source has none: its text comes with the
 * press of its own box. Handed in, so a test reads no keychain and reaches no service.
 */
export type Checks = Readonly<Record<Exclude<ScoutSourceKind, 'paste'>, Check>>;

const CHECKS: Checks = { tickets: checkTicketQuery, sentry: checkSentryIssues, search: checkLogQuery };

// A source a press can read: on, and not pasted text.
const readable = (one: ScoutSource): one is ScoutSource & { kind: keyof Checks } => one.enabled && one.kind !== 'paste';

export interface CheckAllAnswer {
  // At least one source was read.
  ok: boolean;
  // The one line for the whole press, or why nothing was read.
  said: string;
  // One line for each source whose read failed, named by its label, in the source's own words.
  failed: string[];
}

/**
 * One source's own check, the one its Check now button posts to, or null for a pasted text source,
 * whose text comes with the press of its own box. "Add and check now" reads a new source with it.
 */
export async function checkSource(db: DatabaseSync, keychain: Keychain, source: ScoutSource, checks: Checks = CHECKS): Promise<ScoutCheckAnswer | null> {
  if (source.kind === 'paste') return null;
  const form = new FormData();
  form.set('id', String(source.id));
  return checks[source.kind](db, keychain, form);
}

/**
 * Add, save or remove a source, then read a new one once when the dialog's "Add and check now" asked
 * for it with `check=now`. Any other poster never sets off a check. Pasted text is only added, because
 * it has no text yet.
 */
export async function saveAndCheck(
  db: DatabaseSync,
  keychain: Keychain,
  form: FormData,
  hub: HubDeps,
  checks: Checks = CHECKS,
): Promise<{ answer: ScoutAnswer; checked: ScoutCheckAnswer | null }> {
  const answer = await saveScoutSource(db, keychain, form, hub);
  const added = !answer.ok || answer.id === undefined || form.get('check') !== 'now' ? null : scoutSource(db, answer.id);
  return { answer, checked: added === null ? null : await checkSource(db, keychain, added, checks) };
}

/**
 * Check all sources: every source that is on and that a press can read, each through its own check.
 *
 * Only a press calls this, from the Scout page or the palette. Nothing checks on a timer.
 *
 * Limit: one source after the other, so two keychain prompts never stack and the database sees one
 * writer at a time. Read them side by side if a project with many slow sources waits too long.
 */
export async function checkAllSources(db: DatabaseSync, keychain: Keychain, checks: Checks = CHECKS): Promise<CheckAllAnswer> {
  const sources = scoutSources(db);
  const read = sources.filter(readable);
  if (sources.length === 0) return { ok: false, said: 'There is no source to check yet. Add one first.', failed: [] };
  if (read.length === 0) {
    return {
      ok: false,
      said: 'No source here can be checked in one press. A pasted text source takes its text in its own box, and a source that is turned off is not checked.',
      failed: [],
    };
  }

  const findings = () => (db.prepare('SELECT count(*) AS n FROM scout_findings').get() as { n: number }).n;
  const before = findings();
  const failed: string[] = [];
  for (const source of read) {
    const answer = await checkSource(db, keychain, source, checks);
    if (answer !== null && !answer.ok) failed.push(`${source.label}: ${answer.message ?? 'the check failed.'}`);
  }
  const checked = read.length - failed.length;
  if (checked === 0) return { ok: false, said: 'No source could be read.', failed };

  const added = findings() - before;
  const pasted = sources.some((one) => one.enabled && one.kind === 'paste') ? ' A pasted text source takes its text in its own box, so it was left out.' : '';
  return { ok: true, said: `Checked ${count(checked, 'source', 'sources')}. ${added === 0 ? 'No new finding' : count(added, 'new finding', 'new findings')}.${pasted}`, failed };
}
