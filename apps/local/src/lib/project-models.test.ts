import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ACTIONS, deliveryBoard, NO_MODELS_REASON, PRESET_NAMES, presetRows, startsLabel } from '@nolzu/core';
import { DEFAULT_PROFILE, type StageView } from '@nolzu/protocol';
import { bumpVersion, getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { modelsFor, saveProjectModels } from './project-models.ts';

const KNOWN = ['haiku', 'sonnet', 'opus', 'fable'];
// What each vendor offers, as the route reads it off the engines. A row is measured against the
// list of the profile it names.
const OFFERS = { 'claude-code': KNOWN };
// The vendor that runs implement and nothing else, which is what the phase rule is measured with.
const CURSOR = { id: 'cursor#work', label: 'Cursor work', vendor: 'cursor', configDir: '/work/cursor' } as const;
const WITH_CURSOR = { ...OFFERS, cursor: ['composer-2.5'] };
let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-models-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const posted = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return form;
};
const row = (action: string) => modelsFor(db, OFFERS).rows.find((one) => one.action === action);

describe('the rows', () => {
  // extract-summary makes an AI call as much as the phases do, so it has a row like the rest.
  it('has one row per action that makes an AI call, the summary pass included', () => {
    expect(modelsFor(db, OFFERS).rows.map((one) => one.action)).toEqual([...ACTIONS]);
    expect(modelsFor(db, OFFERS).rows.map((one) => one.action)).toContain('extract-summary');
  });

  it('follows the preset on a fresh database, and says so', () => {
    const plan = row('plan');

    expect(plan?.own).toEqual({});
    expect(plan?.resolved).toMatchObject({ model: 'sonnet', effort: 'medium', from: { model: 'preset', effort: 'preset' } });
  });

  it('offers the three presets, and per row the models its own profile reports', () => {
    expect(PRESET_NAMES).toEqual(['light', 'default', 'heavy']);
    expect(modelsFor(db, { 'claude-code': ['sonnet'] }).rows[0]?.models).toEqual(['sonnet']);
  });

  // Every preset has to answer for every action, or an action added later starts with nothing.
  it.each(PRESET_NAMES)('gives every action a model and an effort in the %s preset', (preset) => {
    for (const action of ACTIONS) {
      expect(presetRows(preset, 'claude-code')[action].model).not.toBe('');
      expect(presetRows(preset, 'claude-code')[action].effort).not.toBe('');
    }
  });
});

describe('picking a preset', () => {
  it('moves every row that follows the preset in one step', () => {
    expect(saveProjectModels(db, posted({ preset: 'heavy' }), OFFERS)).toEqual({ ok: true, message: null });
    expect(getSetting(db, 'modelPreset')).toBe('heavy');
    expect(row('implement')?.resolved).toMatchObject({ model: 'opus', effort: 'high' });
  });

  // A change belongs to the preset and engine it was made on, so another preset
  // starts from its own rows and coming back brings the change back.
  it('keeps a change with the preset it was made on, and brings it back with that preset', () => {
    saveProjectModels(db, posted({ action: 'implement', field: 'model', value: 'opus' }), OFFERS);
    saveProjectModels(db, posted({ preset: 'light' }), OFFERS);

    expect(row('implement')?.own).toEqual({});
    expect(row('implement')?.resolved.model).toBe('sonnet');
    saveProjectModels(db, posted({ preset: 'default' }), OFFERS);
    expect(row('implement')).toMatchObject({ changed: true, own: { engine: 'claude-code', model: 'opus', effort: 'medium' } });
    expect(getSetting(db, 'presetChoices')).toEqual({ 'default:claude-code': { implement: { engine: 'claude-code', model: 'opus', effort: 'medium' } }, 'light:claude-code': {} });
  });

  // The whole row is stored, so a later Nolzu whose built-in list says something else for the phase
  // leaves the person's choice as it is. The built-in table is changed in place to stand for that.
  it('keeps a person\'s choice when Nolzu\'s built-in list changes', () => {
    saveProjectModels(db, posted({ action: 'plan', field: 'effort', value: 'high' }), OFFERS);
    const built = presetRows('default', 'claude-code').plan;
    const was = { ...built };
    built.model = 'haiku';
    built.effort = 'low';
    try {
      expect(row('plan')).toMatchObject({ changed: true, resolved: { model: 'sonnet', effort: 'high' } });
      expect(row('implement')?.changed).toBe(false);
      // A move away and back keeps it too.
      saveProjectModels(db, posted({ preset: 'heavy' }), OFFERS);
      saveProjectModels(db, posted({ preset: 'default' }), OFFERS);
      expect(row('plan')?.resolved).toMatchObject({ model: 'sonnet', effort: 'high' });
      // A later list that gives the same row still leaves it the person's.
      built.model = 'sonnet';
      built.effort = 'high';
      expect(row('plan')?.changed).toBe(true);
    } finally {
      Object.assign(built, was);
    }
  });

  // Rows stored before the person's choices were kept per preset are the person's from the first write.
  it('takes the rows an older version stored as the person\'s own', () => {
    writeSetting(db, 'models', { plan: { effort: 'high' }, qa: { engine: 'claude-code', model: 'opus' } });
    expect(getSetting(db, 'presetChoices')).toBeNull();

    saveProjectModels(db, posted({ action: 'refine', field: 'effort', value: 'medium' }), OFFERS);

    expect(getSetting(db, 'models')).toEqual({
      plan: { engine: 'claude-code', model: 'sonnet', effort: 'high' },
      qa: { engine: 'claude-code', model: 'opus', effort: 'medium' },
      refine: { engine: 'claude-code', model: 'haiku', effort: 'medium' },
    });
    expect(getSetting(db, 'presetChoices')?.['default:claude-code']).toEqual(getSetting(db, 'models'));
  });

  it('refuses a preset it does not have', () => {
    expect(saveProjectModels(db, posted({ preset: 'turbo' }), OFFERS)).toMatchObject({ ok: false });
    expect(getSetting(db, 'modelPreset')).toBe('default');
  });
});

