import type { DatabaseSync } from 'node:sqlite';
import { type ActionModel, ACTIONS, boardFor, diffModels, EFFORTS, effortInId, isAction, type ModelAction, type ModelsByVendor, modelsForPick, modelsOfProfile, type ModelTable, pickerProfiles, PRESET_NAMES, type PresetName, profileForPick, type ResolvedModel, type ResolvedTable, resolveModels, type RunPlace, type WallState } from '@nolzu/core';
import { cardBase, cardFollowsProject, cardModels, cardPreset, cardSavedPreset, followPreset, followSavedPreset, getSetting, projectOutsideGit, projectProfiles, setCardModels, cardEstimate } from '@nolzu/core/node';
import { BOARD_LABELS, type BoardKind, type EngineName, type Estimate, phaseLabel } from '@nolzu/protocol';
import { wallHere } from '@nolzu/runner';
import { measured, projectSavedPreset, refuseProfile, vendorOf } from './project-models.ts';

export interface ModelRow {
  action: ModelAction;
  // The step's name on the card's board, which is the name the board's refused drop says. An action
  // that is no step of the board has its phase name.
  label: string;
  // A step of the card's board. The tab shows any other action only while the card stores a value for it.
  step: boolean;
  // What the card stores for this action, if anything.
  own: ActionModel;
  // What the model and the effort would be without the card's own: the project, then the preset,
  // resolved under the engine this row runs on. A preset answers with the rows of that vendor, so a
  // card that moved the row to another profile inherits that vendor's model and not the project's.
  inherited: ResolvedModel;
  // The profile the row would run on if its engine were set back to inherit, which is the project's
  // answer for this action and a different question from the two above.
  inheritEngine: string;
  // What it runs on.
  resolved: ResolvedModel;
  // The models the profile this row names offers.
  models: readonly string[];
  // What the row runs once Reset takes the card's own value away: the card's preset, under the
  // project's own rows. Engine included, because Reset takes the card's engine away too.
  follows: ResolvedModel;
  // What a run of the row would likely cost and take, only where runs measured it.
  estimate?: Estimate;
  followsEstimate?: Estimate;
  // The tab's "Per card" column: this step over the project's own runs, never a preset's range, so
  // the rows of a preset add up to its button. None on a row that will not start.
  stepEstimate?: Estimate;
}

export interface CardSettings {
  rows: ModelRow[];
  // The built-in preset the card follows: its own pick, or the project's.
  preset: PresetName;
  // The project's saved preset the card follows instead, by name, or null: its own pick, or the one the
  // project is on when the card follows the project.
  saved: string | null;
  // The names of the project's saved presets, which the tab offers after the built-in three.
  savedPresets: readonly string[];
  // The engine the built-in presets run on, the one chosen on Settings, Models, or null when this
  // machine holds no login.
  presetEngine: EngineName | null;
  // The card's board, for "Delivery steps".
  board: string;
  // The profiles a row may be set to, by id and label, each with the models it offers. `effortInName`
  // marks an engine that reads the effort off the model id, so the tab offers no effort there, as
  // Settings, Models does.
  profiles: readonly { id: string; label: string; models: readonly string[]; reason?: string; effortInName: boolean }[];
  // What a card of this board costs on each preset, built in or saved by name, only where runs in
  // this project measured every step.
  presets: Partial<Record<string, Estimate>>;
}

const startsNot = (row: ResolvedModel): boolean => row.gone || row.missingProfile || row.refusal !== null;

