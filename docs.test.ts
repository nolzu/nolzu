import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ALL_SECTIONS, MOVED } from './apps/local/src/lib/settings-sections.ts';
import { boardFor, stageSays } from './packages/core/src/board.ts';
import { estimateOf } from './packages/core/src/estimate.ts';
import { isAction, presetRange, presetRows } from './packages/core/src/models.ts';
import * as onboarding from './packages/core/src/onboarding.ts';
import { BOARD_KINDS, BOARD_LABELS, choiceLabel, choicesOf, isResearchKind } from './packages/protocol/src/board.ts';
import { ENGINE_LABELS } from './packages/protocol/src/engine.ts';
import { estimateBrief } from './packages/protocol/src/estimate.ts';
import { SCOUT_AND_EVIDENCE } from './packages/protocol/src/soon.ts';

const read = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');

// The targets of the relative markdown links in a text, without their #part.
const links = (text: string) =>
  [...text.matchAll(/\]\(([^)#\s]+)[^)]*\)/g)].map((match) => match[1]!).filter((to) => !/^[a-z]+:/i.test(to));

it.each(['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md'])('every relative link in %s opens a file', (name) => {
  for (const to of links(read(name))) expect(existsSync(join(import.meta.dirname, to)), `${name} links ${to}`).toBe(true);
});

it('links the security and contributing pages to each other, and the README to all three', () => {
  expect(links(read('README.md'))).toEqual(expect.arrayContaining(['SECURITY.md', 'CONTRIBUTING.md', 'CHANGELOG.md']));
  expect(links(read('SECURITY.md'))).toEqual(expect.arrayContaining(['CONTRIBUTING.md', 'README.md']));
  expect(links(read('CONTRIBUTING.md'))).toEqual(expect.arrayContaining(['SECURITY.md', 'README.md']));
});

// What a reporter is promised. A page that drops one of these, or names a longer wait, breaks a promise.
it('keeps the promises SECURITY.md makes to a reporter', () => {
  const text = read('SECURITY.md').replace(/\s+/g, ' ');
  for (const promise of [
    'A person reads every report and answers you.',
    'You get a first answer within 7 days.',
    'Please keep the problem private until a fix is out.',
    'There is no bug bounty',
  ]) {
    expect(text).toContain(promise);
  }
});

// CONTRIBUTING says CI runs these checks in this order, so a changed workflow has to change the page too.
it('lists the CI checks in the order the workflow runs them', () => {
  const checks = read('.github/workflows/ci.yml');
  const steps = [...checks.matchAll(/^\s+- run: (.*pnpm (?!install).*)$/gm)].map((match) =>
    match[1]!.replace('pnpm', 'corepack pnpm'),
  );
  const listed = /CI runs these[\s\S]*?```bash\n([\s\S]*?)```/.exec(read('CONTRIBUTING.md'))?.[1]?.trim().split('\n');
  expect(steps).toHaveLength(7);
  expect(listed).toEqual(steps);
});

// Until the contributor agreement is ready, the sign-off is the only promise an outside author makes,
// and nothing but the template tick and review asks for it.
it('asks every outside pull request for a signed-off commit and an accepted issue', () => {
  const template = read('.github/pull_request_template.md');
  expect(template).toMatch(/^Closes #/);
  for (const part of ['## What changed', '## How it was tested', '## AI tools']) expect(template).toContain(part);
  expect(template).toContain('- [ ] I can explain every line of this change.');
  expect(template).toContain('- [ ] Every commit is signed off (`git commit -s`).');
  const contributing = read('CONTRIBUTING.md').replace(/\s+/g, ' ');
  for (const said of ['labelled `accepted`', 'Docs and typo fixes are welcome from anyone', '`git commit -s`', '`git commit --amend -s`', '`git rebase --signoff main`', 'https://developercertificate.org', 'You keep the copyright']) {
    expect(contributing, said).toContain(said);
  }
});

// Every public page, the ones under docs/ included.
const PUBLIC = [
  'README.md',
  'AGENTS.md',
  'CHANGELOG.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'ARCHITECTURE.md',
  '.github/pull_request_template.md',
  ...readdirSync(join(import.meta.dirname, 'docs'), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.md'))
    .map((name) => join('docs', name)),
];

// A reader outside the project knows no internal id, so none may stand in for what shipped. The
// phrases are claims the code does not back. A lone capital with a number is a product ref (T1), so
// only the L and O shapes are refused.
it.each(PUBLIC)('%s names no build phase or task id, and none of the false claims', (name) => {
  const text = read(name);
  expect(text.match(/\bphases? [0-9]+\b/gi) ?? []).toEqual([]);
  expect(text.match(/\b[A-Z]{2,6}[0-9]{1,2}[a-z]?\b/g) ?? []).toEqual([]);
  expect(text.match(/\b[LO][0-9]{1,2}\b/g) ?? []).toEqual([]);
  expect(text.match(/\b[A-Z]{2,6}-[A-Z][0-9]+\b/g) ?? []).toEqual([]);
  for (const stale of ['GitLab through', 'Ticket adapters:']) expect(text).not.toContain(stale);
  // Figures no screen computes, and a package that a login never takes away.
  const flat = text.replace(/\s+/g, ' ');
  for (const stale of ['cost and tokens of each run', 'until the next login', 'each with its own ticket']) {
    expect(flat.includes(stale), stale).toBe(false);
  }
});

// The layout once listed docs pages and folders that were never written, so every entry has to exist.
it('lists in the ARCHITECTURE.md layout only files and folders that exist', () => {
  const tree = /## Repository layout\s+```\n([\s\S]*?)```/.exec(read('ARCHITECTURE.md'))?.[1] ?? '';
  const path: string[] = [];
  const entries = [...tree.matchAll(/^([│ ]*)[├└]── (\S+)/gm)].map(([, indent, name]) => {
    path.length = indent!.length / 4;
    path.push(name!);
    return join(...path);
  });
  expect(entries.length).toBeGreaterThan(20);
  for (const entry of entries) expect(existsSync(join(import.meta.dirname, entry)), entry).toBe(true);
});

// The pages under docs/ are read from the folder, so a read that found fewer would still pass.
it('reads the pages under docs/ for the checks above, the engine pages included', () => {
  expect(PUBLIC).toEqual(expect.arrayContaining([join('docs', 'design-system.md'), join('docs', 'engines', 'codex.md')]));
});

// Things the pages describe that are not built. A sentence that names one has to say so. The app has
// no agents drawer and no project switcher (Now and the project selector stand in their place), so a
// sentence that names either has to say there is none. The install line has its own check below, per paragraph.
const NOT_YET: readonly [string, RegExp][] = [
  ['agents drawer', /no agents drawer/i],
  ['project switcher', /no project switcher/i],
];

it('says "not published", or that there is none, in every sentence that names one of those things', () => {
  for (const name of PUBLIC) {
    for (const sentence of read(name).replace(/\s+/g, ' ').split(/(?<=\.) /)) {
      for (const [thing, said] of NOT_YET) if (sentence.toLowerCase().includes(thing)) expect(sentence, `${name}: ${thing}`).toMatch(said);
    }
  }
});

// The website's routes are written here by hand, less its 404 page. A page linked here that the site
// renames or drops has to leave this list too. Tickets and Projects stay because they still answer
// with a 301: Tickets to Boards, Projects to the part of Concepts that took its guide.
const SITE_ROUTES = [
  '/',
  '/pricing',
  '/changelog',
  '/security',
  '/privacy',
  '/terms',
  '/dpa',
  '/docs',
  '/docs/quickstart',
  '/docs/idea',
  '/docs/concepts',
  '/docs/boards',
  '/docs/knowledge',
  '/docs/engines',
  '/docs/tickets',
  '/docs/scout',
  '/docs/evidence',
  '/docs/projects',
  '/docs/extensions',
  '/docs/faq',
  '/docs/mcp',
  '/docs/skills',
  '/docs/wall',
  '/docs/cli',
  '/docs/compatibility',
  '/docs/prerequisites',
  '/docs/security',
];

// The links to the website, as the path of each, without its #part. Any form counts: an inline or
// reference link, an autolink, a bare address in prose, with or without www.
const siteLinks = (text: string) => [...text.matchAll(/https:\/\/(?:www\.)?nolzu\.com\b(\/[^\s)#>\]`'"]*)?/g)].map((match) => match[1] ?? '/');

it.each(PUBLIC)('links %s only to pages the website has', (name) => {
  for (const route of siteLinks(read(name))) expect(SITE_ROUTES, `${name} links ${route}`).toContain(route);
});

// The README sends a reader to the pricing page and the guides, so a pass that dropped them would pass the check above.
it('links the README to the pricing page and the guides', () => {
  const readme = siteLinks(read('README.md'));
  expect(readme).toEqual(
    expect.arrayContaining(['/pricing', '/docs/quickstart', '/docs/concepts', '/docs/boards', '/docs/knowledge', '/docs/mcp', '/docs/skills', '/docs/wall', '/docs/cli', '/docs/compatibility', '/docs/prerequisites', '/docs/security']),
  );
  // Scout, Evidence and Extensions only redirect while the features wait, and the old names answer
  // with a redirect too, so the README links the pages they lead to.
  for (const gone of ['/docs/scout', '/docs/evidence', '/docs/extensions']) expect(readme).not.toContain(gone);
  expect(readme).not.toContain('/docs/tickets');
  expect(readme).not.toContain('/docs/projects');
});

// The README may name only what the code ships. A board, a column or a Scout source the code lacks
// breaks no link, so the names are read against the code here. The README names four boards, and
// this check opens Research into its two kinds.
it('names in the README only the boards and columns the code has, and no hidden feature', () => {
  const readme = read('README.md');
  const boardsSection = /## The four boards\n([\s\S]*?)\n## /.exec(readme)?.[1]?.replace(/\s+/g, ' ') ?? '';
  const names = (list: string) => list.split(/, and |, | and | through | to /);
  const choices = choicesOf(BOARD_KINDS);
  const [, count, boards, research] = /(\w+) boards: ([^.]+)\. Research is one board over two kinds of card, (\w+ and \w+)\./.exec(boardsSection) ?? [];
  expect(names(boards ?? '')).toEqual(choices.map(choiceLabel));
  expect(names(research ?? '')).toEqual(BOARD_KINDS.filter(isResearchKind).map((kind) => BOARD_LABELS[kind]));
  expect(count).toBe(WORDS[choices.length]);
  // Every count of boards on the page, "all four boards" under Plans among them, is that number.
  for (const [, word] of readme.replace(/\s+/g, ' ').matchAll(/\b(\w+) boards\b/gi)) {
    if (WORDS.includes(word!.toLowerCase())) expect(word!.toLowerCase(), `${word} boards`).toBe(WORDS[choices.length]);
  }
  for (const kind of ['delivery', 'epics', 'prreview'] as const) {
    const columns = new RegExp(`- ${BOARD_LABELS[kind]} takes [^.]*? from (.+?)\\.`).exec(boardsSection)?.[1] ?? '';
    expect(names(columns), kind).toEqual(boardFor(kind, 'pull-request').stages.map((stage) => stage.label));
  }
  // Both kinds of Research card go through the same columns.
  const researchColumns = /- Research takes [^.]*? from (.+?)\./.exec(boardsSection)?.[1] ?? '';
  for (const kind of ['questions', 'investigations'] as const) expect(names(researchColumns), kind).toEqual(boardFor(kind, 'pull-request').stages.map((stage) => stage.label));

  // Scout and Evidence wait for a later version, so What it does names neither while they are hidden.
  const section = /## What it does\n([\s\S]*?)\n## /.exec(readme)?.[1]?.replace(/\s+/g, ' ') ?? '';
  expect(section.length).toBeGreaterThan(500);
  for (const hidden of ['Scout', 'Evidence', 'timesheet', 'Timesheet']) expect(section.includes(hidden), hidden).toBe(SCOUT_AND_EVIDENCE);
});

// The README's picture is a drawing of the Delivery board, not a screenshot, so its column names and
// words are held to the code that draws the real board.
it('draws in docs/board.svg the Delivery columns and the words the client shows', () => {
  const svg = read('docs/board.svg');
  const texts = (kind: string) => [...svg.matchAll(new RegExp(`class="${kind}"[^>]*>([^<]+)<`, 'g'))].map((match) => match[1]);
  expect(texts('col')).toEqual(boardFor('delivery', 'pull-request').stages.map((stage) => stage.label));
  expect(texts('says')).toEqual([stageSays('delivery', 'inbox')]);
  const column = read('packages/ui/src/board/BoardColumn.svelte');
  expect(column).toContain('Drop to start {stage.label}');
  expect(texts('drop-head')).toEqual(['Drop to start Implement']);
  expect(column).toContain(`<p class="esc">${texts('esc').join(' ')}</p>`);
  // The line under an open agent column is what a project on the default preset shows: model and
  // effort, and a figure only where the preset measured one, as for Refine. A folded strip has none.
  const rows = presetRows('default', 'claude-code');
  const drawn = new Map([...svg.matchAll(/<g data-column="([^"]+)">([\s\S]*?)<\/g>/g)].map((match) => [match[1], match[2] ?? '']));
  for (const stage of boardFor('delivery', 'pull-request').stages) {
    if (stage.phase === undefined || !isAction(stage.phase)) continue;
    const { model, effort } = rows[stage.phase];
    const estimate = estimateOf([], presetRange('claude-code', stage.phase, model, effort));
    const group = drawn.get(stage.label) ?? '';
    const line = /class="says mono"[^>]*>([^<]+)</.exec(group)?.[1];
    if (/class="slim/.test(group)) expect(group, stage.label).not.toContain('Starts');
    else expect(line, stage.label).toBe([model, effort, ...(estimate === null ? [] : [estimateBrief(estimate)])].join(' · '));
  }
  const command = [...svg.matchAll(/class="command mono"[^>]*>([^<]+)</g)].map((match) => match[1]).join(' ');
  expect(command).toBe(`${ENGINE_LABELS['claude-code']} · ${rows.implement.model} · ${rows.implement.effort}`);
  expect(read('README.md')).toContain('](docs/board.svg)');
});

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

// The client's first screen is New project at /new, and core keeps no wizard steps.
it('draws New project in place of a wizard', () => {
  expect(Object.keys(onboarding)).not.toContain('STEPS');
  const page = read('apps/local/src/routes/new/+page.svelte');
  expect(page).toContain("'Make your first project'");
  expect(page).toContain('>Make the project</Button>');
  expect(read('apps/local/src/routes/onboard/+page.server.ts')).toContain("redirect(307, '/new')");
});

// Now took the place of the board at `/`.
it('draws Now at / and the rail beside it', () => {
  const root = read('apps/local/src/routes/+page.svelte');
  expect(root).toContain('<NowPage');
  expect(root).not.toContain('BoardPage');
  expect(read('apps/local/src/lib/Rail.svelte')).toContain('aria-label="Main"');
});

// `npx nolzu@latest` is the command that starts Nolzu. No page may send a reader to a clone as the
// way to run it, or say the package is not out.
it('starts Nolzu with npx on the install pages, and says nowhere that the package is not out', () => {
  for (const name of ['README.md', join('apps', 'local', 'README.md')]) expect(read(name), name).toContain('npx nolzu@latest');
  for (const name of [...PUBLIC, join('apps', 'local', 'README.md')]) {
    const text = read(name).replace(/\s+/g, ' ');
    for (const said of [/not published/i, /once the package is published/i, /today (?:you run|the client runs)/i, /runs from a clone/i]) expect(text, name).not.toMatch(said);
  }
});

// A feature's settings block may not take the id of one of the app's sections (Cloud too, while the
// cloud is closed), nor of an old one whose link goes to its new home, and a package author reads which ids those are in docs/extensions.md.
it('lists in docs/extensions.md every settings section id a feature block cannot take', () => {
  const text = read('docs/extensions.md');
  const ids = (said: RegExp) => [...(said.exec(text)?.[1] ?? '').matchAll(/`(\w+)`/g)].map(([, id]) => id);

  expect(ids(/The id cannot be one of the app's own sections: ([\s\S]*?), because/)).toEqual(ALL_SECTIONS.map((section) => section.id));
  expect(ids(/Nor can it be one of the sections they replaced:\s([\s\S]*?), because/)).toEqual([...MOVED.keys()]);
});

// docs/design-system.md holds the calibrated token values. A calibration that changes tokens.css
// changes the tables in the same commit. The shadow row is said in words and is left out.
it('lists in docs/design-system.md the colour and radius values of tokens.css', () => {
  const css = read('packages/ui/src/tokens.css');
  const block = (selector: string) => {
    const start = css.indexOf('{', css.indexOf(`${selector} {`)) + 1;
    const body = css.slice(start, css.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1]!, match[2]!.trim()]));
  };
  const dark = block(':root');
  const light = block('[data-theme="light"]');
  const design = read('docs/design-system.md');
  const value = (cell: string) => (cell.startsWith('var(') ? cell : `oklch(${cell})`);
  const listed: string[] = [];
  for (const [, names, inDark, inLight] of design.matchAll(/^\| ((?:`--[a-z0-9-]+`(?:, )?)+) \| `([^`]+)` \| `([^`]+)` \|$/gm)) {
    for (const [, name] of names!.matchAll(/`--([a-z0-9-]+)`/g)) {
      listed.push(name!);
      expect([name, dark[name!], light[name!]]).toEqual([name, value(inDark!), value(inLight!)]);
    }
  }
  expect([...listed, 'shadow'].sort()).toEqual(Object.keys(light).sort());

  const radii = Object.fromEntries([...design.matchAll(/^\| `--(radius-[a-z0-9]+)` \| (\d+px) \|/gm)].map(([, name, px]) => [name!, px!]));
  expect(radii).toEqual(Object.fromEntries(Object.entries(dark).filter(([name]) => name.startsWith('radius-'))));
});
