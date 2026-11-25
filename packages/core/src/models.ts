import { DEFAULT_PROFILE, type Effort, effortInId, ENGINE_NAMES, type EngineName, type EngineProfile, isProfileId } from '@nolzu/protocol';
import { type RunPlace, vendorRefusal, type WallState } from './phase-policy.ts';

export type PresetName = 'light' | 'default' | 'heavy';
// The built-in three, in the order the screens offer them. A saved preset cannot take one of these
// names, so the list is also what the name check measures against.
export const PRESET_NAMES: readonly PresetName[] = ['light', 'default', 'heavy'];

// Every action that makes an AI call. Each has a row in the Models settings and on a card's Settings
// tab.
export const ACTIONS = ['refine', 'plan', 'implement', 'qa', 'wrapup', 'architecture', 'design', 'investigate', 'research', 'pr-review', 'feedback', 'optimize', 'orient', 'learn-repo', 'assess', 'ask', 'extract-summary'] as const;
export type ModelAction = (typeof ACTIONS)[number];

// The phases this vendor cannot run on this machine, by the rule the job builder refuses with. A
// project outside git is a per-project refusal and is left out.
export const refusedPhases = (vendor: string, wall: WallState): ModelAction[] => ACTIONS.filter((action) => vendorRefusal(vendor, action, { outsideGit: false, wall }) !== null);

// The engines that run every phase on this machine: all three where the wall starts, Claude Code and
// Codex where it cannot. Onboarding asks for one of them.
export const everyPhaseEngines = (wall: WallState): EngineName[] => ENGINE_NAMES.filter((vendor) => refusedPhases(vendor, wall).length === 0);

export interface PhaseModel {
  model: string;
  effort: Effort;
}

// One preset under one vendor: what every action runs on.
export type PresetRows = Record<ModelAction, PhaseModel>;

