import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dismissScoutFinding, finishScoutCheck, openDatabase, resolveDataDir, scoutFindings, scoutSources } from '@nolzu/core/node';
import { MIN_SCOUT_INTERVAL_MINUTES, type ScoutSchedule } from '@nolzu/protocol';
import { type Keychain, keychainAccount } from '@nolzu/runner';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ScoutSources from './ScoutSources.svelte';
import { checkFirstPaste, checkScoutSource, saveScoutSchedule, saveScoutSource, scoutFor, shortWhen, SOURCE_FORMS, sourceSecret, when } from './scout-sources.ts';

// Not a token of anything. The tests search the database, the answers and the printed lines for this
// string, so it only has to be one nothing else would write.
const TOKEN = 'abc123notatoken';

let dir = '';
let db: DatabaseSync;

// A keychain of this test's own, so nothing here runs the OS tool and nobody who runs the tests is
// asked for their keychain password. The names it was called with are recorded, and the secrets it
// took are kept aside, because a test may not print one.
let calls: string[] = [];
let kept = new Map<string, string>();
let refuse: string | null = null;
const keychain: Keychain = {
  read: (name) => {
    calls.push(`read ${name}`);
    return Promise.resolve(kept.get(name) ?? null);
  },
  write: (name, secret) => {
    calls.push(`write ${name}`);
    if (refuse !== null) return Promise.reject(new Error(refuse));
    kept.set(name, secret);
    return Promise.resolve();
  },
  remove: (name) => {
    calls.push(`remove ${name}`);
    if (refuse !== null) return Promise.reject(new Error(refuse));
    kept.delete(name);
    return Promise.resolve();
  },
};

// Every frame this file would put on the socket, and whether the socket takes them. No socket is
// opened: the send is handed in, so what reaches the hub is read here.
let frames: ScoutSchedule[] = [];
let reaches = true;
const hub = (projectId: string | null = 'p-1') => ({
  projectId,
  send: (frame: ScoutSchedule) => {
    if (!reaches) return false;
    frames.push(frame);
    return true;
  },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-sources-'));
  db = openDatabase(dir);
  calls = [];
  kept = new Map();
  refuse = null;
  frames = [];
  reaches = true;
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const post = (body: Record<string, string>, projectId: string | null = 'p-1') => {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) form.set(name, value);
  return saveScoutSource(db, keychain, form, hub(projectId));
};

const SENTRY = { do: 'add', form: 'sentry', label: 'The recipe app', org: 'your-org', project: 'recipes-api', secret: TOKEN };
const GITHUB = { do: 'add', form: 'tickets-github', label: 'The recipe app', repo: 'owner/recipes', query: 'is:issue is:open' };
const SEARCH = { do: 'add', form: 'search', label: 'The recipe app', endpoint: 'https://logs.example.com:9200', index: 'logs-*', query: 'level:error', secret: TOKEN };
const JIRA = {
  do: 'add',
  form: 'tickets-jira',
  label: 'The recipe app',
  site: 'https://your-site.atlassian.net',
  email: 'you@example.com',
  jql: 'project = PROJ AND status = Open',
  secret: TOKEN,
};

// Every column of every row, as sqlite holds it. The token is looked for here and not in what a
// function returns, because the database file is what ends up in a backup.
const rawRows = () => JSON.stringify(db.prepare('SELECT * FROM scout_sources').all());

const id = () => scoutSources(db)[0]?.id ?? 0;

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// The source dialog as the strip opens it on the first source, or as Add source opens it with none.
const markup = () => render(ScoutSources, { props: { forms: SOURCE_FORMS, row: scoutFor(db).rows[0] ?? null, onclose: () => {} } }).body;
const shown = () => text(markup());

const PASTE = { do: 'add', form: 'paste', label: 'Pasted by hand' };

// Three occurrences of one event, told apart only by the numbers the fingerprint reads past.
const TIMEOUTS = 'Timeout after 5000ms calling /api/recipes\nTimeout after 9000ms calling /api/recipes';

const check = (body: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) form.set(name, value);
  return checkScoutSource(db, form);
};

