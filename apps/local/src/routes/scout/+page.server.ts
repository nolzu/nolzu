import { fail } from '@sveltejs/kit';
import { getSetting, resolveDataDir } from '@nolzu/core/node';
import { createKeychain, runKeychain } from '@nolzu/runner';
import { database } from '$lib/db.ts';
import { shows } from '$lib/display.ts';
import { currentDisplay, localCloud } from '$lib/display-sync.ts';
import { sendToHub } from '$lib/hub-link.ts';
import { loop } from '$lib/loop.ts';
import { scoutActions } from '$lib/scout-actions.ts';
import { checkAllSources, saveAndCheck } from '$lib/scout-check-all.ts';
import { testConnection } from '$lib/scout-connection.ts';
import { scoutPage } from '$lib/scout-page.ts';
import { SCHEDULE_FEATURE } from '$lib/scout-schedule.ts';
import { checkLogQuery } from '$lib/scout-search.ts';
import { checkSentryIssues } from '$lib/scout-sentry.ts';
import { checkFirstPaste, checkScoutSource, type HubDeps, saveScoutSchedule } from '$lib/scout-sources.ts';
import { checkTicketQuery } from '$lib/scout-tickets.ts';
import type { Actions, PageServerLoad } from './$types';

// The findings, the sources, and the finding seen last on show. The sources sat in Settings, Scout
// until Scout got them.
export const load: PageServerLoad = () => scoutPage();

// How this screen reaches the hub. Two actions need it: the schedule a person saves, and the remove
// that has to stop a schedule the hub still holds.
const hubDeps = (): HubDeps => ({
  projectId: getSetting(database(), 'projectId'),
  send: (schedule) => sendToHub('scout.schedule', schedule, loop().project),
});

// A check that worked tells the loop, whose change report sends the findings to the hub. A refused
// check wrote nothing, so it says nothing.
const afterCheck = <T extends { ok: boolean }>(answer: T): T => {
  if (answer.ok) loop().changed();
  return answer;
};