describe('one row', () => {
  it('stores a model and an effort, and says they are the project\'s own', () => {
    saveProjectModels(db, posted({ action: 'refine', field: 'model', value: 'opus' }), OFFERS);
    saveProjectModels(db, posted({ action: 'refine', field: 'effort', value: 'high' }), OFFERS);

    expect(row('refine')?.own).toEqual({ engine: 'claude-code', model: 'opus', effort: 'high' });
    expect(row('refine')?.resolved.from).toEqual({ model: 'global', effort: 'global' });
  });

  it('stores only what differs from the preset', () => {
    saveProjectModels(db, posted({ action: 'plan', field: 'model', value: presetRows('default', 'claude-code').plan.model }), OFFERS);

    expect(getSetting(db, 'models')).toEqual({});
  });

  it.each([
    ['model', 'opus', presetRows('default', 'claude-code').plan.model],
    ['effort', 'low', presetRows('default', 'claude-code').plan.effort],
  ])('sets the %s back to the preset with an empty value', (field, chosen, base) => {
    saveProjectModels(db, posted({ action: 'plan', field, value: chosen }), OFFERS);
    expect(row('plan')?.own[field as 'model' | 'effort']).toBe(chosen);

    saveProjectModels(db, posted({ action: 'plan', field, value: '' }), OFFERS);
    expect(row('plan')?.own[field as 'model' | 'effort']).toBeUndefined();
    expect(row('plan')?.resolved[field as 'model' | 'effort']).toBe(base);
  });

  // The words the board refuses a drop with, so the two screens do not disagree about what happened.
  // Each says what to do next in its own place, which is why only the first half is shared.
  it('refuses a model the engine no longer offers, in the words the board uses, and names what it does offer', () => {
    const answer = saveProjectModels(db, posted({ action: 'plan', field: 'model', value: 'haiku-3' }), OFFERS);
    const stages: StageView[] = [
      { id: 'inbox', label: 'Inbox', role: 'you', count: 0, cadence: null, starts: null },
      { id: 'plan', label: 'Plan', role: 'agent', count: 0, cadence: null, starts: { phase: 'plan', model: 'haiku-3', effort: 'medium', engine: 'claude-code', modelState: 'gone', refusal: null } },
    ];
    const board = startsLabel(deliveryBoard('pull-request'), 'inbox', 'plan', stages) ?? '';

    expect(board).toContain('haiku-3 is gone.');
    expect(answer.message?.startsWith('haiku-3 is gone.')).toBe(true);
    expect(answer.message).toMatch(/haiku, sonnet, opus, fable/);
    expect(getSetting(db, 'models')).toEqual({});
  });

  it('refuses an effort and an action it does not know', () => {
    expect(saveProjectModels(db, posted({ action: 'plan', field: 'effort', value: 'huge' }), OFFERS)).toMatchObject({ ok: false });
    expect(saveProjectModels(db, posted({ action: 'dream', field: 'model', value: 'opus' }), OFFERS)).toMatchObject({ ok: false });
    expect(saveProjectModels(db, posted({ action: 'plan', field: 'colour', value: 'red' }), OFFERS)).toMatchObject({ ok: false });
  });

  // Kept and marked, never replaced without a word, because a run on it is refused and the person has to know why.
  it('marks a stored model the engine stopped offering as gone', () => {
    writeSetting(db, 'models', { plan: { engine: 'claude-code', model: 'sonnet' } });

    expect(modelsFor(db, { 'claude-code': ['haiku', 'opus'] }).rows.find((one) => one.action === 'plan')?.resolved.gone).toBe(true);
  });

  // The same the other way round: the row runs on the Claude Code login, and the Codex model list
  // says nothing about a Claude model.
  it('measures a row against its own vendor and not against the other one', () => {
    writeSetting(db, 'models', { plan: { engine: 'claude-code', model: 'sonnet' } });

    expect(modelsFor(db, { ...OFFERS, codex: ['gpt-5.6-sol'] }).rows.find((one) => one.action === 'plan')?.resolved.gone).toBe(false);
  });

  it('keeps a row another engine wrote, and marks it', () => {
    writeSetting(db, 'models', { plan: { engine: 'cursor', model: 'composer' } });

    expect(row('plan')?.resolved).toMatchObject({ engine: 'cursor', missingProfile: true });
  });

  // Changing an unrelated row must not rewrite it, and neither must changing its own effort: a model
  // name belongs to an engine, so only picking a model says which engine the row runs on.
  it('leaves another engine\'s row alone when another row is saved', () => {
    writeSetting(db, 'models', { plan: { engine: 'cursor', model: 'composer' } });

    saveProjectModels(db, posted({ action: 'refine', field: 'effort', value: 'high' }), OFFERS);

    expect(row('plan')?.own).toEqual({ engine: 'cursor', model: 'composer' });
  });

  it('leaves the engine alone when only the effort of that row changes', () => {
    writeSetting(db, 'models', { plan: { engine: 'cursor', model: 'composer' } });

    saveProjectModels(db, posted({ action: 'plan', field: 'effort', value: 'low' }), OFFERS);

    // Cursor reads the effort off the model id, so no effort is stored for it.
    expect(row('plan')?.own).toEqual({ engine: 'cursor', model: 'composer' });
  });

  it('repairs the row when a model of this engine is picked', () => {
    writeSetting(db, 'models', { plan: { engine: 'cursor', model: 'composer' } });

    saveProjectModels(db, posted({ action: 'plan', field: 'model', value: 'opus' }), OFFERS);

    expect(row('plan')?.own).toEqual({ engine: 'claude-code', model: 'opus', effort: 'medium' });
    expect(row('plan')?.resolved.missingProfile).toBe(false);
  });
});

// The engine profile is a column of its own, beside the model and the effort.
describe('the engine profile column', () => {
  const CODEX = { id: 'codex#work', label: 'Codex work', vendor: 'codex' as const, configDir: '/tmp/nolzu-models-codex' };
  // Two vendors with an adapter, which is what the run side hands in. The Codex list holds what the
  // built-in preset names, as a real one does, plus a model no preset asks for.
  const BOTH = { ...OFFERS, codex: ['gpt-5.6-terra', 'gpt-9'] };
  const both = () => writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  const planRow = (models = BOTH) => modelsFor(db, models).rows.find((one) => one.action === 'plan');

  it('offers every profile this version can run, and leaves out one it cannot', () => {
    // The lists handed in hold no Cursor model, which is a machine without its binary.
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX, CURSOR]);

    expect(modelsFor(db, BOTH).profiles).toEqual([
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'codex#work', label: 'Codex work' },
    ]);
  });

  // Settings, Models draws the same combined picker, so a profile with no models stays in its choices
  // with the reason, and does not vanish from the list.
  it('keeps a profile with no models among the choices, with the reason', () => {
    both();

    expect(modelsFor(db, OFFERS).choices).toEqual([
      { id: 'claude-code', label: 'Claude Code', models: KNOWN, effortInName: false },
      { id: 'codex#work', label: 'Codex work', models: [], reason: NO_MODELS_REASON, effortInName: false },
    ]);
  });

  // The point of the column: the row moves to the other login, and its picker follows it there.
  it('moves a row to another profile, and offers that profile\'s models', () => {
    both();

    expect(saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'codex#work' }), BOTH)).toEqual({ ok: true, message: null });

    expect(planRow()?.own.engine).toBe('codex#work');
    expect(planRow()?.models).toEqual(['gpt-5.6-terra', 'gpt-9']);
    // The preset answers with the Codex rows, so the row runs without anybody picking a
    // model. Before it, the row fell through to a Claude alias and the drop was refused.
    expect(planRow()?.resolved).toMatchObject({ engine: 'codex#work', model: 'gpt-5.6-terra', gone: false });
  });

  it('takes a model of the profile the row names, and the row then runs', () => {
    both();
    saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'codex#work' }), BOTH);

    saveProjectModels(db, posted({ action: 'plan', field: 'model', value: 'gpt-9' }), BOTH);

    expect(planRow()?.own).toEqual({ engine: 'codex#work', model: 'gpt-9', effort: 'medium' });
    expect(planRow()?.resolved).toMatchObject({ gone: false, missingProfile: false });
  });

  it('refuses a model of the other vendor, and names what this profile offers', () => {
    both();
    saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'codex#work' }), BOTH);

    const answer = saveProjectModels(db, posted({ action: 'plan', field: 'model', value: 'opus' }), BOTH);

    expect(answer.ok).toBe(false);
    expect(answer.message).toMatch(/gpt-5.6-terra, gpt-9/);
  });

  // A model name is the vendor's, so a move to another login of the same vendor keeps it.
  it('keeps the model on a move to another login of the same vendor', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX, { ...CODEX, id: 'codex#home', label: 'Codex home', configDir: '/tmp/nolzu-models-codex-home' }]);
    saveProjectModels(db, posted({ action: 'plan', engine: 'codex#work', model: 'gpt-9' }), BOTH);

    saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'codex#home' }), BOTH);

    expect(planRow()?.resolved).toMatchObject({ engine: 'codex#home', model: 'gpt-9' });
    saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: '' }), BOTH);
    expect(planRow()?.resolved).toMatchObject({ engine: 'claude-code', model: 'sonnet' });
  });

  it('sets the row back to the profile it inherits with an empty value', () => {
    both();
    saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'codex#work' }), BOTH);

    saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: '' }), BOTH);

    expect(planRow()?.own.engine).toBeUndefined();
    expect(planRow()?.resolved.engine).toBe('claude-code');
  });

  it('refuses a profile this machine does not hold', () => {
    const answer = saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'codex#gone' }), BOTH);

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('codex#gone');
    expect(getSetting(db, 'models')).toEqual({});
  });

  // A row set to a profile whose command is not on this machine would take the choice and refuse
  // every run of it, so it is refused where the person can still do something about it.
  it('refuses a profile whose engine is not installed', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);

    const answer = saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'cursor#work' }), BOTH);

    expect(answer.ok).toBe(false);
    expect(answer.message).toMatch(/found no Cursor command/);
  });

  // A vendor this version can run whose command answered with nothing is a tool this machine does
  // not have. Saying Nolzu cannot run Codex would send the person away to wait for something that
  // is already here, and installing the CLI is what repairs the row.
  it('refuses a profile whose command this machine does not have', () => {
    both();

    const answer = saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'codex#work' }), OFFERS);

    expect(answer.ok).toBe(false);
    expect(answer.message).toMatch(/found no Codex command/);
    expect(answer.message).not.toMatch(/cannot run/);
  });

  // The refusal of a profile with no login, read off the screen that shows it.
  it('marks a row whose profile was removed, and keeps what it names', () => {
    both();
    saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'codex#work' }), BOTH);
    saveProjectModels(db, posted({ action: 'plan', field: 'model', value: 'gpt-9' }), BOTH);

    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE]);

    expect(planRow()?.resolved).toMatchObject({ engine: 'codex#work', missingProfile: true, gone: false });
    expect(planRow()?.own).toEqual({ engine: 'codex#work', model: 'gpt-9', effort: 'medium' });
  });
});

