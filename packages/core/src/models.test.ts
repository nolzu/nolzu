import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE } from '@nolzu/protocol';
import { ACTIONS, diffModels, everyPhaseEngines, modelsOfProfile, NO_MODELS_REASON, pickerProfiles, presetModels, presetNameProblem, PRESET_NAMES, presetProfiles, presetRows, presetStandIn, renamedActions, resolveModels, validateModelTable } from './models.ts';
import { readSetting } from './settings.ts';

// The one profile a fresh installation holds. Named on every call, because the resolver takes no
// default: three screens once resolved against a different list than the job builder did.
const ONE = [DEFAULT_PROFILE];

const KNOWN = ['haiku', 'sonnet', 'opus'];
// What each vendor offers, which is what a row is measured against. Named on every call, because
// the resolver takes no default: a default of one vendor marked every row of the other one gone
// the moment a second adapter ran.
const OFFERS = { 'claude-code': KNOWN };

describe('resolveModels', () => {
  it('takes the card over the global table over the preset, field by field', () => {
    const resolved = resolveModels({ plan: { engine: 'claude-code', model: 'opus' } }, { plan: { effort: 'high' } }, 'default', OFFERS, ONE);

    expect(resolved.plan).toMatchObject({ engine: 'claude-code', model: 'opus', effort: 'high', from: { model: 'card', effort: 'global' } });
  });

  it('lets the card win where the card and the project both name a model', () => {
    expect(resolveModels({ plan: { engine: 'claude-code', model: 'opus' } }, { plan: { model: 'haiku' } }, 'default', OFFERS, ONE).plan.model).toBe('opus');
  });

  it('falls through to the preset for an action nothing else names', () => {
    expect(resolveModels(null, {}, 'heavy', OFFERS, ONE).implement).toMatchObject({ model: 'opus', effort: 'high', from: { model: 'preset', effort: 'preset' } });
  });

  it('keeps a stored model the engine no longer offers, and marks it gone', () => {
    const plan = resolveModels({ plan: { engine: 'claude-code', model: 'sonnet-3' } }, {}, 'default', OFFERS, ONE).plan;

    expect(plan.model).toBe('sonnet-3');
    expect(plan.gone).toBe(true);
  });

  it('keeps a row whose engine this app does not know, and marks it', () => {
    const plan = resolveModels({ plan: { engine: 'codex', model: 'gpt-9' } }, {}, 'default', OFFERS, ONE).plan;

    expect(plan).toMatchObject({ engine: 'codex', model: 'gpt-9', missingProfile: true });
  });

  // Cursor runs the effort the model id names, so a stored effort would be a difference nobody can see.
  it('reads past a stored effort on an engine that keeps it in the model name', () => {
    const cursor = { id: 'cursor', label: 'Cursor', vendor: 'cursor' as const, configDir: null };
    const plan = resolveModels(null, { plan: { engine: 'cursor', effort: 'high' } }, 'light', { cursor: ['gpt-5.3-codex'] }, [cursor]).plan;

    expect(plan).toMatchObject({ model: 'gpt-5.3-codex', effort: presetRows('light', 'cursor').plan.effort, from: { effort: 'preset' } });
  });

  it('names a model and an effort for every action in every preset, so an action added later cannot be left without', () => {
    for (const preset of ['light', 'default', 'heavy'] as const) {
      for (const action of ACTIONS) {
        const row = resolveModels(null, {}, preset, OFFERS, ONE)[action];
        expect(row.model, `${preset} ${action}`).not.toBe('');
        expect(['low', 'medium', 'high']).toContain(row.effort);
      }
    }
  });

  it('gives the summary pass sonnet at low effort in every preset', () => {
    for (const preset of PRESET_NAMES) expect(presetRows(preset, 'claude-code')['extract-summary']).toEqual({ model: 'sonnet', effort: 'low' });
  });
});

