import type { DatabaseSync } from 'node:sqlite';
import { type Effort, ENGINE_LABELS, ENGINE_NAMES, engineName, type EngineName, type EngineProfile, type Estimate, goneProblem, isEngineName, missingProfileText, phaseLabel, presetLabel } from '@nolzu/protocol';
import {
  ACTIONS,
  type ActionModel,
  boardFor,
  diffModels,
  EFFORTS,
  effortInId,
  goneText,
  isAction,
  type ModelAction,
  type ModelsByVendor,
  modelsForPick,
  modelsOfProfile,
  pickerProfiles,
  type ModelTable,
  presetRows,
  presetStandIn,
  PRESET_NAMES,
  presetNameProblem,
  type PresetName,
  presetProfiles,
  profileChoices,
  type ResolvedModel,
  type ResolvedTable,
  profileForPick,
  resolveModels,
  type SavedPreset,
  type WallState,
} from '@nolzu/core';
import { getSetting, projectOutsideGit, projectProfiles, renameCardPresets, cardEstimate, startEstimate, writeSetting } from '@nolzu/core/node';
import { wallHere } from '@nolzu/runner';

// The names a saved preset cannot take: each built-in by its stored id and by the title the screen
// draws, so no saved card reads Balanced beside the built-in one.
const BUILT_IN_NAMES = PRESET_NAMES.flatMap((name) => [name, presetLabel(name)]);

export interface ProjectModelRow {
  action: ModelAction;
  // What the project stores for this action, if anything.
  own: ActionModel;
  resolved: ResolvedModel;
  // What the chosen preset gives this phase, which Reset and Discard put back.
  base: ResolvedModel;
  // On a built-in preset: the person changed this phase, and it is kept as theirs. On a saved one:
  // the phase runs something other than the saved preset gives it.
  changed: boolean;
  // The line under a phase that follows a built-in preset whose model this account lacks: "Nolzu
  // picked gpt-5.3-codex: claude-opus-5-5-high is not on this account". Null otherwise.
  picked: string | null;
  // The preset's row in words, "Cursor · claude-opus-5-5-high", for the line under a changed phase.
  baseText: string;
  // The models this row may take, which are the ones of the profile it names. A model name means
  // nothing under another vendor, so the list follows the row and not the screen.
  models: readonly string[];
  // What the row takes when its engine select moves to a profile: the chosen preset's model and
  // effort for this phase on that engine, by profile id. Its first model would turn opus into haiku.
  presetPicks: Record<string, { model: string; effort: string }>;
  // The one thing wrong with this row, or null when nothing is. Built here rather than in the
  // screen, because three branches of markup are three sentences no test can reach.
  warning: string | null;
}

// One choice in the engine and preset table: a built-in preset on the engine of its row.
export interface PresetCell {
  // light, default or heavy.
  name: string;
  // The preset the project chose, on this engine.
  active: boolean;
  // On an engine that answered its models: what Implement runs, "sonnet · medium". The
  // three presets differ most there, so a cell says what a click picks before any cost is measured
  //. Light and Balanced share their models and differ in effort.
  uses?: string;
  // What a Delivery card cost on these rows, only from this project's own runs.
  estimate?: Estimate;
}

// One row of the table: an engine and its three built-in presets. `why` closes the cells of an engine
// that cannot take a preset yet.
export interface EngineRow {
  vendor: EngineName;
  why: string | null;
  cells: PresetCell[];
}

// One line of Your presets under the table. A saved preset can run each phase on another engine, so it
// belongs to no engine row, and fifteen of them would not fit in one cell.
export interface SavedLine {
  name: string;
  // Every engine its phases run on, in the order of the Engines page: "Claude Code and Codex".
  runsOn: string;
  active: boolean;
  // What a Delivery card cost on its rows, only from this project's own runs.
  estimate?: Estimate;
}

