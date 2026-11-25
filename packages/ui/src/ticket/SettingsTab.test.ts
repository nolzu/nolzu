import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import { goneSentence } from '../board/drop.ts';
import SettingsTab from './SettingsTab.svelte';

// The Settings tab, rendered on the server: one combined picker per step, a changed row with
// Reset and what the preset would use, the estimate only where runs measured one, and a gone model
// in the refused drop's own sentence.
const text = (body: string) => body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// The words as a reader hears them: a tag inside a sentence, such as the model in mono, adds no space.
const words = (body: string) => body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
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
const MEASURED = { costUsd: 0.4, lowMs: 360_000, highMs: 600_000, from: 'history' as const, runs: 8 };
const row = (action: string, label: string, model: string, effort: string, extra: Record<string, unknown> = {}) => ({
  action,
  label,
  step: true,
  own: {},
  resolved: resolved(model, effort),
  follows: resolved(model, effort),
  ...extra,
});
const PROFILES = [
  { id: 'claude-code', label: 'Claude Code', models: ['haiku', 'sonnet', 'opus'] },
  { id: 'codex#work', label: 'Codex work', models: ['gpt-9'] },
];
const ROWS = [
  row('refine', 'Refine', 'haiku', 'low', { estimate: MEASURED, stepEstimate: MEASURED }),
  // Measured off the preset's range only, not by this project's runs: no figure in the column.
  row('plan', 'Plan', 'sonnet', 'medium', { estimate: MEASURED }),
  row('implement', 'Implement', 'opus', 'high', { own: { model: 'opus' }, follows: resolved('sonnet', 'high'), followsEstimate: MEASURED }),
  row('qa', 'QA', 'sonnet-4-5', 'medium', { own: { model: 'sonnet-4-5' }, resolved: resolved('sonnet-4-5', 'medium', { gone: true }) }),
  row('wrapup', 'Wrap-up', 'sonnet', 'low'),
  row('ask', 'Ask', 'haiku', 'low', { step: false }),
];
const SETTINGS = { preset: 'default', board: 'Delivery', profiles: PROFILES, rows: ROWS };
const draw = (settings: unknown = SETTINGS) => render(SettingsTab, { props: { settings: settings as never } }).body;
const rowOf = (body: string, action: string) => new RegExp(`data-action="${action}"[\\s\\S]*?(?=data-action=|</section>)`).exec(body)?.[0] ?? '';

