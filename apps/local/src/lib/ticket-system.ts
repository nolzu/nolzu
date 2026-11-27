import type { DatabaseSync } from 'node:sqlite';
import { validateSetting } from '@nolzu/core';
import { getSetting, writeSetting } from '@nolzu/core/node';
import type { TicketAdapter } from '@nolzu/protocol';
import { JIRA_TOKEN_NAME, jiraCall, type JiraFetch, jiraFromKeychain, type Keychain, readJiraToken } from '@nolzu/runner';
import { prefixFree } from './onboard.ts';

/**
 * The ticket system of the project: local, or Jira read only.
 *
 * Connect Jira is reached from Add card and from Settings, Integrations. The site and the email are
 * machine settings, because the token is the machine's too, and each project picks whether it reads
 * Jira on its Tickets line. The token goes to this data folder's keychain entry under `JIRA_TOKEN_NAME` and nowhere
 * else: not the database, not the page data, not a response body, not a log. Nothing here calls Jira
 * when the form is saved, because no recorded answer says what a test call looks like. The first
 * read of a ticket happens when a person adds a card with a Jira key. The one other call is the read
 * only key check of `checkKeyClash`.
 *
 * The worklog export keeps its own site, email and token, and nothing here reads or writes them.
 */

// Where every sentence below sends the person, because that is where the fix is.
export const ON_INTEGRATIONS ='Connect Jira again in Settings, Integrations at /settings/integrations.';

// One GET that waits no longer than a ticket read does, so a slow site never holds a save.
export const CLASH_TIMEOUT_MS = 5000;

export interface JiraForm {
  site: string;
  email: string;
  token: string;
}

/**
 * Store the machine's Jira connection, or say why not. Which project reads Jira is each project's
 * own choice, so this switches none.
 *
 * Every check runs before anything is stored, and the token goes first, so a keychain that refuses
 * it leaves the settings as they were. An empty token keeps the one the keychain holds, but only
 * once Jira was connected before: a first connection with no token would read nothing.
 */
export async function connectJira(db: DatabaseSync, keychain: Keychain, form: JiraForm): Promise<string | null> {
  const site = validateSetting('jiraSite', form.site);
  if (!site.ok) return site.message;
  const email = validateSetting('jiraEmail', form.email);
  if (!email.ok) return email.message;
  const token = form.token.trim();
  if (token === '' && getSetting(db, 'jiraSite') === null) return 'Paste an API token. Create one for that email in your Atlassian account.';
  // The kept token was made for the site it was saved with. Sent to another one, it would reach
  // whoever runs that address.
  const was = getSetting(db, 'jiraSite');
  if (token === '' && was !== null && was !== site.value) return `The token was saved for ${was}. Paste the API token again to use ${site.value}.`;
  if (token !== '') {
    try {
      await keychain.write(JIRA_TOKEN_NAME, token);
    } catch (error) {
      // The keychain's own sentence, which never repeats the secret.
      return error instanceof Error ? error.message : 'The keychain refused the token.';
    }
  }
  writeSetting(db, 'jiraSite', site.value);
  writeSetting(db, 'jiraEmail', email.value);
  return null;
}

// Disconnect on Settings, Integrations. The token leaves the keychain first, so a keychain that refuses
// leaves Jira connected, as the page still says. A project that reads Jira keeps its choice and says on
// its Tickets line that Jira is not connected.
export async function disconnectJira(db: DatabaseSync, keychain: Keychain): Promise<string | null> {
  try {
    await keychain.remove(JIRA_TOKEN_NAME);
  } catch (error) {
    return error instanceof Error ? error.message : 'The keychain did not remove the token.';
  }
  writeSetting(db, 'jiraSite', null);
  writeSetting(db, 'jiraEmail', null);
  return null;
}

// Prefixes to offer in place of one a Jira project has: the vowels after the first letter dropped
// (WORK gives WRK), the first three letters, the first two, then an L for local at the end.
export function otherPrefixes(prefix: string): string[] {
  const picks = [`${prefix.slice(0, 1)}${prefix.slice(1).replace(/[AEIOU]/g, '')}`, prefix.slice(0, 3), prefix.slice(0, 2), `${prefix.slice(0, 5)}L`];
  return [...new Set(picks)].filter((one) => one !== prefix && /^[A-Z]{2,6}$/.test(one));
}