describe('adding a source', () => {
  it('keeps the settings in sqlite and the token in the keychain, and never the token in sqlite', async () => {
    expect(await post(SENTRY)).toEqual({ ok: true, did: 'add', message: null, id: id() });

    expect(scoutSources(db)).toHaveLength(1);
    expect(scoutSources(db)[0]).toMatchObject({ kind: 'sentry', label: 'The recipe app', enabled: true, createCards: false, autoAssess: false });
    expect(scoutSources(db)[0]?.config).toEqual({ org: 'your-org', project: 'recipes-api' });
    // Named by kind, project and id, so a person finds it in their keychain app.
    expect(kept.get(`sentry-recipes-api-${id()}`)).toBe(TOKEN);
    expect(rawRows()).not.toContain(TOKEN);
  });

  // The Add a source dialog draws the two "without asking" switches too, so an add keeps what they say.
  it('keeps the two opt-ins the add posts', async () => {
    await post({ ...GITHUB, createCards: 'on' });
    await post({ ...GITHUB, label: 'The recipe app CI', autoAssess: 'on' });

    expect(scoutSources(db).map(({ createCards, autoAssess }) => ({ createCards, autoAssess }))).toEqual([
      { createCards: true, autoAssess: false },
      { createCards: false, autoAssess: true },
    ]);
  });

  it('remembers which ticket system a source is, and asks GitHub for no token at all', async () => {
    expect(await post(GITHUB)).toMatchObject({ ok: true });

    // No keychain call, so adding this source can never put a password dialog on the screen.
    expect(calls).toEqual([]);
    expect(scoutSources(db)[0]?.config).toEqual({ repo: 'owner/recipes', query: 'is:issue is:open', system: 'github' });
    const row = scoutFor(db).rows[0];
    expect(row?.form.id).toBe('tickets-github');
    expect(row?.secretName).toBeNull();
  });

  // The other ticket system. This kind has two forms and the stored system is what tells them apart,
  // so a Jira row read as the GitHub form would show no token field and refuse every save.
  it('reads a Jira source back as the Jira form, and names its keychain entry', async () => {
    expect(await post(JIRA)).toMatchObject({ ok: true });
    const jira = id();

    expect(scoutFor(db).rows[0]?.form.id).toBe('tickets-jira');
    // The entry the keychain writes for this data folder, so a person can find it by that name.
    expect(scoutFor(db).rows[0]?.secretName).toBe(keychainAccount(`jira-your-site-atlassian-net-${jira}`, resolveDataDir(process.env)));

    expect(await post({ do: 'remove', id: String(jira) })).toMatchObject({ ok: true });
    expect(calls.at(-1)).toBe(`remove jira-your-site-atlassian-net-${jira}`);
  });

  it('takes the row away again when the keychain refuses the token, and repeats the token nowhere', async () => {
    refuse = 'The keychain could not store sentry-recipes-api-1.';
    const said: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation((...args: unknown[]) => {
        said.push(args.join(' '));
      }),
    );

    const answer = await post(SENTRY);
    for (const spy of spies) spy.mockRestore();

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('could not store');
    // The refusal reaches the screen, so it may not carry the token, and neither may any line printed
    // on the way there.
    expect(answer.message).not.toContain(TOKEN);
    expect(said.join('\n')).not.toContain(TOKEN);
    // A source with settings and no token would fail every check with nothing saying why.
    expect(scoutSources(db)).toEqual([]);
    expect(rawRows()).not.toContain(TOKEN);
    // The write may have got the entry in before it failed, and the row that named it is gone, so the
    // rollback asks for it to be removed too.
    expect(calls).toContain('remove sentry-recipes-api-1');
  });
});

describe('a form with something missing', () => {
  it('names the field that is empty, stores nothing, and reaches for no keychain', async () => {
    expect((await post({ ...SENTRY, org: '' })).message).toContain('organization');
    expect((await post({ ...SENTRY, project: '' })).message).toContain('project');
    expect((await post({ ...SENTRY, label: '  ' })).message).toContain('needs a label');
    expect((await post({ ...SENTRY, secret: '' })).message).toContain('Auth token');
    expect((await post({ ...GITHUB, repo: '' })).message).toContain('repository');
    expect((await post({ ...SENTRY, form: 'nothing' })).message).toContain('There is no source nothing');

    expect(scoutSources(db)).toEqual([]);
    // The cheap checks come first, the way the Jira adapter reads its site setting before the
    // keychain: a typo in a field may not cost the person a keychain dialog.
    expect(calls).toEqual([]);
  });
});

describe('the section the settings load reads', () => {
  it('lists a source without touching the keychain, and names the entry rather than claiming it is set', async () => {
    await post(SENTRY);
    calls = [];

    const section = scoutFor(db);

    // A read here would ask the person for their keychain password every time Settings opens, and a
    // refused dialog throws, which would take the whole screen down.
    expect(calls).toEqual([]);
    expect(section.rows[0]).toMatchObject({ label: 'The recipe app', secretName: keychainAccount(`sentry-recipes-api-${id()}`, resolveDataDir(process.env)), checked: 'Not checked yet.', error: null });
    expect(JSON.stringify(section)).not.toContain(TOKEN);
  });

  // The edit block draws every field from these values, so a row that hands over none opens the
  // settings of a stored source empty, and a save that only changes the label is then refused for a
  // field the person can see nothing wrong with.
  it('opens the edit form on the settings that are stored', async () => {
    await post(GITHUB);

    expect(scoutFor(db).rows[0]?.values).toEqual({ repo: 'owner/recipes', query: 'is:issue is:open', system: 'github' });
    expect(markup()).toContain('value="owner/recipes"');
  });

  // A source added by a later version, read back after a downgrade. It keeps the form of its own kind,
  // and the other form of that kind would ask for a site address and claim a keychain entry nobody made.
  it('draws a ticket system it does not know with the first form of its kind', async () => {
    await post(GITHUB);
    db.prepare("UPDATE scout_sources SET config_json = '{\"repo\":\"owner/recipes\",\"system\":\"tracker\"}' WHERE id = ?").run(id());

    expect(scoutFor(db).rows[0]?.form.id).toBe('tickets-github');
    expect(scoutFor(db).rows[0]?.secretName).toBeNull();
  });

  it('says on every form what a token may read and where it is kept', () => {
    const forms = scoutFor(db).forms;

    expect(forms.map((one) => one.id)).toEqual(['paste', 'tickets-github', 'tickets-gitlab', 'tickets-jira', 'tickets-linear', 'sentry', 'search']);
    for (const one of forms) {
      expect(one.scopes).not.toBe('');
      expect(one.credential).not.toBe('');
    }
    // One sentence per kind and not one for all of them: three of these store nothing.
    expect(forms.find((one) => one.id === 'tickets-github')?.credential).toContain('gh');
    expect(forms.find((one) => one.id === 'tickets-gitlab')?.credential).toContain('glab');
    expect(forms.find((one) => one.id === 'paste')?.credential).toContain('No credential');
    expect(forms.find((one) => one.id === 'sentry')?.credential).toContain('keychain');
    expect(forms.filter((one) => one.secret === null).map((one) => one.id)).toEqual(['paste', 'tickets-github', 'tickets-gitlab']);
  });
});

