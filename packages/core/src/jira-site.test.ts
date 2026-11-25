import { describe, expect, it } from 'vitest';
import { basicAuth, siteOrigin } from './jira-site.ts';

describe('siteOrigin', () => {
  it('keeps the site and drops the path, because every call names its own', () => {
    expect(siteOrigin('https://example.atlassian.net/jira/software/projects').toString()).toBe('https://example.atlassian.net/');
    expect(siteOrigin('  https://example.atlassian.net  ').host).toBe('example.atlassian.net');
  });

  // Basic auth over http would put the token on the wire in the clear.
  it('refuses http, so the token is never sent unencrypted', () => {
    expect(() => siteOrigin('http://example.atlassian.net')).toThrow(/starts with https/);
  });

  it('refuses an address that carries a password of its own', () => {
    expect(() => siteOrigin('https://someone:secret@example.atlassian.net')).toThrow(/no user name and no password/);
  });

  it('names what a site address looks like when it is not one', () => {
    expect(() => siteOrigin('example.atlassian.net')).toThrow(/looks like https:\/\/your-site\.atlassian\.net/);
    expect(() => siteOrigin('')).toThrow(/is not a site address/);
  });
});

describe('basicAuth', () => {
  // The email is the user and the token is the password. This is the one place the token is used.
  // Decoded with `atob` and not with `Buffer`, because this package also runs where there
  // is no `Buffer`.
  it('puts the account email and the token into one Basic header', () => {
    const header = basicAuth('someone@example.com', 'abc123');

    expect(header.startsWith('Basic ')).toBe(true);
    expect(atob(header.slice('Basic '.length))).toBe('someone@example.com:abc123');
  });

  /**
   * An email with an accent in it, which is what the `Buffer` version handled for free.
   *
   * Basic auth carries the UTF-8 bytes of `user:password`. `btoa` on the string itself reads one byte
   * per character, so it would send `é` as 0xE9 instead of 0xC3 0xA9 and Jira would answer 401. It
   * throws only from U+0100 up, so this test asserts the bytes and not a throw.
   */
  it('sends the utf-8 bytes of an email that is not ascii', () => {
    const header = basicAuth('zoé@example.com', 'abc123');

    const bytes = Uint8Array.from(atob(header.slice('Basic '.length)), (one) => one.charCodeAt(0));
    expect(new TextDecoder().decode(bytes)).toBe('zoé@example.com:abc123');
  });
});
