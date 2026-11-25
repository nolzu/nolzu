import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { expect, it } from 'vitest';

// A page with no <title> of its own keeps the one the page before it set, which is how the board said
// "Settings" after going back through the logo. So every page sets one: in its own file, in a layout
// of its own folder above it (not the root one, which every page shares), or in the one app component
// it hands the whole page to.
const routes = new URL('.', import.meta.url).pathname;
const lib = join(routes, '..', 'lib');
const SETS_TITLE = /<svelte:head><title>([^<]+)<\/title><\/svelte:head>/;

// What each page's title says, by hand, so a page left with another page's title fails here. A page
// added without a line here fails too.
const TITLES: Record<string, string> = {
  '+page.svelte': 'Now · Nolzu',
  'accept/+page.svelte': 'Before you start · Nolzu',
  'b/[board]/+page.svelte': '{title} · Nolzu',
  'b/research/+page.svelte': '{title} · Nolzu',
  'knowledge/+page.svelte': 'Knowledge · Nolzu',
  'workspace/+page.svelte': 'Workspace · Nolzu',
  'team/+page.svelte': 'Team · Nolzu',
  'f/[...path]/+page.svelte': "{found?.title ?? 'No page here'} · Nolzu",
  'evidence/+page.svelte': 'Evidence · Nolzu',
  'new/+page.svelte': 'New project · Nolzu',
  'new/idea/+page.svelte': 'Start from an idea · Nolzu',
  'new/task/+page.svelte': 'The first task · Nolzu',
  'settings/+page.svelte': 'Settings · Nolzu',
  'settings/[section]/+page.svelte': '{settingsTitle(data.section)}',
  'settings/project/+page.svelte': "{settingsTitle('project')}",
  'settings/phases/+page.svelte': "{settingsTitle('phases')}",
  'settings/mcp/+page.svelte': "{settingsTitle('mcp')}",
  'settings/wall/+page.svelte': "{settingsTitle('wall')}",
  'settings/integrations/+page.svelte': "{settingsTitle('integrations')}",
  't/[key]/[tab]/+page.svelte': '{data.ticket.key} {data.ticket.title} · Nolzu',
  'scout/+page.svelte': 'Scout · Nolzu',
  'scout/f/[id]/+page.svelte': 'Finding {data.finding.row.id} · Nolzu',
  '+error.svelte': '{page.status} {page.error?.message} · Nolzu',
};

// The error page too, which shows in place of any page.
const pages = readdirSync(routes, { recursive: true, encoding: 'utf8' }).filter((file) => file.endsWith('+page.svelte') || file.endsWith('+error.svelte'));

it('finds the pages', () => {
  expect(pages.length).toBeGreaterThan(10);
});

// The page first and Nolzu last, so a row of narrow tabs still reads by page and says whose it is.
it('ends every title in Nolzu', () => {
  for (const title of Object.values(TITLES)) expect(title.endsWith(' · Nolzu') || title.startsWith('{settingsTitle(')).toBe(true);
});

it.each(pages)('%s sets a title that names it', (file) => {
  const own = readFileSync(join(routes, file), 'utf8');
  const layouts: string[] = [];
  for (let folder = dirname(join(routes, file)); relative(routes, folder) !== ''; folder = dirname(folder)) {
    try {
      layouts.push(readFileSync(join(folder, '+layout.svelte'), 'utf8'));
    } catch {
      // No layout in this folder.
    }
  }
  const handed = [...own.matchAll(/import (\w+) from '\$lib\/(\w+\.svelte)'/g)]
    .filter(([, name]) => new RegExp(`^<${name}\\b`, 'm').test(own))
    .map(([, , path]) => readFileSync(join(lib, path!), 'utf8'));

  // The nearest one wins: the page itself, then the component it hands off to, then its layouts.
  const title = [own, ...handed, ...layouts].map((source) => SETS_TITLE.exec(source)?.[1]).find((found) => found !== undefined);
  expect(title).toBe(TITLES[file]);
});
