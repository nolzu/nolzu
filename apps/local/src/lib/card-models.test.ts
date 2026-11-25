import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ACTIONS, boardFor, createQueue, NO_MODELS_REASON, presetRows } from '@nolzu/core';
import { boardSnapshot, cardModels, cardPreset, createCard, getSetting, openDatabase, saveRun, setCardModels, startRun, writeSetting } from '@nolzu/core/node';
import { cardStarts, DEFAULT_PROFILE } from '@nolzu/protocol';
import { dropOutcome, goneSentence, refuseDrop, SettingsTab, startDrag } from '@nolzu/ui';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveCardModels, settingsFor } from './card-models.ts';
import { saveProjectModels } from './project-models.ts';

const KNOWN = ['haiku', 'sonnet', 'opus'];
// What each vendor offers, as the route reads it off the engines. A row is measured against the
// list of the profile it names.
const OFFERS = { 'claude-code': KNOWN };
let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-card-models-'));
  db = openDatabase(dir);
  createCard(db, { key: 'APP-1', board: 'delivery', stage: 'plan', title: 'Add a search box' });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const patch = (body: unknown) => new Request('http://localhost/api', { method: 'PATCH', body: JSON.stringify(body) });
const said = async (response: Response) => ((await response.json()) as { message?: string }).message ?? '';

describe('settingsFor', () => {
  it('gives one row per action, with what it inherits and what the card sets', () => {
    setCardModels(db, 'APP-1', { plan: { engine: 'claude-code', model: 'opus' } });

    const settings = settingsFor(db, 'APP-1', OFFERS);

    expect(settings?.rows.map((row) => row.action)).toEqual(['refine', 'plan', 'implement', 'qa', 'wrapup', 'architecture', 'design', 'investigate', 'research', 'pr-review', 'feedback', 'optimize', 'orient', 'learn-repo', 'assess', 'ask', 'extract-summary']);
    expect(settings?.rows[1]).toMatchObject({ own: { model: 'opus' }, inherited: { model: 'sonnet', effort: 'medium' }, resolved: { model: 'opus', effort: 'medium' } });
    expect(settings?.preset).toBe('default');
    expect(settings?.rows[1]?.models).toEqual(KNOWN);
  });

  it('reads the default preset when the project names none', () => {
    expect(settingsFor(db, 'APP-1', OFFERS)?.rows[0]?.inherited).toMatchObject({ model: 'haiku', effort: 'low', from: { model: 'preset' } });
  });

  // Measured against the Codex list, every Claude model reads gone, and the tab would tell the
  // person to pick another model when nothing about the model is wrong.
  it('measures a row against its own vendor and not against the other one', () => {
    setCardModels(db, 'APP-1', { plan: { engine: 'claude-code', model: 'opus' } });

    const settings = settingsFor(db, 'APP-1', { ...OFFERS, codex: ['gpt-5.6-sol'] });

    expect(settings?.rows[1]?.resolved.gone).toBe(false);
  });

  it('is null for a card that is not there', () => {
    expect(settingsFor(db, 'APP-9', OFFERS)).toBeNull();
  });
});