export interface ModelsSection {
  rows: ProjectModelRow[];
  // The built-in preset, which a saved one sits on.
  preset: PresetName;
  presets: readonly PresetName[];
  // The saved preset the project chose, or null while a built-in one is in use.
  chosen: string | null;
  // The engine the built-in presets run on, or null when this machine holds no login.
  presetEngine: EngineName | null;
  // A row per engine found on this machine, in a fixed engine order. One cell picks the
  // engine and the preset together.
  grid: EngineRow[];
  // The saved presets, in saved order, as the lines of Your presets.
  mine: SavedLine[];
  // How many phases are the person's own on a built-in preset, or differ from a saved one.
  changes: number;
  // The names of the tables the person saved, newest last, as they typed them.
  saved: readonly string[];
  // The profiles a row may be set to, by id and label.
  profiles: readonly { id: string; label: string }[];
  // The same profiles, each with the models it offers, for the combined picker. `effortInName` marks
  // a vendor that reads the effort off the model id, so the picker offers no effort beside it.
  choices: readonly { id: string; label: string; models: readonly string[]; reason?: string; effortInName: boolean }[];
  efforts: readonly string[];
}

// The preset alone, which is what a row with nothing of its own follows.
const fromPreset = (preset: PresetName, models: ModelsByVendor, profiles: readonly EngineProfile[]): ResolvedTable =>
  resolveModels(null, {}, preset, models, profiles);

/**
 * The one warning a row shows, or null.
 *
 * In the order of what a person can do about it. A login this machine does not hold comes first,
 * because with no profile nothing knows the vendor. Then the vendor that cannot run the phase, which
 * no model repairs. Then a model the engine stopped offering.
 */
function rowWarning(action: ModelAction, resolved: ResolvedModel): string | null {
  if (resolved.missingProfile) return `${missingProfileText(resolved.engine)} Runs of ${phaseLabel(action)} are refused until another engine profile is picked here.`;
  // The row is saved all the same, because pointing a row at another vendor is how a person reaches
  // "Run on". The board refuses that drop with this same sentence.
  if (resolved.refusal !== null) return resolved.refusal;
  // In the card Settings tab's words, so one gone model never reads two ways.
  if (resolved.gone) return goneProblem(phaseLabel(action), resolved.model, resolved.engine);
  return null;
}

// A row the board would refuse to start has nothing to cost.
export function measured(db: DatabaseSync, action: ModelAction, row: ResolvedModel, profiles: readonly EngineProfile[]): Estimate | undefined {
  if (row.gone || row.missingProfile || row.refusal !== null) return undefined;
  return startEstimate(db, { phase: action, model: row.model, effort: row.effort, vendor: profiles.find((one) => one.id === row.engine)?.vendor });
}

// The agent steps of a Delivery card, which the preset cells cost.
function deliverySteps(db: DatabaseSync): ModelAction[] {
  return boardFor('delivery', getSetting(db, 'deliveryFlow')).stages.flatMap((stage) => (stage.phase !== undefined && isAction(stage.phase) ? [stage.phase] : []));
}

const cardCost = (db: DatabaseSync, table: ResolvedTable): Estimate | undefined =>
  cardEstimate(db, deliverySteps(db).map((action) => ({ engine: table[action].engine, phase: action, model: table[action].model, effort: table[action].effort })));

const sameRow = (a: ResolvedModel, b: ResolvedModel): boolean => a.engine === b.engine && a.model === b.model && a.effort === b.effort;
const sameTable = (a: ResolvedTable, b: ResolvedTable): boolean => ACTIONS.every((action) => sameRow(a[action], b[action]));
// The effort is left out where the model id carries it, so it is never stored as a difference the
// run does not make.
const fullRow = ({ engine, model, effort }: ResolvedModel, profiles: readonly EngineProfile[]): ActionModel =>
  effortInId(vendorOf(engine, profiles)) ? { engine, model } : { engine, model, effort };
export const vendorOf = (engine: string, profiles: readonly EngineProfile[]): string => profiles.find((one) => one.id === engine)?.vendor ?? engine.split('#')[0] ?? engine;

// The order this page draws engines in, the engine choice and every row's engine select alike.
// A login keeps its stored place among the logins of its own engine.
const ENGINE_ORDER: readonly EngineName[] = ['claude-code', 'codex', 'cursor'];
const byEngine = <T extends { vendor: string }>(profiles: readonly T[]): T[] =>
  [...profiles].sort((a, b) => ENGINE_ORDER.indexOf(a.vendor as EngineName) - ENGINE_ORDER.indexOf(b.vendor as EngineName));

