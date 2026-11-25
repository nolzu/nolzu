import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Banner from './Banner.svelte';
import Button from './Button.svelte';
import Chip from './Chip.svelte';
import CoachNote from './CoachNote.svelte';
import ErrorBox from './ErrorBox.svelte';
import Kbd from './Kbd.svelte';
import LaneChips from './LaneChips.svelte';
import OptionButtons from './OptionButtons.svelte';
import SlotsMeter from './SlotsMeter.svelte';
import StatePill from './StatePill.svelte';
import Switch from './Switch.svelte';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// The server render wraps blocks in comments that the browser uses to hydrate. They are not markup.
const bare = (body: string) => body.replace(/<!--[\s\S]*?-->/g, '');
const words = (said: string) => createRawSnippet(() => ({ render: () => `<span>${said}</span>` }));

// The declarations of the rule for one selector, read off the component, because a server render
// carries no CSS. Comments are cut first, so a word in a comment is never read as a declaration.
function rule(file: string, selector: string): string {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  const style = (/<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const found = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) => match[1]!.split(',').some((one) => one.trim() === selector));
  return found?.[2] ?? '';
}

// Every selector in a component whose rule names an amber token.
function amberSelectors(file: string): string[] {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
  const style = (/<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => /var\(--(amber|amber-bg|amber-line|amber-tint|hatch)\)/.test(match[2]!)).map((match) => match[1]!.trim());
}

const button = (props: Record<string, unknown>) => bare(render(Button, { props: { children: words('Read the plan'), ...props } }).body);
const classOf = (body: string) => /<button[^>]*class="([^"]*)"/.exec(body)?.[1]?.split(/\s+/) ?? [];

