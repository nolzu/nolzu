/**
 * The pure half of the Scout pipeline: normalize, fingerprint, dedup.
 *
 * Nothing here calls an engine, because fetching, counting,
 * pattern matching and change detection are plain code and the agent runs only when something new
 * or changed appears. A wrong answer here costs either a finding per log line, which is the noise
 * Scout exists to remove, or one finding over two real problems, which hides the second.
 */

// What an occurrence carries and an event does not. Each pattern is replaced by one token, so two
// lines of one event come out the same and two lines of two events do not. Order matters: a uuid
// and a hash are both hex, and the wider pattern has to run first or it eats half of the narrower
// one and leaves the rest.
const VARIABLE: readonly [RegExp, string][] = [
  // 2026-09-26T14:02:11.482Z, with or without the fraction and the zone.
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b0x[0-9a-f]+\b/gi, '<id>'],
  // What is left of a clock once the date form above has had its turn. Three parts, because two
  // short numbers joined by a colon are far more often a line and a column or a host and a port,
  // and reading those as a clock split one stack frame into a finding per line number.
  [/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>'],
  // A hex run that holds a digit and a letter, which a word does not and an id almost always does.
  // A plain decimal run falls through to the number rule below, so `5000` and `120000` stay one
  // event, and a word made of a to f, such as `decade` or `facade`, is left alone, so two of them
  // stay two events.
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{3,}\b/gi, '<id>'],
  // The all-letter hex runs long enough that no word is one. Eight, because `deadbeef` is an id and
  // `facade` is a word.
  // Limit: an id that is only the letters a to f and shorter than eight reads as a word, and an
  // id shorter than three reads as its parts. Both cost an extra finding, and the way out, a
  // shorter rule, costs two real problems folded into one, which is the worse half of the trade.
  [/\b[a-f]{8,}\b/gi, '<id>'],
  [/\d+/g, '<n>'],
];

/**
 * The invisible characters out of a line.
 *
 * Zero-width spaces, a zero-width joiner, a word joiner and a byte order mark. They survive a trim
 * and they are not whitespace, so one of them in front of a line would give the same event a second
 * fingerprint that can never merge. Every adapter that reads text a person typed or pasted owes this:
 * a search term, a name or an id copied from a web page carries them, and a Windows shipper writes
 * the byte order mark in front of every line.
 *
 * Its own function and not part of `normalize`, because `normalize` is the fingerprint contract
 * and moving the strip inside it changes every fingerprint the pipeline has ever made.
 */
export const visible = (text: string): string => text.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');

/**
 * One occurrence, as the event behind it.
 *
 * Ids, timestamps, numbers and hashes go, and the words stay, because a person reads the message on
 * the finding and a line stripped to tokens tells them nothing.
 */
export function normalize(message: string): string {
  let text = message;
  for (const [pattern, token] of VARIABLE) text = text.replace(pattern, token);
  // A line wrapped by one collector and not by another is still one event.
  return text.replace(/\s+/g, ' ').trim();
}

// Every token the rules above can leave, folded into one. A field that reads as a number in one
// occurrence and as an id in the next is still that one field: a request id of `2a3f` holds a
// letter and `2000` does not, and two tokens for it made two findings out of one event. The
// message a person reads keeps the three tokens apart, because there the difference is worth
// something. The id the hash is taken over does not.
const TOKENS = /<time>|<id>|<n>/g;

// The message as the fingerprint reads it. `normalize` is what a person reads on the finding.
const key = (message: string): string => normalize(message).replace(TOKENS, '<v>');

export interface ScoutItem {
  // The adapter that found it, which keeps two sources from sharing a finding.
  sourceKind: string;
  // The error class or the level, where the source names one. Empty where it does not.
  errorType: string;
  message: string;
  // Where it happened: a file and a line, a route, a service. Empty where the source says nothing.
  location: string;
  // The id the source groups by, for a source that groups at all. Sentry is the one that does, and
  // its own id outlives a reworded message, which Nolzu's own fingerprint would not.
  sourceId?: string;
}

// Two 32-bit FNV-1a lanes with their own seeds and their own odd multipliers, printed as one 64-bit
// id. This
// package is pure and runs on the server too, so `node:crypto` is out and Web Crypto is asynchronous. It is
// not a cryptographic hash and does not need to be: nothing here is a secret, and what is asked of
// it is that the same event gives the same id on every machine and on every day.
//
// Both lanes read the whole character. A lane fed only the high byte would be a constant for every
// ASCII string of one length, which would leave 32 real bits and a collision rate to match.
export function hash(text: string): string {
  let low = 0x811c9dc5;
  let high = 0x9dc5811c;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + 0x9e3779b9), 0x85ebca6b) >>> 0;
  }
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

/**
 * The id one event keeps across its occurrences.
 *
 * The same fingerprint updates one finding, with its occurrence count and its last seen time,
 * rather than making a second. The source kind leads the id, so a finding says at a glance which
 * adapter found it and two sources can never collide.
 */
export function fingerprint(item: ScoutItem): string {
  // Encoded, because this id travels into a URL and the vendor chose its characters, not us. A
  // plain id such as `RECIPES-API-4F` comes through unchanged and stays readable.
  if (item.sourceId !== undefined && item.sourceId !== '') return `${item.sourceKind}:${encodeURIComponent(item.sourceId)}`;
  // The three parts that say which event this is, with a separator no field can hold, so two fields
  // cannot run together into one string that another pair would also make. The source kind is not
  // among them: it is already the prefix, and two sources can never share an id because of it.
  return `${item.sourceKind}:${hash([item.errorType, key(item.message), item.location].join('\u0000'))}`;
}

export interface ScoutGroup {
  fingerprint: string;
  // How many occurrences this fetch carried. The finding adds it to what it already counted.
  count: number;
  // The first and the last occurrence of the event in this fetch, which are what the finding shows
  // as first and last seen.
  first: ScoutItem;
  last: ScoutItem;
}

/**
 * One fetch, as the events behind it.
 *
 * Runs before anything is stored, so a fetch of ten thousand log lines reaches the database as the
 * handful of events behind them. The order is the order each event was first seen, because that is
 * the order the source reported them in and a person reads the list that way.
 */
export function dedup(items: readonly ScoutItem[]): ScoutGroup[] {
  const found = new Map<string, ScoutGroup>();
  for (const item of items) {
    const id = fingerprint(item);
    const seen = found.get(id);
    // Changed in place, because a fetch can carry a hundred thousand lines and a new object per
    // line is a hundred thousand objects for a handful of events.
    if (seen === undefined) found.set(id, { fingerprint: id, count: 1, first: item, last: item });
    else {
      seen.count += 1;
      seen.last = item;
    }
  }
  return [...found.values()];
}
