import { readFileSync } from 'node:fs';
import type { HubStatus } from '@nolzu/runner';
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { cloudConnection, cloudState, LOCAL_ONLY, offlineBanner, SYNC_PAUSED } from './cloud-status.ts';
import { FREE } from './display.ts';
import CloudStatus from './CloudStatus.svelte';

// The connection state on screen. The words come from `HubStatus` in `packages/runner/src/hub.ts`,
// so the screen and the client never name the same connection in two vocabularies.

// Every status the client can report, spelled out. A new one added to `HubStatus` fails the typecheck
// here and in `cloud-status.ts`, so neither list can quietly miss a state.
const ALL: readonly HubStatus[] = ['connecting', 'open', 'waiting', 'refused', 'unpaid', 'closed'];

// The word and one phrase of the sentence each state has to show, written out here and never read
// back from `cloud-status.ts`. Read the expected text out of the table the component draws from and
// the test only proves the component draws something: two entries swapped, and a connected machine
// could say Offline with the suite green.
const SHOWS: Record<HubStatus, { word: string; phrase: string }> = {
  connecting: { word: 'Connecting', phrase: 'opening the connection to the cloud' },
  open: { word: 'Connected', phrase: 'This machine is connected' },
  waiting: { word: 'Reconnecting', phrase: 'dials again after a wait' },
  refused: { word: 'Refused', phrase: 'refused this machine' },
  unpaid: { word: 'Local only', phrase: 'does not include the cloud board' },
  closed: { word: 'Offline', phrase: 'not connected to the cloud' },
};

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const shown = (status: HubStatus) => text(render(CloudStatus, { props: { status } }).body);

describe('the sentence for each state', () => {
  it.each(ALL)('draws its own word and sentence for %s', (status) => {
    const drawn = shown(status);

    expect(drawn).toContain(SHOWS[status].word);
    expect(drawn).toContain(SHOWS[status].phrase);
    // The component draws the table's sentence whole, and not a line of its own.
    expect(drawn).toContain(cloudConnection(status).sentence);
  });

  it('gives no two states the same word or the same sentence', () => {
    const words = ALL.map((status) => cloudConnection(status).word);
    const sentences = ALL.map((status) => cloudConnection(status).sentence);

    expect(new Set(words).size).toBe(ALL.length);
    expect(new Set(sentences).size).toBe(ALL.length);
  });

  // The state is in an attribute as well as in the word, so the colour is never the only thing that
  // says which state it is.
  it.each(ALL)('marks the panel with the status %s', (status) => {
    expect(render(CloudStatus, { props: { status } }).body).toContain(`data-status="${status}"`);
  });

  // The cloud connection states include offline with runs queued,
  // and both down states are offline to the person reading them: `waiting` is Nolzu still dialling,
  // `closed` is a signed-in machine whose dial never came up.
  it('says the cloud keeps the work while the connection is down', () => {
    expect(shown('waiting')).toContain('waits in the queue');
    expect(shown('closed')).toContain('waits there until this machine connects again');
  });
});

describe('a refused machine', () => {
  // A 4401 and a 4426 both stop the client for good. Waiting fixes neither, so the screen says what to
  // do on this machine instead of promising another attempt.
  it('says to run the login again, and does not claim Nolzu will try again', () => {
    const drawn = shown('refused');

    expect(drawn).toContain('npx nolzu@latest login');
    expect(drawn).toContain('stopped dialling');
    expect(drawn).not.toContain('dials again');
  });

  it('offers no button to retry', () => {
    expect(render(CloudStatus, { props: { status: 'refused' } }).body).not.toContain('<button');
  });

  // The three states nothing leaves by itself. `closed` joined with Connect again.
  it('shares the fix with the other two stopped states, and with no fourth one', () => {
    const withFix = ALL.filter((status) => cloudConnection(status).fix !== null);

    expect(withFix).toEqual(['refused', 'unpaid', 'closed']);
  });

  // `nolzu login` is its own process and the dial is not, so the login alone changes nothing in the
  // running server. The page load after it does: `dialHubAgain` in `hub-link.ts` dials once on the
  // document that load fetches. So the reload comes after the login and before the restart, and the
  // restart stays as the fallback.
  it('names the login, then the reload, and keeps the restart last', () => {
    const fix = cloudConnection('refused').fix ?? '';

    expect(fix).toContain('Restart Nolzu');
    expect(fix.indexOf('npx nolzu@latest login')).toBeLessThan(fix.indexOf('reload this screen'));
    expect(fix.indexOf('reload this screen')).toBeLessThan(fix.indexOf('Restart Nolzu'));
  });

  // The wait this state really has, said out loud. A revoked token fails `/access` too, so the document
  // the load before the login fetched is `FREE`, and `currentDisplay` holds it for `RETRY_AFTER_SECONDS`.
  // Until it asks again, the reload after the login fetches the same document and `dialHubAgain` sees no
  // change, so a fix that promised one reload would send a paying person to the restart.
  it('says the sign-in can take a minute, so one reload is not read as the answer', () => {
    const fix = cloudConnection('refused').fix ?? '';

    expect(fix).toContain('can take a minute');
    expect(fix).toContain('reload again if nothing changed');
    expect(fix.indexOf('can take a minute')).toBeLessThan(fix.indexOf('Restart Nolzu'));
  });
});

