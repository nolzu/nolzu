import type { CardView } from '@nolzu/protocol';

/**
 * Where a blocked card is answered: the composer on its card page. The card's Answer link and the A
 * key on the board both go here, so a question has one place to be answered. Null on a card that
 * asks nothing.
 */
export function answerHref(card: Pick<CardView, 'key' | 'state' | 'question'>): string | null {
  return card.state === 'blocked' && card.question !== null ? `/t/${encodeURIComponent(card.key)}/overview#asks` : null;
}

/**
 * The answer after a press on one of the options the agent offered. A field set by script loses its
 * undo history, so a press never drops typed text: the label goes in front of it, in place of the
 * label a press put there before. The card page's composer and Now both answer through this.
 */
export function pickOption(draft: string, options: readonly { label: string }[], label: string): string {
  const text = draft.trim();
  const before = options.find((option) => text === option.label || text.startsWith(`${option.label}\n\n`));
  const typed = (before === undefined ? text : text.slice(before.label.length)).trim();
  return typed === '' ? label : `${label}\n\n${typed}`;
}

/**
 * A question as the card page draws it: the first paragraph at size, the paragraphs under it as the
 * run wrote them, and a chip for each file it named in backticks. A name with no slash is a table or
 * a word, not a file, so it stays in its sentence only.
 */
export function questionParts(question: string): { lead: string; body: string[]; files: string[] } {
  const [lead = '', ...body] = question
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const files = [...new Set([...body.join('\n').matchAll(/`([^`\s]+\/[^`\s]+)`/g)].map((match) => match[1] ?? ''))];
  return { lead, body, files };
}

/**
 * "asked 15:02 · waiting 12m": when the card started to wait, off the Now snapshot, and for how long.
 * Null for a time that is no time.
 */
export function askedLine(since: string, now: Date, timeZone?: string): string | null {
  const then = new Date(since);
  if (Number.isNaN(then.getTime())) return null;
  const at = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(then);
  const minutes = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 60_000));
  const waited = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `asked ${at} · waiting ${waited}`;
}
