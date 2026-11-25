import type { DatabaseSync } from 'node:sqlite';

/** The toast kinds, so an item reads as the toast it was. */
export type NotificationKind = 'success' | 'error' | 'warning' | 'info';

/** One thing that happened, as the bell's panel lists it. */
export interface NotificationItem {
  id: string;
  at: string;
  kind: NotificationKind;
  // The card it is about, which its link opens when it has no address of its own.
  card: string | null;
  text: string;
  href: string | null;
  read: boolean;
}

/** How many the project keeps. A write past it drops the oldest. */
export const NOTIFICATIONS_KEPT = 200;

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ')";

/**
 * Keeps one event. The id is the event's own key (`run:12`), so the same event written twice, from a
 * retried path or a second tab's request, stays one row. Answers whether a row was added.
 */
export function addNotification(db: DatabaseSync, notice: { id: string; kind: NotificationKind; text: string; card?: string | null; href?: string | null }): boolean {
  const added =
    db
      .prepare(`INSERT OR IGNORE INTO notifications (id, at, kind, card_key, text, href) VALUES (?, ${NOW}, ?, ?, ?, ?)`)
      .run(notice.id, notice.kind, notice.card ?? null, notice.text, notice.href ?? null).changes > 0;
  if (added) db.prepare('DELETE FROM notifications WHERE rowid NOT IN (SELECT rowid FROM notifications ORDER BY at DESC, rowid DESC LIMIT ?)').run(NOTIFICATIONS_KEPT);
  return added;
}

interface Row {
  id: string;
  at: string;
  kind: NotificationKind;
  card_key: string | null;
  text: string;
  href: string | null;
  read_at: string | null;
}

/** Newest first. */
export function notifications(db: DatabaseSync, limit = NOTIFICATIONS_KEPT): NotificationItem[] {
  const rows = db.prepare('SELECT * FROM notifications ORDER BY at DESC, rowid DESC LIMIT ?').all(limit) as unknown as Row[];
  return rows.map((row) => ({ id: row.id, at: row.at, kind: row.kind, card: row.card_key, text: row.text, href: row.href, read: row.read_at !== null }));
}

export function unreadNotifications(db: DatabaseSync): number {
  return (db.prepare('SELECT count(*) AS n FROM notifications WHERE read_at IS NULL').get() as { n: number }).n;
}

/** Opening the panel reads them all. Answers whether any was unread. */
export function markNotificationsRead(db: DatabaseSync): boolean {
  return db.prepare(`UPDATE notifications SET read_at = ${NOW} WHERE read_at IS NULL`).run().changes > 0;
}
