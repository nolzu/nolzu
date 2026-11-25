import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// The rail sits on the left and the page takes the rest of the width (`docs/design-system.md`). No app
// page sits in a centred box. The first run has no rail: its page is a box of at most 1180px with a side
// column of 400px, centred by the column around it. Text is capped on the text block itself, through one
// of the named caps below. These read the source, because a server render carries no CSS.
const routes = new URL('.', import.meta.url).pathname;
const lib = new URL('../lib/', import.meta.url).pathname;
const ui = new URL('../../../../packages/ui/src/', import.meta.url).pathname;

// The allowed text caps. A lede is the large line under a title, prose is a short note such as a help
// paragraph, and long text (rendered markdown, a summary, a file on the Files tab) fills its box up to
// 120ch, a cap that only a very wide screen reaches. The first run caps its page box
// and its side column. A share caps a part to a share of its
// own box, which is no text measure: an image, or the card page's actions beside the title. A control is
// a box drawn at a fixed width that may narrow, such as the board's filter box.
const CAPS = {
  lede: ['68ch'],
  prose: ['72ch'],
  long: ['min(100%, 120ch)'],
  firstRun: ['1180px', '400px'],
  share: ['100%', '50%', 'none'],
  control: ['200px'],
  // A table cell that gives up its width first, as the remote of Settings, Project does.
  shrink: ['0'],
  // A saved preset on Settings, Models, which leaves room for the menu button beside it.
  beside: ['calc(100% - 34px)'],
  // The held name column of a grid that scrolls, so a long name wraps and leaves the boxes in view.
  column: ['16ch'],
} as const;

type Cap = keyof typeof CAPS;

const style = (source: string) => /<style>([\s\S]*)<\/style>/.exec(source)?.[1] ?? '';

// Every rule of the file's own style, with comments taken out: its selector and its declarations.
// A rule inside a media query is read on its own, without the query around it.
function rules(source: string): { selector: string; body: string }[] {
  const css = style(source).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' }));
}

// The only rules that may cap a width, each with the cap it takes. A cap anywhere else is a page or a
// tab shrinking beside the rail, so a new one fails here until it is named.
const capped: Record<string, Record<string, Cap>> = {
  'evidence/+page.svelte': { '.intro': 'prose' },
  'team/+page.svelte': { p: 'prose' },
  'settings/phases/+page.svelte': { '.quiet': 'prose' },
  'settings/mcp/+page.svelte': { '.quiet': 'prose', "th[scope='row']": 'column' },
  'new/+page.svelte': { '.page': 'firstRun', aside: 'firstRun', '.lede': 'lede', '.base select': 'control' },
  'new/idea/+page.svelte': { '.page': 'firstRun', aside: 'firstRun', '.lede': 'lede' },
  'new/task/+page.svelte': { '.page': 'firstRun' },
  'accept/+page.svelte': { '.page': 'firstRun', '.lede': 'lede', '.changed': 'lede', ol: 'lede' },
  't/[key]/+layout.svelte': { '.cluster': 'share' },
  'ticket/ReviewTab.svelte': { '.sj': 'prose', '.body': 'prose' },
  'ticket/FilesTab.svelte': { img: 'share', '.body > pre': 'long' },
  'ticket/Overview.svelte': { '.text': 'long', '.excerpt': 'long' },
  'Markdown.svelte': { '.markdown': 'long', '.markdown :global(pre)': 'share', '.markdown :global(table)': 'share' },
  'lib/BoardOff.svelte': { p: 'prose' },
  'lib/ProjectsList.svelte': { '.quiet': 'prose', '.remote': 'shrink', '.folder': 'control', '.panel .folder': 'share', '.panel .remote': 'share' },
  'lib/HandEditedFiles.svelte': { '.quiet': 'prose' },
  'lib/WorkspacePage.svelte': { '.head p': 'prose' },
  'lib/NowItem.svelte': { '.summary': 'long' },
  'lib/BoardPage.svelte': { '.filter': 'control' },
  'lib/CloudStatus.svelte': { '.quiet': 'prose', '.fix': 'prose' },
  'lib/ModelsSection.svelte': { '.nm': 'share', '.sc': 'share', '.sc .cf': 'beside' },
};

// `margin: auto`, `margin: 0 auto`, `margin: 0 auto 0 auto`, `margin-inline: auto`, or a left and a
// right auto.
const centred = (body: string) =>
  /margin-inline:\s*auto|margin:\s*[^;]*?\bauto\b[^;]*?\bauto\b|margin:\s*(\S+\s+)?auto\s*(;|$)/.test(body) ||
  (/margin-left:\s*auto/.test(body) && /margin-right:\s*auto/.test(body));

