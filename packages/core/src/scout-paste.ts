/**
 * The adapter that needs no credential: pasted text.
 *
 * It exists so the whole pipeline can be walked before any account or key exists. It is also the
 * one source that can honestly answer "nothing new", which a check with no new events needs in order
 * to be tested at all.
 */

import type { ScoutSourceKind } from '@nolzu/protocol';
import { hash, type ScoutItem, visible } from './scout.ts';

// Pinned to the kind list rather than left as the plain string `ScoutItem` asks for, because this
// kind is the prefix of every finding id this adapter ever makes and a rename later is a data
// migration, not an edit.
const PASTE: ScoutSourceKind = 'paste';

// How many lines one item may hold.
// Limit: 50 lines covers any real stack trace with room to spare, and the ceiling is what keeps
// a pasted ten thousand line indented blob from becoming one message nobody can read. Past it the
// next line opens a new item, so nothing is dropped. Raise it, or cut the message where a finding
// is stored, if a source is found that nests deeper.
const LINES_PER_ITEM = 50;

export interface PasteFetch {
  items: ScoutItem[];
  // The digest of the text that was read, which the next call hands back to say what it has seen. A
  // read that carried nothing leaves the digest of the last real read in place.
  cursor: string | null;
}

/**
 * One paste, as the occurrences in it.
 *
 * Synchronous, because a paste does no IO. The cursor is the digest of the text: a person who
 * pastes the same text twice has not seen the event twice, so a second read of that exact text
 * carries nothing and the finding keeps the count it had. The digest is over the text as pasted and
 * not the normalized text, so a paste that differs by a single character is genuinely new.
 *
 * One slot, so it remembers the previous paste only. A paste that alternates with another one, or
 * that appends to an earlier one, is read again, and those repeats fold into the count of the finding
 * that is already there.
 *
 * `errorType` and `location` stay empty and `sourceId` is left out, because pasted text names
 * neither. Guessing an error class or a file path out of it costs findings in both directions, and
 * the message alone already tells two events apart.
 */
export function fetchPaste(text: string, cursor: string | null): PasteFetch {
  const digest = hash(text);
  if (cursor === digest) return { items: [], cursor: digest };

  const items: ScoutItem[] = [];
  let held = 0;
  // A Python traceback puts its error line last and at column zero, so the header opens a wait that
  // only that line closes. Without it the line naming the error splits off as its own item, and the
  // frames above it become a finding that says nothing.
  let waiting = false;
  for (const raw of text.split(/\r\n?|\n/)) {
    // The zero-width characters go first, for the reason `visible` gives.
    const clean = visible(raw);
    const line = clean.trim();
    // A blank line carries no occurrence, and keeping it would end the item above it.
    if (line === '') continue;
    const open = items.at(-1);
    // An indented line, or a stack frame, belongs to the line above it, so a pasted trace is one
    // event and not one per frame. With nothing above it, or once the item is full, it opens an
    // item of its own rather than being thrown away.
    const joins = /^\s/.test(clean) || line.startsWith('at ') || line.startsWith('Caused by:') || waiting;
    if (open !== undefined && held < LINES_PER_ITEM && joins) {
      open.message += `\n${line}`;
      held += 1;
      // The error line sits at column zero, so it is the one that ends the wait.
      if (!/^\s/.test(clean)) waiting = false;
      continue;
    }
    items.push({ sourceKind: PASTE, errorType: '', message: line, location: '' });
    held = 1;
    waiting = line.startsWith('Traceback (most recent call last)');
  }
  // Nothing was read, so nothing is forgotten: the marker stays where the last real read left it.
  // Moving it on an empty box would make the text before it look new again on the next paste.
  if (items.length === 0) return { items, cursor: cursor ?? digest };
  return { items, cursor: digest };
}