describe('Button', () => {
  it('draws a plain button with its words and type button', () => {
    const body = button({});

    expect(body).toMatch(/^<button[^>]*type="button"/);
    expect(text(body)).toBe('Read the plan');
    expect(classOf(body)).toContain('btn');
    expect(['primary', 'go', 'ghost', 'sm', 'lg'].filter((name) => classOf(body).includes(name))).toEqual([]);
  });

  it.each([
    { variant: 'primary', fill: 'background: var(--accent);', ink: 'color: var(--accent-ink);' },
    { variant: 'go', fill: 'background: var(--amber);', ink: 'color: var(--on-status);' },
    { variant: 'ghost', fill: 'background: transparent;', ink: 'color: var(--ink-2);' },
  ])('draws the $variant variant with its class, and the class with its tokens', ({ variant, fill, ink }) => {
    const body = button({ variant });

    expect(classOf(body)).toContain(variant);
    expect(['primary', 'go', 'ghost'].filter((name) => classOf(body).includes(name))).toEqual([variant]);
    expect(rule('Button.svelte', `.${variant}`)).toContain(fill);
    expect(rule('Button.svelte', `.${variant}`)).toContain(ink);
  });

  it('draws the default button on the card with ink', () => {
    expect(rule('Button.svelte', '.btn')).toContain('background: var(--card);');
    expect(rule('Button.svelte', '.btn')).toContain('color: var(--ink);');
    expect(rule('Button.svelte', '.btn')).toContain('border-radius: var(--radius-md);');
  });

  // Every button is set at 400 and only go at 600, so go is the one heavy label.
  it('writes go as the one heavy label', () => {
    expect(rule('Button.svelte', '.btn')).toContain('font-weight: 400;');
    expect(rule('Button.svelte', '.go')).toContain('font-weight: 600;');
    for (const variant of ['.primary', '.ghost']) expect(rule('Button.svelte', variant)).not.toContain('font-weight');
  });

  // go is the one amber button in the whole client. The scan over every other component is in
  // amber.test.ts at the root.
  it('keeps amber on the go variant and nowhere else in the button', () => {
    expect(amberSelectors('Button.svelte')).toEqual(['.go']);
  });

  it.each([
    { size: 'small', name: 'sm', height: 'height: 26px;' },
    { size: 'large', name: 'lg', height: 'height: 42px;' },
  ])('draws the $size size with its class and height', ({ size, name, height }) => {
    expect(classOf(button({ size }))).toContain(name);
    expect(rule('Button.svelte', `.${name}`)).toContain(height);
  });

  it('takes the large radius on the large button', () => {
    expect(rule('Button.svelte', '.lg')).toContain('border-radius: var(--radius-lg);');
  });

  it('draws the key as a key cap after the words, hidden from a screen reader', () => {
    const body = button({ variant: 'primary', key: '⌘↵', children: words('Make card APP-1') });

    expect(body).toMatch(/<button[^>]*>[\s\S]*Make card APP-1[\s\S]*<kbd[^>]*aria-hidden="true"[^>]*>⌘↵<\/kbd>[\s\S]*<\/button>/);
    expect(button({})).not.toContain('<kbd');
  });

  it('writes the key cap in the ink of a filled button', () => {
    expect(rule('Button.svelte', '.go > :global(kbd)')).toContain('color: inherit;');
    expect(rule('Button.svelte', '.primary > :global(kbd)')).toContain('color: inherit;');
  });

  it('holds with the disabled attribute or with aria-disabled, and draws both muted', () => {
    expect(button({ disabled: true })).toMatch(/<button[^>]*\sdisabled/);
    const held = button({ 'aria-disabled': 'true' });
    expect(held).toContain('aria-disabled="true"');
    expect(held).not.toMatch(/<button[^>]*\sdisabled/);
    expect(button({})).not.toMatch(/<button[^>]*\sdisabled/);

    expect(rule('Button.svelte', '.btn:disabled')).toContain('color: var(--muted);');
    expect(rule('Button.svelte', ".btn[aria-disabled='true']")).toContain('color: var(--muted);');
    expect(rule('Button.svelte', ".btn[aria-disabled='true']")).not.toContain('amber');
  });

  it('passes every attribute through to the element', () => {
    const body = button({ type: 'submit', 'data-move': 'plan', 'aria-describedby': 'why', 'aria-busy': 'true', formaction: '?/go', title: 'Moves the card' });

    expect(body).toMatch(/^<button[^>]*type="submit"/);
    for (const one of ['data-move="plan"', 'aria-describedby="why"', 'aria-busy="true"', 'formaction="?/go"', 'title="Moves the card"']) expect(body).toContain(one);
  });

  it('adds a class the caller passes to its own', () => {
    expect(classOf(button({ variant: 'go', class: 'wide' }))).toEqual(expect.arrayContaining(['btn', 'go', 'wide']));
  });

  // A mark sits before the words of every go button: a bolt for a start, a send arrow
  // for a resume. The words are the name, so the mark is hidden from a screen reader.
  it('draws a bolt before the words of a go button, a send arrow for a resume, and no mark elsewhere', () => {
    const glyph = (body: string) => /<svg[^>]*data-glyph="(\w+)"[^>]*aria-hidden="true"/.exec(body)?.[1] ?? null;

    expect(glyph(button({ variant: 'go' }))).toBe('start');
    expect(glyph(button({ variant: 'go', glyph: 'resume' }))).toBe('resume');
    expect(button({ variant: 'go' })).toMatch(/^<button[^>]*>\s*<svg[\s\S]*<\/svg>\s*<span>Read the plan/);
    expect(button({ variant: 'go', glyph: null })).not.toContain('<svg');
    for (const variant of ['default', 'primary', 'ghost']) expect(button({ variant, glyph: 'start' })).not.toContain('<svg');
    expect(rule('Button.svelte', '.glyph')).toContain('stroke: currentColor;');
    // The name on the mark is not enough: a resume must draw another shape than a start.
    const path = (body: string) => /<path d="([^"]+)"/.exec(body)?.[1] ?? '';
    expect(path(button({ variant: 'go', glyph: 'resume' }))).not.toBe(path(button({ variant: 'go' })));
  });

  // Minimize is a ghost toggle. Pressed shows in the edge as well as in the attribute, so it is not
  // colour alone.
  it('draws a pressed ghost with a dashed edge', () => {
    expect(rule('Button.svelte', ".ghost[aria-pressed='true']")).toContain('border-style: dashed;');
  });
});

