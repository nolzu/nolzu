import type { CardState } from '@nolzu/protocol';
import { ago } from '../board/peek.ts';
import { type Seen, settle } from './actions.ts';

// The shapes the PRs tab draws, as the card page loads them from the last read. Comment text stays on
// this page: nothing here goes into the board snapshot.

export type PrStatus = 'new' | 'fixing' | 'fixed' | 'done';
export type PrVerdict = 'fix' | 'reject' | 'clarify' | 'defer' | 'none';

export interface PrMessage {
  id: number;
  author: string | null;
  body: string;
  createdAt: string;
  url: string | null;
  mine: boolean;
  unread: boolean;
}

export interface PrDiscussion {
  ref: string;
  // The row id of its pull request on the card.
  pull: number;
  kind: 'thread' | 'review' | 'comment';
  path: string | null;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  status: PrStatus;
  verdict: PrVerdict | null;
  // What the newest triage said: one line each, and the drafted reply the person copies.
  summary: string | null;
  reason: string | null;
  reply: string | null;
  needsAction: boolean | null;
  // What the last Fix said when it ended well, and why the last one failed or was stopped.
  fixNote?: string | null;
  fixFailed?: string | null;
  // The question a running Fix stopped on, while the card waits for the answer on its overview.
  fixAsks?: string | null;
  messages: PrMessage[];
}

export interface PrPullRef {
  id: number;
  repo: string;
  number: number;
  url: string | null;
}

/**
 * The line a row shows for a message. A quoted reply, an HTML comment a bot hides its ids in, a fence
 * and a lone tag say nothing a person reads, so they are skipped, and a heading, list, bold, italic,
 * code or link mark is taken off. With nothing left, the first line that has text, as it is.
 */
export function firstLine(body: string): string {
  const lines = body.replace(/<!--[\s\S]*?-->/g, '').split('\n').map((line) => line.trim());
  for (const line of lines) {
    if (line === '' || line.startsWith('>') || line.startsWith('```') || line.startsWith('~~~') || /^<[^>]+>$/.test(line) || /^<\/?[a-z]+[^>]*>.*<\/[a-z]+>$/i.test(line)) continue;
    if (/^[-=*_]{3,}$/.test(line)) continue;
    const text = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^([-*+]|\d+[.)])\s+/, '')
      // The row draws plain text, so inline marks come off too: a link keeps its words, code its text.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, '$1$3')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
      .trim();
    if (text !== '') return text;
  }
  return body.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

export const reviewerOf = (row: PrDiscussion): string => {
  const author = row.messages[0]?.author;
  return author === null || author === undefined ? 'Deleted account' : author;
};

export const unread = (row: PrDiscussion): boolean => row.messages.some((one) => one.unread);

// A row nobody has to act on: it is done, or triage said none and the person did not pull it back
// with Needs action. Done always folds: Needs action sets a done row back to new, and a thread
// resolved on GitHub after that is done again, so it must not sit among the rows to act on.
const quiet = (row: PrDiscussion): boolean => row.status === 'done' || (row.verdict === 'none' && row.needsAction !== true);

/** The rows to act on, and the ones for the folded "Nothing to action" footer, each in ref order. */
export function splitRows<R extends PrDiscussion>(rows: readonly R[]): { action: R[]; quiet: R[] } {
  return { action: rows.filter((row) => !quiet(row)), quiet: rows.filter(quiet) };
}

/** Where the row opens on GitHub: its first message when the read had its link, else the pull request. */
export function discussionLink(row: PrDiscussion, pulls: readonly PrPullRef[]): string {
  const first = row.messages[0]?.url;
  if (first !== null && first !== undefined) return first;
  const pull = pulls.find((one) => one.id === row.pull);
  return pull === undefined ? 'https://github.com' : (pull.url ?? `https://github.com/${pull.repo}/pull/${pull.number}`);
}

/** "Read just now", "Read 5 minutes ago", or "Never read" before the first read. */
export function readWords(at: string | null, now: Date): string {
  if (at === null) return 'Never read';
  if (now.getTime() - Date.parse(at) < 60_000) return 'Read just now';
  const said = ago(at, now, true);
  return said === null ? 'Never read' : `Read ${said}`;
}

/**
 * The Run triage button: "Triage again" once a row has a verdict, and held, with the reason, while a
 * run or a question holds the card, while nothing is open, while the model row would be refused, and
 * from the press until the board shows the card moved. Busy state comes off the snapshot, not the
 * press's answer.
 */
