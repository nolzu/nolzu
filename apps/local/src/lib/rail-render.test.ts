import { readFileSync } from 'node:fs';
import { scoped } from '@nolzu/ui';
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
// The stub vitest aliases `$app/paths` to. By path and not by that name, because the app's types for
// `$app/paths` are SvelteKit's own and carry no `drawnAt`.
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt, resolve } from '../../../../test/stubs/app-paths.ts';
import { type ProjectChoice, selectorRows } from './rail.ts';
import Rail from './Rail.svelte';

// Scout and Evidence are off as shipped. These tests pin how they work once the switch is on again, and
// coming-soon.test.ts pins the off state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), SCOUT_AND_EVIDENCE: true }));

const recipes = { name: 'recipes', path: '~/nolzu/recipes', repos: ['api', 'web'], listed: true };

type Props = Parameters<typeof Rail>[1];
const draw = (over: Partial<Props> = {}, at = '/knowledge') => {
  drawnAt(at);
  return render(Rail, { props: { routeId: '/knowledge', project: recipes, ontheme: () => {}, ...over } }).body;
};

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// The project menu, which a server render draws hidden.
const menu = (body: string) => /<div id="project-menu"[\s\S]*?(?=<div class="scroll)/.exec(body)?.[0] ?? '';
const links = (body: string) => [...body.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((match) => match[1]);

describe('the project selector', () => {
  it('names the project and counts its repositories', () => {
    const body = draw();
    const button = /<button[^>]*class="proj[^"]*"[^>]*>/.exec(body)?.[0] ?? '';

    expect(button).toContain('aria-label="Project recipes, 2 repositories, project menu"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toContain('aria-controls="project-menu"');
    expect(text(body)).toContain('recipes 2 repositories');
  });

  // Every plan makes as many projects as the person wants, so New project is a link.
  it('shows the project, its repositories, its settings and New project as a link', () => {
    const shown = menu(draw());

    expect(shown).toContain('hidden=""');
    expect(text(shown)).toBe('Project R recipes ~/nolzu/recipes , the project open Repositories 2 Add a repository Project settings New project');
    expect(shown).toMatch(/<span class="mono[^"]*">~\/nolzu\/recipes<\/span>/);
    expect(links(shown)).toEqual(['./settings/project#git-title', './settings/project#add-url', './settings/project', './new']);
    expect(text(shown)).not.toContain('Free keeps');
    expect(text(shown)).not.toContain('Coming soon');
  });

  // A project of one repository has no Add form in Settings, Project until it is a workspace, and that section
  // says so.
  it('sends Add a repository to the workspace form for a project of one repository', () => {
    const shown = menu(draw({ project: { name: 'recipes', path: '/srv/recipes', repos: ['recipes'], listed: false } }));

    expect(links(shown)).toEqual(['./settings/project#git-title', './settings/project#git-title', './settings/project', './new']);
    expect(text(draw({ project: { name: 'recipes', path: null, repos: ['recipes'], listed: false } }))).toContain('recipes 1 repository');
  });

  // A wizard finished with no project leaves no selector, so the rail links Projects, where one is set:
  // Settings, Project.
  it('draws no selector with no project set, and links Projects in its place', () => {
    const body = draw({ project: null });

    expect(body).not.toContain('class="proj');
    expect(body).not.toContain('project-menu');
    expect(links(body)).toContain('./settings/project');
    expect(text(body)).toContain('Project Projects Knowledge Scout Evidence');
    expect(draw({ project: null, routeId: '/settings/project' }, '/settings/project')).toMatch(/<a href="\.\.\/settings\/project" aria-current="page"/);
    expect(draw({ project: null, compact: true, routeId: '/' }, '/')).toMatch(/<a href="\.\/settings\/project"[^>]*aria-label="Projects"/);
  });
});

// Every plan lists every project, the busiest first, each with the cards waiting on the person off
// its own board.
describe('the projects in the selector', () => {
  const choice = (id: number, name: string, waiting: number | null, running: number | null, current = false): ProjectChoice => ({ id, name, repos: id + 1, waiting, running, current });
  const several = selectorRows([choice(1, 'recipes', 1, 2, true), choice(2, 'bakery-site', 3, 0), choice(3, 'meal-planner', 0, 1), choice(4, 'invoice-api', 0, 0)]);
  const form = (body: string) => /<form[^>]*>[\s\S]*?<\/form>/.exec(body)?.[0] ?? '';

  it('lists every project, the busiest first, with each count of cards waiting on the person', () => {
    const shown = menu(draw({ projects: several }));

    expect(text(shown)).toBe(
      'Projects G P B bakery-site 3 repositories 3 waiting on you R recipes 2 repositories · 2 running 1 waiting on you , the project open M meal-planner 4 repositories · 1 running I invoice-api 5 repositories Repositories of recipes 2 Add a repository New project Settings of recipes',
    );
    // The count is the cream of the Now count and never amber.
    expect([...shown.matchAll(/<span class="n[^"]*" data-needs-you="">(\d+)<\/span>/g)].map((match) => match[1])).toEqual(['3', '1']);
    expect(read('./Rail.svelte')).not.toMatch(/\.n\b[^{]*\{[^}]*amber/);
  });

  // Free lists its one project like any plan, so the menu reads the same with one project or ten.
  it('lists a machine of one project under Projects, with New project', () => {
    const shown = menu(draw({ projects: [choice(1, 'recipes', 0, 0, true)] }));

    expect(text(shown)).toBe('Projects G P R recipes 2 repositories , the project open Repositories of recipes 2 Add a repository New project Settings of recipes');
    // The open project's repositories stay one click away with one project.
    expect(links(shown)).toEqual(['./settings/project#git-title', './settings/project#add-url', './new', './settings/project']);
  });

  // A pick is a plain post of the project's id, so the page loads again on it. The open project is no button.
  it('picks another project with a post that makes it current, and opens New project at /new', () => {
    const shown = menu(draw({ projects: several }));

    expect(form(shown)).toMatch(/^<form method="POST" action="\.\/api\/current-project"[^>]*>/);
    expect([...form(shown).matchAll(/<button type="submit" class="pr[^"]*" name="project" value="(\d+)">/g)].map((match) => match[1])).toEqual(['2', '3', '4']);
    expect(form(shown)).toMatch(/<div class="pr current[^"]*">[\s\S]*?recipes/);
    expect(links(shown)).toEqual(['./settings/project#git-title', './settings/project#add-url', './new', './settings/project']);
  });

  it('is handed the projects off the layout, the busiest first, with the open one counted off the Now stream', () => {
    const layout = read('../routes/+layout.svelte');

    expect(/<Rail\b[\s\S]*?\/>/.exec(layout)?.[0]).toContain('{projects}');
    expect(layout).toContain('const projects = $derived(selectorRows(data.projects, nowLive.state.snapshot?.boards ?? null));');
    expect(read('../routes/+layout.server.ts')).toContain('projects: projectChoices(),');
  });

  // jsdom's location cannot be spied on, so the source says it. A reload would keep a card page's
  // address, whose key can be another card in the new project, and would cancel the picking tab's
  // own way to Now.
  it('opens Now when the stream says another project became the current one', () => {
    const layout = read('../routes/+layout.svelte');

    expect(layout).toContain("if (nowLive.state.snapshot?.switched === true) location.assign(resolve('/'));");
    expect(layout).not.toContain('location.reload()');
  });
});

describe('the links', () => {
  it('links Now, Delivery and every board that is on, then the project screens and Settings', () => {
    const body = draw({ offBoards: ['prreview'] });

    expect(links(body).slice(4)).toEqual([
      './',
      './b/delivery',
      './b/epics',
      './b/research',
      './settings/project#boards',
      './workspace',
      './knowledge',
      './scout',
      './evidence',
      './settings/project',
      'https://nolzu.com/docs',
      'https://github.com/nolzu/nolzu/issues/new/choose',
    ]);
    // One Research item where Investigations and Questions stood.
    expect(text(body)).toContain('Now Boards Delivery Epics Research Add a board Project Workspace Knowledge Scout Evidence');
    expect(text(body)).not.toContain('Questions');
    expect(text(body)).not.toContain('PR reviews');
  });

  it('offers Add a board only while a board is off', () => {
    expect(draw()).not.toContain('Add a board');
    expect(draw({ offBoards: ['epics'] })).toContain('Add a board');
  });

  // On a card page the card is the page, so its board is marked as where it sits and not as the page.
  it.each([
    // Now sits at `/`, and every board at `/b/<board>`.
    ['/', { routeId: '/' }, './', 'page'],
    ['/b/delivery', { routeId: '/b/[board]', board: 'delivery' }, '../b/delivery', 'page'],
    ['/b/epics', { routeId: '/b/[board]', board: 'epics' }, '../b/epics', 'page'],
    ['/t/APP-1/overview', { routeId: '/t/[key]/[tab]', cardBoard: 'prreview' as const }, '../../b/prreview', 'true'],
    ['/knowledge', { routeId: '/knowledge' }, './knowledge', 'page'],
    ['/workspace', { routeId: '/workspace' }, './workspace', 'page'],
    ['/scout/f/3', { routeId: '/scout/f/[id]' }, '../../scout', 'page'],
    ['/evidence', { routeId: '/evidence' }, './evidence', 'page'],
    ['/settings/models', { routeId: '/settings/[section]' }, '../settings/project', 'page'],
    // Settings opens on Project, and stays marked on every settings page.
    ['/settings/runs', { routeId: '/settings/[section]' }, '../settings/project', 'page'],
  ] as const)('marks the one link of the page at %s', (at, over, href, mark) => {
    const body = draw(over, at);
    const current = [...body.matchAll(/<a\b[^>]*aria-current="[^"]*"[^>]*>/g)];

    expect(current).toHaveLength(1);
    expect(current[0]?.[0]).toContain(`href="${href}"`);
    expect(current[0]?.[0]).toContain(`aria-current="${mark}"`);
  });

  // The mark is drawn as the box and the ink, so it is not colour alone. Read off the source, because a
  // server render has no CSS.
  it('draws the marked link in its box', () => {
    const css = readFileSync(new URL('./Rail.svelte', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const box = /\.nav a\[aria-current\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(box).toContain('background: var(--card);');
    expect(box).toContain('box-shadow: inset 0 0 0 1px var(--line);');
    expect(box).toContain('color: var(--ink);');
  });

  it('marks nothing on a page the rail has no link for', () => {
    expect(draw({ routeId: '/projects' }, '/projects')).not.toContain('aria-current');
  });

  // The help lists only live keys, and a G chord goes where the rail's link for it goes.
  it('links the place each G chord goes to', () => {
    const layout = readFileSync(new URL('../routes/+layout.svelte', import.meta.url), 'utf8');
    const body = draw({}, '/');
    // The selector and the bell's panel open over the page, so they have no place to link.
    const chords = scoped('global').filter((binding) => binding.action.startsWith('go:') && binding.action !== 'go:project' && binding.action !== 'go:notifications');

    expect(chords.length).toBeGreaterThan(4);
    for (const { action } of chords) {
      const call = new RegExp(`'${action}': \\(\\) => void goto\\(resolve\\('([^']+)'(?:, \\{ board: '(\\w+)' \\})?\\)\\)`).exec(layout);
      expect(call, action).not.toBeNull();
      const [, route = '', board] = call!;
      expect(links(body), action).toContain(resolve(route, board === undefined ? {} : { board }));
    }
    // G then P opens the selector itself, on every plan.
    expect(layout).toContain("railShown && project !== null ? { 'go:project': () => void rail?.openMenu() }");
  });

  // The rail's props have defaults, so a merge that dropped one would pass the typecheck. Off boards
  // would come back in the rail, and a card page would mark no board. routes/layout.mount.test.ts
  // mounts the layout and holds the count against Now's section.
  it('is handed what the root layout knows', () => {
    const layout = readFileSync(new URL('../routes/+layout.svelte', import.meta.url), 'utf8');
    const call = /<Rail\b[\s\S]*?\/>/.exec(layout)?.[0] ?? '';

    for (const prop of ['routeId={page.route.id}', 'board={page.params.board}', '{cardBoard}', 'offBoards={data.offBoards}', '{project}', 'usage={data.usage}', '{waiting}', '{slots}', '{firstRun}', 'onsearch={() => palette?.show()}', 'ontheme={toggleTheme}']) {
      expect(call, prop).toContain(prop);
    }
    // The count and the slots come off the one Now stream the layout keeps open, the one the Now page
    // reads.
    expect(layout).toContain("const client = connectBoard(browserStream(resolve('/api/now')), (state) => (nowLive.state = state), isNow);");
    expect(layout).toContain('const waiting = $derived(waitingCount(nowLive.state.snapshot));');
    expect(layout).toContain('const slots = $derived(nowLive.state.snapshot?.boards[0]?.slots ?? null);');
    expect(read('../routes/+page.svelte')).toContain('<NowPage stream={nowLive.state} />');
    expect(layout).toMatch(/\{#if railShown\}\s*<Rail\b/);
    expect(layout).toContain("const railShown = $derived(!(page.route.id?.startsWith('/new') ?? false) && page.route.id !== '/accept');");
    // The rail stays open on the boards too, so the layout never folds it.
    expect(call).not.toContain('compact');
    expect(layout).toContain('const firstRun = $derived(nowLive.state.snapshot?.firstRun ?? data.firstRun ?? null);');
    expect(layout).toContain("const cardBoard = $derived(page.route.id?.startsWith('/t/[key]') ? ((page.data as { ticket?: { board?: BoardKind } }).ticket?.board ?? null) : null);");
  });

  // Never a control that does nothing: the search button only with a palette to open, and the board
  // counts come with their screen.
  it('draws the search button only with a palette to open, and no count beside a board', () => {
    expect(text(draw({ waiting: 3 }))).not.toMatch(/Search|⌘K/);
    const body = draw({ waiting: 3, onsearch: () => {} });
    const button = /<button[^>]*class="cmdk[^"]*"[^>]*>[\s\S]*?<\/button>/.exec(body)?.[0] ?? '';

    expect(text(button)).toBe('Search or run a command ⌘K');
    expect(button).toContain('aria-keyshortcuts="Meta+K Control+K"');
    expect(button).toMatch(/<kbd[^>]*aria-hidden="true"[^>]*>⌘K<\/kbd>/);
    expect(body.match(/class="n\b/g)).toHaveLength(1);
  });

  // The count is the count of Now's first section, a badge only while something waits, and cream.
  it('draws Now first, with how many cards wait on the person', () => {
    const body = draw({ waiting: 3 });
    const now = /<nav class="nav[^"]*" aria-label="Main">[\s\S]*?<\/nav>/.exec(body)?.[0] ?? '';

    expect(text(now)).toBe('Now 3 waiting on you');
    expect(now).toMatch(/<a href="\.\/"[^>]*>/);
    expect(now).toMatch(/<span class="n[^"]*" data-now-count="">3<\/span>/);
    for (const none of [0, null]) {
      expect(text(/<nav class="nav[^"]*" aria-label="Main">[\s\S]*?<\/nav>/.exec(draw({ waiting: none }))?.[0] ?? '')).toBe('Now');
    }
    expect(draw({ waiting: 3, compact: true, routeId: '/b/[board]', board: 'delivery' }, '/b/delivery')).toMatch(/<a href="\.\.\/"[^>]*aria-label="Now, 3 waiting on you"/);
  });

  it('draws the count on the cream accent and never amber', () => {
    const css = readFileSync(new URL('./Rail.svelte', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const badge = /\n {2}\.n\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(badge).toContain('background: var(--accent);');
    expect(badge).toContain('color: var(--accent-ink);');
  });
});

// "Delivery 9" and "Epics 2", off the Now stream on every page with the rail.
describe('the board counts', () => {
  const counts = { delivery: 9, epics: 1, research: 0 };

  it('draws a quiet count after each board the stream counted, with its noun for a screen reader', () => {
    const body = draw({ counts });
    const boards = /<nav class="nav[^"]*" aria-label="Boards">[\s\S]*?<\/nav>/.exec(body)?.[0] ?? '';

    expect(text(boards)).toBe('Delivery 9 , 9 cards Epics 1 , 1 epic Research 0 , 0 cards PR reviews');
    expect(boards).toMatch(/<span class="count[^"]*" aria-hidden="true">9<\/span>/);
    // Nothing between the name and its count, so a screen reader hears "Delivery, 9 cards" and not
    // "Delivery , 9 cards".
    expect(boards).toMatch(/>Delivery<\/span><!--\[0--><span class="count/);
    // A total is no badge: the cream pill stays Now's alone.
    expect(boards).not.toMatch(/class="n\b/);
  });

  // The same counts on Now, Research, a board and a card page, because the layout hands them to the
  // one rail every page draws.
  it('is handed the counts off the one Now stream', () => {
    const layout = read('../routes/+layout.svelte');

    expect(layout).toContain('const counts = $derived(railCounts(nowLive.state.snapshot?.boards ?? null));');
    expect(/<Rail\b[\s\S]*?\/>/.exec(layout)?.[0]).toContain('{counts}');
  });

  it('hides the count in the folded strip and keeps it in the name', () => {
    const body = draw({ counts, compact: true, routeId: '/b/[board]', board: 'delivery' }, '/b/delivery');
    const css = readFileSync(new URL('./Rail.svelte', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const strip = /@media \(min-width: 761px\) \{([\s\S]*?)\n {2}\}/.exec(css)?.[1] ?? '';

    expect(body).toMatch(/aria-label="Delivery board, 9 cards"/);
    expect(body).toMatch(/aria-label="Epics board, 1 epic"/);
    expect(strip).toMatch(/\.compact \.count \{\s*display: none;\s*\}/);
  });

  it('draws the count in muted ink and never amber', () => {
    const css = readFileSync(new URL('./Rail.svelte', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\n {2}\.count\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(rule).toContain('color: var(--muted);');
    expect(rule).not.toContain('amber');
  });
});

// The changed files of the Workspace page's last read, quiet like a board's total, with its noun for a
// screen reader. None before a read and none at 0.
describe('the Workspace count', () => {
  it('shows the changed files of the last read', () => {
    const body = draw({ changed: 5 });
    const link = /<a\b[^>]*href="\.\/workspace"[^>]*>[\s\S]*?<\/a>/.exec(body)?.[0] ?? '';

    expect(link).toMatch(/<span class="count[^"]*" data-workspace-count="" aria-hidden="true">5<\/span>/);
    expect(text(link)).toBe('Workspace 5 , 5 changed files');
    expect(draw({ changed: 5, compact: true })).toMatch(/aria-label="Workspace, 5 changed files"/);
    expect(draw({ changed: 1, compact: true })).toMatch(/aria-label="Workspace, 1 changed file"/);
  });

  it.each([null, 0])('draws no number for %s', (changed) => {
    expect(draw({ changed })).not.toContain('data-workspace-count');
    expect(draw({ changed, compact: true })).toMatch(/aria-label="Workspace"/);
  });

  it('takes the count from the layout load', () => {
    expect(/<Rail\b[\s\S]*?\/>/.exec(read('../routes/+layout.svelte'))?.[0]).toContain('changed={data.workspaceChanged}');
  });
});

// A knowledge change waits on the person, so its count is the cream one of Now and the bell.
describe('the Knowledge count', () => {
  it('shows how many knowledge changes wait for review', () => {
    const link = /<a\b[^>]*href="\.\/knowledge"[^>]*>[\s\S]*?<\/a>/.exec(draw({ reviews: 2 }))?.[0] ?? '';

    expect(link).toMatch(/<span class="n[^"]*" data-knowledge-count="" aria-hidden="true">2<\/span>/);
    expect(text(link)).toBe('Knowledge 2 , 2 changes wait for your review');
    expect(draw({ reviews: 1, compact: true })).toMatch(/aria-label="Knowledge, 1 change waits for your review"/);
    expect(draw({ reviews: 0 })).not.toContain('data-knowledge-count');
  });

  it('takes the count from the Now stream', () => {
    expect(/<Rail\b[\s\S]*?\/>/.exec(read('../routes/+layout.svelte'))?.[0]).toContain('{reviews}');
    expect(/<Rail\b[\s\S]*?\/>/.exec(read('../routes/+layout.svelte'))?.[0]).toContain('{writing}');
  });

  // A Learn run, Optimize or a wrap-up writes the folder: a turning ring, since the rail draws no amber.
  it('draws the turning ring while a run writes knowledge', () => {
    const link = /<a\b[^>]*href="\.\/knowledge"[^>]*>[\s\S]*?<\/a>/.exec(draw({ writing: true }))?.[0] ?? '';

    expect(link).toMatch(/<span class="dot run[^"]*" data-knowledge-writing="" aria-hidden="true"><\/span>/);
    expect(text(link)).toContain('a run is writing knowledge');
    expect(draw({ writing: true, compact: true })).toMatch(/aria-label="Knowledge, a run is writing knowledge"/);
    expect(draw()).not.toContain('data-knowledge-writing');
  });
});

// The bell's tip names its key, as the theme switch's names T.
it('names the key of the notifications in the bell tip', () => {
  const bell = /<button[^>]*class="bell[^"]*"[\s\S]*?<\/button>/.exec(draw({ onbell: () => {} }))?.[0] ?? '';

  expect(text(bell)).toContain('Notifications, or press G then B');
  expect(read('../routes/+layout.svelte')).toContain("'go:notifications': () => (noticesOpen = true)");
});

// Notifications are not a place to work in, so the bell sits in the header beside the selector and
// not in the list of places.
describe('the bell', () => {
  const bell = (body: string) => /<button[^>]*class="bell[^"]*"[^>]*>[\s\S]*?<\/button>/.exec(body)?.[0] ?? '';

  it('sits beside the selector, out of the list of places, with the unread count in its name', () => {
    const body = draw({ unread: 4, onbell: () => {} });
    const top = /<div class="top[^"]*">[\s\S]*?(?=<div class="scroll)/.exec(body)?.[0] ?? '';

    expect(bell(top)).toContain('aria-label="Notifications, 4 unread"');
    expect(bell(top)).toContain('aria-haspopup="dialog"');
    expect(bell(top)).toMatch(/<span class="n[^"]*" data-unread="" aria-hidden="true">4<\/span>/);
    expect(top.indexOf('class="proj')).toBeLessThan(top.indexOf('class="bell'));
    for (const nav of body.match(/<nav\b[\s\S]*?<\/nav>/g) ?? []) expect(nav).not.toContain('Notifications');
  });

  it('draws no badge with nothing unread, and no bell with no panel to open', () => {
    for (const none of [0, null]) {
      const button = bell(draw({ unread: none, onbell: () => {} }));
      expect(button).toContain('aria-label="Notifications"');
      expect(button).not.toContain('data-unread');
    }
    expect(bell(draw({ unread: 4 }))).toBe('');
  });

  // With no project there is no selector, and the bell keeps its place in the header.
  it('stays in the header with no project set', () => {
    expect(/<div class="top[^"]*">[\s\S]*?(?=<div class="scroll)/.exec(draw({ project: null, unread: 1, onbell: () => {} }))?.[0]).toContain('aria-label="Notifications, 1 unread"');
  });

  // Focus follows the header: the selector and its menu, the bell, then the search.
  it('takes the focus after the selector and before the search', () => {
    const body = draw({ onbell: () => {}, onsearch: () => {} });
    const order = [...body.matchAll(/<button\b[^>]*class="(proj|bell|cmdk)[^"]*"/g)].map((match) => match[1]);

    expect(order).toEqual(['proj', 'bell', 'cmdk']);
  });

  it('shows its tip on keyboard focus as well as on hover', () => {
    const css = readFileSync(new URL('./Rail.svelte', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const shown = [...css.matchAll(/([^{}]+)\{\s*visibility:\s*visible;\s*\}/g)].flatMap((match) => match[1]!.split(',').map((one) => one.trim()));

    for (const selector of ['.bell:hover .tip', '.bell:focus-visible .tip']) expect(shown, selector).toContain(selector);
  });

  // The menu sits at left: 100% of its box. Off the selector that would be over the bell, so the header
  // is the box.
  it('opens the project menu past the bell, not over it', () => {
    const css = readFileSync(new URL('./Rail.svelte', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (name: string) => new RegExp(`\\n\\s*\\${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';

    expect(rule('.top')).toContain('position: relative');
    expect(rule('.selector')).not.toContain('position');
  });
});

describe('the folded strip on a board', () => {
  // Every icon has a name a screen reader says and a tip on hover and focus, which is the word the
  // full rail shows.
  it('names every icon and gives each one a tip', () => {
    const body = draw({ compact: true, routeId: '/', offBoards: ['prreview'] }, '/');
    // The Help line leaves the app and is hidden in the strip, so it has no icon to name.
    const anchors = [...body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].filter(([, attributes]) => !/class="it\b|target="_blank"/.test(attributes ?? ''));

    expect(anchors.map(([, attributes]) => /aria-label="([^"]*)"/.exec(attributes ?? '')?.[1])).toEqual([
      'Now',
      'Delivery board',
      'Epics board',
      'Research board',
      'Add a board',
      'Workspace',
      'Knowledge',
      'Scout',
      'Evidence',
      'Settings',
    ]);
    for (const [, , inside] of anchors) expect(inside).toMatch(/<span class="label[^"]*" aria-hidden="true">[^<]+<\/span>/);
    expect(body).toMatch(/<button[^>]*class="theme[^"]*"[^>]*aria-label="Switch the theme"[^>]*>[\s\S]*?<span class="tip[^"]*" aria-hidden="true">Switch the theme, or press T<\/span>/);
    expect(body).toMatch(/class="proj[^"]*"[^>]*aria-label="Project recipes, 2 repositories, project menu"/);
  });

  // A server render has no CSS, so the rule is read off the source: the tip shows on keyboard focus as
  // well as on hover, or a keyboard user meets a row of bare icons.
  it('shows each tip on keyboard focus as well as on hover', () => {
    const css = readFileSync(new URL('./Rail.svelte', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const shown = [...css.matchAll(/([^{}]+)\{\s*visibility:\s*visible;\s*\}/g)].flatMap((match) => match[1]!.split(',').map((one) => one.trim()));

    for (const selector of ['.compact .nav a:hover .label', '.compact .nav a:focus-visible .label', '.compact .proj:hover .pt', '.compact .proj:focus-visible .pt', '.theme:hover .tip', '.theme:focus-visible .tip']) {
      expect(shown, selector).toContain(selector);
    }
  });

  // The board design's strip draws no search, so the strip hides the button and Cmd K opens the palette.
  it('hides the search button on the folded strip', () => {
    const css = readFileSync(new URL('./Rail.svelte', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const strip = /@media \(min-width: 761px\) \{([\s\S]*?)\n {2}\}/.exec(css)?.[1] ?? '';

    expect(strip).toMatch(/\.compact \.cmdk \{\s*display: none;\s*\}/);
  });

  it('keeps the words in sight and in the names of the full rail', () => {
    const body = draw();

    expect(body).not.toMatch(/<a\b[^>]*aria-label=/);
    expect(body).not.toMatch(/class="label[^"]*" aria-hidden/);
  });
});

// Focus follows this order: the selector and its menu, the boards, the project screens, then the
// foot.
it('puts the controls in order', () => {
  const body = draw({ offBoards: ['epics'], onsearch: () => {} });
  const order = [...body.matchAll(/<(a|button)\b[^>]*?(?:href="([^"]*)"|class="(proj|theme|cmdk)[^"]*")/g)].map((match) => match[2] ?? match[3]);

  expect(order).toEqual([
    'proj',
    './settings/project#git-title',
    './settings/project#add-url',
    './settings/project',
    './new',
    'cmdk',
    './',
    './b/delivery',
    './b/research',
    './b/prreview',
    './settings/project#boards',
    './workspace',
    './knowledge',
    './scout',
    './evidence',
    './settings/project',
    'theme',
    'https://nolzu.com/docs',
    'https://github.com/nolzu/nolzu/issues/new/choose',
  ]);
});

describe('the usage foot', () => {
  it('shows the last reading of the engine window, with when it was seen', () => {
    const body = draw({ usage: { label: 'Claude Code', share: 62, resets: '11 Oct, 19:00', seen: '11 Oct, 14:20' } });

    expect(text(body)).toContain('Claude Code 5h window 62% Resets 11 Oct, 19:00 Seen 11 Oct, 14:20 Settings');
    expect(body).toContain('style="width: 62%;"');
  });

  it('fills the bar no further than full for an account over its window', () => {
    expect(draw({ usage: { label: 'Claude Code', share: 130, resets: null, seen: '11 Oct, 14:20' } })).toContain('style="width: 100%;"');
  });

  it('shows no usage with no reading', () => {
    expect(text(draw())).not.toContain('window');
  });

  // "Resets 19:00 · 2 of 3 slots busy". The slots are live, off the Now stream, so they show
  // with no usage reading too, and not before the stream's first event.
  it('says how many agent slots are busy, after the reset time', () => {
    const usage = { label: 'Claude Code', share: 62, resets: '11 Oct, 19:00', seen: '11 Oct, 14:20' };

    expect(text(draw({ usage, slots: { busy: 2, total: 3 } }))).toContain('Claude Code 5h window 62% Resets 11 Oct, 19:00 · 2 of 3 slots busy Seen 11 Oct, 14:20 Settings');
    expect(text(draw({ slots: { busy: 0, total: 1 } }))).toContain('Evidence 0 of 1 slot busy Settings');
    expect(draw({ slots: null })).not.toContain('data-slots');
    expect(draw({ slots: { busy: 0, total: 0 } })).not.toContain('data-slots');
  });

  // The 56px strip has no room for it: drawn there, it spilled past the strip's left edge.
  it('hides the usage in the folded strip', () => {
    const css = readFileSync(new URL('./Rail.svelte', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

    expect(css).toMatch(/\.compact \.eng,\s*\.compact \.help\s*\{\s*display:\s*none;\s*\}/);
  });
});

// The first drag draws the foot with Getting started in place of the usage, and the offer under it.
// Help: the guides and the bug form, outside the app, so a new tab and no referrer.
it('links the docs and the bug report form under Settings', () => {
  const help = /<nav class="help[^"]*" aria-label="Help">([\s\S]*?)<\/nav>/.exec(draw())?.[1] ?? '';

  expect(text(help)).toBe('Docs Report a bug');
  expect(links(help)).toEqual(['https://nolzu.com/docs', 'https://github.com/nolzu/nolzu/issues/new/choose']);
  expect(help.match(/target="_blank" rel="noreferrer"/g)).toHaveLength(2);
});

describe('Getting started in the foot', () => {
  const firstRun = {
    steps: [
      { id: 'card' as const, label: 'Make the first card', done: true },
      { id: 'drag' as const, label: 'Drag it to Refine', done: false },
      { id: 'summary' as const, label: 'Read what changed', done: false },
      { id: 'push' as const, label: 'Push your first branch', done: false },
    ],
    coach: 'first-drag',
    loginOffer: 'start-at-login',
  };
  const usage = { label: 'Claude Code', share: 62, resets: '11 Oct, 19:00', seen: '11 Oct, 14:20' };

  it('holds the list in place of the usage, then the offer, then Settings', () => {
    const shown = text(draw({ usage, slots: { busy: 0, total: 3 }, firstRun }));

    expect(shown).toContain('Evidence Getting started 1/4 , 1 of 4 done Make the first card , done Drag it to Refine Read what changed Push your first branch Start Nolzu when you log in? Turn on Not now Settings');
    expect(shown).not.toContain('5h window');
  });

  it('shows the usage again once the list is done, with the offer still asked', () => {
    const shown = text(draw({ usage, firstRun: { ...firstRun, steps: null } }));

    expect(shown).toContain('5h window 62%');
    expect(shown).toContain('Start Nolzu when you log in?');
    expect(shown).not.toContain('Getting started');
  });

  it('draws neither in the folded strip', () => {
    const shown = text(draw({ compact: true, routeId: '/b/[board]', board: 'delivery', firstRun: { ...firstRun, steps: null } }, '/b/delivery'));
    expect(shown).not.toContain('log in');
  });

  it('puts no amber on the list or the offer', () => {
    expect(readFileSync(new URL('./GettingStarted.svelte', import.meta.url), 'utf8')).not.toMatch(/--amber|--hatch/);
  });
});

// The version sits beside the word, short on screen and full in the tip and for a screen reader.
// Tests run without the build's define, so the line is the fallback, 0.0.0 with no commit and no date.
describe('the version line', () => {
  it('draws the version beside the logo, with the full line in the tip', () => {
    const brand = /<div class="brand[\s\S]*?<\/div>/.exec(draw())?.[0] ?? '';

    expect(brand).toMatch(/<span class="version[^"]*" title="Nolzu 0.0.0">/);
    expect(brand).toMatch(/<span aria-hidden="true">0.0.0<\/span>/);
    // Below 1.0 the beta pill follows the version.
    expect(brand).toMatch(/<span class="beta[^"]*" title="Nolzu is in beta until 1.0. Things can change between versions.">beta<\/span>/);
    expect(text(brand)).toBe('Nolzu 0.0.0 Nolzu 0.0.0 beta');
  });
});
