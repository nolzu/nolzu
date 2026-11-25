import type { RateLimitWindow } from './run.ts';

// The vendor CLIs this product knows. It lives here rather than in the runner because core reads
// it to resolve an action table, the runner reads it to spawn, and the UI reads it to draw the
// Engines screen, and protocol is the one package all three may import.
export const ENGINE_NAMES = ['claude-code', 'cursor', 'codex'] as const;

export type EngineName = (typeof ENGINE_NAMES)[number];

// The name each vendor is called by on screen. It sits with the names, because the Engines screen
// draws two lists over them and the two must call a vendor the same thing.
export const ENGINE_LABELS: Readonly<Record<EngineName, string>> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
};

// The wall that held a run, as `runs.wall` stores it: Nolzu's own on macOS or Linux, the Codex
// sandbox where Nolzu's cannot start, or none. Null on a row made before the column.
export const WALL_KINDS = ['macos', 'bubblewrap', 'codex', 'none'] as const;

export type WallKind = (typeof WALL_KINDS)[number];

const WALL_LABELS: Readonly<Record<WallKind, string>> = {
  macos: 'walled by macOS',
  bubblewrap: 'walled by bubblewrap',
  codex: 'Codex sandbox',
  none: 'not walled',
};

// The words beside the engine on the card History row and the run log. An old row says nothing.
export const wallLabel = (kind: string | null | undefined): string | null =>
  kind != null && Object.hasOwn(WALL_LABELS, kind) ? WALL_LABELS[kind as WallKind] : null;

export const isEngineName = (value: string): value is EngineName =>
  (ENGINE_NAMES as readonly string[]).includes(value);

// The vendor of a profile id is the part before `#`. An id this version has no vendor for is named as
// it is, rather than as some other vendor.
export function engineName(profile: string): string {
  const vendor = profile.split('#')[0] ?? profile;
  return isEngineName(vendor) ? ENGINE_LABELS[vendor] : profile;
}

// The words for a step whose model its engine stopped offering, said the same by the board's refused
// drop, the card's Settings tab and Settings, Models. Here and not in the UI,
// because the server words the Settings, Models row with it.
export const goneSentence = (step: string, model: string, profile: string): string => `${step} uses ${model}, which ${engineName(profile)} no longer offers.`;
// The same with what to do, for a row that holds the pick.
export const goneProblem = (step: string, model: string, profile: string): string => `${goneSentence(step, model, profile)} ${step} will not start until you pick another.`;

// A profile by its vendor's name and the part of its id after `#`: "Claude Code (work)". The first
// profile of a vendor holds the bare id and reads as the vendor alone. Here and not in the UI, because
// the server words the near-limit notification with it too.
export function profileName(profile: string): string {
  const [vendor = profile, own] = profile.split('#');
  if (!isEngineName(vendor)) return profile;
  return own === undefined ? ENGINE_LABELS[vendor] : `${ENGINE_LABELS[vendor]} (${own})`;
}

// Cursor carries the effort inside the model id and its adapter never reads the
// effort field, so a screen offers no effort beside them and a stored one changes nothing.
export const effortInId = (vendor: string | undefined): boolean => vendor === 'cursor';

// The same rule by profile id. A line that names a model leaves the effort out on such an engine, so the
// board never shows "medium" beside a Cursor model where Settings says the effort is in the name.
export const effortInModel = (engine: string | null | undefined): boolean => engine != null && effortInId(engine.split('#')[0]);

// "Claude Code · sonnet · high": what a run ran on, with each part it has not got left out. Every
// screen that shows a run's model goes through it, so the engine is never missing beside a model.
export const ranOn = (engine: string | null | undefined, model: string | null | undefined, effort: string | null | undefined): string =>
  [engine == null || engine === '' ? null : engineName(engine), model, effortInModel(engine) ? null : effort].filter((part) => part != null && part !== '').join(' · ');

/**
 * The environment variable each vendor reads for a second configuration folder.
 *
 * Nolzu sets the variable per process and never opens the folder. The person runs the vendor's own
 * login command inside it.
 *
 * Read off each vendor's documentation on 2026-09-20 and recorded in `docs/engines/`. A name that a
 * real run proves wrong changes here.
 */
export const CONFIG_DIR_VAR: Readonly<Record<EngineName, string>> = {
  'claude-code': 'CLAUDE_CONFIG_DIR',
  cursor: 'CURSOR_CONFIG_DIR',
  codex: 'CODEX_HOME',
};

/**
 * One login of one vendor CLI on this machine.
 *
 * A person with a work account and a personal account has two profiles of the same vendor. The id
 * is made from the label once, when the profile is created, and never again: a rename changes the
 * label alone, so no card and no action table row breaks.
 */