describe('Kbd', () => {
  it('draws one key cap with the keys in it', () => {
    const body = bare(render(Kbd, { props: { key: '⇧⌘↵' } }).body);

    expect(body).toMatch(/^<kbd[^>]*>⇧⌘↵<\/kbd>$/);
  });

  it('passes attributes through, so a caller can hide it from a screen reader', () => {
    expect(render(Kbd, { props: { key: 'W', 'aria-hidden': 'true', title: 'Or press W' } }).body).toMatch(/<kbd[^>]*aria-hidden="true"[^>]*title="Or press W"/);
  });

  it('draws the cap in mono at the key cap radius', () => {
    expect(rule('Kbd.svelte', 'kbd')).toContain('font-family: var(--font-mono);');
    expect(rule('Kbd.svelte', 'kbd')).toContain('border-radius: var(--radius-xs);');
    expect(rule('Kbd.svelte', 'kbd')).toContain('color: var(--muted);');
  });
});

describe('Chip', () => {
  it('draws a plain chip in the sans face', () => {
    const body = bare(render(Chip, { props: { children: words('in Plan') } }).body);

    expect(body).toMatch(/^<span class="chip[\s"]/);
    expect(body).not.toMatch(/class="[^"]*\bmono\b/);
    expect(text(body)).toBe('in Plan');
    expect(rule('Chip.svelte', '.chip')).toContain('color: var(--ink-2);');
    expect(rule('Chip.svelte', '.chip')).toContain('border-radius: var(--radius-sm);');
  });

  it('draws a mono chip for evidence such as a path', () => {
    const body = render(Chip, { props: { mono: true, children: words('api/src/recipes.ts') } }).body;

    expect(body).toMatch(/class="chip[^"]*\bmono\b/);
    expect(rule('Chip.svelte', '.mono')).toContain('font-family: var(--font-mono);');
  });
});

describe('StatePill', () => {
  it('names Quiet in words, with a clock in place of the dot', () => {
    const body = render(StatePill, { props: { state: 'quiet', detail: '6m' } }).body;

    expect(body).toContain('data-state="quiet"');
    expect(text(body)).toBe('Quiet 6m');
    expect(body).toMatch(/<svg class="clock[^"]*"[^>]*aria-hidden="true"/);
    expect(body).not.toContain('class="dot');
  });

  it('names New in words, on the blue of information', () => {
    const body = render(StatePill, { props: { state: 'new' } }).body;

    expect(body).toContain('data-state="new"');
    expect(text(body)).toBe('New');
    expect(rule('StatePill.svelte', "[data-state='new']")).toContain('color: var(--blue);');
    expect(rule('StatePill.svelte', "[data-state='new']")).toContain('background: var(--blue-bg);');
  });

  // A quiet run is not working, so it must not look like one: no amber, the idle ring of the base.
  it('draws Quiet without amber, in the muted ring of the base pill', () => {
    expect(amberSelectors('StatePill.svelte').filter((selector) => selector.includes('quiet'))).toEqual([]);
    expect(rule('StatePill.svelte', '.pill')).toContain('color: var(--muted);');
    expect(rule('StatePill.svelte', '.pill')).toContain('box-shadow: inset 0 0 0 1px var(--line-2);');
  });

  it.each([
    ['running', 'amber'],
    ['ready', 'green'],
    ['blocked', 'violet'],
    ['failed', 'red'],
  ])('draws %s in its colour on its own tint', (state, colour) => {
    expect(rule('StatePill.svelte', `[data-state='${state}']`)).toContain(`color: var(--${colour});`);
    expect(rule('StatePill.svelte', `[data-state='${state}']`)).toContain(`background: var(--${colour}-bg);`);
  });

  it('keeps the pill round and the queued state as a ring with no fill', () => {
    expect(rule('StatePill.svelte', '.pill')).toContain('border-radius: 999px;');
    expect(rule('StatePill.svelte', "[data-state='queued']")).toContain('box-shadow: inset 0 0 0 1px var(--amber-line);');
    expect(rule('StatePill.svelte', "[data-state='queued']")).not.toContain('background');
  });

  // The minimized card shows the dot alone, so the box around it goes too.
  it('drops the box around the dot when the word is hidden', () => {
    expect(rule('StatePill.svelte', "[data-word-hidden='true']")).toContain('background: none;');
    expect(rule('StatePill.svelte', "[data-word-hidden='true']")).toContain('padding: 0;');
    // The hidden word still leaves an empty item, and a gap beside it would push the dot off centre.
    expect(rule('StatePill.svelte', "[data-word-hidden='true']")).toContain('gap: 0;');
  });

  // A screen may name the state in its own words, such as the board card's "Asks you". Every other
  // caller keeps the default, so every other screen reads as before.
  it('takes a word from the caller in place of the default one', () => {
    expect(text(render(StatePill, { props: { state: 'blocked', word: 'Asks you' } }).body)).toBe('Asks you');
    expect(text(render(StatePill, { props: { state: 'blocked' } }).body)).toBe('Blocked');
  });

  // The running card's pill shows its run time alone.
  it('shows the detail alone when asked, and keeps the word for a screen reader', () => {
    const body = render(StatePill, { props: { state: 'running', detail: '0m 40s', detailOnly: true } }).body;

    expect(body).toContain('data-detail-only="true"');
    expect(text(body)).toBe('Running 0m 40s');
    expect(rule('StatePill.svelte', "[data-detail-only='true'] .label")).toContain('clip-path: inset(50%);');
    expect(rule('StatePill.svelte', "[data-detail-only='true'] .detail")).toContain('font-family: var(--font-mono);');
    // With no detail, the word is all the pill has, so it stays in sight.
    expect(render(StatePill, { props: { state: 'running', detailOnly: true } }).body).not.toContain('data-detail-only');
  });
});

