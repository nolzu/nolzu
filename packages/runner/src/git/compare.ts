import type { CompareUrl } from '@nolzu/protocol';
import { parseRemoteUrl, withoutCredentials } from './remote.ts';

export interface CompareDraft {
  remote: string;
  base: string;
  head: string;
  title: string;
  body: string;
  capBytes?: number;
}

// Measured against github.com: it stops answering just above 7050 characters, and what comes back
// is an "Internal server error" page rather than a length error, so a URL that is too long does not
// even look too long. This leaves room for drift at the edge. The body is the only part that grows,
// so it is the part that gives way.
const URL_CAP = 6800;

// The compare page only exists on github.com. An unknown domain may be a GitHub Enterprise install
// or anything else at all, and there is nothing in a remote URL that tells them apart, so this
// refuses by name rather than sending a person to a page that may not exist.
const GITHUB = 'github.com';

const cutToFit = (body: string, room: number): string => {
  if (encodeURIComponent(body).length <= room) return body;

  const note = 'The rest is on the card.';
  const lines = body.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const next = [...kept, line, note].join('\n');
    if (encodeURIComponent(next).length > room) break;
    kept.push(line);
  }

  // Cut between lines and never inside one, so no sentence arrives halved.
  return [...kept, note].join('\n');
};

export function compareUrl(draft: CompareDraft): CompareUrl {
  const place = parseRemoteUrl(draft.remote);
  if (place === null) {
    // A clone made by CI, or one set up with a token, carries the credential in its remote URL, and
    // this reason is shown in a button and can reach a log. Every other path that hands a URL back
    // strips it, and this one was the exception.
    return {
      ok: false,
      reason: `${withoutCredentials(draft.remote)} is not a remote Nolzu can read, so there is no compare page for it.`,
    };
  }
  if (place.host.toLowerCase() !== GITHUB) {
    return { ok: false, reason: `${place.host} is not github.com, and a pull request needs a GitHub remote.` };
  }
  if (draft.base === draft.head) {
    return { ok: false, reason: `${draft.head} is the same branch as the base, so there is nothing to compare.` };
  }

  // Encoded whole, so a branch name with a slash stays one path segment and the page exists.
  const range = `${encodeURIComponent(draft.base)}...${encodeURIComponent(draft.head)}`;
  const head = `https://${GITHUB}/${place.owner}/${place.repo}/compare/${range}?expand=1&title=${encodeURIComponent(draft.title)}&body=`;
  const cap = draft.capBytes ?? URL_CAP;

  return { ok: true, url: `${head}${encodeURIComponent(cutToFit(draft.body, Math.max(0, cap - head.length)))}` };
}
