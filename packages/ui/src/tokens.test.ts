import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

// Pulls one top-level block's body out of the file by its exact selector. Good enough for
// this file: no nested braces inside a token block, one block per selector we care about.
function block(selector: string, source: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const bodyStart = source.indexOf('{', start) + 1;
  const bodyEnd = source.indexOf('}', bodyStart);
  return source.slice(bodyStart, bodyEnd);
}

function tokens(body: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    found[match[1]!] = match[2]!.trim();
  }
  return found;
}

// A token written as another name, such as `var(--amber-bg)`, measured as the value it names.
function resolve(theme: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(theme).map(([name, value]) => {
      const named = /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1];
      return [name, named === undefined ? value : (theme[named] ?? value)];
    }),
  );
}

const darkTokens = tokens(block(':root', css));
const lightTokens = tokens(block('[data-theme="light"]', css));

// Same values twice in the file (explicit theme and system preference): keep the parsers
// honest that both blocks actually carry the light palette, not just the labeled one.
const systemLightSection = css.slice(css.indexOf('prefers-color-scheme: light'));
const systemLightTokens = tokens(block(':root:not([data-theme])', systemLightSection));

it('the system-preference block repeats the explicit light block', () => {
  expect(systemLightTokens).toEqual(lightTokens);
});

it('the explicit dark block repeats the root block', () => {
  expect(tokens(block(':root[data-theme="dark"]', css))).toEqual(darkTokens);
});

// A colour the light block leaves out stays dark in light mode, because nothing overrides :root.
// Only :root carries the fonts and the size scales.
it('the light block sets every colour token the dark block sets', () => {
  const colours = Object.keys(darkTokens).filter((name) => !/^(font|text|mono|space|radius)-/.test(name));
  expect(Object.keys(lightTokens).sort()).toEqual(colours.sort());
});

// State words, column labels, meta rows and chips are set in 11px.
it('has an 11px text step', () => {
  expect(darkTokens['text-2xs']).toBe('11px');
});

// Old names that stay for code that still uses them.
it.each([
  ['dark', darkTokens],
  ['light', lightTokens],
])('the %s theme keeps amber-tint and status-ink as other names', (_name, theme) => {
  expect(theme['amber-tint']).toBe('var(--amber-bg)');
  expect(theme['status-ink']).toBe(theme['on-status']);
});

// ink-3 sits between ink-2 and muted, so the 49 places that use it keep their rank.
it.each([
  ['dark', darkTokens],
  ['light', lightTokens],
])('the %s ink-3 sits between ink-2 and muted', (_name, theme) => {
  const [ink2, ink3, muted] = ['ink-2', 'ink-3', 'muted'].map((name) => parseOklch(theme[name]!)[0]);
  expect(ink3).toBeGreaterThan(Math.min(ink2!, muted!));
  expect(ink3).toBeLessThan(Math.max(ink2!, muted!));
});

// Only parts that float carry a shadow, in both themes: a wide soft layer and a close one.
it.each([
  ['dark', darkTokens],
  ['light', lightTokens],
])('the %s theme has the two layer shadow', (_name, theme) => {
  expect(theme['shadow']).toMatch(/^0 12px 32px oklch\([^)]+\), 0 2px 6px oklch\([^)]+\)$/);
});

// Six steps by part, from key caps to dialogs. Only the dark block carries the scales.
it('has the radius scale', () => {
  const names = ['radius-xs', 'radius-sm', 'radius-md', 'radius-lg', 'radius-xl', 'radius-2xl'];
  expect(names.map((name) => darkTokens[name])).toEqual(['4px', '6px', '8px', '10px', '12px', '14px']);
});

// The sizes `docs/design-system.md` names, from key caps to the first run question.
it('has the type scale', () => {
  const scale = Object.fromEntries(Object.entries(darkTokens).filter(([name]) => /^(text|mono)-/.test(name)));
  expect(scale).toEqual({
    'text-2xs': '11px',
    'text-xs': '12px',
    'text-sm': '13px',
    'text-card-title': '13.5px',
    'text-base': '14px',
    'text-md': '15px',
    'text-lg': '18px',
    'text-xl': '26px',
    'text-2xl': '40px',
    'mono-3xs': '10.5px',
    'mono-2xs': '11px',
    'mono-card-key': '11.5px',
    'mono-xs': '12px',
    'mono-sm': '13px',
  });
});