// A 4402 close. The hub serves no cloud board to this account, so the client stops dialling, and the
// screen has two readers: the Free machine that never asked for the cloud, and the person who pays and
// should not be here.
describe('a machine whose plan does not open the hub', () => {
  it('reads as a fact and not as a fault', () => {
    const drawn = shown('unpaid');

    expect(drawn).toContain('Local only');
    expect(drawn).toContain('does not include the cloud board');
    expect(drawn).toContain('works whole without it');
    expect(drawn).not.toContain('refused');
    expect(drawn).not.toContain('dials again');
  });

  // Red here would call a Free machine broken. The word carries the state either way, so the state with
  // no colour rule of its own reads in the default ink.
  it('gets no colour rule of its own, so no screen draws it as a fault', () => {
    const source = readFileSync(new URL('./CloudStatus.svelte', import.meta.url), 'utf8');

    // Quote-insensitive, because nothing in this repository normalises CSS quoting, so a rule written
    // with double quotes would slip past a plain string search.
    expect(source).toMatch(/\[data-status=['"]refused['"]\]/);
    expect(source).not.toMatch(/\[data-status=['"]unpaid['"]\]/);
  });

  // The ordinary path, and the one a fix about accounts gets wrong: a Free machine reads this, the
  // person buys the plan in the browser, and comes back. The document that load fetches carries the new
  // plan, and `dialHubAgain` in `hub-link.ts` dials on it, so the reload is the fix for the reader who
  // just paid. A restart first would ask a paying customer to stop the app in their first minute.
  it('names the reload first, and keeps the restart as the fallback', () => {
    const fix = cloudConnection('unpaid').fix ?? '';

    expect(fix).toContain('reload this screen');
    expect(fix).toContain('Restart Nolzu');
    expect(fix.indexOf('reload this screen')).toBeLessThan(fix.indexOf('npx nolzu@latest login'));
    expect(fix.indexOf('npx nolzu@latest login')).toBeLessThan(fix.indexOf('Restart Nolzu'));
  });

  // Two loads and not one. The settings load reads `hubStatus()` in a load that does not await the
  // layout's, so it is built while the document is still being fetched and draws the word the last dial
  // left. The dial the document starts reads the keychain before it says `connecting`. So the load that
  // dials cannot show it, and a fix promising one reload would send a paying person to the restart.
  it('asks for two loads, because the load that dials cannot show the connection', () => {
    const fix = cloudConnection('unpaid').fix ?? '';

    expect(fix).toContain('reload this screen twice');
    expect(fix).toContain('the second shows it');
    expect(fix.indexOf('twice')).toBeLessThan(fix.indexOf('Restart Nolzu'));
  });

  // Signing in again on the same account gets the same close, so the account line says which account.
  it('does not send a person to the login without saying which account', () => {
    const fix = cloudConnection('unpaid').fix;

    expect(fix).toContain('signed in to another account');
    expect(fix).toContain('the account that pays for it');
  });
});

// Connect again: a manual redial on the one state nothing leaves by itself.
describe('Connect again', () => {
  const button = (status: HubStatus, free = false) => render(CloudStatus, { props: { status, free } }).body;

  it('shows on a machine whose plan has the board and whose link is closed, and posts the redial', () => {
    const body = button('closed');

    expect(body).toMatch(/<form[^>]*method="POST"[^>]*action="\?\/redial"/);
    expect(body).toContain('Connect again');
    expect(cloudConnection('closed').fix).toContain('press Connect again');
  });

  // Nolzu is dialling already, or waiting for the account to change, which `dialHubAgain` watches.
  it.each(ALL.filter((status) => status !== 'closed'))('does not show while the link is %s', (status) => {
    expect(button(status)).not.toContain('Connect again');
    expect(cloudState(status, false).redial).toBe(false);
  });

  // A machine with no account has nothing to dial with, so a press could never help.
  it.each(ALL)('never shows on Free (%s)', (status) => {
    expect(button(status, true)).not.toContain('?/redial');
    expect(cloudState(status, true).redial).toBe(false);
  });

  // The press dials and nothing else does: no timer, no interval, no reload of its own.
  it('starts no timer on the screen', () => {
    const source = readFileSync(new URL('./CloudStatus.svelte', import.meta.url), 'utf8');

    expect(source).not.toMatch(/setInterval|setTimeout|invalidate/);
  });
});

// Delete my cloud data pauses sync until the person turns it back on. The row says
// why, offers the way back, and never offers Connect again, which would dial into the same pause.
describe('sync paused', () => {
  it('says sync is paused after the delete, and posts Turn sync back on', () => {
    const body = render(CloudStatus, { props: { status: 'closed', paused: true } }).body;

    expect(cloudState('closed', false, true)).toEqual({ connection: SYNC_PAUSED, redial: false, resume: true });
    expect(text(body)).toContain('Paused');
    expect(text(body)).toContain('You deleted your cloud data, so sync is paused.');
    expect(body).toMatch(/<form[^>]*method="POST"[^>]*action="\?\/resume"/);
    expect(text(body)).toContain('Turn sync back on');
    expect(body).not.toContain('?/redial');
  });

  it.each(ALL)('offers no way back while sync is on (%s)', (status) => {
    expect(cloudState(status, false).resume).toBe(false);
    expect(render(CloudStatus, { props: { status } }).body).not.toContain('?/resume');
  });
});

describe('Free', () => {
  // The machine with no account: closed because there is nothing to dial with, and no fault.
  it('reads Local only and sends nothing when the link is closed', () => {
    const drawn = text(render(CloudStatus, { props: { status: 'closed', free: true } }).body);

    expect(cloudState('closed', true).connection).toBe(LOCAL_ONLY);
    expect(drawn).toContain('Local only');
    expect(drawn).toContain('This machine sends nothing to Nolzu cloud.');
    expect(drawn).not.toContain('Offline');
  });

  // A signed-in Free machine can still be refused, or turned down for its plan, and reads it as it is.
  it.each(ALL.filter((status) => status !== 'closed'))('reads %s as the client reports it', (status) => {
    expect(cloudState(status, true).connection).toEqual(cloudConnection(status));
  });
});

// Amber means an agent starts work. A dial is not that, so no state draws it.
it('draws no state in amber', () => {
  expect(readFileSync(new URL('./CloudStatus.svelte', import.meta.url), 'utf8')).not.toMatch(/var\(--amber/);
});

// The wire. A component nothing draws is a feature that only works in its own test, which has
// happened here before, so the screen and its load are read off the files themselves.
it('draws the state on the settings screen, from the status the load reads', () => {
  const page = readFileSync(new URL('../routes/settings/[section]/+page.svelte', import.meta.url), 'utf8');
  const load = readFileSync(new URL('../routes/settings/[section]/+page.server.ts', import.meta.url), 'utf8');

  expect(page).toContain('id="cloud"');
  expect(page).toContain('<CloudStatus status={data.hub} paused={data.paused ?? false} />');
  expect(page).toContain('<CloudStatus status={data.hub} free />');
  expect(load).toContain("hub: on('cloud') ? hubStatus() : null");
});

describe('offlineBanner', () => {
  const ALL: HubStatus[] = ['connecting', 'open', 'waiting', 'refused', 'unpaid', 'closed'];
  const solo = { ...FREE, id: 'acct-1', plan: 'solo' as const, features: ['cloud-board'], expiresAt: 4_000_000_000 };

  // Free never dials a hub, so it is never offline from one. The signed document says what the plan
  // opens; the banner reads the document and checks no plan (AGENTS.md rule 2).
  it.each(ALL)('never shows on Free, whatever the link says (%s)', (status) => {
    expect(offlineBanner(status, FREE)).toBeNull();
  });

  it('shows on a paid machine whose link dropped, and says Nolzu dials again', () => {
    expect(offlineBanner('waiting', solo)).toEqual({
      headline: 'The connection to the cloud dropped.',
      sentence: 'Answers and approvals from the phone and the web app wait in the cloud until this machine connects again.',
      fix: 'Nolzu dials again by itself.',
      settings: false,
    });
  });

  it('shows on a paid machine the cloud refused, and leads to the connection settings', () => {
    // The machine is online and the cloud turned it down, so the headline does not say offline.
    expect(offlineBanner('refused', solo)).toMatchObject({ headline: 'The cloud refused this machine.', fix: 'Nolzu stopped dialling.', settings: true });
  });

  // Every start passes through connecting, and a link that is up or was never opened is no news.
  it.each(['connecting', 'open', 'unpaid', 'closed'] as HubStatus[])('shows nothing on a paid machine while the link is %s', (status) => {
    expect(offlineBanner(status, solo)).toBeNull();
  });
});