// Refine reads and tidies, so it stays cheap in every preset. Planning is where model strength pays
// back most, which is why even the light preset plans with the middle model. The summary pass only
// rewrites text it is handed, so it runs at low effort in all three. The wrap-up decides what the
// card taught and corrects what was wrong, which is judgement over a few short files, so it sits
// where refine sits and one step above it in the heavy preset. QA runs the project's own checks and
// judges what came back against the brief, which is the same weight as making the change, so it
// sits where implement sits. Optimize rewrites one knowledge file and invents nothing, so it sits
// with the wrap-up in every preset. Learn this project reads what people wrote and keeps a few lines
// of it, so it sits there too. The Scout assessment reads a finding, judges what is behind it
// and writes one short file, inventing nothing, so it sits there too.
//
// The five phases of the other boards follow the same weights. Architecture decides the shape of a
// change before anybody plans it, which is the judgement planning is, so it sits with plan. Design
// draws screens from a decided architecture, investigate reads a log and the code to find what
// caused something, research answers one question out of the project, and a PR review judges
// somebody else's diff. All four are work over real code, which is where implement and QA sit, so
// they sit there too. The three tables below keep that shape per vendor.
//
// Learn your repositories reads one repository's README, CI and stack files and writes how to run it and
// the rules its code keeps.
// It reads more than it judges, and a person runs it once per repository, so it takes the ask row:
// the vendor's small model at low effort in all three presets.
//
// Ask answers a person's question about a card in a read-only session. It reads
// and answers and changes nothing, so it runs on the vendor's small model at low effort in all three
// presets, the way the summary pass keeps one row in all three.
//
// Triage (`feedback`) reads the comments on a card's own pull request and writes one short verdict
// and a drafted reply for each, changing nothing. It reads more than it judges, so it runs on the
// small model at low effort, and on the middle model in the heavy preset, where a reply's tone is
// worth more.
const CLAUDE_CODE: Record<PresetName, PresetRows> = {
  light: {
    refine: { model: 'haiku', effort: 'low' },
    plan: { model: 'sonnet', effort: 'medium' },
    implement: { model: 'sonnet', effort: 'low' },
    qa: { model: 'sonnet', effort: 'low' },
    wrapup: { model: 'haiku', effort: 'low' },
    architecture: { model: 'sonnet', effort: 'medium' },
    design: { model: 'sonnet', effort: 'low' },
    investigate: { model: 'sonnet', effort: 'low' },
    research: { model: 'sonnet', effort: 'low' },
    'pr-review': { model: 'sonnet', effort: 'low' },
    feedback: { model: 'haiku', effort: 'low' },
    optimize: { model: 'haiku', effort: 'low' },
    orient: { model: 'haiku', effort: 'low' },
    'learn-repo': { model: 'haiku', effort: 'low' },
    assess: { model: 'haiku', effort: 'low' },
    ask: { model: 'haiku', effort: 'low' },
    'extract-summary': { model: 'sonnet', effort: 'low' },
  },
  default: {
    refine: { model: 'haiku', effort: 'low' },
    plan: { model: 'sonnet', effort: 'medium' },
    implement: { model: 'sonnet', effort: 'medium' },
    qa: { model: 'sonnet', effort: 'medium' },
    wrapup: { model: 'sonnet', effort: 'low' },
    architecture: { model: 'sonnet', effort: 'medium' },
    design: { model: 'sonnet', effort: 'medium' },
    investigate: { model: 'sonnet', effort: 'medium' },
    research: { model: 'sonnet', effort: 'medium' },
    'pr-review': { model: 'sonnet', effort: 'medium' },
    feedback: { model: 'haiku', effort: 'low' },
    optimize: { model: 'sonnet', effort: 'low' },
    orient: { model: 'sonnet', effort: 'low' },
    'learn-repo': { model: 'haiku', effort: 'low' },
    assess: { model: 'haiku', effort: 'low' },
    ask: { model: 'haiku', effort: 'low' },
    'extract-summary': { model: 'sonnet', effort: 'low' },
  },
  heavy: {
    refine: { model: 'sonnet', effort: 'medium' },
    plan: { model: 'opus', effort: 'high' },
    implement: { model: 'opus', effort: 'high' },
    qa: { model: 'opus', effort: 'high' },
    wrapup: { model: 'sonnet', effort: 'medium' },
    architecture: { model: 'opus', effort: 'high' },
    design: { model: 'opus', effort: 'high' },
    investigate: { model: 'opus', effort: 'high' },
    research: { model: 'opus', effort: 'high' },
    'pr-review': { model: 'opus', effort: 'high' },
    feedback: { model: 'sonnet', effort: 'low' },
    optimize: { model: 'sonnet', effort: 'medium' },
    orient: { model: 'sonnet', effort: 'medium' },
    'learn-repo': { model: 'haiku', effort: 'low' },
    assess: { model: 'sonnet', effort: 'medium' },
    ask: { model: 'haiku', effort: 'low' },
    'extract-summary': { model: 'sonnet', effort: 'low' },
  },
};