// The four finding writers live in $lib, because one finding's own page offers the same buttons and
// both screens have to answer a person the same way. They answer with `did`; the source actions below
// answer with `field`, so the page prints each under the panel it came from.
export const actions: Actions = {
  ...scoutActions,
  // The one source action that writes outside sqlite. The keychain is built here, the way
  // `bin/nolzu.js` builds it, and the save reaches for it only after the form is accepted.
  // "Add and check now" posts `check`, and the new source is read once through its own check. A
  // pasted text source has no text yet, so it is only added.
  scout: async ({ request }) => {
    const keychain = createKeychain(process.platform, runKeychain, resolveDataDir(process.env));
    const { answer, checked } = await saveAndCheck(database(), keychain, await request.formData(), hubDeps());
    if (!answer.ok) return fail(400, { field: answer.did, message: answer.message });
    if (checked === null) return { field: answer.did, saved: true };
    afterCheck(checked);
    return { field: answer.did, saved: true, checked: checked.checked, message: checked.message };
  },
  // Test the connection: one read with the dialog's unsaved form. It stores nothing and reads no row,
  // and it answers into the dialog, so the field is its own.
  test: async ({ request }) => {
    const answer = await testConnection(createKeychain(process.platform, runKeychain, resolveDataDir(process.env)), await request.formData());
    return answer.ok ? { field: 'test', readable: answer.readable ?? '', where: answer.where ?? '', took: answer.took ?? '' } : fail(400, { field: 'test', message: answer.message });
  },
  // Its own action and not a fourth word on `scout`, because the answer carries a sentence about two
  // numbers and because no keychain is built here: a pasted source holds no credential, and a
  // keychain call can put an OS password dialog in front of the person. The pasted text is read from
  // the post and never answered back, so the box comes up empty when the page renders again.
  check: async ({ request }) => {
    const answer = afterCheck(checkScoutSource(database(), await request.formData()));
    return answer.ok
      ? { field: 'check', checked: answer.checked, saved: true }
      : fail(400, { field: 'check', message: answer.message });
  },
  // The first visit's paste box: the text checked with the pasted text source, made on the way when
  // there is none. It answers as a check does, so the line prints under the sources strip the page
  // shows next.
  firstPaste: async ({ request }) => {
    const answer = afterCheck(checkFirstPaste(database(), await request.formData()));
    return answer.ok
      ? { field: 'check', checked: answer.checked, saved: true }
      : fail(400, { field: 'check', message: answer.message });
  },
  // Check all sources, from the button in the top bar and from the palette, which presses it. Every
  // source a press can read, through its own check, with one keychain built the way `scout` builds it.
  // A check that read something tells the loop, as one source's check does.
  checkAll: async () => {
    const answer = await checkAllSources(database(), createKeychain(process.platform, runKeychain, resolveDataDir(process.env)));
    if (answer.ok) loop().changed();
    return answer.ok
      ? { field: 'checkAll', checked: answer.said, failed: answer.failed, saved: true }
      : fail(400, { field: 'checkAll', message: answer.said, failed: answer.failed });
  },
  // A third action, because a ticket query is read over the network and a Jira one needs its token.
  // The keychain is built here the way `scout` builds it. Building it makes no call: the read happens
  // inside the check and only for a Jira source, so pressing this on a GitHub or a GitLab source
  // cannot put an OS password dialog on the screen. The field is `check`, so the screen prints the sentence the same
  // way it prints a paste check's.
  checkTickets: async ({ request }) => {
    const answer = afterCheck(await checkTicketQuery(database(), createKeychain(process.platform, runKeychain, resolveDataDir(process.env)), await request.formData()));
    return answer.ok
      ? { field: 'check', checked: answer.checked, saved: true }
      : fail(400, { field: 'check', message: answer.message });
  },
  // A fourth action, for the same reason the ticket one is its own: Sentry is read over the network
  // and its Auth token is in the keychain, which is built here the way `scout` builds it. The field is
  // `check`, so the screen prints the sentence the same way it prints a paste check's.
  checkSentry: async ({ request }) => {
    const answer = afterCheck(await checkSentryIssues(database(), createKeychain(process.platform, runKeychain, resolveDataDir(process.env)), await request.formData()));
    return answer.ok
      ? { field: 'check', checked: answer.checked, saved: true }
      : fail(400, { field: 'check', message: answer.message });
  },
  // A fifth one, for the same reasons as `checkTickets`: a log query is read over the network and it
  // needs its API key, so the keychain is built here. Building it makes no call, and the keychain is
  // read inside the check, after the cheap checks on the stored address and index have run. The post
  // carries the source id and nothing else.
  checkLogs: async ({ request }) => {
    const answer = afterCheck(await checkLogQuery(database(), createKeychain(process.platform, runKeychain, resolveDataDir(process.env)), await request.formData()));
    return answer.ok
      ? { field: 'check', checked: answer.checked, saved: true }
      : fail(400, { field: 'check', message: answer.message });
  },
  /**
   * One source's schedule, stored here and sent to the hub.
   *
   * Its own action and not a word on `scout`: a label edit has no business putting a frame on the
   * socket, and the plan is asked here alone. The document is read again rather than taken from the
   * load, because a post is not a page load and the screen is not what may decide this.
   */
  schedule: async ({ request }) => {
    const display = await currentDisplay(localCloud());
    const answer = saveScoutSchedule(database(), await request.formData(), { ...hubDeps(), allowed: shows(display, SCHEDULE_FEATURE) });
    // The word comes with the answer, the way the `scout` action takes its own: what the hub did or
    // did not get is decided where the frame is sent and is pinned by that module's tests.
    return answer.ok
      ? { field: answer.did, saved: true }
      : fail(400, { field: answer.did, message: answer.message });
  },
};
