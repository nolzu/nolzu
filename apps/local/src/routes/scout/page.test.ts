import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addScoutSource, checkPasteSource, openDatabase, writeSetting } from '@nolzu/core/node';
import { render } from 'svelte/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FREE } from '$lib/display.ts';
import { nowSnapshot } from '$lib/now-snapshot.ts';
import Rail from '$lib/Rail.svelte';
import type { ScoutFindingDetail } from '$lib/scout-detail.ts';
import type { ScoutFindingsView } from '$lib/scout-findings.ts';
import type { ScoutSection } from '$lib/scout-sources.ts';
// The stub vitest aliases `$app/paths` to. By path and not by that name, because the app's types for
// `$app/paths` are SvelteKit's own and carry no `drawnAt`.
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../test/stubs/app-paths.ts';
import Scout from './+page.svelte';

// Scout is off as shipped. These tests pin the page once the switch is on again, and
// coming-soon.test.ts pins the off state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), SCOUT_AND_EVIDENCE: true }));

// The data folder each keychain was built for, because the keychain names its entries by it. The
// keychain itself refuses every call: no test here may reach the keychain of whoever runs it.
const folders = vi.hoisted(() => [] as string[]);
vi.mock('@nolzu/runner', async (real) => ({
  ...(await real<object>()),
  createKeychain: (_platform: string, _run: unknown, folder: string) => {
    folders.push(folder);
    const refuse = async () => {
      throw new Error('A test reached the keychain.');
    };
    return { read: refuse, write: refuse, remove: refuse };
  },
}));

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported and opens anything.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-route-'));
process.env.NOLZU_DATA_DIR = dir;
// The schedule action asks the server what this account's plan draws. A closed port on this machine is
// what it gets, so the round cannot reach a server even if the keychain of whoever runs the tests holds
// a device token, and the answer is the Free document every time.
process.env.NOLZU_CLOUD_URL = 'http://127.0.0.1:1';

const { actions, load } = await import('./+page.server.ts');
const page = load as unknown as () => { findings: ScoutFindingsView; scout: ScoutSection; githubOwner: Promise<string | null>; finding: ScoutFindingDetail | null };
type Answer = { did?: string; said?: string; status?: number; data?: { did: string; problem: string } };
const post = (id: number | string) => ({ request: new Request('http://localhost/scout', { method: 'POST', body: new URLSearchParams({ id: String(id) }) }) });

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('reads no finding and no source on a fresh machine', () => {
  expect(page().findings.rows).toEqual([]);
  expect(page().scout.rows).toEqual([]);
});

const draw = (form: unknown = null, at = '/scout') => {
  drawnAt(at);
  return render(Scout as never, { props: { data: { ...page(), display: FREE }, form } } as never).body;
};
const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