// Codex prints five models in its own picker, and the vendor's own description of each one is the
// ladder these rows follow: `gpt-5.6-luna` is the fast and affordable one, `gpt-5.6-terra` the
// balanced one for everyday work, and `gpt-5.6-sol` the frontier one. Read off
// `codex debug models --bundled` on 2026-09-25, which answers offline. All three take low, medium
// and high.
const CODEX: Record<PresetName, PresetRows> = {
  light: {
    refine: { model: 'gpt-5.6-luna', effort: 'low' },
    plan: { model: 'gpt-5.6-terra', effort: 'medium' },
    implement: { model: 'gpt-5.6-terra', effort: 'low' },
    qa: { model: 'gpt-5.6-terra', effort: 'low' },
    wrapup: { model: 'gpt-5.6-luna', effort: 'low' },
    architecture: { model: 'gpt-5.6-terra', effort: 'medium' },
    design: { model: 'gpt-5.6-terra', effort: 'low' },
    investigate: { model: 'gpt-5.6-terra', effort: 'low' },
    research: { model: 'gpt-5.6-terra', effort: 'low' },
    'pr-review': { model: 'gpt-5.6-terra', effort: 'low' },
    feedback: { model: 'gpt-5.6-luna', effort: 'low' },
    optimize: { model: 'gpt-5.6-luna', effort: 'low' },
    orient: { model: 'gpt-5.6-luna', effort: 'low' },
    'learn-repo': { model: 'gpt-5.6-luna', effort: 'low' },
    assess: { model: 'gpt-5.6-luna', effort: 'low' },
    ask: { model: 'gpt-5.6-luna', effort: 'low' },
    'extract-summary': { model: 'gpt-5.6-terra', effort: 'low' },
  },
  default: {
    refine: { model: 'gpt-5.6-luna', effort: 'low' },
    plan: { model: 'gpt-5.6-terra', effort: 'medium' },
    implement: { model: 'gpt-5.6-terra', effort: 'medium' },
    qa: { model: 'gpt-5.6-terra', effort: 'medium' },
    wrapup: { model: 'gpt-5.6-terra', effort: 'low' },
    architecture: { model: 'gpt-5.6-terra', effort: 'medium' },
    design: { model: 'gpt-5.6-terra', effort: 'medium' },
    investigate: { model: 'gpt-5.6-terra', effort: 'medium' },
    research: { model: 'gpt-5.6-terra', effort: 'medium' },
    'pr-review': { model: 'gpt-5.6-terra', effort: 'medium' },
    feedback: { model: 'gpt-5.6-luna', effort: 'low' },
    optimize: { model: 'gpt-5.6-terra', effort: 'low' },
    orient: { model: 'gpt-5.6-terra', effort: 'low' },
    'learn-repo': { model: 'gpt-5.6-luna', effort: 'low' },
    assess: { model: 'gpt-5.6-luna', effort: 'low' },
    ask: { model: 'gpt-5.6-luna', effort: 'low' },
    'extract-summary': { model: 'gpt-5.6-terra', effort: 'low' },
  },
  heavy: {
    refine: { model: 'gpt-5.6-terra', effort: 'medium' },
    plan: { model: 'gpt-5.6-sol', effort: 'high' },
    implement: { model: 'gpt-5.6-sol', effort: 'high' },
    qa: { model: 'gpt-5.6-sol', effort: 'high' },
    wrapup: { model: 'gpt-5.6-terra', effort: 'medium' },
    architecture: { model: 'gpt-5.6-sol', effort: 'high' },
    design: { model: 'gpt-5.6-sol', effort: 'high' },
    investigate: { model: 'gpt-5.6-sol', effort: 'high' },
    research: { model: 'gpt-5.6-sol', effort: 'high' },
    'pr-review': { model: 'gpt-5.6-sol', effort: 'high' },
    feedback: { model: 'gpt-5.6-terra', effort: 'low' },
    optimize: { model: 'gpt-5.6-terra', effort: 'medium' },
    orient: { model: 'gpt-5.6-terra', effort: 'medium' },
    'learn-repo': { model: 'gpt-5.6-luna', effort: 'low' },
    assess: { model: 'gpt-5.6-terra', effort: 'medium' },
    ask: { model: 'gpt-5.6-luna', effort: 'low' },
    'extract-summary': { model: 'gpt-5.6-terra', effort: 'low' },
  },
};

