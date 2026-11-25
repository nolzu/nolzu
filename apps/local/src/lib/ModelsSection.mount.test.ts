import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
// eslint-disable-next-line no-restricted-imports -- the ui package's mount helper, which is not exported
import { mounted } from '../../../../packages/ui/test/mounted.svelte.ts';
import ModelsSection from './ModelsSection.svelte';
import source from './ModelsSection.svelte?raw';
import type { ModelsSection as Section, ProjectModelRow } from './project-models.ts';

// The shared stub of `use:enhance` drops its callback. This one keeps it, so a test can play the answer
// to a submit the way the client runtime does.
type Answer = (input: { update: () => Promise<void> }) => Promise<void>;
const enhanced = vi.hoisted(() => new Map<HTMLFormElement, () => unknown>());
vi.mock('$app/forms', async (original) => ({
  ...(await original<object>()),
  enhance: (form: HTMLFormElement, submit?: () => unknown) => {
    if (submit !== undefined) enhanced.set(form, submit);
    return { destroy: () => enhanced.delete(form) };
  },
}));

// One phase, as `modelsFor` hands it over. `gone` gives it the model its engine stopped offering, and
// `changed` a pick apart from the preset.
const step = (action: ProjectModelRow['action'], gone = false, changed = false): ProjectModelRow => {
  const resolved = { engine: 'claude-code', model: gone ? 'haiku-3' : 'haiku', effort: 'low' as const, from: { model: 'preset' as const, effort: 'preset' as const }, gone, missingProfile: false, refusal: null };
  return {
    action,
    own: {},
    resolved,
    base: resolved,
    changed,
    picked: null,
    baseText: 'Claude Code · haiku · low',
    models: ['haiku', 'sonnet'],
    presetPicks: {},
    warning: gone ? 'Refine uses haiku-3, which Claude Code no longer offers. Refine will not start until you pick another.' : null,
  };
};
// The three built-in cells of one engine's row, Balanced in use on the engine named.
const builtIns = (inUse?: string) => ['light', 'default', 'heavy'].map((name) => ({ name, active: inUse !== undefined && name === 'default' }));
const section = (rows: ProjectModelRow[]): Section => ({
  rows,
  preset: 'default',
  presets: ['light', 'default', 'heavy'],
  chosen: null,
  presetEngine: 'claude-code',
  grid: [
    { vendor: 'claude-code', why: null, cells: builtIns('claude-code') },
    { vendor: 'codex', why: null, cells: builtIns() },
  ],
  mine: [],
  changes: rows.filter((one) => one.changed).length,
  saved: [],
  profiles: [{ id: 'claude-code', label: 'Claude Code' }, { id: 'codex#work', label: 'Codex work' }],
  choices: [
    { id: 'claude-code', label: 'Claude Code', models: ['haiku', 'sonnet'], effortInName: false },
    { id: 'codex#work', label: 'Codex work', models: ['gpt-5.6-terra'], effortInName: false },
  ],
  efforts: ['low', 'medium', 'high'],
});

let instance: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
  vi.unstubAllGlobals();
});

// The selects are drawn in place, so a pick is one change, as a person makes it.
const choose = (root: HTMLElement, action: string, pick: 'engine' | 'model', value: string) => {
  const picker = root.querySelector<HTMLElement>(`.pr[data-action="${action}"] .pick`)!;
  const select = picker.querySelector<HTMLSelectElement>(`select[data-pick="${pick}"]`)!;
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return { select, note: () => picker.querySelector('.note')?.textContent };
};

const open = (models: Section): HTMLElement => {
  drawnAt('/settings/models');
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(ModelsSection, { target, props: { models } }) as Record<string, unknown>;
  flushSync();
  return target;
};