// An engine can take a built-in preset when one of its logins answered models.
const foundEngines = (profiles: readonly EngineProfile[], models: ModelsByVendor): EngineName[] =>
  ENGINE_NAMES.filter((vendor) => profiles.some((one) => one.vendor === vendor) && (models[vendor]?.length ?? 0) > 0);

// Everything the screen and every write measure against: the rows as they run, the built-in preset
// on its engine, and the preset the project chose, saved or built in.
interface State {
  profiles: readonly EngineProfile[];
  preset: PresetName;
  saved: readonly SavedPreset[];
  resolved: ResolvedTable;
  floor: ResolvedTable;
  chosen: SavedPreset | null;
  base: ResolvedTable;
  // Where a built-in preset keeps the person's phases: "heavy:cursor".
  key: string;
}

function stateOf(db: DatabaseSync, models: ModelsByVendor, place?: { outsideGit: boolean; wall: WallState }): State {
  const profiles = projectProfiles(db);
  const preset = getSetting(db, 'modelPreset');
  const saved = getSetting(db, 'savedPresets');
  const resolved = resolveModels(null, getSetting(db, 'models'), preset, models, profiles, null, place);
  const floor = fromPreset(preset, models, profiles);
  const tableOf = (one: SavedPreset) => resolveModels(null, one.models, preset, models, profiles);
  const name = getSetting(db, 'savedPreset');
  // A project from before the choice was stored opens on the saved preset its table matches, and only
  // when its table differs from the built-in one, so picking Heavy never lights up a copy of Heavy.
  // Once this screen wrote anything, a null name is a built-in preset picked, and Balanced picked off
  // Evenings stays Balanced although the rows still match Evenings.
  const matched = name === null && !getSetting(db, 'presetChosen') && !sameTable(resolved, floor);
  const chosen = saved.find((one) => one.name === name) ?? (matched ? saved.find((one) => sameTable(tableOf(one), resolved)) : undefined) ?? null;
  return { profiles, preset, saved, resolved, floor, chosen, base: chosen === null ? floor : tableOf(chosen), key: `${preset}:${profiles[0]?.vendor ?? 'claude-code'}` };
}

// The saved preset the project is on, by the same rule as this screen, so a card that follows the
// project names it too.
export const projectSavedPreset = (db: DatabaseSync, models: ModelsByVendor): SavedPreset | null => stateOf(db, models).chosen;