describe('saveCardModels', () => {
  it('stores a model that differs, with its engine', async () => {
    const response = await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: 'opus' }), OFFERS);

    expect(response.status).toBe(200);
    expect(cardModels(db, 'APP-1')).toEqual({ plan: { engine: 'claude-code', model: 'opus' } });
  });

  it('keeps the other field of a row when one field changes', async () => {
    await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: 'opus' }), OFFERS);
    await saveCardModels(db, 'APP-1', patch({ action: 'plan', effort: 'high' }), OFFERS);

    expect(cardModels(db, 'APP-1')).toEqual({ plan: { engine: 'claude-code', model: 'opus', effort: 'high' } });
  });

  it('removes a field set back to inherit, and stores nothing when nothing is left', async () => {
    await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: 'opus' }), OFFERS);
    await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: null }), OFFERS);

    expect(cardModels(db, 'APP-1')).toBeNull();
  });

  it('stores nothing for a value equal to what the card inherits', async () => {
    writeSetting(db, 'models', { plan: { model: 'opus' } });

    await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: 'opus' }), OFFERS);

    expect(cardModels(db, 'APP-1')).toBeNull();
  });

  // The card follows the preset itself, with nothing of its own, so "follows
  // Heavy" means Heavy.
  it('moves the card onto a preset and clears every value it set', async () => {
    setCardModels(db, 'APP-1', { plan: { engine: 'claude-code', model: 'haiku' }, ask: { engine: 'claude-code', effort: 'high' } });

    expect((await saveCardModels(db, 'APP-1', patch({ preset: 'heavy' }), OFFERS)).status).toBe(200);

    expect(cardModels(db, 'APP-1')).toBeNull();
    const settings = settingsFor(db, 'APP-1', OFFERS);
    expect(settings?.preset).toBe('heavy');
    expect(settings?.rows.find((row) => row.action === 'plan')?.resolved).toMatchObject({ model: 'opus', effort: 'high', from: { model: 'preset' } });
    expect(settings?.rows.find((row) => row.action === 'ask')?.resolved).toMatchObject({ model: 'haiku', effort: 'low' });
  });

  it('refuses an unknown action with 400', async () => {
    const response = await saveCardModels(db, 'APP-1', patch({ action: 'review', model: 'opus' }), OFFERS);

    expect(response.status).toBe(400);
    expect(await said(response)).toMatch(/no action review/);
  });

  it('refuses an effort word it does not know, and names the three', async () => {
    const response = await saveCardModels(db, 'APP-1', patch({ action: 'plan', effort: 'max' }), OFFERS);

    expect(response.status).toBe(400);
    expect(await said(response)).toContain('low, medium, high');
  });

  it('refuses a model the engine does not offer', async () => {
    const response = await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: 'sonnet-3' }), OFFERS);

    expect(response.status).toBe(400);
    expect(await said(response)).toMatch(/sonnet-3/);
  });

  it('refuses a preset it does not know', async () => {
    expect((await saveCardModels(db, 'APP-1', patch({ preset: 'turbo' }), OFFERS)).status).toBe(400);
  });

  // It only changes the next run, so a run that is going is no reason to refuse.
  it('takes a write on a card whose run is going', async () => {
    db.prepare("UPDATE cards SET state = 'running' WHERE key = 'APP-1'").run();

    expect((await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: 'opus' }), OFFERS)).status).toBe(200);
  });

  // A row another engine wrote is fixed by picking a model: a model name belongs to an engine, so that
  // is the choice that says which engine the row runs on.
  it('writes this version engine into the row when its model is picked, so a row of another engine can be repaired', async () => {
    setCardModels(db, 'APP-1', { plan: { engine: 'codex', model: 'gpt-9', effort: 'high' } });

    await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: null }), OFFERS);

    expect(cardModels(db, 'APP-1')).toEqual({ plan: { engine: 'claude-code', effort: 'high' } });
  });

  // Changing the effort says nothing about the engine, so it must not claim that row for this one.
  it('leaves another engine on the row when only the effort changes', async () => {
    setCardModels(db, 'APP-1', { plan: { engine: 'codex', model: 'gpt-9' } });

    await saveCardModels(db, 'APP-1', patch({ action: 'plan', effort: 'low' }), OFFERS);

    expect(cardModels(db, 'APP-1')).toEqual({ plan: { engine: 'codex', model: 'gpt-9', effort: 'low' } });
  });

  // An edit to one action leaves every other row as the card stored it.
  it('keeps the other rows as stored, even one that now equals the project value', async () => {
    setCardModels(db, 'APP-1', { plan: { engine: 'claude-code', model: 'opus', effort: 'high' } });
    writeSetting(db, 'models', { plan: { model: 'opus' } });

    await saveCardModels(db, 'APP-1', patch({ action: 'refine', effort: 'high' }), OFFERS);

    expect(cardModels(db, 'APP-1')?.plan).toEqual({ engine: 'claude-code', model: 'opus', effort: 'high' });
  });

  it('answers 404 for a card that is not there', async () => {
    expect((await saveCardModels(db, 'APP-9', patch({ action: 'plan', model: 'opus' }), OFFERS)).status).toBe(404);
  });
});

it('tells the open boards after a save, because what a move starts reads these models', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../routes/api/card/[key]/models/+server.ts', import.meta.url), 'utf8');

  expect(source).toContain('saveCardModels(database(), params.key, request, live.models())');
  expect(source).toContain('if (answer.ok) live.changed();');
});