describe('diffModels', () => {
  const inherited = resolveModels(null, {}, 'default', OFFERS, ONE);

  it('drops a value equal to what would be inherited and keeps one that differs', () => {
    expect(diffModels({ plan: { model: 'sonnet', effort: 'high' } }, inherited)).toEqual({ plan: { engine: 'claude-code', effort: 'high' } });
  });

  it('stores the engine with every model it stores', () => {
    expect(diffModels({ plan: { model: 'opus' } }, inherited)).toEqual({ plan: { engine: 'claude-code', model: 'opus' } });
  });

  it('removes a row set back to inherit', () => {
    expect(diffModels({ plan: {} }, inherited)).toBeNull();
  });

  it('stores an empty result as null and never as {}', () => {
    expect(diffModels({}, inherited)).toBeNull();
  });

  // Its model means nothing under this engine, so it cannot be measured against the preset. Dropping
  // it would change what the row runs, silently, while some other row was being edited.
  it('keeps a row another engine wrote, even when its values match the preset', () => {
    const foreign = { plan: { engine: 'cursor', model: 'sonnet', effort: 'medium' as const } };

    expect(diffModels(foreign, inherited)).toEqual(foreign);
  });
});

// Optimize rewrites one knowledge file and invents nothing, so it sits where the wrap-up sits in
// every preset. Read back by value, because nothing else in the suite would notice a row edited by
// hand.
it('gives Optimize the wrap-up\'s model and effort in every preset', () => {
  expect(presetRows('light', 'claude-code').optimize).toEqual({ model: 'haiku', effort: 'low' });
  expect(presetRows('default', 'claude-code').optimize).toEqual({ model: 'sonnet', effort: 'low' });
  expect(presetRows('heavy', 'claude-code').optimize).toEqual({ model: 'sonnet', effort: 'medium' });
  // Every vendor keeps that shape, so a vendor added later cannot quietly split the two rows.
  for (const vendor of ['claude-code', 'codex', 'cursor'] as const) {
    for (const preset of PRESET_NAMES) expect(presetRows(preset, vendor).optimize).toEqual(presetRows(preset, vendor).wrapup);
  }
});

/**
 * Refine and assess stay on the cheap row of every preset, on every vendor.
 *
 * Refine reads and tidies, and assess writes a sentence about one finding. Read back by value, like
 * Optimize above: they are in no cross-row pair, so nothing else in the suite would notice either row
 * edited by hand, and a person who picked Light to save money would be refining on a frontier model.
 * The cheap and the middle model of each vendor are the ones the comments in `models.ts` name.
 */
it.each(['claude-code', 'codex', 'cursor'] as const)('keeps refine and assess on the cheap row of every preset on %s', (vendor) => {
  const cheap = { 'claude-code': 'haiku', codex: 'gpt-5.6-luna', cursor: 'composer-2.5' }[vendor];
  const middle = { 'claude-code': 'sonnet', codex: 'gpt-5.6-terra', cursor: 'gpt-5.3-codex' }[vendor];

  for (const action of ['refine', 'assess'] as const) {
    expect(presetRows('light', vendor)[action], action).toEqual({ model: cheap, effort: 'low' });
    expect(presetRows('default', vendor)[action], action).toEqual({ model: cheap, effort: 'low' });
    expect(presetRows('heavy', vendor)[action], action).toEqual({ model: middle, effort: 'medium' });
  }
});

// Ask reads and answers in a read-only session: haiku on Claude Code and the small
// model of each other vendor, at low effort in every preset, so a question never runs on a frontier model.
it.each([
  ['claude-code', 'haiku'],
  ['codex', 'gpt-5.6-luna'],
  ['cursor', 'composer-2.5'],
] as const)('gives Ask the small model at low effort in every preset on %s', (vendor, small) => {
  for (const preset of PRESET_NAMES) expect(presetRows(preset, vendor).ask, preset).toEqual({ model: small, effort: 'low' });
});

// One entry per model. The one caller hands this to the fake engine as the list a vendor offers, so
// duplicates draw the same model over and over in the picker.
it('names each model of the built-in presets once', () => {
  const models = presetModels('claude-code');

  expect([...new Set(models)]).toEqual(models);
  expect([...models].sort()).toEqual(['haiku', 'opus', 'sonnet']);
});