// The rows saved under a name the person typed, and applied again with one write.
describe('a named preset', () => {
  const CODEX = { id: 'codex#work', label: 'Codex work', vendor: 'codex' as const, configDir: '/tmp/nolzu-models-codex' };
  const BOTH = { ...OFFERS, codex: ['gpt-5.6-terra'] };
  // What the screen draws, row by row, which is what a person compares before and after.
  const table = (models = OFFERS) => modelsFor(db, models).rows.map((one) => [one.action, one.resolved.engine, one.resolved.model, one.resolved.effort]);
  const names = () => modelsFor(db, OFFERS).saved;

  it('gives every row back on apply, and lists the name', () => {
    saveProjectModels(db, posted({ preset: 'heavy' }), OFFERS);
    saveProjectModels(db, posted({ action: 'refine', field: 'model', value: 'haiku' }), OFFERS);
    const saved = table();

    expect(saveProjectModels(db, posted({ save: 'Evenings' }), OFFERS)).toEqual({ ok: true, message: null });
    expect(names()).toEqual(['Evenings']);

    // Everything moves away from what was saved, so the apply has something to do.
    saveProjectModels(db, posted({ preset: 'light' }), OFFERS);
    expect(table()).not.toEqual(saved);

    expect(saveProjectModels(db, posted({ apply: 'Evenings' }), OFFERS)).toEqual({ ok: true, message: null });
    expect(table()).toEqual(saved);
  });

  // A person who lost a login still gets the rest of the table. Refusing the whole write would
  // leave them with a preset they can never apply again.
  it('applies every other row and marks the one whose profile is gone', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
    saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'codex#work' }), BOTH);
    saveProjectModels(db, posted({ action: 'implement', field: 'model', value: 'opus' }), BOTH);
    saveProjectModels(db, posted({ save: 'Two logins' }), BOTH);
    // The Codex login goes, and the project moves back to Balanced.
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE]);
    saveProjectModels(db, posted({ preset: 'default' }), OFFERS);

    expect(saveProjectModels(db, posted({ apply: 'Two logins' }), OFFERS)).toEqual({ ok: true, message: null });

    const rows = modelsFor(db, OFFERS).rows;
    expect(rows.find((one) => one.action === 'implement')?.resolved).toMatchObject({ model: 'opus', missingProfile: false });
    expect(rows.find((one) => one.action === 'plan')?.resolved).toMatchObject({ engine: 'codex#work', missingProfile: true });
  });

  // A saved preset holds the engine of every phase, so it gives the same rows back
  // whatever the engine choice says by then.
  it('saves the engine, model and effort of every phase', () => {
    saveProjectModels(db, posted({ preset: 'heavy' }), OFFERS);
    saveProjectModels(db, posted({ save: 'Evenings' }), OFFERS);

    const stored = getSetting(db, 'savedPresets')[0]!.models;
    for (const action of ACTIONS) expect(stored[action], action).toEqual({ engine: 'claude-code', ...presetRows('heavy', 'claude-code')[action] });
  });

  it.each([
    ['', /needs a name/],
    ['   ', /needs a name/],
    ['Evenings', /already a preset called Evenings/],
    ['heavy', /already a preset called heavy/],
    // The screen draws the built-in three with a capital, so this would be a second Heavy button.
    ['Heavy', /already a preset called Heavy/],
    // The built-in default is drawn as Balanced, so that title is taken in any case too.
    ['Balanced', /already a preset called Balanced/],
    [' balanced ', /already a preset called balanced/],
    ['home/work', /cannot hold a slash/],
  ])('refuses the name %j and saves nothing', (name, why) => {
    saveProjectModels(db, posted({ save: 'Evenings' }), OFFERS);

    const answer = saveProjectModels(db, posted({ save: name }), OFFERS);

    expect(answer.ok).toBe(false);
    expect(answer.message).toMatch(why);
    expect(names()).toEqual(['Evenings']);
  });

  it('renames one in its place, and refuses a name another preset holds', () => {
    saveProjectModels(db, posted({ save: 'Evenings' }), OFFERS);
    saveProjectModels(db, posted({ save: 'Weekends' }), OFFERS);

    expect(saveProjectModels(db, posted({ rename: 'Evenings', name: ' Nights ' }), OFFERS)).toEqual({ ok: true, message: null });
    expect(names()).toEqual(['Nights', 'Weekends']);
    // Its own name in another case is no clash with itself.
    expect(saveProjectModels(db, posted({ rename: 'Nights', name: 'nights' }), OFFERS)).toEqual({ ok: true, message: null });
    expect(saveProjectModels(db, posted({ rename: 'nights', name: 'Weekends' }), OFFERS)).toMatchObject({ ok: false, message: 'There is already a preset called Weekends.' });
    expect(saveProjectModels(db, posted({ rename: 'nights', name: 'heavy' }), OFFERS)).toMatchObject({ ok: false });
    expect(saveProjectModels(db, posted({ rename: 'nights', name: 'BALANCED' }), OFFERS)).toMatchObject({ ok: false, message: 'There is already a preset called BALANCED.' });
    expect(saveProjectModels(db, posted({ rename: 'nights', name: '' }), OFFERS)).toMatchObject({ ok: false, message: 'A preset needs a name.' });
    expect(saveProjectModels(db, posted({ rename: 'Gone', name: 'Other' }), OFFERS)).toMatchObject({ ok: false });
    expect(names()).toEqual(['nights', 'Weekends']);
  });

  it('saves the current setup into one, and leaves the others alone', () => {
    saveProjectModels(db, posted({ save: 'Evenings' }), OFFERS);
    saveProjectModels(db, posted({ save: 'Weekends' }), OFFERS);
    saveProjectModels(db, posted({ preset: 'heavy' }), OFFERS);
    const now = table();
    const weekends = getSetting(db, 'savedPresets')[1];

    expect(saveProjectModels(db, posted({ replace: 'Evenings' }), OFFERS)).toEqual({ ok: true, message: null });
    expect(names()).toEqual(['Evenings', 'Weekends']);
    expect(getSetting(db, 'savedPresets')[1]).toEqual(weekends);
    saveProjectModels(db, posted({ preset: 'default' }), OFFERS);
    saveProjectModels(db, posted({ apply: 'Evenings' }), OFFERS);
    expect(table()).toEqual(now);
    expect(saveProjectModels(db, posted({ replace: 'Gone' }), OFFERS)).toMatchObject({ ok: false });
  });

  it('removes one, and refuses a name it does not hold', () => {
    saveProjectModels(db, posted({ save: 'Evenings' }), OFFERS);

    expect(saveProjectModels(db, posted({ remove: 'Evenings' }), OFFERS)).toEqual({ ok: true, message: null });
    expect(names()).toEqual([]);
    expect(saveProjectModels(db, posted({ apply: 'Evenings' }), OFFERS)).toMatchObject({ ok: false });
    expect(saveProjectModels(db, posted({ remove: 'Evenings' }), OFFERS)).toMatchObject({ ok: false });
  });
});

