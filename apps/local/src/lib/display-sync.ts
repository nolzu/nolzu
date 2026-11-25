import { hostname } from 'node:os';
import { resolveDataDir } from '@nolzu/core/node';
import { CLOUD_OPEN, type DisplayEntitlement, type SignedDisplay } from '@nolzu/protocol';
import { cloudUrl, createKeychain, machineAccessToken, machineName, runKeychain, type Cloud } from '@nolzu/runner';
import { displayFrom, DISPLAY_PUBLIC_KEYS, FREE, refreshAfterSeconds } from './display.ts';

/**
 * The signed display document this machine's account has, held between page loads.
 *
 * The fetch runs in Node, because the access token is minted from a secret in the OS keychain and
 * the browser never sees either. What the layout gets is the document that verified, and Free for
 * every other case: no account, a server that cannot sign, a body signed by a key this build does
 * not know. None of them is an error and none of them reaches the screen.
 *
 * The document is held in memory only. Nothing is written to disk, so a second account on the same
 * machine cannot find the first one's document, and a restart asks again.
 *
 * Limit: `nolzu logout` runs in its own process, so the running server keeps what it holds until
 * the document runs out, up to its whole life. Have the logout command tell the server when a
 * signed out machine has to lose the menus at once.
 */

// How long to wait before asking again when the answer was Free. Without it every page load of a
// client with no account would read the keychain and call the server.
export const RETRY_AFTER_SECONDS = 60;

// The wait for one round of asking, and for the one call inside it. A page load waits on this, so
// nothing in the round may hang the screen with it.
export const TIMEOUT_MS = 5000;

// What this needs from fetch, so a test answers by hand and never opens a socket. Same shape as
// PackageFetch, for the same reason.
export type DisplayFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

let held: { document: DisplayEntitlement; askAgainAt: number } | null = null;

/**
 * Ask the server for this account's signed document, or null.
 *
 * Null for every refusal and every failure. A 503 is a server with no signing key and a
 * 401 is a machine the server will not have, and the client shows the same Free menus for both.
 */
export async function fetchDisplay(base: string, accessToken: string, fetch: DisplayFetch): Promise<SignedDisplay | null> {
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/api/display`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as SignedDisplay;
  } catch {
    return null;
  }
}

/**
 * What the menus may show right now.
 *
 * The held document is reused until half its life is gone, so the server is asked about once every
 * seven minutes on a fifteen minute document and a navigation almost never waits for it. A document
 * whose whole life ran out while the asking failed is not drawn any more: the menus go back to Free,
 * which is what the account may be down to by then.
 */
export async function currentDisplay(
  cloud: Cloud,
  fetch: DisplayFetch = httpGet,
  keys: readonly string[] = DISPLAY_PUBLIC_KEYS,
  now?: number,
  timeoutMs: number = TIMEOUT_MS,
): Promise<DisplayEntitlement> {
  // While the cloud is closed there is no document to ask for: no keychain read, no call.
  if (!CLOUD_OPEN) return FREE;
  const at = now ?? Math.floor(Date.now() / 1000);
  if (held !== null && at < held.askAgainAt) return held.document.expiresAt > at ? held.document : FREE;

  const answer = await ask(cloud, fetch, keys, at, timeoutMs);
  // A round that got no answer it could trust hands back `FREE` itself, the constant, while a
  // server that really moved this account to Free signs a document of its own. So the identity
  // check below is the whole difference between the two, and a refresh that fails at half life
  // keeps the document it already has instead of flickering the menus away for a minute.
  const document = answer === FREE && held !== null && held.document.expiresAt > at ? held.document : answer;
  // The wait comes from the answer, not from what is kept: a failed round is asked again in a
  // minute, not in half of what is left on the old document.
  const half = refreshAfterSeconds(answer, at);
  held = { document, askAgainAt: at + (half > 0 ? half : RETRY_AFTER_SECONDS) };
  return document;
}

// The document held now, for code that cannot wait for a round of asking, such as `database()`. Free
// while none is held or the held one ran out. Every page load asks again through `currentDisplay`.
export const heldDisplay = (now: number = Math.floor(Date.now() / 1000)): DisplayEntitlement =>
  held !== null && held.document.expiresAt > now ? held.document : FREE;

// Drop what is held, for a test and for a machine that just signed out.
export const forgetDisplay = (): void => {
  held = null;
};

/**
 * The account this machine signs in as, for code that has no person to talk to.
 *
 * `say` goes nowhere. A page load is not a command, and there is no terminal to print a line to.
 */
export const localCloud = (env: Record<string, string | undefined> = process.env): Cloud => ({
  keychain: createKeychain(process.platform, runKeychain, resolveDataDir(env)),
  baseUrl: cloudUrl(env),
  machine: machineName(hostname()),
  say: () => {},
  fetch: httpPost,
});

/**
 * One round of asking, with a ceiling on the whole round.
 *
 * A round makes three waits, not one: the keychain read, the call that mints the access token, and
 * the document fetch. Only the last carries its own timeout. The keychain has none on purpose,
 * because a locked one shows a dialog a person may take a minute to answer, and a host that accepts
 * the connection and never replies holds the token call for minutes. A page load waits on all
 * three, so the round is bounded here rather than each call being bounded on its own.
 *
 * Giving up does not stop the work, it stops the waiting: the page draws Free and the next load
 * asks again after the retry wait.
 *
 * `expectedId` is left out because this client has no user id of its own to compare against: the
 * access token is what binds the answer to this machine's account, and the document is never read
 * back from a file somebody else could have written.
 */
async function ask(
  cloud: Cloud,
  fetch: DisplayFetch,
  keys: readonly string[],
  now: number,
  timeoutMs: number,
): Promise<DisplayEntitlement> {
  const round = async (): Promise<DisplayEntitlement> => {
    const token = await machineAccessToken(cloud);
    if (token === null) return FREE;
    return await displayFrom(await fetchDisplay(cloud.baseUrl, token, fetch), undefined, keys, now);
  };
  // `AbortSignal.timeout` and not `setTimeout`, because this timer must never be the reason a
  // process stays alive.
  const gaveUp = new Promise<DisplayEntitlement>((resolve) => {
    AbortSignal.timeout(timeoutMs).addEventListener('abort', () => resolve(FREE));
  });
  try {
    return await Promise.race([round(), gaveUp]);
  } catch {
    return FREE;
  }
}

const httpGet: DisplayFetch = (url, init) => fetch(url, init);

// The same ceiling on the token call, so a host that never answers loses its socket instead of
// holding one until Node's own five minute default runs out.
const httpPost: NonNullable<Cloud['fetch']> = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