// A model name means nothing under another engine, so an engine pick posts the engine's model with it.
it('posts the engine and the model of a pick in one write to the models action', async () => {
  const sent: { url: string; body: Record<string, string> }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: FormData }) => {
    sent.push({ url, body: Object.fromEntries([...init.body.entries()].map(([name, value]) => [name, String(value)])) });
    return new Response(JSON.stringify({ type: 'success', status: 200 }));
  });
  const picked = choose(open(section([step('plan')])), 'plan', 'engine', 'codex#work');
  await vi.waitFor(() => expect(sent).toHaveLength(1));

  expect(sent).toEqual([{ url: '?/models', body: { action: 'plan', engine: 'codex#work', model: 'gpt-5.6-terra' } }]);
  // The bar says the change is in use, so the row repeats nothing.
  await vi.waitFor(() => expect(picked.note()).toBe(''));
});

// Heavy's Plan on Claude Code is opus at high, not the engine's first model.
it('posts the preset\'s model and effort for the engine a row moves to', async () => {
  const sent: Record<string, string>[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: { body: FormData }) => {
    sent.push(Object.fromEntries([...init.body.entries()].map(([name, value]) => [name, String(value)])));
    return new Response(JSON.stringify({ type: 'success', status: 200 }));
  });
  const plan = { ...step('plan'), presetPicks: { 'codex#work': { model: 'gpt-5.6-terra', effort: 'high' } } };
  choose(open(section([plan])), 'plan', 'engine', 'codex#work');

  await vi.waitFor(() => expect(sent).toEqual([{ action: 'plan', engine: 'codex#work', model: 'gpt-5.6-terra', effort: 'high' }]));
});

// Profiles with no models are named once, in the engine choice, and not in each of fifteen rows.
it('names a profile with no models in no row, and draws no effort for an engine that reads it off the model', () => {
  const models = section([step('plan'), step('refine')]);
  const root = open({
    ...models,
    grid: [...models.grid, { vendor: 'cursor', why: 'Cursor answered no models.', cells: builtIns() }],
    choices: [{ id: 'cursor', label: 'Cursor', models: ['haiku'], effortInName: true }, { id: 'cursor#work', label: 'Cursor work', models: [], reason: 'No models answered.', effortInName: true }],
    rows: models.rows.map((row) => ({ ...row, resolved: { ...row.resolved, engine: 'cursor' } })),
  });

  expect(root.querySelector('.pick .help')).toBeNull();
  // Not even as a closed option: its long label widened every select and broke each row in two.
  expect([...root.querySelectorAll<HTMLOptionElement>('.pr select[data-pick="engine"] option')].map((one) => one.value)).toEqual(['cursor', 'cursor']);
  expect(root.querySelector('select[data-pick="effort"]')).toBeNull();
  expect([...root.querySelectorAll('.pr .inid')].map((one) => one.textContent)).toEqual(['in model name', 'in model name']);
  const closed = root.querySelector('.gr[data-engine="cursor"]')!;
  expect([...closed.querySelectorAll<HTMLButtonElement>('button.cell')].map((one) => one.disabled)).toEqual([true, true, true]);
  expect(closed.querySelector('.en')?.textContent).toMatch(/^Cursor\s*Cursor answered no models\. Engines/);
});

it('puts the select back and says why when the pick is refused', async () => {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ type: 'failure', status: 400, data: { message: 'gpt-9 is gone. The engine offers gpt-5.6-terra.' } })));
  const picked = choose(open(section([step('plan')])), 'plan', 'engine', 'codex#work');
  await vi.waitFor(() => expect(picked.note()).toBe('gpt-9 is gone. The engine offers gpt-5.6-terra.'));

  expect(picked.select.value).toBe('claude-code');
});

// The red select and its sentence say what to do. A step the person set to a model that is now gone
// keeps Reset and the default line, since back to the default is the quickest fix.
it('draws a gone step with its red select and sentence, and Reset only when it is yours', () => {
  const row = open(section([step('refine', true, true)])).querySelector('.pr[data-action="refine"]')!;

  expect(row.querySelector('.was.warn')?.textContent).toBe('Refine uses haiku-3, which Claude Code no longer offers. Refine will not start until you pick another.');
  expect(row.querySelector('select[data-pick="model"]')).not.toBeNull();
  expect([...row.querySelectorAll('.act button')].map((one) => one.getAttribute('aria-label'))).toEqual(["Put Refine back to Nolzu's default"]);
  expect(row.querySelector('.was:not(.warn)')?.textContent).toBe("Nolzu's default is Claude Code · haiku · low");

  const preset = open(section([step('refine', true, false)])).querySelector('.pr[data-action="refine"]')!;
  expect(preset.querySelectorAll('.act button')).toHaveLength(0);
});