// Scout on a first visit: three source buttons and a paste box ready to use, with Paste a log picked
// because it needs no login. Nothing to check yet, so no Check all sources.
it('draws the first visit on a machine with no source', () => {
  const body = draw();
  const buttons = [...body.matchAll(/<button class="big[^"]*" type="button" aria-pressed="(true|false)"[\s\S]*?<b[^>]*>([^<]*)<\/b>/g)].map((match) => [match[2], match[1]]);

  expect(buttons).toEqual([
    ['GitHub issues and failed CI', 'false'],
    ['Sentry', 'false'],
    ['Paste a log', 'true'],
  ]);
  expect(body).toContain('action="?/firstPaste"');
  expect(body).toMatch(/<textarea id="first-paste" name="text"/);
  expect(text(body)).toContain('Read-only. Scout never changes code.');
  expect(text(body)).toContain('GitLab, Jira, Linear or a log query? More kinds');
  expect(body).not.toContain('data-check-all');
  expect(body).not.toContain('id="findings"');
});

// Scout on a first visit: the short note under Check now, and the GitHub card names the owner of the
// project's GitHub remote. A project with no GitHub remote names nobody.
it('names the GitHub owner on the first visit and says the text stays here', async () => {
  drawnAt('/scout');
  const drawWith = (githubOwner: string | null) => text(render(Scout as never, { props: { data: { ...page(), githubOwner, display: FREE }, form: null } } as never).body);

  expect(drawWith('example')).toContain('Uses your gh login · example');
  expect(drawWith('example')).toContain('Check now ⌘↵ Stays on this machine.');
  expect(drawWith(null)).toContain('Uses your gh login Sentry');
  // The fresh machine has no project folder, so the load names no owner.
  await expect(page().githubOwner).resolves.toBeNull();
});

// The owner is read from the project's origin, and only while there is no source to show.
const withOrigin = () => {
  const repo = mkdtempSync(join(tmpdir(), 'nolzu-scout-origin-'));
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example/recipes.git']);
  const db = openDatabase(dir);
  writeSetting(db, 'projectPath', repo);
  db.close();
  return repo;
};

it('names the owner of the GitHub remote while there is no source', async () => {
  const repo = withOrigin();
  try {
    await expect(page().githubOwner).resolves.toBe('example');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// Removing the last source lands on the first visit, which has no strip, so the answer prints above it.
it('says the source is removed on the first visit that follows a remove of the last one', () => {
  const body = draw({ field: 'remove', saved: true });

  expect(body).toContain('action="?/firstPaste"');
  expect(body).toContain('role="status">The source is removed.</p>');
});

// The empty box is refused before a source is made, so the page stays on the first visit with the
// sentence under the box.
it('refuses an empty first paste and makes no source', async () => {
  const answer = (await actions.firstPaste!(send({ text: '  ' }) as never)) as { status: number; data: { field: string; message: string } };

  expect(answer.status).toBe(400);
  expect(answer.data).toEqual({ field: 'check', message: 'Paste the log or the errors into the box first. It is empty.' });
  expect(page().scout.rows).toEqual([]);
  expect(text(draw(answer.data))).toContain('It is empty.');
});

it('reads the findings of every source, the one met last first', () => {
  const db = openDatabase(dir);
  const first = addScoutSource(db, { kind: 'paste', label: 'Pasted by hand' });
  const second = addScoutSource(db, { kind: 'paste', label: 'Pasted from the other log' });
  checkPasteSource(db, first, 'Timeout after 5000ms calling /api/recipes');
  checkPasteSource(db, second, 'Out of memory in the recipe worker');
  db.close();

  expect(page().findings.rows.map((row) => row.source)).toEqual(['Pasted from the other log', 'Pasted by hand']);
});

// Scout: the top bar with Check all sources, the sources strip, and the inbox in two panes with
// the finding seen last selected on the right.
it('draws the sources strip and the two panes, with the finding seen last on show', () => {
  const { findings, finding } = page();
  const body = draw();
  const first = findings.rows[0];

  expect(body).toMatch(/<form method="POST" action="\?\/checkAll#sources" data-check-all="">[\s\S]*?Check all sources/);
  expect(text(body)).toMatch(/Sources Pasted by hand checked \d\d:\d\d Pasted from the other log checked \d\d:\d\d Add source/);
  expect(text(body)).toContain('Findings 2 Last seen first');
  expect(finding?.row.id).toBe(first?.id);
  expect(body).toMatch(new RegExp(`<a class="frow[^"]*" href="\\./scout/f/${first?.id}" aria-current="true">`));
  expect(body).toContain('<h2 class="fd-t');
  expect(text(body)).toContain(`What Scout saw 1 line`);
  // The two panes come after the strip, so an old Settings link lands above them.
  expect(body.indexOf('id="sources"')).toBeLessThan(body.indexOf('id="findings"'));
  expect(body.indexOf('id="findings"')).toBeLessThan(body.indexOf('id="fd-t"'));
});

// A press reads only the sources a press can read. Here every source takes a paste, so nothing is read,
// no service is asked, and the answer says why.
it('answers Check all sources with why nothing was read when every source takes a paste', async () => {
  const answer = (await actions.checkAll!({} as never)) as { status: number; data: { field: string; message: string; failed: string[] } };

  expect(answer.status).toBe(400);
  expect(answer.data).toEqual({ field: 'checkAll', message: expect.stringContaining('A pasted text source takes its text in its own box'), failed: [] });
  expect(text(draw(answer.data))).toContain('No source here can be checked in one press.');
});

// The seen marker: opening Scout clears the rail's blue dot on every open page, through the loop's
// change report, and a visit with nothing new tells nobody.
it('clears the rail dot on Scout once the page is opened', async () => {
  const { loop } = await import('$lib/loop.ts');
  const db = openDatabase(dir);
  const id = addScoutSource(db, { kind: 'paste', label: 'Pasted for the dot' });
  checkPasteSource(db, id, 'Connection refused by the recipe database');
  db.close();
  const rail = (fresh: number) => {
    drawnAt('/knowledge');
    return render(Rail, { props: { routeId: '/knowledge', project: null, ontheme: () => {}, scoutNew: fresh > 0 } }).body;
  };

  const before = nowSnapshot(loop()).scout.fresh;
  expect(before).toBe(1);
  expect(rail(before)).toContain('data-scout-new');

  let told = 0;
  const stop = loop().onChange(() => told++);
  page();
  expect(told).toBe(1);
  page();
  expect(told).toBe(1);
  stop();

  const after = nowSnapshot(loop()).scout.fresh;
  expect(after).toBe(0);
  expect(rail(after)).not.toContain('data-scout-new');
});

// The two buttons reaching the database through the route. What they may and may not do to a finding
// is proved in scout-findings.test.ts; this is the wiring, and that the form field they read is the
// one the buttons post.
it('mutes a finding and brings it back, and says so both times', async () => {
  const db = openDatabase(dir);
  const id = addScoutSource(db, { kind: 'paste', label: 'Pasted for the buttons' });
  checkPasteSource(db, id, 'Out of disk space writing /var/log/recipes.log');
  db.close();
  const finding = page().findings.rows.find((row) => row.source === 'Pasted for the buttons');

  // Both buttons tell the loop, whose change report sends the new status to the hub.
  const { loop } = await import('$lib/loop.ts');
  let told = 0;
  const stop = loop().onChange(() => told++);

  const muted = (await actions.dismiss!(post(finding?.id ?? 0) as never)) as Answer;
  expect(told).toBe(1);

  expect(muted.said).toContain('is muted');
  // The button the answer came from, because the screen prints it at the foot of that button's panel.
  expect(muted.did).toBe('dismiss');
  expect(page().findings.rows.map((row) => row.id)).not.toContain(finding?.id);
  expect(page().findings.memory.map((row) => row.id)).toContain(finding?.id);

  const back = (await actions.unmute!(post(finding?.id ?? 0) as never)) as Answer;

  expect(back.said).toContain('back on the list');
  expect(back.did).toBe('unmute');
  expect(told).toBe(2);
  await actions.dismiss!(post(999) as never);
  expect(told).toBe(2);
  stop();
  expect(page().findings.rows.map((row) => row.id)).toContain(finding?.id);
  expect(page().findings.memory).toEqual([]);
});

// A refusal is a 400 with a sentence, so the screen prints it under the panel instead of a 500 page.
it('refuses a dismiss of a finding that is not there and names it', async () => {
  const answer = (await actions.dismiss!(post(999) as never)) as Answer;

  expect(answer.status).toBe(400);
  expect(answer.data?.problem).toContain('999');
  expect(answer.data?.did).toBe('dismiss');
});

// The Start as Delivery button on both screens posts to this name, so the action has to be
// under it. It is not called here: it goes through the loop for the notice the open boards need, and a
// test that built one would build a scheduler for a write that starts no run. What it writes is proved
// in scout-findings.test.ts, in core and in the app.
it('holds the start action both Scout screens post to', () => {
  expect(typeof actions.start).toBe('function');
});

// Start makes a card, which a render cannot press, so the one line that carries a rule the type check
// cannot see is read as source, and it is not matched whole: a reflow of the tag is no bug, and a test
// that dies on one teaches people to loosen it. The page this route draws is `ScoutPage.svelte`.
//
// The panel's props are not read here. Every one of them is required on the component, so a missing
// one is a svelte-check error and the gate is already red. What the button list Start is named in is
// not: it is an argument to a local function, and dropping it there only loses the sentence.
it('hands the findings panel what Start answered', () => {
  const source = readFileSync(new URL('../../lib/ScoutPage.svelte', import.meta.url), 'utf8');

  expect(source).toMatch(/said=\{said\([^)]*'start'[^)]*\)\}/);
});

// The sources moved here from Settings, Scout, with the actions their forms post.
const send = (body: Record<string, string>) => ({ request: new Request('http://localhost/scout', { method: 'POST', body: new URLSearchParams(body) }) });

describe('the scout action', () => {
  // The form is refused before anything is stored, so this reaches no keychain and running the tests
  // asks nobody for their keychain password. The keychain write itself is tested in the module, with a
  // keychain of the test's own.
  it('answers 400 with the field that is empty, and stores no source', async () => {
    // The tests above added sources of their own, so this counts what the refusal added.
    const before = page().scout.rows.length;
    const answer = (await actions.scout!(send({ do: 'add', form: 'sentry', label: 'The recipe app', org: '', project: 'recipes-api', secret: 'abc123notatoken' }) as never)) as {
      status: number;
      data: { field: string; message: string };
    };

    expect(answer.status).toBe(400);
    expect(answer.data.field).toBe('add');
    expect(answer.data.message).toContain('organization');
    expect(page().scout.rows).toHaveLength(before);
  });

  // A source with no credential, so the whole action runs through the route with no keychain in it.
  it('adds a source that stores no credential, and the load reads it back', async () => {
    const answer = await actions.scout!(send({ do: 'add', form: 'tickets-github', label: 'The recipe app', repo: 'owner/recipes', query: 'is:issue is:open' }) as never);

    expect(answer).toMatchObject({ field: 'add', saved: true });
    expect(page().scout.rows.at(-1)).toMatchObject({ label: 'The recipe app', secretName: null });
  });

  // A second data folder on the machine keeps its own source tokens, so every action that may hold one
  // opens the keychain of the folder this app runs on, and not the default one. A refused form and an id
  // that is no source, so nothing reads a token or reaches a server.
  it('opens the keychain of this data folder for the save and the three checks', async () => {
    folders.length = 0;

    await actions.scout!(send({ do: 'add', form: 'sentry', label: 'The recipe app', org: '', project: 'recipes-api', secret: 'abc123notatoken' }) as never);
    for (const check of ['checkTickets', 'checkSentry', 'checkLogs'] as const) await actions[check]!(send({ id: '999999' }) as never);

    expect(folders).toHaveLength(4);
    expect([...new Set(folders)]).toEqual([dir]);
  });
});

describe('the schedule action', () => {
  /**
   * The plan gate, which only this route can prove.
   *
   * `saveScoutSchedule` takes the answer as a flag and its own tests drive both values of it. What
   * nothing else covers is where that flag comes from: the signed display document, read again on the
   * post. A machine with no account is Free, so the schedule is refused and nothing is stored.
   *
   * The source is a GitHub one, which stores no credential, so the whole action runs with no keychain
   * in it. The plan is asked before the source's own kind, because a Free machine takes no schedule
   * whatever the source is.
   */
  it('answers 400 with the free-plan sentence on a machine with no account, and stores no schedule', async () => {
    await actions.scout!(send({ do: 'add', form: 'tickets-github', label: 'The recipe app scheduled', repo: 'owner/recipes', query: 'is:issue is:open' }) as never);
    const source = page().scout.rows.at(-1)?.id ?? 0;

    const answer = (await actions.schedule!(send({ id: String(source), every: '60', notify: 'on' }) as never)) as {
      status: number;
      data: { field: string; message: string };
    };

    expect(answer.status).toBe(400);
    expect(answer.data).toMatchObject({ field: 'schedule' });
    expect(answer.data.message).toContain('free plan');
    expect(page().scout.rows.at(-1)?.schedule.minutes).toBe(0);
  });
});

describe('the check action', () => {
  // Its own action, so the sentence with the two numbers does not have to fit the shape the three
  // source actions answer with. No keychain is built on this path at all.
  it('checks a pasted source and answers with the line the screen prints', async () => {
    await actions.scout!(send({ do: 'add', form: 'paste', label: 'Pasted by hand' }) as never);
    const paste = page().scout.rows.at(-1)?.id ?? 0;

    const answer = (await actions.check!(send({ id: String(paste), text: 'Timeout after 5000ms calling /api/recipes' }) as never)) as {
      field: string;
      checked: string;
      saved: boolean;
    };

    expect(answer).toMatchObject({ field: 'check', saved: true });
    expect(answer.checked).toContain('1 new finding');
  });

  // The loop's change report is what sends the findings to the hub, so a check that worked tells it
  // and a refused one does not.
  it('tells the loop after a check that worked, and not after a refused one', async () => {
    const { loop } = await import('$lib/loop.ts');
    // Read before listening, because opening the page moves the seen marker, which tells the loop too.
    const paste = page().scout.rows.at(-1)?.id ?? 0;
    let told = 0;
    const stop = loop().onChange(() => told++);

    await actions.check!(send({ id: String(paste), text: 'Out of memory in the recipe worker' }) as never);
    expect(told).toBe(1);
    await actions.check!(send({ id: String(paste), text: '' }) as never);
    expect(told).toBe(1);
    stop();
  });

  // The first visit's box goes on the pasted text source that is there, and answers as a check does.
  it('checks a first paste with the pasted text source there', async () => {
    const before = page().scout.rows.length;

    const answer = await actions.firstPaste!(send({ text: 'Out of memory in the recipe importer' }) as never);

    expect(answer).toMatchObject({ field: 'check', saved: true, checked: expect.stringContaining('1 new finding') });
    expect(page().scout.rows).toHaveLength(before);
  });

  it('answers 400 with the sentence when the box is empty', async () => {
    const paste = page().scout.rows.at(-1)?.id ?? 0;

    const answer = (await actions.check!(send({ id: String(paste), text: '' }) as never)) as { status: number; data: { field: string; message: string } };

    expect(answer.status).toBe(400);
    expect(answer.data).toMatchObject({ field: 'check' });
    expect(answer.data.message).toContain('It is empty.');
  });
});

// Nothing checks a source on a schedule yet, and a stop that never reached the hub is not sent again
// on reconnect. Each answer is pinned whole, so a line saying the cloud checks cannot come back.
it.each([
  ['remove-here', 'The source is removed here. Nolzu cloud could not be told, so it may keep the schedule. It checks no source yet, so that changes nothing today.'],
  ['schedule', 'Saved, and Nolzu cloud has the schedule. It checks no source yet, so keep using Check now.'],
  ['schedule-here', 'Saved on this machine. Nolzu cloud does not have it yet. Keep using Check now.'],
  ['schedule-off-here', 'Stopped on this machine. Nolzu cloud could not be told, so it may keep the old schedule. Save Off again once the link is back. It checks no source yet, so that changes nothing today.'],
])('says what the %s answer did to a schedule, and not that one runs', (field, line) => {
  drawnAt('/scout');
  const { body } = render(Scout as never, { props: { data: { ...page(), display: FREE }, form: { field, saved: true } } } as never);

  expect(body).toContain(`role="status">${line}</p>`);
});

// An old /settings/scout link still lands where the sources are: the strip at #sources, drawn first,
// above the findings. Each entry and Add source open the source dialog, so no source form sits on the
// page until one is opened.
it('keeps an old /settings/scout link landing on the sources strip, which opens the dialog', async () => {
  const settings = await import('../settings/[section]/+page.server.ts');
  expect(() => (settings.load as unknown as (event: { params: { section: string } }) => unknown)({ params: { section: 'scout' } })).toThrow(
    expect.objectContaining({ status: 308, location: '/scout#sources' }),
  );

  drawnAt('/scout');
  const { body } = render(Scout as never, { props: { data: { ...page(), display: FREE }, form: null } } as never);

  expect(body).toContain('id="sources" aria-labelledby="sources-title"');
  expect(body.indexOf('id="sources"')).toBeLessThan(body.indexOf('id="findings"'));
  expect(body).toMatch(/<button type="button" class="add[^"]*" aria-haspopup="dialog">[\s\S]*?Add source<\/button>/);
  expect(body).not.toContain('action="?/scout');
  expect(body).not.toContain('<dialog');
});

describe('the source dialog actions', () => {
  // Test the connection reads with the unsaved form. A Sentry form with no token and no source behind
  // it is refused before anything is read, so no keychain call and no request is made.
  it('refuses a test with no token before any read', async () => {
    const answer = (await actions.test!(send({ form: 'sentry', label: 'The recipe app', org: 'example', project: 'recipes-web', secret: '' }) as never)) as {
      status: number;
      data: { field: string; message: string };
    };

    expect(answer.status).toBe(400);
    expect(answer.data).toEqual({ field: 'test', message: 'Paste the Auth token first, so the test has something to connect with.' });
  });

  // "Add and check now" on pasted text adds it and checks nothing, because there is no text yet.
  it('adds a pasted text source with Add and check now, and checks nothing', async () => {
    const answer = await actions.scout!(send({ do: 'add', form: 'paste', label: 'Pasted at the dialog', check: 'now' }) as never);

    expect(answer).toEqual({ field: 'add', saved: true });
    expect(page().scout.rows.at(-1)).toMatchObject({ label: 'Pasted at the dialog', checkedAt: null });
  });
});

it('names no owner once the page has a source, the strip taking the first visit\'s place', async () => {
  expect(page().scout.rows.length).toBeGreaterThan(0);
  const repo = withOrigin();
  try {
    await expect(page().githubOwner).resolves.toBeNull();
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