describe('saving the settings of a source', () => {
  it('writes the fields and the two opt-ins, and leaves the stored token alone when the field is empty', async () => {
    await post(SENTRY);
    calls = [];

    const answer = await post({ do: 'save', id: String(id()), label: 'The recipe API', org: 'other-org', project: 'recipes-api', secret: '', createCards: 'on' });

    expect(answer).toMatchObject({ ok: true, did: 'save' });
    expect(scoutSources(db)[0]).toMatchObject({ label: 'The recipe API', enabled: false, createCards: true, autoAssess: false });
    expect(scoutSources(db)[0]?.config).toEqual({ org: 'other-org', project: 'recipes-api' });
    // Nothing was written, so changing one setting does not ask for the token again.
    expect(calls).toEqual([]);
    expect(kept.get(`sentry-recipes-api-${id()}`)).toBe(TOKEN);
  });

  // The entry is named by the project, so a new project renames it. The token moves with it and no
  // copy stays under the old name.
  it('moves the token to the name of a new project, and leaves no copy behind', async () => {
    await post(SENTRY);
    calls = [];

    expect(await post({ do: 'save', id: String(id()), label: 'The recipe app', org: 'your-org', project: 'recipes-web', secret: '' })).toMatchObject({ ok: true });

    expect([...kept.entries()]).toEqual([[`sentry-recipes-web-${id()}`, TOKEN]]);
    expect(calls).toEqual([`read sentry-recipes-api-${id()}`, `write sentry-recipes-web-${id()}`, `remove sentry-recipes-api-${id()}`]);
  });

  // Every other test here has one source, id 1. With an older source in front, the new one is id 2 and
  // its token must go under its own id, on the add and on the move to a new project.
  it('names the entry by the id of the source it belongs to, and not by the first source', async () => {
    await post({ do: 'add', form: 'paste', label: 'Pasted logs' });
    await post(SENTRY);
    const own = scoutSources(db).find((one) => one.kind === 'sentry')?.id ?? 0;
    expect(own).toBeGreaterThan(1);
    expect([...kept.keys()]).toEqual([`sentry-recipes-api-${own}`]);

    await post({ do: 'save', id: String(own), label: 'The recipe app', org: 'your-org', project: 'recipes-web', secret: '' });

    expect([...kept.entries()]).toEqual([[`sentry-recipes-web-${own}`, TOKEN]]);
  });

  it('replaces the token when one is typed, and keeps it out of sqlite', async () => {
    await post(SENTRY);

    await post({ do: 'save', id: String(id()), label: 'The recipe app', org: 'your-org', project: 'recipes-api', secret: 'def456notatoken', enabled: 'on' });

    expect(kept.get(`sentry-recipes-api-${id()}`)).toBe('def456notatoken');
    expect(rawRows()).not.toContain('def456notatoken');
  });

  // A source from before the new names, whose token was never read since. A new token goes under the
  // new name and the old entry goes, so the old token is not kept anywhere.
  it('takes the old entry away when a new token is saved', async () => {
    await post(SENTRY);
    kept = new Map([[`scout-${id()}`, TOKEN]]);

    await post({ do: 'save', id: String(id()), label: 'The recipe app', org: 'your-org', project: 'recipes-api', secret: 'def456notatoken', enabled: 'on' });

    expect([...kept.entries()]).toEqual([[`sentry-recipes-api-${id()}`, 'def456notatoken']]);
  });

  /**
   * The marker belongs to the settings it was read with.
   *
   * A source pointed at another index keeps asking for rows newer than the last check of the old one.
   * An older index answers nothing to that, for good, and the screen says the source is quiet on every
   * press. The only way out was removing the source and losing its findings.
   */
  it('clears the marker when the settings name other rows, and keeps it when they do not', async () => {
    await post(SEARCH);
    finishScoutCheck(db, id(), { cursor: '2026-09-28T09:00:00.000Z' });

    await post({ do: 'save', id: String(id()), label: 'The recipe app logs', endpoint: 'https://logs.example.com:9200', index: 'logs-*', query: 'level:error', secret: '' });
    expect(scoutSources(db)[0]?.cursor).toBe('2026-09-28T09:00:00.000Z');

    await post({ do: 'save', id: String(id()), label: 'The recipe app logs', endpoint: 'https://logs.example.com:9200', index: 'logs-archive-2025', query: 'level:error', secret: '' });
    expect(scoutSources(db)[0]?.cursor).toBeNull();
  });

  it('says there is no such source instead of writing one', async () => {
    expect(await post({ do: 'save', id: '404', label: 'The recipe app' })).toMatchObject({ ok: false, message: 'There is no source 404 on this machine.' });
  });

  // A word this screen has no branch for, which a misspelt post or a button a later version adds looks
  // like. Answering ok would put a success banner over a source nothing happened to.
  it('refuses a word it has no button for, and changes nothing', async () => {
    await post(SENTRY);

    const answer = await post({ do: 'archive', id: String(id()) });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('There is nothing called archive to do to a source.');
    expect(scoutSources(db)).toHaveLength(1);
  });
});

describe('removing a source', () => {
  it('takes the keychain entry with it, and asks for none where there is none', async () => {
    await post(SENTRY);
    const sentry = id();
    calls = [];

    expect(await post({ do: 'remove', id: String(sentry) })).toMatchObject({ ok: true, did: 'remove' });
    // The old name as well, for a source whose token never moved to its new one.
    expect(calls).toEqual([`remove scout-${sentry}`, `remove sentry-recipes-api-${sentry}`]);
    expect(kept.size).toBe(0);
    expect(scoutSources(db)).toEqual([]);

    await post(GITHUB);
    calls = [];
    expect(await post({ do: 'remove', id: String(id()) })).toMatchObject({ ok: true });
    expect(calls).toEqual([]);
    expect(scoutSources(db)).toEqual([]);
  });

  it('keeps the row when the keychain will not give the entry up', async () => {
    await post(SENTRY);
    refuse = 'security is missing, so Nolzu cannot reach the keychain.';

    expect(await post({ do: 'remove', id: String(id()) })).toMatchObject({ ok: false, message: 'Nothing was removed. security is missing, so Nolzu cannot reach the keychain.' });
    expect(scoutSources(db)).toHaveLength(1);
  });
});