/**
 * The five phases the other four boards run, at the weight of plan and implement.
 *
 * Architecture is the judgement planning is, and the other four are work over real code, which is
 * where implement sits. That a row exists at all for each of them, on each vendor, is the type's
 * job: `PresetRows` is a record over `ACTIONS`, so a missed row does not compile. That the model is
 * one its own vendor offers is `apps/local/src/lib/preset-models.test.ts`, measured against what
 * each vendor's own command printed, because core holds no list of what a vendor offers.
 */
it.each(['claude-code', 'codex', 'cursor'] as const)('gives the other boards phases the weight of plan and implement on %s', (vendor) => {
  for (const preset of PRESET_NAMES) {
    const rows = presetRows(preset, vendor);
    expect(rows.architecture, preset).toEqual(rows.plan);
    for (const action of ['design', 'investigate', 'research', 'pr-review'] as const) {
      expect(rows[action], `${preset} ${action}`).toEqual(rows.implement);
    }
  }
});

describe('validateModelTable', () => {
  it('takes a table of known actions with a model, an effort and the one engine', () => {
    expect(validateModelTable({ plan: { engine: 'claude-code', model: 'opus', effort: 'high' } })).toBeNull();
  });

  it.each([
    [{ review: {} }, /no action review/],
    [{ plan: { effort: 'max' } }, /low, medium, high/],
    [{ plan: { engine: 'Codex Work', model: 'gpt-9' } }, /engine profile id/],
    [{ plan: { model: '' } }, /not a model name/],
    [[], /table of actions/],
  ])('refuses %j and says why', (table, why) => {
    expect(validateModelTable(table)).toMatch(why);
  });

  // Every profile id a person can make passes, because a row of any login is one a card may store.
  it('takes a row of a second profile', () => {
    expect(validateModelTable({ plan: { engine: 'codex#work', model: 'gpt-9' } })).toBeNull();
  });
});

describe('resolveModels against the profile list', () => {
  const CLAUDE = { id: 'claude-code', label: 'Claude Code', vendor: 'claude-code', configDir: null } as const;
  const WORK = { id: 'codex-work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/codex-work' } as const;

  // Both sides of the rule. A row naming a profile the machine holds runs; a row naming one it
  // does not is marked and refused, which is the state a person reaches by removing a login.
  it('marks a row whose profile has no login, and leaves a configured one alone', () => {
    const profiles = [CLAUDE, WORK];
    const table = resolveModels(
      { plan: { engine: 'codex-work', model: 'gpt-9' }, implement: { engine: 'codex-gone', model: 'gpt-9' } },
      {},
      'default',
      OFFERS,
      profiles,
    );

    expect(table.plan.missingProfile).toBe(false);
    expect(table.implement.missingProfile).toBe(true);
    expect(table.implement.engine).toBe('codex-gone');
  });

  // A model name means nothing under a profile that is not there, so it must not also read as
  // gone: two sentences about one row would send a person to fix the wrong thing.
  it('does not call a model gone when its profile is the thing that is missing', () => {
    const table = resolveModels({ plan: { engine: 'nowhere', model: 'gpt-9' } }, {}, 'default', OFFERS, [CLAUDE]);

    expect(table.plan.missingProfile).toBe(true);
    expect(table.plan.gone).toBe(false);
  });

  it('inherits the first profile when no level names one', () => {
    const table = resolveModels(null, {}, 'default', OFFERS, [WORK, CLAUDE]);

    expect(table.plan.engine).toBe('codex-work');
    expect(table.plan.missingProfile).toBe(false);
  });

  // A row is measured against the models of its own profile, not against one list for the screen.
  it('measures each row against the list of the vendor its profile runs', () => {
    const both = { 'claude-code': KNOWN, codex: ['gpt-9'] };

    const table = resolveModels({ plan: { engine: 'codex-work', model: 'gpt-9' }, qa: { engine: 'codex-work', model: 'opus' } }, {}, 'default', both, [CLAUDE, WORK]);

    expect(table.plan.gone).toBe(false);
    expect(table.qa.gone).toBe(true);
  });

  // The engine follows the same rule as the model and the effort: the card's row wins. The other way
  // round, a card pointed at a second login runs on the project's login while the row still draws as
  // the card's own.
  it('lets the card win where the card and the project both name a login', () => {
    const both = { 'claude-code': KNOWN, codex: ['gpt-9'] };

    const table = resolveModels({ plan: { engine: 'codex-work' } }, { plan: { engine: 'claude-code' } }, 'default', both, [CLAUDE, WORK]);

    expect(table.plan.engine).toBe('codex-work');
  });

  // The picker of a row whose login is gone offers nothing at all, because nothing here knows what
  // that login runs. Offered another vendor's list, a person picks a model the row cannot run and the
  // row is still broken after they thought they had fixed it.
  it('offers no model for a profile this machine does not hold', () => {
    expect(modelsOfProfile('codex-gone', [CLAUDE], { 'claude-code': KNOWN })).toEqual([]);
  });

  // A vendor this version has no adapter for offers no list, so nothing here can call its model
  // gone. Saying it was would send a person to pick another model for a row that is fine.
  it('never calls a model gone under a vendor with no list', () => {
    const table = resolveModels({ plan: { engine: 'codex-work', model: 'gpt-9' } }, {}, 'default', OFFERS, [CLAUDE, WORK]);

    expect(table.plan).toMatchObject({ model: 'gpt-9', gone: false, missingProfile: false });
  });
});