// The card's Settings tab has the same engine profile column the Models table has.
describe('the engine profile of a card row', () => {
  const CODEX = { id: 'codex#work', label: 'Codex work', vendor: 'codex' as const, configDir: '/tmp/nolzu-card-codex' };
  const BOTH = { ...OFFERS, codex: ['gpt-9', 'gpt-9-mini'] };
  const both = () => writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  const planRow = () => settingsFor(db, 'APP-1', BOTH)?.rows.find((row) => row.action === 'plan');

  // A project folder that is not a git repository runs on Claude Code only, and the card's own row
  // says so on its Settings tab before a run is refused for it.
  it('refuses a card row on Codex when the project folder is not a git repository', () => {
    both();
    setCardModels(db, 'APP-1', { plan: { engine: 'codex#work', model: 'gpt-9' } });
    writeSetting(db, 'projectPath', '/work/recipes');
    writeSetting(db, 'repos', [{ path: 'api', base: null }]);

    expect(planRow()?.resolved.refusal).toContain('Run this phase on a Claude Code profile');

    writeSetting(db, 'repos', [{ path: '.', base: null }, { path: 'api', base: null }]);
    expect(planRow()?.resolved.refusal).toBeNull();
  });

  it('offers the profiles this version can run', () => {
    both();

    // Each with its own models, which the combined picker offers under it.
    expect(settingsFor(db, 'APP-1', BOTH)?.profiles).toEqual([
      { id: 'claude-code', label: 'Claude Code', models: KNOWN, effortInName: false },
      { id: 'codex#work', label: 'Codex work', models: ['gpt-9', 'gpt-9-mini'], effortInName: false },
    ]);
  });

  // A profile whose vendor answered no models stays in the picker, closed, with why and where to fix it.
  // Left out, a person could not tell why the engine they hold was not offered.
  it('names a profile with no models, closed, with a link to Settings, Engines', async () => {
    both();

    expect(settingsFor(db, 'APP-1', OFFERS)?.profiles).toEqual([
      { id: 'claude-code', label: 'Claude Code', models: KNOWN, effortInName: false },
      { id: 'codex#work', label: 'Codex work', models: [], reason: NO_MODELS_REASON, effortInName: false },
    ]);
    const tab = render(SettingsTab, { props: { settings: settingsFor(db, 'APP-1', OFFERS)! } }).body;
    expect(tab).toMatch(/<option value="codex#work" disabled="?"?>Codex work \(no models\)<\/option>/);
    expect(tab).toMatch(/No models from Codex work. <a href="\/settings\/engines"/);
    // Picking it stays impossible: the save refuses a model it does not offer.
    const answer = await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#work', model: 'gpt-9' }), OFFERS);
    expect(answer.status).toBe(400);
  });

  // The combined picker writes the engine and the model together. An engine alone would keep a model
  // of the engine the row is leaving.
  it('refuses an engine sent without its model, and stores nothing', async () => {
    both();

    const answer = await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#work' }), BOTH);

    expect(answer.status).toBe(400);
    expect(await said(answer)).toBe('Pick a model with the engine. A model name means nothing under another engine.');
    expect(cardModels(db, 'APP-1')).toBeNull();
  });

  it('keeps a later model of that profile on it, and the row then runs', async () => {
    both();
    await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#work', model: 'gpt-9' }), BOTH);

    await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: 'gpt-9-mini' }), BOTH);

    expect(cardModels(db, 'APP-1')?.plan).toEqual({ engine: 'codex#work', model: 'gpt-9-mini' });
    expect(planRow()?.resolved).toMatchObject({ engine: 'codex#work', model: 'gpt-9-mini', gone: false });
    expect(planRow()?.models).toEqual(['gpt-9', 'gpt-9-mini']);
  });

  it('refuses a model the row\'s profile does not offer', async () => {
    both();
    await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#work', model: 'gpt-9' }), BOTH);

    const answer = await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: 'opus' }), BOTH);

    expect(answer.status).toBe(400);
    expect(await said(answer)).toMatch(/gpt-9, gpt-9-mini/);
  });

  it('refuses a profile this machine does not hold, and stores nothing', async () => {
    const answer = await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#gone' }), BOTH);

    expect(answer.status).toBe(400);
    expect(await said(answer)).toContain('codex#gone');
    expect(cardModels(db, 'APP-1')).toBeNull();
  });

  // The tab sends one field at a time, and the route takes any JSON. A body that carries both is
  // one write to one profile, or the row would answer 200 and keep the profile it was leaving.
  it('takes an engine and a model in one write, and keeps both', async () => {
    both();

    const answer = await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#work', model: 'gpt-9' }), BOTH);

    expect(answer.status).toBe(200);
    expect(cardModels(db, 'APP-1')?.plan).toEqual({ engine: 'codex#work', model: 'gpt-9' });
    expect(planRow()?.resolved).toMatchObject({ engine: 'codex#work', model: 'gpt-9', gone: false });
  });

  it('refuses a model the profile in the same body does not offer', async () => {
    both();

    const answer = await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#work', model: 'opus' }), BOTH);

    expect(answer.status).toBe(400);
    expect(await said(answer)).toMatch(/gpt-9, gpt-9-mini/);
    expect(cardModels(db, 'APP-1')).toBeNull();
  });

  it('sets the row back to inherit with null', async () => {
    both();
    await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#work', model: 'gpt-9' }), BOTH);

    await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: null, model: null }), BOTH);

    expect(cardModels(db, 'APP-1')).toBeNull();
    expect(planRow()?.resolved.engine).toBe('claude-code');
  });
});

// Applying a named preset is a write of the project table, and a card stores only what
// differs from what it inherits, so the card's own row is not in that write and still wins.
it('keeps a card\'s own row when a named preset is applied to the project', async () => {
  const posted = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return form;
  };
  // The project plans on haiku, the card on opus, and the preset is saved with the project's own
  // row in it. The two differ, or nothing here could tell which one the card ran.
  saveProjectModels(db, posted({ action: 'plan', field: 'model', value: 'haiku' }), OFFERS);
  saveProjectModels(db, posted({ save: 'Evenings' }), OFFERS);
  await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'claude-code', model: 'opus', effort: 'high' }), OFFERS);
  // The project moves away, which is what the apply then undoes.
  saveProjectModels(db, posted({ preset: 'heavy' }), OFFERS);

  expect(saveProjectModels(db, posted({ apply: 'Evenings' }), OFFERS)).toEqual({ ok: true, message: null });

  expect(cardModels(db, 'APP-1')).toEqual({ plan: { engine: 'claude-code', model: 'opus', effort: 'high' } });
  const plan = settingsFor(db, 'APP-1', OFFERS)?.rows.find((row) => row.action === 'plan');
  expect(plan?.inherited.model).toBe('haiku');
  expect(plan?.resolved).toMatchObject({ model: 'opus', effort: 'high', from: { model: 'card', effort: 'card' } });
});