// `models` is what each vendor offers today, so a row is only ever measured against the list of the
// profile it names.
export function settingsFor(db: DatabaseSync, key: string, models: ModelsByVendor, wall: WallState = wallHere()): CardSettings | null {
  const card = db.prepare('SELECT board FROM cards WHERE key = ?').get(key) as { board: BoardKind } | undefined;
  if (card === undefined) return null;
  const own = cardModels(db, key);
  const saved = cardSavedPreset(db, key);
  const global = cardBase(db, key);
  const preset = cardPreset(db, key);
  // The same list the job builder resolves against, the project's preset engine first.
  const profiles = projectProfiles(db);
  const place: RunPlace = { outsideGit: projectOutsideGit(db), wall };
  // A card that follows the project follows its saved preset too, and the tab names that one.
  const project = saved === null && cardFollowsProject(db, key) ? projectSavedPreset(db, models) : null;
  const projectTable = project === null ? null : resolveModels(null, project.models, preset, models, profiles);
  // On a saved preset its rows are the preset the card follows, so the tab says so and does not send
  // the person to Settings, Models for them. A phase the project changed on top of it still does.
  const fromSaved = (table: ResolvedTable): ResolvedTable =>
    saved === null && projectTable === null
      ? table
      : (Object.fromEntries(
          ACTIONS.map((action) => {
            const { from, engine, model, effort } = table[action];
            const kept = projectTable?.[action];
            if (kept !== undefined && (kept.engine !== engine || kept.model !== model || kept.effort !== effort)) return [action, table[action]];
            return [action, { ...table[action], from: { model: from.model === 'global' ? 'preset' : from.model, effort: from.effort === 'global' ? 'preset' : from.effort } }];
          }),
        ) as ResolvedTable);
  const inherited = fromSaved(resolveModels(null, global, preset, models, profiles));
  const follows = fromSaved(resolveModels(null, global, preset, models, profiles, null, place));
  const resolved = fromSaved(resolveModels(own, global, preset, models, profiles, null, place));
  // The first column that starts each phase names it, as the drop onto that column does.
  const steps = new Map<string, string>();
  for (const stage of boardFor(card.board, getSetting(db, 'deliveryFlow')).stages) {
    if (stage.phase !== undefined && !steps.has(stage.phase)) steps.set(stage.phase, stage.label);
  }
  // A switch clears the card's own values, so each preset is costed on the project's rows alone.
  const actions = [...steps.keys()].filter(isAction);
  const presets: Partial<Record<string, Estimate>> = {};
  const cost = (name: string, table: ResolvedTable) => {
    const estimate = cardEstimate(db, actions.map((action) => ({ engine: table[action].engine, phase: action, model: table[action].model, effort: table[action].effort })));
    if (estimate !== undefined) presets[name] = estimate;
  };
  // A built-in preset sits on the project's rows, and a saved one holds its own on the project's
  // preset, since a pick of it clears the card's own built-in one.
  for (const name of PRESET_NAMES) cost(name, resolveModels(null, getSetting(db, 'models'), name, models, profiles, null, place));
  const savedPresets = getSetting(db, 'savedPresets');
  for (const one of savedPresets) cost(one.name, resolveModels(null, one.models, getSetting(db, 'modelPreset'), models, profiles, null, place));
  return {
    rows: ACTIONS.map((action) => ({
      action,
      label: steps.get(action) ?? phaseLabel(action),
      step: steps.has(action),
      own: own?.[action] ?? {},
      inherited: own?.[action]?.engine === undefined ? inherited[action] : fromSaved(resolveModels(null, global, preset, models, profiles, own[action].engine))[action],
      inheritEngine: inherited[action].engine,
      resolved: resolved[action],
      models: modelsForPick(resolved[action], profiles, models),
      follows: follows[action],
      estimate: measured(db, action, resolved[action], profiles),
      followsEstimate: measured(db, action, follows[action], profiles),
      stepEstimate: startsNot(resolved[action]) ? undefined : cardEstimate(db, [{ engine: resolved[action].engine, phase: action, model: resolved[action].model, effort: resolved[action].effort }]),
    })),
    preset,
    saved: saved?.name ?? project?.name ?? null,
    savedPresets: savedPresets.map((one) => one.name),
    presetEngine: profiles[0]?.vendor ?? null,
    presets,
    board: BOARD_LABELS[card.board],
    profiles: pickerProfiles(profiles, models).map((one) => ({ ...one, effortInName: effortInId(vendorOf(one.id, profiles)) })),
  };
}

const answer = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * One action's engine and model, its effort, a reset, or the card's preset.
 *
 * An engine comes with its model in one write, because a model name means nothing under another
 * engine. `{ reset: true }` removes the card's own value of one action, so it follows the preset again.
 * A preset is a built-in one or one of the project's saved presets by name, and clears every value the
 * card set. The card stores only what differs from
 * what it follows, so a later change to the preset still reaches the rest. A run that is going keeps
 * the values it started with; this changes the next one.
 */