describe('Switch', () => {
  it('is a switch to a screen reader, named by the caller, and off by default', () => {
    const body = bare(render(Switch, { props: { 'aria-label': 'Keep the computer awake' } }).body);

    expect(body).toMatch(/^<button[^>]*type="button"/);
    expect(body).toContain('role="switch"');
    expect(body).toContain('aria-checked="false"');
    expect(body).toContain('aria-label="Keep the computer awake"');
  });

  it('says it is on with aria-checked', () => {
    expect(render(Switch, { props: { checked: true, 'aria-label': 'On' } }).body).toContain('aria-checked="true"');
  });

  it('passes the disabled attribute through', () => {
    expect(render(Switch, { props: { disabled: true, 'aria-label': 'Always on' } }).body).toMatch(/<button[^>]*\sdisabled/);
    expect(render(Switch, { props: { 'aria-label': 'Off' } }).body).not.toMatch(/<button[^>]*\sdisabled/);
  });

  // The pairs tokens.test.ts measures at 3:1: ink on line-2 off, accent-ink on accent on.
  it('draws the knob in ink on the line track when off', () => {
    expect(rule('Switch.svelte', '.switch')).toContain('background: var(--line-2);');
    expect(rule('Switch.svelte', '.switch::after')).toContain('background: var(--ink);');
  });

  it('is cream when on and never amber', () => {
    expect(rule('Switch.svelte', ".switch[aria-checked='true']")).toContain('background: var(--accent);');
    expect(rule('Switch.svelte', ".switch[aria-checked='true']::after")).toContain('background: var(--accent-ink);');
    expect(amberSelectors('Switch.svelte')).toEqual([]);
  });
});

describe('Banner', () => {
  type Kind = 'info' | 'ok' | 'warning' | 'error';
  const draw = (kind: Kind) => render(Banner, { props: { kind, children: words('The board is offline.') } }).body;
  const icon = (body: string) => /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(body)?.[1]?.replace(/<!--.*?-->/g, '');

  it.each([
    ['info', 'status', 'blue-bg'],
    ['ok', 'status', 'green-bg'],
    ['error', 'alert', 'red-bg'],
    ['warning', 'status', 'card'],
  ] as const)('draws the %s banner as a %s on %s', (kind, role, fill) => {
    const body = draw(kind);

    expect(body).toContain(`data-kind="${kind}"`);
    expect(body).toContain(`role="${role}"`);
    expect(text(body)).toBe('The board is offline.');
    expect(body).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(rule('Banner.svelte', `[data-kind='${kind}']`)).toContain(`background: var(--${fill});`);
  });

  it('gives each kind its own icon, so the kind is not told by the tint alone', () => {
    expect(new Set((['info', 'ok', 'warning', 'error'] as const).map((kind) => icon(draw(kind)))).size).toBe(4);
    // An empty icon is still a different one, so each must draw a shape. The warning box has only its icon.
    for (const kind of ['info', 'ok', 'warning', 'error'] as const) expect(icon(draw(kind))).toMatch(/<(?:path|circle)\b/);
  });

  // `docs/design-system.md`: a warning is a neutral box with a warning icon, never amber.
  it('draws the warning as a neutral box with a muted edge and no amber', () => {
    expect(rule('Banner.svelte', "[data-kind='warning']")).toContain('border-left: 2px solid var(--muted);');
    expect(rule('Banner.svelte', "[data-kind='warning'] .icon")).toContain('color: var(--muted);');
    expect(amberSelectors('Banner.svelte')).toEqual([]);
  });
});