// A plain button and not a disclosure: the press shows the name field in its place, with the focus in it.
it('shows the name field on Save as new preset', async () => {
  const root = open(section([step('plan', false, true)]));
  const button = () => [...root.querySelectorAll<HTMLButtonElement>('.bar button')].find((one) => one.textContent?.includes('Save as new preset'));

  expect(root.querySelector('#preset-name')).toBeNull();
  button()!.click();
  flushSync();

  expect(root.querySelector('#preset-name')).not.toBeNull();
  expect(button()).toBeUndefined();
  await vi.waitFor(() => expect(document.activeElement).toBe(root.querySelector('#preset-name')));
});

// A refusal sits on its own line under the field, and goes once the name is edited, so it never reads
// as the answer to a name it was not about.
it('puts a refused name under the field and clears it on an edit', async () => {
  drawnAt('/settings/models');
  const page = mounted(ModelsSection as never, { models: section([step('plan', false, true)]), named: 'A preset name cannot hold a slash.' });
  const field = page.target.querySelector<HTMLInputElement>('#preset-name')!;
  const refusal = () => page.target.querySelector('.bar form.name p.refused');

  expect(refusal()?.textContent).toBe('A preset name cannot hold a slash.');
  // After the Save button in the form, so with the flex-basis rule it starts a line of its own.
  expect(refusal()?.previousElementSibling?.textContent?.trim()).toBe('Save');
  expect(field.getAttribute('aria-describedby')).toBe(refusal()?.id);
  expect(field.getAttribute('aria-invalid')).toBe('true');

  field.value = 'Cursor (custom-heavy)';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();

  expect(refusal()).toBeNull();
  expect(field.getAttribute('aria-invalid')).toBe('false');
  expect(field.hasAttribute('aria-describedby')).toBe(false);

  // The press alone keeps the message away; the answer to it shows the server's refusal again.
  const answer = enhanced.get(field.form!)!() as Answer;
  flushSync();
  expect(refusal()).toBeNull();
  const update = vi.fn(async () => {});
  await answer({ update });
  flushSync();
  expect(update).toHaveBeenCalledOnce();
  expect(refusal()?.textContent).toBe('A preset name cannot hold a slash.');
  page.remove();
});

// A server render carries no CSS, so the rule that starts the refusal's own line is read from the source.
it('starts a line of its own for a refused name', () => {
  expect(source).toMatch(/\.name \.refused \{\s*flex-basis: 100%;\s*\}/);
  // The bar's buttons line up with the field, not with the field and the refusal together.
  expect(source).toMatch(/\.bb \{[^}]*align-items: baseline;/);
});

// After a save the bar goes. The next change offers Save as new preset again, not the old name field.
it('closes the name field with the bar', () => {
  drawnAt('/settings/models');
  const page = mounted(ModelsSection as never, { models: section([step('plan', false, true)]) });
  const button = () => [...page.target.querySelectorAll<HTMLButtonElement>('.bar button')].find((one) => one.textContent?.includes('Save as new preset'));
  button()!.click();
  flushSync();

  page.set({ models: { ...section([step('plan')]), chosen: 'Evenings', saved: ['Evenings'] } });
  page.set({ models: { ...section([step('plan', false, true)]), chosen: 'Evenings', saved: ['Evenings'] } });

  expect(page.target.querySelector('#preset-name')).toBeNull();
  expect(button()).not.toBeUndefined();
  page.remove();
});

