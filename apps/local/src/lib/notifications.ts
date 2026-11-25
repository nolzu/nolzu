import type { DatabaseSync } from 'node:sqlite';
import { addNotification, type NotificationItem, notifications, unreadNotifications } from '@nolzu/core/node';
import { type CardState, isMaintenanceKey, phaseLabel, repoOfLearnKey, shortReason, type Verdict } from '@nolzu/protocol';

/** What the Now stream carries for the bell: the unread count and the newest few. */
export interface NotificationsView {
  unread: number;
  newest: NotificationItem[];
}

const NEWEST_SENT = 5;

export function notificationsView(db: DatabaseSync): NotificationsView {
  return { unread: unreadNotifications(db), newest: notifications(db, NEWEST_SENT) };
}

/**
 * Keeps the end of one card run, in the words its toast uses, plus a question it asked. A stop is the
 * person's own act and keeps nothing. The run id is the key, so the end is kept once.
 */
export function noteRunEnd(
  db: DatabaseSync,
  run: { id: number; key: string; phase: string },
  end: { cardState: CardState; failureReason: string | null; question: string | null },
  qa: { verdict: Verdict | null; reason: string | null } | null,
): void {
  const phase = phaseLabel(run.phase);
  const note = (kind: 'success' | 'error' | 'warning', text: string) => addNotification(db, { id: `run:${run.id}`, kind, text, card: run.key });
  if (end.cardState === 'failed') note('error', end.failureReason === null ? `${phase} failed. It gave no reason.` : `${phase} failed: ${shortReason(end.failureReason)}`);
  else if (end.cardState === 'blocked') note('warning', `${phase} asks you: ${shortReason(end.question ?? 'Read the question on the card.')}`);
  else if (end.cardState !== 'ready') return;
  else if (qa?.verdict === 'FAIL') note('error', qa.reason === null ? `${phase} failed` : `${phase} failed: ${shortReason(qa.reason)}`);
  else if (qa !== null && qa.verdict === null && qa.reason !== null) note('warning', `${phase} gave no verdict: ${shortReason(qa.reason)}`);
  else note('success', qa?.verdict === 'PASS' ? `${phase} passed` : `${phase} finished`);
}

/**
 * Keeps a failed knowledge run of no card, Learn or Optimize, which raises no toast and shows only on
 * Knowledge otherwise, so a Learn that failed before the card it held started is not missed. The run
 * id is the key, so the end is kept once.
 */
export function noteMaintenanceFailure(db: DatabaseSync, run: { id: number; key: string; phase: string }, end: { cardState: CardState; failureReason: string | null }): void {
  if (!isMaintenanceKey(run.key) || end.cardState !== 'failed') return;
  const repo = repoOfLearnKey(run.key);
  const what = repo === null ? phaseLabel(run.phase) : `Learning ${repo}`;
  const text = end.failureReason === null ? `${what} failed. It gave no reason.` : `${what} failed: ${shortReason(end.failureReason)}`;
  addNotification(db, { id: `run:${run.id}`, kind: 'error', text, href: '/knowledge' });
}