describe('ErrorBox', () => {
  const output = "$ git push origin APP-1\n ! [rejected]        APP-1 -> APP-1 (fetch first)\nerror: failed to push some refs to 'origin'";
  const props = { title: 'APP-1 was not pushed.', output, fix: 'Pull the new commits into the checkout, then push again.' };

  it('names the problem as the alert, then the raw output in mono, then the fix', () => {
    const body = render(ErrorBox, { props }).body;

    expect(body).toMatch(/<p class="head[^"]*"[^>]*role="alert"[^>]*>[\s\S]*APP-1 was not pushed\./);
    expect(body).toContain('<pre');
    expect(/<pre[^>]*>([\s\S]*)<\/pre>/.exec(body)?.[1]).toBe(output);
    expect(body.indexOf('APP-1 was not pushed.')).toBeLessThan(body.indexOf('<pre'));
    expect(body.indexOf('</pre>')).toBeLessThan(body.indexOf('Pull the new commits'));
    expect(rule('ErrorBox.svelte', 'pre')).toContain('font-family: var(--font-mono);');
    expect(rule('ErrorBox.svelte', 'pre')).toContain('white-space: pre-wrap;');
  });

  it('labels the box by its title, and only the title is the alert', () => {
    const body = render(ErrorBox, { props }).body;
    const id = /<section[^>]*aria-labelledby="([^"]+)"/.exec(body)?.[1];

    expect(id).toBeTruthy();
    expect(body).toContain(`id="${id}"`);
    expect(body.match(/role="alert"/g)).toHaveLength(1);
    expect(body).not.toMatch(/<section[^>]*role=/);
  });

  it('writes the reason after the bold title, inside the alert', () => {
    const body = render(ErrorBox, { props: { ...props, reason: 'GitHub has commits the checkout does not.' } }).body;
    const alert = /<p[^>]*role="alert"[^>]*>([\s\S]*?)<\/p>/.exec(body)?.[1]?.replace(/<!--.*?-->/g, '') ?? '';

    expect(alert).toMatch(/<b[^>]*>APP-1 was not pushed\.<\/b> GitHub has commits the checkout does not\./);
    expect(text(render(ErrorBox, { props }).body)).not.toContain('GitHub has');
  });

  it('offers Copy output only when the page can copy', () => {
    expect(text(render(ErrorBox, { props }).body)).not.toContain('Copy output');
    expect(text(render(ErrorBox, { props: { ...props, children: words('Pull into the checkout') } }).body)).not.toContain('Copy output');
    expect(text(render(ErrorBox, { props: { ...props, oncopy: async () => null } }).body)).toContain('Copy output');
  });

  it('draws the fix buttons the caller hands it after the fix sentence', () => {
    const body = render(ErrorBox, { props: { ...props, children: words('Pull into the checkout') } }).body;

    expect(body.indexOf('Pull the new commits')).toBeLessThan(body.indexOf('Pull into the checkout'));
  });
});