function declarations(rule: string): Record<string, string> {
  return Object.fromEntries([...rule.matchAll(/([a-z-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]!.trim()]));
}

// The system stack after Geist is the one the app had before, so a page draws while a font file
// loads, and still draws if the file never comes.
it.each([
  ['font-sans', '"Geist"', 'system-ui, -apple-system, "Segoe UI", sans-serif'],
  ['font-mono', '"Geist Mono"', 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'],
])('%s starts with %s and keeps the system stack after it', (name, first, system) => {
  expect(darkTokens[name]).toBe(`${first}, ${system}`);
});

const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => declarations(match[1]!));

// One variable file per family covers every weight. The url resolves next to tokens.css, so the file
// must sit under src/, the only folder the published package carries.
it.each([
  ['Geist', 'Geist-Variable.woff2'],
  ['Geist Mono', 'GeistMono-Variable.woff2'],
])('declares %s from a woff2 file in the package', (family, file) => {
  const face = faces.find((declared) => declared['font-family'] === `"${family}"`);
  expect(face).toEqual({
    'font-family': `"${family}"`,
    src: `url("./fonts/${file}") format("woff2")`,
    'font-weight': '100 900',
    'font-style': 'normal',
    'font-display': 'swap',
  });
  const found = new URL(/url\("([^"]+)"\)/.exec(face!.src!)![1]!, new URL('./tokens.css', import.meta.url));
  expect(found.href.startsWith(new URL('./', import.meta.url).href)).toBe(true);
  expect(readFileSync(found).subarray(0, 4).toString('latin1')).toBe('wOF2');
});

// The OFL lets the fonts ship with the app as long as its text and copyright line ship with them.
it('carries the font license next to the fonts', () => {
  const license = readFileSync(new URL('./fonts/OFL.txt', import.meta.url), 'utf8');
  expect(license).toContain('SIL Open Font License, Version 1.1');
  expect(license.split('\n')[0]).toMatch(/^Copyright \(c\) \d{4} \S/);
});

// No font comes from another address: no page asks a font host, so the app needs no network to look right.
it('loads nothing from another host', () => {
  expect(css).not.toMatch(/url\(\s*["']?(https?:)?\/\/|@import/i);
});

// Without this rule the page outside the board is the browser default: white, serif, 8px margin.
// Geist is set with antialiased smoothing. Without it, macOS draws light text on the dark
// theme too heavy.
it('applies the tokens to the document', () => {
  expect(declarations(block('html,\nbody', css))).toEqual({
    margin: '0',
    background: 'var(--bg)',
    color: 'var(--ink)',
    'font-family': 'var(--font-sans)',
    'font-size': 'var(--text-sm)',
    'line-height': '1.45',
    '-webkit-font-smoothing': 'antialiased',
  });
  // The rule points at the token, so pin its size.
  expect(darkTokens['text-sm']).toBe('13px');
});

// OKLCH -> linear sRGB, with the published OKLab matrices.
function oklchToLinearSrgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;

  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;

  const r = 4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  const g = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  const bl = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;

  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [clamp(r), clamp(g), clamp(bl)];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseOklch(value: string): [number, number, number] {
  const match = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(value);
  if (!match) throw new Error(`not a plain oklch() color: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function contrast(tokenValueA: string, tokenValueB: string): number {
  const la = relativeLuminance(oklchToLinearSrgb(...parseOklch(tokenValueA)));
  const lb = relativeLuminance(oklchToLinearSrgb(...parseOklch(tokenValueB)));
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// A translucent colour over a surface, mixed in gamma encoded sRGB, which is how a browser paints it.
// The surface can be an earlier mix, for a tint laid over another tint.
function over(tint: string, surface: string | [number, number, number]): [number, number, number] {
  const alpha = Number(/\/ ([\d.]+)\)$/.exec(tint)![1]);
  const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  const decode = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
  const top = oklchToLinearSrgb(...parseOklch(tint.replace(/ \/ [\d.]+\)$/, ')')));
  const bottom = typeof surface === 'string' ? oklchToLinearSrgb(...parseOklch(surface)) : surface;
  return top.map((value, i) => decode(encode(value) * alpha + encode(bottom[i]!) * (1 - alpha))) as [number, number, number];
}

// Text on a mixed fill, such as a status colour on its own tint.
function onFill(text: string, fill: [number, number, number]): number {
  const a = relativeLuminance(oklchToLinearSrgb(...parseOklch(text)));
  const b = relativeLuminance(fill);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const surfaces = ['bg', 'rail', 'panel', 'card', 'card-2'];
const inks = ['ink', 'ink-2', 'ink-3', 'muted'];
const statusColors = ['amber', 'green', 'red', 'blue', 'violet'];

describe.each([
  ['dark', resolve(darkTokens)],
  ['light', resolve(lightTokens)],
])('%s theme', (_name, theme) => {
  it.each(inks.flatMap((ink) => surfaces.map((surface) => [ink, surface] as const)))(
    '%s reaches 4.5:1 on %s',
    (ink, surface) => {
      expect(contrast(theme[ink]!, theme[surface]!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it.each(statusColors)('status-ink reaches 4.5:1 on %s', (status) => {
    expect(contrast(theme['status-ink']!, theme[status]!)).toBeGreaterThanOrEqual(4.5);
  });

  // A part filled with a status colour, such as the amber go button, writes its words in on-status.
  // Count badges are cream and use accent-ink.
  it.each(statusColors)('on-status reaches 4.5:1 on %s', (status) => {
    expect(contrast(theme['on-status']!, theme[status]!)).toBeGreaterThanOrEqual(4.5);
  });

  // The card and the ticket header write the state word in the state colour.
  it.each(statusColors.flatMap((status) => surfaces.map((surface) => [status, surface] as const)))(
    '%s as text reaches 4.5:1 on %s',
    (status, surface) => {
      expect(contrast(theme[status]!, theme[surface]!)).toBeGreaterThanOrEqual(4.5);
    },
  );

  // A pill, a banner or a glyph box writes its state colour on its own tint, and the box can sit on
  // any surface. The tints are translucent, so each is measured mixed over the surface.
  it.each(statusColors.flatMap((status) => surfaces.map((surface) => [status, surface] as const)))(
    '%s reaches 4.5:1 on its own tint over %s',
    (status, surface) => {
      expect(onFill(theme[status]!, over(theme[`${status}-bg`]!, theme[surface]!))).toBeGreaterThanOrEqual(4.5);
    },
  );

  // The question box, the failure reason and a banner write body text on a tint. Muted on a tint over
  // card-2 falls to 4.4:1 in dark, so text on a tint there is ink, as `docs/design-system.md` says.
  it.each(
    ['ink', 'muted'].flatMap((ink) =>
      statusColors.flatMap((status) =>
        surfaces.filter((surface) => ink === 'ink' || surface !== 'card-2').map((surface) => [ink, status, surface] as const),
      ),
    ),
  )('%s reaches 4.5:1 on the %s tint over %s', (ink, status, surface) => {
    expect(onFill(theme[ink]!, over(theme[`${status}-bg`]!, theme[surface]!))).toBeGreaterThanOrEqual(4.5);
  });

  // The drop box sits in the column, on the panel, and writes its label in amber and its lines in ink.
  it.each(['amber', 'ink', 'ink-2', 'ink-3'])('%s reaches 4.5:1 on the amber tint over the panel', (ink) => {
    const fill = relativeLuminance(over(theme['amber-tint']!, theme['panel']!));
    const text = relativeLuminance(oklchToLinearSrgb(...parseOklch(theme[ink]!)));
    expect((Math.max(fill, text) + 0.05) / (Math.min(fill, text) + 0.05)).toBeGreaterThanOrEqual(4.5);
  });

  // An agent column is a hatch on the page, and the drop box on top of the hatch.
  it.each(['amber', 'ink', 'ink-2', 'ink-3', 'muted'])('%s reaches 4.5:1 on the drop box over the hatch', (ink) => {
    expect(onFill(theme[ink]!, over(theme['amber-bg']!, over(theme['hatch']!, theme['bg']!)))).toBeGreaterThanOrEqual(4.5);
  });

  // The column has no panel under it any more. An agent column's header writes its name in ink, a
  // folded strip in ink-2, and the count and the Starts line in muted, straight on the hatch. A drop
  // box that starts nothing or refuses has no fill, so its words and its red head sit there too.
  it.each(['ink', 'ink-2', 'ink-3', 'muted', 'red'])('%s reaches 4.5:1 on the hatch over the page', (ink) => {
    expect(onFill(theme[ink]!, over(theme['hatch']!, theme['bg']!))).toBeGreaterThanOrEqual(4.5);
  });

  // The glyph is the mark. The box line is under 3:1 and only frames it, so the glyph itself needs the
  // 3:1 of a non-text part on the box over the hatch.
  it('the amber role glyph reaches 3:1 on its box over the hatch', () => {
    expect(onFill(theme['amber']!, over(theme['amber-bg']!, over(theme['hatch']!, theme['bg']!)))).toBeGreaterThanOrEqual(3);
  });

  // The ring on a drop target whose drop starts a run. On a folded strip it is the only mark, so it
  // needs the 3:1 of a non-text part, on the hatch and on the page between its stripes.
  // --amber-line falls under that in both themes, so the ring is full amber.
  it('amber reaches 3:1 as the ring of a drop target, on the hatch and on the page', () => {
    expect(onFill(theme['amber']!, over(theme['hatch']!, theme['bg']!))).toBeGreaterThanOrEqual(3);
    expect(contrast(theme['amber']!, theme['bg']!)).toBeGreaterThanOrEqual(3);
  });

  // The dashed line that marks a folded strip a dragged card may land on when the drop starts nothing.
  // On an agent strip it sits on the hatch.
  it('faint reaches 3:1 on the hatch over the page', () => {
    expect(onFill(theme['faint']!, over(theme['hatch']!, theme['bg']!))).toBeGreaterThanOrEqual(3);
  });

  it('accent-ink reaches 4.5:1 on accent', () => {
    expect(contrast(theme['accent-ink']!, theme['accent']!)).toBeGreaterThanOrEqual(4.5);
  });

  // The switch knob is what shows on or off, so it needs the 3:1 of a non-text part on its track.
  // A card-coloured off knob on line-2 is 1.4:1, so the knob is ink.
  it.each([
    ['ink', 'line-2'],
    ['accent-ink', 'accent'],
  ])('the switch knob in %s reaches 3:1 on its %s track', (knob, track) => {
    expect(contrast(theme[knob]!, theme[track]!)).toBeGreaterThanOrEqual(3);
  });

  // Faint is for lines and marks only, never text, so it needs the 3:1 of a non-text part.
  it.each(surfaces)('faint reaches 3:1 on %s', (surface) => {
    expect(contrast(theme['faint']!, theme[surface]!)).toBeGreaterThanOrEqual(3);
  });
});
