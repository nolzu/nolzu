import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSetting, openDatabase, writeSetting } from '@nolzu/core/node';
import { type DisplayEntitlement, type EvidenceDay, type Timesheet, weekOf } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EXPORT_FEATURE, HISTORY_FEATURE } from '$lib/display.ts';
// The stub vitest aliases `$app/paths` to. By path and not by that name, because the app's types for
// `$app/paths` are SvelteKit's own and carry no `drawnAt`.
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../../test/stubs/app-paths.ts';
// Safe above the line that points the data directory at a temp one: the page and its components
// open nothing, they only draw.
import Evidence from './+page.svelte';

// The OS keychain the two export actions build, as a map. The rest of the runner is the real one.
// Reads are listed, because a read on a real machine can ask the person for their keychain password.
const keys = vi.hoisted(() => new Map<string, string>());
const reads = vi.hoisted(() => [] as string[]);
// The data folder each keychain was built for, because the keychain names its entries by it.
const folders = vi.hoisted(() => [] as string[]);
vi.mock('@nolzu/runner', async (real) => ({
  ...(await real<object>()),
  createKeychain: (_platform: string, _run: unknown, folder: string) => {
    folders.push(folder);
    return {
      read: async (name: string) => {
        reads.push(name);
        return keys.get(name) ?? null;
      },
      write: async (name: string, secret: string) => void keys.set(name, secret),
      remove: async (name: string) => void keys.delete(name),
    };
  },
}));

// The signed display document the two export actions read on a post. A test cannot sign a paid one,
// so the features are set here, and none until a test puts some in. The plan word stays solo, so a
// check that read the word and not the feature fails the refusal test.
const plan = vi.hoisted(() => ({ features: [] as string[] }));
vi.mock('$lib/display-sync.ts', async (real) => ({
  ...(await real<object>()),
  currentDisplay: async (): Promise<DisplayEntitlement> => ({ id: 'a', plan: 'solo', features: plan.features, seats: 1, expiresAt: 0 }),
}));

// The route reads the data directory from the environment, so it is pointed at a temp one before the
// module is imported and opens anything.
const dir = mkdtempSync(join(tmpdir(), 'nolzu-evidence-route-'));
process.env.NOLZU_DATA_DIR = dir;

const { actions, load } = await import('./+page.server.ts');
const page = load as unknown as (event: { url: URL }) => Promise<{
  day: EvidenceDay;
  week: Timesheet;
  today: string;
  weeks: { previous: string; next: string };
}>;

// One day and its week, pinned, because these tests are about which day the URL asks for. The
// suite runs with TZ=UTC. 2026-04-13 is the Monday, 2026-04-15 the Wednesday. Another week than the
// one the CSV tests below read, so those two keep answering an empty file.
const DAY = '2026-04-15';
const WEEK = '2026-04-13';

// Today by a different route than the loader takes, so the fallback test cannot pass by running the
// same line of code twice.
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date());

// A card, a run of half an hour and a move, all on the pinned day. Written through a second
// connection to the same file, because the route holds its own.
function rows(): void {
  const db = openDatabase(dir);
  db.prepare("INSERT INTO cards (key, board, stage, state, title) VALUES ('APP-1', 'delivery', 'implement', 'idle', 'Add a search box')").run();
  const written = db
    .prepare("INSERT INTO runs (card_key, phase, engine, log_path, state) VALUES ('APP-1', 'implement', 'claude-code', ?, 'complete')")
    .run(join(dir, 'run.ndjson'));
  db.prepare('UPDATE runs SET started_at = ?, ended_at = ?, duration_ms = 1800000 WHERE id = ?').run(
    `${DAY}T09:00:00.000Z`,
    `${DAY}T09:30:00.000Z`,
    Number(written.lastInsertRowid),
  );
  db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, at) VALUES ('APP-1', 'implement', 'review', 'you', ?)").run(
    `${DAY}T11:30:00.000Z`,
  );
  db.close();
}

const { GET } = await import('../api/evidence/timesheet/+server.ts');
const csv = GET as unknown as (event: { url: URL }) => Response;

// Written once, before any test. The rows are in April and every default the route falls back to is
// today, so the panels of a screen that asked for nothing stay empty.
rows();

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('opens on today and this week, with nothing on either', async () => {
  const data = await page({ url: new URL('http://localhost/evidence') });

  expect(data.day.day).toBe(new Date().toISOString().slice(0, 10));
  expect(data.day.blocks).toEqual([]);
  expect(data.day.problem).toBeNull();
  expect(data.week.week).toBe(weekOf(new Date().toISOString().slice(0, 10)));
  expect(data.week.days).toHaveLength(7);
  expect(data.week.rows).toEqual([]);
});