/**
 * Asks Jira, read only, whether a project has this project's local key prefix as its key, and keeps
 * the answer for the prefix row.
 *
 * Only for a project that reads Jira, after a save of the prefix, a switch to Jira or a connect, never
 * on a page load, because the keychain read can put a password dialog up. One GET asks for the prefix
 * and the prefixes it would offer, so the one offered is free in Jira too. A refusal, a timeout or an
 * answer it cannot read keeps the last answer: this is a warning. The setting is stored before it
 * asks, and the timeout keeps the wait for the answer short.
 */
export async function checkKeyClash(db: DatabaseSync, keychain: Keychain, fetcher?: JiraFetch): Promise<void> {
  if (getSetting(db, 'ticketSystem') !== 'jira') return;
  const url = getSetting(db, 'jiraSite');
  const email = getSetting(db, 'jiraEmail');
  if (url === null || email === null) return;
  const prefix = getSetting(db, 'localKeyPrefix');
  const others = otherPrefixes(prefix).filter((one) => prefixFree(db, one));
  try {
    const token = await readJiraToken(keychain);
    if (token === null) return;
    const keys = [prefix, ...others].map((key) => `keys=${key}`).join('&');
    const answer = await jiraCall({ url, email }, token, fetcher)(`/rest/api/3/project/search?${keys}`, AbortSignal.timeout(CLASH_TIMEOUT_MS));
    if (answer.status !== 200) return;
    const found = (JSON.parse(answer.body) as { values?: { key?: unknown }[] }).values ?? [];
    const taken = new Set(found.map((one) => one.key));
    writeSetting(db, 'jiraKeyClash', taken.has(prefix) ? { prefix, site: url, suggestion: others.find((one) => !taken.has(one)) ?? null } : null);
  } catch {
    // Jira not answering, or a keychain that refused, leaves the last answer as it was.
  }
}

// Both ways. Back to local keeps the site, the email and the token, so Jira is one press away again.
// Local cards work either way, because a key with the project's prefix is always a local card.
export function switchTickets(db: DatabaseSync, value: string): string | null {
  const checked = validateSetting('ticketSystem', value.trim());
  if (!checked.ok) return checked.message;
  if (checked.value === 'jira' && (getSetting(db, 'jiraSite') === null || getSetting(db, 'jiraEmail') === null)) {
    return 'Connect Jira first in Settings, Integrations, with the site address, the account email and an API token.';
  }
  writeSetting(db, 'ticketSystem', checked.value);
  return null;
}

/**
 * The Jira adapter Add card reads a key with, or null on a local project.
 *
 * Called only once a person gave a key or a Jira link, or opened Add card, which lists their tickets.
 * Never on a page load, because a keychain read can put a password dialog in front of them. The setting is read first, so a local project never
 * touches the keychain at all.
 */
export async function jiraReader(db: DatabaseSync, keychain: Keychain, fetcher?: JiraFetch): Promise<TicketAdapter | null> {
  if (getSetting(db, 'ticketSystem') !== 'jira') return null;
  const url = getSetting(db, 'jiraSite');
  const email = getSetting(db, 'jiraEmail');
  if (url === null || email === null) throw new Error(`Jira is the ticket system here, and Jira is not connected on this machine. ${ON_INTEGRATIONS}`);
  try {
    return await jiraFromKeychain({ url, email }, keychain, fetcher);
  } catch (error) {
    // Building the adapter makes no call, so this is a site, a keychain or a missing token sentence,
    // and none of those holds a secret. The cause is safe to keep.
    throw new Error(`${(error as Error).message} ${ON_INTEGRATIONS}`, { cause: error });
  }
}

// POST /api/tickets/jira, from Connect Jira in Add card, which also makes this project read Jira: the
// person pasted a Jira link into it. The answer carries a sentence or nothing, and never what was
// posted.
export async function postJira(db: DatabaseSync, keychain: Keychain, request: Request, fetcher?: JiraFetch): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const asked = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const text = (name: string) => (typeof asked[name] === 'string' ? (asked[name] as string) : '');
  const refused = await connectJira(db, keychain, { site: text('site'), email: text('email'), token: text('token') });
  if (refused !== null) return Response.json({ message: refused }, { status: 400 });
  writeSetting(db, 'ticketSystem', 'jira');
  await checkKeyClash(db, keychain, fetcher);
  return Response.json({ ticketSystem: 'jira' });
}