// Colours come from the tokens, so a part cannot drift from the design system.
it.each(['Banner.svelte', 'Button.svelte', 'Chip.svelte', 'ErrorBox.svelte', 'Kbd.svelte', 'Switch.svelte'])('sets no colour literal in %s', (name) => {
  const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

  expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(source).not.toMatch(/oklch\(|rgba?\(|hsla?\(/);
});

// The overlay parts take every colour from the tokens too, the scrim behind a dialog
// included.
it.each(['Dialog.svelte', 'ConfirmTyped.svelte', 'ToastHost.svelte'])('sets no colour literal in %s', (name) => {
  const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

  expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(source).not.toMatch(/oklch\(|rgba?\(|hsla?\(/);
});

// Nothing in a dialog shell, a typed confirm or a toast starts a run, so none of them is amber. A
// warning is neutral (`docs/design-system.md`).
it.each(['Dialog.svelte', 'ConfirmTyped.svelte', 'ToastHost.svelte'])('writes no amber in %s', (name) => {
  expect(amberSelectors(name)).toEqual([]);
});

it('draws the danger button as red words and a red edge on no fill', () => {
  const body = button({ variant: 'danger' });

  expect(classOf(body)).toContain('danger');
  expect(rule('Button.svelte', '.danger')).toContain('color: var(--red);');
  expect(rule('Button.svelte', '.danger')).toContain('background: transparent;');
  expect(rule('Button.svelte', '.danger')).toContain('border-color: color-mix(in oklch, var(--red) 45%, transparent);');
});

it('draws the dialog at the dialog radius, over the scrim, with the footer on the panel', () => {
  expect(rule('Dialog.svelte', 'dialog')).toContain('border-radius: var(--radius-2xl);');
  expect(rule('Dialog.svelte', 'dialog')).toContain('box-shadow: var(--shadow);');
  expect(rule('Dialog.svelte', 'dialog::backdrop')).toContain('background: var(--scrim);');
  expect(rule('Dialog.svelte', '.foot')).toContain('background: var(--panel);');
});

// The host is the one place toasts sit, so a second toast stacks under the first instead of on top of it.
it('stacks the toasts in one fixed corner', () => {
  expect(rule('ToastHost.svelte', '.toasts')).toContain('position: fixed;');
  expect(rule('ToastHost.svelte', '.toasts')).toContain('flex-direction: column;');
  expect(rule('ToastHost.svelte', '[data-kind=\'warning\'] .icon')).toContain('color: var(--muted);');
});

// Keys, models, times and costs are set in Geist Mono (`docs/design-system.md`).
it.each(['.key', '.run'])('sets the toast %s in mono', (selector) => {
  expect(rule('ToastHost.svelte', selector)).toContain('font-family: var(--font-mono);');
});

describe('SlotsMeter', () => {
  const meter = (busy: number, total: number) => bare(render(SlotsMeter, { props: { slots: { busy, total } } }).body);

  it('draws a block per slot, the busy ones marked, and says the count in words', () => {
    const body = meter(2, 3);

    expect([...body.matchAll(/<i\b/g)]).toHaveLength(3);
    expect([...body.matchAll(/<i data-busy="true"/g)]).toHaveLength(2);
    expect(body).toMatch(/<span class="blocks[^"]*" aria-hidden="true">/);
    expect(text(body)).toBe('2 of 3 agent slots busy');
  });

  it('says a free machine is free, with every block empty', () => {
    const body = meter(0, 3);

    expect(body).not.toContain('data-busy');
    expect(text(body)).toBe('0 of 3 agent slots busy');
  });

  // A board may send no slots. Nothing to count is nothing drawn, never a made-up number.
  it('draws nothing when the snapshot has no slots', () => {
    expect(meter(0, 0)).toBe('');
  });

  it('draws a busy slot amber and a free one faint', () => {
    expect(rule('SlotsMeter.svelte', 'i')).toContain('background: var(--faint);');
    expect(rule('SlotsMeter.svelte', "[data-busy='true']")).toContain('background: var(--amber);');
    expect(rule('SlotsMeter.svelte', 'i')).toContain('border-radius: var(--radius-xs);');
  });
});

describe('LaneChips', () => {
  const chips = (lanes: { name: string; heldBy: string | null }[]) => bare(render(LaneChips, { props: { lanes } }).body);

  it('names each lane the snapshot sends, in its order, and says it is free', () => {
    const body = chips([
      { name: 'stack', heldBy: null },
      { name: 'knowledge', heldBy: null },
      { name: 'scout', heldBy: null },
    ]);

    expect([...body.matchAll(/class="chip[^"]*"[^>]*>([\s\S]*?)<\/span>(?=\s*<span class="chip|\s*<\/span>$)/g)].map((match) => text(match[1]!))).toEqual(['Stack lane free', 'Knowledge lane free', 'Scout lane free']);
    expect(body).not.toContain('data-held');
  });

  it('names the card that holds a lane by its key in mono, and the runs that are not cards in words', () => {
    const body = chips([
      { name: 'stack', heldBy: 'APP-1' },
      { name: 'knowledge', heldBy: 'kb-maintenance' },
      { name: 'scout', heldBy: 'assess-7' },
    ]);

    expect(text(body)).toBe('Stack lane busy with APP-1 Knowledge lane busy with a maintenance run Scout lane busy with an assessment');
    expect(body).toContain('<span class="key');
    expect([...body.matchAll(/data-held="true"/g)]).toHaveLength(3);
    expect(rule('LaneChips.svelte', '.key')).toContain('font-family: var(--font-mono);');
  });

  // Each chip names the card that holds its own lane, not one card for all of them.
  it('names a different card on each lane it holds', () => {
    const body = chips([
      { name: 'stack', heldBy: 'APP-7' },
      { name: 'knowledge', heldBy: 'WEB-12' },
    ]);

    expect(text(body)).toBe('Stack lane busy with APP-7 Knowledge lane busy with WEB-12');
  });

  it('draws nothing when the snapshot has no lanes', () => {
    expect(chips([])).toBe('');
  });

  it('marks a free lane green and a held one amber, beside the words', () => {
    expect(rule('LaneChips.svelte', '.dot')).toContain('background: var(--green);');
    expect(rule('LaneChips.svelte', ".dot[data-held='true']")).toContain('background: var(--amber);');
  });
});

describe('CoachNote', () => {
  const props = { note: 'first-drag', seen: [] as string[], title: 'Dropping a card here is your approval', ondismiss: () => {} };
  const note = (over: Record<string, unknown> = {}) =>
    bare(render(CoachNote, { props: { ...props, children: words('Refine rewrites the ticket. It changes no code.'), ...over } }).body);

  it('is a note named by its title, with the words and a Got it button', () => {
    const body = note();
    const id = /<div class="coach[^"]*" role="note" aria-labelledby="([^"]+)"/.exec(body)?.[1];

    expect(id).toBeTruthy();
    expect(body).toMatch(new RegExp(`<b class="title[^"]*" id="${id}">Dropping a card here is your approval</b>`));
    expect(text(body)).toBe('Dropping a card here is your approval Refine rewrites the ticket. It changes no code. Got it');
    expect(body).toMatch(/<button[^>]*data-dismiss-note="first-drag"[^>]*>\s*Got it/);
  });

  // The hint wraps in its own column beside Got it. A foot that wraps drops it under the button.
  it('draws the hint beside Got it', () => {
    const hint = createRawSnippet(() => ({ render: () => '<span>No mouse? Select the card and press <kbd>⇧→</kbd></span>' }));

    expect(text(note({ hint }))).toContain('Got it No mouse? Select the card and press ⇧→');
    expect(rule('CoachNote.svelte', '.foot')).toContain('display: flex;');
    expect(rule('CoachNote.svelte', '.foot')).not.toContain('flex-wrap');
    expect(rule('CoachNote.svelte', '.hint')).toContain('min-width: 0;');
  });

  // Shown once: a note the person closed is in the seen list and draws nothing.
  it('draws nothing once its name is in the seen list, and still draws for another note', () => {
    expect(note({ seen: ['first-drag'] })).toBe('');
    expect(note({ seen: ['other-note'] })).toContain('role="note"');
  });

  it('is cream with accent-ink words, at the dialog radius, and floats with a shadow', () => {
    expect(rule('CoachNote.svelte', '.coach')).toContain('background: var(--accent);');
    expect(rule('CoachNote.svelte', '.coach')).toContain('color: var(--accent-ink);');
    expect(rule('CoachNote.svelte', '.coach')).toContain('border-radius: var(--radius-2xl);');
    expect(rule('CoachNote.svelte', '.coach')).toContain('box-shadow: var(--shadow);');
  });

  // The note explains a run and starts none. Text never takes opacity, and no test measures a faded pair.
  it('writes no amber and fades no text', () => {
    expect(amberSelectors('CoachNote.svelte')).toEqual([]);
    expect(readFileSync(new URL('./CoachNote.svelte', import.meta.url), 'utf8')).not.toMatch(/opacity/);
  });

  // The style rules are not the only road: a style attribute or the go button would paint it amber too.
  it('draws no amber in its markup and no go button', () => {
    const body = note();

    expect(body).not.toMatch(/var\(--(amber|amber-bg|amber-line|amber-tint|hatch)\)/);
    expect(/<button[^>]*class="([^"]*)"/.exec(body)?.[1]?.split(/\s+/)).not.toContain('go');
  });

  // The page ring is the accent, the note's own fill, so inside the note it takes the note's ink.
  it('draws Got it in the note ink and the focus ring in a colour that shows on cream', () => {
    expect(rule('CoachNote.svelte', '.coach :global(.btn.dismiss)')).toContain('color: inherit;');
    expect(rule('CoachNote.svelte', '.coach :global(.btn.dismiss)')).toContain('background: transparent;');
    expect(rule('CoachNote.svelte', '.coach :global(:focus-visible)')).toContain('outline-color: var(--accent-ink);');
  });
});

describe('OptionButtons', () => {
  const options = [
    { label: '1 to 5 stars', means: 'New column in recipes, one migration' },
    { label: 'Thumbs up and down', means: 'Reuses the likes table, no migration' },
  ];
  const draw = (over: Record<string, unknown> = {}) => bare(render(OptionButtons, { props: { options, answer: '', onpick: () => {}, ...over } }).body);
  const buttons = (body: string) => [...body.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({ attributes: match[1]!, said: text(match[2]!) }));

  it('draws a named group with one plain button per option, its label and what it means', () => {
    const body = draw();

    expect(body).toMatch(/^<div class="opts[^"]*" role="group" aria-label="Answers the agent offered">/);
    expect(buttons(body).map((one) => one.said)).toEqual(['1 to 5 stars New column in recipes, one migration', 'Thumbs up and down Reuses the likes table, no migration']);
    for (const one of buttons(body)) {
      expect(one.attributes).toContain('type="button"');
      expect(one.attributes).toContain('aria-pressed="false"');
    }
    expect(body).not.toContain('<svg');
  });

  it('shows the option pressed, with a check, while the answer is its label', () => {
    const body = draw({ answer: ' 1 to 5 stars ' });

    expect(buttons(body).map((one) => /aria-pressed="(\w+)"/.exec(one.attributes)?.[1])).toEqual(['true', 'false']);
    expect(body).toMatch(/aria-pressed="true"[^>]*>\s*<span class="label[^"]*">\s*<svg[^>]*aria-hidden="true"/);
    expect(buttons(draw({ answer: '1 to 5 stars, half stars allowed' })).every((one) => one.attributes.includes('aria-pressed="false"'))).toBe(true);
  });

  it('draws only the labels in the compact pills', () => {
    const body = draw({ compact: true });

    expect(body).toMatch(/class="opts[^"]*\bcompact\b/);
    expect(buttons(body).map((one) => one.said)).toEqual(['1 to 5 stars', 'Thumbs up and down']);
    expect(rule('OptionButtons.svelte', '.compact .opt')).toContain('border-radius: 999px;');
  });

  // An option with no meaning draws its label alone, with no empty line under it.
  it('draws only the label of an option with no meaning', () => {
    const body = draw({ options: [{ label: 'Thumbs up and down' }, { label: '1 to 5 stars', means: null }] });

    expect(buttons(body).map((one) => one.said)).toEqual(['Thumbs up and down', '1 to 5 stars']);
    expect(body).not.toContain('class="means');
  });

  it('draws nothing when the agent offered no options', () => {
    expect(draw({ options: [] })).toBe('');
  });

  // A press fills the answer and starts nothing, so no option is amber. The violet edge is a question.
  it('edges an option in violet, draws pressed in ink, and writes no amber', () => {
    expect(rule('OptionButtons.svelte', '.opt')).toContain('border: 1px solid color-mix(in oklch, var(--violet) 50%, transparent);');
    expect(rule('OptionButtons.svelte', '.opt')).toContain('background: var(--card);');
    expect(rule('OptionButtons.svelte', ".opt[aria-pressed='true']")).toContain('border-color: var(--ink);');
    expect(rule('OptionButtons.svelte', '.means')).toContain('color: var(--muted);');
    expect(amberSelectors('OptionButtons.svelte')).toEqual([]);
  });

  // The page draws the focus ring on every control. An option must not take it away.
  it('keeps the focus ring of the page', () => {
    const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

    expect(/:focus-visible \{([^}]*)\}/.exec(tokens)?.[1]).toContain('outline: 2px solid var(--accent);');
    expect(readFileSync(new URL('./OptionButtons.svelte', import.meta.url), 'utf8')).not.toMatch(/outline/);
  });
});

// These parts take every colour from the tokens too.
it.each(['SlotsMeter.svelte', 'LaneChips.svelte', 'CoachNote.svelte', 'OptionButtons.svelte'])('sets no colour literal in %s', (name) => {
  const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');

  expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(source).not.toMatch(/oklch\(|rgba?\(|hsla?\(/);
});