// Cursor carries the effort inside the model id and its adapter never reads the effort field, so
// its presets move the model instead. The three ids come off `cursor-agent --list-models` on
// 2026-09-25: `composer-2.5` is the vendor's own fast one, `gpt-5.3-codex` the stronger coding
// model, and `claude-opus-5-5-high` a frontier one the list carries. The effort is stored all the
// same, because one row shape serves every vendor and the screens draw it.
const CURSOR: Record<PresetName, PresetRows> = {
  light: {
    refine: { model: 'composer-2.5', effort: 'low' },
    plan: { model: 'gpt-5.3-codex', effort: 'medium' },
    implement: { model: 'gpt-5.3-codex', effort: 'low' },
    qa: { model: 'gpt-5.3-codex', effort: 'low' },
    wrapup: { model: 'composer-2.5', effort: 'low' },
    architecture: { model: 'gpt-5.3-codex', effort: 'medium' },
    design: { model: 'gpt-5.3-codex', effort: 'low' },
    investigate: { model: 'gpt-5.3-codex', effort: 'low' },
    research: { model: 'gpt-5.3-codex', effort: 'low' },
    'pr-review': { model: 'gpt-5.3-codex', effort: 'low' },
    feedback: { model: 'composer-2.5', effort: 'low' },
    optimize: { model: 'composer-2.5', effort: 'low' },
    orient: { model: 'composer-2.5', effort: 'low' },
    'learn-repo': { model: 'composer-2.5', effort: 'low' },
    assess: { model: 'composer-2.5', effort: 'low' },
    ask: { model: 'composer-2.5', effort: 'low' },
    'extract-summary': { model: 'gpt-5.3-codex', effort: 'low' },
  },
  default: {
    refine: { model: 'composer-2.5', effort: 'low' },
    plan: { model: 'gpt-5.3-codex', effort: 'medium' },
    implement: { model: 'gpt-5.3-codex', effort: 'medium' },
    qa: { model: 'gpt-5.3-codex', effort: 'medium' },
    wrapup: { model: 'gpt-5.3-codex', effort: 'low' },
    architecture: { model: 'gpt-5.3-codex', effort: 'medium' },
    design: { model: 'gpt-5.3-codex', effort: 'medium' },
    investigate: { model: 'gpt-5.3-codex', effort: 'medium' },
    research: { model: 'gpt-5.3-codex', effort: 'medium' },
    'pr-review': { model: 'gpt-5.3-codex', effort: 'medium' },
    feedback: { model: 'composer-2.5', effort: 'low' },
    optimize: { model: 'gpt-5.3-codex', effort: 'low' },
    orient: { model: 'gpt-5.3-codex', effort: 'low' },
    'learn-repo': { model: 'composer-2.5', effort: 'low' },
    assess: { model: 'composer-2.5', effort: 'low' },
    ask: { model: 'composer-2.5', effort: 'low' },
    'extract-summary': { model: 'gpt-5.3-codex', effort: 'low' },
  },
  heavy: {
    refine: { model: 'gpt-5.3-codex', effort: 'medium' },
    plan: { model: 'claude-opus-5-5-high', effort: 'high' },
    implement: { model: 'claude-opus-5-5-high', effort: 'high' },
    qa: { model: 'claude-opus-5-5-high', effort: 'high' },
    wrapup: { model: 'gpt-5.3-codex', effort: 'medium' },
    architecture: { model: 'claude-opus-5-5-high', effort: 'high' },
    design: { model: 'claude-opus-5-5-high', effort: 'high' },
    investigate: { model: 'claude-opus-5-5-high', effort: 'high' },
    research: { model: 'claude-opus-5-5-high', effort: 'high' },
    'pr-review': { model: 'claude-opus-5-5-high', effort: 'high' },
    feedback: { model: 'gpt-5.3-codex', effort: 'low' },
    optimize: { model: 'gpt-5.3-codex', effort: 'medium' },
    orient: { model: 'gpt-5.3-codex', effort: 'medium' },
    'learn-repo': { model: 'composer-2.5', effort: 'low' },
    assess: { model: 'gpt-5.3-codex', effort: 'medium' },
    ask: { model: 'composer-2.5', effort: 'low' },
    'extract-summary': { model: 'gpt-5.3-codex', effort: 'low' },
  },
};

/**
 * The rows each vendor ships for the three built-in presets.
 *
 * Per vendor, because a model name means nothing under another one. A row moved to a Codex login
 * with no model of its own used to fall through to a Claude alias, read as gone, and refuse the
 * drop until somebody picked a model by hand.
 *
 * A built-in preset names no engine profile. It answers under the profile each row already has,
 * which is how it keeps the rule that a built-in preset never carries somebody's second login onto
 * a machine where that login is not configured.
 */
const PRESETS: Readonly<Partial<Record<EngineName, Record<PresetName, PresetRows>>>> = {
  'claude-code': CLAUDE_CODE,
  codex: CODEX,
  cursor: CURSOR,
};

// In protocol, because the board names a start with it too.
export { effortInId };

// The built-in rows one vendor ships for one preset.
export function presetRows(preset: PresetName, vendor: EngineName | undefined): PresetRows {
  return ((vendor === undefined ? undefined : PRESETS[vendor]) ?? CLAUDE_CODE)[preset];
}