// `models` is what each vendor offers today, so every row is measured against the list of its own
// profile. `onPath` is what Settings, Engines counts as found, so the engine choice lists the same
// engines as the "3 found" beside Engines.
export function modelsFor(db: DatabaseSync, models: ModelsByVendor, wall: WallState = wallHere(), onPath: readonly EngineName[] = []): ModelsSection {
  const { profiles, preset, saved, resolved, chosen, base } = stateOf(db, models, { outsideGit: projectOutsideGit(db), wall });
  const label = (id: string) => profiles.find((one) => one.id === id)?.label ?? engineName(id);
  const presetEngine = profiles[0]?.vendor ?? null;
  // In the order the Engines page lists them, so the "Codex and Cursor" line follows that page.
  const vendors = (table: ResolvedTable) => ENGINE_ORDER.filter((vendor) => ACTIONS.some((action) => vendorOf(table[action].engine, profiles) === vendor));
  const ready = foundEngines(profiles, models);
  const ordered = byEngine(getSetting(db, 'engineProfiles'));
  const stored = getSetting(db, 'models');
  const rows = ACTIONS.map((action) => {
    const row = base[action];
    const now = resolved[action];
    return {
      action,
      own: stored[action] ?? {},
      resolved: now,
      base: row,
      // On a built-in preset a stored model is the person's own, so a choice that matches a later
      // built-in list still reads as theirs. An older row with only an effort the id carries is not.
      changed: (chosen === null && stored[action]?.model !== undefined) || !sameRow(now, row),
      picked: now.insteadOf === undefined ? null : `Nolzu picked ${now.model}: ${now.insteadOf} is not on this account.`,
      baseText: [label(row.engine), row.model, ...(effortInId(vendorOf(row.engine, profiles)) ? [] : [row.effort])].join(' · '),
      models: modelsForPick(resolved[action], profiles, models),
      presetPicks: Object.fromEntries(
        profiles.map((one) => {
          const built = presetRows(preset, one.vendor)[action];
          return [one.id, one.id === row.engine ? { model: row.model, effort: row.effort } : { ...built, model: presetStandIn(one.vendor, built.model, models[one.vendor]) ?? built.model }];
        }),
      ),
      warning: rowWarning(action, resolved[action]),
    };
  });
  const mine = saved.map((one): SavedLine => {
    // A saved table holds every row, so the preset under it fills nothing in.
    const table = resolveModels(null, one.models, preset, models, profiles);
    const names = vendors(table).map((vendor) => ENGINE_LABELS[vendor]);
    const runsOn = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? ENGINE_LABELS[presetEngine ?? 'claude-code']);
    return { name: one.name, runsOn, active: chosen?.name === one.name, estimate: cardCost(db, table) };
  });
  return {
    rows,
    preset,
    presets: PRESET_NAMES,
    chosen: chosen?.name ?? null,
    presetEngine,
    changes: rows.filter((one) => one.changed).length,
    saved: saved.map((one) => one.name),
    profiles: profileChoices(ordered, models),
    choices: pickerProfiles(ordered, models).map((one) => ({ ...one, effortInName: effortInId(vendorOf(one.id, profiles)) })),
    efforts: EFFORTS,
    mine,
    grid: ENGINE_ORDER.filter((vendor) => onPath.includes(vendor) || ready.includes(vendor)).map((vendor) => ({
      vendor,
      why: ready.includes(vendor)
        ? null
        : !profiles.some((one) => one.vendor === vendor)
          ? `${ENGINE_LABELS[vendor]} has no login yet.`
          : `${ENGINE_LABELS[vendor]} answered no models.`,
      cells: PRESET_NAMES.map((name): PresetCell => {
        const cell: PresetCell = { name, active: chosen === null && name === preset && vendor === presetEngine };
        if (!ready.includes(vendor)) return cell;
        // The built-in preset as it runs with this engine's main login first.
        const table = fromPreset(name, models, presetProfiles(profiles, vendor));
        const { model, effort } = table.implement;
        return { ...cell, uses: effortInId(vendor) ? model : `${model} · ${effort}`, estimate: cardCost(db, table) };
      }),
    })),
  };
}

// The table as it resolves right now, every row filled in with its engine, model and effort. A saved
// preset holds this, so it gives the same rows back whatever the built-in preset says by then.
const tableNow = (state: State): ModelTable => Object.fromEntries(ACTIONS.map((action) => [action, fullRow(state.resolved[action], state.profiles)]));

// The phases that run something other than `table` gives them, each as a whole row.
const differing = (state: State, table: ResolvedTable): ModelTable =>
  Object.fromEntries(ACTIONS.filter((action) => !sameRow(state.resolved[action], table[action])).map((action) => [action, fullRow(state.resolved[action], state.profiles)]));

/**
 * Writes the rows of a built-in preset: what runs, and the same rows kept as the person's under the
 * preset and its engine, so coming back to Heavy on Cursor brings them back.
 */
function writeChoices(db: DatabaseSync, state: State, rows: ModelTable): void {
  writeSetting(db, 'models', rows);
  writeSetting(db, 'presetChoices', { ...(getSetting(db, 'presetChoices') ?? {}), [state.key]: rows });
}

/**
 * The first write after an update that brought `presetChoices`. A built-in preset's stored rows were
 * differences from the built-in list, so a field nobody changed followed that list. Each is written
 * whole now, as the person's choice, and the same rows run as before.
 */
function adoptChoices(db: DatabaseSync, state: State): void {
  if (getSetting(db, 'presetChoices') !== null) return;
  // A stored effort an engine reads off the id ran nothing different, so it is not the person's.
  if (state.chosen === null) writeChoices(db, state, differing(state, state.floor));
  else writeSetting(db, 'presetChoices', {});
}