// Remove asks first, and a No posts nothing.
it('asks before Remove, and posts nothing on a No', () => {
  vi.stubGlobal('confirm', vi.fn(() => false));
  const root = open(withSaved());
  const submitted = vi.fn((event: Event) => event.preventDefault());
  buttonOf(root, 'Remove the preset Evenings').form!.addEventListener('submit', submitted);
  buttonOf(root, 'Remove the preset Evenings').click();

  expect(confirm).toHaveBeenCalledWith('Remove the preset Evenings? Every phase keeps running what it runs now.');
  expect(submitted).not.toHaveBeenCalled();
});

// A saved preset as `modelsFor` hands it over: in use, on two engines, in the list under the table.
const withSaved = (): Section => ({
  ...section([step('plan')]),
  saved: ['Evenings'],
  chosen: 'Evenings',
  grid: [
    { vendor: 'claude-code', why: null, cells: builtIns() },
    { vendor: 'codex', why: null, cells: builtIns() },
  ],
  mine: [{ name: 'Evenings', runsOn: 'Claude Code and Codex', active: true }],
});
const buttonOf = (root: HTMLElement, label: string) => root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

// The press on a saved line posts its name as apply. Rename and Remove sit in a menu beside it, so
// pressing one never applies the preset.
it('makes a saved line the apply button, with Rename and Remove in a menu beside it', () => {
  const root = open(withSaved());
  const face = root.querySelector<HTMLButtonElement>('.own [role="radiogroup"] button.cell[data-preset="Evenings"]')!;

  expect(root.querySelector('.grid [data-preset="Evenings"]')).toBeNull();

  expect([face.type, face.name, face.value, face.getAttribute('role'), face.getAttribute('aria-checked')]).toEqual(['submit', 'apply', 'Evenings', 'radio', 'true']);
  expect(face.textContent).toContain('In use');
  expect(face.textContent).toContain('Claude Code and Codex');
  for (const label of ['Rename the preset Evenings', 'Remove the preset Evenings']) {
    expect(buttonOf(root, label).closest('button.cell')).toBeNull();
    expect(buttonOf(root, label).closest('details.more')).not.toBeNull();
  }
  expect(buttonOf(root, 'Rename the preset Evenings').type).toBe('button');
  expect([buttonOf(root, 'Remove the preset Evenings').name, buttonOf(root, 'Remove the preset Evenings').value]).toEqual(['remove', 'Evenings']);
});

it('opens the rename form on Rename, with the focus in the name', async () => {
  const root = open(withSaved());
  const rename = buttonOf(root, 'Rename the preset Evenings');

  expect(root.querySelector('#preset-edit')).toBeNull();
  rename.click();
  flushSync();

  const form = root.querySelector<HTMLFormElement>('#preset-edit')!;
  expect(rename.getAttribute('aria-expanded')).toBe('true');
  expect(form.getAttribute('aria-label')).toBe('Rename the preset Evenings');
  expect(form.querySelector<HTMLInputElement>('input[name="rename"]')?.value).toBe('Evenings');
  expect(form.querySelector<HTMLInputElement>('#preset-rename')?.value).toBe('Evenings');
  await vi.waitFor(() => expect(document.activeElement).toBe(form.querySelector('#preset-rename')));

  rename.click();
  flushSync();
  expect(root.querySelector('#preset-edit')).toBeNull();
});

it('prints a refused name in the rename form', () => {
  drawnAt('/settings/models');
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(ModelsSection, { target, props: { models: withSaved(), renamed: 'There is already a preset called Heavy.' } }) as Record<string, unknown>;
  flushSync();
  buttonOf(target, 'Rename the preset Evenings').click();
  flushSync();

  expect(target.querySelector('#preset-edit [role="alert"]')?.textContent).toBe('There is already a preset called Heavy.');
});

// One click picks the engine and the preset: the cell's form posts both.
it('posts the preset and its engine from one cell', () => {
  const root = open(section([step('plan')]));
  const heavy = root.querySelector<HTMLButtonElement>('.gr[data-engine="codex"] button.cell[data-preset="heavy"]')!;
  const sent: Record<string, string>[] = [];
  heavy.form!.addEventListener('submit', (event) => {
    event.preventDefault();
    sent.push(Object.fromEntries([...new FormData(heavy.form!, heavy).entries()].map(([name, value]) => [name, String(value)])));
  });
  heavy.click();

  expect(sent).toEqual([{ presetEngine: 'codex', preset: 'heavy' }]);
});

