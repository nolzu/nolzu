import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import SettingsMenu from './SettingsMenu.svelte';
import { PROJECT_BOXES, SECTIONS } from './settings-sections.ts';

const drawn = (current: string | null, features: { id: string; title: string; href: string }[] = [], engines: number | null = null) =>
  render(SettingsMenu, { props: { current, href: (id: string) => `/settings/${id}`, features, engines } }).body;
const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

it('links every section to its own page', () => {
  const body = drawn(null);

  for (const { id } of SECTIONS) expect(body).toContain(`href="/settings/${id}"`);
  // No section page is open on the menu page itself, so none is marked.
  expect(body).not.toContain('aria-current');
});

it('marks the open section and only that one', () => {
  const body = drawn('models');

  expect(body.match(/aria-current="page"/g)).toHaveLength(1);
  expect(body).toMatch(/<a href="\/settings\/models" aria-current="page"[^>]*>Models<\/a>/);
});

// A feature's block has no page of its own, so its link is an anchor at the foot of Project.
it('lists a feature block after the sections, by the address it is given', () => {
  const body = drawn('runs', [{ id: 'time-tracking', title: 'Time tracking', href: '/settings/project#time-tracking' }]);

  expect(body).toContain('href="/settings/project#time-tracking"');
  expect(body.indexOf('time-tracking')).toBeGreaterThan(body.indexOf('/settings/cloud'));
});

// The layout hands the menu the open section. `$app/state` has no stub here, so its source is read.
// Without this line no menu item is marked on any section page.
it('has the settings layout mark the section named in the address', () => {
  const layout = readFileSync(new URL('../routes/settings/+layout.svelte', import.meta.url), 'utf8');

  expect(layout).toContain('<SettingsMenu {current} {href} {features} engines={data.enginesFound} />');
  expect(layout).toContain("href: `${resolve('/settings/project')}#${block.id}`");
  // Project has a route of its own, so its id is no param there and the route names it.
  expect(layout).toContain("const current = $derived(page.params.section ?? sectionOf(page.route.id?.replace('/settings/', '') ?? '')?.id ?? null);");
});

// "Engines 2 found", in this order with no Knowledge item.
it('says after Engines how many engine tools were found', () => {
  expect(text(drawn(null, [], 2))).toBe('Project Engines 2 found Models Phase instructions MCP servers Runs Integrations Wall');
  expect(drawn(null, [], 2)).toMatch(/>Engines<span class="n[^"]*">2 found<\/span><\/a>/);
  expect(text(drawn(null, [], 0))).toContain('Engines None found');
  // No look, no count.
  expect(text(drawn(null))).toBe('Project Engines Models Phase instructions MCP servers Runs Integrations Wall');
});

// On Project the menu lists its boxes under it, each an anchor on the page. The box in view is
// marked in the browser, so a server render marks none.
it('lists the boxes of Project under it while Project is open', () => {
  const body = drawn('project');

  for (const { id } of PROJECT_BOXES) expect(body).toContain(`href="#${id}"`);
  expect(text(body)).toMatch(/^Project Name and folder Repositories Cards and branches Agent Boards Knowledge Walls Tickets Engines/);
  expect(body).not.toContain('aria-current="location"');
  expect(drawn('models')).not.toContain('href="#identity"');
});

// A jump to a box glides, and is instant for a person who asked for less motion.
it('scrolls smoothly on the settings pages, and never under reduced motion', () => {
  const layout = readFileSync(new URL('../routes/settings/+layout.svelte', import.meta.url), 'utf8');

  expect(layout).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*:global\(html:has\(\[data-settings-page\]\)\) \{\s*scroll-behavior: smooth;/);
  expect(layout).toContain('<div class="page" data-settings-page>');
});