/**
 * The models a preset model gives way to when the vendor's list on this machine lacks it, strongest
 * first. The first pattern the list holds wins, and `*` stands for any part of an id, so a newer
 * version of the same family counts; among several matches the highest version wins.
 *
 * Accounts differ: a Cursor account can have a frontier model turned off.
 * The same family comes first, then a model of the same tier, then the preset's next step down.
 * Claude Code is not here, because its list is kept by hand and holds every alias the presets name.
 */
const STAND_INS: Readonly<Partial<Record<EngineName, Readonly<Record<string, readonly string[]>>>>> = {
  codex: {
    'gpt-5.6-sol': ['gpt-*-sol', 'gpt-5.6-terra'],
    'gpt-5.6-terra': ['gpt-*-terra', 'gpt-5.6-luna'],
    'gpt-5.6-luna': ['gpt-*-luna'],
  },
  cursor: {
    'claude-opus-5-5-high': ['claude-opus-*-high', 'claude-opus-*', 'gpt-*-codex-high', 'gemini-*-pro', 'gpt-5.3-codex'],
    'gpt-5.3-codex': ['gpt-*-codex', 'composer-2.5'],
    'composer-2.5': ['composer-*'],
  },
};

const glob = (pattern: string): RegExp => new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
const newestFirst = (a: string, b: string): number => b.localeCompare(a, 'en', { numeric: true });

// The model a preset row gives way to on this account, or null when the list holds the preset's own
// model, when nothing here knows the list, or when no model of the ranking is on it.
export function presetStandIn(vendor: EngineName | undefined, model: string, known: readonly string[] | undefined): string | null {
  if (vendor === undefined || known === undefined || known.includes(model)) return null;
  for (const pattern of STAND_INS[vendor]?.[model] ?? []) {
    const found = known.filter((one) => glob(pattern).test(one)).sort(newestFirst)[0];
    if (found !== undefined) return found;
  }
  return null;
}

// Every model the three built-in presets of one vendor name, each one once. Read by the fake engine
// and by the test that measures these rows against what a vendor's own command prints.
export function presetModels(vendor: EngineName): readonly string[] {
  return [...new Set(PRESET_NAMES.flatMap((preset) => ACTIONS.map((action) => presetRows(preset, vendor)[action].model)))];
}

// What one built-in preset row costs and takes, for a project with no history of its own yet.
export interface PresetRange {
  // Null for an engine that reports no cost.
  costUsd: number | null;
  lowMs: number;
  highMs: number;
}

// One refine run on haiku at low effort, through Nolzu's own start path on Claude Code 2.1.278 on
// 2026-09-21, as docs/engines/claude-code.md records it: $0.048 in 21 seconds. The seconds are what
// the run reported, and the worktree was made before it, so they leave out the worktree time that
// history counts. The run before it is left out: it had no way to open the refine skill, so it did
// not run refine the way a start does today.
const REFINE_HAIKU_LOW: PresetRange = { costUsd: 0.048, lowMs: 21_000, highMs: 21_000 };

// Measured rows only. A screen never shows a number nobody measured, so a row with no real runs
// behind it has no range and shows no estimate until the project has runs of its own.
const RANGES: Readonly<Partial<Record<EngineName, Partial<Record<PresetName, Partial<Record<ModelAction, PresetRange>>>>>>> = {
  'claude-code': {
    light: { refine: REFINE_HAIKU_LOW },
    default: { refine: REFINE_HAIKU_LOW },
  },
};

/**
 * The measured range of the built-in preset row this start matches, or null.
 *
 * Matched on the vendor's own rows and not on `presetRows`, which answers an unknown vendor with the
 * Claude Code rows. A card or a project that picks exactly what a preset row runs gets that row's
 * range, because it is the same run. Any other pick has no honest number.
 */
export function presetRange(vendor: EngineName | undefined, action: ModelAction, model: string, effort: Effort): PresetRange | null {
  if (vendor === undefined) return null;
  for (const preset of PRESET_NAMES) {
    const row = PRESETS[vendor]?.[preset][action];
    const range = RANGES[vendor]?.[preset]?.[action];
    if (range !== undefined && row?.model === model && row.effort === effort) return range;
  }
  return null;
}

export const isAction = (value: string): value is ModelAction => (ACTIONS as readonly string[]).includes(value);