// The arrows walk the table and skip a closed cell; Tab has one stop in it, the cell the arrows left on.
// The saved lines are no part of that walk.
it('moves through the cells with the arrow keys', () => {
  const models = section([step('plan')]);
  const root = open({
    ...models,
    grid: [models.grid[0]!, { vendor: 'cursor', why: 'Cursor has no login yet.', cells: builtIns() }, models.grid[1]!],
    saved: ['Evenings'],
    mine: [{ name: 'Evenings', runsOn: 'Claude Code', active: false }],
  });
  const at = (vendor: string, name: string) => root.querySelector<HTMLButtonElement>(`.gr[data-engine="${vendor}"] button.cell[data-preset="${name}"]`)!;
  const press = (key: string) => {
    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    flushSync();
  };
  const stops = () => [...root.querySelectorAll<HTMLButtonElement>('.grid button.cell')].filter((one) => one.tabIndex === 0);

  expect(stops()).toEqual([at('claude-code', 'default')]);
  expect(root.querySelector<HTMLButtonElement>('.own button.cell')!.tabIndex).toBe(0);
  at('claude-code', 'default').focus();
  press('ArrowRight');
  expect(document.activeElement).toBe(at('claude-code', 'heavy'));
  press('ArrowRight');
  expect(document.activeElement).toBe(at('claude-code', 'heavy'));
  // Cursor has no login, so Down goes past its closed row.
  press('ArrowDown');
  expect(document.activeElement).toBe(at('codex', 'heavy'));
  press('Home');
  expect(document.activeElement).toBe(at('codex', 'light'));
  press('ArrowUp');
  expect(document.activeElement).toBe(at('claude-code', 'light'));
  expect(stops()).toEqual([at('claude-code', 'light')]);
});

// The saved preset's menu: Escape shuts it and gives the focus back, and Rename opens the form below.
it('shuts the saved preset menu on Escape, and opens the rename form from it', async () => {
  const root = open(withSaved());
  const menu = root.querySelector<HTMLDetailsElement>('details.more')!;
  menu.open = true;
  buttonOf(root, 'Rename the preset Evenings').focus();
  (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  expect([menu.open, document.activeElement]).toEqual([false, menu.querySelector('summary')]);

  menu.open = true;
  buttonOf(root, 'Rename the preset Evenings').click();
  await vi.waitFor(() => expect(document.activeElement).toBe(root.querySelector('#preset-rename')));
  expect(menu.open).toBe(false);
});

// A saved preset in use on an engine that cannot take a built-in one is still reached with Tab, and the
// closed table offers no stop.
it('keeps the saved line a Tab stop when the table is closed', () => {
  const models = withSaved();
  const root = open({ ...models, grid: [{ ...models.grid[0]!, why: 'Claude Code has no login yet.' }] });
  const stops = [...root.querySelectorAll<HTMLButtonElement>('button.cell')].filter((one) => one.tabIndex === 0);

  expect(stops.map((one) => [one.dataset.preset, one.disabled])).toEqual([['Evenings', false]]);
});

// A reset takes its own button away, and the focus fell to the page.
it('puts the focus on the row after a Reset, and on the Phases head after Back to Nolzu\'s default', async () => {
  const root = open(section([step('plan', false, true)]));
  const play = async (form: HTMLFormElement) => {
    await (enhanced.get(form)!() as Answer)({ update: async () => {} });
  };

  await play(root.querySelector<HTMLButtonElement>('.pr[data-action="plan"] button[name="reset"]')!.form!);
  expect(document.activeElement).toBe(root.querySelector('.pr[data-action="plan"] select[data-pick="model"]'));
  await play(root.querySelector<HTMLButtonElement>('.bar button[name="discard"]')!.form!);
  expect(document.activeElement?.id).toBe('model-phases-title');
});
