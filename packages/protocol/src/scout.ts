// The adapters Scout ships. A runtime list as well as a type, so the form and the
// screen read one list rather than each keeping a copy. The table's own CHECK is a copy of it,
// because a released migration is never edited: a fifth kind is an appended migration.
export const SCOUT_SOURCE_KINDS = ['paste', 'tickets', 'sentry', 'search'] as const;

export type ScoutSourceKind = (typeof SCOUT_SOURCE_KINDS)[number];

export const isScoutSourceKind = (value: string): value is ScoutSourceKind => (SCOUT_SOURCE_KINDS as readonly string[]).includes(value);

// What a person is shown where a source kind is named.
export const SCOUT_SOURCE_LABELS: Readonly<Record<ScoutSourceKind, string>> = {
  paste: 'Pasted text',
  tickets: 'Ticket query',
  sentry: 'Sentry',
  search: 'Log query',
};

/**
 * The keychain name a source's secret had before it was named by kind and project.
 *
 * Kept because the first read of an older source moves its secret from here to `scoutEntryName`.
 */
export const scoutSecretName = (id: number): string => `scout-${id}`;

/**
 * The project part of a source's keychain name: the project, the teams or the address it reads in
 * that service, cut to what a keychain name may hold. An address counts by its host, without a user
 * name or a password a person may have typed into it.
 */
export function scoutEntrySlug(project: string): string {
  const typed = project.trim();
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#]*)/i.exec(typed)?.[1] ?? typed;
  return host
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * The keychain name that holds one source's secret: its kind, the project it reads and its id, such
 * as `sentry-recipes-web-7`, so a person can find it in their keychain app.
 *
 * The id keeps two sources of one kind and project apart, so removing a source takes its own secret
 * and never another's. The keychain refuses a name that is not lower case letters, digits and
 * hyphens, which this shape always is, and adds a tag of the data folder to it.
 */
export const scoutEntryName = (kind: string, project: string, id: number): string =>
  [kind, scoutEntrySlug(project), String(id)].filter((part) => part !== '').join('-');

/**
 * The key an assessment run carries, for the finding it is about.
 *
 * A finding is no card, and a run needs a key: it names the run's own folder, its log file and its
 * rows. One key per finding and not one reserved key for every assessment, because the queue
 * refuses a second run under a key it already holds, and the lane is what has to hold one
 * assessment at a time. `runs.card_key` and `scout_findings.card_key` both take a key with no card
 * behind it, which is why neither has a foreign key.
 *
 * It lives here beside the source secret name, because the loop builds it and the screen reads it
 * back, and a second copy of the shape would let the two drift apart.
 */
export const assessKey = (findingId: number): string => `assess-${findingId}`;

/** The finding an assessment key is about, or null when the key is not one. */
export function findingOfKey(key: string): number | null {
  const match = /^assess-(\d+)$/.exec(key);
  return match === null ? null : Number(match[1]);
}