it('answers the download with a CSV of the week asked for', async () => {
  const answer = csv({ url: new URL('http://localhost/api/evidence/timesheet?week=2026-03-08') });
  const text = await answer.text();

  expect(answer.status).toBe(200);
  expect(answer.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  // The Monday of the week the day sits in, so a link may carry any day of it.
  expect(answer.headers.get('content-disposition')).toBe('attachment; filename="nolzu-timesheet-2026-03-02.csv"');
  expect(text).toBe('Card,Title,2026-03-02,2026-03-03,2026-03-04,2026-03-05,2026-03-06,2026-03-07,2026-03-08,Total minutes,Runs with no time\r\n');
});

it('falls back to this week when the query is no day', async () => {
  const answer = csv({ url: new URL('http://localhost/api/evidence/timesheet?week=last') });
  const week = weekOf(new Date().toISOString().slice(0, 10));

  expect(answer.headers.get('content-disposition')).toBe(`attachment; filename="nolzu-timesheet-${week}.csv"`);
  expect(await answer.text()).toContain(`Card,Title,${week},`);

  // The shape on its own is not enough. This one used to reach weekOf and throw, and a download
  // cannot show a person an error.
  const shaped = csv({ url: new URL('http://localhost/api/evidence/timesheet?week=2026-13-01') });
  expect(shaped.headers.get('content-disposition')).toBe(`attachment; filename="nolzu-timesheet-${week}.csv"`);
});

it('draws the day the URL asks for, and not today', async () => {
  const data = await page({ url: new URL(`http://localhost/evidence?day=${DAY}`) });

  expect(data.day.day).toBe(DAY);
  // The run and the move of that day, earliest first. Today has neither.
  expect(data.day.blocks.map((block) => block.start)).toEqual([`${DAY}T09:00:00.000Z`, `${DAY}T11:30:00.000Z`]);
  // Still the server's clock, and not the day that was asked for. The heading says "Today" off this
  // field, so a loader that handed the drawn day back would date April the 15th today.
  expect(data.today).toBe(today());
  expect(data.today).not.toBe(DAY);
});

it('draws the week the URL asks for, from any day of it', async () => {
  const data = await page({ url: new URL('http://localhost/evidence?week=2026-04-16') });

  // The Monday of the week the day sits in, the way the CSV route folds it.
  expect(data.week.week).toBe(WEEK);
  expect(data.week.days).toEqual(['2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16', '2026-04-17', '2026-04-18', '2026-04-19']);
  expect(data.week.rows.find((row) => row.key === 'APP-1')?.cells.map((cell) => cell.minutes)).toEqual([0, 0, 30, 0, 0, 0, 0]);
  // What the two week links carry.
  expect(data.weeks).toEqual({ previous: '2026-04-06', next: '2026-04-20' });
});

it('falls back to today and this week when neither query is a day', async () => {
  const data = await page({ url: new URL('http://localhost/evidence?day=last&week=nope') });

  expect(data.day.day).toBe(today());
  expect(data.today).toBe(today());
  expect(data.week.week).toBe(weekOf(today()));
});

it('falls back for a query that has the shape of a day but names no day', async () => {
  // A hand-edited URL. These all pass a `YYYY-MM-DD` shape test. `2026-13-01` is an Invalid Date, so
  // the week side threw out of weekOf and answered the error page, and the day side ended in the
  // banner that tells a person to check their project folder. `2026-02-30` is not an error at all:
  // it rolls over to 2 March, and the screen headed an always empty day with a date nobody has.
  for (const bad of ['2026-13-01', '2026-00-10', '2026-01-32', '2026-99-99', '2026-02-30']) {
    const data = await page({ url: new URL(`http://localhost/evidence?day=${bad}&week=${bad}`) });

    expect(data.day.day).toBe(today());
    expect(data.day.problem).toBeNull();
    expect(data.week.week).toBe(weekOf(today()));
  }
});

// The page itself, drawn. Until the `$app/paths` stub landed nothing could import this file, so the
// headings, the two week links and the CSV href were covered only through the loader and the child
// components, and a page that wired any of them to the wrong field stayed green.
//
// The data comes from the loader above, so no hand-built week can drift from the real shape, and
// `today` is written over on the way in. The clock is never asked here: the two headings say a word
// only while they are true, and a test that worked the day out the way the page does would say the
// same wrong thing.
describe('the page', () => {
  const display = (...features: string[]): DisplayEntitlement => ({ id: 'a', plan: 'solo', features, seats: 1, expiresAt: 0 });

  // The word in front of the date, read by the heading's own id, because "Day" is a part of "Today"
  // and a plain toContain would pass on either.
  const heading = (body: string, id: string) => new RegExp(`<h2 id="${id}"[^>]*>([^<]*)<`).exec(body)?.[1]?.trim();

  // `now` goes with `today`, because the timeline draws its now line off the server's clock.
  const drawn = async (over: { today: string; features?: string[] }) => {
    const data = await page({ url: new URL(`http://localhost/evidence?day=${DAY}&week=${WEEK}`) });
    // The screen these links are drawn on. The server writes every address relative to it, so the
    // hrefs below are the strings the app serves and not addresses from the root.
    drawnAt('/evidence');
    const now = `${over.today}T15:40:00.000Z`;
    return render(Evidence as never, { props: { data: { ...data, today: over.today, now, display: display(...(over.features ?? [])) } } } as never).body;
  };

  // The headings are "Timeline" and "Timesheet". What says the screen is on today is the
  // stepper, whose arrow after the day is off, and the now line on the timeline.
  it('stops the stepper at today and draws the now line while the screen is on today', async () => {
    const body = await drawn({ today: DAY });

    expect(heading(body, 'day-title')).toBe('Timeline');
    expect(heading(body, 'week-title')).toBe('Timesheet');
    expect(body).toContain('>Wed 15 Apr<');
    expect(body).toMatch(/<button[^>]*disabled[^>]*aria-label="Next day"/);
    expect(body).toContain('>15:40<');
    // The card on the timeline, linked to its log tab. Drawn by the day component off the loader's
    // own blocks, and the tab is named here, so a link pointed at another tab of the card fails.
    expect(body).toContain('href="./t/APP-1/log"');
  });

  it('steps to the next day and draws no now line once the screen is on another day', async () => {
    // A day in the next month, so the week the grid draws is not this week either.
    const body = await drawn({ today: '2026-05-01' });

    // No week in the link: the grid follows the day the arrow goes to.
    expect(body).toMatch(/<a href="\.\/evidence\?day=2026-04-16" aria-label="Next day"/);
    expect(body).not.toContain('>15:40<');
  });

  it('draws the timesheet of the day it steps to', async () => {
    const data = await page({ url: new URL('http://localhost/evidence?day=2026-04-16') });

    expect(data.day.day).toBe('2026-04-16');
    expect(data.week.week).toBe(WEEK);
  });

  // Older days are Solo. On Free the way back is locked with the one quiet line under it, read off
  // the signed display document, and Solo gets the arrow and the date field instead.
  it('locks the way back on Free with the Solo line, and opens it on Solo', async () => {
    const free = await drawn({ today: DAY });
    expect(free.match(/History is part of Solo/g)).toHaveLength(1);
    expect(free).toMatch(/<button[^>]*disabled[^>]*aria-label="Previous day, needs Solo"/);
    expect(free).not.toContain('data-pick=');

    const solo = await drawn({ today: DAY, features: [HISTORY_FEATURE] });
    expect(solo).not.toContain('History is part of Solo');
    expect(solo).toMatch(/<a href="\.\/evidence\?day=2026-04-14" aria-label="Previous day"/);
    expect(solo).toContain('data-pick="day"');
  });

  // The pinned day holds one run of half an hour that reported no cost, and one move.
  it('fills the stat tiles from the day, and makes up no cost', async () => {
    const body = (await drawn({ today: DAY })).replace(/<!--[^>]*-->/g, '');
    const tile = (label: string) => new RegExp(`data-stat="${label}"[^>]*>([\\s\\S]*?)</div>`).exec(body)?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    expect(tile('Agent time')).toBe('Agent time 30m 00s 1 card');
    expect(tile('Runs')).toBe('Runs 1 None running');
    expect(tile('Cards moved')).toBe('Cards moved 1 1 move');
    expect(tile('Cost')).toBe('Cost No run reported a cost');
  });

  // A Day | Week switch in the header. Week sums the tiles and the timeline over Mon to Sun,
  // and it is history, so Free locks it like the arrow back, with the one Solo line.
  const ranged = async (range: string, features: string[]) => {
    const data = await page({ url: new URL(`http://localhost/evidence?day=2026-04-16&range=${range}`) });
    drawnAt('/evidence');
    const now = `${DAY}T15:40:00.000Z`;
    return render(Evidence as never, { props: { data: { ...data, today: DAY, now, display: display(...features) } } } as never).body.replace(/<!--[^>]*-->/g, '');
  };

  it('sums the week on the Week view, and locks Week on Free', async () => {
    const tile = (body: string, label: string) =>
      new RegExp(`data-stat="${label}"[^>]*>([\\s\\S]*?)</div>`).exec(body)?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // The day after the run holds nothing, and its week holds the run and the move.
    const day = await ranged('day', [HISTORY_FEATURE]);
    expect(tile(day, 'Runs')).toBe('Runs 0 None on this day');
    expect(day).toMatch(/<a href="\.\/evidence\?day=2026-04-16" aria-current="page"[^>]*>Day<\/a>/);
    expect(day).toMatch(/<a href="\.\/evidence\?day=2026-04-16&amp;range=week"[^>]*>Week<\/a>/);

    const week = await ranged('week', [HISTORY_FEATURE]);
    expect(tile(week, 'Runs')).toBe('Runs 1 None running');
    expect(tile(week, 'Cards moved')).toBe('Cards moved 1 1 move');
    expect(week).toMatch(/aria-current="page"[^>]*>Week<\/a>/);
    expect(week).toContain('>13 to 19 Apr<');
    expect(week).toContain('aria-label="Previous week"');
    expect(week).toContain('href="./t/APP-1/log"');
    expect(week).toContain('>Wed 15<');
    expect(week).toMatch(/<h2 id="day-title"[^>]*>Timeline<span class="n[^"]*">1 card<\/span>/);

    // Free draws the day whatever the link asks for, with Week locked and one Solo line.
    const free = await ranged('week', []);
    expect(tile(free, 'Runs')).toBe('Runs 0 None on this day');
    expect(free).toMatch(/<button[^>]*disabled[^>]*aria-label="Week, needs Solo"/);
    expect(free.match(/History is part of Solo/g)).toHaveLength(1);
  });

  // The standup heading is plain, and the standup is three labelled lists with one note.
  it('draws the standup as Yesterday, Today and Blocked under a plain heading', async () => {
    const body = await drawn({ today: DAY });
    const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

    expect(heading(body, 'standup-title')).toBe('Standup');
    expect(body).toContain('id="standup-yesterday"');
    expect(body).toContain('id="standup-today"');
    expect(body).toContain('id="standup-blocked"');
    expect(text).toContain('Yesterday Tue 14 Apr');
    expect(text).toContain('Nothing is posted from here.');
    // Hours in UTC and the lane of work on no card stay, both true.
    expect(text).toContain('Hours in UTC');
    expect(text).toContain('Timeline 1 card');
  });

  // The page tells the day component whether the day is today, so an empty day reads "Nothing yet
  // today" only while it is not over.
  it('says an empty day is empty yet only while it is today', async () => {
    const empty = '2026-04-16';
    const data = await page({ url: new URL(`http://localhost/evidence?day=${empty}&week=${WEEK}`) });
    drawnAt('/evidence');
    const body = (today: string) => render(Evidence as never, { props: { data: { ...data, today, display: display() } } } as never).body;

    expect(body(empty)).toContain('Nothing yet today.');
    expect(body('2026-05-01')).not.toContain('Nothing yet today.');
  });

  it('carries the day on both week links, so paging a week keeps the timeline where it is', async () => {
    const body = await drawn({ today: DAY, features: [HISTORY_FEATURE] });

    expect(body).toContain('href="./evidence?week=2026-04-06&amp;day=2026-04-15"');
    expect(body).toContain('href="./evidence?week=2026-04-20&amp;day=2026-04-15"');
    // The words the next test looks for. Pinned here as well, so renaming a link cannot leave that
    // test passing on a page that shows both links to a plan which may not open another week.
    expect(body).toContain('Previous week');
    expect(body).toContain('Next week');
  });

  it('hides the week links on a plan that cannot open another week', async () => {
    const body = await drawn({ today: DAY });

    expect(body).not.toContain('Previous week');
    expect(body).not.toContain('Next week');
  });

  it('names the export destinations on a plan that holds a connection, and offers the connections', async () => {
    const body = await drawn({ today: DAY, features: [EXPORT_FEATURE] });

    expect(body).toContain('Sending a week to Toggl, Harvest, Clockify or Jira is part of Solo. Export posts it from this machine');
    // No tracker is connected yet, so there is no button to press, and the four forms are open.
    expect(body).not.toContain('Export this week');
    for (const destination of ['toggl', 'harvest', 'clockify', 'jira']) expect(body).toContain(`data-exporter="${destination}"`);
    expect(body).toContain('action="?week=2026-04-13&amp;day=2026-04-15&amp;/exporter#timesheet"');
  });

  it('shows the CSV and no destination on the free plan', async () => {
    const body = await drawn({ today: DAY });

    expect(body).toContain('href="./api/evidence/timesheet?week=2026-04-13"');
    // The one note under the timesheet names the trackers Solo sends to, and no Export.
    expect(body).not.toContain('Export posts it');
    expect(body).not.toContain('data-exporter=');
    expect(body).toContain('Send weeks to Toggl, Harvest or Clockify with Solo');
  });

  it('hands the download the week on screen', async () => {
    const body = await drawn({ today: DAY });

    // The Monday, because the route folds any day of a week to it and the file is named after it.
    expect(body).toContain('href="./api/evidence/timesheet?week=2026-04-13"');
  });
});

// Client and rate moved here from Settings, Project. The action saves the three fields together on
// every plan, a refusal stores none of them and keeps what was typed, and the form shows what is stored.
describe('client and rate', () => {
  const billed = actions as unknown as Record<string, (event: { url: URL; request: Request }) => Promise<unknown>>;
  const bill = (fields: Record<string, string>) =>
    billed.bill!({ url: new URL(`http://localhost/evidence?week=${WEEK}&day=${DAY}&/bill`), request: new Request('http://localhost/evidence', { method: 'POST', body: new URLSearchParams(fields) }) });
  const drawn = async (form: unknown = null) => {
    const data = await page({ url: new URL(`http://localhost/evidence?day=${DAY}&week=${WEEK}`) });
    drawnAt('/evidence');
    const display: DisplayEntitlement = { id: 'a', plan: 'free', features: [], seats: 1, expiresAt: 0 };
    return render(Evidence as never, { props: { data: { ...data, display }, form } } as never).body;
  };
  const field = (body: string, name: string) => new RegExp(`<input name="${name}"[^>]*>`).exec(body)?.[0] ?? '';

  it('saves the client, the rate and the currency, and draws them in the form', async () => {
    expect(await bill({ client: 'The recipe app', rate: '80', currency: 'eur' })).toEqual({ billed: true });

    const db = openDatabase(dir);
    expect([getSetting(db, 'clientName'), getSetting(db, 'hourlyRate'), getSetting(db, 'currency')]).toEqual(['The recipe app', 80, 'EUR']);
    db.close();
    const body = await drawn({ billed: true });
    expect(body).toContain('action="?week=2026-04-13&amp;day=2026-04-15&amp;/bill#billing"');
    expect(field(body, 'client')).toContain('value="The recipe app"');
    expect(field(body, 'rate')).toContain('value="80"');
    expect(field(body, 'currency')).toContain('value="EUR"');
    expect(body).toContain('Saved.');
  });

  it('refuses a rate that is not a number, stores nothing, and keeps what was typed', async () => {
    const answer = (await bill({ client: 'Another client', rate: 'eighty', currency: 'EUR' })) as { status: number; data: { billing: { field: string; message: string; typed: Record<string, string> } } };

    expect(answer.status).toBe(400);
    expect(answer.data.billing).toEqual({ field: 'hourlyRate', message: 'The hourly rate is a number, such as 80, or nothing at all.', typed: { client: 'Another client', rate: 'eighty', currency: 'EUR' } });
    const db = openDatabase(dir);
    expect(getSetting(db, 'clientName')).toBe('The recipe app');
    db.close();
    const body = await drawn(answer.data);
    expect(field(body, 'rate')).toContain('value="eighty"');
    expect(field(body, 'client')).toContain('value="Another client"');
    expect(body).toContain('The hourly rate is a number, such as 80, or nothing at all.');
  });
});

// "Bill this project?" on the first visit to the timesheet. It posts the same `bill` action as the
// fields at #billing, and the load stores the visit, so it never shows twice.
describe('the Bill this project? prompt', () => {
  const posted = actions as unknown as Record<string, (event: { url: URL; request: Request }) => Promise<unknown>>;
  const display: DisplayEntitlement = { id: 'a', plan: 'free', features: [], seats: 1, expiresAt: 0 };
  const draw = (data: object, form: unknown = null) => {
    drawnAt('/evidence');
    return render(Evidence as never, { props: { data: { ...data, display }, form } } as never).body;
  };
  const visit = async () => (await page({ url: new URL(`http://localhost/evidence?day=${DAY}&week=${WEEK}`) })) as unknown as { billingPrompt: boolean };
  // A project nobody asked yet: no client, no rate, and the visit not stored.
  const fresh = () => {
    const db = openDatabase(dir);
    writeSetting(db, 'clientName', null);
    writeSetting(db, 'hourlyRate', null);
    writeSetting(db, 'currency', 'USD');
    writeSetting(db, 'billingAsked', false);
    db.close();
  };

  it('shows only on the first timesheet visit, and keeps #billing for old links', async () => {
    fresh();

    const first = await visit();
    expect(first.billingPrompt).toBe(true);
    const asked = draw(first);
    expect(asked).toContain('Bill this project?');
    expect(asked).toMatch(/<section class="bill[^"]*" id="billing"/);
    expect(asked).toContain('Not now');

    const second = await visit();
    expect(second.billingPrompt).toBe(false);
    const later = draw(second);
    expect(later).not.toContain('Bill this project?');
    // The same three fields, folded, where an old /evidence#billing link lands.
    expect(later).toMatch(/<details class="bill[^"]*" id="billing"/);
    expect(later).toContain('Client and rate');
    expect(later).toMatch(/<input name="client"/);
  });

  it('saves the three fields from the prompt, and does not come back after the save', async () => {
    fresh();
    const body = draw(await visit());
    const prompt = /<section class="bill[^"]*" id="billing"[\s\S]*?<\/section>/.exec(body)?.[0] ?? '';
    // What a browser posts when a person fills the three boxes by their labels and presses Save:
    // every named control of the form, under the name it draws.
    const typed: Record<string, string> = { client: 'The recipe app', rate: '95', currency: 'gbp' };
    const fields: Record<string, string> = {};
    for (const [tag] of prompt.matchAll(/<input\b[^>]*>/g)) {
      const name = /\bname="([^"]*)"/.exec(tag)?.[1];
      if (name !== undefined) fields[name] = typed[name] ?? '';
    }
    expect(Object.keys(fields)).toEqual(['client', 'rate', 'currency']);
    const action = /<form[^>]*action="([^"]*)"/.exec(prompt)?.[1]?.replaceAll('&amp;', '&') ?? '';
    expect(action).toBe('?week=2026-04-13&day=2026-04-15&/bill#billing');

    const answer = await posted.bill!({ url: new URL(`http://localhost/evidence${action}`), request: new Request('http://localhost/evidence', { method: 'POST', body: new URLSearchParams(fields) }) });

    expect(answer).toEqual({ billed: true });
    const db = openDatabase(dir);
    expect([getSetting(db, 'clientName'), getSetting(db, 'hourlyRate'), getSetting(db, 'currency')]).toEqual(['The recipe app', 95, 'GBP']);
    db.close();
    // The page that answers the save: no prompt, the fields open with what was saved.
    const after = draw(await visit(), answer);
    expect(after).not.toContain('Bill this project?');
    expect(after).toMatch(/<details class="bill[^"]*" id="billing" open/);
    expect(after).toContain('The recipe app, 95 GBP an hour');
    expect(after).toContain('Saved.');
  });

  // A client or a rate saved before is an answer, so a fresh visit has nothing to ask.
  it('does not ask a project that has a client already', async () => {
    fresh();
    const db = openDatabase(dir);
    writeSetting(db, 'clientName', 'The recipe app');
    db.close();

    expect((await visit()).billingPrompt).toBe(false);
  });
});

