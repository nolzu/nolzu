import type { DatabaseSync } from 'node:sqlite';
import { parseTicketRef } from '@nolzu/protocol';
import { githubIssues, type RunGh } from '@nolzu/runner';

// One read: the adapter asks GitHub for twenty issues in one call.
const MOST = 20;
// The run waits for this read, so it gives up long before a run would.
const READ_MS = 10_000;

// The numbers an issue's text names as `#12`, where GitHub would link them, each once, in order, and
// not the issue's own. A `#` inside a word, a link or a heading such as `##2` names nothing.
export function namedNumbers(text: string, own: number): number[] {
  const found = [...text.matchAll(/(?<![\w&/#-])#([1-9]\d{0,6})\b/g)].map((match) => Number(match[1])).filter((number) => number !== own);
  return [...new Set(found)].slice(0, MOST);
}

/**
 * One line per issue a GitHub card's text names by number: "- #2: Holds expire (closed)".
 *
 * An epic lists its tasks as `- [ ] #1`, and GitHub shows their titles there, but the text holds the
 * numbers alone. A run cannot reach GitHub, so without this it spent its turns looking for them. Read
 * with the person's `gh`, as Add card reads an issue. Empty for any other card, and when GitHub did
 * not answer: the run then has the ticket as before.
 */
export async function namedIssues(db: DatabaseSync, key: string, run: RunGh | null, signal: AbortSignal): Promise<string[]> {
  if (run === null) return [];
  const card = db.prepare('SELECT summary, source, source_ref FROM cards WHERE key = ?').get(key) as { summary: string | null; source: string | null; source_ref: string | null } | undefined;
  if (card === undefined || card.source !== 'github' || card.summary === null || card.source_ref === null) return [];
  const own = parseTicketRef(card.source_ref);
  if (own.kind !== 'github' || own.owner === null) return [];
  const { owner, repo } = own;
  const numbers = namedNumbers(card.summary, own.number);
  if (numbers.length === 0) return [];
  try {
    const found = await githubIssues({ run, defaultOwner: owner }).get(
      numbers.map((number) => ({ kind: 'github', owner, repo, number })),
      AbortSignal.any([signal, AbortSignal.timeout(READ_MS)]),
    );
    return found.flatMap((one, at) => (one.ticket === null ? [] : [`- #${numbers[at]}: ${one.ticket.title.replace(/\s+/g, ' ').trim()}${one.ticket.state === 'closed' ? ' (closed)' : ''}`]));
  } catch {
    return [];
  }
}

// The lines under their own heading, before the prompt says how the run works, so they sit with the
// card. The last such heading: a ticket can hold one of its own, and only Nolzu's text comes after.
export function withNamedIssues(prompt: string, lines: readonly string[]): string {
  if (lines.length === 0) return prompt;
  const block = `## Issues the ticket names\n\nGitHub's titles for the issues the ticket names by number. This run cannot reach GitHub, so\nthese lines are all it has of them.\n\n${lines.join('\n')}\n\n`;
  const at = prompt.lastIndexOf('\n## How this run works\n');
  return at === -1 ? `${prompt}\n${block.trimEnd()}\n` : `${prompt.slice(0, at + 1)}${block}${prompt.slice(at + 1)}`;
}
