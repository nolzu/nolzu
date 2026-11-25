import { basicAuth, type JiraAnswer, type JiraSite, siteOrigin } from '@nolzu/core';
import type { TicketAdapter } from '@nolzu/protocol';
import type { Keychain } from '../keychain.ts';
import { type CallJira, jiraIssues } from './jira.ts';

/**
 * The real calls for the Jira adapter.
 *
 * Authentication is Basic, with the account's email address as the user and the API token as the
 * password. The token lives in the OS keychain under the service `nolzu`, the same module the
 * device token uses. It never reaches the database and it never reaches a log: it goes into one
 * header, and no message built here repeats what a failed call was given.
 */

// The one keychain name the Jira API token lives under, next to `device-token`. Spelled here and
// nowhere else.
export const JIRA_TOKEN_NAME = 'jira-token';

export const readJiraToken = (keychain: Keychain): Promise<string | null> => keychain.read(JIRA_TOKEN_NAME);

// What this needs from `fetch`, so a test drives the calls by hand and opens no socket.
export type JiraFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export function jiraCall(site: JiraSite, token: string, fetcher: JiraFetch = fetch): CallJira {
  const origin = siteOrigin(site.url);
  const authorization = basicAuth(site.email, token);

  return async (path, signal): Promise<JiraAnswer> => {
    let answer: Response;
    let body: string;
    try {
      answer = await fetcher(new URL(path, origin).toString(), {
        // The token goes here and nowhere else. Never into the path, which reaches a log.
        headers: { authorization, accept: 'application/json' },
        signal,
      });
      body = await answer.text();
    } catch {
      // Never the error's own message, and never the error itself as a cause. A transport error can
      // carry the request that caused it, headers and all, and `util.inspect` prints a cause chain
      // whole, so a cause here would be the token in a log.
      throw new Error(
        signal.aborted
          ? `Jira did not answer in time, so nothing was read from ${origin.host}.`
          : `Nolzu could not reach ${origin.host}. Check the site address and the network.`,
      );
    }

    const headers: Record<string, string> = {};
    answer.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    // `x-ratelimit-limit` and `x-ratelimit-remaining` ride along on every answer and are kept here
    // whole. Nothing reads them yet: no call was ever throttled, so there is no measured shape for
    // a throttled answer to act on.
    return { status: answer.status, headers, body };
  };
}

/**
 * The adapter against a real site, with the token from the OS keychain.
 *
 * The token is read once, when the adapter is built. A token revoked mid-read shows up as the
 * refusal the adapter already names.
 */
export async function jiraFromKeychain(site: JiraSite, keychain: Keychain, fetcher: JiraFetch = fetch): Promise<TicketAdapter> {
  // The cheap check first. Reading the keychain can ask a person for their keychain password, and a
  // typo in the site setting should not cost them that.
  siteOrigin(site.url);
  const token = await readJiraToken(keychain);
  if (token === null) {
    throw new Error('There is no Jira API token on this machine, so nothing can be read from Jira.');
  }
  return jiraIssues(jiraCall(site, token, fetcher));
}