// The Export button, end to end: the connection saved through its form, the week posted through the
// action, and the second press. The fetch is a Toggl held in memory, so no call leaves the process.
describe('the Export button', () => {
  // Words on purpose, so the secret scanner in CI leaves it alone.
  const TOKEN = 'tgl_not-a-real-token-for-the-evidence-route';
  const toggl = { held: [] as Record<string, unknown>[], posts: 0 };
  const exported = actions as unknown as Record<string, (event: { url: URL; request?: Request }) => Promise<unknown>>;
  const press = () => exported.export!({ url: new URL(`http://localhost/evidence?week=${WEEK}&day=${DAY}&/export`) });
  const connect = (fields: Record<string, string>) =>
    exported.exporter!({ url: new URL('http://localhost/evidence?/exporter'), request: new Request('http://localhost/evidence', { method: 'POST', body: new URLSearchParams(fields) }) });
  const stored = () => {
    const db = openDatabase(dir);
    const rows = [...db.prepare('SELECT * FROM exporters').all(), ...db.prepare('SELECT * FROM export_entries').all()];
    db.close();
    return rows.map((row) => Object.values(row).join('|')).join('\n');
  };

  beforeAll(() => {
    // A plan with the export feature, because both actions ask for it on every post.
    plan.features = [EXPORT_FEATURE];
    // A project folder, because the entries are filed under the project id the export mints.
    const db = openDatabase(dir);
    writeSetting(db, 'projectPath', dir);
    db.close();
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const at = new URL(url);
      if (at.hostname !== 'api.track.toggl.com') throw new Error(`No call may leave the test, and this one went to ${at.hostname}.`);
      if (init.method === 'GET') return new Response(JSON.stringify(toggl.held), { status: 200 });
      toggl.posts += 1;
      const one = { ...(JSON.parse(String(init.body)) as Record<string, unknown>), id: 5000 + toggl.held.length };
      toggl.held.push(one);
      return new Response(JSON.stringify(one), { status: 200 });
    });
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('saves a connection from the form the page draws, with the names the action reads', async () => {
    const data = await page({ url: new URL(`http://localhost/evidence?day=${DAY}&week=${WEEK}`) });
    const display: DisplayEntitlement = { id: 'a', plan: 'solo', features: [EXPORT_FEATURE], seats: 1, expiresAt: 0 };
    drawnAt('/evidence');
    const body = render(Evidence as never, { props: { data: { ...data, display }, form: null } } as never).body;
    const toggl = /<form[^>]*data-exporter="toggl"[^>]*>[\s\S]*?<\/form>/.exec(body)?.[0] ?? '';
    // What a browser posts when a person fills the two boxes by their labels and presses Save: every
    // named control the form draws, under the name it draws. A new connection has one button.
    const typed: Record<string, string> = { 'export-toggl-workspace': '42', 'export-toggl-secret': TOKEN };
    const posted: Record<string, string> = {};
    for (const [tag] of toggl.matchAll(/<(?:input|button)\b[^>]*>/g)) {
      const name = /\bname="([^"]*)"/.exec(tag)?.[1];
      if (name !== undefined) posted[name] = typed[/\bid="([^"]*)"/.exec(tag)?.[1] ?? ''] ?? /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? '';
    }

    expect(await connect(posted)).toMatchObject({ connection: { ok: true, did: 'save', destination: 'toggl' } });
    expect(keys.get('export-toggl')).toBe(TOKEN);
    expect(await connect({ do: 'remove', destination: 'toggl' })).toMatchObject({ connection: { ok: true } });
  });

  // A post made by hand: the page draws neither form without the feature.
  it('refuses both actions on a plan without the export feature, and changes nothing', async () => {
    // Saved while the plan holds the feature, so the press below has a tracker it could reach.
    expect(await connect({ do: 'save', destination: 'toggl', workspace: '42', secret: TOKEN })).toMatchObject({ connection: { ok: true } });
    const before = stored();
    const NO_CONNECTION = 'Connecting a time tracker is part of Solo. This machine is on the free plan, so no connection was saved or removed.';
    plan.features = [];
    reads.length = 0;
    try {
      expect(await connect({ do: 'save', destination: 'harvest', account: '1', project: '2', task: '3', secret: 'hvst_not-a-real-token' })).toMatchObject({
        status: 400,
        data: { connection: { ok: false, did: '', destination: '', message: NO_CONNECTION } },
      });
      expect(await connect({ do: 'remove', destination: 'toggl' })).toMatchObject({
        status: 400,
        data: { connection: { ok: false, did: '', destination: '', message: NO_CONNECTION } },
      });
      expect(await press()).toMatchObject({
        status: 400,
        data: { exported: ['Sending a week to a time tracker is part of Solo. This machine is on the free plan, so nothing was sent. The CSV works on every plan.'] },
      });

      expect(toggl.posts).toBe(0);
      // The plan is asked before any tracker token is read. The document read itself is stubbed above.
      expect(reads).toEqual([]);
      expect([...keys]).toEqual([['export-toggl', TOKEN]]);
      expect(stored()).toBe(before);
      // The press stopped before the export minted the project id its entries are filed under.
      const db = openDatabase(dir);
      expect(getSetting(db, 'exportProjectId')).toBeNull();
      db.close();
    } finally {
      plan.features = [EXPORT_FEATURE];
    }
    // Removed with the feature back, so the next test starts with no connection, as before.
    expect(await connect({ do: 'remove', destination: 'toggl' })).toMatchObject({ connection: { ok: true } });
  });

  it('posts the week once, and a second press writes nothing new', async () => {
    expect(await connect({ do: 'save', destination: 'toggl', workspace: '42', secret: TOKEN })).toMatchObject({ connection: { ok: true, did: 'save' } });
    expect(keys.get('export-toggl')).toBe(TOKEN);

    expect(await press()).toEqual({ exported: ['Toggl: posted 1 entry.'] });
    expect(toggl.posts).toBe(1);
    expect(toggl.held[0]).toMatchObject({ workspace_id: 42, duration: 1800, description: 'APP-1 Add a search box', start: `${DAY}T09:00:00.000Z` });
    const after = stored();

    expect(await press()).toEqual({ exported: ['Toggl: posted nothing new. Skipped 1 entry that was sent before.'] });
    expect(toggl.posts).toBe(1);
    // The entry rows are what they were. Only the connection's own stamp of its last export moved.
    const entries = (text: string) => text.split('\n').filter((line) => line.startsWith('toggl|nolzu:'));
    expect(entries(stored())).toEqual(entries(after));
    expect(entries(after)).toHaveLength(1);
  });

  it('marks the cell that went, and draws the button with what the press said', async () => {
    const data = await page({ url: new URL(`http://localhost/evidence?day=${DAY}&week=${WEEK}`) });
    const loaded = data as unknown as { sync: unknown; shown: unknown };

    expect(loaded.shown).toEqual({ destination: 'toggl', label: 'Toggl' });
    expect(loaded.sync).toEqual([{ card: 'APP-1', day: DAY, state: 'sent', reason: null }]);

    drawnAt('/evidence');
    const display: DisplayEntitlement = { id: 'a', plan: 'solo', features: [EXPORT_FEATURE], seats: 1, expiresAt: 0 };
    const form = { exported: ['Toggl: posted nothing new. Skipped 1 entry that was sent before.'] };
    const body = render(Evidence as never, { props: { data: { ...data, display }, form } } as never).body;

    // The tracker the marks are for rides along, so the page that answers the press draws the same marks.
    expect(body).toContain('action="?week=2026-04-13&amp;day=2026-04-15&amp;to=toggl&amp;/export#timesheet"');
    // A past week is not "this week", and has no today to warn about.
    expect(body).toContain('Export the week<');
    expect(body).not.toContain('Export this week');
    expect(body).not.toContain('Today goes with');
    expect(body).toContain('Posts the week on screen to Toggl.');
    expect(body).toContain('Toggl: posted nothing new. Skipped 1 entry that was sent before.');
    expect(body).toContain(`data-sync="APP-1 ${DAY}"`);
    expect(body).toContain('for Toggl.');
    // The stored workspace fills its field again, and the token field stays empty.
    expect(body).toMatch(/name="workspace"[^>]*value="42"/);
    for (const text of [body, JSON.stringify(data), stored()]) expect(text).not.toContain(TOKEN);

    const now = render(Evidence as never, { props: { data: { ...data, today: DAY, display }, form: null } } as never).body;
    expect(now).toContain('Export this week');
    expect(now).toContain('Today goes with the minutes it has now, and minutes added to it later are not sent.');
  });

  it('draws the marks of the tracker the address names, and links to the other one', async () => {
    expect(await connect({ do: 'save', destination: 'harvest', account: '1', project: '2', task: '3', secret: 'hvst_not-a-real-token' })).toMatchObject({
      connection: { ok: true },
    });
    const display: DisplayEntitlement = { id: 'a', plan: 'solo', features: [EXPORT_FEATURE], seats: 1, expiresAt: 0 };
    const at = (query: string) => page({ url: new URL(`http://localhost/evidence?day=${DAY}&week=${WEEK}${query}`) });
    const draw = (data: object) => {
      drawnAt('/evidence');
      return render(Evidence as never, { props: { data: { ...data, display }, form: null } } as never).body;
    };

    // No `?to=`: the first connection in the order the forms list them.
    expect(await at('')).toMatchObject({ shown: { destination: 'toggl' }, sync: [{ card: 'APP-1', state: 'sent' }] });

    const harvest = await at('&to=harvest');
    expect(harvest).toMatchObject({ shown: { destination: 'harvest', label: 'Harvest' }, sync: [] });
    // The sentence wraps in the source, so the line breaks are read as the spaces a browser shows.
    const body = draw(harvest).replace(/\s+/g, ' ');
    expect(body).toContain('The marks in the grid are for Harvest.');
    expect(body).not.toContain(`data-sync="APP-1 ${DAY}"`);
    expect(body).toMatch(/href="[^"]*week=2026-04-13&amp;day=2026-04-15&amp;to=toggl#timesheet"[^>]*>Show the Toggl marks</);
    expect(body).not.toContain('Show the Harvest marks');
    expect(body).toContain('&amp;to=harvest&amp;/export#timesheet"');

    // A name that is no connection falls back to the first one.
    expect(await at('&to=timely')).toMatchObject({ shown: { destination: 'toggl' } });
    expect(await connect({ do: 'remove', destination: 'harvest' })).toMatchObject({ connection: { ok: true } });
  });

  it('takes the connection and its token away, and keeps the entry that went', async () => {
    expect(await connect({ do: 'remove', destination: 'toggl' })).toMatchObject({ connection: { ok: true, did: 'remove' } });

    expect(keys.has('export-toggl')).toBe(false);
    expect(stored().split('\n').filter((line) => line.startsWith('toggl|nolzu:'))).toHaveLength(1);
    // With no connection the press is refused, and nothing reaches Toggl.
    expect(await press()).toMatchObject({ status: 400, data: { exported: ['No time tracker is connected. Connect one below, then press Export.'] } });
    expect(toggl.posts).toBe(1);
  });

  // A second data folder on the machine keeps its own tracker token, so both actions open the keychain
  // of the folder this app runs on, and not the default one. The plan check builds one of its own too.
  it('opens the keychain of this data folder for both actions', async () => {
    folders.length = 0;

    await connect({ do: 'remove', destination: 'toggl' });
    await press();

    expect(folders.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(folders)]).toEqual([dir]);
  });
});