/**
 * A row whose vendor cannot run that phase.
 *
 * The save goes through, because pointing a row at another vendor's profile is how a person reaches
 * "Run on". What changes is that the row says why the run would be
 * refused, in the sentence the spawn would have thrown, and the board refuses the drop.
 */
// Where the wall cannot start, which is the one place a Cursor row of a read-only phase is refused.
const NO_WALL = { ready: false, reason: 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.' } as const;

describe('a row on a vendor that cannot run its phase', () => {
  const rowOf = (action: string, wall: { ready: true } | typeof NO_WALL = NO_WALL) => modelsFor(db, WITH_CURSOR, wall).rows.find((one) => one.action === action);

  beforeEach(() => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
  });

  it('takes the save and says why the run would be refused', () => {
    expect(saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'cursor#work' }), WITH_CURSOR)).toEqual({ ok: true, message: null });

    expect(rowOf('plan')?.own.engine).toBe('cursor#work');
    expect(rowOf('plan')?.resolved.refusal).toContain(NO_WALL.reason);
    // Where the wall starts, the same row runs.
    expect(rowOf('plan', { ready: true })?.resolved.refusal).toBeNull();
  });

  // The other path. Implement is the phase Cursor runs, so the same profile on the row below says
  // nothing.
  it('says nothing on a row this vendor can run', () => {
    saveProjectModels(db, posted({ action: 'implement', field: 'engine', value: 'cursor#work' }), WITH_CURSOR);

    expect(rowOf('implement')?.resolved.refusal).toBeNull();
  });

  // The board and this screen read one rule, so a row the screen warns about is a drop the board
  // refuses, in the same words.
  it('says what the board would say on the drop', () => {
    saveProjectModels(db, posted({ action: 'plan', field: 'engine', value: 'cursor#work' }), WITH_CURSOR);
    const resolved = rowOf('plan')?.resolved;
    const board = deliveryBoard('pull-request');
    const stages: readonly StageView[] = board.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      role: stage.role,
      count: 0,
      cadence: null,
      starts:
        stage.phase === 'plan' && resolved !== undefined
          ? { phase: 'plan', model: resolved.model, effort: resolved.effort, engine: resolved.engine, modelState: 'vendor', refusal: resolved.refusal }
          : null,
    }));

    expect(startsLabel(board, 'refine', 'plan', stages)).toBe(resolved?.refusal);
  });
});

/**
 * The one warning a row shows.
 *
 * It used to be three branches of markup in the route, which no test renders, so breaking one of
 * them on purpose failed no test. The sentence is a value on the row now, and the screen draws it.
 */
describe('the warning a row carries', () => {
  const warningOf = (action: string) => modelsFor(db, WITH_CURSOR, NO_WALL).rows.find((one) => one.action === action)?.warning;

  it('says nothing about a row that would run', () => {
    expect(warningOf('plan')).toBeNull();
  });

  // A login this machine does not hold comes first: with no profile nothing knows the vendor, so a
  // rule about a vendor nobody can see would be the wrong sentence.
  it('names a login this machine does not hold, and the screen to repair it on', () => {
    writeSetting(db, 'models', { plan: { engine: 'codex#gone', model: 'gpt-9' } });

    expect(warningOf('plan')).toContain('codex#gone');
    expect(warningOf('plan')).toContain('Runs of Plan are refused');
  });

  // Then the vendor rule, which no model a person could pick repairs.
  it('names the phase the vendor cannot run', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
    writeSetting(db, 'models', { plan: { engine: 'cursor#work', model: 'composer-2.5' } });

    expect(warningOf('plan')).toContain("only Nolzu's wall holds Cursor to reading");
  });

  // The one order that can be seen. A row can be refused by its vendor and name a model that
  // vendor dropped at the same time, and the vendor sentence is the one to show, because no model
  // a person could pick repairs it.
  it('names the vendor rule and not the model when both are true', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
    writeSetting(db, 'models', { plan: { engine: 'cursor#work', model: 'gone-model' } });

    expect(warningOf('plan')).toContain("only Nolzu's wall holds Cursor to reading");
    expect(warningOf('plan')).not.toContain('is gone');
  });

  // A project folder that is not a git repository runs on Claude Code only, and the row says so
  // before a run is refused for it.
  it('names Claude Code on a Cursor implement row when the project folder is not a git repository', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
    writeSetting(db, 'models', { implement: { engine: 'cursor#work', model: 'composer-2.5' } });
    writeSetting(db, 'projectPath', '/work/recipes');
    writeSetting(db, 'repos', [{ path: 'api', base: null }]);

    expect(warningOf('implement')).toContain('Run this phase on a Claude Code profile');
    expect(warningOf('plan')).toBeNull();
  });

  // Then a model the engine stopped offering.
  it('names the model the engine no longer offers', () => {
    writeSetting(db, 'models', { plan: { model: 'haiku-3' } });

    // The card Settings tab's words, so one gone model never reads two ways.
    expect(warningOf('plan')).toBe('Plan uses haiku-3, which Claude Code no longer offers. Plan will not start until you pick another.');
  });
});