/**
 * A stored table with the Design row under its old name, `mockups`, read under the new one.
 *
 * A project, a saved preset or a card may hold a row from before the rename. Left as it was, the
 * table fails `validateModelTable` and reads as nothing stored, which drops every row of it. A table
 * that has both keeps the new one. Anything that is not a table goes back as it came.
 */
export function renamedActions(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Object.hasOwn(value, 'mockups')) return value;
  const { mockups, ...rest } = value as Record<string, unknown>;
  return Object.hasOwn(rest, 'design') ? rest : { ...rest, design: mockups };
}

// The half of the sentence every screen says about a model the engine stopped offering, so the board,
// the card tab and the settings screen cannot drift apart on it. Each adds what to do next.
export const goneText = (model: string): string => `${model} is gone.`;

// What a card or the project stores for one action. A missing field inherits from the level above.
export interface ActionModel {
  engine?: string;
  model?: string;
  effort?: Effort;
}

export type ModelTable = Partial<Record<ModelAction, ActionModel>>;

// The profile an action with no engine of its own falls back to when nothing else says. A stored id
// this machine has no profile for is kept and marked, never dropped.
export const ENGINE = DEFAULT_PROFILE.id;
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

/**
 * The profiles with the main login of the project's preset engine first.
 *
 * `resolveModels` gives every row with no engine of its own to the first profile, so this is how
 * "Heavy on Cursor" reaches every run. The main login is the one under the bare vendor id, else the
 * first one of that vendor: a built-in preset never runs on a second login,
 * which a phase change or a saved preset still reaches. Null, or an engine with no login here, keeps
 * the stored order.
 */
export function presetProfiles(profiles: readonly EngineProfile[], engine: EngineName | null): readonly EngineProfile[] {
  const main = engine === null ? undefined : (profiles.find((one) => one.id === engine) ?? profiles.find((one) => one.vendor === engine));
  return main === undefined || main === profiles[0] ? profiles : [main, ...profiles.filter((one) => one !== main)];
}

export type ModelLevel = 'card' | 'global' | 'preset';

// The models each vendor offers today, by vendor name. A vendor with no adapter in this version is
// not a key here, and a row of that vendor is never called gone: nothing can say what it offers.
export type ModelsByVendor = Readonly<Record<string, readonly string[]>>;

export interface ResolvedModel {
  engine: string;
  model: string;
  effort: Effort;
  // Where each value came from, so the tab can say whether it is the card's own or inherited.
  from: { model: ModelLevel; effort: ModelLevel };
  // The engine no longer offers the stored model. It is kept and said, never silently replaced.
  gone: boolean;
  // The preset's own model when the account lacks it and Nolzu picked `model` in its place. Only a
  // row that follows the preset gets one: a person's own pick is never swapped.
  insteadOf?: string;
  // This machine has no profile under the stored id, so nothing can run the row. A person who
  // removed a login they still point a card at is the normal way to reach it.
  missingProfile: boolean;
  // Why the vendor of this row's profile cannot run this phase, or null when it can. The same rule
  // the spawn enforces, asked here so a screen and a drop target say what the run would say.
  refusal: string | null;
}

export type ResolvedTable = Record<ModelAction, ResolvedModel>;

/**
 * Card over global over preset, field by field.
 *
 * `profiles` is every login this machine holds, and the first one is what an action with no
 * engine of its own inherits. It has no default on purpose: a default let three screens resolve
 * against one profile while the job builder resolved against the stored list, and they would have
 * disagreed the moment a second profile existed.
 *
 * `models` is what each vendor offers today. `gone` is asked of a row against the list of the
 * vendor its own profile runs, because a model name means nothing under another vendor. A vendor
 * with no list is left alone: nothing here can tell whether its model is real.
 *
 * `onProfile` pins the whole table to one profile, which is what a resume does: the session lives
 * inside that login, so the model has to be one that login can run. A stored row of another
 * profile is skipped and the level below it answers instead, because that row's model belongs to
 * another vendor. Null resolves the table as the action list stores it.
 *
 * `place` says whether the project folder is a git repository and whether the wall starts on this
 * machine, so `refusal` names the engines that cannot run there and a drop or a row says so before
 * the click. Left out, no refusal is worked out, for a caller that shows none.
 */
