import type { GitHost, ScannedRemote } from '@nolzu/protocol';

// The two hosts Nolzu can open a pull request against. A self hosted GitLab cannot be told from any
// other domain by its URL, so it lands with the unknown hosts on purpose.
const HOSTS: Record<string, GitHost> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
};

// Where a remote points, as written. The host is kept as found, so a caller that knows what to do
// with a host this file does not recognise still has it.
export interface RemotePlace {
  host: string;
  owner: string;
  repo: string;
}

export function splitUrl(url: string): { host: string; path: string } | null {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    try {
      const parsed = new URL(url);
      return { host: parsed.hostname, path: parsed.pathname };
    } catch {
      return null;
    }
  }
  // The scp form git accepts, user@host:owner/repo. It is not a URL, so the URL parser reads
  // the host as a scheme and the rest as a path.
  const scp = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(url);
  if (scp === null) return null;
  return { host: scp[1] ?? '', path: scp[2] ?? '' };
}

// A clone made by CI, or one set up with a token, carries the credential in its remote URL. The
// URL is kept for a remote Nolzu cannot resolve, so the credential comes off first: a secret
// belongs in the keychain and never in a result that is shown, logged or written to the database.
//
// What marks a secret is the colon inside the user info, not the shape of the URL. In a scheme URL
// the whole user info goes, because a token is often the user with nothing after it. In the scp
// form `git@host:path` that user is how every SSH remote reads, so it stays, and only a
// `user:password` pair is dropped.
export function withoutCredentials(url: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    return url.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@]*@/, '$1');
  }
  return url.replace(/^[^/@]*:[^/@]*@/, '');
}

export function parseRemote(name: string, url: string): ScannedRemote {
  const place = splitUrl(url);
  const host = place === null ? undefined : HOSTS[place.host.toLowerCase()];
  if (place === undefined || place === null || host === undefined) return { supported: false, name, url: withoutCredentials(url) };

  const parts = place.path.split('/').filter((part) => part !== '');
  const last = parts.at(-1);
  const repo = last === undefined ? undefined : last.replace(/\.git$/i, '');
  // A GitLab group nests, so everything before the last part is the owner. Keeping only the
  // first would name a repository that does not exist.
  if (repo === undefined || parts.length < 2) return { supported: false, name, url: withoutCredentials(url) };
  return { supported: true, name, host, owner: parts.slice(0, -1).join('/'), repo };
}


// The same reading, without the host allow list, for a caller that needs the parts of any remote.
// One parser, so a URL cannot be read two ways in one product.
export function parseRemoteUrl(url: string): RemotePlace | null {
  const place = splitUrl(url);
  if (place === null) return null;

  const parts = place.path.split('/').filter((part) => part !== '');
  const last = parts.at(-1);
  if (last === undefined || parts.length < 2) return null;

  // A GitLab group nests, so everything before the last part is the owner.
  return { host: place.host, owner: parts.slice(0, -1).join('/'), repo: last.replace(/\.git$/i, '') };
}