describe('the keychain entry of an older source', () => {
  // Before the names by kind and project, a source's token sat under `scout-<id>`. The first read moves
  // it, and nothing is left under the old name.
  it('moves an old scout-<id> entry on the first read and leaves no copy', async () => {
    await post(SENTRY);
    const source = scoutSources(db)[0]!;
    kept = new Map([[`scout-${source.id}`, TOKEN]]);
    calls = [];

    expect(await sourceSecret(keychain, source)).toBe(TOKEN);

    expect([...kept.entries()]).toEqual([[`sentry-recipes-api-${source.id}`, TOKEN]]);
    expect(calls).toEqual([`read sentry-recipes-api-${source.id}`, `read scout-${source.id}`, `write sentry-recipes-api-${source.id}`, `remove scout-${source.id}`]);

    // The second read finds the new entry and asks for nothing else.
    calls = [];
    expect(await sourceSecret(keychain, source)).toBe(TOKEN);
    expect(calls).toEqual([`read sentry-recipes-api-${source.id}`]);
  });

  it('leaves the old entry where it was when the new one cannot be written', async () => {
    await post(SENTRY);
    const source = scoutSources(db)[0]!;
    kept = new Map([[`scout-${source.id}`, TOKEN]]);
    refuse = 'The keychain could not store sentry-recipes-api-1.';

    await expect(sourceSecret(keychain, source)).rejects.toThrow('could not store');
    expect([...kept.entries()]).toEqual([[`scout-${source.id}`, TOKEN]]);
  });

  it('takes an old entry with it when the source is removed', async () => {
    await post(SENTRY);
    kept = new Map([[`scout-${id()}`, TOKEN]]);

    expect(await post({ do: 'remove', id: String(id()) })).toMatchObject({ ok: true });
    expect(kept.size).toBe(0);
  });
});

describe('checking a pasted source', () => {
  it('stores what it found, counts the new findings in its line, and touches no keychain', async () => {
    await post(PASTE);

    const answer = check({ id: String(id()), text: TIMEOUTS });

    // The sentence a person reads, and then the database, because the answer alone would pass with
    // nothing written.
    expect(answer).toMatchObject({ ok: true, message: null });
    expect(answer.checked).toContain('1 new finding');
    // Something did land on the list, so this line does not point at the Muted fold.
    expect(answer.checked).not.toContain('Muted');
    expect(scoutFindings(db, id())).toHaveLength(1);
    expect(scoutFindings(db, id())[0]).toMatchObject({ occurrences: 2, kind: 'bug', status: 'new' });
    // A pasted source holds no credential, so this path may never open a keychain dialog. The database
    // and the post are the only two arguments it takes, which is what makes that true, so the count is
    // the assertion: a keychain handed in here would be a third one.
    expect(checkScoutSource).toHaveLength(2);
  });

  /**
   * What is kept, which the box on the screen says out loud.
   *
   * The line that became a finding is kept as it was pasted, because those numbers and ids are the
   * evidence a person copies into a bug report. The paste around it is not, and neither is the source
   * row: the cursor there is a digest. A change that parked the whole paste in a column would turn the
   * sentence beside the box into a lie, so it goes red here.
   */
  it('keeps the pasted line on the finding and nothing of it on the source', async () => {
    await post(PASTE);

    check({ id: String(id()), text: `Timeout after 5000ms calling /api/recipes?key=${TOKEN}` });

    const findings = JSON.stringify(db.prepare('SELECT * FROM scout_findings').all());
    expect(findings).toContain(TOKEN);
    expect(rawRows()).not.toContain(TOKEN);
  });

  // The adapter takes the zero-width characters out of every line, so a paste of nothing but invisible
  // characters reads as an empty box. Without the same strip in the guard the check stamps the source
  // and the screen says Scout has read that text before, which it never has.
  it('refuses a paste of invisible characters, and leaves the source unchecked', async () => {
    await post(PASTE);

    expect(check({ id: String(id()), text: '\u200b\ufeff' })).toMatchObject({ ok: false, checked: null });
    expect(check({ id: String(id()), text: '\u200b' }).message).toContain('It is empty.');
    expect(scoutSources(db)[0]?.lastChecked).toBeNull();
    expect(scoutFindings(db, id())).toEqual([]);
  });

  // A muted finding met again changes no row, so the sentence may not say a text was read before: the
  // text is new and the cursor moved. Its own clause, and the word a person can act on is muted.
  it('says a finding was left muted when the check met one that is dismissed', async () => {
    await post(PASTE);
    check({ id: String(id()), text: TIMEOUTS });
    dismissScoutFinding(db, scoutFindings(db, id())[0]?.id ?? 0);

    const again = check({ id: String(id()), text: `${TIMEOUTS}\nTimeout after 11000ms calling /api/recipes` });

    expect(again.ok).toBe(true);
    expect(again.checked).toContain('1 finding left muted');
    expect(again.checked).not.toContain('read that text before');
    // Nothing was added and nothing was met, so the line points at the Muted fold. Sending the person
    // to the list would send them to a screen that looks exactly as they left it.
    expect(again.checked).toContain('Nothing on the list changed.');
    expect(again.checked).toContain('under Muted.');
    expect(scoutFindings(db, id())[0]?.occurrences).toBe(2);
  });

  // A check that only met findings already on the list is the one case with no added and no muted, so
  // it is the only one that says whether the "seen again" clause is written at all. Without it the
  // sentence is two full stops with nothing between them.
  it('says a finding was seen again, and points at the list it moved on', async () => {
    await post(PASTE);
    check({ id: String(id()), text: TIMEOUTS });

    const again = check({ id: String(id()), text: 'Timeout after 11000ms calling /api/recipes' });

    expect(again.ok).toBe(true);
    expect(again.checked).toContain('1 finding seen again');
    expect(again.checked).not.toContain('Nothing on the list changed.');
    expect(scoutFindings(db, id())[0]?.occurrences).toBe(3);
  });

  // The only check that writes two clauses, so it is the only one that reads the joiner between them.
  it('joins a new finding and one seen again into one sentence', async () => {
    await post(PASTE);
    check({ id: String(id()), text: TIMEOUTS });

    const again = check({ id: String(id()), text: 'Timeout after 13000ms calling /api/recipes\nCannot read property name of undefined' });

    expect(again.checked).toBe('Checked. 1 new finding, and 1 finding seen again.');
  });

  // The cursor is the digest of the text, so the same paste twice is not the same event twice. "0 new"
  // would read as a failure there, which is why this line is its own.
  it('says the text was read before the second time, and adds no second row', async () => {
    await post(PASTE);
    check({ id: String(id()), text: TIMEOUTS });

    const again = check({ id: String(id()), text: TIMEOUTS });

    expect(again.ok).toBe(true);
    expect(again.checked).toContain('read that text before');
    expect(scoutFindings(db, id())).toHaveLength(1);
    expect(scoutFindings(db, id())[0]?.occurrences).toBe(2);
  });

  // An empty box is not refused one level down: the check would find nothing, stamp last_checked and
  // leave the row claiming it was checked when nothing was read.
  it('refuses an empty box, and leaves the source saying it was never checked', async () => {
    await post(PASTE);

    expect(check({ id: String(id()), text: '   \n  ' })).toMatchObject({ ok: false, checked: null });
    expect(check({ id: String(id()), text: '' }).message).toContain('It is empty.');
    expect(scoutSources(db)[0]?.lastChecked).toBeNull();
    expect(scoutFindings(db, id())).toEqual([]);
  });

  // The refusals belong to the check in core and are whole sentences, so they travel as they are.
  it('passes the check refusal through as one sentence', async () => {
    await post(GITHUB);

    expect(check({ id: String(id()), text: TIMEOUTS })).toMatchObject({ ok: false, checked: null });
    expect(check({ id: String(id()), text: TIMEOUTS }).message).toContain('is not a pasted source');
    expect(check({ id: '404', text: TIMEOUTS }).message).toBe('That source is gone. Pick one from the sources on the Scout page.');
  });

  // An unchecked box is absent from the post, so this save turns the source off.
  it('says a source that is turned off was not checked', async () => {
    await post(PASTE);
    await post({ do: 'save', id: String(id()), label: 'Pasted by hand' });

    expect(scoutSources(db)[0]?.enabled).toBe(false);
    expect(check({ id: String(id()), text: TIMEOUTS }).message).toContain('is turned off');
    expect(scoutFindings(db, id())).toEqual([]);
  });
});