export interface EngineProfile {
  id: string;
  // What the person typed. Nolzu shows no fixed labels.
  label: string;
  vendor: EngineName;
  // The folder the vendor's own variable points at, or null for the vendor's default place.
  configDir: string | null;
}

// The profile every installation starts with. Claude Code with the vendor's own config folder.
export const DEFAULT_PROFILE: EngineProfile = {
  id: 'claude-code',
  label: 'Claude Code',
  vendor: 'claude-code',
  configDir: null,
};

const MAX_ID = 64;

// What a profile id may look like: a vendor, on its own or followed by `#` and the slug of the
// label. `profileId` makes them, and this refuses one a hand edited database carries.
const ID_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*(#[a-z0-9]+(-[a-z0-9]+)*)?$/;

export const isProfileId = (value: string): boolean => value.length <= MAX_ID && ID_SHAPE.test(value);

/**
 * The id for a new profile, made from its label and never changed after.
 *
 * The form is the vendor, then the label,
 * as in `codex#work`. The vendor is part of it so the id says which CLI it runs without a lookup,
 * and so two profiles of different vendors labelled "Work" cannot read as two of the same one.
 *
 * A label of punctuation alone, or of a script with no ASCII letters, leaves nothing to slug, and
 * the bare vendor is the id instead, which is what the first profile of a vendor gets. A base
 * already taken gets a number, because two profiles under one id would share every stored choice
 * in silence.
 */
export function profileId(label: string, vendor: EngineName, taken: readonly string[]): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // The vendor and the separator come off the budget first, so the whole id fits.
  const room = MAX_ID - vendor.length - 1;
  const cut = slug.slice(0, Math.max(room, 0)).replace(/-+$/, '');
  const base = cut === '' ? vendor : `${vendor}#${cut}`;
  if (!taken.includes(base)) return base;
  // From 2, because the first one holds the bare name. Every step tries a longer name, so the
  // loop ends, and the suffix fits because the base was cut short enough to leave room for it.
  const trimmed = base.length > MAX_ID - 4 ? base.slice(0, MAX_ID - 4).replace(/[-#]+$/, '') : base;
  for (let n = 2; ; n += 1) {
    const next = `${trimmed}-${n}`;
    if (!taken.includes(next)) return next;
  }
}

// The sentence every screen says about a row pointing at a profile this machine has no login for.
// It lives here and not in core because `packages/ui` may import only this package, and the card
// tab, the Models screen and the board all have to say the same thing. It names the cause and not
// the cure: a card row goes back to inherit, and a project row takes another model.
export const missingProfileText = (profile: string): string =>
  `The engine profile ${profile} has no login on this machine.`;

/**
 * Whether a vendor's CLI says anything about a usage window, and the sentence that says why.
 *
 * Measured on 2026-09-25 and written down per engine in `docs/engines/`. Claude Code is
 * the one engine with real numbers. Cursor prints nothing about a window, which is a normal state
 * and not a gap, so its block reads "not available". Codex reports no window in a normal turn and
 * no usage limit has been seen yet, so nothing is known.
 *
 * `knownSilent` is the measured answer to one question: has this engine been seen to say nothing at
 * all about a usage window? Only that is "not available". The rest sit at "unknown" until a run
 * reports a window, which keeps an engine that stays quiet apart from one that has had nothing to
 * say yet. A new engine has to answer the question with a measurement.
 */
export const LIMIT_SIGNAL: Readonly<Record<EngineName, { knownSilent: boolean; note: string }>> = {
  'claude-code': {
    knownSilent: false,
    note: 'Claude Code reports the 5-hour and the weekly window when a run makes a model call on a subscription login. A run in API-key mode reports none.',
  },
  cursor: { knownSilent: true, note: 'Cursor reports no usage window in its output, so there is nothing to read. This is a normal state and not a gap.' },
  codex: { knownSilent: false, note: 'Codex reports no window in a normal turn, and no Codex usage limit has been seen yet, so nothing is known.' },
};

/**
 * What Nolzu last saw of one profile's usage windows.
 *
 * It stays on this machine. Limit state stays off the wire in every tier, so nothing sends this
 * anywhere. The number is the last one seen and never a live one, which is why the time
 * it was seen is stored with it.
 */
export interface ProfileLimit {
  // Unix milliseconds, from the moment the run read the engine's line.
  seenAt: number;
  windows: readonly RateLimitWindow[];
  // The card whose run read the line, for the near-limit toast's "seen on APP-1". Absent on a reading
  // stored before it, and on a run that belongs to no card.
  card?: string;
}