// What a resume does: the session lives inside one login, so the table is read under that profile
// and a row chosen under another one has nothing to say about this run.
describe('resolveModels pinned to one profile', () => {
  const CLAUDE = { id: 'claude-code', label: 'Claude Code', vendor: 'claude-code', configDir: null } as const;
  const WORK = { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/codex-work' } as const;
  // The Codex list holds what the built-in preset names, as a real one does, plus a model nobody's
  // preset asks for.
  const BOTH = { 'claude-code': KNOWN, codex: ['gpt-5.6-terra', 'gpt-9'] };

  it('skips a row of another profile and takes the level below it', () => {
    const table = resolveModels(null, { plan: { engine: 'codex#work', model: 'gpt-9' } }, 'default', BOTH, [CLAUDE, WORK], 'claude-code');

    expect(table.plan).toMatchObject({ engine: 'claude-code', model: 'sonnet', gone: false, from: { model: 'preset' } });
  });

  it('takes a row that names the profile it is pinned to', () => {
    const table = resolveModels(null, { plan: { engine: 'codex#work', model: 'gpt-9' } }, 'default', BOTH, [CLAUDE, WORK], 'codex#work');

    expect(table.plan).toMatchObject({ engine: 'codex#work', model: 'gpt-9', gone: false });
  });

  // Per-vendor preset rows closed this. A pin to a Codex login falls through to the Codex rows of the
  // preset, so the run starts on a model that login can run instead of being refused on a Claude alias.
  it('falls through to the preset rows of the pinned profile\'s own vendor', () => {
    const table = resolveModels(null, {}, 'default', BOTH, [CLAUDE, WORK], 'codex#work');

    expect(table.plan).toMatchObject({ engine: 'codex#work', model: 'gpt-5.6-terra', gone: false });
  });

  // A row with no profile of its own was chosen under the one every row falls back to, so the pin
  // skips it and the preset of the pinned vendor answers.
  it('skips a row with no profile of its own when the pin is another profile', () => {
    const table = resolveModels({ plan: { model: 'opus' } }, {}, 'default', BOTH, [CLAUDE, WORK], 'codex#work');

    expect(table.plan.model).toBe('gpt-5.6-terra');
  });
});

/**
 * Each vendor ships its own rows for the three built-in presets.
 *
 * The hole the engine profile column first left: a row moved to a Codex profile with no model of its
 * own fell through to a preset holding Claude aliases, read as gone, and refused the drop until
 * somebody picked a model.
 */
describe('the built-in presets per vendor', () => {
  const CLAUDE = { id: 'claude-code', label: 'Claude Code', vendor: 'claude-code', configDir: null } as const;
  const WORK = { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/tmp/codex-work' } as const;
  const DESIGN = { id: 'cursor', label: 'Cursor', vendor: 'cursor', configDir: null } as const;
  // What each vendor offers, the way a machine with all three logins answers.
  const ALL = { 'claude-code': KNOWN, codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'], cursor: ['composer-2.5', 'gpt-5.3-codex', 'claude-opus-5-5-high'] };

  it.each(PRESET_NAMES)('gives every row of a Codex profile a model that profile runs, in the %s preset', (preset) => {
    const table = resolveModels(null, {}, preset, ALL, [WORK, CLAUDE]);

    for (const action of ACTIONS) {
      expect(table[action], action).toMatchObject({ engine: 'codex#work', gone: false, missingProfile: false });
      expect(KNOWN, action).not.toContain(table[action].model);
    }
  });

  it.each(PRESET_NAMES)('gives every row of a Cursor profile a model that profile runs, in the %s preset', (preset) => {
    const table = resolveModels(null, {}, preset, ALL, [DESIGN, CLAUDE]);

    for (const action of ACTIONS) expect(table[action], action).toMatchObject({ engine: 'cursor', gone: false, missingProfile: false });
  });

  // An account can have the frontier model turned off. The preset takes the
  // strongest one of the same family the account has, and says which one it replaced.
  it('gives a gone preset model the strongest one of its family on this account, and says so', () => {
    const work = { ...ALL, cursor: ['composer-2.5', 'gpt-5.3-codex', 'claude-opus-4-7', 'claude-opus-4-8-high', 'claude-opus-4-9'] };
    const table = resolveModels(null, {}, 'heavy', work, [DESIGN]);

    expect(table.plan).toMatchObject({ model: 'claude-opus-4-8-high', insteadOf: 'claude-opus-5-5-high', gone: false, from: { model: 'preset' } });
    expect(table.refine.insteadOf).toBeUndefined();
  });

  it('steps down to the next preset model when the family is missing, and keeps a person\'s own pick', () => {
    const bare = { ...ALL, cursor: ['composer-2.5', 'gpt-5.3-codex'] };

    expect(resolveModels(null, {}, 'heavy', bare, [DESIGN]).plan).toMatchObject({ model: 'gpt-5.3-codex', insteadOf: 'claude-opus-5-5-high' });
    // A person's pick is theirs: it stays and reads as gone.
    expect(resolveModels(null, { plan: { engine: 'cursor', model: 'claude-opus-5-5-high' } }, 'heavy', bare, [DESIGN]).plan).toMatchObject({ model: 'claude-opus-5-5-high', gone: true });
    expect(presetStandIn('cursor', 'claude-opus-5-5-high', ['kimi-k2.7-code'])).toBeNull();
    expect(presetStandIn('cursor', 'claude-opus-5-5-high', undefined)).toBeNull();
    expect(presetStandIn('codex', 'gpt-5.6-sol', ['gpt-5.6-terra', 'gpt-5.7-sol'])).toBe('gpt-5.7-sol');
    // The newest version wins, whatever order the list holds them in.
    expect(presetStandIn('cursor', 'claude-opus-5-5-high', ['claude-opus-4-7-high', 'claude-opus-4-10-high', 'claude-opus-4-9-high'])).toBe('claude-opus-4-10-high');
    // A person's own pick that the account has is not a stand-in.
    expect(resolveModels(null, { plan: { engine: 'cursor', model: 'composer-2.5' } }, 'heavy', bare, [DESIGN]).plan.insteadOf).toBeUndefined();
  });

  // Two vendors in one table. The row that moved keeps its own vendor's model and the rest stay
  // where they were.
  it('answers a row moved to another profile with that vendor\'s rows, and leaves the others alone', () => {
    const table = resolveModels(null, { plan: { engine: 'codex#work' } }, 'default', ALL, [CLAUDE, WORK]);

    expect(table.plan).toMatchObject({ engine: 'codex#work', model: 'gpt-5.6-terra', gone: false });
    expect(table.implement).toMatchObject({ engine: 'claude-code', model: 'sonnet', gone: false });
  });

  it('answers no vendor at all with the Claude Code rows', () => {
    for (const preset of PRESET_NAMES) expect(presetRows(preset, undefined), preset).toEqual(presetRows(preset, 'claude-code'));
  });

  // Heavy has to cost more than light somewhere, or the three buttons say nothing. Cursor carries
  // the effort inside the model id, so for that vendor the model is where it shows.
  it('moves something between light and heavy for every vendor', () => {
    for (const vendor of ['claude-code', 'codex', 'cursor'] as const) {
      const light = presetRows('light', vendor).implement;
      const heavy = presetRows('heavy', vendor).implement;
      expect(`${light.model} ${light.effort}`, vendor).not.toBe(`${heavy.model} ${heavy.effort}`);
    }
  });
});

describe('presetNameProblem', () => {
  it('takes a name a person typed', () => {
    expect(presetNameProblem('Evenings', ['Mornings'])).toBeNull();
    // The stored name is the trimmed one, so the check measures the trimmed one too.
    expect(presetNameProblem('  Evenings  ', ['Mornings'])).toBeNull();
  });

  // Only a real slash or backslash is refused: brackets, a dash and dots read as no folder.
  it.each(['Cursor (custom-heavy)', 'a-b', 'v1.2', 'Mine: fast', 'a|b'])('takes %j, which holds no slash', (name) => {
    expect(presetNameProblem(name, [...PRESET_NAMES, 'Mornings'])).toBeNull();
  });

  // The upper boundary from the side that is allowed. Refused at exactly forty, the sentence turns a
  // person away from a name of the length it tells them they may use.
  it('takes a name of exactly forty characters, the length the refusal allows', () => {
    expect(presetNameProblem('x'.repeat(40), [...PRESET_NAMES, 'Mornings'])).toBeNull();
  });

  it.each([
    ['', /needs a name/],
    ['   ', /needs a name/],
    ['Mornings', /already a preset called Mornings/],
    ['light', /already a preset called light/],
    // The screen draws the built-in three with a capital, so these two would read the same.
    ['Default', /already a preset called Default/],
    ['MORNINGS', /already a preset called MORNINGS/],
    ['home/work', /cannot hold a slash/],
    ['home\\work', /cannot hold a slash/],
    ['x'.repeat(41), /40 characters or less/],
  ])('refuses %j and says why', (name, why) => {
    expect(presetNameProblem(name, [...PRESET_NAMES, 'Mornings'])).toMatch(why);
  });
});

describe('pickerProfiles', () => {
  const CLAUDE = { id: 'claude-code', label: 'Claude Code', vendor: 'claude-code', configDir: null } as const;
  const WORK = { id: 'cursor-work', label: 'Cursor (Work)', vendor: 'cursor', configDir: '/tmp/cursor-work' } as const;

  // A profile whose vendor answered no models stays in the picker, named and closed, so a person
  // learns why it cannot be picked instead of not seeing it at all.
  it('keeps a profile with no models, with the reason', () => {
    expect(pickerProfiles([CLAUDE, WORK], OFFERS)).toEqual([
      { id: 'claude-code', label: 'Claude Code', models: KNOWN },
      { id: 'cursor-work', label: 'Cursor (Work)', models: [], reason: NO_MODELS_REASON },
    ]);
    expect(pickerProfiles([WORK], { cursor: [] })[0]?.reason).toBe(NO_MODELS_REASON);
  });

  it('gives a profile with models no reason', () => {
    expect(pickerProfiles([CLAUDE], OFFERS)[0]).not.toHaveProperty('reason');
  });
});

// Design was called mockups before. A table stored then keeps its row, and nothing else of it is lost.
describe('a stored mockups row', () => {
  const OLD = { mockups: { engine: 'claude-code', model: 'opus', effort: 'high' }, plan: { model: 'haiku' } };

  it('reads under the design action', () => {
    expect(renamedActions(OLD)).toEqual({ design: OLD.mockups, plan: { model: 'haiku' } });
  });

  it('gives way to a design row stored beside it', () => {
    expect(renamedActions({ ...OLD, design: { model: 'sonnet' } })).toEqual({ design: { model: 'sonnet' }, plan: { model: 'haiku' } });
  });

  it('leaves a table without it and a value that is no table alone', () => {
    const table = { plan: { model: 'haiku' } };
    expect(renamedActions(table)).toBe(table);
    expect(renamedActions(null)).toBeNull();
    expect(renamedActions(['mockups'])).toEqual(['mockups']);
  });

  it('still resolves from the project table and the saved presets', () => {
    const project = readSetting('models', JSON.stringify(OLD));
    expect(project.fellBack).toBe(false);
    expect(resolveModels(null, project.value, 'default', OFFERS, ONE).design).toMatchObject({ model: 'opus', effort: 'high', from: { model: 'global' } });
    expect(resolveModels(null, project.value, 'default', OFFERS, ONE).plan.model).toBe('haiku');

    const saved = readSetting('savedPresets', JSON.stringify([{ name: 'Mine', models: OLD }]));
    expect(saved.fellBack).toBe(false);
    expect(saved.value[0]?.models.design).toEqual(OLD.mockups);
  });

  it('is still refused under its old name where a table is written', () => {
    expect(validateModelTable(OLD)).toMatch(/There is no action mockups/);
  });
});

// Onboarding asks for one engine that runs every phase on this machine.
describe('everyPhaseEngines', () => {
  it('names all three engines where the wall starts', () => {
    expect(everyPhaseEngines({ ready: true })).toEqual(['claude-code', 'cursor', 'codex']);
  });

  // Cursor runs Implement only without the wall.
  it('names Claude Code and Codex where the wall cannot start', () => {
    expect(everyPhaseEngines({ ready: false, reason: 'bubblewrap is not installed.' })).toEqual(['claude-code', 'codex']);
  });
});

// The engine choice of a built-in preset moves the main login of that engine to the front, which is the
// profile every row with no engine of its own resolves to.
describe('presetProfiles', () => {
  const CODEX_WORK = { id: 'codex#work', label: 'Codex work', vendor: 'codex', configDir: '/work/codex' } as const;
  const CODEX = { id: 'codex', label: 'Codex', vendor: 'codex', configDir: null } as const;

  it('keeps the stored order with no choice, or a choice this machine has no login for', () => {
    const profiles = [DEFAULT_PROFILE, CODEX_WORK];
    expect(presetProfiles(profiles, null)).toBe(profiles);
    expect(presetProfiles(profiles, 'cursor')).toBe(profiles);
    expect(presetProfiles(profiles, 'claude-code')).toBe(profiles);
  });

  // A built-in preset runs on the main login only, never a second one.
  it('puts the main login of the chosen engine first, the bare vendor id before a second login', () => {
    expect(presetProfiles([DEFAULT_PROFILE, CODEX_WORK, CODEX], 'codex').map((one) => one.id)).toEqual(['codex', 'claude-code', 'codex#work']);
    expect(presetProfiles([DEFAULT_PROFILE, CODEX_WORK], 'codex').map((one) => one.id)).toEqual(['codex#work', 'claude-code']);
  });

  it('gives every row the chosen engine\'s own models for the preset', () => {
    const table = resolveModels(null, {}, 'heavy', { 'claude-code': ['opus', 'sonnet', 'haiku'], codex: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] }, presetProfiles([DEFAULT_PROFILE, CODEX], 'codex'));
    for (const action of ACTIONS) expect(table[action], action).toMatchObject({ engine: 'codex', ...presetRows('heavy', 'codex')[action] });
  });
});