/**
 * Moves the project to another preset, engine or saved preset in one write.
 *
 * A built-in preset keeps the person's phases under its own name and engine, so
 * moving onto one brings back what they chose there, and moving off one loses nothing. A saved
 * preset's unsaved changes still go along and are counted again against the new preset; on a
 * built-in preset they become the person's own. `keep` false drops them, which is
 * Discard. A saved preset is stored as its differences from the built-in preset on its engine.
 */
function moveTo(db: DatabaseSync, models: ModelsByVendor, change: () => void, keep = true): void {
  const before = stateOf(db, models);
  const carried = keep && before.chosen !== null ? differing(before, before.base) : {};
  change();
  const after = stateOf(db, models);
  if (after.chosen === null) {
    const kept = getSetting(db, 'presetChoices')?.[after.key] ?? {};
    // Measured on the new preset, so an effort an engine reads off the id never counts.
    const now = resolveModels(null, carried, after.preset, models, after.profiles);
    const fresh = Object.fromEntries(Object.entries(carried).filter(([action]) => isAction(action) && !sameRow(now[action], after.floor[action])));
    writeChoices(db, after, { ...kept, ...fresh });
    return;
  }
  const table = Object.fromEntries(ACTIONS.map((action) => [action, carried[action] ?? fullRow(after.base[action], after.profiles)])) as ModelTable;
  writeSetting(db, 'models', diffModels(table, after.floor) ?? {});
}

/**
 * What the project stores after one phase changed. On a built-in preset a phase that differs from it
 * is kept whole as the person's choice, and one that matches it again is dropped, so it follows
 * Nolzu's list once more. On a saved preset it stays a difference from the built-in rows.
 */
function writePhase(db: DatabaseSync, models: ModelsByVendor, state: State, action: ModelAction, table: ModelTable): void {
  if (state.chosen !== null) {
    writeSetting(db, 'models', diffModels(table, state.floor) ?? {});
    return;
  }
  const row = resolveModels(null, table, state.preset, models, state.profiles)[action];
  const rest = { ...getSetting(db, 'models') };
  delete rest[action];
  writeChoices(db, state, sameRow(row, state.floor[action]) ? rest : { ...rest, [action]: fullRow(row, state.profiles) });
}

