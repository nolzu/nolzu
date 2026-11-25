import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { missingProfileText } from '@nolzu/protocol';
import { cursorFailure } from '@nolzu/runner';
import { SettingsTab } from '@nolzu/ui';
import { createCard, getSetting, openDatabase, setCardModels } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import EngineProfiles from './EngineProfiles.svelte';
import { checkProfileLogin, engineTools, phasesLine, profilesFor, saveProfile, wallLine } from './engine-profiles.ts';
import { settingsFor } from './card-models.ts';

// What each vendor offers, which is what `resolveModels` measures a row against. Codex has no list
// here, so the Codex rows below are never called gone.
const OFFERS = { 'claude-code': ['haiku', 'sonnet', 'opus'] };
// Two folders of this test's own. The real second Cursor login on this machine is not touched and
// is not named here.
const WORK = '/tmp/nolzu-test-codex-work';
const SIDE = '/tmp/nolzu-test-codex-side';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-engine-profiles-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const post = (body: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) form.set(name, value);
  return saveProfile(db, form);
};
const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const shown = () => text(render(EngineProfiles, { props: { profiles: profilesFor(db) } }).body);
const ids = () => getSetting(db, 'engineProfiles').map((one) => one.id);

describe('the profiles a fresh installation has', () => {
  it('lists the one Claude Code profile, and says the variable it does not set for it', () => {
    const section = profilesFor(db);

    expect(section.rows.map((row) => row.id)).toEqual(['claude-code']);
    expect(section.rows[0]).toMatchObject({ label: 'Claude Code', vendorLabel: 'Claude Code', configDir: null });
    expect(section.rows[0]?.where).toContain('sets no CLAUDE_CONFIG_DIR');
  });

  it('offers all three vendors', () => {
    expect(profilesFor(db).vendors.map((one) => one.vendor)).toEqual(['claude-code', 'cursor', 'codex']);
  });

  it('says under the folder field which variable is set and where the login is made', () => {
    const vendors = profilesFor(db).vendors;

    const codex = vendors.find((one) => one.vendor === 'codex')?.hint ?? '';
    expect(codex).toContain('CODEX_HOME');
    expect(codex).toContain('Run the login of Codex there');
    expect(codex).toContain('Leave it empty');
    // Claude Code already holds its own default place, so an empty folder there would be refused.
    expect(vendors.find((one) => one.vendor === 'claude-code')?.hint).toContain('is taken by another profile');
    expect(vendors.find((one) => one.vendor === 'claude-code')?.hint).not.toContain('Leave it empty');
  });
});

describe('adding a profile', () => {
  it('takes a second login of one vendor and names the variable and the folder', () => {
    expect(post({ do: 'add', vendor: 'codex', label: 'Work', configDir: WORK })).toEqual({ ok: true, did: 'add', id: 'codex#work', message: null });

    const row = profilesFor(db).rows.find((one) => one.id === 'codex#work');
    expect(row).toMatchObject({ label: 'Work', vendorLabel: 'Codex', configDir: WORK });
    expect(row?.where).toContain('CODEX_HOME');
    expect(row?.where).toContain(WORK);
  });

  it('refuses a second profile of one vendor with no folder, and stores nothing', () => {
    const answer = post({ do: 'add', vendor: 'claude-code', label: 'Personal', configDir: '' });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('would share one login');
    expect(ids()).toEqual(['claude-code']);
  });

  it('answers with the id it made, so the screen can name it', () => {
    expect(post({ do: 'add', vendor: 'codex', label: 'Work', configDir: WORK }).id).toBe('codex#work');
  });

  it('gives two profiles labelled alike two ids, because one id is one login', () => {
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: WORK });
    expect(post({ do: 'add', vendor: 'codex', label: 'Work', configDir: SIDE }).id).toBe('codex#work-2');

    expect(ids()).toEqual(['claude-code', 'codex#work', 'codex#work-2']);
  });

  it('takes the spaces off a pasted folder, which would not pass as a full path', () => {
    expect(post({ do: 'add', vendor: 'codex', label: 'Work', configDir: `  ${WORK} ` }).ok).toBe(true);

    expect(profilesFor(db).rows.find((one) => one.id === 'codex#work')?.configDir).toBe(WORK);
  });

  it('refuses a second profile of one vendor on the same folder, and stores nothing', () => {
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: WORK });

    const answer = post({ do: 'add', vendor: 'codex', label: 'Side', configDir: WORK });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('would share one login');
    expect(ids()).toEqual(['claude-code', 'codex#work']);
  });

  it('refuses a folder written with a tilde, and says why it is not a path', () => {
    const answer = post({ do: 'add', vendor: 'codex', label: 'Work', configDir: '~/.codex-work' });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('not expanded');
    expect(ids()).toEqual(['claude-code']);
  });

  it('refuses a label of nothing, because a list of profiles with no names cannot be read', () => {
    expect(post({ do: 'add', vendor: 'codex', label: '  ', configDir: WORK }).message).toContain('needs a label');
    expect(ids()).toEqual(['claude-code']);
  });

  it('refuses a vendor this version does not know', () => {
    expect(post({ do: 'add', vendor: 'copilot', label: 'Work', configDir: WORK }).message).toContain('copilot');
    expect(ids()).toEqual(['claude-code']);
  });
});

