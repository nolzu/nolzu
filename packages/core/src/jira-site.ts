/**
 * The Jira site address a person typed, and the header a call to it carries.
 *
 * Pure, so the hosted service reads a site setting the same way this machine does, in the same
 * words.
 */

export interface JiraSite {
  // The site address, such as https://your-site.atlassian.net. A project setting, not a secret.
  url: string;
  // The account the token belongs to. Basic auth takes it as the user name. Also a setting.
  email: string;
}

/**
 * The account email and the API token as one Basic header.
 *
 * The bytes come from `TextEncoder` and not from `Buffer`, because this package also runs on
 * the server, which has no `Buffer`. `btoa` reads one byte per character, so the bytes are spelled out as
 * characters first. Without that step `btoa` does not fail loudly on an email with an accent in it:
 * it sends `é` as one byte instead of two, Jira answers 401, and nothing says why. It throws only
 * from U+0100 up. Checked against the `Buffer` version this replaced: the same base64 for an ascii
 * email and for an accented one.
 */
export const basicAuth = (email: string, token: string): string => {
  let characters = '';
  for (const byte of new TextEncoder().encode(`${email}:${token}`)) characters += String.fromCharCode(byte);
  return `Basic ${btoa(characters)}`;
};

/**
 * The site address a person typed, as an origin.
 *
 * https only: Basic auth over http would put the token on the wire in the clear. A user name or a
 * password in the address is refused rather than used, because the token belongs in the keychain.
 * The path is dropped, because every call names a full path of its own.
 */
export function siteOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    // Never the value: a mistyped address can hold the password, and this sentence is stored and shown.
    throw new Error('That is not a site address. A Jira site address looks like https://your-site.atlassian.net.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('A Jira site address starts with https, so the API token is never sent in the clear.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('A Jira site address carries no user name and no password. The API token goes into the keychain.');
  }
  return new URL(url.origin);
}