export function resolveModels(
  card: ModelTable | null,
  global: ModelTable,
  preset: PresetName,
  models: ModelsByVendor,
  profiles: readonly EngineProfile[],
  onProfile: string | null = null,
  place?: RunPlace,
): ResolvedTable {
  const table = {} as ResolvedTable;
  const fallback = profiles[0]?.id ?? ENGINE;
  // A row with no engine of its own was chosen under the profile every row falls back to.
  const pinned = (row: ActionModel | undefined): ActionModel =>
    onProfile === null || (row?.engine ?? fallback) === onProfile ? (row ?? {}) : {};
  for (const action of ACTIONS) {
    const own = pinned(card?.[action]);
    const project = pinned(global[action]);
    const engine = onProfile ?? own.engine ?? project.engine ?? fallback;
    const profile = profiles.find((one) => one.id === engine);
    const known = profile === undefined ? undefined : models[profile.vendor];
    // The built-in rows of the vendor this row runs on, so a row with nothing of its own falls
    // through to a model that vendor offers and not to another vendor's name.
    const base = presetRows(preset, profile?.vendor)[action];
    const standIn = presetStandIn(profile?.vendor, base.model, known);
    const model = own.model ?? project.model ?? standIn ?? base.model;
    // An engine that reads the effort off the model id runs the same thing whatever the field says,
    // so a stored effort there is ignored. Kept, it marked a phase changed that showed the preset's
    // engine and model, with no effort select to put it back.
    const inId = effortInId(profile?.vendor);
    table[action] = {
      engine,
      model,
      effort: inId ? base.effort : (own.effort ?? project.effort ?? base.effort),
      from: {
        model: own.model !== undefined ? 'card' : project.model !== undefined ? 'global' : 'preset',
        effort: !inId && own.effort !== undefined ? 'card' : !inId && project.effort !== undefined ? 'global' : 'preset',
      },
      gone: known !== undefined && !known.includes(model),
      ...(standIn !== null && own.model === undefined && project.model === undefined ? { insteadOf: base.model } : {}),
      missingProfile: profile === undefined,
      // Null when there is no profile: nothing knows the vendor then, and the missing login is the
      // problem to name rather than a rule about a vendor nobody can see.
      refusal: profile === undefined || place === undefined ? null : vendorRefusal(profile.vendor, action, place),
    };
  }
  return table;
}

/**
 * The profiles a row may be set to: the ones whose vendor this version has an adapter for.
 *
 * A profile of a vendor Nolzu cannot spawn would take the row and then refuse every run of it, so
 * it is not offered. The profile stays on the Engines screen, where a person keeps their logins.
 */
export function profileChoices(
  profiles: readonly EngineProfile[],
  models: ModelsByVendor,
): { id: string; label: string }[] {
  return profiles.filter((one) => models[one.vendor] !== undefined).map((one) => ({ id: one.id, label: one.label }));
}

export const NO_MODELS_REASON = 'No models answered. Settings, Engines shows whether its command is installed and signed in.';

/**
 * Every profile for the combined picker, each with its models, and a reason on one that has none.
 *
 * A profile whose vendor answered no models (a command not installed, a lapsed login, terms not
 * accepted) cannot take a row. Left out, it vanished from the picker with no word, so it stays in,
 * closed, with the reason.
 */
export function pickerProfiles(
  profiles: readonly EngineProfile[],
  models: ModelsByVendor,
): { id: string; label: string; models: readonly string[]; reason?: string }[] {
  return profiles.map((one) => {
    const list = models[one.vendor] ?? [];
    return list.length > 0 ? { id: one.id, label: one.label, models: list } : { id: one.id, label: one.label, models: [], reason: NO_MODELS_REASON };
  });
}

/**
 * The models one profile offers, which are the ones of its vendor.
 *
 * Empty for a profile this machine does not hold and for a vendor this version cannot run. A
 * screen then offers no model for that row, which is the truth: nothing here knows what that CLI
 * takes.
 */
export function modelsOfProfile(
  profile: string,
  profiles: readonly EngineProfile[],
  models: ModelsByVendor,
): readonly string[] {
  const vendor = profiles.find((one) => one.id === profile)?.vendor;
  return (vendor === undefined ? undefined : models[vendor]) ?? [];
}