describe('a rename', () => {
  beforeEach(() => {
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: WORK });
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'plan', title: 'Add a search box' });
    setCardModels(db, 'APP-1', { plan: { engine: 'codex#work', model: 'opus' } });
  });

  it('changes the label, and the card that chose the profile still resolves to it', () => {
    expect(post({ do: 'rename', id: 'codex#work', label: 'Day job' })).toEqual({ ok: true, did: 'rename', id: null, message: null });

    expect(profilesFor(db).rows.find((one) => one.id === 'codex#work')?.label).toBe('Day job');
    const plan = settingsFor(db, 'APP-1', OFFERS)?.rows.find((row) => row.action === 'plan');
    expect(plan?.resolved).toMatchObject({ engine: 'codex#work', model: 'opus', missingProfile: false });
  });

  it('changes nothing but the label', () => {
    post({ do: 'rename', id: 'codex#work', label: 'Day job' });

    expect(getSetting(db, 'engineProfiles')).toEqual([
      { id: 'claude-code', label: 'Claude Code', vendor: 'claude-code', configDir: null },
      { id: 'codex#work', label: 'Day job', vendor: 'codex', configDir: WORK },
    ]);
  });

  it('refuses a label of nothing and an id this machine does not hold', () => {
    expect(post({ do: 'rename', id: 'codex#work', label: '' }).message).toContain('needs a label');
    expect(post({ do: 'rename', id: 'codex#gone', label: 'Day job' }).message).toContain('codex#gone');
    expect(profilesFor(db).rows.find((one) => one.id === 'codex#work')?.label).toBe('Work');
  });
});

describe('removing a profile a card points at', () => {
  beforeEach(() => {
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: WORK });
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'plan', title: 'Add a search box' });
    setCardModels(db, 'APP-1', { plan: { engine: 'codex#work', model: 'opus' } });
  });

  // A person who lost a login has to be able to clear it, so the removal goes through and the card
  // says what happened to it.
  it('goes through, and the card then says the profile has no login on this machine', () => {
    expect(post({ do: 'remove', id: 'codex#work' })).toEqual({ ok: true, did: 'remove', id: null, message: null });

    const settings = settingsFor(db, 'APP-1', OFFERS)!;
    expect(settings.rows.find((row) => row.action === 'plan')?.resolved.missingProfile).toBe(true);
    expect(text(render(SettingsTab, { props: { settings } }).body)).toContain(missingProfileText('codex#work'));
  });

  it('keeps what the card stored, so the profile can come back', () => {
    post({ do: 'remove', id: 'codex#work' });

    expect(settingsFor(db, 'APP-1', OFFERS)?.rows.find((row) => row.action === 'plan')?.own).toEqual({ engine: 'codex#work', model: 'opus' });
  });

  // The id is what a card stores, so a label used again makes the id used again and the card runs
  // on the new login. The add answer names the id, because that is the only warning of it.
  it('gives a removed label its id back, and the card then runs on the new folder', () => {
    post({ do: 'remove', id: 'codex#work' });

    const again = post({ do: 'add', vendor: 'codex', label: 'Work', configDir: SIDE });

    expect(again.id).toBe('codex#work');
    expect(profilesFor(db).rows.find((one) => one.id === 'codex#work')?.configDir).toBe(SIDE);
    const plan = settingsFor(db, 'APP-1', OFFERS)?.rows.find((row) => row.action === 'plan');
    expect(plan?.resolved).toMatchObject({ engine: 'codex#work', missingProfile: false });
  });

  it('refuses the last profile, because every action falls back to one', () => {
    post({ do: 'remove', id: 'codex#work' });

    const answer = post({ do: 'remove', id: 'claude-code' });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('at least one engine profile');
    expect(ids()).toEqual(['claude-code']);
  });

  it('refuses an id this machine does not hold, and refuses a word it has no action for', () => {
    expect(post({ do: 'remove', id: 'codex#gone' }).message).toContain('codex#gone');
    expect(post({ do: 'archive', id: 'codex#work' }).message).toContain('archive');
    expect(ids()).toEqual(['claude-code', 'codex#work']);
  });
});

