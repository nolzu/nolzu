import { flushSync } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import SettingsTab from './SettingsTab.svelte';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
};

const REPOS = {
  repos: [
    { path: '.', picked: true, fixed: true },
    { path: 'api', picked: true, fixed: false },
    { path: 'web', picked: false, fixed: false },
  ],
  by: 'plan' as const,
};

function draw(onrepos: (repos: string[]) => Promise<string | null>) {
  page = mounted(SettingsTab as never, { settings: { rows: [], preset: 'default', board: 'Delivery', profiles: [] }, repos: REPOS, onrepos });
  const boxes = [...page.target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
  const status = () => page!.target.querySelectorAll('[role="status"]')[1]?.textContent ?? '';
  return { boxes, status };
}

it('sends the ticked repositories without the project folder, and shows its own pending line', async () => {
  let done: (value: string | null) => void = () => {};
  const onrepos = vi.fn(() => new Promise<string | null>((resolve) => (done = resolve)));
  const ui = draw(onrepos);

  expect(ui.boxes[0]?.disabled).toBe(true);
  ui.boxes[2]?.click();
  flushSync();

  expect(onrepos).toHaveBeenCalledWith(['api', 'web']);
  expect(ui.status()).toBe('Saving.');
  expect(ui.boxes[1]?.disabled).toBe(true);

  done(null);
  await settle();

  expect(ui.status()).toBe('Saved. The next run that needs a checkout makes the missing ones.');
  expect(ui.boxes[1]?.disabled).toBe(false);
});

it('puts a refused tick back and says why', async () => {
  const ui = draw(async () => 'APP-1 has a checkout of api already, so api stays in its list.');

  ui.boxes[1]?.click();
  await settle();

  expect(ui.boxes[1]?.checked).toBe(true);
  expect(ui.status()).toBe('APP-1 has a checkout of api already, so api stays in its list.');
});

it('sends an empty list when the last tick is cleared', async () => {
  const onrepos = vi.fn(async () => null);
  const ui = draw(onrepos);

  ui.boxes[1]?.click();
  await settle();

  expect(onrepos).toHaveBeenCalledWith([]);
  expect(ui.status()).toBe('Saved. The list is empty, so the next refine or plan picks it again.');
});

// The model rows: one combined picker per step, Reset, Pick another and the preset switch.
const resolved = (model: string, effort: string, over: Record<string, unknown> = {}) => ({
  engine: 'claude-code',
  model,
  effort,
  from: { model: 'preset', effort: 'preset' },
  gone: false,
  missingProfile: false,
  refusal: null,
  ...over,
});
const step = (action: string, label: string, model: string, own: Record<string, string> = {}, over: Record<string, unknown> = {}) => ({
  action,
  label,
  step: true,
  own,
  resolved: resolved(model, 'medium', over),
  follows: resolved('sonnet', 'medium'),
});
const MODELS = {
  preset: 'default',
  board: 'Delivery',
  profiles: [
    { id: 'claude-code', label: 'Claude Code', models: ['haiku', 'sonnet', 'opus'] },
    { id: 'codex#work', label: 'Codex work', models: ['gpt-9', 'gpt-9-mini'] },
  ],
  rows: [step('plan', 'Plan', 'sonnet'), step('implement', 'Implement', 'opus', { model: 'opus' }), step('qa', 'QA', 'sonnet-4-5', { model: 'sonnet-4-5' }, { gone: true })],
};

function rows(props: Record<string, unknown>) {
  page = mounted(SettingsTab as never, { settings: MODELS, ...props });
  const find = <T extends Element = HTMLElement>(selector: string) => page!.target.querySelector<T>(selector)!;
  const said = () => find('.said').textContent ?? '';
  return { find, said };
}

it('writes an engine pick together with the first model the engine offers, in one change', async () => {
  const onpick = vi.fn(async () => null);
  const ui = rows({ onpick });
  const engine = ui.find<HTMLSelectElement>('[data-action="plan"] .pick select[data-pick="engine"]');

  engine.value = 'codex#work';
  engine.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();

  expect(onpick).toHaveBeenCalledTimes(1);
  expect(onpick).toHaveBeenCalledWith('plan', { engine: 'codex#work', model: 'gpt-9' });
  expect(ui.find('[data-action="plan"] .pick [role="status"]').textContent).toBe('Saved for this card.');
});

it('sends the effort alone, since it says nothing about the engine', async () => {
  const onpick = vi.fn(async () => null);
  const ui = rows({ onpick });
  const effort = ui.find<HTMLSelectElement>('[data-action="plan"] .pick select[data-pick="effort"]');

  effort.value = 'high';
  effort.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();

  expect(onpick).toHaveBeenCalledWith('plan', { effort: 'high' });
});

it('resets a changed step so it follows the preset again', async () => {
  const onreset = vi.fn(async () => null);
  const ui = rows({ onreset });

  ui.find<HTMLButtonElement>('[data-reset="implement"]').click();
  await settle();

  expect(onreset).toHaveBeenCalledWith('implement');
  expect(ui.said()).toBe('Implement follows Balanced again.');
});

// The switch clears the card's own values, and one line names each step that lost one.
it('switches the preset and names every step whose own choice went', async () => {
  const onpreset = vi.fn(async () => null);
  const ui = rows({ onpreset });
  const button = (name: string) => [...page!.target.querySelectorAll<HTMLButtonElement>('.presets button')].find((one) => one.textContent === name)!;

  button('Balanced').click();
  await settle();
  expect(onpreset).not.toHaveBeenCalled();

  button('Heavy').click();
  await settle();

  expect(onpreset).toHaveBeenCalledWith('heavy');
  expect(ui.said()).toBe('This card follows Heavy now. It dropped its own choice for Implement and QA.');
});

// The switch clears every value the card stores, so a changed run that is no step of the board is named too.
it('names a changed run that is no step of the board when the preset switches', async () => {
  const ask = { ...step('ask', 'Ask', 'opus', { model: 'opus' }), step: false };
  const ui = rows({ onpreset: vi.fn(async () => null), settings: { ...MODELS, rows: [step('plan', 'Plan', 'sonnet'), ask] } });

  [...page!.target.querySelectorAll<HTMLButtonElement>('.presets button')].find((one) => one.textContent === 'Heavy')!.click();
  await settle();

  expect(ui.said()).toBe('This card follows Heavy now. It dropped its own choice for Ask.');
});

// The built-in three run on the project's engine and the heading says which; the project's saved
// presets follow them, and a saved one is sent by its name.
it('names the engine of the built-in presets and offers the saved ones', async () => {
  const onpreset = vi.fn(async () => null);
  const ui = rows({ onpreset, settings: { ...MODELS, preset: 'heavy', presetEngine: 'cursor', savedPresets: ['Evenings'] } });
  const buttons = () => [...page!.target.querySelectorAll<HTMLButtonElement>('.presets button')];

  expect(ui.find('.title').textContent).toBe('This card follows Heavy on Cursor');
  expect(buttons().map((one) => one.textContent)).toEqual(['Light', 'Balanced', 'Heavy', 'Evenings']);
  expect(buttons().map((one) => one.getAttribute('aria-label'))).toEqual(['Light on Cursor', 'Balanced on Cursor', 'Heavy on Cursor', 'Evenings']);
  expect(ui.find('[data-action="implement"] .sub').textContent).toBe('Heavy on Cursor uses sonnet · medium.');

  buttons()[3]!.click();
  await settle();

  expect(onpreset).toHaveBeenCalledWith('Evenings');
  expect(ui.said()).toBe('This card follows Evenings now. It dropped its own choice for Implement and QA.');
});

it('marks the saved preset a card follows, and does nothing when it is picked again', async () => {
  const onpreset = vi.fn(async () => null);
  const ui = rows({ onpreset, settings: { ...MODELS, saved: 'Evenings', savedPresets: ['Evenings'] } });
  const pressed = [...page!.target.querySelectorAll<HTMLButtonElement>('.presets button[aria-pressed="true"]')];

  expect(ui.find('.title').textContent).toBe('This card follows Evenings');
  expect(pressed.map((one) => one.textContent)).toEqual(['Evenings']);

  pressed[0]!.click();
  await settle();
  expect(onpreset).not.toHaveBeenCalled();
});

// After a switch no step keeps a choice of its own, so no picker may still say it saved one.
it('clears the saved note of a picker when the preset switches', async () => {
  const ui = rows({ onpick: vi.fn(async () => null), onpreset: vi.fn(async () => null) });
  const model = ui.find<HTMLSelectElement>('[data-action="qa"] .pick select[data-pick="model"]');
  model.value = 'opus';
  model.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  expect(ui.find('[data-action="qa"] .pick .note').textContent).toBe('Saved for this card.');

  [...page!.target.querySelectorAll<HTMLButtonElement>('.presets button')].find((one) => one.textContent === 'Heavy')!.click();
  await settle();

  expect(ui.find('[data-action="qa"] .pick .note').textContent).toBe('');
});

// The card set the gone model itself here. The red picker is the fix, so the row has no button.
it('offers the models a gone step can move to, with no button beside them', () => {
  const ui = rows({});

  expect(page!.target.querySelector('[data-reset="qa"]')).toBeNull();
  expect(page!.target.querySelectorAll('[data-action="qa"] .act button')).toHaveLength(0);
  // The gone model stays on the list, closed, under the models its engine still offers.
  const options = [...ui.find('[data-action="qa"] .pick select[data-pick="model"]').querySelectorAll('option')];
  expect(options.map((one) => `${one.textContent}${one.disabled ? ' [closed]' : ''}`)).toEqual(['haiku', 'sonnet', 'opus', 'sonnet-4-5 (gone) [closed]']);
  // The sentence beside it is read with the model select.
  const select = ui.find('[data-action="qa"] .pick select[data-pick="model"]');
  expect(page!.target.querySelector(`#${select.getAttribute('aria-describedby')}`)?.textContent).toContain('sonnet-4-5');
});

// A row with no login has nothing to pick in the model select, so the engine select is the way out.
it('offers the other engines on a row with no login, with no button beside them', () => {
  const lost = step('implement', 'Implement', 'gpt-9', { engine: 'codex#gone', model: 'gpt-9' }, { engine: 'codex#gone', missingProfile: true });
  const ui = rows({ settings: { ...MODELS, rows: [lost] } });

  expect(page!.target.querySelectorAll('[data-action="implement"] .act button')).toHaveLength(0);
  const shown = (pick: string) => [...ui.find(`[data-action="implement"] .pick select[data-pick="${pick}"]`).querySelectorAll('option')].map((one) => `${one.textContent}${one.disabled ? ' [closed]' : ''}`);
  expect(shown('engine')).toEqual(['Claude Code', 'Codex work', 'codex#gone (no login) [closed]']);
  expect(shown('model')).toEqual(['gpt-9 [closed]']);
});

// The select shows what is stored, as a refused repository tick goes back.
it('puts a refused pick back to what the step runs on, and says why', async () => {
  const onpick = vi.fn(async () => 'Codex cannot run the plan phase.');
  const ui = rows({ onpick });
  const engine = ui.find<HTMLSelectElement>('[data-action="plan"] .pick select[data-pick="engine"]');

  engine.value = 'codex#work';
  engine.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();

  expect(engine.value).toBe('claude-code');
  expect(ui.find('[data-action="plan"] .pick [role="status"]').textContent).toBe('Codex cannot run the plan phase.');
});

// The chain is a tick on the card, drawn only where the page hands one over.
it('draws the chain tick only where the page hands one over', () => {
  page = mounted(SettingsTab as never, { settings: { rows: [], preset: 'default', board: 'Delivery', profiles: [] } });
  expect(page.target.querySelector('[data-chain-tick]')).toBeNull();
});

it('sends the chain tick, and puts a refused one back with the reason', async () => {
  const onchain = vi.fn(async (on: boolean): Promise<string | null> => (on ? null : 'The local app is not answering.'));
  page = mounted(SettingsTab as never, { settings: { rows: [], preset: 'default', board: 'Delivery', profiles: [] }, chain: { ticked: false }, onchain });
  const label = page.target.querySelector<HTMLLabelElement>('[data-chain-tick]')!;
  const box = label.querySelector<HTMLInputElement>('input')!;
  const status = () => page!.target.querySelector('[aria-labelledby="chain-title"] [role="status"]')?.textContent;

  expect(label.textContent?.trim()).toBe('Go on to Implement after Plan');
  expect(box.checked).toBe(false);
  box.click();
  await settle();
  expect(onchain).toHaveBeenLastCalledWith(true);
  expect(status()).toBe('Saved. Implement starts by itself when the plan is done.');

  box.click();
  await settle();
  expect(onchain).toHaveBeenLastCalledWith(false);
  expect(box.checked).toBe(true);
  expect(status()).toBe('The local app is not answering.');
});
