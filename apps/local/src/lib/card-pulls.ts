import type { CardPullLine } from './pull-list.ts';

export interface PullsRead {
  pulls: CardPullLine[];
  said: string | null;
}

// Limit: one held read, reused for a few seconds. Enough for the head and the Overview of one page
// load; a second card or a later visit asks gh again.
const REUSE_MS = 10_000;
let held: { url: string; at: number; read: Promise<PullsRead> } | null = null;

/**
 * The pull request state of a closed card, read through the app's `GET /api/card/<key>/pr`. The card
 * head's "Changes merged" and the Overview's pull request lines both ask, and share one read.
 */
export function readCardPulls(url: string, get: typeof fetch = fetch): Promise<PullsRead> {
  if (held !== null && held.url === url && Date.now() - held.at < REUSE_MS) return held.read;
  const read = (async (): Promise<PullsRead> => {
    try {
      const answer = await get(url);
      if (answer.ok) return (await answer.json()) as PullsRead;
    } catch {
      // Said below, the same as a refused read.
    }
    return { pulls: [], said: 'The pull request state could not be read. The local app is not answering.' };
  })();
  held = { url, at: Date.now(), read };
  return read;
}

// Every repository's pull request, so a card with one still open does not read merged.
export const merged = (read: PullsRead): boolean => read.pulls.length > 0 && read.pulls.every((pull) => pull.state === 'merged');

// Words with the time they name, which the record draws as "3 hours ago" with the date on hover.
export interface TimedWords {
  words: string;
  at?: string;
}

/**
 * A closed card's Pull request row in the record: "#42 opened" and ", merged by you", each with its
 * time. Null for a line gh did not read a number for, and each part is left out when gh did not say it.
 */
export function pullTrail(pull: CardPullLine): TimedWords[] | null {
  if (pull.number === null) return null;
  const timed = (words: string, at: string | undefined): TimedWords => (at === undefined ? { words } : { words, at });
  const opened = timed(pull.openedAt === undefined ? `#${pull.number}` : `#${pull.number} opened`, pull.openedAt);
  if (pull.state !== 'merged') return [opened];
  return [opened, timed(pull.mergedBy === undefined ? ', merged' : `, merged by ${pull.mergedBy}`, pull.mergedAt)];
}
