import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS } from '@nolzu/core';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import type { DisplayEntitlement } from '@nolzu/protocol';
import { claudeModels, wallHere } from '@nolzu/runner';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// The Runs load reads the start-at-login switch off a home folder: a folder in this suite's temp data
// directory, so no run reads the home of whoever runs it.
vi.mock('$lib/start-at-login.ts', async (real) => {
  const login = await real<typeof import('$lib/start-at-login.ts')>();
  return { ...login, loginSwitch: () => login.loginSwitch(process.platform, join(dir, 'home'), process.argv) };
});
// Check login runs a vendor's CLI and the tool look runs each one's version flag. Both are stood in
// for, so no test here starts the real claude, codex or cursor-agent.
vi.mock('$lib/engine-profiles.ts', async (real) => {
  const profiles = await real<typeof import('$lib/engine-profiles.ts')>();
  return {
    ...profiles,
    engineTools: vi.fn(async () => []),
    checkProfileLogin: vi.fn(async (_db: unknown, form: FormData) => ({ ok: true, check: { id: String(form.get('id')), state: 'in', said: null, at: 0 } })),
  };
});
// Connect again dials the hub. Stood in for, so a press is counted and no test reads a keychain.
vi.mock('$lib/hub-link.ts', async (real) => ({ ...(await real<typeof import('$lib/hub-link.ts')>()), redialHub: vi.fn(async () => true) }));
// Safe above the line that points this suite at a temp data directory: the page and its components
// open nothing, they only draw.
import { MOVED, SECTIONS, settingsTitle } from '$lib/settings-sections.ts';
import Settings from './+page.svelte';
// The stub vitest aliases `$app/paths` to. By path and not by that name, because the app's types for
// `$app/paths` are SvelteKit's own and carry no `drawnAt`.
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../../test/stubs/app-paths.ts';

// The cloud waits for the paid plans (`packages/protocol/src/soon.ts`). This file pins the code kept for
// then, and cloud-closed.test.ts pins the closed state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true }));

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported and opens anything. Not fake mode: fake mode ignores NOLZU_DATA_DIR on purpose,
// and this test would then run against the fake data directory of whoever ran it.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-settings-route-'));
process.env.NOLZU_DATA_DIR = dir;

const { actions, load } = await import('./+page.server.ts');
const { wallLine } = await import('$lib/engine-profiles.ts');
type Loaded = { section: string; agents: { slots: number }; knowledge: { review: boolean }; models: { rows: { action: string; own: { model?: string }; resolved: { engine: string }; models: readonly string[] }[]; profiles: readonly { id: string; label: string }[]; preset: string; saved: readonly string[]; chosen: string | null; changes: number }; profiles: { rows: { id: string; label: string }[] }; hub: string; engines: Promise<unknown> };
// The load of one section's page. Every field of another section is null there, which the load test
// below checks, so the type here names the fields as the section that owns them reads them.
const page = (section: string) => (load as unknown as (event: { params: { section: string } }) => Loaded)({ params: { section } });
const post = (body: Record<string, string>) => ({ request: new Request('http://localhost/settings', { method: 'POST', body: new URLSearchParams(body) }) });