// The card's own profile goes with the rest, so the card runs exactly what
// the preset runs.
it('clears the card\'s own profile too when a preset is picked', async () => {
  const offers = { ...OFFERS, codex: ['gpt-5.6-terra', 'gpt-5.6-sol'] };
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/nolzu-card-own' }]);
  await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#work', model: 'gpt-5.6-terra' }), offers);

  await saveCardModels(db, 'APP-1', patch({ preset: 'heavy' }), offers);

  expect(cardModels(db, 'APP-1')).toBeNull();
  expect(settingsFor(db, 'APP-1', offers)?.rows.find((row) => row.action === 'plan')?.resolved).toMatchObject({ engine: 'claude-code', model: 'opus', effort: 'high' });
});

// The project's own preset is stored as nothing: the card follows the project again, rows cleared.
it('follows the project again when the project preset is picked', async () => {
  await saveCardModels(db, 'APP-1', patch({ preset: 'heavy' }), OFFERS);
  await saveCardModels(db, 'APP-1', patch({ action: 'plan', model: 'haiku' }), OFFERS);

  await saveCardModels(db, 'APP-1', patch({ preset: 'default' }), OFFERS);

  expect(cardModels(db, 'APP-1')).toBeNull();
  writeSetting(db, 'modelPreset', 'light');
  expect(settingsFor(db, 'APP-1', OFFERS)?.preset).toBe('light');
});

// The other half of the same rule, on the one-field path. Setting the effort of a row that names a
// profile leaves the profile and the model the person picked alone.
it('keeps the card\'s own profile and model when only the effort is set', async () => {
  const offers = { ...OFFERS, codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] };
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/nolzu-card-effort' }]);
  await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#work', model: 'gpt-5.6-terra' }), offers);

  await saveCardModels(db, 'APP-1', patch({ action: 'plan', effort: 'high' }), offers);

  expect(cardModels(db, 'APP-1')?.plan).toEqual({ engine: 'codex#work', model: 'gpt-5.6-terra', effort: 'high' });
});

// A card on a preset still runs the project's own rows, the exceptions that ignore every preset,
// and each row takes the preset's rows of the vendor it runs on.
it('follows its preset under the project\'s own rows, per vendor', async () => {
  const offers = { ...OFFERS, codex: ['gpt-5.6-terra', 'gpt-5.6-sol'] };
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/nolzu-card-codex' }]);
  writeSetting(db, 'models', { plan: { engine: 'codex#work', model: 'gpt-5.6-terra' } });

  await saveCardModels(db, 'APP-1', patch({ preset: 'heavy' }), offers);

  const rows = settingsFor(db, 'APP-1', offers)?.rows;
  expect(rows?.find((row) => row.action === 'plan')?.resolved).toMatchObject({ engine: 'codex#work', model: 'gpt-5.6-terra', effort: 'high' });
  expect(rows?.find((row) => row.action === 'implement')?.resolved).toMatchObject({ engine: 'claude-code', model: 'opus', effort: 'high' });
});

/**
 * A card row that names its own profile inherits that vendor's model.
 *
 * The same rule the Models screen follows. Without it the card's Settings tab named the project's
 * model, which belongs to another vendor's list, on a row the card had moved.
 */
it('names the model of the vendor the card row runs on', async () => {
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex' as const, configDir: '/tmp/nolzu-card-codex' }]);
  const offers = { ...OFFERS, codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] };
  // Stored as an older version wrote it: the engine with no model of its own.
  setCardModels(db, 'APP-1', { plan: { engine: 'codex#work' } });

  const plan = settingsFor(db, 'APP-1', offers)?.rows.find((row) => row.action === 'plan');

  expect(plan?.inherited.model).toBe('gpt-5.6-terra');
  // What the row runs, which is what the label has to name. The two can still differ when the
  // project stores a model of another vendor for this action, which is written down in the plan.
  expect(plan?.resolved.model).toBe('gpt-5.6-terra');
  // The engine column still answers its own question: the project's profile for this action.
  expect(plan?.inheritEngine).toBe(DEFAULT_PROFILE.id);
});

// The other path. A card row with no profile of its own follows the project, model and all, and the
// label says where the value came from.
it('keeps the project model on a card row with no profile of its own', () => {
  writeSetting(db, 'models', { plan: { model: 'opus' } });

  const plan = settingsFor(db, 'APP-1', OFFERS)?.rows.find((row) => row.action === 'plan');

  expect(plan?.inherited.model).toBe('opus');
  expect(plan?.inherited.from.model).toBe('global');
  expect(plan?.resolved.model).toBe('opus');
});