// The cells of the engine and preset table: what a Delivery card costs on each, from this project's own
// runs only.
describe('the preset cells', () => {
  const cards = () => modelsFor(db, OFFERS).grid.flatMap((one) => one.cells);
  const card = (name: string) => cards().find((one) => one.name === name);
  const mine = (offers = OFFERS) => modelsFor(db, offers).mine;
  const line = (name: string, offers = OFFERS) => mine(offers).find((one) => one.name === name);
  // Five cards, each run once through every agent step of Delivery on the rows of one preset, with the
  // cost each step reported.
  const fiveCards = (preset: 'light' | 'default' | 'heavy', costs: Record<string, number>) => {
    const rows = presetRows(preset, 'claude-code');
    for (let i = 1; i <= 5; i += 1) {
      const key = `${preset.toUpperCase()}-${i}`;
      db.prepare('INSERT INTO cards (key, board, stage, title) VALUES (?, ?, ?, ?)').run(key, 'delivery', 'closed', key);
      for (const [phase, cost] of Object.entries(costs)) {
        const { model, effort } = rows[phase as keyof typeof rows];
        db.prepare(
          `INSERT INTO runs (card_key, phase, engine, model, asked_model, effort, state, resumed, cost_estimate, started_at, ended_at)
           VALUES (?, ?, 'claude-code', ?, ?, ?, 'complete', 0, ?, '2026-10-01T10:00:00.000Z', '2026-10-01T10:03:00.000Z')`,
        ).run(key, phase, model, model, effort, cost);
      }
    }
    // A run's end moves the board version, which is what tells the cached figures to read again.
    bumpVersion(db);
  };
  const LIGHT = { refine: 0.02, plan: 0.08, implement: 0.06, qa: 0.03, wrapup: 0.01 };

  it('lists the three built-in presets in the table, and the saved ones apart', () => {
    saveProjectModels(db, posted({ save: 'Evenings' }), OFFERS);

    expect(cards().map((one) => one.name)).toEqual(['light', 'default', 'heavy']);
    expect(mine()).toEqual([{ name: 'Evenings', runsOn: 'Claude Code', active: true }]);
  });

  it('costs each preset from the runs of cards on its rows', () => {
    fiveCards('light', LIGHT);
    // Balanced shares refine and plan with Light, so those two come from the Light cards.
    fiveCards('default', { implement: 0.3, qa: 0.15, wrapup: 0.05 });

    expect(card('light')?.estimate?.costUsd).toBeCloseTo(0.2);
    expect(card('default')?.estimate?.costUsd).toBeCloseTo(0.6);
    expect(card('default')?.estimate).toMatchObject({ from: 'history', runs: 5 });
  });

  // What Implement runs names each built-in cell, with no effort where the model id holds it, and a
  // closed engine names nothing it cannot run.
  it('names what Implement runs on each built-in cell of an engine that answered', () => {
    const grid = modelsFor(db, OFFERS, { ready: true }, ['codex']).grid;
    const uses = (vendor: string) => grid.find((one) => one.vendor === vendor)?.cells.map((one) => one.uses);

    expect(uses('claude-code')).toEqual(['sonnet · low', 'sonnet · medium', 'opus · high']);
    expect(uses('codex')).toEqual([undefined, undefined, undefined]);
  });

  // No figure is better than one made up: a preset with a step nobody measured shows none at all.
  it('gives no figure without measured runs of every step', () => {
    expect(cards().every((one) => one.estimate === undefined)).toBe(true);

    fiveCards('default', { implement: 0.3, qa: 0.15 });
    expect(card('default')?.estimate).toBeUndefined();
    expect(card('heavy')?.estimate).toBeUndefined();
  });

  // Each engine's row is costed on that engine: the Claude Code runs give Codex no figure, and a closed
  // row gets none.
  it('costs a built-in cell on the engine of its row only', () => {
    fiveCards('light', LIGHT);
    const grid = modelsFor(db, OFFERS, { ready: true }, ['codex']).grid;
    const light = (vendor: string) => grid.find((one) => one.vendor === vendor)?.cells.find((one) => one.name === 'light')?.estimate?.costUsd;

    expect(light('claude-code')).toBeCloseTo(0.2);
    expect(light('codex')).toBeUndefined();
  });

  // A saved preset lives in its own list, so an engine only a saved preset runs on gets no table row.
  it('draws no row for an engine only a saved preset runs on', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
    writeSetting(db, 'savedPresets', [{ name: 'Old', models: Object.fromEntries(ACTIONS.map((action) => [action, { engine: 'cursor#work', model: 'composer-2.5' }])) }]);

    expect(modelsFor(db, OFFERS).grid.map((one) => one.vendor)).toEqual(['claude-code']);
    expect(line('Old')?.runsOn).toBe('Cursor');
  });

  // A saved preset can run a step on another vendor, and that step counts only the runs made there.
  it('costs a saved preset on the vendor each of its rows runs on', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
    writeSetting(db, 'models', { implement: { engine: 'cursor#work', model: 'composer-2.5' } });
    saveProjectModels(db, posted({ save: 'Mixed' }), WITH_CURSOR);
    const { effort } = modelsFor(db, WITH_CURSOR).rows.find((one) => one.action === 'implement')!.resolved;
    fiveCards('default', { refine: 0.02, plan: 0.08, qa: 0.03, wrapup: 0.01 });
    for (let i = 1; i <= 5; i += 1) {
      db.prepare(
        `INSERT INTO runs (card_key, phase, engine, model, asked_model, effort, state, resumed, cost_estimate, started_at, ended_at)
         VALUES (?, 'implement', 'cursor#work', 'composer-2.5', 'composer-2.5', ?, 'complete', 0, 0.06, '2026-10-01T10:00:00.000Z', '2026-10-01T10:03:00.000Z')`,
      ).run(`DEFAULT-${i}`, effort);
    }
    bumpVersion(db);

    expect(line('Mixed', WITH_CURSOR)?.estimate?.costUsd).toBeCloseTo(0.2);
  });

  // A saved line always names the engines its phases run on, in the order the Engines page lists them.
  it('names every engine a saved preset runs on, one or several', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
    saveProjectModels(db, posted({ save: 'Plain' }), WITH_CURSOR);
    saveProjectModels(db, posted({ action: 'implement', engine: 'cursor#work', model: 'composer-2.5' }), WITH_CURSOR);
    saveProjectModels(db, posted({ save: 'Mixed' }), WITH_CURSOR);

    expect(mine(WITH_CURSOR).map((one) => [one.name, one.runsOn])).toEqual([
      ['Plain', 'Claude Code'],
      ['Mixed', 'Claude Code and Cursor'],
    ]);
  });

  it('marks the chosen preset in use, one at a time', () => {
    saveProjectModels(db, posted({ preset: 'heavy' }), OFFERS);
    expect(cards().filter((one) => one.active).map((one) => one.name)).toEqual(['heavy']);

    saveProjectModels(db, posted({ save: 'Evenings' }), OFFERS);
    expect(cards().filter((one) => one.active)).toEqual([]);
    expect(mine().filter((one) => one.active).map((one) => one.name)).toEqual(['Evenings']);

    // A changed phase keeps the preset in use and counts as one change against it.
    saveProjectModels(db, posted({ action: 'plan', field: 'effort', value: 'low' }), OFFERS);
    expect(line('Evenings')?.active).toBe(true);
    expect(modelsFor(db, OFFERS).changes).toBe(1);
  });

  it('adds a line per saved preset, costed on the rows it saved', () => {
    fiveCards('light', LIGHT);
    saveProjectModels(db, posted({ preset: 'light' }), OFFERS);
    saveProjectModels(db, posted({ save: 'Evenings' }), OFFERS);
    saveProjectModels(db, posted({ preset: 'heavy' }), OFFERS);

    expect(card('Evenings')).toBeUndefined();
    expect(line('Evenings')?.estimate?.costUsd).toBeCloseTo(0.2);
  });
});