// The steps of the card's board, then the runs any card makes, then a project action only while the
// card stores a value for it.
it('draws the steps of the card board, the other runs of a card, and a project action only when the card changed it', () => {
  const optimize = (own: Record<string, string>) => row('optimize', 'Optimize', 'sonnet', 'low', { step: false, own });
  const body = draw({ ...SETTINGS, rows: [...ROWS, optimize({})] });

  expect([...body.matchAll(/data-action="([^"]+)"/g)].map((match) => match[1])).toEqual(['refine', 'plan', 'implement', 'qa', 'wrapup', 'ask']);
  expect(text(body)).toContain('Delivery steps 5');
  expect(text(body)).toContain('Other runs on this card Ask');
  expect(draw({ ...SETTINGS, rows: [...ROWS, optimize({ model: 'opus' })] })).toContain('data-action="optimize"');
});

// One picker per step: its engine, model and effort selects, drawn in place.
it('gives each step one combined picker, set to what it runs on', () => {
  const body = draw();
  const plan = rowOf(body, 'plan');

  expect(body.match(/<div class="pick/g)).toHaveLength(6);
  expect(body).not.toContain('<details class="pick');
  expect(plan).toContain('aria-label="Plan engine"');
  expect(plan).toContain('aria-label="Plan model"');
  expect(plan).toContain('aria-label="Plan effort"');
  expect(text(plan)).toContain('Claude Code Codex work');
  expect(plan).toMatch(/<option value="claude-code" selected/);
  expect(plan).toMatch(/<option value="sonnet" selected/);
  expect(plan).toMatch(/<option value="medium" selected/);
});

it('tints a changed row, offers Reset, and says what the preset would use with its measured figure', () => {
  const implement = rowOf(draw(), 'implement');

  expect(implement).toContain('data-state="changed"');
  expect(text(implement)).toContain('Changed on this card. Balanced uses sonnet · high, about $0.40.');
  expect(implement).toContain('data-reset="implement"');
  // A row that follows the preset says so in the Source column, and has no Reset.
  const plan = rowOf(draw(), 'plan');
  expect(text(plan)).toContain('From the preset');
  expect(plan).not.toContain('data-reset');
});

// No figure that nothing measured. No card has a size any more, so the head
// names none.
it('heads the figure column and shows a figure only on a row this project measured', () => {
  const body = draw();

  expect(text(body)).toContain('Delivery steps 5 Step Engine Model Effort Source Per card');
  expect(text(body)).not.toContain('small');
  // The same columns as Settings, Models.
  expect(body.match(/<div class="pick[^"]*\bcols\b/g)).toHaveLength(6);
  expect(text(rowOf(body, 'refine'))).toContain('~$0.40');
  expect(text(rowOf(body, 'plan'))).not.toMatch(/\$|min/);
});

// The selects read in the text font, and in a table they take the row's columns.
it('draws the picker selects in the text font, on the row grid in columns', () => {
  const source = readFileSync(new URL('./ModelPicker.svelte', import.meta.url), 'utf8');
  expect(source).toMatch(/\n {2}select \{[^}]*font-family: var\(--font-sans\);/);
  expect(source).toMatch(/\.cols \{[^}]*grid-column: span 3;[^}]*grid-template-columns: subgrid;/);
});

// Empty, as on a step with no measured runs: a bare "none" has no label on a phone.
it('leaves the figure column of a step that will not start empty', () => {
  expect(rowOf(draw(), 'qa')).toMatch(/class="estimate[^"]*"><\/span>/);
});

// The preset buttons: "Light ~$0.20", "Balanced ~$0.55", "Heavy ~$1.60".
it('shows what a card costs on each preset only where it was measured', () => {
  const small = (costUsd: number) => ({ ...MEASURED, costUsd });
  const body = draw({ ...SETTINGS, presets: { light: small(0.2), default: small(0.55) } });

  expect(text(body)).toContain('Light ~$0.20 Balanced ~$0.55 Heavy');
  expect(text(body)).not.toContain('Heavy ~$');
  expect(text(draw())).toContain('Light Balanced Heavy Delivery');
});

it('says a gone model in red with the sentence the board refuses the drop with', () => {
  const qa = rowOf(draw(), 'qa');

  expect(qa).toContain('data-state="refused"');
  expect(qa).toContain('data-tone="gone"');
  expect(words(qa)).toContain(`${goneSentence('QA', 'sonnet-4-5', 'claude-code')} QA will not start until you pick another.`);
  // No button beside the red picker: a pick there is the fix.
  expect(text(qa)).not.toContain('Pick another');
  expect(qa).not.toContain('data-reset');
});

it('says a missing login and a vendor that cannot run the step, and nothing on a row that runs', () => {
  const said = 'The plan phase may not change the project, and Cursor has no mode that holds a run to reading. Run this phase on a Claude Code profile.';
  const settings = {
    ...SETTINGS,
    rows: [
      row('plan', 'Plan', 'sonnet', 'medium', { own: { engine: 'cursor#work' }, resolved: resolved('sonnet', 'medium', { engine: 'cursor#work', refusal: said }) }),
      row('implement', 'Implement', 'gpt-9', 'medium', { own: { engine: 'codex#gone', model: 'gpt-9' }, resolved: resolved('gpt-9', 'medium', { engine: 'codex#gone', missingProfile: true }) }),
    ],
  };
  const body = draw(settings);
  const shown = text(body);

  expect(shown).toContain(said);
  expect(shown).toMatch(/The engine profile codex#gone has no login on this machine/);
  // Kept on the picker, so the person reads what the row names.
  expect(body).toMatch(/<option value="codex#gone" disabled="" selected="">codex#gone \(no login\)<\/option>/);
  expect(text(rowOf(draw(), 'plan'))).not.toMatch(/no longer offers|will not start/);
});

it('names the preset the card follows, marks its button, and counts the steps it set itself', () => {
  const body = draw({ ...SETTINGS, preset: 'heavy' });

  expect(text(body)).toContain('This card follows Heavy');
  expect(text(body)).toContain('With 2 values of its own. The rest changes when Heavy changes.');
  expect(body).toMatch(/<button[^>]*aria-pressed="true"[^>]*>Heavy(<!--[^>]*-->)*<\/button>/);
  expect(body).toMatch(/<button[^>]*aria-pressed="false"[^>]*>Balanced(<!--[^>]*-->)*<\/button>/);
});

// Amber only where an agent starts or resumes work, and nothing here starts one.
it('draws nothing amber', () => {
  expect(draw()).not.toMatch(/class="[^"]*\bgo\b/);
  // A changed row is never tinted amber.
  for (const file of ['./SettingsTab.svelte', './ModelPicker.svelte']) expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/--amber|variant="go"/);
});

it('names a gone model with a red pill above its sentence', () => {
  expect(text(rowOf(draw(), 'qa'))).toContain('Model gone QA uses sonnet-4-5');
  expect(rowOf(draw(), 'plan')).not.toContain('Model gone');
});