export async function saveCardModels(db: DatabaseSync, key: string, request: Request, models: ModelsByVendor): Promise<Response> {
  let asked: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    asked = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    asked = {};
  }
  const current = settingsFor(db, key, models);
  if (current === null) return answer(404, { message: `There is no card ${key}, so it has no models to set.` });

  if (asked.preset !== undefined) {
    if (typeof asked.preset === 'string' && (PRESET_NAMES as readonly string[]).includes(asked.preset)) followPreset(db, key, asked.preset as PresetName);
    else if (typeof asked.preset === 'string' && current.savedPresets.includes(asked.preset)) followSavedPreset(db, key, asked.preset);
    else return answer(400, { message: `There is no preset ${String(asked.preset)}. The presets are light, default, heavy and the ones saved on Settings, Models.` });
    return answer(200, { ok: true });
  }

  // What the card follows with nothing of its own. Not the rows' own labels: those are pinned to the
  // engine each row names, and a diff against them would take that engine back off the card.
  const inherited: ResolvedTable = resolveModels(null, cardBase(db, key), current.preset, models, projectProfiles(db));
  const profiles = projectProfiles(db);
  const { action, engine, model, effort } = asked;
  if (typeof action !== 'string' || !isAction(action)) return answer(400, { message: `There is no action ${String(action)}. The actions are ${ACTIONS.join(', ')}.` });
  // Only this row is worked out again; every other row stays as the card stored it.
  const others = Object.fromEntries(current.rows.filter((one) => one.action !== action && Object.keys(one.own).length > 0).map((one) => [one.action, one.own]));
  const row = current.rows.find((one) => one.action === action);

  let kept: ActionModel | undefined;
  if (asked.reset === true) {
    kept = undefined;
  } else {
    const resolved = row?.resolved ?? inherited[action];
    if (engine !== undefined && engine !== null) {
      const refused = typeof engine === 'string' ? refuseProfile(engine, profiles, models) : `There is no engine profile ${String(engine)} on this machine.`;
      if (refused !== null) return answer(400, { message: refused });
      if (typeof model !== 'string') return answer(400, { message: 'Pick a model with the engine. A model name means nothing under another engine.' });
    }
    // The profile this write lands on: the one the body names, the one the row inherits when it is
    // set back to inherit, and otherwise the one the row already runs. The model is checked against
    // that profile and written under it, so a body that carries an engine and a model cannot be
    // checked against the profile the row is leaving.
    let target = profileForPick(resolved, profiles);
    if (typeof engine === 'string' && engine !== '') target = engine;
    else if (engine === null) target = profileForPick(inherited[action], profiles);
    const known = modelsOfProfile(target, profiles, models);
    if (model !== undefined && model !== null && (typeof model !== 'string' || !known.includes(model))) {
      return answer(400, { message: `The engine does not offer ${String(model)}. It offers ${known.join(', ')}.` });
    }
    if (effort !== undefined && effort !== null && !(EFFORTS as readonly unknown[]).includes(effort)) {
      return answer(400, { message: `The effort is one of ${EFFORTS.join(', ')}.` });
    }
    const mine: ActionModel = { ...(row?.own ?? {}) };
    if (engine !== undefined) mine.engine = engine === null ? undefined : (engine as string);
    // A model name belongs to an engine profile, so choosing one is also what repairs a row whose
    // profile is gone. Changing only the effort leaves that profile alone.
    if (model !== undefined) {
      mine.engine = target;
      mine.model = model === null ? undefined : (model as string);
    }
    if (effort !== undefined) mine.effort = effort === null ? undefined : (effort as ActionModel['effort']);
    kept = diffModels({ [action]: mine }, inherited)?.[action];
  }
  const table: ModelTable = kept === undefined ? others : { ...others, [action]: kept };
  setCardModels(db, key, Object.keys(table).length === 0 ? null : table);
  return answer(200, { ok: true });
}
