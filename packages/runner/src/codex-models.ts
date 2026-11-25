import { execFileSync } from 'node:child_process';

// One model the binary carries, with the effort levels that model takes. The levels differ per
// model, which is why the effort cannot be three fixed words for this engine.
export interface CodexModel {
  slug: string;
  levels: readonly string[];
  // The vendor does not offer it in its own picker. Such a model still runs, so it keeps its
  // levels, but Nolzu does not put it in a list for somebody to choose from.
  hidden: boolean;
}

interface ListedModel {
  slug?: string;
  supported_reasoning_levels?: { effort?: string }[];
  visibility?: string;
}

// `codex debug models --bundled` prints the list the binary itself carries. It answers offline and
// with a dead login, so the models come from the binary and are never kept by hand here.
export function parseCodexModels(json: string): CodexModel[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error('The Codex model list is not JSON. Run `codex debug models --bundled` to see what the binary printed.');
  }
  const listed = (value as { models?: unknown }).models;
  if (!Array.isArray(listed)) {
    throw new Error('The Codex model list has no models in it. Run `codex debug models --bundled` to see what the binary printed.');
  }
  return listed.flatMap((one: ListedModel) => {
    const slug = one.slug;
    if (typeof slug !== 'string' || slug === '') return [];
    const levels = (one.supported_reasoning_levels ?? []).flatMap((level) => (typeof level.effort === 'string' ? [level.effort] : []));
    return [{ slug, levels, hidden: one.visibility === 'hide' }];
  });
}

// Read once per binary and kept. The board reads the model list on every snapshot, and a run of
// the binary for each one would cost a tenth of a second of the person's page. A new version of
// the binary is picked up when the app restarts, which is what installing one does anyway.
const known = new Map<string, readonly CodexModel[]>();

// How long the model list may take. An installed binary answers in a tenth of a second; a test's stub
// written a moment before can take longer on a busy machine, so a test passes its own.
export const MODEL_LIST_TIMEOUT_MS = 5000;

export function readCodexModels(binary: string, env: Record<string, string | undefined>, timeoutMs = MODEL_LIST_TIMEOUT_MS): readonly CodexModel[] {
  try {
    // stderr is dropped. The binary warns about its own config folder on a machine where that
    // folder is a temporary one, and the app's console is not the place for it.
    return parseCodexModels(execFileSync(binary, ['debug', 'models', '--bundled'], { env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    // A binary that is not installed, or one whose list this version cannot read, leaves the list
    // empty. The run itself still reports what went wrong, and the app stays reachable.
    return [];
  }
}

export function codexModelList(binary: string, env: Record<string, string | undefined>, timeoutMs = MODEL_LIST_TIMEOUT_MS): readonly CodexModel[] {
  const cached = known.get(binary);
  if (cached !== undefined) return cached;
  const list = readCodexModels(binary, env, timeoutMs);
  // An empty list is the binary not answering, which installing it repairs. Keeping that answer
  // would leave the app saying Codex is missing until somebody restarts it. Asking again is cheap:
  // a binary that is not there answers in 0.2 milliseconds, measured on 2026-09-25. The ceiling is
  // a binary that hangs instead of failing. That one costs the 5 second timeout on every board
  // snapshot, and no run has seen one. Give the empty answer a short expiry if one turns up.
  if (list.length > 0) known.set(binary, list);
  return list;
}

// The models a person may pick, which are the ones the vendor lists. A hidden model still runs when
// a row names it, which is why the levels are read off the whole list and only the picker is cut
// down.
export function codexModels(binary: string, env: Record<string, string | undefined>, timeoutMs = MODEL_LIST_TIMEOUT_MS): readonly string[] {
  return codexModelList(binary, env, timeoutMs)
    .filter((model) => !model.hidden)
    .map((model) => model.slug);
}