// The combined picker of Settings, Models writes an engine with its model, and Remove takes a step's
// own value away so it follows the preset again.
describe('a step picked with the picker', () => {
  const CODEX = { id: 'codex#work', label: 'Codex work', vendor: 'codex' as const, configDir: '/tmp/nolzu-models-codex' };
  const BOTH = { ...OFFERS, codex: ['gpt-5.6-terra', 'gpt-5.6-sol'] };

  it('writes the engine and the model in one post', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

    expect(saveProjectModels(db, posted({ action: 'plan', engine: 'codex#work', model: 'gpt-5.6-sol' }), BOTH)).toEqual({ ok: true, message: null });
    expect(getSetting(db, 'models').plan).toEqual({ engine: 'codex#work', model: 'gpt-5.6-sol', effort: 'medium' });
  });

  it('refuses an engine without its model, and a model the engine does not offer', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

    expect(saveProjectModels(db, posted({ action: 'plan', engine: 'codex#work' }), BOTH)).toEqual({ ok: false, message: 'Pick a model with the engine. A model name means nothing under another engine.' });
    expect(saveProjectModels(db, posted({ action: 'plan', engine: 'codex#work', model: 'opus' }), BOTH)).toMatchObject({ ok: false, message: expect.stringContaining('opus is gone.') });
    expect(saveProjectModels(db, posted({ action: 'plan', engine: 'codex#gone', model: 'gpt-5.6-sol' }), BOTH)).toMatchObject({ ok: false });
    expect(getSetting(db, 'models')).toEqual({});
  });

  it('keeps the effort the step already had when a pick changes its model', () => {
    saveProjectModels(db, posted({ action: 'plan', field: 'effort', value: 'high' }), OFFERS);
    saveProjectModels(db, posted({ action: 'plan', engine: 'claude-code', model: 'opus' }), OFFERS);

    expect(getSetting(db, 'models').plan).toMatchObject({ model: 'opus', effort: 'high' });
  });

  // Picking what the preset already runs is no exception, so nothing is stored.
  it('stores nothing for a pick that matches the preset', () => {
    saveProjectModels(db, posted({ action: 'plan', engine: 'claude-code', model: 'sonnet' }), OFFERS);

    expect(getSetting(db, 'models')).toEqual({});
  });

  it('takes the step back to the preset on reset, and leaves the other steps alone', () => {
    saveProjectModels(db, posted({ action: 'plan', engine: 'claude-code', model: 'opus' }), OFFERS);
    saveProjectModels(db, posted({ action: 'qa', field: 'effort', value: 'high' }), OFFERS);

    expect(saveProjectModels(db, posted({ action: 'plan', reset: '1' }), OFFERS)).toEqual({ ok: true, message: null });
    expect(getSetting(db, 'models')).toEqual({ qa: { engine: 'claude-code', model: 'sonnet', effort: 'high' } });
    expect(saveProjectModels(db, posted({ action: 'dream', reset: '1' }), OFFERS)).toMatchObject({ ok: false });
  });

  it('hands the picker every profile with the models it offers', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

    expect(modelsFor(db, BOTH).choices).toEqual([
      { id: 'claude-code', label: 'Claude Code', models: KNOWN, effortInName: false },
      { id: 'codex#work', label: 'Codex work', models: ['gpt-5.6-terra', 'gpt-5.6-sol'], effortInName: false },
    ]);
  });

  // A move to another engine stores the preset's effort with its model, so the row runs what it shows.
  it('stores the effort an engine pick sends with its model, and refuses one that is no effort', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);

    expect(saveProjectModels(db, posted({ action: 'plan', engine: 'codex#work', model: 'gpt-5.6-sol', effort: 'high' }), BOTH)).toEqual({ ok: true, message: null });
    expect(getSetting(db, 'models').plan).toEqual({ engine: 'codex#work', model: 'gpt-5.6-sol', effort: 'high' });
    expect(saveProjectModels(db, posted({ action: 'plan', engine: 'codex#work', model: 'gpt-5.6-sol', effort: 'max' }), BOTH)).toMatchObject({ ok: false });
  });
});

