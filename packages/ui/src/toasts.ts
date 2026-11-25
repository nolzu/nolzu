import { formatCost, formatDuration, ranOn } from '@nolzu/protocol';

// The stack the toast host draws. The page owns it and changes it only through these, so the limit
// and the one-toast-per-card rule hold wherever a toast comes from.

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

// What a finished run reported. A field is null when the run did not report it, such as the time,
// which the board snapshot does not carry.
export interface ToastRun {
  // The engine profile the run was on. Optional, because a sender built before it carries none.
  engine?: string | null;
  model: string | null;
  durationMs: number | null;
  costUsd: number | null;
}

export interface ToastItem {
  kind: ToastKind;
  // Every toast is about a card. Its key leads the first line, and Open links to it. A toast with no
  // href has no Open, such as a save on the page the person is already on, where Open would reload it.
  card: { key: string; href?: string | null };
  // The words after the key on the first line, such as "did not move to Plan". The message and the fix
  // then share one line under it, as in a refused drop. Without it the first line
  // is "KEY: message" and the fix has a line of its own.
  headline?: string | null;
  message: string;
  // A word of the message set in mono, such as the model in "Plan uses sonnet-4-5, which ...".
  code?: string | null;
  // What the reader can do about it, such as the setting that fixes a gone model.
  fix?: string | null;
  // Nothing ran: the board or the server turned the move down. Drawn with the ban sign, where an error
  // that ran and failed has the x.
  refused?: boolean;
  // The screen that fixes it, such as Settings, Models for a refused drop.
  link?: { label: string; href: string } | null;
  run?: ToastRun | null;
  // The first line of a toast about no card, drawn as it is in place of the key and the message, such
  // as "Scout: 2 new findings". The card's key then names the toast in the stack and for Open.
  title?: string | null;
  // The mono line of a toast that comes from no run, such as the source of Scout's findings.
  note?: string | null;
}

export const TOAST_LIMIT = 3;

// How long a toast stays before it closes by itself. An error or a toast with a link to act on gets
// longer, because it has more to read and something to press. Hover and focus inside pause it.
export const TOAST_MS = 6000;
export const TOAST_LONG_MS = 10_000;

export const toastLife = (toast: ToastItem): number => (toast.kind === 'error' || (toast.link ?? null) !== null ? TOAST_LONG_MS : TOAST_MS);

// The sentence cut around the one word set in mono, or null when there is none to cut around. The
// first place it stands, because a model named twice is set in mono once.
export function splitCode(text: string, code: string | null | undefined): [string, string, string] | null {
  const at = code === null || code === undefined || code === '' ? -1 : text.indexOf(code);
  if (at === -1 || code === null || code === undefined) return null;
  return [text.slice(0, at), code, text.slice(at + code.length)];
}

export function pushToast(stack: readonly ToastItem[], toast: ToastItem): ToastItem[] {
  return [...dropToast(stack, toast.card.key), toast].slice(-TOAST_LIMIT);
}

export function dropToast(stack: readonly ToastItem[], key: string): ToastItem[] {
  return stack.filter((one) => one.card.key !== key);
}

// The one mono line under a toast, such as "Claude Code · sonnet · 1m 02s · $0.08". Only what the run reported is
// written, and a toast with no run gets no line, because a made-up figure is worse than none.
export function runLine(run: ToastRun | null | undefined): string | null {
  if (run === null || run === undefined) return null;
  const parts = [ranOn(run.engine, run.model, null) || null, run.durationMs === null ? null : formatDuration(run.durationMs), run.costUsd === null ? null : formatCost(run.costUsd)];
  const said = parts.filter((part) => part !== null);
  return said.length === 0 ? null : said.join(' · ');
}
