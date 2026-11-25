/**
 * What the four timesheet exporters share: the one call on a destination's API, the sentences a
 * refusal leaves on an entry, and the check on an id a person pasted into a connection.
 *
 * Each adapter file owns its address, its body, its duplicate check and the sentence per status,
 * because those differ per destination. What is here is the part that has to read the same way in
 * all four: the token goes in one header and never into a path or a sentence, a redirect is not
 * followed, and a web page is never read as an answer.
 */

// What a call needs from `fetch`, so a test drives every call by hand and opens no socket.
export type ExportFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal; redirect: 'manual' },
) => Promise<Response>;

/**
 * What an adapter throws for an entry this destination can never take, with the reason as its
 * message. The entry keeps the reason on its row and is not counted as a failure, so a week of
 * local cards does not end a Jira export on `MAX_FAILURES_PER_EXPORT` or get stuck on
 * `MAX_ATTEMPTS`. It is asked again on the next export, which costs no call.
 */
export class ExportSkipped extends Error {}

/** One destination's call, as an adapter sets it up for one entry. */
export interface Destination {
  // The name a person reads, such as Toggl.
  label: string;
  origin: URL;
  // Every header the destination needs, the one that carries the token included.
  headers: Record<string, string>;
  // The raw token and every encoded form of it a header holds, taken out of any sentence.
  secrets: string[];
  // The sentence one refused call leaves on the entry, from the status and the body.
  refusal: (status: number, body: string, secrets: string[]) => string;
  fetcher?: ExportFetch | undefined;
}

// A page, not data: a JSON answer starts with a bracket, a brace or a quote.
export const isHtml = (body: string): boolean => body.trimStart().startsWith('<');

export const webPage = (label: string): string => `${label} answered with a web page instead of data, so the entry was not sent.`;

/**
 * The destination's own words about a refusal, cut short. They come as a JSON string, as an object
 * with a message, or as plain text, and no sentence written here can guess which field was refused.
 * Jira puts them in `errorMessages` or in `errors` by field, and Harvest's token refusal in
 * `error_description`.
 */
export function detail(label: string, body: string, secrets: string[]): string {
  let words: unknown = body;
  try {
    words = JSON.parse(body);
  } catch {
    // Plain text is the destination's words as they are.
  }
  if (words !== null && typeof words === 'object') {
    const held = words as Record<string, unknown>;
    const listed = Array.isArray(held.errorMessages) ? held.errorMessages[0] : undefined;
    const fields = held.errors !== null && typeof held.errors === 'object' ? Object.values(held.errors as Record<string, unknown>)[0] : undefined;
    words = held.message ?? held.error_description ?? held.error ?? listed ?? fields;
  }
  if (typeof words !== 'string') return '';
  // The token comes out after the decode, so an escaped one is caught, and before the cut, so no
  // half of it is left behind. `said` in the export loop knows only the raw token.
  const clean = secrets.reduce((text, secret) => text.split(secret).join('…'), words).trim();
  return clean === '' ? '' : ` ${label} said: ${clean.slice(0, 200)}`;
}

/**
 * One call on a destination's API, answering the body of the one status it expects.
 *
 * The token never goes in the path and never in a sentence: a path reaches a log, and a sentence is
 * stored and shown. A redirect is not followed, because a hop off the destination is some other
 * host's page, and read as the destination's answer it would look like a day with nothing on it.
 */
export async function callDestination(
  to: Destination,
  method: 'GET' | 'POST',
  path: string,
  body: string | undefined,
  signal: AbortSignal,
  expect: 200 | 201 = 200,
): Promise<string> {
  const target = new URL(path, to.origin);
  // Every path is built by an adapter from checked ids and a checked time, so this writes the rule
  // down rather than closing a hole: no path may carry the token to another host.
  if (target.origin !== to.origin.origin) {
    throw new Error(`A ${to.label} call names a path on ${to.origin.host}, and not another address.`);
  }
  const send: ExportFetch = to.fetcher ?? ((url, init) => fetch(url, init));
  const headers: Record<string, string> = { ...to.headers, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let answer: Response;
  let text: string;
  try {
    answer = await send(target.toString(), { method, headers, ...(body === undefined ? {} : { body }), signal, redirect: 'manual' });
    text = await answer.text();
  } catch {
    // Never the error itself and never as a cause: a transport error can carry the request, and
    // the request carries the token.
    throw new Error(
      signal.aborted
        ? `${to.label} did not answer in time, so the entry was not sent.`
        : `Nolzu could not reach ${to.label}, so the entry was not sent. Export again later.`,
    );
  }
  if (answer.status >= 300 && answer.status < 400) {
    throw new Error(`${to.label} answered with a redirect, so the entry was not sent.`);
  }
  // Any other yes to a post may still have made the entry, so it is never called a refusal.
  if (method === 'POST' && answer.status >= 200 && answer.status < 300 && answer.status !== expect) {
    throw new Error(
      `${to.label} answered ${answer.status} where ${expect} was expected, so the entry is not marked as sent. The next export looks for it in ${to.label} before it posts again.`,
    );
  }
  // A refusal that echoes the token or the header back would otherwise store it.
  if (answer.status !== expect) throw new Error(to.refusal(answer.status, text, to.secrets.filter(Boolean)));
  if (isHtml(text)) throw new Error(webPage(to.label));
  return text;
}

/**
 * An id a person copied into a connection, or null when the setting is left out. A number is read
 * as its digits, so a form that sent one and a form that sent a string store the same id.
 */
export function idSetting(
  label: string,
  settings: Record<string, unknown>,
  name: string,
  shape: RegExp,
  // Where a person finds the id, when it is not in the address of the thing it names.
  where = `the address of the ${name} in ${label}`,
): string | null {
  const value = settings[name];
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !shape.test(text)) {
    throw new Error(
      `The ${label} ${name} on this connection is not a ${label} id, so the entry was not sent. Save the ${label} connection again with the id from ${where}.`,
    );
  }
  return text;
}

/** The same, for a setting an entry cannot be sent without. Refused before any call. */
export function requiredId(label: string, settings: Record<string, unknown>, name: string, shape: RegExp, where?: string): string {
  const id = idSetting(label, settings, name, shape, where);
  if (id === null) {
    throw new Error(`This ${label} connection names no ${name}, so the entry was not sent. Save the ${label} connection again with its ${name}.`);
  }
  return id;
}

// A second as an instant, because Toggl, Clockify and Jira keep a start to the second.
export function startSecond(value: string): number | null {
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.floor(at / 1000);
}

/** The entry's start as a second, or a throw. The grid stamps every entry, so a throw here is a bug. */
export function entrySecond(start: string): number {
  const second = startSecond(start);
  if (second === null) throw new Error('The entry carries a start time Nolzu could not read, so it was not sent.');
  return second;
}

/** A UTC time to the second, with no fraction, the form every one of the four reads. */
export const utcSecond = (at: number): string => `${new Date(at).toISOString().slice(0, 19)}Z`;

export const DAY_MS = 86_400_000;
