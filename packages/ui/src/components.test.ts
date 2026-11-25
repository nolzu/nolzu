import { readFileSync } from 'node:fs';
import type { CardState, StageRole } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import Markdown from './Markdown.svelte';
import { sanitize } from './markdown.ts';
import RoleGlyph from './RoleGlyph.svelte';
import StatePill from './StatePill.svelte';
import Toast from './Toast.svelte';

const STATES: CardState[] = ['idle', 'queued', 'running', 'ready', 'blocked', 'failed'];
const ROLES: StageRole[] = ['you', 'agent', 'auto', 'archive'];

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

it('names the running state in words and marks it on the element', () => {
  const { body } = render(StatePill, { props: { state: 'running' } });
  expect(body).toContain('data-state="running"');
  expect(text(body)).toContain('Running');
});

it.each(STATES)('gives the %s state a visible label, so colour is never the only signal', (state) => {
  const { body } = render(StatePill, { props: { state } });
  expect(text(body).length).toBeGreaterThan(0);
});

it('hides the colour dot from assistive technology, so the word is read once', () => {
  const { body } = render(StatePill, { props: { state: 'blocked' } });
  expect(body).toContain('aria-hidden="true"');
});

it('shows the detail next to the state when one is given', () => {
  const { body } = render(StatePill, { props: { state: 'queued', detail: '2nd' } });
  // "Queued 1st": a word space and no separator, so nothing is read out as a symbol.
  expect(body.replace(/<!--.*?-->/g, '')).toMatch(/Queued<\/span> <span class="detail[^"]*">2nd<\/span>/);
  expect(body).not.toContain('·');
});

it.each(ROLES)('gives the %s role its own word', (role) => {
  const { body } = render(RoleGlyph, { props: { role } });
  expect(text(body).length).toBeGreaterThan(0);
});

it('draws its own line glyph for each role, hidden from assistive technology', () => {
  const glyphs = ROLES.map((role) => /<svg[^>]*>(.*?)<\/svg>/s.exec(render(RoleGlyph, { props: { role } }).body));
  expect(glyphs.every((glyph) => glyph !== null && glyph[0].includes('aria-hidden="true"'))).toBe(true);
  expect(new Set(glyphs.map((glyph) => glyph![1]!.replace(/<!--.*?-->/g, ''))).size).toBe(ROLES.length);
});

it('says in words when an agent stage starts nothing yet', () => {
  const { body } = render(RoleGlyph, { props: { role: 'agent', startsNothing: true } });
  expect(text(body)).toBe('Agent, starts nothing yet');
  expect(render(RoleGlyph, { props: { role: 'agent' } }).body).not.toContain('starts nothing');
});

it('reads an error toast out as an alert and keeps the fix next to the problem', () => {
  const { body } = render(Toast, { props: { kind: 'error', message: 'sonnet is gone.', fix: 'Settings, Models.' } });
  expect(body).toContain('role="alert"');
  expect(text(body)).toBe('sonnet is gone. Settings, Models.');
});

it('shows markdown as its source on the server, with no tag from it', () => {
  const source = '# Title\n\n<script>alert(1)</script>';
  const { body } = render(Markdown, { props: { source } });

  // The server has no DOM for the sanitizer, so it must not render markup at all. The source
  // goes out as text, and the browser swaps the rendered form in.
  expect(body).toMatch(/<pre[^>]*># Title\n\n&lt;script>alert\(1\)&lt;\/script><\/pre>/);
  expect(body).not.toContain('<script');
  expect(body).not.toContain('<h1');
});

it('refuses to sanitize without a DOM, instead of passing markup through', () => {
  // This file runs with no DOM on purpose. DOMPurify without one returns its input unchanged,
  // which would look like a cleaned page and be the raw one.
  expect(() => sanitize('<script>alert(1)</script>')).toThrow(/needs a DOM/);
});

it.each(['Markdown.svelte', 'StatePill.svelte', 'RoleGlyph.svelte', 'Toast.svelte'])('sets no colour literal in %s', (name) => {
  const source = readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
  // Colours come from the tokens, so a component cannot drift from the design system.
  expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(source).not.toMatch(/oklch\(/);
});

// Amber only where an agent starts work. The glyph of a person, auto or archive
// column, and of an agent column that starts nothing, stays muted. A render carries no CSS, so this
// reads the rules.
it('paints the glyph amber only for an agent that starts work', () => {
  const source = readFileSync(new URL('./RoleGlyph.svelte', import.meta.url), 'utf8');
  const style = source.slice(source.indexOf('<style>')).replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const amber = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((rule) => /--amber/.test(rule[2]!)).map((rule) => rule[1]!.trim());

  expect(amber).toEqual(["[data-role='agent']:not([data-starts-nothing='true'])"]);
});

it('hides the role word from sight and keeps it for screen readers', () => {
  // Without this rule the word shows again under every column header, and no render test sees it.
  const source = readFileSync(new URL('./RoleGlyph.svelte', import.meta.url), 'utf8');
  const rule = /\.word \{([^}]*)\}/.exec(source)?.[1] ?? '';
  expect(rule).toContain('position: absolute;');
  expect(rule).toContain('clip-path: inset(50%);');
  expect(rule).not.toContain('display: none');
});

it('hides the state word from sight when asked, and keeps it for screen readers', () => {
  const source = readFileSync(new URL('./StatePill.svelte', import.meta.url), 'utf8');
  const rule = /\[data-word-hidden='true'\] \.label \{([^}]*)\}/.exec(source)?.[1] ?? '';
  expect(rule).toContain('position: absolute;');
  expect(rule).toContain('clip-path: inset(50%);');
});

