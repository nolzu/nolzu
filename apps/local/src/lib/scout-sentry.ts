import type { DatabaseSync } from 'node:sqlite';
import { fetchSentry } from '@nolzu/core';
import { checkSentrySource, type ScoutSource } from '@nolzu/core/node';
import { type Keychain, sentryCall, type SentryHttp, sentryIssues } from '@nolzu/runner';
import { type ScoutCheckAnswer, checkedSentence, count, scoutEntry, sourceEntry, sourceSecret } from './scout-sources.ts';

// The same read timeout the card path and the ticket check use, so one product does not wait two
// different lengths for the same kind of call.
const READ_TIMEOUT_MS = 30_000;

/**
 * How many issues one check reads.
 *
 * The bound on the first check of a real project. Thirty findings on one press is a list a person can
 * read, and the adapter would allow a hundred.
 *
 * Limit: not a setting, the same as the ticket limit. The source form collects no limit, and a
 * field added to a source form becomes required on every save. Make it a setting when somebody asks
 * for a different number.
 */
export const SCOUT_SENTRY_LIMIT = 30;

/** The one way out of this process, so a test drives the call by hand and opens no socket. */
export interface SentrySeams {
  fetcher?: SentryHttp;
}

/**
 * The unresolved issues of one Sentry project.
 *
 * The keychain read comes after the two settings are checked, because those checks cost nothing and a
 * keychain read can put an OS password dialog in front of the person.
 *
 * The rows come back as they are and the fold into groups happens at the call, because the sentence the
 * button prints has to know how many issues the answer carried and the fold no longer says.
 */
async function read(source: ScoutSource, keychain: Keychain, seams: SentrySeams) {
  const org = source.config.org ?? '';
  const project = source.config.project ?? '';
  if (org === '' || project === '') {
    throw new Error(`The source "${source.label}" is missing its organization or its project. Open the source on the Scout page and write both as they appear in the address of the project in Sentry.`);
  }
  const token = await sourceSecret(keychain, source);
  if (token === null) {
    throw new Error(`There is no Auth token for "${source.label}" in this machine's keychain under ${scoutEntry(sourceEntry(source) ?? '')}. Open the source on the Scout page, paste the token, and save it.`);
  }
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  return sentryIssues(sentryCall(token, seams.fetcher), org, project, SCOUT_SENTRY_LIMIT, signal);
}

/**
 * How many issues the source can read, for "Test the connection". The same read as a check, with
 * nothing stored.
 */
export async function sentryReadable(source: ScoutSource, keychain: Keychain, seams: SentrySeams = {}): Promise<string> {
  return count((await read(source, keychain, seams)).length, 'issue', 'issues');
}

/**
 * Check one Sentry source with what Sentry answers.
 *
 * Its own action and not a word on the paste check, because that one takes a database and a post and
 * nothing else: a keychain handed in there would let opening the Scout page ask for a keychain
 * password. Here a person pressed a button, so a keychain read may happen.
 */
export async function checkSentryIssues(db: DatabaseSync, keychain: Keychain, form: FormData, seams: SentrySeams = {}): Promise<ScoutCheckAnswer> {
  const id = Number(form.get('id')?.toString() ?? '');
  // How many issues the answer carried. Without it the two states below print the same sentence, and
  // one of them would name issues this source reported when the answer named none.
  let carried = 0;
  const answer = await checkSentrySource(db, id, async (source) => {
    const issues = await read(source, keychain, seams);
    carried = issues.length;
    return fetchSentry(issues, source.cursor);
  });
  if (answer.error !== null) return { ok: false, checked: null, message: answer.error };
  // Nothing new is the honest common case and not a failure, and "0 new" alone reads as one. A project
  // with nothing unresolved is a different fact, so it gets its own sentence.
  if (answer.added === 0 && answer.met === 0 && answer.muted === 0) {
    const checked =
      carried === 0
        ? 'Checked. Sentry answered no unresolved issue for this project.'
        : 'Checked. Sentry counted no new events on the issues this source has already reported.';
    return { ok: true, checked, message: null };
  }
  return { ok: true, checked: checkedSentence(answer), message: null };
}
