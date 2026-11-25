import { execFileSync } from 'node:child_process';
import { CONFIG_DIR_VAR } from '@nolzu/protocol';

// The name of the variable that points at the login folder. The list belongs to the login, so the
// folder belongs in the cache key.
const CONFIG_VAR = CONFIG_DIR_VAR.cursor;

// The colours the binary prints its list in. They sit around the id, so a match on the line has to
// drop them first.
// eslint-disable-next-line no-control-regex -- the escape character is what has to be matched here
const COLOUR = /\u001B\[[0-9;]*m/g;

// One listed model: the id, a space, a dash, a space, the label. The heading and the tip line the
// list ends with carry no such dash after their first word, so neither reads as a model.
const LISTED = /^\s*([A-Za-z0-9][\w.-]*) - \S/;

/**
 * The one id Nolzu never asks for.
 *
 * `auto` lets the vendor choose the model inside the run, so the card would name one model and the
 * run would use another. It is dropped from the list rather than refused later, which also makes it
 * unpickable on every screen that draws the list.
 */
export const CURSOR_AUTO = 'auto';

/**
 * The model ids `cursor-agent --list-models` printed.
 *
 * The effort is part of the id, and some ids carry none, so nothing here takes an id apart. An id
 * goes to `--model` exactly as the binary printed it.
 */
export function parseCursorModels(text: string): string[] {
  const ids: string[] = [];
  for (const line of text.replace(COLOUR, '').split('\n')) {
    const id = LISTED.exec(line)?.[1];
    if (id !== undefined && id !== CURSOR_AUTO) ids.push(id);
  }
  return ids;
}

// The list comes from the login, so it is a network call and not a bundled table. Measured on
// 2026-09-25: 1.1 seconds. A call that cannot reach the endpoint sits there instead, so this is what
// one board snapshot waits when the line is down: ten seconds, once, and then the answer below
// spares the next ones.
const LIST_TIMEOUT_MS = 10_000;

export function readCursorModels(binary: string, env: Record<string, string | undefined>): readonly string[] {
  try {
    // stderr is dropped: a warning about the login folder belongs in the run, not in the app's console.
    return parseCursorModels(execFileSync(binary, ['--list-models'], { env, encoding: 'utf8', timeout: LIST_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // A binary that is not installed, or one whose list this version cannot read, leaves the list
    // empty. The run itself still reports what went wrong, and the app stays reachable.
    return [];
  }
}

// Read once and kept. The board reads the model list on every snapshot, and a second of network on
// each one would be a second of the person's page. The key holds the login folder as well as the
// binary, because this list is what that login may run: two Cursor profiles on one machine answer
// with two lists, and one cache under the binary alone would check a run's model against the other
// login's list.
const known = new Map<string, { list: readonly string[]; at: number }>();

// How long an empty answer is kept. Empty is the binary or the login not answering, and both are
// repaired outside the app, so it is not kept until a restart. It is kept for a moment, because a
// line that is down costs the whole timeout above, and without this every board snapshot and every
// page load would pay it again.
const EMPTY_KEEP_MS = 30_000;

export function cursorModels(binary: string, env: Record<string, string | undefined>): readonly string[] {
  const key = `${binary}\u0000${env[CONFIG_VAR] ?? ''}`;
  const cached = known.get(key);
  if (cached !== undefined && (cached.list.length > 0 || Date.now() - cached.at < EMPTY_KEEP_MS)) return cached.list;
  const list = readCursorModels(binary, env);
  known.set(key, { list, at: Date.now() });
  return list;
}
