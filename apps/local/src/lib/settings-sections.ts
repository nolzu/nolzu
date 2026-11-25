import { CLOUD_OPEN } from '@nolzu/protocol';

// The sections this version ships, each on its own page at /settings/<id>. The menu is built from
// this list, so a name here with no section behind it would be a link that does nothing. Its own
// module and not `settings-page.ts`, because the menu draws in the browser and that one reads sqlite.
// Project is first because it edits the project open now, and it has a route of its own because its
// forms are the old Projects page's. Phase instructions has one too, because it writes files in the
// project folder and reads no setting. MCP servers has one for the same reason, and keeps secrets in the
// keychain. Wall has one because it shows the wall's fixed rules, which are no setting.
// Integrations has one because its logins are the machine's, with forms of their own.
export const ALL_SECTIONS = [
  { id: 'project', title: 'Project' },
  { id: 'engines', title: 'Engines' },
  { id: 'models', title: 'Models' },
  { id: 'phases', title: 'Phase instructions' },
  { id: 'mcp', title: 'MCP servers' },
  { id: 'runs', title: 'Runs' },
  { id: 'integrations', title: 'Integrations' },
  { id: 'wall', title: 'Wall' },
  { id: 'cloud', title: 'Cloud' },
] as const;

// Cloud holds the account and what goes to a hub, so it is no section while the cloud is closed.
export const SECTIONS: readonly (typeof ALL_SECTIONS)[number][] = ALL_SECTIONS.filter((section) => CLOUD_OPEN || section.id !== 'cloud');

// The boxes of Settings, Project, in page order, which the menu lists under Project. Each id is the
// box's anchor on that page.
const ALL_PROJECT_BOXES = [
  { id: 'identity', title: 'Name and folder' },
  { id: 'repositories', title: 'Repositories' },
  { id: 'cards', title: 'Cards and branches' },
  { id: 'agent', title: 'Agent' },
  { id: 'boards', title: 'Boards' },
  { id: 'knowledge', title: 'Knowledge' },
  { id: 'evidence', title: 'Evidence' },
  { id: 'walls', title: 'Walls' },
  { id: 'tickets', title: 'Tickets' },
] as const;

// Evidence has no box on Settings, Project (its client and rate save on Evidence), so the menu names
// none. Its id stays reserved for when Evidence is back.
export const PROJECT_BOXES: readonly (typeof ALL_PROJECT_BOXES)[number][] = ALL_PROJECT_BOXES.filter((box) => box.id !== 'evidence');

export type SectionId = (typeof ALL_SECTIONS)[number]['id'];

export const sectionOf = (id: string): (typeof SECTIONS)[number] | null => SECTIONS.find((section) => section.id === id) ?? null;

// The sections where every setting saves on change, which the top bar says. Project keeps a Save
// button on its text boxes and Engines on a profile's label, so a person who reads the promise there
// and leaves loses what they typed. Wall and Cloud change nothing, and Integrations has Save buttons.
export const savesOnChange = (id: string | null): boolean => id === 'models' || id === 'runs';

// Where each old section went, so a saved link still lands on what it
// showed. Knowledge had one switch, which now sits at the foot of Runs, and Scout's sources sit on
// the Scout page. What leaves this machine is a box on Cloud. A Map and not an object, so a name off the object prototype is no old section.
export const MOVED: ReadonlyMap<string, string> = new Map([
  ['agents', '/settings/runs'],
  ['knowledge', '/settings/runs#knowledge'],
  ['scout', '/scout#sources'],
  ['connection', CLOUD_OPEN ? '/settings/cloud' : '/settings/project'],
  ['data', CLOUD_OPEN ? '/settings/cloud#data' : '/settings/project'],
]);

export const movedTo = (id: string): string | null => MOVED.get(id) ?? null;

// Every id a feature's settings block cannot take: an old /settings#<id> link goes to that section's
// page, or to where an old one went, and never to the block.
// A box of Settings, Project is taken too, since a block sits on that same page.
export const RESERVED_IDS: readonly string[] = [...new Set([...ALL_SECTIONS.map((section) => section.id), ...MOVED.keys(), ...ALL_PROJECT_BOXES.map((box) => box.id)])];

// Where a /settings address goes: an old #<id> link to that section's page, or to where an old
// section went. Any other hash is a feature block's anchor, which sits at the foot of Project, and a
// plain /settings opens Project, the first section.
export function addressFromHash(hash: string): string {
  const id = hash.startsWith('#') ? hash.slice(1) : '';
  if (sectionOf(id) !== null) return `/settings/${id}`;
  return movedTo(id) ?? (id === '' ? '/settings/project' : `/settings/project#${id}`);
}

export const settingsTitle = (id: string | null): string => {
  const section = id === null ? null : sectionOf(id);
  return section === null ? 'Settings · Nolzu' : `${section.title} · Settings · Nolzu`;
};
