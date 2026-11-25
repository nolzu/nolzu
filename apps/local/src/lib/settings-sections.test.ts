import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { addressFromHash, MOVED, movedTo, RESERVED_IDS, SECTIONS, savesOnChange, sectionOf, settingsTitle } from './settings-sections.ts';

// The cloud waits for the paid plans (`packages/protocol/src/soon.ts`). This file pins the code kept for
// then, and cloud-closed.test.ts pins the closed state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true }));

// Each section is its own page, and the menu is built from this list, so a name here with no page
// behind it is a dead link. Project comes first.
it('lists the sections in the order the menu shows them', () => {
  expect(SECTIONS.map((section) => [section.id, section.title])).toEqual([
    ['project', 'Project'],
    ['engines', 'Engines'],
    ['models', 'Models'],
    ['phases', 'Phase instructions'],
    ['mcp', 'MCP servers'],
    ['runs', 'Runs'],
    ['integrations', 'Integrations'],
    ['wall', 'Wall'],
    ['cloud', 'Cloud'],
  ]);
});

it('knows a section by its id and nothing else', () => {
  expect(sectionOf('models')?.title).toBe('Models');
  expect(sectionOf('cloud')?.title).toBe('Cloud');
  expect(sectionOf('billing')).toBeNull();
  expect(sectionOf('')).toBeNull();
  // A name off the object prototype is not a section either.
  expect(sectionOf('toString')).toBeNull();
  // An old section is no section now, so the menu cannot link it.
  expect(sectionOf('agents')).toBeNull();
});

// Every old section has a new home, and a link to one lands there: Agents is Runs, Knowledge's one
// switch sits at the foot of Runs, Scout's sources are on the Scout page, the Cloud connection is
// Cloud, and What leaves this machine is a box on Cloud.
it.each([
  ['agents', '/settings/runs'],
  ['knowledge', '/settings/runs#knowledge'],
  ['scout', '/scout#sources'],
  ['connection', '/settings/cloud'],
  ['data', '/settings/cloud#data'],
])('sends the old %s section to its new home', (id, home) => {
  expect(movedTo(id)).toBe(home);
  expect(addressFromHash(`#${id}`)).toBe(home);
});

it('moves no section that is still there, and no name that never was one', () => {
  expect([...MOVED.keys()]).toEqual(['agents', 'knowledge', 'scout', 'connection', 'data']);
  for (const section of SECTIONS) expect(movedTo(section.id)).toBeNull();
  expect(movedTo('billing')).toBeNull();
  expect(movedTo('toString')).toBeNull();
});

// Every link written before the split pointed at /settings#<id>. The browser never sends the hash, so
// the menu page reads it and moves to the section's own page.
it.each(SECTIONS.map((section) => section.id))('sends an old /settings#%s link to its own page', (id) => {
  expect(addressFromHash(`#${id}`)).toBe(`/settings/${id}`);
});

// Settings opens on its first section, and a feature block now sits at the foot of Project, so a
// hash that is no section keeps its anchor there.
it('sends a plain /settings to Project, and a hash that is no section to its anchor on Project', () => {
  expect(addressFromHash('')).toBe('/settings/project');
  expect(addressFromHash('#')).toBe('/settings/project');
  expect(addressFromHash('#time-tracking')).toBe('/settings/project#time-tracking');
  expect(addressFromHash('#toString')).toBe('/settings/project#toString');
  expect(addressFromHash('scout')).toBe('/settings/project');
});

// A feature block under an old id would never show: its anchor goes to the section's new home. One under
// a Project box's id would share that box's anchor on the same page.
it('reserves every section id, every old one and every Project box', () => {
  expect(RESERVED_IDS).toEqual(['project', 'engines', 'models', 'phases', 'mcp', 'runs', 'integrations', 'wall', 'cloud', 'agents', 'knowledge', 'scout', 'connection', 'data', 'identity', 'repositories', 'cards', 'agent', 'boards', 'evidence', 'walls', 'tickets']);
});

// "Saved as you change it" is a promise. Where a box still has its own Save button, a person who
// believes it and leaves loses what they typed.
it('says it saves as you change it only where every setting does', () => {
  expect(SECTIONS.map((section) => section.id).filter(savesOnChange)).toEqual(['models', 'runs']);
  expect(savesOnChange(null)).toBe(false);
  const layout = readFileSync(new URL('../routes/settings/+layout.svelte', import.meta.url), 'utf8');
  expect(layout).toContain('const saves = $derived(savesOnChange(current));');
  // Models words it this way.
  expect(layout).toContain("current === 'models' ? 'Changes reach the next run' : 'Saved as you change it'");
});

// The tab names the page, so going back through the logo cannot leave it saying Settings.
it('names the section first in the page title', () => {
  expect(settingsTitle('models')).toBe('Models · Settings · Nolzu');
  expect(settingsTitle('cloud')).toBe('Cloud · Settings · Nolzu');
  // An old section has no title of its own: its address goes on to Cloud.
  expect(settingsTitle('data')).toBe('Settings · Nolzu');
  expect(settingsTitle(null)).toBe('Settings · Nolzu');
});

// The wire that uses the helper above. `$app/navigation` has no stub here (vitest.config.ts says why),
// so the menu page cannot be mounted, and its source is read instead. Without these lines an old link
// shows the bare menu.
it('has /settings read the hash and replace itself with the page it names', () => {
  const menu = readFileSync(new URL('../routes/settings/+page.svelte', import.meta.url), 'utf8');

  expect(menu).toContain('const to = addressFromHash(location.hash);');
  expect(menu).toContain('void goto(to, { replaceState: true });');
  // Nothing is drawn while it moves on.
  expect(menu).not.toContain('<FeatureSettings');
  expect(menu).toMatch(/\$effect\(\(\) => \{\s+const to = addressFromHash/);
});

// The rail link (rail-render.test.ts) and the palette's Settings, Cmd+comma, both skip the /settings
// hop, which can only move on once the page is in the browser.
it('has the palette Settings action open Project', () => {
  const layout = readFileSync(new URL('../routes/+layout.svelte', import.meta.url), 'utf8');

  expect(layout).toContain("settings: () => void goto(resolve('/settings/project')),");
});

// The blocks a paid package registers have no page of their own. They sat on /settings, which now
// only moves on, so they sit at the foot of Project where the anchors above point.
it('draws the feature settings blocks at the foot of Project', () => {
  const project = readFileSync(new URL('../routes/settings/project/+page.svelte', import.meta.url), 'utf8');

  expect(project).toContain('<FeatureSettings />');
  // After the Project region closes, because a block is not part of Project.
  expect(project.indexOf('<FeatureSettings />')).toBeGreaterThan(project.indexOf('</section>'));
});