// On a card the built-in presets run on the engine chosen on Settings, Models, and the project's
// saved presets are offered beside them.
describe('the presets a card offers', () => {
  const offers = { ...OFFERS, codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] };
  const posted = (fields: Record<string, string>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    return form;
  };
  const row = (action: string) => settingsFor(db, 'APP-1', offers)?.rows.find((one) => one.action === action);
  // A saved preset that plans on Codex and builds on Claude Code, so a run of each phase shows which
  // table it came from.
  const saveEvenings = () => {
    saveProjectModels(db, posted({ action: 'plan', engine: 'codex', model: 'gpt-5.6-sol', effort: 'high' }), offers);
    saveProjectModels(db, posted({ save: 'Evenings' }), offers);
    saveProjectModels(db, posted({ preset: 'default' }), offers);
  };
  beforeEach(() => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex', label: 'Codex', vendor: 'codex', configDir: '/tmp/nolzu-card-presets' }]);
  });

  it('runs the built-in presets on the engine chosen for the project, and names it', async () => {
    saveProjectModels(db, posted({ presetEngine: 'codex' }), offers);
    await saveCardModels(db, 'APP-1', patch({ preset: 'heavy' }), offers);

    const settings = settingsFor(db, 'APP-1', offers);
    expect(settings).toMatchObject({ preset: 'heavy', saved: null, presetEngine: 'codex', savedPresets: [] });
    expect(row('implement')?.resolved).toMatchObject({ engine: 'codex', model: 'gpt-5.6-sol', effort: 'high', from: { model: 'preset' } });
  });

  it('lists the saved presets and applies one with its engine, model and effort per phase', async () => {
    saveEvenings();
    await saveCardModels(db, 'APP-1', patch({ action: 'qa', model: 'opus' }), offers);

    expect(settingsFor(db, 'APP-1', offers)?.savedPresets).toEqual(['Evenings']);
    expect((await saveCardModels(db, 'APP-1', patch({ preset: 'Evenings' }), offers)).status).toBe(200);

    expect(cardModels(db, 'APP-1')).toBeNull();
    expect(settingsFor(db, 'APP-1', offers)).toMatchObject({ saved: 'Evenings', preset: 'default' });
    expect(row('plan')?.resolved).toMatchObject({ engine: 'codex', model: 'gpt-5.6-sol', effort: 'high', from: { model: 'preset', effort: 'preset' } });
    expect(row('implement')?.resolved).toMatchObject({ engine: 'claude-code', model: 'sonnet', effort: 'medium' });
    // The project's own rows stay as they were.
    expect(getSetting(db, 'models')).toEqual({});
  });

  // The card holds the name, so the project moving on does not reach it, and the board starts what
  // the tab shows.
  it('keeps the saved rows when the project changes, on the tab and on the board', async () => {
    saveEvenings();
    await saveCardModels(db, 'APP-1', patch({ preset: 'Evenings' }), offers);
    saveProjectModels(db, posted({ preset: 'light' }), offers);
    saveProjectModels(db, posted({ action: 'plan', field: 'model', value: 'haiku' }), offers);

    expect(row('plan')?.resolved).toMatchObject({ engine: 'codex', model: 'gpt-5.6-sol' });
    const board = boardFor('delivery', 'pull-request');
    const card = boardSnapshot(db, { wall: { ready: true }, board, queue: createQueue(3), models: offers }).cards.find((one) => one.key === 'APP-1')!;
    expect(card.starts?.plan).toMatchObject({ engine: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  });

  it('changes one phase on top of the saved preset, and Reset puts the saved row back', async () => {
    saveEvenings();
    await saveCardModels(db, 'APP-1', patch({ preset: 'Evenings' }), offers);

    await saveCardModels(db, 'APP-1', patch({ action: 'plan', effort: 'low' }), offers);
    expect(cardModels(db, 'APP-1')).toEqual({ plan: { engine: 'codex', effort: 'low' } });
    await saveCardModels(db, 'APP-1', patch({ action: 'plan', reset: true }), offers);

    expect(cardModels(db, 'APP-1')).toBeNull();
    expect(row('plan')?.resolved).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high' });
  });

  // The tab named Balanced and sent the person to Settings, Models for rows that are Evenings'.
  it('names the saved preset the project is on for a card that follows the project', async () => {
    saveEvenings();
    saveProjectModels(db, posted({ apply: 'Evenings' }), offers);
    saveProjectModels(db, posted({ action: 'qa', field: 'effort', value: 'high' }), offers);

    expect(settingsFor(db, 'APP-1', offers)).toMatchObject({ saved: 'Evenings', preset: 'default' });
    expect(row('plan')?.follows).toMatchObject({ engine: 'codex', model: 'gpt-5.6-sol', from: { model: 'preset' } });
    // A phase the project changed on top of Evenings is still the project's.
    expect(row('qa')?.follows).toMatchObject({ effort: 'high', from: { effort: 'global' } });
    const tab = render(SettingsTab, { props: { settings: settingsFor(db, 'APP-1', offers)! } }).body;
    expect(tab).toContain('This card follows Evenings');

    // Balanced picked on the card is the built-in one, not the project's Evenings again.
    await saveCardModels(db, 'APP-1', patch({ preset: 'default' }), offers);
    expect(settingsFor(db, 'APP-1', offers)).toMatchObject({ saved: null, preset: 'default' });
  });

  it('leaves the saved preset for a built-in one', async () => {
    saveEvenings();
    await saveCardModels(db, 'APP-1', patch({ preset: 'Evenings' }), offers);

    await saveCardModels(db, 'APP-1', patch({ preset: 'default' }), offers);

    expect(settingsFor(db, 'APP-1', offers)).toMatchObject({ saved: null, preset: 'default' });
    expect(row('plan')?.resolved).toMatchObject({ engine: 'claude-code', model: 'sonnet' });
  });

  it('follows a rename on Settings, Models, and the project again once the preset is removed', async () => {
    saveEvenings();
    await saveCardModels(db, 'APP-1', patch({ preset: 'Evenings' }), offers);

    saveProjectModels(db, posted({ rename: 'Evenings', name: 'Late' }), offers);
    expect(settingsFor(db, 'APP-1', offers)?.saved).toBe('Late');

    saveProjectModels(db, posted({ remove: 'Late' }), offers);
    expect(settingsFor(db, 'APP-1', offers)?.saved).toBeNull();
    expect(row('plan')?.resolved).toMatchObject({ engine: 'claude-code', model: 'sonnet' });
    // A later preset of the same name is a new one, which the card never picked: it follows the
    // project onto it and off it again.
    saveProjectModels(db, posted({ save: 'Late' }), offers);
    saveProjectModels(db, posted({ preset: 'heavy' }), offers);
    expect(settingsFor(db, 'APP-1', offers)?.saved).toBeNull();
  });

  // Cursor reads the effort off the model id. The tab offered an effort select there, which Settings,
  // Models does not, and its note named an effort Cursor never uses.
  it('offers no effort on a Cursor row and names none in its note', async () => {
    const cursor = presetRows('heavy', 'cursor');
    const withCursor = { ...offers, cursor: [...new Set(ACTIONS.map((action) => cursor[action].model)), 'composer-2.5'] };
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'cursor', label: 'Cursor', vendor: 'cursor', configDir: '/tmp/nolzu-card-cursor' }]);
    saveProjectModels(db, posted({ presetEngine: 'cursor' }), withCursor);
    saveProjectModels(db, posted({ preset: 'heavy' }), withCursor);
    await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'cursor', model: 'composer-2.5' }), withCursor);

    const settings = settingsFor(db, 'APP-1', withCursor)!;
    expect(settings.profiles.map((one) => [one.id, one.effortInName])).toEqual([
      ['cursor', true],
      ['claude-code', false],
    ]);
    const tab = render(SettingsTab, { props: { settings } }).body;
    expect(tab).not.toContain('data-pick="effort"');
    expect(tab).toContain(`Heavy on Cursor uses ${cursor.plan.model}.`);
  });

  it('refuses a name the project has not saved', async () => {
    const response = await saveCardModels(db, 'APP-1', patch({ preset: 'Mornings' }), offers);
    expect(response.status).toBe(400);
    expect(await said(response)).toBe('There is no preset Mornings. The presets are light, default, heavy and the ones saved on Settings, Models.');
  });
});