export function triageView(rows: readonly PrDiscussion[], card: (Seen & { state: CardState }) | null, refusal: string | null, pressed: Seen | null): { label: string; why: string | null } {
  const label = rows.some((one) => one.verdict !== null) ? 'Triage again' : 'Run triage';
  const why =
    card === null
      ? 'The board has not answered yet.'
      : settle(pressed, card) !== null
        ? 'Sent. Waiting for the board to show the run.'
        : card.state === 'queued' || card.state === 'running'
          ? `A run holds ${card.key} now. Triage once it ends.`
          : card.state === 'blocked'
            ? `${card.key} waits for an answer. Answer it first.`
            : !rows.some((one) => one.status !== 'done')
              ? 'Nothing is open to triage.'
              : refusal;
  return { label, why };
}

// Why a press that starts a run waits, read off the card in the snapshot: before the board answered,
// from the press until it shows the run, while a run or a question holds the card, and after a
// failure. `verb` finishes "Fix once it ends". Null when nothing holds it.
function held(card: (Seen & { state: CardState }) | null, pressed: Seen | null, verb: string): string | null {
  if (card === null) return 'The board has not answered yet.';
  if (settle(pressed, card) !== null) return 'Sent. Waiting for the board to show the run.';
  if (card.state === 'queued' || card.state === 'running') return `A run holds ${card.key} now. ${verb} once it ends.`;
  if (card.state === 'blocked') return `${card.key} waits for an answer. Answer it first.`;
  if (card.state === 'failed') return `${card.key} failed. Retry it or move it first.`;
  return null;
}

/**
 * The Fix button of one row: "Fix again" on a fixed row, and held, with the reason, while a fix runs on
 * any row of the card (one at a time), while a run or a question holds the card, after a failure, and
 * from the press until the board shows the run. Busy state comes off the snapshot, as for triage.
 */
export function fixView(rows: readonly PrDiscussion[], item: PrDiscussion, card: (Seen & { state: CardState }) | null, pressed: Seen | null): { label: string; why: string | null } {
  const label = item.status === 'fixed' ? 'Fix again' : 'Fix';
  const running = rows.find((one) => one.status === 'fixing');
  // A fix that runs is read off the rows, so it is said before the board has answered too.
  const why =
    running !== undefined
      ? running.ref === item.ref
        ? running.fixAsks
          ? 'Waiting for your answer.'
          : 'Fixing now. The row changes when the run ends.'
        : `${running.ref} is being fixed now. One fix runs at a time.`
      : held(card, pressed, 'Fix');
  return { label, why };
}

/**
 * The Fix all button: one run over every row triage wants fixed that is new, "Fix all 3" when there
 * are several. Held as a row's Fix is, and while no such row is left.
 */
export function fixAllView(rows: readonly PrDiscussion[], card: (Seen & { state: CardState }) | null, pressed: Seen | null): { label: string; why: string | null } {
  const due = rows.filter((one) => one.verdict === 'fix' && one.status === 'new').length;
  const running = rows.find((one) => one.status === 'fixing');
  const why =
    running !== undefined
      ? `${running.ref} is being fixed now. One fix runs at a time.`
      : (held(card, pressed, 'Fix all') ?? (due === 0 ? (rows.some((one) => one.verdict !== null) ? 'No comment triage wants fixed is left to fix.' : 'Run triage first, so Fix all knows which comments to fix.') : null));
  return { label: due > 1 ? `Fix all ${due}` : 'Fix all', why };
}

/**
 * The QA the fixes button. `due` is the refs fixed since the last QA with a verdict, which the run
 * checks. Held as Fix is, while a fix runs, and while nothing was fixed since the last QA.
 */
export function qaFixesView(due: readonly string[], rows: readonly PrDiscussion[], card: (Seen & { state: CardState }) | null, pressed: Seen | null): { label: string; why: string | null } {
  const running = rows.find((one) => one.status === 'fixing');
  const why =
    running !== undefined
      ? `${running.ref} is being fixed now. Run QA once the fix ends.`
      : (held(card, pressed, 'Run QA') ?? (due.length === 0 ? 'Nothing was fixed since the last QA.' : null));
  return { label: 'QA the fixes', why };
}

/**
 * The board card's line about its review comments, "3 to fix · 1 new", with a part at nought left out,
 * and the label a screen reader hears in its place, where the dot would read as a word. Null at none.
 */
export function feedbackLine(counts: { toFix: number; unread: number } | undefined): { text: string; label: string } | null {
  if (counts === undefined) return null;
  const parts = [...(counts.toFix > 0 ? [`${counts.toFix} to fix`] : []), ...(counts.unread > 0 ? [`${counts.unread} new`] : [])];
  return parts.length === 0 ? null : { text: parts.join(' · '), label: `Review comments: ${parts.join(', ')}` };
}