describe('what the row says about its last check', () => {
  it('prints the real time once a check has run, written out and not as a stamp', async () => {
    await post(PASTE);
    expect(scoutFor(db).rows[0]?.checked).toBe('Not checked yet.');

    check({ id: String(id()), text: TIMEOUTS });

    expect(scoutFor(db).rows[0]?.checked).toMatch(/^Last checked \d{2} \w{3,4} \d{4}, \d{2}:\d{2}\.$/);
    expect(shown()).not.toContain('Not checked yet');
  });

  /**
   * The zone the line is printed in, which the suite cannot see on its own.
   *
   * `vitest.global-setup.ts` runs everything in UTC, so a line printed in UTC looks right here and is
   * off by the offset on the person's machine. The zone is set by hand for this one line, because Nolzu
   * runs on that machine and the clock a person reads is theirs.
   */
  it('prints the time in the zone of the machine and not in UTC', () => {
    const zone = process.env.TZ;
    process.env.TZ = 'Europe/Budapest';
    try {
      expect(when('2026-09-25T12:02:00.000Z')).toBe('25 Sept 2026, 14:02');
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  // Only a check writes this column, so the test writes it the way a check does.
  it('prints the last error of a source that failed', async () => {
    await post(PASTE);
    finishScoutCheck(db, id(), { cursor: null, error: 'The log cluster answered 403. Give the API key read access to that index.' });

    expect(scoutFor(db).rows[0]?.error).toContain('answered 403');
    expect(shown()).toContain('answered 403');
  });
});

describe('the source dialog', () => {
  it('opens a source with the keychain entry that holds its token, and never the token', async () => {
    await post(SENTRY);

    const body = shown();

    expect(body).toContain('The recipe app');
    // The service, the kind and the project.
    expect(body).toContain('Kept as nolzu/sentry/recipes-api');
    expect(body).toContain('Sent only to Sentry, never to Nolzu cloud.');
    expect(body).not.toContain(TOKEN);
    // The label keeps its own capitals inside the sentence, so the screen never prints "auth token".
    expect(body).toContain('Leave the Auth token empty');
    expect(markup()).toContain('value="your-org"');
  });

  // With no source, Add source opens it on the first kind, which is the one that needs no account.
  it('lists every kind with what it needs, opened on pasted text', () => {
    const body = markup();
    const kinds = [...body.matchAll(/<label class="kind[^"]*">[\s\S]*?<b[^>]*>([^<]*)<\/b><span[^>]*>([^<]*)<\/span>/g)].map((match) => `${match[1]}: ${match[2]}`);

    expect(kinds).toEqual([
      'Pasted text: Needs nothing',
      'GitHub issues and failed CI: Uses your gh login',
      'GitLab issues: Uses your glab login',
      'Jira: API token',
      'Linear: API key',
      'Sentry: Auth token',
      'Log query: Elasticsearch or OpenSearch',
    ]);
    expect(text(body)).toContain('Add a source Scout reads from it. It never writes back.');
    expect(text(body)).toContain('You paste the text yourself');
    // Pasted text has nothing to connect to, and nothing to check until a log is pasted.
    expect(body).not.toContain('data-test');
    expect(text(body)).toContain('Cancel');
    expect(text(body)).toMatch(/Add\s*⌘↵/);
  });

  /**
   * The box is what belongs to a pasted source, and only to it.
   *
   * A ticket query and a Sentry project are checked from here as well, because their adapters ask their
   * own system, so each gets the button without a box. A source whose adapter has no screen yet gets
   * neither, and the log query is the one left.
   */
  it('gives a pasted source a box, and every source read over the network the button with its own action', async () => {
    await post(PASTE);

    expect(markup()).toContain('<textarea');
    expect(shown()).toContain('Check now');

    await post({ do: 'remove', id: String(id()) });
    await post(GITHUB);

    expect(markup()).not.toContain('<textarea');
    expect(shown()).toContain('Check now');
    expect(markup()).toContain('?/checkTickets');
    expect(shown()).toContain('failed CI runs of the default branch');

    // A log query is read over the network too, so it gets the button and its own action.
    await post({ do: 'remove', id: String(id()) });
    await post(SEARCH);

    expect(markup()).not.toContain('<textarea');
    expect(shown()).toContain('Check now');
    expect(markup()).toContain('?/checkLogs');
    expect(shown()).toContain('reads the log lines your query answers');

    await post({ do: 'remove', id: String(id()) });
    await post(SENTRY);

    expect(markup()).not.toContain('<textarea');
    expect(shown()).toContain('Check now');
    expect(markup()).toContain('?/checkSentry');
    expect(shown()).toContain('unresolved issues of that project');

  });
});

describe('the schedule a person sets', () => {
  const schedule = (body: Record<string, string>, deps: { allowed?: boolean; projectId?: string | null } = {}) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(body)) form.set(name, value);
    return saveScoutSchedule(db, form, { ...hub(deps.projectId === undefined ? 'p-1' : deps.projectId), allowed: deps.allowed ?? true });
  };

  const stored = () => {
    const row = scoutSources(db)[0];
    return { scheduleMinutes: row?.scheduleMinutes, notify: row?.notify };
  };

  it('stores the interval and the notify flag, and sends both to the hub', async () => {
    await post(SENTRY);

    expect(schedule({ id: String(id()), every: '60', notify: 'on' })).toEqual({ ok: true, did: 'schedule', message: null });

    expect(stored()).toEqual({ scheduleMinutes: 60, notify: true });
    expect(frames).toEqual([{ projectId: 'p-1', sourceId: id(), intervalMinutes: 60, notify: true, createCards: false, autoAssess: false }]);
    // The row is what the screen reads back after a restart, so the control opens on the stored one.
    expect(scoutFor(db).rows[0]?.schedule).toEqual({ minutes: 60, notify: true, pick: '60', custom: '' });
  });

  /**
   * The two opt-ins ride along with the schedule, because the check they govern runs on Nolzu cloud.
   *
   * They belong to the source's own form and not to this one, so the frame carries the row and ignores
   * anything this form says about them. Red if `saveScoutSchedule` reads either flag off the form, or
   * leaves either out of the frame, or sends the other column's value.
   */
  it('sends the two opt-ins the source row holds, and ignores what the schedule form says', async () => {
    await post(SENTRY);
    await post({ ...SENTRY, do: 'save', id: String(id()), createCards: 'on', secret: '' });

    // Read off the row, so what is pinned is the column and not the word this test typed.
    const source = scoutSources(db)[0];
    expect([source?.createCards, source?.autoAssess]).toEqual([true, false]);

    // The source has no schedule yet, so the hub holds no row for that opt-in to act on and the save
    // sends nothing. Cleared here so the one assertion below is about `saveScoutSchedule` alone, and a
    // frame from the source form fails the test that owns it instead of this one.
    expect(frames).toEqual([]);
    frames = [];

    expect(schedule({ id: String(id()), every: '60', notify: 'on', createCards: 'on', autoAssess: 'on' })).toEqual({ ok: true, did: 'schedule', message: null });

    expect(frames).toEqual([
      { projectId: 'p-1', sourceId: id(), intervalMinutes: 60, notify: true, createCards: source?.createCards, autoAssess: source?.autoAssess },
    ]);
  });

  /**
   * An opt-in the person turns off reaches the hub at once, and not at the next connect.
   *
   * The scheduled check runs on Nolzu cloud, so for as long as the hub holds the old yes it goes on
   * making cards for a source whose box this screen shows unticked. This app keeps one socket open for
   * days, so waiting for the next connect puts no bound on that. Only a real change sends a frame,
   * which is what keeps a label edit from moving the hub's next due time.
   *
   * Red if the `save` branch of `saveScoutSource` sends no frame, or sends one for a label edit, or
   * sends what the form said instead of what the row now holds.
   */
  it('sends the row when the source form turns an opt-in off, and nothing when only the label changed', async () => {
    await post(SENTRY);
    const on = { ...SENTRY, do: 'save', id: String(id()), enabled: 'on', createCards: 'on', secret: '' };
    await post(on);
    schedule({ id: String(id()), every: '60', notify: 'on' });
    frames = [];

    await post({ ...on, label: 'The recipe app errors' });

    expect(scoutSources(db)[0]?.label).toBe('The recipe app errors');
    expect(frames).toEqual([]);

    await post({ ...on, label: 'The recipe app errors', createCards: '' });

    expect(scoutSources(db)[0]?.createCards).toBe(false);
    expect(frames).toEqual([{ projectId: 'p-1', sourceId: id(), intervalMinutes: 60, notify: true, createCards: false, autoAssess: false }]);
  });

  // The two opt-ins are not interchangeable: one lets the hub make a card, the other lets it spend an
  // engine run. Every other test here has both of them off or both on, so swapping the two names in
  // the frame passed the whole suite. This one asks for them one at a time, in both orders.
  it.each([
    ['cards only', { createCards: 'on', autoAssess: '' }, { createCards: true, autoAssess: false }],
    ['assessment only', { createCards: '', autoAssess: 'on' }, { createCards: false, autoAssess: true }],
  ])('sends %s as the person set it, and not the other one', async (_what, set, sent) => {
    await post(SENTRY);
    await post({ ...SENTRY, do: 'save', id: String(id()), enabled: 'on', secret: '' });
    schedule({ id: String(id()), every: '60', notify: 'on' });
    frames = [];

    await post({ ...SENTRY, do: 'save', id: String(id()), enabled: 'on', secret: '', ...set });

    const row = scoutSources(db)[0];
    expect({ createCards: row?.createCards, autoAssess: row?.autoAssess }).toEqual(sent);
    expect(frames).toEqual([{ projectId: 'p-1', sourceId: id(), intervalMinutes: 60, notify: true, ...sent }]);
  });

  // Turning the checks off is the third setting on that form the hub acts on, and its frame is the 0
  // that deletes the row up there. Red if the `save` branch stops reading `enabled` into the frame.
  it('sends the zero when the source form turns the checks off', async () => {
    await post(SENTRY);
    await post({ ...SENTRY, do: 'save', id: String(id()), enabled: 'on', secret: '' });
    schedule({ id: String(id()), every: '60', notify: 'on' });
    frames = [];

    await post({ ...SENTRY, do: 'save', id: String(id()), secret: '' });

    expect(frames).toEqual([{ projectId: 'p-1', sourceId: id(), intervalMinutes: 0, notify: false, createCards: false, autoAssess: false }]);
    // The row keeps its interval, so the screen still shows it and a source turned on again is armed.
    expect(stored()).toEqual({ scheduleMinutes: 60, notify: true });
  });

  it('sends the zero when the schedule is turned off, and does not keep the old interval', async () => {
    await post(SENTRY);
    schedule({ id: String(id()), every: 'custom', minutes: '240', notify: 'on' });
    expect(stored()).toEqual({ scheduleMinutes: 240, notify: true });

    // The minutes box still holds 240, which is the trap: off means off.
    expect(schedule({ id: String(id()), every: 'off', minutes: '240' })).toEqual({ ok: true, did: 'schedule', message: null });

    expect(stored()).toEqual({ scheduleMinutes: 0, notify: false });
    expect(frames[1]).toEqual({ projectId: 'p-1', sourceId: id(), intervalMinutes: 0, notify: false, createCards: false, autoAssess: false });
  });

  it('refuses an interval outside the bounds with its own sentence, and stores and sends nothing', async () => {
    await post(SENTRY);
    schedule({ id: String(id()), every: '60' });
    frames = [];

    const answer = schedule({ id: String(id()), every: 'custom', minutes: '5' });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain(`every ${MIN_SCOUT_INTERVAL_MINUTES} minutes`);
    // The stored schedule is the one from before, so a refused number changed nothing.
    expect(stored()).toEqual({ scheduleMinutes: 60, notify: false });
    expect(frames).toEqual([]);
  });

  it('saves nothing and sends nothing without the plan', async () => {
    await post(SENTRY);

    const answer = schedule({ id: String(id()), every: '60' }, { allowed: false });

    expect(answer.ok).toBe(false);
    expect(answer.message).toBe('This machine is on the free plan, so no schedule was saved. Check now works on every plan.');
    expect(stored()).toEqual({ scheduleMinutes: 0, notify: false });
    expect(frames).toEqual([]);
  });

  it('keeps the schedule here when the hub cannot be reached, and says so', async () => {
    await post(SENTRY);
    reaches = false;

    expect(schedule({ id: String(id()), every: '60' })).toEqual({ ok: true, did: 'schedule-here', message: null });
    expect(stored()).toEqual({ scheduleMinutes: 60, notify: false });

    // A machine registered nowhere has no project to name, so the frame is not even built.
    expect(schedule({ id: String(id()), every: '60' }, { projectId: null })).toEqual({ ok: true, did: 'schedule-here', message: null });
    expect(frames).toEqual([]);
  });

  /**
   * The stop the hub never heard is its own word.
   *
   * The two states are opposites on the screen. A schedule that stayed here runs nowhere, and a stop
   * that stayed here means Nolzu cloud may still hold the old interval, and it is the one place that
   * would check on it. One sentence for both would tell the person the reverse of what is true.
   */
  it('says a stop that did not reach the hub in its own word, and not the one for a save', async () => {
    await post(SENTRY);
    schedule({ id: String(id()), every: '60', notify: 'on' });
    reaches = false;

    const off = schedule({ id: String(id()), every: 'off' });

    expect(off).toEqual({ ok: true, did: 'schedule-off-here', message: null });
    // The row is off here, which is why the hub is the only place the old schedule still lives.
    expect(stored()).toEqual({ scheduleMinutes: 0, notify: false });
    // A machine registered nowhere sent the hub no schedule to keep, so its stop is an ordinary save.
    expect(schedule({ id: String(id()), every: 'off' }, { projectId: null }).did).toBe('schedule-here');
  });

  it('offers no schedule for a source Nolzu cloud cannot check, and keeps Check now', async () => {
    await post(SEARCH);

    const answer = schedule({ id: String(id()), every: '60' });

    expect(answer.ok).toBe(false);
    expect(answer.message).toContain('takes no schedule');
    expect(stored()).toEqual({ scheduleMinutes: 0, notify: false });
    expect(frames).toEqual([]);
    // And the screen does not draw the control at all.
    expect(markup()).not.toContain('?/schedule');
    expect(shown()).toContain('Check now');
  });

  /**
   * The cloud schedule is hidden until Nolzu cloud can check a source. Not drawn off
   * and not drawn with a line saying it does nothing: not drawn at all, on a new source and on an open
   * one of a kind the cloud could read, and the footer says a check waits for Check now.
   */
  it('draws no cloud schedule on the dialog', async () => {
    const empty = markup();
    await post(SENTRY);
    const sentry = markup();

    for (const body of [empty, sentry]) {
      expect(body).not.toContain('?/schedule');
      expect(text(body)).not.toMatch(/Ask Nolzu cloud|Custom minutes|notification|schedule/i);
      expect(text(body)).toContain('Scout checks it when you press Check now.');
    }
  });

  /**
   * A removed source takes its schedule with it.
   *
   * `scout_sources.id` is an INTEGER PRIMARY KEY with no AUTOINCREMENT, so the next source added takes
   * the freed id, which this test proves rather than assumes. A schedule the hub kept under that id
   * would then check a source nobody scheduled, and no screen on this machine could turn it off.
   */
  it('sends the zero when a scheduled source is removed, and the freed id goes to the next source', async () => {
    await post(SENTRY);
    const gone = id();
    schedule({ id: String(gone), every: String(MIN_SCOUT_INTERVAL_MINUTES), notify: 'on' });
    frames = [];

    expect(await post({ do: 'remove', id: String(gone) })).toEqual({ ok: true, did: 'remove', message: null });

    // Both opt-ins ride along as the row holds them. They change nothing on a frame the hub deletes
    // its row on, and leaving them out of the one builder both paths use would cost a second one.
    expect(frames).toEqual([{ projectId: 'p-1', sourceId: gone, intervalMinutes: 0, notify: false, createCards: false, autoAssess: false }]);
    await post(JIRA);
    expect(id()).toBe(gone);
  });

  it('says the source is gone from this machine alone when the stop did not reach the hub', async () => {
    await post(SENTRY);
    schedule({ id: String(id()), every: '60' });
    reaches = false;

    const answer = await post({ do: 'remove', id: String(id()) });

    // Removed here whatever the hub did, because the person asked for that and a row kept for a frame
    // that may never go would be a source they cannot get rid of.
    expect(answer).toEqual({ ok: true, did: 'remove-here', message: null });
    expect(scoutSources(db)).toEqual([]);
  });

  it('sends nothing when the removed source had no schedule', async () => {
    await post(SENTRY);

    expect(await post({ do: 'remove', id: String(id()) })).toEqual({ ok: true, did: 'remove', message: null });

    expect(frames).toEqual([]);
  });

  /**
   * One place per form, never two.
   *
   * A form whose token this machine keeps names the keychain. Nolzu cloud is named by no form yet:
   * nothing in this build sends a credential there, so a form that said so would be wrong. The check
   * is here so the second sentence cannot be added beside the first one.
   */
  it('names one place for each form credential and not two', () => {
    for (const form of SOURCE_FORMS) {
      const places = ['OS keychain', 'Nolzu cloud'].filter((place) => form.credential.includes(place));
      // The keychain by name, not "one of the two". A form that swapped it for Nolzu cloud would be
      // lying while no message carries a credential, and counting alone would let that through.
      expect(places).toEqual(form.secret === null ? [] : ['OS keychain']);
    }
  });
});

// The short time beside a source on the strip and beside a finding on the list: the clock today, the
// weekday in the week before, the date before that. Written out and not "5m ago", so a page that stays
// open does not grow wrong.
describe('shortWhen', () => {
  const now = new Date('2026-10-12T15:00:00.000Z');

  it('gives the clock for a time today', () => {
    expect(shortWhen('2026-10-12T13:02:00.000Z', now, 'UTC')).toBe('13:02');
  });

  it('gives the weekday for a time in the six days before today', () => {
    expect(shortWhen('2026-10-10T16:40:00.000Z', now, 'UTC')).toBe('Sat');
    expect(shortWhen('2026-10-06T09:00:00.000Z', now, 'UTC')).toBe('Tue');
  });

  it('gives the date for a time a week ago or more, and the year when it is not this one', () => {
    expect(shortWhen('2026-10-05T09:00:00.000Z', now, 'UTC')).toBe('5 Oct');
    expect(shortWhen('2025-10-20T09:00:00.000Z', now, 'UTC')).toBe('20 Oct 2025');
  });

  // The day is the person's own: 23:30 in UTC is already tomorrow in Tokyo.
  it('reads the day in the time zone it is given', () => {
    expect(shortWhen('2026-10-12T23:30:00.000Z', new Date('2026-10-13T08:00:00.000Z'), 'Asia/Tokyo')).toBe('08:30');
  });
});

// The first visit's paste box: one paste and Check now show the first finding, with no source made by
// hand first.
describe('checkFirstPaste', () => {
  const paste = (text: string) => {
    const form = new FormData();
    form.set('text', text);
    return checkFirstPaste(db, form);
  };

  it('makes a pasted text source, checks the text with it, and finds what it holds', () => {
    expect(paste(TIMEOUTS)).toMatchObject({ ok: true, checked: expect.stringContaining('1 new finding') });
    expect(scoutSources(db).map((one) => [one.kind, one.label])).toEqual([['paste', 'Pasted logs']]);
    expect(scoutFindings(db, id())).toHaveLength(1);
  });

  // A second paste goes on the same source, so the page does not fill with one source per paste.
  it('checks a later paste with the pasted text source that is there', async () => {
    await post(PASTE);

    paste(TIMEOUTS);

    expect(scoutSources(db).map((one) => one.label)).toEqual(['Pasted by hand']);
    expect(scoutFindings(db, id())).toHaveLength(1);
  });

  it('refuses an empty box before it makes a source', () => {
    expect(paste(' \u200B ')).toEqual({ ok: false, checked: null, message: 'Paste the log or the errors into the box first. It is empty.' });
    expect(scoutSources(db)).toEqual([]);
  });
});