describe('the screen', () => {
  it('shows the one profile and offers a second, when nothing else is there', () => {
    const body = shown();

    expect(body).toContain('Claude Code');
    expect(body).toContain('claude-code');
    expect(body).toContain('Add a profile');
  });

  it('shows two profiles of one vendor apart, by label, id and folder', () => {
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: WORK });
    post({ do: 'add', vendor: 'codex', label: 'Side', configDir: SIDE });

    const body = shown();

    expect(body).toContain('codex#work');
    expect(body).toContain('codex#side');
    expect(body).toContain(WORK);
    expect(body).toContain(SIDE);
  });

  it('says of a profile with no folder that the vendor reads its own default place', () => {
    // The row's own sentence, not the screen's text, so the hint under the add form cannot stand in
    // for it: the two say different things about an empty folder.
    expect(profilesFor(db).rows[0]?.where).toContain('sets no CLAUDE_CONFIG_DIR');
    expect(profilesFor(db).rows[0]?.where).toContain('the default place');
    expect(shown()).toContain('sets no CLAUDE_CONFIG_DIR');
  });

});

describe('the words it takes', () => {
  it('refuses a word it has no action for', () => {
    expect(post({ do: 'sign' })).toMatchObject({ ok: false });
    expect(post({ do: 'sign' }).message).toBe('There is no sign to do to an engine profile. The screen adds, renames and removes one.');
  });
});

/**
 * Antigravity was an engine before 0.1.0 and is not one now: Google's terms do not allow third-party
 * apps on its consumer plans. A machine that used it still stores its profile and rows that point at
 * it. They read the way a removed profile reads, so nothing crashes and nothing new is needed.
 */
describe('a stored Antigravity profile from before 0.1.0', () => {
  beforeEach(() => {
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: WORK });
    const stored = [...getSetting(db, 'engineProfiles'), { id: 'antigravity', label: 'Antigravity', vendor: 'antigravity', configDir: null }];
    // Written past the validator, as an older build stored it.
    db.prepare('INSERT OR REPLACE INTO machine.settings (key, value) VALUES (?, ?)').run('engineProfiles', JSON.stringify(stored));
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'plan', title: 'Add a search box' });
    setCardModels(db, 'APP-1', { plan: { engine: 'antigravity', model: 'gemini-3.1-pro-high' } });
  });

  it('keeps every other login, and the Engines screen shows no row for it', () => {
    expect((db.prepare('SELECT value FROM machine.settings WHERE key = ?').get('engineProfiles') as { value: string }).value).toContain('"antigravity"');
    expect(ids()).toEqual(['claude-code', 'codex#work']);
    expect(profilesFor(db).rows.map((row) => row.id)).toEqual(['claude-code', 'codex#work']);
    expect(shown()).not.toContain('Antigravity');
  });

  it('leaves a phase set to it the way a removed profile leaves it', () => {
    const settings = settingsFor(db, 'APP-1', OFFERS)!;
    expect(settings.rows.find((row) => row.action === 'plan')?.resolved).toMatchObject({ engine: 'antigravity', missingProfile: true });
    expect(text(render(SettingsTab, { props: { settings } }).body)).toContain(missingProfileText('antigravity'));
  });

  it('writes the list back without it on the next change', () => {
    post({ do: 'rename', id: 'codex#work', label: 'Day job' });

    expect(JSON.parse((db.prepare('SELECT value FROM machine.settings WHERE key = ?').get('engineProfiles') as { value: string }).value)).toEqual([
      { id: 'claude-code', label: 'Claude Code', vendor: 'claude-code', configDir: null },
      { id: 'codex#work', label: 'Day job', vendor: 'codex', configDir: WORK },
    ]);
  });
});