// One engine for a built-in preset, the count of phases that differ from the chosen preset, and the
// bar's Discard and Update.
describe('the engine choice and the changes', () => {
  const CODEX = { id: 'codex', label: 'Codex', vendor: 'codex' as const, configDir: null };
  const ALL = { ...OFFERS, codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'], cursor: ['composer-2.5', 'gpt-5.3-codex', 'claude-opus-5-5-high'] };
  const view = (offers: typeof ALL | typeof OFFERS = ALL, wall: { ready: true } | typeof NO_WALL = { ready: true }) => modelsFor(db, offers, wall);
  const rowOf = (action: string, offers: typeof ALL | typeof OFFERS = ALL) => view(offers).rows.find((one) => one.action === action)!;

  beforeEach(() => writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]));

  const vendors = (models: ReturnType<typeof view>) => models.grid.map((one) => one.vendor);
  const engines = (models: ReturnType<typeof view>) => models.grid.map(({ vendor, why }) => ({ vendor, why }));

  // Cursor has models here but no login, so it is not listed until it has one.
  it('lists the engines with a login that answered models, in the engine order', () => {
    expect(engines(view())).toEqual([
      { vendor: 'claude-code', why: null },
      { vendor: 'codex', why: null },
    ]);
    expect(vendors(view(OFFERS))).toEqual(['claude-code']);

    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR, CODEX]);
    expect(vendors(view())).toEqual(['claude-code', 'codex', 'cursor']);
  });

  // The menu's "3 found" counts the engines on PATH, so the choice lists the same ones and names why
  // one cannot take the preset yet, instead of leaving it out.
  it('lists every engine found on PATH, closed with the reason when it cannot take the preset', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
    const found = modelsFor(db, { ...OFFERS, cursor: [] }, { ready: true }, ['claude-code', 'cursor', 'codex']);

    expect(engines(found)).toEqual([
      { vendor: 'claude-code', why: null },
      { vendor: 'codex', why: 'Codex has no login yet.' },
      { vendor: 'cursor', why: 'Cursor answered no models.' },
    ]);
  });

  // The row selects keep the same order, whichever engine the preset runs on.
  it('orders the picker profiles like the engine choice, with the preset engine kept in its place', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR, CODEX]);
    saveProjectModels(db, posted({ presetEngine: 'cursor' }), ALL);

    expect(view().choices.map((one) => [one.id, one.effortInName])).toEqual([
      ['claude-code', false],
      ['codex', false],
      ['cursor#work', true],
    ]);
  });

  // An engine pick in a row lands on the preset's row for that phase on that engine, not its first model.
  it('hands each row the preset\'s model and effort on every engine', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR, CODEX]);
    saveProjectModels(db, posted({ preset: 'heavy' }), ALL);
    saveProjectModels(db, posted({ presetEngine: 'cursor' }), ALL);

    expect(rowOf('plan').presetPicks).toEqual({
      'cursor#work': { model: 'claude-opus-5-5-high', effort: 'high' },
      'claude-code': { model: 'opus', effort: 'high' },
      codex: presetRows('heavy', 'codex').plan,
    });
  });

  // Cursor reads the effort off the model id and the row draws no effort select, so an effort left
  // over from another preset cannot mark a phase changed that shows the preset's engine and model.
  it('counts no change on an engine that keeps the effort in the model name', () => {
    writeSetting(db, 'engineProfiles', [CURSOR, DEFAULT_PROFILE]);
    saveProjectModels(db, posted({ preset: 'heavy' }), ALL);
    saveProjectModels(db, posted({ save: 'Nights' }), ALL);
    saveProjectModels(db, posted({ action: 'refine', engine: 'cursor#work', model: 'composer-2.5' }), ALL);
    saveProjectModels(db, posted({ preset: 'default' }), ALL);

    expect(rowOf('refine')).toMatchObject({ changed: false, resolved: { engine: 'cursor#work', model: 'composer-2.5', effort: 'low' } });
    expect(view().changes).toBe(0);
    expect(getSetting(db, 'models')).toEqual({});
    // A stored effort from before is read past as well.
    writeSetting(db, 'models', { refine: { engine: 'cursor#work', effort: 'medium' } });
    expect(view().changes).toBe(0);
  });

  it('moves every phase to the chosen engine\'s own models for the preset, with nothing changed', () => {
    saveProjectModels(db, posted({ preset: 'heavy' }), ALL);
    expect(saveProjectModels(db, posted({ presetEngine: 'codex' }), ALL)).toEqual({ ok: true, message: null });

    const models = view();
    expect([models.presetEngine, models.changes, models.chosen]).toEqual(['codex', 0, null]);
    for (const row of models.rows) expect(row.resolved, row.action).toMatchObject({ engine: 'codex', ...presetRows('heavy', 'codex')[row.action] });
    expect(getSetting(db, 'models')).toEqual({});
    // The machine's logins keep their order: the choice is this project's alone.
    expect(getSetting(db, 'engineProfiles').map((one) => one.id)).toEqual(['claude-code', 'codex']);
  });

  it('refuses an engine that is not found, and any engine on a saved preset', () => {
    expect(saveProjectModels(db, posted({ presetEngine: 'cursor' }), ALL)).toMatchObject({ ok: false, message: expect.stringContaining('Nolzu found no Cursor login') });
    saveProjectModels(db, posted({ save: 'Evenings' }), ALL);
    expect(saveProjectModels(db, posted({ presetEngine: 'codex' }), ALL)).toEqual({
      ok: false,
      message: 'Evenings keeps the engine it saved for each phase. Pick a built-in preset to put every phase on one engine.',
    });
    expect(getSetting(db, 'presetEngine')).toBeNull();
  });

  // One cell of the table picks the engine and the preset together.
  const inUse = () => [
    ...view().grid.flatMap((row) => row.cells.filter((one) => one.active).map((one) => `${one.name} on ${row.vendor}`)),
    ...view().mine.filter((one) => one.active).map((one) => `${one.name} on ${one.runsOn}`),
  ];

  it('moves the preset and its engine in one post, off a saved preset too', () => {
    saveProjectModels(db, posted({ save: 'Evenings' }), ALL);
    expect(inUse()).toEqual(['Evenings on Claude Code']);

    expect(saveProjectModels(db, posted({ preset: 'heavy', presetEngine: 'codex' }), ALL)).toEqual({ ok: true, message: null });
    expect([getSetting(db, 'modelPreset'), getSetting(db, 'presetEngine'), view().chosen]).toEqual(['heavy', 'codex', null]);
    expect(inUse()).toEqual(['heavy on codex']);
    for (const row of view().rows) expect(row.resolved, row.action).toMatchObject({ engine: 'codex', ...presetRows('heavy', 'codex')[row.action] });
  });

  it('refuses a preset on an engine that is not found, and writes nothing', () => {
    expect(saveProjectModels(db, posted({ preset: 'heavy', presetEngine: 'cursor' }), ALL)).toMatchObject({ ok: false, message: expect.stringContaining('Nolzu found no Cursor login') });
    expect([getSetting(db, 'modelPreset'), getSetting(db, 'presetEngine')]).toEqual(['default', null]);
  });

  it('draws the three built-in presets in every engine row, closed where the engine cannot take them', () => {
    const grid = modelsFor(db, ALL, { ready: true }, ['cursor']).grid;

    expect(grid.map((row) => [row.vendor, row.why, row.cells.map((one) => one.name)])).toEqual([
      ['claude-code', null, ['light', 'default', 'heavy']],
      ['codex', null, ['light', 'default', 'heavy']],
      ['cursor', 'Cursor has no login yet.', ['light', 'default', 'heavy']],
    ]);
  });

  // A preset that mixes two engines belongs to neither row: it is one line of Your presets, naming both.
  it('lists a saved preset that mixes engines once, apart from the engine rows', () => {
    saveProjectModels(db, posted({ preset: 'light', presetEngine: 'codex' }), ALL);
    saveProjectModels(db, posted({ action: 'plan', engine: 'claude-code', model: 'opus' }), ALL);
    saveProjectModels(db, posted({ save: 'Nights' }), ALL);

    expect(view().mine).toEqual([{ name: 'Nights', runsOn: 'Claude Code and Codex', active: true }]);
    for (const row of view().grid) expect(row.cells.map((one) => one.name), row.vendor).toEqual(['light', 'default', 'heavy']);
  });

  // Fifteen saved presets are fifteen lines in saved order, and the table keeps its three cells a row.
  it('keeps fifteen saved presets out of the table', () => {
    const names = Array.from({ length: 15 }, (_, i) => `Preset ${i + 1}`);
    writeSetting(db, 'savedPresets', names.map((name) => ({ name, models: {} })));

    expect(view().mine.map((one) => one.name)).toEqual(names);
    expect(view().grid.flatMap((row) => row.cells)).toHaveLength(view().grid.length * 3);
  });

  // The first phase on Claude Code, then half on Codex and half on Cursor: the line names all three in
  // the order of the Engines page. Seventeen phases, so the first one keeps the other two even.
  it('names the engines of a saved preset in the order of the Engines page', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR, CODEX]);
    const table = Object.fromEntries(
      ACTIONS.map((action, i) => [
        action,
        i === 0 ? { engine: 'claude-code', model: 'sonnet', effort: 'medium' } : i % 2 === 0 ? { engine: 'cursor#work', model: 'composer-2.5' } : { engine: 'codex', model: 'gpt-5.6-terra', effort: 'medium' },
      ]),
    );
    writeSetting(db, 'savedPresets', [{ name: 'Halves', models: table }]);

    expect(ACTIONS).toHaveLength(17);
    expect(view().mine.find((one) => one.name === 'Halves')?.runsOn).toBe('Claude Code, Codex and Cursor');
  });

  // "2 changes from Heavy on Cursor": each changed phase says what the preset would run.
  it('counts the phases that differ from the preset, and Discard puts every one back', () => {
    saveProjectModels(db, posted({ preset: 'heavy' }), ALL);
    saveProjectModels(db, posted({ presetEngine: 'codex' }), ALL);
    saveProjectModels(db, posted({ action: 'plan', engine: 'claude-code', model: 'opus' }), ALL);
    saveProjectModels(db, posted({ action: 'qa', engine: 'codex', model: 'gpt-5.6-terra' }), ALL);

    expect(view().changes).toBe(2);
    expect(rowOf('plan')).toMatchObject({ changed: true, baseText: 'Codex · gpt-5.6-sol · high' });
    expect(rowOf('implement').changed).toBe(false);

    expect(saveProjectModels(db, posted({ discard: '1' }), ALL)).toEqual({ ok: true, message: null });
    expect(view().changes).toBe(0);
    expect(getSetting(db, 'models')).toEqual({});
  });

  // A change is kept per preset and engine: another engine starts from its own
  // rows, and the change comes back with the engine it was made on.
  it('keeps the changes with the preset and engine they were made on', () => {
    saveProjectModels(db, posted({ action: 'plan', engine: 'claude-code', model: 'opus' }), ALL);
    saveProjectModels(db, posted({ presetEngine: 'codex' }), ALL);
    expect(rowOf('plan').resolved).toMatchObject({ engine: 'codex', model: 'gpt-5.6-terra' });
    expect(view().changes).toBe(0);

    saveProjectModels(db, posted({ presetEngine: 'claude-code' }), ALL);
    expect(rowOf('plan')).toMatchObject({ changed: true, resolved: { engine: 'claude-code', model: 'opus', effort: 'medium' } });
    expect(view().changes).toBe(1);
  });

  // Back to Nolzu's default: one phase with Reset, the whole preset with the bar's button.
  it('puts one phase or the whole preset back to Nolzu\'s default', () => {
    saveProjectModels(db, posted({ action: 'plan', engine: 'claude-code', model: 'opus' }), ALL);
    saveProjectModels(db, posted({ action: 'qa', engine: 'codex', model: 'gpt-5.6-sol' }), ALL);
    saveProjectModels(db, posted({ action: 'refine', engine: 'claude-code', model: 'sonnet' }), ALL);
    expect(view().changes).toBe(3);

    saveProjectModels(db, posted({ action: 'plan', reset: '1' }), ALL);
    expect(view().rows.filter((one) => one.changed).map((one) => one.action)).toEqual(['refine', 'qa']);
    expect(rowOf('plan').resolved).toMatchObject({ model: 'sonnet', from: { model: 'preset' } });

    saveProjectModels(db, posted({ discard: '1' }), ALL);
    expect(view().changes).toBe(0);
    expect(getSetting(db, 'presetChoices')?.['default:claude-code']).toEqual({});
  });

  // An older Cursor row with only an effort ran the preset's model all along, so it does not become
  // the person's choice on the first write.
  it('leaves an older effort-only row on Cursor out of the person\'s choices', () => {
    writeSetting(db, 'engineProfiles', [CURSOR, DEFAULT_PROFILE]);
    writeSetting(db, 'models', { plan: { effort: 'high' }, qa: { engine: 'claude-code', model: 'opus' } });

    saveProjectModels(db, posted({ action: 'refine', reset: '1' }), ALL);

    expect(Object.keys(getSetting(db, 'models'))).toEqual(['qa']);
    expect(rowOf('plan').changed).toBe(false);
  });

  // A built-in preset never runs a model the account lacks: it takes the strongest of the same
  // family, and the row says which one it picked. It is not the person's change.
  it('picks a model the account has for a preset model it lacks, and says so', () => {
    writeSetting(db, 'engineProfiles', [CURSOR, DEFAULT_PROFILE]);
    const work = { ...ALL, cursor: ['composer-2.5', 'gpt-5.3-codex', 'claude-opus-4-7-high'] };
    saveProjectModels(db, posted({ preset: 'heavy' }), work);

    const models = view(work as typeof ALL);
    const plan = models.rows.find((one) => one.action === 'plan')!;
    expect(plan).toMatchObject({ changed: false, warning: null, resolved: { model: 'claude-opus-4-7-high' } });
    expect(plan.picked).toBe('Nolzu picked claude-opus-4-7-high: claude-opus-5-5-high is not on this account.');
    expect(models.rows.filter((one) => one.warning !== null)).toEqual([]);
    expect(models.rows.find((one) => one.action === 'refine')!.picked).toBeNull();
    expect(models.changes).toBe(0);
    // A move in another row's engine select lands on the same stand-in.
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
    expect(view(work as typeof ALL).rows.find((one) => one.action === 'plan')!.presetPicks['cursor#work']).toMatchObject({ model: 'claude-opus-4-7-high' });
  });

  // Where the wall cannot start, Cursor cannot run the read-only phases. Those rows stay red with no
  // fallback picked for them.
  it('leaves a phase the engine cannot run on that engine, with its warning', () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CURSOR]);
    saveProjectModels(db, posted({ presetEngine: 'cursor' }), ALL);
    const refine = view(ALL, NO_WALL).rows.find((one) => one.action === 'refine')!;

    expect(refine.resolved.engine).toBe('cursor#work');
    expect(refine.warning).not.toBeNull();
  });

  it('saves the phases as a new preset that is then the one in use, and updates it from the bar', () => {
    saveProjectModels(db, posted({ action: 'implement', engine: 'codex', model: 'gpt-5.6-terra' }), ALL);
    saveProjectModels(db, posted({ save: 'Evenings' }), ALL);
    expect(view()).toMatchObject({ chosen: 'Evenings', changes: 0 });
    expect(view().mine.find((one) => one.name === 'Evenings')?.runsOn).toBe('Claude Code and Codex');

    saveProjectModels(db, posted({ action: 'wrapup', engine: 'claude-code', model: 'haiku' }), ALL);
    expect(rowOf('wrapup')).toMatchObject({ changed: true, baseText: 'Claude Code · sonnet · low' });
    // Reset on a saved preset gives back its own row, not the built-in one.
    saveProjectModels(db, posted({ action: 'wrapup', reset: '1' }), ALL);
    expect(rowOf('wrapup')).toMatchObject({ changed: false, resolved: { model: 'sonnet' } });
    // Where the saved preset parts from the built-in one, Reset gives back the saved row.
    saveProjectModels(db, posted({ action: 'implement', engine: 'codex', model: 'gpt-5.6-sol' }), ALL);
    saveProjectModels(db, posted({ action: 'implement', reset: '1' }), ALL);
    expect(rowOf('implement')).toMatchObject({ changed: false, resolved: { engine: 'codex', model: 'gpt-5.6-terra' } });

    saveProjectModels(db, posted({ action: 'wrapup', engine: 'claude-code', model: 'haiku' }), ALL);
    expect(saveProjectModels(db, posted({ replace: 'Evenings' }), ALL)).toEqual({ ok: true, message: null });
    expect(view().changes).toBe(0);
    expect(getSetting(db, 'savedPresets')[0]!.models.wrapup).toMatchObject({ engine: 'claude-code', model: 'haiku' });
  });

  it('names the one engine of a saved preset, and keeps the choice through a rename', () => {
    saveProjectModels(db, posted({ save: 'Evenings' }), ALL);
    expect(inUse()).toEqual(['Evenings on Claude Code']);

    saveProjectModels(db, posted({ rename: 'Evenings', name: 'Nights' }), ALL);
    expect(view().chosen).toBe('Nights');
  });

  // The saved preset's rows are not changes the person made, so picking the built-in one under it
  // leaves them behind, and the rows that no longer differ do not read as Evenings again.
  it('leaves a saved preset for the built-in one under it, with only the changes made on top', () => {
    saveProjectModels(db, posted({ action: 'implement', engine: 'codex', model: 'gpt-5.6-terra' }), ALL);
    saveProjectModels(db, posted({ save: 'Evenings' }), ALL);
    // The change went into Evenings, so Balanced is Nolzu's own again.
    expect(saveProjectModels(db, posted({ preset: 'default' }), ALL)).toEqual({ ok: true, message: null });
    expect(view()).toMatchObject({ chosen: null, preset: 'default', changes: 0 });
    expect(getSetting(db, 'models')).toEqual({});

    saveProjectModels(db, posted({ apply: 'Evenings' }), ALL);
    saveProjectModels(db, posted({ action: 'qa', field: 'effort', value: 'high' }), ALL);
    saveProjectModels(db, posted({ preset: 'default' }), ALL);
    expect(view()).toMatchObject({ chosen: null, preset: 'default', changes: 1 });
    expect(view().rows.filter((one) => one.changed).map((one) => one.action)).toEqual(['qa']);
  });

  // Remove takes the name away and nothing that runs: the phases become the person's own on the
  // built-in preset, so they come back with it after a move.
  it('keeps every phase when the chosen preset is removed', () => {
    saveProjectModels(db, posted({ action: 'implement', engine: 'codex', model: 'gpt-5.6-terra' }), ALL);
    saveProjectModels(db, posted({ save: 'Evenings' }), ALL);
    saveProjectModels(db, posted({ remove: 'Evenings' }), ALL);

    expect(view()).toMatchObject({ chosen: null, changes: 1 });
    expect(rowOf('implement').resolved).toMatchObject({ engine: 'codex', model: 'gpt-5.6-terra' });
    // The name goes too, so a preset renamed to it later is not chosen by it.
    expect(getSetting(db, 'savedPreset')).toBeNull();
    saveProjectModels(db, posted({ preset: 'heavy' }), ALL);
    saveProjectModels(db, posted({ preset: 'default' }), ALL);
    expect(rowOf('implement')).toMatchObject({ changed: true, resolved: { engine: 'codex', model: 'gpt-5.6-terra' } });
  });

  // A project from before the choice is not rewritten. Its stored rows read as changes from the
  // built-in preset on the login rows fall back to, and a table that is a saved preset opens on it.
  it('opens a project stored before the choice on what its table already says', () => {
    // A saved copy of the built-in preset does not take over a table that has nothing changed.
    const plain = Object.fromEntries(view().rows.map((one) => [one.action, { engine: one.resolved.engine, model: one.resolved.model, effort: one.resolved.effort }]));
    writeSetting(db, 'savedPresets', [{ name: 'Copy', models: plain }]);
    expect(view()).toMatchObject({ chosen: null, changes: 0 });

    writeSetting(db, 'models', { implement: { engine: 'codex', model: 'gpt-5.6-sol' }, plan: { engine: 'claude-code', model: 'opus' } });
    expect(view()).toMatchObject({ chosen: null, presetEngine: 'claude-code', changes: 2 });

    const table = Object.fromEntries(view().rows.map((one) => [one.action, { engine: one.resolved.engine, model: one.resolved.model, effort: one.resolved.effort }]));
    writeSetting(db, 'savedPresets', [{ name: 'Evenings', models: table }]);
    expect(view()).toMatchObject({ chosen: 'Evenings', changes: 0 });
    expect(getSetting(db, 'savedPreset')).toBeNull();

    // The first write keeps it chosen, so one more change is one change from Evenings.
    saveProjectModels(db, posted({ action: 'qa', field: 'effort', value: 'high' }), ALL);
    expect(view()).toMatchObject({ chosen: 'Evenings', changes: 1 });
  });
});