function check(file: string, source: string) {
  for (const { selector, body } of rules(source)) {
    expect(centred(body), `${file} ${selector} centres itself`).toBe(false);
    const cap = /max-width:\s*([^;]+?)\s*(;|$)/.exec(body)?.[1];
    if (cap === undefined) continue;
    const kind = capped[file]?.[selector];
    expect(kind, `${file} ${selector} caps its width`).toBeDefined();
    expect(CAPS[kind!] as readonly string[], `${file} ${selector} caps at ${cap}, which is no ${kind} cap`).toContain(cap);
  }
}

const routeFiles = readdirSync(routes, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('.svelte'));
const libFiles = readdirSync(lib).filter((file) => file.endsWith('.svelte'));
const parts = ['ticket/Overview.svelte', 'ticket/Block.svelte', 'ticket/QaPanels.svelte', 'ticket/GateBlock.svelte', 'ticket/ClosedCard.svelte', 'ticket/PrLinks.svelte', ...readdirSync(join(ui, 'ticket')).filter((file) => file.endsWith('Tab.svelte')).map((file) => `ticket/${file}`), 'KnowledgeBrowser.svelte', 'Markdown.svelte'];

it('finds the routes, the root layout, the tabs and the app parts', () => {
  expect(routeFiles.length).toBeGreaterThan(10);
  expect(routeFiles).toContain('+layout.svelte');
  expect(libFiles).toContain('Rail.svelte');
  expect(parts).toContain('ticket/ChangesTab.svelte');
  expect(parts).toContain('ticket/FilesTab.svelte');
  expect(parts).toContain('ticket/PrsTab.svelte');
  // The blocks of the Overview's left column fill it too, down to a 390px phone.
  expect(parts).toContain('ticket/Block.svelte');
});

it.each(routeFiles)('%s sets no page-level maximum width', (file) => check(file, readFileSync(join(routes, file), 'utf8')));

it.each(parts)('%s fills the width', (file) => check(file, readFileSync(join(ui, file), 'utf8')));

it.each(libFiles)('lib/%s fills the width', (file) => check(`lib/${file}`, readFileSync(join(lib, file), 'utf8')));

it('reads every rule, so the checks above are not empty', () => {
  const files = readFileSync(join(ui, 'ticket/FilesTab.svelte'), 'utf8');
  expect(rules(files).map((one) => one.selector)).toEqual(expect.arrayContaining(['.body', 'img', '.quiet']));
  expect(() => check('ticket/FilesTab.svelte', files.replace(/(\n {2}\.body \{)/, '$1\n    max-width: 72ch;'))).toThrow(/caps its width/);
  for (const margin of ['margin: 0 auto;', 'margin: 0 auto 0 auto;', 'margin-left: auto; margin-right: auto;', 'margin-inline: auto;', 'margin: auto;']) {
    expect(() => check('x', `<style>\n  .page { ${margin} }\n</style>`)).toThrow(/centres itself/);
  }
  expect(() => check('x', '<style>\n  .stat { margin-left: auto; }\n  .row { margin: 0 0 auto; }\n</style>')).not.toThrow();
});

// A named rule holds a named cap: an old 78ch measure, or a page box in rem, fails.
it('refuses a cap that is not one of the named ones', () => {
  expect(() => check('team/+page.svelte', '<style>\n  p { max-width: 78ch; }\n</style>')).toThrow(/no prose cap/);
  expect(() => check('new/+page.svelte', '<style>\n  .page { max-width: 40rem; }\n</style>')).toThrow(/no firstRun cap/);
  expect(() => check('team/+page.svelte', '<style>\n  p { max-width: 72ch; }\n</style>')).not.toThrow();
  expect(() => check('ticket/FilesTab.svelte', '<style>\n  img { max-width: 72ch; }\n</style>')).toThrow(/no share cap/);
  expect(() => check('lib/TimesheetExport.svelte', '<style>\n  .grid { max-width: 640px; }\n</style>')).toThrow(/caps its width/);
});

it('takes the caps from docs/design-system.md', () => {
  const doc = readFileSync(new URL('../../../../docs/design-system.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  expect(doc).toContain(`a lede at most ${Number.parseInt(CAPS.lede[0])} characters, a short note at most ${Number.parseInt(CAPS.prose[0])}, and long text fills its box up to ${/(\d+)ch/.exec(CAPS.long[0])?.[1]}`);
});

it('lets long text fill its box and keeps a short note to a readable measure', () => {
  expect(rules(readFileSync(join(ui, 'Markdown.svelte'), 'utf8')).find((one) => one.selector === '.markdown')?.body).toMatch(/max-width: min\(100%, 120ch\)/);
  expect(rules(readFileSync(join(lib, 'NowItem.svelte'), 'utf8')).find((one) => one.selector === '.summary')?.body).toMatch(/max-width: min\(100%, 120ch\)/);
  expect(rules(readFileSync(join(routes, 'evidence/+page.svelte'), 'utf8')).find((one) => one.selector === '.intro')?.body).toMatch(/max-width: 72ch/);
});
