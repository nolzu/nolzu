import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { ACTIONS } from '@nolzu/core';
import { openDatabase, writeSetting } from '@nolzu/core/node';
import { DEFAULT_PROFILE, PHASE_HELP, phaseLabel } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { afterEach, beforeEach, expect, it } from 'vitest';
// The stub vitest aliases `$app/paths` to, by path, because the app's own types for it carry no `drawnAt`.
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
import ModelsSection from './ModelsSection.svelte';
import { modelsFor, type ModelsSection as Section } from './project-models.ts';

const OFFERS = { 'claude-code': ['haiku', 'sonnet', 'opus'], codex: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol'] };
const CODEX = { id: 'codex', label: 'Codex', vendor: 'codex', configDir: null } as const;
let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  drawnAt('/settings/models');
  dir = mkdtempSync(join(tmpdir(), 'nolzu-models-section-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Built by the real producer, so the fixture cannot drift from what the page hands over.
const section = (): Section => modelsFor(db, OFFERS, { ready: true });
const drawn = (models: Section, props: Record<string, unknown> = {}) => render(ModelsSection, { props: { models, ...props } as never }).body;
const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// The markup from the end of the tag that carries `marker` up to the next `next`, or to the end.
function part(body: string, marker: string, next: string): string {
  const at = body.indexOf(marker);
  if (at === -1) return '';
  const rest = body.slice(body.indexOf('>', at) + 1);
  const end = rest.indexOf(next);
  return end === -1 ? rest : rest.slice(0, end);
}
// One engine's row of the table, up to the next one.
const engineRow = (body: string, vendor: string) => part(body, `data-engine="${vendor}"`, 'data-engine=');
// One cell's button, from its tag to its end.
const cell = (body: string, name: string) => part(body, `data-preset="${name}"`, '</button>');
const bar = (body: string) => part(body, 'class="bar', '</section>');
// The engine, model and effort selects of one phase, in that order, each on the value it names.
const picked = (step: string, engine: string, model: string, effort: string) =>
  new RegExp(`aria-label="${step} engine"[^]*?<option value="${engine}" selected[^]*?aria-label="${step} model"[^]*?<option value="${model}" selected[^]*?aria-label="${step} effort"[^]*?<option value="${effort}" selected`);

// One table: a row per engine found, a column per built-in preset, one cell in use.
it('draws a cell per engine and preset, with the stored default as Balanced in use', () => {
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  const body = drawn(section());
  const head = part(body, 'class="gr head', '<div class="gr');

  expect(text(head)).toBe('Engine Light Balanced Heavy');
  expect(head.match(/<i class="[^"]*\bon\b/g)).toHaveLength(6);
  expect(body).toMatch(/role="radiogroup" aria-labelledby="preset-title"/);
  const claude = engineRow(body, 'claude-code');
  expect(claude).toMatch(/name="presetEngine" value="claude-code"[^]*name="preset" value="default" class="cell[^"]*" role="radio" aria-checked="true" aria-label="Balanced on Claude Code, Implement runs sonnet · medium"/);
  // Each cell names its preset and what Implement runs, so no cell is blank before a cost is known.
  expect(text(cell(claude, 'default'))).toBe('Balanced In use sonnet · medium');
  expect(text(cell(claude, 'light'))).toBe('Light sonnet · low');
  expect(text(cell(claude, 'heavy'))).toBe('Heavy opus · high');
  expect(engineRow(body, 'codex')).toMatch(/name="presetEngine" value="codex"[^]*name="preset" value="default" class="cell[^"]*" role="radio" aria-checked="false"/);
  expect(body.match(/aria-checked="true"/g)).toHaveLength(1);
  // Tab lands on the cell in use, and the arrows reach the rest.
  expect(body.match(/tabindex="0"/g)).toHaveLength(1);
  expect(cell(claude, 'default')).toBe(cell(body, 'default'));
  expect(body).not.toContain('disabled');
  expect(body).not.toContain('Your presets');
  expect(text(body)).not.toMatch(/\bDefault\b/);
  // No run measured a cost yet: the cells stay empty and one line under the table says so.
  expect(text(body)).not.toContain('No figure yet');
  expect(text(body)).toContain('Costs for a Delivery card show here once runs in this project measured them.');
  // The answer to a click in the table shows under it, not at the foot of the page.
  expect(drawn(section(), { said: 'Saved.' })).toMatch(/role="radiogroup"[^]*<p class="quiet saved[^"]*" role="status">Saved\.<\/p>[^]*id="model-phases-title"/);
});

// A figure only where runs measured it, and no made-up one.
it('prints the cost of a card where measured, and no figure where not', () => {
  const models = section();
  const measured = { ...models, grid: models.grid.map((row) => ({ ...row, cells: row.cells.map((one) => (one.name === 'default' ? { ...one, estimate: { costUsd: 0.55, lowMs: 600_000, highMs: 900_000, from: 'history' as const, runs: 5 } } : one)) })) };
  const body = drawn(measured);

  expect(cell(body, 'default')).toMatch(/<span class="cost[^"]*">about \$0\.55<\/span>/);
  expect(body).toContain('aria-label="Balanced on Claude Code, Implement runs sonnet · medium, about $0.55 a card"');
  // An unmeasured cell shows no figure, and the line under the table no longer says no run measured any.
  expect(text(cell(body, 'light'))).toBe('Light sonnet · low');
  expect(text(body)).toContain('Costs are for one Delivery card, from your own runs in this project.');
  expect(text(cell(body, 'heavy'))).not.toContain('$');
});

// The markup of Your presets, up to the status line under it.
const mine = (body: string) => part(body, 'class="own', 'role="status"');
// One engine's row and nothing of the list under the table, which follows the last row.
const rowOnly = (body: string, vendor: string) => engineRow(body, vendor).split('class="own')[0]!;

// A saved preset can mix engines, so it is a line of its own under the table and never a grid cell.
it('lists a saved preset under the table once, with every engine it runs on, and Rename and Remove in a menu', () => {
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  writeSetting(db, 'savedPresets', [{ name: 'Evenings', models: { implement: { engine: 'codex', model: 'gpt-5.6-terra', effort: 'medium' } } }]);
  const body = drawn(section());
  const list = mine(body);

  expect(body.match(/data-preset="Evenings"/g)).toHaveLength(1);
  expect(rowOnly(body, 'claude-code')).not.toContain('Evenings');
  expect(rowOnly(body, 'codex')).not.toContain('Evenings');
  expect(list).toMatch(/<h4 id="own-title"[^>]*>Your presets<span class="n[^"]*">1<\/span><\/h4>/);
  expect(list).toMatch(/role="radiogroup" aria-labelledby="own-title"/);
  expect(list).toMatch(/name="apply" value="Evenings" class="cell line[^"]*" role="radio" aria-checked="false" aria-label="Evenings, on Claude Code and Codex"/);
  expect(text(cell(list, 'Evenings'))).toBe('Evenings Claude Code and Codex');
  // A long name is cut with an ellipsis, so the whole name is on hover too.
  expect(cell(list, 'Evenings')).toMatch(/class="nm[^"]*" title="Evenings">Evenings</);
  const menu = part(list, 'class="more', '</details>');
  expect(menu).toContain('aria-label="Rename the preset Evenings"');
  expect(menu).toContain('name="remove" value="Evenings"');
});

// Fifteen saved presets are fifteen lines in saved order, each naming its engine, and the table keeps
// its three built-in cells per engine.
it('draws fifteen saved presets as fifteen lines and no grid cell', () => {
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  const names = Array.from({ length: 15 }, (_, i) => `Preset number ${i + 1} with a long name`);
  writeSetting(db, 'savedPresets', names.map((name) => ({ name, models: {} })));
  writeSetting(db, 'savedPreset', names[4]!);
  const body = drawn(section());
  const list = mine(body);

  expect([...list.matchAll(/name="apply" value="([^"]+)"/g)].map((one) => one[1])).toEqual(names);
  expect(list.match(/<span class="engs[^"]*">Claude Code<\/span>/g)).toHaveLength(15);
  expect(list.match(/aria-checked="true"/g)).toHaveLength(1);
  expect(cell(list, names[4]!)).toContain('In use');
  expect(list.match(/<details class="more/g)).toHaveLength(15);
  expect(text(list)).toMatch(/^Your presets 15 /);
  for (const vendor of ['claude-code', 'codex']) expect(rowOnly(body, vendor).match(/class="cell/g)).toHaveLength(3);
  // Every line can be reached with Tab, and nothing in the table is checked while a saved one is in use.
  expect(list).not.toContain('tabindex="-1"');
  expect(part(body, 'class="grid', 'class="own')).not.toContain('aria-checked="true"');
});

// Only engines found here, and the one in use checked.
it('lists the engines found here, with the preset in use checked on its engine', () => {
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  writeSetting(db, 'presetEngine', 'codex');
  const body = drawn(section());

  expect([...body.matchAll(/data-engine="([^"]+)"/g)].map((one) => one[1])).toEqual(['claude-code', 'codex']);
  expect(body).not.toContain('Experimental');
  expect(engineRow(body, 'codex')).toMatch(/value="default" class="cell[^"]*" role="radio" aria-checked="true"/);
  expect(engineRow(body, 'claude-code')).toMatch(/value="default" class="cell[^"]*" role="radio" aria-checked="false"/);
  expect(body).not.toContain('Cursor');
});

// Nothing is closed without a reason: an engine with no login says so beside its closed cells, and a
// saved preset in use stays in its own list.
it('closes the cells of an engine that cannot take a preset, with the reason beside them', () => {
  writeSetting(db, 'savedPresets', [{ name: 'Evenings', models: {} }]);
  writeSetting(db, 'savedPreset', 'Evenings');
  const body = drawn(modelsFor(db, OFFERS, { ready: true }, ['codex']));
  const codex = engineRow(body, 'codex');

  expect(codex.match(/role="radio" aria-checked="false"[^>]*disabled/g)).toHaveLength(3);
  expect(text(codex)).toContain('Codex has no login yet. Engines');
  expect(engineRow(body, 'claude-code')).not.toContain('disabled');
  expect(engineRow(body, 'claude-code')).toMatch(/value="light" class="cell[^"]*" role="radio" aria-checked="false"[^>]*tabindex="0"/);
  expect(mine(body)).toMatch(/value="Evenings" class="cell line[^"]*" role="radio" aria-checked="true"/);
  // A closed cell looks closed: a dashed edge and muted text, never a fade on the text.
  expect(readFileSync(new URL('./ModelsSection.svelte', import.meta.url), 'utf8')).toMatch(/\.cell:disabled \{[^}]*border-style: dashed;[^}]*color: var\(--muted\);/);
});

it('draws every phase in its group, each with its engine, model and effort', () => {
  const body = drawn(section());
  const table = part(body, 'aria-labelledby="model-phases-title"', '</section>');

  expect(text(table)).toMatch(/^Phases 16 Balanced on Claude Code Phase Engine Model Effort Delivery Refine/);
  // Each phase's three selects sit in the three columns under the head.
  expect(table.match(/<div class="pick[^"]*\bcols\b/g)).toHaveLength(16);
  expect([...table.matchAll(/class="gh[^"]*">([^<]+)</g)].map((one) => one[1])).toEqual(['Delivery', 'Epics, Research and PR reviews', 'Other runs']);
  expect(table.match(/data-action=/g)).toHaveLength(16);
  expect(table).toMatch(picked('Refine', 'claude-code', 'haiku', 'low'));
  expect(table).toMatch(picked('Implement', 'claude-code', 'sonnet', 'medium'));
  expect(table).not.toContain('Changed');
  expect(body).not.toContain('class="bar');
});

// On a built-in preset a change is the person's own and saved at once.
it('marks a phase the person set as theirs, with Reset and Nolzu\'s default, and counts it on the bar', () => {
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, CODEX]);
  writeSetting(db, 'presetEngine', 'codex');
  writeSetting(db, 'modelPreset', 'heavy');
  writeSetting(db, 'models', { plan: { engine: 'claude-code', model: 'opus' }, qa: { engine: 'codex', model: 'gpt-5.6-terra' } });
  const body = drawn(section());
  const plan = part(body, 'data-action="plan"', 'data-action=');

  expect(body).toMatch(/class="pr[^"]*changed[^"]*" data-action="plan"/);
  // The mark sits on the right with its Reset, not beside the phase name.
  expect(plan).toMatch(/class="act[^"]*">[^]*class="tag[^"]*">Yours</);
  // Its column keeps the mark and Reset wide enough, so a narrow page never lays them over the selects.
  expect(readFileSync(new URL('./ModelsSection.svelte', import.meta.url), 'utf8')).toMatch(/grid-template-columns: 170px [^;]* minmax\(max-content, 1fr\);/);
  expect(plan).toMatch(/name="action" value="plan"[^>]*>[^]*name="reset" value="1"[^>]*aria-label="Put Plan back to Nolzu's default"/);
  expect(text(plan)).toContain("Nolzu's default is Codex · gpt-5.6-sol · high");
  expect(text(body)).toContain('Heavy on Codex, 2 phases yours');

  expect(text(bar(body))).toMatch(/^Heavy on Codex, 2 phases yours Saved\. Runs in this project use them from the next start, and a Nolzu update keeps them\. Back to Nolzu's default Save as new preset$/);
  expect(bar(body)).toContain('name="discard" value="1"');
  expect(bar(body)).not.toContain('name="replace"');
});

// A Cursor account without the preset's frontier model: the preset takes one the account has, and
// the row says so instead of turning red.
it('says which model Nolzu picked for a preset model the account lacks', () => {
  const cursor = { id: 'cursor', label: 'Cursor', vendor: 'cursor', configDir: null } as const;
  writeSetting(db, 'engineProfiles', [DEFAULT_PROFILE, cursor]);
  writeSetting(db, 'presetEngine', 'cursor');
  writeSetting(db, 'modelPreset', 'heavy');
  const body = drawn(modelsFor(db, { ...OFFERS, cursor: ['composer-2.5', 'gpt-5.3-codex'] }, { ready: true }));

  expect(text(part(body, 'data-action="plan"', 'data-action='))).toContain('Nolzu picked gpt-5.3-codex: claude-opus-5-5-high is not on this account.');
  expect(body).not.toContain('data-state="refused"');
  expect(body).not.toContain('class="bar');
});

it('offers Update on the bar of a saved preset only', () => {
  writeSetting(db, 'savedPresets', [{ name: 'Evenings', models: {} }]);
  writeSetting(db, 'savedPreset', 'Evenings');
  writeSetting(db, 'models', { wrapup: { engine: 'claude-code', model: 'haiku' } });
  const body = drawn(section());

  expect(text(body)).toContain('Phases 16 Evenings, 1 changed Phase');
  expect(text(part(body, 'data-action="wrapup"', 'data-action='))).toContain('Evenings uses Claude Code · sonnet · low');
  expect(text(bar(body))).toMatch(/^1 change from Evenings Runs in this project use them from the next start\. Evenings itself stays as it is\. Discard Update Evenings Save as new preset$/);
  expect(bar(body)).toContain('name="replace" value="Evenings"');
});

it('opens the name field on the bar when a name was refused, and prints the refusal there', () => {
  writeSetting(db, 'models', { wrapup: { engine: 'claude-code', model: 'haiku' } });
  const body = drawn(section(), { named: 'There is already a preset called Evenings.' });

  expect(bar(body)).toContain('id="preset-name"');
  expect(text(bar(body))).not.toContain('Save as new preset');
  expect(bar(body)).toMatch(/role="alert">There is already a preset called Evenings\.<\/p>/);
});

// A gone model will not start, so its row is red and says the board's sentence. No Pick another: a pick
// in the red select is the fix. A preset row has no Reset either, it has nothing to undo.
it('marks a phase whose model is gone, with no Pick another and no Reset on a preset row', () => {
  const body = drawn(modelsFor(db, { 'claude-code': ['sonnet', 'opus'] }, { ready: true }));
  const refine = part(body, 'data-action="refine"', 'data-action=');

  expect(body).toMatch(/data-action="refine" data-state="refused"/);
  expect(text(refine)).toContain('Refine uses haiku, which Claude Code no longer offers. Refine will not start until you pick another.');
  expect(text(refine)).not.toContain('Pick another');
  expect(refine).not.toContain('name="reset"');
  // The sentence is read with the model select, and stays its own line under the row. Its width went
  // to the last column and squeezed the selects to empty boxes.
  expect(refine).toMatch(/data-pick="model" aria-label="Refine model, gone" aria-describedby="was-refine"/);
  expect(refine).toMatch(/class="was warn[^"]*" id="was-refine"/);
  expect(readFileSync(new URL('./ModelsSection.svelte', import.meta.url), 'utf8')).toMatch(/\n {2}\.was \{[^}]*grid-column: 2 \/ -1;[^}]*contain: inline-size;/);
});

// A step like Assessment is on no board, so every row says in one line what it does and where it runs.
it('gives every step a short line of help', () => {
  for (const action of ACTIONS) {
    const line = PHASE_HELP[action];
    expect(line, action).toMatch(/^[A-Z].*\.$/);
    expect(line!.split(' ').length, action).toBeLessThanOrEqual(16);
  }
});

// Assessment reads Scout findings only, and waits with Scout, so its row is not drawn.
it('draws the help tip next to every step label', () => {
  const body = drawn(section());

  expect(body).not.toContain('data-action="assess"');
  for (const action of ACTIONS.filter((one) => one !== 'assess')) {
    const row = part(body, `data-action="${action}"`, 'data-action=');
    expect(row, action).toContain(`aria-label="What ${phaseLabel(action)} does"`);
    expect(text(row), action).toContain(PHASE_HELP[action]);
    // A native popover, so the table's edge never clips the tip of the last rows.
    expect(row, action).toContain('popover="auto"');
  }
});

