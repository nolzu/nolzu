import { fail } from '@sveltejs/kit';
import { resolveDataDir } from '@nolzu/core/node';
import { isDay, weekOf } from '@nolzu/protocol';
import { createKeychain, runKeychain } from '@nolzu/runner';
import { database } from '$lib/db.ts';
import { EXPORT_FEATURE, shows } from '$lib/display.ts';
import { currentDisplay, localCloud } from '$lib/display-sync.ts';
import { evidenceFor, runPhases, standupFor } from '$lib/evidence.ts';
import { dayShift, weekEvidence } from '$lib/evidence-timeline.ts';
import { billingFor, billingPrompt, saveBilling, timesheetFor, weekShift } from '$lib/timesheet.ts';
import { EXPORTER_FORMS, exporters, exportWeek, postExporter, timesheetSync } from '$lib/timesheet-export.ts';
import type { Actions, PageServerLoad } from './$types';

// `?day=` is the day the timeline draws, `?week=` any day of the week the grid draws. With no week the
// grid draws the day's own week, so the stepper's arrows move both. The day is the UTC day,
// so the timeline and the cost roll-up never disagree about which day a run belongs to.
//
// Whatever the plan says, the URL is read. The plan gates what the screen draws, and these rows sit
// on the person's own disk, so a loader that refused a day would hide a person's own data from them
// and still not be enforcement.
//
// Anything that is not a day that exists falls back to today and this week, the way the CSV route
// beside this one already does. `isDay` and not a shape test: `2026-13-01` has the shape and throws
// out of `weekOf` and out of the evidence window. A hand-edited URL answers with a screen, not with
// an error.
function askedDay(url: URL, field: string): string | undefined {
  const asked = url.searchParams.get(field);
  return asked !== null && isDay(asked) ? asked : undefined;
}

const askedWeek = (url: URL) => {
  const asked = askedDay(url, 'week') ?? askedDay(url, 'day');
  return timesheetFor(database(), { week: asked === undefined ? undefined : weekOf(asked) });
};

export const load: PageServerLoad = async ({ url }) => {
  const day = askedDay(url, 'day');
  const week = askedWeek(url);
  // Rows only. A token is in the OS keychain, and reading it here would ask the person for their
  // keychain password every time they open this screen.
  const connected = exporters(database());
  // The tracker the grid's marks are for: the one `?to=` names, or the first connection.
  const shown = connected.find((one) => one.destination === url.searchParams.get('to')) ?? connected[0] ?? null;
  const evidence = await evidenceFor(database(), { day });
  // `?range=week` sums the seven days of the day's week, Mon to Sun, for the tiles and the timeline.
  // Limit: one read per day, so seven git calls; read the week in one call if it ever feels slow.
  const range = url.searchParams.get('range') === 'week' ? 'week' : 'day';
  const monday = weekOf(evidence.day);
  const period =
    range === 'week'
      ? weekEvidence(monday, await Promise.all(Array.from({ length: 7 }, (_, index) => dayShift(monday, index)).map((one) => (one === evidence.day ? evidence : evidenceFor(database(), { day: one })))))
      : null;
  // The server's clock, once. The timeline draws its now line from it and the stepper stops at
  // today, and the screen draws the same before and after hydration.
  const now = new Date().toISOString();
  return {
    day: evidence,
    range,
    // The week summed, or null on the Day view.
    period,
    phases: runPhases(database(), period ?? evidence),
    standup: await standupFor(database(), { day }),
    week,
    now,
    today: now.slice(0, 10),
    weeks: { previous: weekShift(week.week, -1), next: weekShift(week.week, 1) },
    exporters: connected,
    forms: EXPORTER_FORMS,
    shown: shown === null ? null : { destination: shown.destination, label: shown.label },
    sync: shown === null ? null : timesheetSync(database(), week, shown.destination),
    // True on the first visit only. The call records the visit, so the prompt never shows twice.
    billingPrompt: billingPrompt(database()),
    billing: billingFor(database()),
  };
};

// Both export actions ask the plan on every post, the way the Scout schedule action does. Hiding the panel on
// Free does not stop a hand post. This is a plan check the maintainer agreed to, as AGENTS.md
// rule 2 asks.
const canExport = async (): Promise<boolean> => shows(await currentDisplay(localCloud()), EXPORT_FEATURE);

// A page on Free draws no panel, so a person who posts by hand reads the timesheet's free plan line.
// These sentences reach only a caller that reads the answer itself. A remove is refused as well, the
// way the schedule action refuses a stop.
const NO_EXPORT = 'Sending a week to a time tracker is part of Solo. This machine is on the free plan, so nothing was sent. The CSV works on every plan.';
const NO_CONNECTION = 'Connecting a time tracker is part of Solo. This machine is on the free plan, so no connection was saved or removed.';

// The two export actions build the keychain the way the settings actions do: here, after the post arrived,
// and never in the load. The plan is asked first, so a refused post reads no tracker token, no ledger
// and no tracker.
export const actions: Actions = {
  // Client and rate, on every plan: they are the person's own answers, and only Solo reads them. A
  // refusal sends back what was typed, so the boxes still show it.
  bill: async ({ request }) => {
    const form = await request.formData();
    const typed = { client: form.get('client')?.toString() ?? '', rate: form.get('rate')?.toString() ?? '', currency: form.get('currency')?.toString() ?? '' };
    const refused = saveBilling(database(), typed);
    return refused === null ? { billed: true } : fail(400, { billing: { ...refused, typed } });
  },
  // The week the address names, so the press posts the grid the person was looking at.
  export: async ({ url }) => {
    if (!(await canExport())) return fail(400, { exported: [NO_EXPORT] });
    const answer = await exportWeek(database(), createKeychain(process.platform, runKeychain, resolveDataDir(process.env)), askedWeek(url), Date.now());
    return answer.ok ? { exported: answer.lines } : fail(400, { exported: answer.lines });
  },
  exporter: async ({ request }) => {
    if (!(await canExport())) return fail(400, { connection: { ok: false, did: '', destination: '', message: NO_CONNECTION } });
    const answer = await postExporter(database(), createKeychain(process.platform, runKeychain, resolveDataDir(process.env)), await request.formData(), Date.now());
    return answer.ok ? { connection: answer } : fail(400, { connection: answer });
  },
};