describe('a stored list a hand edit broke', () => {
  // The read path falls back to the default list, so the screen draws rather than failing.
  it('draws the default list instead of nothing', () => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('engineProfiles', '[]');

    expect(profilesFor(db).rows.map((row) => row.id)).toEqual(['claude-code']);
  });
});

/**
 * What a free Cursor plan can do here, said on the row.
 *
 * A free plan runs the Auto model and nothing else, and Nolzu always asks for a model by name, so
 * such a login cannot run a card. Nothing reports the plan, so the sentence is one that holds
 * whatever the person pays, and it is on the row rather than on a screen of its own.
 */
describe('what a free plan can do', () => {
  it('says it on a Cursor row, with the reason a card cannot run', () => {
    post({ do: 'add', vendor: 'cursor', label: 'Mine', configDir: '' });

    const said = profilesFor(db).rows.find((row) => row.vendor === 'cursor')?.plan ?? '';
    expect(said).toContain('free Cursor plan');
    expect(said).toContain('Auto');
    expect(said).toContain('cannot run on a free login');
    // The same two ways out a card that already failed this way is given, so the screen before the
    // run and the card after it do not send a person to different places.
    const failed = cursorFailure('ActionRequiredError: Named models unavailable') ?? '';
    for (const way of ['Upgrade the plan', 'another engine']) {
      expect(failed).toContain(way);
      expect(said).toContain(way);
    }
  });

  // The person reads the screen and not the section shape, so the sentence has to reach the page.
  it('draws the sentence on the screen', () => {
    post({ do: 'add', vendor: 'cursor', label: 'Mine', configDir: '' });

    expect(shown()).toContain('Nolzu always asks for a model by name and never for Auto');
  });

  // The other three vendors have no such plan, so a line about one would be a sentence nobody can
  // act on. The screen is checked too: an empty paragraph renders as nothing a reader sees, so the
  // row shape alone would not catch a component that drew it for everybody.
  it.each(['claude-code', 'codex'])('says nothing about a plan on a %s row', (vendor) => {
    post({ do: 'add', vendor, label: 'Mine', configDir: '/tmp/nolzu-test-plan' });

    expect(profilesFor(db).rows.find((row) => row.vendor === vendor)?.plan).toBeNull();
    expect(render(EngineProfiles, { props: { profiles: profilesFor(db) } }).body).not.toContain('data-plan');
  });
});

// A folder of stand-in tools, each a shell script with a recorded answer. Nothing else is on its PATH,
// so no test reaches the real claude, codex or cursor-agent.
function toolsFolder(scripts: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), 'nolzu-engine-tools-'));
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(folder, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(folder, name), 0o755);
  }
  return folder;
}

const asked = (id: string) => {
  const form = new FormData();
  form.set('id', id);
  return form;
};

describe('Check login', () => {
  let tools = '';
  afterEach(() => rmSync(tools, { recursive: true, force: true }));

  // The stand-in prints the folder it was handed and the words it was asked, then answers as Codex
  // does: its line on stderr and 0 for a login.
  it("runs the tool's status command with the profile's own folder", async () => {
    tools = toolsFolder({ codex: 'echo "home=$CODEX_HOME asked=$*"\necho "Logged in using ChatGPT" >&2' });
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: WORK });

    const reply = await checkProfileLogin(db, asked('codex#work'), { PATH: tools }, () => 42);

    expect(reply).toEqual({ ok: true, check: { id: 'codex#work', state: 'in', said: `home=${WORK} asked=login status\nLogged in using ChatGPT`, at: 42 } });
  });

  it('says a folder with no login is signed out', async () => {
    tools = toolsFolder({ codex: 'echo "Not logged in" >&2\nexit 1' });
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: WORK });

    const reply = await checkProfileLogin(db, asked('codex#work'), { PATH: tools });

    expect(reply.ok && reply.check.state).toBe('out');
  });

  it('says a tool that is not on the PATH is not installed', async () => {
    tools = toolsFolder({});

    const reply = await checkProfileLogin(db, asked('claude-code'), { PATH: tools });

    expect(reply.ok && reply.check).toMatchObject({ state: 'missing', said: null });
  });

  it('refuses a profile that is not there', async () => {
    tools = toolsFolder({});

    expect(await checkProfileLogin(db, asked('codex#gone'), { PATH: tools })).toEqual({ ok: false, message: 'There is no engine profile codex#gone on this machine.' });
  });
});