describe('the Settings tab rows', () => {
  const row = (action: string) => settingsFor(db, 'APP-1', OFFERS)?.rows.find((one) => one.action === action);

  it('names the steps of the card board as its columns do, and marks the rest', () => {
    const settings = settingsFor(db, 'APP-1', OFFERS);

    expect(settings?.board).toBe('Delivery');
    expect(settings?.rows.filter((one) => one.step).map((one) => one.label)).toEqual(['Refine', 'Plan', 'Implement', 'QA', 'Wrap-up']);
    expect(row('ask')).toMatchObject({ step: false, label: 'Ask' });
  });

  it('resets one step so it follows the preset again, and keeps the other rows', async () => {
    setCardModels(db, 'APP-1', { plan: { engine: 'claude-code', model: 'opus', effort: 'high' }, qa: { engine: 'claude-code', effort: 'low' } });

    expect((await saveCardModels(db, 'APP-1', patch({ action: 'plan', reset: true }), OFFERS)).status).toBe(200);

    expect(cardModels(db, 'APP-1')).toEqual({ qa: { engine: 'claude-code', effort: 'low' } });
    expect(row('plan')?.own).toEqual({});
    expect(row('plan')?.resolved).toEqual(row('plan')?.follows);
    expect(row('plan')?.resolved).toMatchObject({ model: 'sonnet', effort: 'medium', from: { model: 'preset', effort: 'preset' } });
  });

  // What the changed row says the preset would use is what Reset gives back, engine included.
  it('says what the step runs once reset, under the profile the card would fall back to', async () => {
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/nolzu-card-follows' }]);
    const offers = { ...OFFERS, codex: ['gpt-5.6-terra'] };
    await saveCardModels(db, 'APP-1', patch({ action: 'plan', engine: 'codex#work', model: 'gpt-5.6-terra' }), offers);

    expect(settingsFor(db, 'APP-1', offers)?.rows.find((one) => one.action === 'plan')?.follows).toMatchObject({ engine: 'claude-code', model: 'sonnet', effort: 'medium' });
  });

  // A figure only where measured runs give one. Refine on haiku at low effort is the
  // one measured preset row; Plan has none until five first runs of it end.
  it('gives a step its estimate only where runs measured one', () => {
    expect(row('refine')?.estimate).toMatchObject({ from: 'preset' });
    expect(row('plan')?.estimate).toBeUndefined();

    for (let i = 0; i < 5; i += 1) {
      const id = startRun(db, { cardKey: 'APP-1', phase: 'plan', engine: 'claude-code', model: 'sonnet', effort: 'medium', sessionId: `s-${i}`, logPath: '', lane: null });
      saveRun(db, id, { sessionId: `s-${i}`, model: 'sonnet', costUsd: 0.12, durationMs: null, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });
    }

    expect(row('plan')?.estimate).toMatchObject({ from: 'history', runs: 5, costUsd: 0.12 });
    // What Reset gives back is costed the same way, for the changed row's sentence.
    expect(row('plan')?.followsEstimate).toEqual(row('plan')?.estimate);
  });

  it('gives a step whose model is gone no estimate', () => {
    setCardModels(db, 'APP-1', { refine: { engine: 'claude-code', model: 'claude-retired-1' } });

    expect(row('refine')?.resolved.gone).toBe(true);
    expect(row('refine')?.estimate).toBeUndefined();
  });

  // Runs that measured the gone model must not cost a row the board refuses to start.
  it('gives a gone model no estimate even when five runs measured it', () => {
    for (let i = 0; i < 5; i += 1) {
      const id = startRun(db, { cardKey: 'APP-1', phase: 'refine', engine: 'claude-code', model: 'claude-retired-1', effort: 'low', sessionId: `g-${i}`, logPath: '', lane: null });
      saveRun(db, id, { sessionId: `g-${i}`, model: 'claude-retired-1', costUsd: 0.2, durationMs: null, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });
    }
    setCardModels(db, 'APP-1', { refine: { engine: 'claude-code', model: 'claude-retired-1', effort: 'low' } });

    expect(row('refine')?.resolved.gone).toBe(true);
    expect(row('refine')?.estimate).toBeUndefined();
  });

  // The row and the board say one sentence, through one function, and the drop that would start the
  // gone model is refused.
  it('says a gone model with the sentence the board refuses the drop with, and the drop is refused', () => {
    setCardModels(db, 'APP-1', { qa: { engine: 'claude-code', model: 'sonnet-4-5' } });
    const board = boardFor('delivery', 'pull-request');
    const snapshot = boardSnapshot(db, { wall: { ready: true }, board, queue: createQueue(3), models: OFFERS });
    const qa = snapshot.stages.find((stage) => stage.id === 'qa')!;
    const card = snapshot.cards.find((one) => one.key === 'APP-1')!;
    const column = { ...qa, starts: cardStarts(qa, card) };

    const refusal = refuseDrop(column, 'forward');
    expect(refusal?.message).toBe(goneSentence('QA', 'sonnet-4-5', 'claude-code'));
    expect(dropOutcome(startDrag('APP-1'), column, () => 'forward')?.kind).toBe('refused');

    const tab = render(SettingsTab, { props: { settings: settingsFor(db, 'APP-1', OFFERS)! } }).body;
    const qaRow = /data-action="qa"[\s\S]*?(?=data-action=)/.exec(tab)?.[0] ?? '';
    expect(qaRow).toContain('data-state="refused"');
    expect(qaRow.replace(/<!--[^>]*-->/g, '').replace(/<[^>]*>/g, '')).toContain(refusal!.message);
  });

  // Five cards, each taken through every step of its board on what the preset runs it on.
  const fiveCards = (preset: 'light' | 'default' | 'heavy', cost: number, offers: Record<string, string[]> = OFFERS) => {
    writeSetting(db, 'modelPreset', preset);
    const steps = settingsFor(db, 'APP-1', offers)!.rows.filter((one) => one.step);
    for (let i = 1; i <= 5; i += 1) {
      const key = `DONE-${preset}-${i}`;
      createCard(db, { key, board: 'delivery', stage: 'closed', title: key });
      for (const step of steps) {
        const id = startRun(db, { cardKey: key, phase: step.action, engine: step.resolved.engine, model: step.resolved.model, effort: step.resolved.effort, sessionId: `${key}-${step.action}`, logPath: '', lane: null });
        saveRun(db, id, { sessionId: `${key}-${step.action}`, model: step.resolved.model, costUsd: cost, durationMs: null, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });
      }
    }
    writeSetting(db, 'modelPreset', 'default');
  };

  // The preset buttons and the column carry a figure only where runs measured it.
  it('costs a preset and each step of a card only where runs measured them', () => {
    expect(settingsFor(db, 'APP-1', OFFERS)?.presets).toEqual({});
    expect(row('plan')?.stepEstimate).toBeUndefined();

    fiveCards('default', 0.1);
    const settings = settingsFor(db, 'APP-1', OFFERS)!;

    expect(settings.presets.default?.costUsd).toBeCloseTo(0.5);
    expect(settings.presets.default).toMatchObject({ from: 'history', runs: 5 });
    expect(row('plan')?.stepEstimate).toMatchObject({ costUsd: 0.1, from: 'history', runs: 5 });
    // A preset that runs a step on another model has no measured card yet.
    expect(settings.presets.heavy).toBeUndefined();
  });

  // One model name can cost two prices on two vendors, so a step counts only the runs of its own vendor.
  it('costs a preset and a step on the vendor each row runs on', () => {
    const codex = { ...OFFERS, codex: ['gpt-9'] };
    writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/nolzu-card-codex' }]);
    writeSetting(db, 'models', { plan: { engine: 'codex#work', model: 'gpt-9' } });
    fiveCards('default', 0.1, codex);
    const settings = settingsFor(db, 'APP-1', codex)!;

    expect(settings.presets.default?.costUsd).toBeCloseTo(0.5);
    expect(settings.rows.find((one) => one.action === 'plan')?.stepEstimate).toMatchObject({ costUsd: 0.1, runs: 5 });
  });

  // The preset figure is what the card runs after a switch, which clears its own values, so they are not in it.
  it('costs a preset without the values the card set itself', () => {
    fiveCards('default', 0.1);
    setCardModels(db, 'APP-1', { plan: { engine: 'claude-code', model: 'opus' } });

    expect(settingsFor(db, 'APP-1', OFFERS)?.presets.default?.costUsd).toBeCloseTo(0.5);
    expect(row('plan')?.stepEstimate).toBeUndefined();
  });

  // Another preset is costed on the project's rows too, not on what the card set for the one it follows.
  it('costs a preset it does not follow without the values the card set itself', () => {
    fiveCards('heavy', 0.2);
    setCardModels(db, 'APP-1', { plan: { engine: 'claude-code', model: 'haiku' } });

    expect(settingsFor(db, 'APP-1', OFFERS)?.presets.heavy?.costUsd).toBeCloseTo(1);
  });

  // A pick of a saved preset clears the card's own built-in one, so the figure sits on the project's.
  it('costs a saved preset on the project preset, not on the one the card picked', async () => {
    fiveCards('default', 0.1);
    writeSetting(db, 'savedPresets', [{ name: 'Evenings', models: {} }]);
    await saveCardModels(db, 'APP-1', patch({ preset: 'heavy' }), OFFERS);

    expect(settingsFor(db, 'APP-1', OFFERS)?.presets.Evenings?.costUsd).toBeCloseTo(0.5);
  });

  // Runs measured on a retired model must not give the row a figure: the step will not start.
  it('gives a gone model no figure even where cards ran on it', () => {
    for (let i = 1; i <= 5; i += 1) {
      const key = `GONE-${i}`;
      createCard(db, { key, board: 'delivery', stage: 'closed', title: key });
      const id = startRun(db, { cardKey: key, phase: 'refine', engine: 'claude-code', model: 'claude-retired-1', effort: row('refine')!.resolved.effort, sessionId: key, logPath: '', lane: null });
      saveRun(db, id, { sessionId: key, model: 'claude-retired-1', costUsd: 0.1, durationMs: null, tokens: null, question: null, failureReason: null, failureStatus: null, state: 'complete', cardState: 'ready', retry: null });
    }
    setCardModels(db, 'APP-1', { refine: { engine: 'claude-code', model: 'claude-retired-1' } });

    expect(row('refine')?.resolved.gone).toBe(true);
    expect(row('refine')?.stepEstimate).toBeUndefined();
  });

  it('gives a step that will not start no figure', () => {
    fiveCards('default', 0.1);
    setCardModels(db, 'APP-1', { refine: { engine: 'claude-code', model: 'claude-retired-1' } });

    expect(row('refine')?.resolved.gone).toBe(true);
    expect(row('refine')?.stepEstimate).toBeUndefined();
  });
});