// The models a row's picker offers, which are the ones of the profile the pick lands on.
export function modelsForPick(
  resolved: ResolvedModel,
  profiles: readonly EngineProfile[],
  models: ModelsByVendor,
): readonly string[] {
  return modelsOfProfile(profileForPick(resolved, profiles), profiles, models);
}

/**
 * The profile a row should carry after a person picks a model for it.
 *
 * A model name belongs to a profile, so the pick has to write one. The row keeps the profile it
 * already resolves to when this machine holds it. When it does not, the pick is what repairs the
 * row, so it moves to the first profile: writing the missing id back would leave the row refused
 * the moment the person thought they had fixed it.
 */
export function profileForPick(resolved: ResolvedModel, profiles: readonly EngineProfile[]): string {
  return resolved.missingProfile ? (profiles[0]?.id ?? ENGINE) : resolved.engine;
}

// What a card stores for the values chosen: only the fields that differ from what it would inherit, so a
// later change to the preset or the project still reaches every field the card left alone. A stored
// model always carries its engine, because a model name means nothing under another engine. Null when
// nothing differs, never an empty object.
export function diffModels(chosen: ModelTable, inherited: ResolvedTable): ModelTable | null {
  const table: ModelTable = {};
  for (const action of ACTIONS) {
    const want = chosen[action];
    if (want === undefined) continue;
    // A row another engine wrote is kept as it is. Its model means nothing under this engine, so it
    // cannot be measured against the preset, and dropping it would change what the row runs without
    // a word. The screens say how to repair it.
    const base = inherited[action];
    if (want.engine !== undefined && want.engine !== base.engine) {
      table[action] = want;
      continue;
    }
    const row: ActionModel = {};
    if (want.model !== undefined && want.model !== base.model) row.model = want.model;
    if (want.effort !== undefined && want.effort !== base.effort) row.effort = want.effort;
    if (Object.keys(row).length > 0) table[action] = { engine: want.engine ?? base.engine, ...row };
  }
  return Object.keys(table).length === 0 ? null : table;
}

// One action table the person saved under a name.
export interface SavedPreset {
  name: string;
  models: ModelTable;
}

const MAX_NAME = 40;

/**
 * The sentence that refuses a preset name, or null when it is fine.
 *
 * `taken` holds the names in use, and the caller puts the built-in three in it: two presets called
 * Default would draw two buttons a person cannot tell apart. A name with a slash in it is refused
 * because it reads as a folder, and a preset is not a file.
 */
export function presetNameProblem(name: string, taken: readonly string[]): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'A preset needs a name.';
  if (trimmed.length > MAX_NAME) return `A preset name is ${MAX_NAME} characters or less.`;
  if (/[/\\]/.test(trimmed)) return 'A preset name cannot hold a slash.';
  // Lowercased, because the screen draws the built-in three with a capital and two buttons reading
  // Default are two a person cannot tell apart.
  if (taken.some((one) => one.trim().toLowerCase() === trimmed.toLowerCase())) return `There is already a preset called ${trimmed}.`;
  return null;
}

// The sentence that refuses a table, or null when it is fine. Shared by the global setting and the card
// route, so both refuse the same things in the same words. Any engine profile id passes: a row of a
// profile this machine no longer holds is kept and marked, never dropped.
export function validateModelTable(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'The models are a table of actions.';
  for (const [action, row] of Object.entries(value)) {
    if (!isAction(action)) return `There is no action ${action}. The actions are ${ACTIONS.join(', ')}.`;
    if (typeof row !== 'object' || row === null) return `The ${action} row is not a model, an effort and an engine.`;
    const { engine, model, effort } = row as Record<string, unknown>;
    if (engine !== undefined && (typeof engine !== 'string' || !isProfileId(engine))) return `The engine for ${action} is ${String(engine)}, which is not an engine profile id. One looks like ${ENGINE} or codex#work.`;
    if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) return `The model for ${action} is not a model name.`;
    if (effort !== undefined && !(EFFORTS as readonly unknown[]).includes(effort)) return `The effort for ${action} is one of ${EFFORTS.join(', ')}.`;
  }
  return null;
}