// One row's engine profile, model or effort, where an empty value sets it back to what the row would
// inherit; a reset of one row; or a move: a built-in preset, its engine, a saved preset, Discard. The
// fields after those are the named tables: save the rows under a name, rename one, update one, remove
// one. A run that is going keeps what it started with; this changes the next one.
export function saveProjectModels(db: DatabaseSync, form: FormData, models: ModelsByVendor): { ok: boolean; message: string | null } {
  const state = stateOf(db, models);
  // A project that opened on a saved preset by its table keeps it from the first write on, so one
  // changed phase does not flip the whole screen back to the built-in preset. From then on the stored
  // name alone says which preset is in use.
  if (state.chosen !== null && getSetting(db, 'savedPreset') === null) writeSetting(db, 'savedPreset', state.chosen.name);
  if (!getSetting(db, 'presetChosen')) writeSetting(db, 'presetChosen', true);
  adoptChoices(db, state);
  const { profiles, preset, saved } = state;

  // A cell of the table sends the preset with its engine, so both move in one write.
  const asked = form.get('preset')?.toString();
  const engine = form.get('presetEngine')?.toString();
  const notFound = engine === undefined || (isEngineName(engine) && foundEngines(profiles, models).includes(engine)) ? null : `Nolzu found no ${isEngineName(engine) ? ENGINE_LABELS[engine] : engine} login with models on this machine. Settings, Engines shows what is missing.`;
  if (asked !== undefined) {
    if (!(PRESET_NAMES as readonly string[]).includes(asked)) return no(`There is no preset ${asked}. The presets are ${PRESET_NAMES.join(', ')}.`);
    if (notFound !== null) return no(notFound);
    moveTo(db, models, () => {
      writeSetting(db, 'modelPreset', asked as PresetName);
      writeSetting(db, 'savedPreset', null);
      if (engine !== undefined) writeSetting(db, 'presetEngine', engine as EngineName);
    });
    return { ok: true, message: null };
  }

  if (engine !== undefined) {
    if (state.chosen !== null) return no(`${state.chosen.name} keeps the engine it saved for each phase. Pick a built-in preset to put every phase on one engine.`);
    if (notFound !== null) return no(notFound);
    moveTo(db, models, () => writeSetting(db, 'presetEngine', engine as EngineName));
    return { ok: true, message: null };
  }

  // Discard on a saved preset. On a built-in one the same field is Back to Nolzu's default for the
  // whole preset: the person's phases on it are dropped and every phase follows Nolzu's list again.
  if (form.has('discard')) {
    if (state.chosen === null) writeChoices(db, state, {});
    else moveTo(db, models, () => undefined, false);
    return { ok: true, message: null };
  }

  const named = form.get('save')?.toString();
  if (named !== undefined) {
    const refused = presetNameProblem(named, [...BUILT_IN_NAMES, ...saved.map((one) => one.name)]);
    if (refused !== null) return no(refused);
    // The new preset holds every phase as it runs, so it is the one in use, with nothing changed.
    writeSetting(db, 'savedPresets', [...saved, { name: named.trim(), models: tableNow(state) }]);
    writeSetting(db, 'savedPreset', named.trim());
    // The person's phases on a built-in preset went into the new one, so the built-in one is Nolzu's
    // own again when it is picked next.
    if (state.chosen === null) writeSetting(db, 'presetChoices', { ...(getSetting(db, 'presetChoices') ?? {}), [state.key]: {} });
    return { ok: true, message: null };
  }

  const rename = form.get('rename')?.toString();
  if (rename !== undefined) {
    if (!saved.some((one) => one.name === rename)) return no(`There is no saved preset ${rename}.`);
    const name = form.get('name')?.toString() ?? '';
    const refused = presetNameProblem(name, [...BUILT_IN_NAMES, ...saved.filter((one) => one.name !== rename).map((one) => one.name)]);
    if (refused !== null) return no(refused);
    writeSetting(db, 'savedPresets', saved.map((one) => (one.name === rename ? { ...one, name: name.trim() } : one)));
    if (getSetting(db, 'savedPreset') === rename) writeSetting(db, 'savedPreset', name.trim());
    renameCardPresets(db, rename, name.trim());
    return { ok: true, message: null };
  }

  // Update <name> on the bar: the saved preset takes the phases as they run now.
  const replace = form.get('replace')?.toString();
  if (replace !== undefined) {
    if (!saved.some((one) => one.name === replace)) return no(`There is no saved preset ${replace}.`);
    writeSetting(db, 'savedPresets', saved.map((one) => (one.name === replace ? { ...one, models: tableNow(state) } : one)));
    return { ok: true, message: null };
  }

  const apply = form.get('apply')?.toString();
  if (apply !== undefined) {
    if (!saved.some((one) => one.name === apply)) return no(`There is no saved preset ${apply}.`);
    // A row that names a profile this machine no longer holds is written as it is and marked on the
    // screen, so losing one login does not stop the other rows.
    moveTo(db, models, () => writeSetting(db, 'savedPreset', apply));
    return { ok: true, message: null };
  }

  // Remove keeps what runs: the phases stay, now the person's own on the built-in preset. A card on
  // it follows the project again.
  const remove = form.get('remove')?.toString();
  if (remove !== undefined) {
    if (!saved.some((one) => one.name === remove)) return no(`There is no saved preset ${remove}.`);
    writeSetting(db, 'savedPresets', saved.filter((one) => one.name !== remove));
    if (getSetting(db, 'savedPreset') === remove) {
      writeSetting(db, 'savedPreset', null);
      const after = stateOf(db, models);
      writeChoices(db, after, differing(after, after.floor));
    }
    renameCardPresets(db, remove, null);
    return { ok: true, message: null };
  }

  const action = form.get('action')?.toString() ?? '';
  const field = form.get('field')?.toString() ?? '';
  const value = form.get('value')?.toString() ?? '';
  if (!isAction(action)) return no(`There is no action ${action}. The actions are ${ACTIONS.join(', ')}.`);
  const stored = getSetting(db, 'models');

  // Reset on a changed phase: it runs what the chosen preset gives it again, which on a built-in
  // preset is Back to Nolzu's default for that phase.
  if (form.has('reset')) {
    writePhase(db, models, state, action, { ...stored, [action]: fullRow(state.base[action], profiles) });
    return { ok: true, message: null };
  }

  // The combined picker sends an engine with its model, because a model name means nothing under
  // another engine. A pick that matches the preset stores nothing.
  const picked = form.get('engine')?.toString();
  if (picked !== undefined) {
    const model = form.get('model')?.toString() ?? '';
    const refused = picked === '' ? 'Pick an engine with the model.' : refuseProfile(picked, profiles, models);
    if (refused !== null) return no(refused);
    if (model === '') return no('Pick a model with the engine. A model name means nothing under another engine.');
    const known = modelsOfProfile(picked, profiles, models);
    if (!known.includes(model)) return no(`${goneText(model)} The engine offers ${known.join(', ')}.`);
    // A move to another engine brings the preset's effort for it, so the row stores what it shows.
    const effort = form.get('effort')?.toString();
    if (effort !== undefined && !(EFFORTS as readonly string[]).includes(effort)) return no(`The effort is one of ${EFFORTS.join(', ')}.`);
    const row: ActionModel = { ...stored[action], engine: picked, model, ...(effort === undefined ? {} : { effort: effort as Effort }) };
    if (effortInId(vendorOf(picked, profiles))) delete row.effort;
    writePhase(db, models, state, action, { ...stored, [action]: row });
    return { ok: true, message: null };
  }
  if (field !== 'engine' && field !== 'model' && field !== 'effort') return no(`There is no ${field} to set on a model row.`);
  if (field === 'effort' && value !== '' && !(EFFORTS as readonly string[]).includes(value)) {
    return no(`The effort is one of ${EFFORTS.join(', ')}.`);
  }

  const table = { ...stored };
  const row: ActionModel = { ...(table[action] ?? {}) };
  const resolved = resolveModels(null, table, preset, models, profiles)[action];

  if (field === 'engine') {
    const refused = refuseProfile(value, profiles, models);
    if (refused !== null) return no(refused);
    row.engine = value === '' ? undefined : value;
    // A model name means nothing under another vendor, so the row takes that engine's preset model.
    // Another login of the same vendor keeps it.
    if (vendorOf(value === '' ? (profiles[0]?.id ?? '') : value, profiles) !== vendorOf(resolved.engine, profiles)) delete row.model;
  }
  // A model name belongs to an engine profile, so choosing one is also what repairs a row whose
  // profile is gone. Changing only the effort leaves that profile alone.
  if (field === 'model') {
    const known = modelsForPick(resolved, profiles, models);
    const target = profileForPick(resolved, profiles);
    if (value !== '' && known.length === 0) return no(noModels(target, profiles));
    if (value !== '' && !known.includes(value)) return no(`${goneText(value)} The engine offers ${known.join(', ')}.`);
    row.model = value === '' ? undefined : value;
    row.engine = target;
  }
  if (field === 'effort') row.effort = value === '' ? undefined : (value as Effort);
  table[action] = row;
  writePhase(db, models, state, action, table);
  return { ok: true, message: null };
}

// The sentence that refuses an engine profile a row cannot be set to, or null when it can.
export function refuseProfile(value: string, profiles: readonly EngineProfile[], models: ModelsByVendor): string | null {
  if (value === '') return null;
  const profile = profiles.find((one) => one.id === value);
  if (profile === undefined) return `There is no engine profile ${value} on this machine.`;
  return models[profile.vendor] === undefined ? noModels(value, profiles) : null;
}

/**
 * Why a profile offers no model.
 *
 * Every vendor a stored profile can name has an adapter now, so an empty list is a command this
 * machine does not have, and installing it repairs the row. Saying Nolzu cannot run the engine
 * would send the person away to wait for something that is already here.
 *
 * Named apart, because the model picker and the profile picker both reach it.
 */
const noModels = (id: string, profiles: readonly EngineProfile[]): string => {
  const vendor = profiles.find((one) => one.id === id)?.vendor;
  const label = vendor === undefined ? id : ENGINE_LABELS[vendor as EngineName];
  return `Nolzu found no ${label} command on this machine, so no row can be set to ${id}. Install it, then open this screen again.`;
};

const no = (message: string) => ({ ok: false, message });
