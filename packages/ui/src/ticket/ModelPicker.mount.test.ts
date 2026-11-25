import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../../test/mounted.svelte.ts';
import ModelPicker from './ModelPicker.svelte';

let page: Mounted<Record<string, unknown>> | null = null;
afterEach(() => {
  page?.remove();
  page = null;
});

const PROFILES = [
  { id: 'claude-code', label: 'Claude Code', models: ['haiku', 'sonnet'] },
  { id: 'cursor#work', label: 'Cursor work', models: ['auto', 'sonnet'] },
  { id: 'codex#work', label: 'Codex work', models: ['gpt-9'] },
];

// A refused pick puts the select back by hand, and a `selected` attribute stops working on an option
// picked that way. The select still follows the stored engine when another picker on the page saves.
it('follows the stored engine after a refused pick and two saves made elsewhere', async () => {
  page = mounted(ModelPicker as never, { step: 'Plan', engine: 'cursor#work', model: 'sonnet', effort: 'medium', profiles: PROFILES, onpick: vi.fn(async () => 'Refused.') });
  const engine = page.target.querySelector<HTMLSelectElement>('select[data-pick="engine"]')!;

  engine.value = 'codex#work';
  engine.dispatchEvent(new Event('change', { bubbles: true }));
  await vi.waitFor(() => expect(page!.target.querySelector('.note')?.textContent).toBe('Refused.'));
  expect(engine.value).toBe('cursor#work');

  page.set({ engine: 'codex#work', model: 'gpt-9' });
  page.set({ engine: 'cursor#work', model: 'sonnet' });

  expect(engine.value).toBe('cursor#work');
  expect(page.target.querySelector<HTMLSelectElement>('select[data-pick="model"]')!.value).toBe('sonnet');
});

// The closed state is the picker: three selects drawn in place, nothing to open first.
it('draws engine, model and effort as three selects with no block to open', () => {
  page = mounted(ModelPicker as never, { step: 'Plan', engine: 'cursor#work', model: 'sonnet', effort: 'medium', profiles: PROFILES, onpick: vi.fn(async () => null) });

  expect(page.target.querySelector('details, summary')).toBeNull();
  const selects = [...page.target.querySelectorAll<HTMLSelectElement>('.pick select')];
  expect(selects.map((one) => [one.dataset.pick, one.value, one.getAttribute('aria-label')])).toEqual([
    ['engine', 'cursor#work', 'Plan engine'],
    ['model', 'sonnet', 'Plan model'],
    ['effort', 'medium', 'Plan effort'],
  ]);
});

// The red edge is the only other mark of a gone model, so a screen reader hears it in the name.
it('names the model select gone on a row whose model is gone', () => {
  page = mounted(ModelPicker as never, { step: 'Plan', engine: 'cursor#work', model: 'sonnet', effort: 'medium', profiles: PROFILES, tone: 'gone', onpick: vi.fn(async () => null) });

  expect(page.target.querySelector('select[data-pick="model"]')!.getAttribute('aria-label')).toBe('Plan model, gone');
});