let db = openDatabase(dir);
beforeAll(() => {
  db.close();
  db = openDatabase(dir);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Project, Phase instructions and Wall have their own routes, which win over this one, so this page
// never draws them.
const HERE = SECTIONS.map((section) => section.id).filter((id) => id !== 'project' && id !== 'phases' && id !== 'mcp' && id !== 'wall' && id !== 'integrations');

describe('the load', () => {
  it('returns the defaults on a fresh database, with a row per action and the models the engine lists', () => {
    expect(page('runs').agents.slots).toBe(3);
    const models = page('models').models;
    expect(models.rows.map((row) => row.action)).toEqual([...ACTIONS]);
    // The engine's own list, not a copy kept in the route, so a model it stops offering reads as gone.
    expect(models.rows[0]?.models).toEqual([...claudeModels()]);
    expect(models.profiles).toEqual([{ id: 'claude-code', label: 'Claude Code' }]);
    // No dial has started in this process, so the screen is told the connection is closed rather than
    // left to guess.
    expect(page('cloud').hub).toBe('closed');
  });

  // The Hub row names the host the link dials, and an override that is not an address still draws.
  it.each([
    ['wss://hub.example/', 'hub.example'],
    ['hub.example', 'hub.example/connect'],
  ])('names the hub host for the override %s', (override, host) => {
    const before = process.env.NOLZU_HUB_URL;
    process.env.NOLZU_HUB_URL = override;
    try {
      expect((page('cloud') as unknown as { link: { host: string } }).link.host).toBe(host);
    } finally {
      if (before === undefined) delete process.env.NOLZU_HUB_URL;
      else process.env.NOLZU_HUB_URL = before;
    }
  });

  // Each section is its own page, so a page reads its own section and nothing of the others: the
  // Runs page waits on no engine check and asks no hub.
  it.each(HERE)('reads only the %s section on its page', (id) => {
    const data = page(id) as unknown as Record<string, unknown>;
    const owner: Record<string, string> = { agents: 'runs', login: 'runs', knowledge: 'runs', models: 'models', engines: 'engines', profiles: 'engines', hub: 'cloud' };

    expect(data.section).toBe(id);
    for (const [field, section] of Object.entries(owner)) {
      if (section === id) expect(data[field]).not.toBeNull();
      else expect(data[field]).toBeNull();
    }
    // Null on Engines too where the wall cannot start, so it is checked against the probe.
    expect(data.wall).toBe(id === 'engines' ? wallLine(wallHere(), process.platform) : null);
  });

  it('answers 404 for a name that is no section', () => {
    expect(() => page('billing')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => page('toString')).toThrow(expect.objectContaining({ status: 404 }));
  });

  // A saved link to an old section lands where that section went.
  it.each([...MOVED])('sends the old /settings/%s on to %s', (id, home) => {
    expect(() => page(id)).toThrow(expect.objectContaining({ status: 308, location: home }));
  });
});

describe('the runs action', () => {
  // The section travels with the answer, because the screen prints the saved line under the section
  // the person wrote in.
  it('stores a value it takes, and names the section and the field it answers about', async () => {
    const answer = await actions.runs!(post({ field: 'slots', value: '5' }) as never);

    expect(answer).toMatchObject({ section: 'runs', field: 'slots', saved: true });
    expect(page('runs').agents.slots).toBe(5);
  });

  // An open board draws Quiet from the snapshot, so a saved quiet time reaches it at once.
  it('tells the board when the quiet time changes', async () => {
    const { loop } = await import('$lib/loop.ts');
    let told = 0;
    const leave = loop().onChange(() => (told += 1));

    const answer = await actions.runs!(post({ field: 'quiet', value: '8' }) as never);
    leave();

    expect(answer).toMatchObject({ section: 'runs', field: 'quiet', saved: true });
    expect(told).toBe(1);
    expect(loop().snapshot().quietAfterMs).toBe(8 * 60_000);
  });

  // The board column names the model each drop starts off its snapshot, so every write on Models and
  // Engines reaches an open board at once. A refused write changed nothing and tells nobody.
  it('tells the board when models, presets or profiles change', async () => {
    const { loop } = await import('$lib/loop.ts');
    let told = 0;
    const leave = loop().onChange(() => (told += 1));
    const writes = [
      () => actions.models!(post({ action: 'refine', field: 'effort', value: 'high' }) as never),
      () => actions.models!(post({ save: 'Told' }) as never),
      () => actions.models!(post({ apply: 'Told' }) as never),
      () => actions.models!(post({ remove: 'Told' }) as never),
      () => actions.models!(post({ preset: 'light' }) as never),
      () => actions.profiles!(post({ do: 'add', vendor: 'codex', label: 'Told', configDir: '/tmp/nolzu-settings-route-told' }) as never),
      () => actions.profiles!(post({ do: 'remove', id: 'codex#told' }) as never),
    ];
    const counts: number[] = [];
    for (const write of writes) {
      await write();
      counts.push(told);
    }
    await actions.models!(post({ action: 'plan', field: 'model', value: 'haiku-3' }) as never);
    await actions.profiles!(post({ do: 'add', vendor: 'claude-code', label: 'Personal', configDir: '' }) as never);
    leave();

    expect(counts).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(told).toBe(7);
    await actions.models!(post({ preset: 'default' }) as never);
    await actions.models!(post({ action: 'refine', reset: '1' }) as never);
  });

  // The refusal is the settings module's own sentence, and nothing is stored.
  it('answers 400 with the rule when the value is refused', async () => {
    const answer = (await actions.runs!(post({ field: 'slots', value: '0' }) as never)) as { status: number; data: { message: string; field: string } };

    expect(answer.status).toBe(400);
    expect(answer.data.message).toMatch(/whole number from 1 to 20/);
    expect(answer.data.field).toBe('slots');
    expect(page('runs').agents.slots).toBe(5);
  });

  // The scheduler took the slot count when it started. A saved one reaches it and the open boards at
  // once, so the busy meter beside the stepper counts against the number on screen.
  it('hands a saved slot count to the scheduler and the board', async () => {
    const { loop } = await import('$lib/loop.ts');
    let told = 0;
    const leave = loop().onChange(() => (told += 1));

    await actions.runs!(post({ field: 'slots', value: '4' }) as never);
    leave();

    expect(loop().scheduler.queue().slots).toBe(4);
    expect(loop().snapshot().slots).toEqual({ busy: 0, total: 4 });
    expect(told).toBeGreaterThan(0);
  });
});

describe('the models action', () => {
  it('stores a model for one action', async () => {
    const answer = await actions.models!(post({ action: 'plan', field: 'model', value: 'opus' }) as never);

    expect(answer).toMatchObject({ section: 'models', field: 'models', saved: true });
    expect(page('models').models.rows.find((row) => row.action === 'plan')?.own.model).toBe('opus');
  });

  // Through the route: the name is saved, the rows come back, and the remove says a different
  // word because it changed no row.
  it('saves the rows under a name, applies them again, and removes the name', async () => {
    await actions.models!(post({ action: 'plan', field: 'model', value: 'opus' }) as never);

    // Its own word: saving rows under a name changes no row, so the screen may not say that cards
    // use it on their next run.
    expect(await actions.models!(post({ save: 'Evenings' }) as never)).toMatchObject({ section: 'models', field: 'named', saved: true });
    expect(page('models').models.saved).toEqual(['Evenings']);

    // The new preset is the one in use, so a phase changed after it is one change, and Discard puts it back.
    await actions.models!(post({ action: 'plan', field: 'model', value: 'haiku' }) as never);
    expect(page('models').models).toMatchObject({ chosen: 'Evenings', changes: 1 });
    await actions.models!(post({ discard: '1' }) as never);
    expect(page('models').models.rows.find((row) => row.action === 'plan')?.own.model).toBe('opus');
    await actions.models!(post({ preset: 'light' }) as never);
    await actions.models!(post({ apply: 'Evenings' }) as never);
    expect(page('models').models.rows.find((row) => row.action === 'plan')?.own.model).toBe('opus');

    expect(await actions.models!(post({ remove: 'Evenings' }) as never)).toMatchObject({ section: 'models', field: 'removed', saved: true });
    expect(page('models').models.saved).toEqual([]);
  });

  // A name with brackets and a dash holds no slash, so the form action saves it as typed.
  it('saves a name with brackets and a dash, and refuses one with a slash', async () => {
    await actions.models!(post({ action: 'plan', field: 'model', value: 'opus' }) as never);

    const refused = (await actions.models!(post({ save: 'a/b' }) as never)) as { status: number; data: { field: string; message: string } };
    expect([refused.status, refused.data.field, refused.data.message]).toEqual([400, 'named', 'A preset name cannot hold a slash.']);

    expect(await actions.models!(post({ save: 'Cursor (custom-heavy)' }) as never)).toMatchObject({ section: 'models', field: 'named', saved: true });
    expect(page('models').models).toMatchObject({ saved: ['Cursor (custom-heavy)'], chosen: 'Cursor (custom-heavy)' });
    await actions.models!(post({ remove: 'Cursor (custom-heavy)' }) as never);
  });

  it('answers 400 and says why when a preset name is already taken', async () => {
    await actions.models!(post({ save: 'Evenings' }) as never);

    const answer = (await actions.models!(post({ save: 'Evenings' }) as never)) as { status: number; data: { field: string; message: string } };

    expect(answer.status).toBe(400);
    expect(answer.data.field).toBe('named');
    expect(answer.data.message).toMatch(/already a preset called Evenings/);
    await actions.models!(post({ remove: 'Evenings' }) as never);
  });

  // Edit on a saved card changes no row either, and a refused name goes to the edit form.
  it('renames a saved preset and saves the current setup into it, each with its own word', async () => {
    await actions.models!(post({ save: 'Evenings' }) as never);

    expect(await actions.models!(post({ rename: 'Evenings', name: 'Nights' }) as never)).toMatchObject({ section: 'models', field: 'renamed', saved: true });
    const taken = (await actions.models!(post({ rename: 'Nights', name: 'Heavy' }) as never)) as { status: number; data: { field: string; message: string } };
    expect([taken.status, taken.data.field, taken.data.message]).toEqual([400, 'renamed', 'There is already a preset called Heavy.']);
    expect(await actions.models!(post({ replace: 'Nights' }) as never)).toMatchObject({ section: 'models', field: 'replaced', saved: true });
    expect(page('models').models.saved).toEqual(['Nights']);
    await actions.models!(post({ remove: 'Nights' }) as never);
  });

  it('answers 400 and stores nothing when the model is gone', async () => {
    const answer = (await actions.models!(post({ action: 'plan', field: 'model', value: 'haiku-3' }) as never)) as { status: number; data: { message: string } };

    expect(answer.status).toBe(400);
    expect(answer.data.message).toMatch(/haiku-3 is gone\./);
    expect(page('models').models.rows.find((row) => row.action === 'plan')?.own.model).toBe('opus');
  });

  // The picker on Settings, Models: an engine with its model in one post, and Remove on an exception.
  it('stores a pick of engine and model together, and takes it back on reset', async () => {
    // From Balanced with nothing changed, whatever the tests above left.
    await actions.models!(post({ preset: 'default' }) as never);
    await actions.models!(post({ discard: '1' }) as never);
    expect(await actions.models!(post({ action: 'design', engine: 'claude-code', model: 'opus' }) as never)).toMatchObject({ section: 'models', field: 'models', saved: true });
    expect(page('models').models.rows.find((row) => row.action === 'design')?.own).toEqual({ engine: 'claude-code', model: 'opus', effort: 'medium' });

    expect(await actions.models!(post({ action: 'design', reset: '1' }) as never)).toMatchObject({ section: 'models', field: 'models', saved: true });
    expect(page('models').models.rows.find((row) => row.action === 'design')?.own).toEqual({});
  });

  it('moves every row that follows the preset when a preset is picked', async () => {
    await actions.models!(post({ preset: 'light' }) as never);

    expect(page('models').models.preset).toBe('light');
  });
});

describe('the rows on screen', () => {
  // The card tab names the engine of every row, and this is the same table one level up.
  it('carries the engine of every row, so the two screens say the same thing', () => {
    expect(page('models').models.rows.every((row) => row.resolved.engine !== '')).toBe(true);
    expect(page('models').models.rows[0]?.resolved.engine).toBe('claude-code');
  });
});

describe('a row another engine wrote', () => {
  // The one case where the screen must not repair anything by itself: the row is kept and marked.
  it('survives a save on another row', async () => {
    writeSetting(db, 'models', { implement: { engine: 'cursor', model: 'composer' } });

    await actions.models!(post({ action: 'refine', field: 'effort', value: 'high' }) as never);

    expect(page('models').models.rows.find((row) => row.action === 'implement')?.own).toEqual({ engine: 'cursor', model: 'composer' });
  });
});

describe('the profiles action', () => {
  // The word it answers with is what the screen prints, so add, rename and remove cannot share one line.
  it('adds a profile, renames it, and removes it again', async () => {
    const added = await actions.profiles!(post({ do: 'add', vendor: 'codex', label: 'Work', configDir: '/tmp/nolzu-settings-route-codex' }) as never);
    expect(added).toMatchObject({ section: 'engines', field: 'add', id: 'codex#work', saved: true });
    expect(page('engines').profiles.rows.map((row) => row.id)).toEqual(['claude-code', 'codex#work']);

    await actions.profiles!(post({ do: 'rename', id: 'codex#work', label: 'Day job' }) as never);
    expect(page('engines').profiles.rows.find((row) => row.id === 'codex#work')?.label).toBe('Day job');

    const removed = await actions.profiles!(post({ do: 'remove', id: 'codex#work' }) as never);
    expect(removed).toMatchObject({ section: 'engines', field: 'remove', saved: true });
    expect(page('engines').profiles.rows.map((row) => row.id)).toEqual(['claude-code']);
  });

  it('answers 400 with the rule when the list would be refused', async () => {
    const answer = (await actions.profiles!(post({ do: 'add', vendor: 'claude-code', label: 'Personal', configDir: '' }) as never)) as { status: number; data: { message: string; section: string } };

    expect(answer.status).toBe(400);
    expect(answer.data.section).toBe('engines');
    expect(answer.data.message).toContain('would share one login');
  });
});

describe('the login action', () => {
  // The one way a status command runs. The Engines load and its page draw start none.
  it('checks one profile on a post, and nothing on the load or the page', async () => {
    const { checkProfileLogin } = await import('$lib/engine-profiles.ts');
    vi.mocked(checkProfileLogin).mockClear();

    drawnAt('/settings/engines');
    const display: DisplayEntitlement = { id: 'a', plan: 'solo', features: [], seats: 1, expiresAt: 0 };
    render(Settings as never, { props: { data: { ...page('engines'), display }, form: null } } as never);
    expect(checkProfileLogin).not.toHaveBeenCalled();

    const answer = await actions.login!(post({ id: 'claude-code' }) as never);
    expect(checkProfileLogin).toHaveBeenCalledTimes(1);
    expect(answer).toMatchObject({ section: 'engines', field: 'login', check: { id: 'claude-code', state: 'in' } });
  });

  it('says on Engines that runs use your own setup', () => {
    drawnAt('/settings/engines');
    const display: DisplayEntitlement = { id: 'a', plan: 'solo', features: [], seats: 1, expiresAt: 0 };
    const { body } = render(Settings as never, { props: { data: { ...page('engines'), display }, form: null } } as never);
    expect(body).toContain('<p>Runs use your own npm, git and shell setup from where Nolzu started.</p>');
  });

  // Said once for the section, and not at all where the wall cannot start: each tool row says that.
  it('names the wall at the top of Engines only when it starts', () => {
    drawnAt('/settings/engines');
    const display: DisplayEntitlement = { id: 'a', plan: 'solo', features: [], seats: 1, expiresAt: 0 };
    const draw = (wall: string | null) => render(Settings as never, { props: { data: { ...page('engines'), wall, display }, form: null } } as never).body;
    const line = 'Every run is walled by macOS sandbox-exec: secret files such as ~/.ssh and .env stay hidden.';

    // The paragraphs of the Engines header: the setup line, and the wall line only when there is one.
    const head = (body: string) => body.match(/<header class="section-head[^>]*>([\s\S]*?)<\/header>/)?.[1]?.match(/<p[ >]/g)?.length;

    expect(draw(line)).toContain(`<p>${line}</p>`);
    expect(head(draw(line))).toBe(2);
    expect(head(draw(null))).toBe(1);
  });

  it('answers 400 with the reason when the profile cannot be checked', async () => {
    const { checkProfileLogin } = await import('$lib/engine-profiles.ts');
    vi.mocked(checkProfileLogin).mockResolvedValueOnce({ ok: false, message: 'There is no engine profile codex#gone on this machine.' });

    const answer = (await actions.login!(post({ id: 'codex#gone' }) as never)) as { status: number; data: { section: string; message: string } };

    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ section: 'engines', field: 'login', message: 'There is no engine profile codex#gone on this machine.' });
  });
});

// Connect again on Cloud: a manual redial, so no load may dial and a press dials once.
describe('the redial action', () => {
  it('dials on a press and never on a load', async () => {
    const { redialHub } = await import('$lib/hub-link.ts');
    vi.mocked(redialHub).mockClear();

    for (const id of HERE) page(id);
    expect(redialHub).not.toHaveBeenCalled();

    const answer = await (actions.redial as unknown as (event: unknown) => Promise<unknown>)(post({}));
    expect(answer).toEqual({ section: 'cloud', field: 'redial', dialled: true });
    expect(redialHub).toHaveBeenCalledTimes(1);
  });
});

describe('the knowledge action', () => {
  // The switch sits at the foot of Runs now, and writes the one setting it always wrote.
  it('turns the review toggle on, and the Runs load reads it back', async () => {
    const answer = await actions.knowledge!(post({ field: 'reviewKnowledge', value: 'on' }) as never);

    expect(answer).toMatchObject({ section: 'knowledge', field: 'reviewKnowledge', saved: true });
    expect(page('runs').knowledge.review).toBe(true);
    expect(getSetting(db, 'reviewKnowledge')).toBe(true);
  });
});

// The page itself, drawn, once per section. Until the `$app/forms` and `$app/paths` stubs landed nothing
// could import this file, so a section named in `SECTIONS` but never placed in the markup would have
// passed: the menu link came from the list and the panel from the component, and nothing checked that
// the page put the two together.
describe('the page', () => {
  const display = (...features: string[]): DisplayEntitlement => ({ id: 'a', plan: 'solo', features, seats: 1, expiresAt: 0 });

  const drawn = (section: string, ...features: string[]) => {
    // The screen these sections are drawn on. The server writes every address relative to it.
    drawnAt(`/settings/${section}`);
    // `cloud` is the layout's address of the web app, which the Account links are built on.
    return render(Settings as never, { props: { data: { ...page(section), display: display(...features), cloud: 'https://cloud.example' }, form: null } } as never);
  };

  // Read off the list itself, so a section added to `SECTIONS` and forgotten in the markup fails
  // here. What the list holds is spelled out by hand in settings-sections.test.ts.
  it.each(HERE)('draws the %s section on its own page and no other section there', (id) => {
    const { body, head } = drawn(id);

    expect(body).toContain(`id="${id}" aria-labelledby="${id}-title"`);
    for (const other of SECTIONS.filter((section) => section.id !== id)) expect(body).not.toContain(`aria-labelledby="${other.id}-title"`);
    expect(head).toContain(`<title>${settingsTitle(id)}</title>`);
  });

  // Knowledge's one switch, at the foot of Runs under its own heading, still posting the same field to
  // the same action, so it writes the setting it wrote in its old section.
  it('draws the Knowledge switch at the bottom of Runs, posting the same setting', () => {
    const { body } = drawn('runs');
    const knowledge = body.slice(body.indexOf('id="knowledge"'));

    expect(body).toContain('id="knowledge" aria-labelledby="knowledge-title"');
    expect(body).toContain('id="startAtLogin"');
    expect(body.indexOf('id="knowledge"')).toBeGreaterThan(body.indexOf('id="startAtLogin"'));
    expect(knowledge).toMatch(/<form method="POST" action="\?\/knowledge"[^>]*>\s*<input type="hidden" name="field" value="reviewKnowledge"/);
    expect(knowledge).toContain('id="reviewKnowledge" name="value" type="checkbox"');
    // Nothing of Runs comes after it.
    expect(knowledge).not.toContain('action="?/runs"');
  });

  // Runs: the rows in their set order, with the Knowledge switch last.
  it('draws the Runs rows in their set order', () => {
    const text = drawn('runs').body.replace(/<[^>]+>/g, '');
    const labels = ['Agent slots', 'Run timeout', 'Retry on API errors', 'Call a run quiet', 'Keep the machine awake while a run is going', 'Start Nolzu when I log in', 'Review knowledge changes before they apply'];
    const at = labels.map((label) => text.indexOf(label));

    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  // Runs: three minute boxes, each its own form writing its place in the wait list, while the
  // switch is on.
  it('draws the three retry boxes with the stored waits and the switch on', () => {
    const body = drawn('runs').body;

    expect(body).toMatch(/<input id="retry" name="value" type="checkbox" role="switch" value="default"[^>]*checked/);
    for (const [at, label, wait] of [
      [1, 'First retry, minutes', 2],
      [2, 'Second retry, minutes', 5],
      [3, 'Third retry, minutes', 15],
    ]) {
      expect(body).toMatch(new RegExp(`<input type="hidden" name="field" value="wait${at}"[^>]*/?>\\s*<label[^>]*for="wait${at}"[^>]*>${label}</label>\\s*<input id="wait${at}" name="value"[^>]*value="${wait}"`));
    }
    expect(body).toContain('Each retry resumes the same session. After the third, the card fails with the raw error.');
  });

  it('prints a refused retry box under the row, keeping the typed value', () => {
    drawnAt('/settings/runs');
    const form = { section: 'runs', field: 'wait2', typed: '0', message: 'The second retry is a whole number of minutes, one or more.' };
    const body = render(Settings as never, { props: { data: { ...page('runs'), display: display() }, form } } as never).body;

    expect(body).toMatch(/<input id="wait2" name="value"[^>]*value="0"/);
    expect(body).toContain('role="alert">The second retry is a whole number of minutes, one or more.</p>');
  });

  it('saves a retry box through the runs action', async () => {
    expect(await actions.runs!(post({ field: 'wait1', value: '3' }) as never)).toMatchObject({ section: 'runs', field: 'wait1', saved: true });
    expect(getSetting(db, 'retryWaitsMs')).toEqual([180_000, 300_000, 900_000]);
    await actions.runs!(post({ field: 'wait1', value: '2' }) as never);
  });

  it('says what the run timeout and keep awake do, in short lines', () => {
    const text = drawn('runs').body.replace(/<[^>]+>/g, '');

    expect(text).toContain('A run that prints nothing this long stops, and its card fails.');
    expect(text).toContain('The screen can still turn off.');
  });

  // The systems that can hold the machine awake are named only where this one cannot.
  it('names the systems keep awake works on only where this one has no tool for it', () => {
    drawnAt('/settings/runs');
    const withAwake = (awake: boolean) => render(Settings as never, { props: { data: { ...page('runs'), awake, display: display() }, form: null } } as never).body;

    expect(withAwake(true)).not.toContain('systemd-inhibit');
    expect(withAwake(false)).toContain('This system has no tool to keep it awake. Keep awake works on macOS, and on Linux with systemd-inhibit.');
  });

  // The load looks for the tool on PATH and starts nothing. macOS always has one, Linux needs systemd-inhibit.
  it('loads whether a tool here can hold the machine awake, and nothing outside Runs', () => {
    expect(page('cloud') as { awake?: unknown }).toMatchObject({ awake: null });
    if (process.platform === 'darwin') return expect(page('runs') as { awake?: unknown }).toMatchObject({ awake: true });
    if (process.platform !== 'linux') return;
    const was = process.env.PATH;
    const bin = join(dir, 'awake-bin');
    mkdirSync(bin, { recursive: true });
    try {
      process.env.PATH = bin;
      expect(page('runs') as { awake?: unknown }).toMatchObject({ awake: false });
      writeFileSync(join(bin, 'systemd-inhibit'), '#!/bin/sh\n', { mode: 0o755 });
      expect(page('runs') as { awake?: unknown }).toMatchObject({ awake: true });
    } finally {
      process.env.PATH = was;
    }
  });

  it('draws the retry switch off with no waits and says what off does', () => {
    drawnAt('/settings/runs');
    const loaded = page('runs');
    const body = render(Settings as never, { props: { data: { ...loaded, agents: { ...loaded.agents, waits: [] }, display: display() }, form: null } } as never).body;

    expect(body).toMatch(/<input id="retry" name="value" type="checkbox" role="switch" value="default"(?![^>]*checked)/);
    expect(body).toContain('Off, the first API error fails the card.');
  });

  // The stepper stops where the settings module refuses, so no press there asks for a refusal.
  it.each([
    [1, 'One slot fewer'],
    [20, 'One slot more'],
  ])('turns the stepper button off at %i slots', (slots, off) => {
    drawnAt('/settings/runs');
    const loaded = page('runs');
    const body = render(Settings as never, { props: { data: { ...loaded, agents: { ...loaded.agents, slots }, display: display() }, form: null } } as never).body;
    const button = (label: string) => new RegExp(`<button[^>]*disabled[^>]*aria-label="${label}"`);

    expect(body).toMatch(button(off));
    expect(body).not.toMatch(button(off === 'One slot more' ? 'One slot fewer' : 'One slot more'));
  });

  // What goes to a hub is one box on Cloud.
  it('hands the hub box on Cloud the plan the display document says', () => {
    const { body } = drawn('cloud', 'cloud-board');

    // The list of what a hub is sent, which is what the section draws for a plan that has the board.
    expect(body).toContain('data-sends="card.state"');
    expect(body).not.toContain('data-free="data"');
  });

  it('draws the hub box on Cloud for a plan with no cloud board as one line, the never list folded', () => {
    const { body } = drawn('cloud');

    expect(body).toContain('id="data"');
    expect(body).toMatch(/data-free="data"[^>]*>No hub: nothing is sent\.</);
    expect(body).toMatch(/<details[^>]*>\s*<summary[^>]*>[\s\S]*Never sent[\s\S]*data-never="Code"[\s\S]*<\/details>/);
    expect(body).not.toContain('data-sends=');
    // The promise the section carries on every plan, so a free plan is not left with a bare panel.
    expect(body).toContain('data-never="Code"');
  });

  // Free sees what an account adds and the login to copy, and Solo sees none of
  // it. Solo and Team are not on sale yet, so the list says Coming soon, and History and Reports wait
  // with Evidence.
  it('draws the Coming soon with Solo and Team list on Free only', () => {
    const free = drawn('cloud').body;
    const solo = drawn('cloud', 'cloud-board').body;

    expect(free).toContain('data-free="cloud"');
    expect(free).toContain('Coming soon with Solo and Team');
    for (const line of ['The phone', 'Team']) expect(free).toContain(`>${line}</b>`);
    // Free holds every project, so more projects is no paid line.
    for (const line of ['More projects', 'History', 'Reports']) expect(free).not.toContain(`>${line}</b>`);
    expect(free.match(/<ul class="adds[^"]*">([\s\S]*?)<\/ul>/)?.[1]?.match(/<li/g)).toHaveLength(2);
    expect(free).toMatch(/<code[^>]*>npx nolzu@latest login<\/code>/);
    expect(free).toContain('Free needs none of this.');
    expect(free).toContain('This machine sends nothing to Nolzu cloud.');
    // Cloud: the plan heading row first, no intro, then the list beside the sign-in box.
    expect(free).toMatch(/<h3[^>]*>Free<\/h3>\s*<span class="hint[^"]*">no account on this machine<\/span>/);
    expect(free).not.toContain('The link to Nolzu cloud, as this page loaded.');
    expect(free).toMatch(/<div class="two[^"]*">\s*<div class="block[^"]*" data-free="cloud">/);

    expect(solo).not.toContain('data-free="cloud"');
    expect(solo).not.toContain('Coming soon with Solo and Team');
    expect(solo).not.toContain('npx nolzu@latest login</code>');
  });

  it('draws the Solo panel with the plan, the hub, this machine, the last sync and the sign out', () => {
    const solo = drawn('cloud', 'cloud-board').body;

    for (const label of ['Plan', 'Hub', 'This machine', 'Last sync']) expect(solo).toContain(`>${label}</dt>`);
    expect(solo).toContain('>Solo</dd>');
    // No frame has gone out in this suite, so the row says so and invents no time.
    expect(solo).toContain('Nothing sent since Nolzu started');
    expect(solo).toMatch(/<code[^>]*>npx nolzu@latest logout<\/code>/);
    // The send lists are on this page now, so no link leads away to them.
    expect(solo).not.toContain('/settings/data');
    expect(solo).toContain('id="data"');
    // No dial has started in this process, so the link is closed, and on a paid plan that is Offline
    // with Connect again.
    expect(solo).toContain('Offline');
    expect(solo).toMatch(/action="\?\/redial"/);
    expect(drawn('cloud').body).not.toMatch(/action="\?\/redial"/);
  });

  // Last sync is the clock time of the last frame, in mono, as the page loaded it.
  it('draws the time a frame last went out as a clock time', () => {
    drawnAt('/settings/cloud');
    const loaded = page('cloud') as unknown as { link: { host: string; machine: string; lastSent: number | null } };
    const at = new Date(2026, 9, 15, 14, 32, 8).getTime();
    const body = render(Settings as never, { props: { data: { ...loaded, link: { ...loaded.link, lastSent: at }, display: display('cloud-board'), cloud: 'https://cloud.example' }, form: null } } as never).body;

    expect(body).toMatch(/<span class="mono[^"]*">14:32:08<\/span>/);
    expect(body).not.toContain('Nothing sent since Nolzu started');
  });

  it('says a press changed nothing when the link was dialling already or no longer Offline', () => {
    drawnAt('/settings/cloud');
    const body = render(Settings as never, { props: { data: { ...page('cloud'), display: display('cloud-board'), cloud: 'https://cloud.example' }, form: { section: 'cloud', field: 'redial', dialled: false } } } as never).body;

    expect(body).toContain('Nolzu was dialling already, or the link was no longer Offline, so Connect again changed nothing.');
  });

  it('says nothing goes to a team hub from a project that has not joined a team', () => {
    expect((page('cloud') as unknown as { team: boolean }).team).toBe(false);
    expect(drawn('cloud', 'cloud-board').body).toContain('Nothing today. This project is not a team project.');
  });

  // The board reads the quiet time, so saving it says the open boards have it, not the next run.
  it.each([
    ['quiet', 'Saved. Open boards use it now.'],
    ['timeout', 'Saved. The next run uses it.'],
  ])('says who uses a saved %s value on Runs', (field, line) => {
    drawnAt('/settings/runs');
    const { body } = render(Settings as never, { props: { data: { ...page('runs'), display: display() }, form: { section: 'runs', field, saved: true } } } as never);

    expect(body).toContain(`role="status">${line}</p>`);
  });

  // Start Nolzu when I log in shows what is on disk. Under the test runner no nolzu command started the
  // server, so the load offers no On; the drawn rows below hand the switch its state.
  it('draws Start Nolzu when I log in off, and names the file On writes', () => {
    drawnAt('/settings/runs');
    expect((page('runs') as unknown as { login: unknown }).login).toMatchObject({ on: false, canTurnOn: false });
    const drawnWith = (login: unknown) => render(Settings as never, { props: { data: { ...page('runs'), login, display: display() }, form: null } } as never).body;

    const off = drawnWith({ on: false, canTurnOn: true, path: '~/.config/systemd/user/nolzu.service' });
    expect(off).toMatch(/<input id="startAtLogin" type="checkbox" role="switch"(?![^>]*checked)(?![^>]*disabled)/);
    expect(off).toMatch(/<span class="hint[^"]*">Never turned on by itself\.<\/span>/);

    expect(drawnWith({ on: true, canTurnOn: true, path: '~/x' })).toMatch(/<input id="startAtLogin"[^>]*checked/);
    expect(drawnWith({ on: true, canTurnOn: true, path: '~/x' })).toMatch(/Nolzu starts when you log in\. Off removes <code[^>]*>~\/x<\/code>\./);
    expect(drawnWith({ on: false, canTurnOn: false, path: '~/x' })).toMatch(/<input id="startAtLogin"[^>]*disabled[^]*Works only for a Nolzu the <code[^>]*>nolzu<\/code> command started\./);
    // An item a person wants gone can always be turned off.
    expect(drawnWith({ on: true, canTurnOn: false, path: '~/x' })).not.toMatch(/<input id="startAtLogin"[^>]*disabled/);
  });

  // The engine and preset table with the stored `default` named Balanced, and every phase named whole
  // in its picker, where the old select cut "inherit (first profile: C" at 1440.
  it('draws the engine and preset table with Balanced as the stored default, and every step whole', async () => {
    await actions.models!(post({ preset: 'default' }) as never);
    // Without Svelte's markers between the tags, so the test reads the markup a person gets.
    const body = drawn('models').body.replace(/<!--[^]*?-->/g, '');

    expect(body).toMatch(/value="default"[^>]*aria-checked="true" aria-label="Balanced on Claude Code, Implement runs [^"]+"/);
    expect(body).toMatch(/>Balanced<\/span> <span class="pill[^"]*">In use<\/span>/);
    expect(body).toMatch(/aria-label="Plan engine"[^]*?<option value="claude-code" selected[^]*?aria-label="Plan model"[^]*?<option value="[\w.-]+" selected[^]*?aria-label="Plan effort"[^]*?<option value="(low|medium|high)" selected/);
    expect(body).not.toContain('inherit (');
    await actions.models!(post({ preset: 'light' }) as never);
    expect(drawn('models').body).toMatch(/value="light"[^>]*aria-checked="true"/);
  });

  it('draws a saved preset as a line of Your presets, under the table', async () => {
    expect(drawn('models').body).not.toContain('data-preset="Evenings"');
    await actions.models!(post({ save: 'Evenings' }) as never);

    const { body } = drawn('models');
    expect(body.indexOf('data-preset="Evenings"')).toBeGreaterThan(body.indexOf('>Your presets<'));
    expect(body.indexOf('>Your presets<')).toBeGreaterThan(body.lastIndexOf('data-engine='));
    expect(body).toMatch(/name="apply" value="Evenings" class="[^"]*cell[^"]*" role="radio"/);
    await actions.models!(post({ remove: 'Evenings' }) as never);
  });
});