// A save changes the card in the address and no other. APP-1 holds its own choice and its own preset,
// so a write that landed on APP-1, or read APP-1, shows on APP-2.
describe('a save on one card leaves another card alone', () => {
  beforeEach(async () => {
    createCard(db, { key: 'APP-2', board: 'delivery', stage: 'plan', title: 'Other card' });
    await saveCardModels(db, 'APP-1', patch({ preset: 'heavy' }), OFFERS);
    setCardModels(db, 'APP-1', { plan: { engine: 'claude-code', model: 'haiku' } });
  });

  it('writes a pick to the card in the address and keeps the rows of the other', async () => {
    expect((await saveCardModels(db, 'APP-2', patch({ action: 'qa', engine: 'claude-code', model: 'opus' }), OFFERS)).status).toBe(200);

    expect(cardModels(db, 'APP-2')).toEqual({ qa: { engine: 'claude-code', model: 'opus' } });
    expect(cardModels(db, 'APP-1')).toEqual({ plan: { engine: 'claude-code', model: 'haiku' } });
  });

  it('resets the step of the card in the address only', async () => {
    setCardModels(db, 'APP-2', { plan: { engine: 'claude-code', model: 'opus' } });

    await saveCardModels(db, 'APP-2', patch({ action: 'plan', reset: true }), OFFERS);

    expect(cardModels(db, 'APP-2')).toBeNull();
    expect(cardModels(db, 'APP-1')).toEqual({ plan: { engine: 'claude-code', model: 'haiku' } });
  });

  it('moves the card in the address onto a preset and leaves the other on its own', async () => {
    setCardModels(db, 'APP-2', { qa: { engine: 'claude-code', model: 'opus' } });

    await saveCardModels(db, 'APP-2', patch({ preset: 'light' }), OFFERS);

    expect(cardPreset(db, 'APP-2')).toBe('light');
    expect(cardModels(db, 'APP-2')).toBeNull();
    expect(cardPreset(db, 'APP-1')).toBe('heavy');
    expect(cardModels(db, 'APP-1')).toEqual({ plan: { engine: 'claude-code', model: 'haiku' } });
  });

  it('shows each card its own preset and rows', () => {
    expect(settingsFor(db, 'APP-2', OFFERS)?.preset).toBe('default');
    expect(settingsFor(db, 'APP-2', OFFERS)?.rows.find((one) => one.action === 'plan')?.own).toEqual({});
    expect(settingsFor(db, 'APP-1', OFFERS)?.preset).toBe('heavy');
    expect(settingsFor(db, 'APP-1', OFFERS)?.rows.find((one) => one.action === 'plan')?.own).toEqual({ engine: 'claude-code', model: 'haiku' });
  });
});
