import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Amber means an agent starts or resumes work (`docs/design-system.md`), and the go variant of
// Button is the one button that says so. No other component puts amber on a control or inside one:
// no fill, ink, edge or mark. This reads the source, because a server render carries no CSS. Amber that reaches a
// control through `currentColor` from an amber parent is out of its reach.
const ROOTS = ['packages/ui/src', 'apps/local/src'];
const BUTTON = 'packages/ui/src/Button.svelte';
const AMBER = /var\(--(?:amber|amber-bg|amber-line|amber-tint|hatch)\)/;
// What a person presses: a button, a link, a disclosure, and the Button part, which takes a class.
const CONTROLS = new Set(['button', 'a', 'summary', 'Button']);
// The classes Button puts on itself for its variants and sizes. A caller reaches them with :global.
const BUTTON_CLASSES = /\.(?:primary|go|ghost|sm|lg)(?![\w-])/;

const files = ROOTS.flatMap((root) =>
  readdirSync(join(import.meta.dirname, root), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.svelte'))
    .map((file) => `${root}/${file}`),
).filter((file) => file !== BUTTON);

// Every opening tag of the markup with its attributes, and where the tag ends. An attribute such as
// `onclick={() => a > b}` holds a `>` that does not end the tag, so braces and quotes are counted.
function tags(markup: string): { name: string; attributes: string; end: number }[] {
  const found: { name: string; attributes: string; end: number }[] = [];
  for (const match of markup.matchAll(/<([A-Za-z][\w-]*)(?=[\s>/])/g)) {
    let at = match.index + match[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; at < markup.length; at++) {
      const char = markup[at]!;
      if (quote !== null) {
        if (char === quote) quote = null;
      } else if (depth === 0 && (char === '"' || char === "'")) quote = char;
      else if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === '>' && depth === 0) break;
    }
    found.push({ name: match[1]!, attributes: markup.slice(match.index + match[0].length, at), end: at });
  }
  return found;
}