it('draws the queued dot as a ring and pulses the running one', () => {
  const source = readFileSync(new URL('./StatePill.svelte', import.meta.url), 'utf8');
  expect(/\[data-state='queued'\] \.dot \{([^}]*)\}/.exec(source)?.[1]).toMatch(/background: transparent;[\s\S]*border: 1\.5px solid var\(--amber\)/);
  expect(/\[data-state='running'\] \.dot \{([^}]*)\}/.exec(source)?.[1]).toContain('animation: pulse');
});

it('names the card first, as a link to it, when the toast is about one', () => {
  const { body } = render(Toast, { props: { kind: 'error', card: { key: 'APP-1', href: '/t/APP-1' }, message: 'sonnet is gone.' } });

  expect(body.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()).toBe('APP-1: sonnet is gone.');
  expect(body).toMatch(/<a href="\/t\/APP-1"[^>]*>APP-1<\/a>/);
});

it('closes with a button that says Close to a screen reader', () => {
  const { body } = render(Toast, { props: { message: 'Saved.', onclose: () => {} } });

  expect(body).toMatch(/<button[^>]*aria-label="Close"[^>]*>/);
});

it('marks the kind with a bar on the left and sits in one fixed place on every page', () => {
  const source = readFileSync(new URL('./Toast.svelte', import.meta.url), 'utf8');
  const bar = (kind: string) => new RegExp(`\\[data-kind='${kind}'\\] \\{\\s*border-left-color: var\\(--([a-z]+)\\)`).exec(source)?.[1];

  expect(['success', 'warning', 'error', 'info'].map(bar)).toEqual(['green', 'muted', 'red', 'blue']);
  expect(/\.toast \{([^}]*)\}/.exec(source)?.[1]).toMatch(/position: fixed;[\s\S]*border-left: 2px solid/);
});

// No DOM here lays out a page, so the rules that keep rendered markdown inside its box are
// read off the component. Inline code breaks only a word too long for a line, and a code block or a
// table scrolls.
it('keeps rendered code and tables inside the markdown box', () => {
  const component = readFileSync(new URL('./Markdown.svelte', import.meta.url), 'utf8');

  expect(component).toMatch(/\.markdown :global\(code\) \{[^}]*overflow-wrap: anywhere/);
  // break-all splits every path in the middle ("composer.jso n"), even one that fits on the next line.
  expect(component).not.toMatch(/break-all/);
  expect(component).toMatch(/\.markdown :global\(pre\) \{[^}]*overflow-x: auto/);
  expect(component).toMatch(/\.markdown :global\(table\) \{[^}]*overflow-x: auto/);
});

// Add card: the dialog opens 64px from the top, as the keyboard help does, and the Description
// box is three lines tall before anything is typed. No DOM here lays out a page, so the rules are read.
it('draws Add card 64px from the top with a three line Description', () => {
  const dialog = readFileSync(new URL('./Dialog.svelte', import.meta.url), 'utf8');
  const add = readFileSync(new URL('./board/AddCardDialog.svelte', import.meta.url), 'utf8');

  expect(dialog).toMatch(/dialog\.medium,\s*dialog\.wide \{[^}]*margin-top: min\(64px, 8vh\);/);
  expect(add).toContain('<textarea id="card-description" rows="3"');
  expect(add).toMatch(/#card-description \{\s*min-height: calc\(4\.5em \+ 22px\);/);
});

// At 390px the Extra context row squeezed into three columns and broke its name over two lines. The
// row wraps instead, so the hint drops below and the name stays on one line.
it('wraps the Extra context row rather than breaking its name', () => {
  const add = readFileSync(new URL('./board/AddCardDialog.svelte', import.meta.url), 'utf8');

  expect(add).toContain('<span class="fold-name">Extra context</span>');
  expect(add).toMatch(/\.fold summary \{[^}]*flex-wrap: wrap;[^}]*min-height: 34px;/);
  expect(add).not.toMatch(/\.fold summary \{[^}]*\n {4}height:/);
  expect(add).toMatch(/\.fold-name \{\s*white-space: nowrap;/);
});

// The Skeleton's mounted shapes are in Skeleton.mount.test.ts; this rule only shows in the source.
it('stops the skeleton pulse when the system asks for less motion', () => {
  const source = readFileSync(new URL('./Skeleton.svelte', import.meta.url), 'utf8');

  expect(source).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.bone \{\s*animation: none;/);
});

// A skeleton row taller than a found tool's row made the page jump up when the look landed. Each bar
// stands in a line box of the text it replaces, and nothing sets a taller minimum.
it('makes a skeleton row as tall as a found tool row', () => {
  const source = readFileSync(new URL('./Skeleton.svelte', import.meta.url), 'utf8');
  const rule = (selector: string) => new RegExp(`(?<!,)\\n  ${selector.replace(/[.,]/g, '\\$&')} \\{([^}]*)\\}`).exec(source)?.[1] ?? '';

  expect(rule('.row')).toContain('font-size: var(--text-sm);');
  expect(rule('.row')).not.toMatch(/grid-auto-rows|min-height/);
  expect(source).toMatch(/\.name,\s*\.meta \{\s*margin-block: calc\(\(1lh - 10px\) \/ 2\);/);
  expect(rule('.meta')).toContain('font-size: var(--mono-xs);');
});