describe('the rows the Engines section draws', () => {
  it('names the folder with ~, the variable, the status command and the sign-in line', () => {
    post({ do: 'add', vendor: 'codex', label: 'Work', configDir: '/home/you/.codex-work' });

    const row = profilesFor(db, '/home/you').rows.find((one) => one.id === 'codex#work');

    expect(row).toMatchObject({ folder: '~/.codex-work', variable: 'CODEX_HOME', status: 'codex login status', signIn: 'CODEX_HOME=/home/you/.codex-work codex login' });
  });

  it('gives the bare sign-in command for the default place', () => {
    const rows = profilesFor(db, '/home/you').rows;

    expect(rows.find((one) => one.id === 'claude-code')).toMatchObject({ folder: null, signIn: 'claude auth login', status: 'claude auth status --text' });
  });

  it('hands the add form the variable and the sign-in command of each vendor', () => {
    const vendors = profilesFor(db).vendors;

    expect(vendors.find((one) => one.vendor === 'cursor')).toMatchObject({ variable: 'CURSOR_CONFIG_DIR', login: 'cursor-agent login' });
  });
});

describe('the look at the tools', () => {
  let tools = '';
  afterEach(() => rmSync(tools, { recursive: true, force: true }));

  it('gives each tool its version and place, and the install line of one that is missing', async () => {
    tools = toolsFolder({ claude: 'echo "2.1.296 (Claude Code)"' });

    const rows = await engineTools({ PATH: tools }, tools);

    expect(rows.map((row) => [row.engine, row.found])).toEqual([
      ['claude-code', true],
      ['cursor', false],
      ['codex', false],
    ]);
    expect(rows[0]).toMatchObject({ label: 'Claude Code', version: '2.1.296', path: '~/claude' });
    expect(rows.find((row) => row.engine === 'codex')).toMatchObject({ path: null, command: 'npm install -g @openai/codex' });
    // Cursor installs with its own script, so the row links its page.
    expect(rows.find((row) => row.engine === 'cursor')).toMatchObject({ command: null, install: 'https://cursor.com/cli' });
  });
});

// Settings, Engines says per engine which phases this machine can run and why, from the same rule the
// job builder refuses with and the wall the probe found.
describe('phasesLine', () => {
  const MISSING = { ready: false, reason: 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.' } as const;

  // The same sentence on every row told nothing, so the section says the wall once (`wallLine`).
  it('says nothing for an engine that runs every phase where the wall starts', () => {
    for (const vendor of ['claude-code', 'cursor', 'codex'] as const) {
      expect(phasesLine(vendor, { ready: true }, 'darwin')).toBeNull();
      expect(phasesLine(vendor, { ready: true }, 'linux')).toBeNull();
    }
  });

  it('names the wall once for the section, and only where it starts', () => {
    expect(wallLine({ ready: true }, 'darwin')).toBe('Every run is walled by macOS sandbox-exec: secret files such as ~/.ssh and .env stay hidden.');
    expect(wallLine({ ready: true }, 'linux')).toBe('Every run is walled by bubblewrap: secret files such as ~/.ssh and .env stay hidden.');
    expect(wallLine(MISSING, 'linux')).toBeNull();
  });

  it('says what each engine can still run, and why, where the wall cannot start', () => {
    expect(phasesLine('claude-code', MISSING, 'linux')).toBe(
      `Every phase. Nolzu's wall cannot start here, so secret files such as ~/.ssh and .env are not hidden from its runs. ${MISSING.reason}`,
    );
    expect(phasesLine('codex', MISSING, 'linux')).toBe(
      `Every phase. Runs are held by the Codex sandbox, because Nolzu's wall cannot start here, so secret files such as ~/.ssh and .env are not hidden from them. ${MISSING.reason}`,
    );
    for (const vendor of ['cursor'] as const) {
      expect(phasesLine(vendor, MISSING, 'linux')).toBe(`Implement only. The read-only phases need Nolzu's wall, which cannot start here. ${MISSING.reason}`);
    }
  });

  it('puts the line on each tool row', async () => {
    const tools = toolsFolder({});
    try {
      const rows = await engineTools({ PATH: tools }, tools, MISSING, 'linux');
      expect(rows.find((row) => row.engine === 'cursor')?.phases).toBe(phasesLine('cursor', MISSING, 'linux'));
    } finally {
      rmSync(tools, { recursive: true, force: true });
    }
  });
});