function controlTags(markup: string) {
  return tags(markup).filter((tag) => CONTROLS.has(tag.name) || /\brole=["']button["']/.test(tag.attributes));
}

// The classes, and the data and aria attribute names, of one tag.
function namesOf(attributes: string): string[] {
  return [
    ...(/\bclass="([^"]*)"/.exec(attributes)?.[1]?.split(/\s+/) ?? []).filter((one) => one !== '' && !/[{}]/.test(one)),
    ...[...(/\bclass=\{([^}]*)\}/.exec(attributes)?.[1]?.matchAll(/['"]([\w\s-]+)['"]/g) ?? [])].flatMap((literal) => literal[1]!.split(/\s+/)).filter((one) => one !== ''),
    ...[...attributes.matchAll(/\bclass:([\w-]+)/g)].map((directive) => directive[1]!),
    ...[...attributes.matchAll(/(?:^|\s)((?:data|aria)-[\w-]+)(?=[\s=/]|$)/g)].map((attribute) => attribute[1]!),
  ];
}

// The names on a control and on every tag written inside it. A rule that names one of them reaches a
// control, or a mark inside one. A part drawn inside through a snippet is out of reach.
function controlNames(markup: string): Set<string> {
  const names = new Set<string>();
  for (const control of controlTags(markup)) {
    for (const one of namesOf(control.attributes)) names.add(one);
    if (control.attributes.trimEnd().endsWith('/')) continue;
    // A closing tag may break its line before the >, as `</button\n>` does to keep text off the edge.
    const closing = new RegExp(`</${control.name}\\s*>`, 'g');
    closing.lastIndex = control.end;
    const close = closing.exec(markup)?.index ?? -1;
    const inside = close === -1 ? '' : markup.slice(control.end + 1, close);
    for (const tag of tags(inside)) for (const one of namesOf(tag.attributes)) names.add(one);
  }
  return names;
}

// Every selector of the file's own style that puts amber on a control, and every control that writes
// amber in its own style attribute.
function amberOnControls(source: string): string[] {
  const markup = source
    .replace(/<style>[\s\S]*<\/style>/, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const names = controlNames(markup);
  const css = (/<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  const reaches = (selector: string) =>
    /(?:^|[\s>+~(])(?:button|summary|a)(?=$|[\s.#[:>+~)])/.test(selector) ||
    /\[role=['"]?button/.test(selector) ||
    /\.btn\b/.test(selector) ||
    (/<Button\b/.test(markup) && BUTTON_CLASSES.test(selector)) ||
    [...selector.matchAll(/\.([\w-]+)/g)].some((match) => names.has(match[1]!)) ||
    [...selector.matchAll(/\[([\w-]+)/g)].some((match) => names.has(match[1]!));

  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => AMBER.test(match[2]!))
    .flatMap((match) => match[1]!.split(',').map((one) => one.trim()).filter(reaches));
  const inline = controlTags(markup)
    .filter((tag) => AMBER.test(tag.attributes))
    .map((tag) => `<${tag.name}> style`);
  return [...rules, ...inline];
}

it('finds the components, and amber that is not on a control', () => {
  expect(files.length).toBeGreaterThan(50);
  expect(files).toContain('packages/ui/src/ticket/TicketActions.svelte');
  expect(files).toContain('apps/local/src/routes/new/+page.svelte');
  expect(files).not.toContain(BUTTON);
  // A running card and the drop target are amber, and neither is a control.
  const pill = readFileSync(join(import.meta.dirname, 'packages/ui/src/StatePill.svelte'), 'utf8');
  expect(pill).toMatch(AMBER);
  expect(amberOnControls(pill)).toEqual([]);
});

it.each([
  ['a class on a button', '<button class="move">Go</button><style>.move { background: var(--amber); }</style>'],
  ['the button type', '<button>Go</button><style>p button { color: var(--amber-bg); }</style>'],
  ['a mark inside a button', '<button data-status="changed"><i class="dot"></i></button><style>[data-status="changed"] .dot { background: var(--amber); }</style>'],
  ['a bare data attribute on a link', '<a href="/" data-go>Go</a><style>[data-go] { border-color: var(--hatch); }</style>'],
  ['a class handed to Button', "<Button class={'wide'}>Go</Button><style>.row :global(.wide) { outline-color: var(--amber-line); }</style>"],
  ['a role of button', '<div role="button" class="tile">Go</div><style>.tile { color: var(--amber); }</style>'],
  ['a role selector', '<div role="button">Go</div><style>[role="button"] { color: var(--amber); }</style>'],
  ['the class of Button itself', '<div class="row"><Button>Go</Button></div><style>.row :global(.btn) { background: var(--amber); }</style>'],
  ['a variant class of Button', '<div class="row"><Button variant="primary">Save</Button></div><style>.row :global(.primary) { background: var(--amber); }</style>'],
  ['a size class of Button', '<div class="row"><Button size="small">Save</Button></div><style>.row :global(.sm) { border-color: var(--amber-line); }</style>'],
  ['a class directive', '<button class:on={pressed}>Go</button><style>.on { color: var(--amber-tint); }</style>'],
  ['a tag with a brace that holds >', '<button onclick={() => a > b} class="q">Go</button><style>.q { color: var(--amber); }</style>'],
  ['a rule inside a media query', '<button>Go</button><style>@media (width < 600px) { button { color: var(--amber); } }</style>'],
  ['a selector list', '<button class="b">Go</button><style>.x, .b::before { color: var(--amber); }</style>'],
  ['a span written inside a button', '<Button variant="primary">Move <span class="starts">Starts: /plan</span></Button><style>.starts { color: var(--amber); }</style>'],
  ['a style attribute', '<button style="background: var(--amber)">Go</button>'],
  ['a style directive', '<summary style:color="var(--amber)">More</summary>'],
])('catches amber put on a control through %s', (_name, source) => {
  expect(amberOnControls(source)).not.toEqual([]);
});

it.each([
  ['a span', '<span class="pill">Running</span><style>.pill { color: var(--amber); }</style>'],
  ['a comment that names amber', '<button>Go</button><style>button { color: var(--ink); /* not var(--amber) */ }</style>'],
  ['a button in a markup comment', '<!-- <button class="ring"> --><span class="ring"></span><style>.ring { color: var(--amber); }</style>'],
  ['a button in a script string', '<script>const html = \'<button class="ring">\';</script><span class="ring"></span><style>.ring { color: var(--amber); }</style>'],
  ['a span after a button whose closing tag breaks its line', '<button>Go</button\n><p class="note">Long</p><button>Stop</button><style>.note { background: var(--amber-bg); }</style>'],
  ['a class only on a span, with a button beside it', '<span class="ring"></span><button class="go">Go</button><style>.ring { border-color: var(--amber); }</style>'],
  ['a span after a self-closing Button', '<Button key="N" /><span class="ring"></span><Button>Go</Button><style>.ring { border-color: var(--amber); }</style>'],
  ['a control with no amber', '<button class="move">Go</button><style>.move { background: var(--accent); }</style>'],
  ['a class named like a variant, in a file with no Button', '<span class="sm">2m</span><button>Go</button><style>.sm { color: var(--amber); }</style>'],
])('lets amber on %s through', (_name, source) => {
  expect(amberOnControls(source)).toEqual([]);
});

it.each(files)('%s puts no amber on a control', (file) => {
  expect(amberOnControls(readFileSync(join(import.meta.dirname, file), 'utf8'))).toEqual([]);
});
