import type { DisplayEntitlement } from '@nolzu/protocol';
import type { HubStatus } from '@nolzu/runner';
import { shows } from './display.ts';

// What a screen says about the connection to the cloud, one entry per `HubStatus`. The words are the
// ones the client already has, so a screen and a log line never describe the same connection in two
// vocabularies.
export interface CloudConnection {
  // The state, said in a word, because colour alone is not a state.
  word: string;
  // What is true right now, in one or two sentences.
  sentence: string;
  // What a person does next, for the three states the client cannot leave on its own. Null everywhere
  // else, so no screen offers a retry while Nolzu is already dialling.
  fix: string | null;
}

// `refused` is the token the cloud will not take and the version it will not speak, and the status
// does not say which: `connectHub` reports the word and keeps the close code to itself. One sentence
// covers both, because both are repaired on this machine and neither is repaired by waiting.
//
// Both stopped states send a person to a page load before a restart. `connectHub` returns for good on a
// refusal code, so nothing dials by itself any more, but `dialHubAgain` in `hub-link.ts` dials once when
// the next document says the account changed, and a page load is what fetches that document. The restart
// stays in both fixes as the fallback, for the account that changed in a way no document shows.
//
// Both fixes ask for two loads, because one load cannot show its own dial. The settings load reads
// `hubStatus()` while the layout load is still fetching the document, and the dial that document starts
// reads the keychain before it reports `connecting`. So the load that dials still draws the old word, and
// the next one draws the connection.
const STATES: Record<HubStatus, CloudConnection> = {
  connecting: {
    word: 'Connecting',
    sentence: 'Nolzu is opening the connection to the cloud.',
    fix: null,
  },
  open: {
    word: 'Connected',
    sentence: 'This machine is connected. A run started from the cloud starts here.',
    fix: null,
  },
  waiting: {
    word: 'Reconnecting',
    sentence: 'The connection dropped, and Nolzu dials again after a wait that grows to a minute. A run started from the cloud waits in the queue there until this machine is back.',
    fix: null,
  },
  refused: {
    word: 'Refused',
    sentence: 'The cloud refused this machine, so Nolzu stopped dialling. Nothing changes until this machine does.',
    fix: 'Run npx nolzu@latest login again, then reload this screen: Nolzu dials once more with the account it reads. The new sign-in can take a minute to reach this screen, so reload again if nothing changed. If this machine is signed in already, update Nolzu instead, because the cloud also turns down a version it cannot speak. Restart Nolzu if this screen keeps saying Refused.',
  },
  // Not an error. Most machines that read this never asked for the cloud, so the sentence says what is
  // true and the fix is written for the two people who are paying and still see it: the one who just
  // bought the plan, and the one signed in as the wrong account. The reload comes first because the
  // bought plan is the common path and the document the reload fetches is what dials. Two loads, because
  // the load that dials was built before the dial reported anything.
  unpaid: {
    word: 'Local only',
    sentence: 'The plan on this account does not include the cloud board, so Nolzu stopped dialling. The board on this machine works whole without it.',
    fix: 'If your plan does include the cloud board, reload this screen twice: the first load reads the plan and opens the connection, the second shows it. If the connection stays shut, this machine is signed in to another account, so run npx nolzu@latest login again with the account that pays for it. Restart Nolzu if this screen keeps saying Local only.',
  },
  // A signed-in machine whose keychain read failed or found no token. Nothing dials again by itself, so
  // this is the one state with Connect again (`redialHub`). A machine with no account reads `LOCAL_ONLY`.
  closed: {
    word: 'Offline',
    sentence: 'Nolzu stopped trying, so this machine is not connected to the cloud. The board here works whole without it. A run started from the cloud waits there until this machine connects again.',
    fix: 'Press Connect again. Nolzu reads its sign-in from the keychain and dials once more, so allow it if the system asks. If it stays Offline, run npx nolzu@latest login, then press Connect again.',
  },
};

export const cloudConnection = (status: HubStatus): CloudConnection => STATES[status];

// Free with no account: the link is `closed` because there is nothing to dial with, which is no fault
// and has nothing to fix.
export const LOCAL_ONLY: CloudConnection = { word: 'Local only', sentence: 'This machine sends nothing to Nolzu cloud.', fix: null };

// After Delete my cloud data the link dials nothing until the person turns sync back on, so the
// row says why and the button is the fix.
export const SYNC_PAUSED: CloudConnection = {
  word: 'Paused',
  sentence: 'You deleted your cloud data, so sync is paused. Nothing leaves this machine until you turn it back on. Turning it on sends the board again.',
  fix: null,
};

/**
 * The state line of Settings, Cloud, and whether it offers Connect again or, after Delete my cloud data
 * (`paused`), Turn sync back on.
 *
 * `free` is a display document without the cloud board. There `closed` is a machine that never dials,
 * so it reads Local only; every other state reads as the client reports it, because a signed-in Free
 * machine can be refused or turned down for its plan. Connect again only where nothing dials by itself
 * and a dial could help: `closed` on a machine whose plan has the board.
 */
export const cloudState = (status: HubStatus, free: boolean, paused = false): { connection: CloudConnection; redial: boolean; resume: boolean } =>
  paused
    ? { connection: SYNC_PAUSED, redial: false, resume: true }
    : {
        connection: free && status === 'closed' ? LOCAL_ONLY : cloudConnection(status),
        redial: !free && status === 'closed',
        resume: false,
      };

// The offline banner at the top of every page: what went wrong with the link, what waits, what happens
// next, and whether the fix is on the connection settings.
export interface OfflineBanner {
  headline: string;
  sentence: string;
  fix: string;
  settings: boolean;
}

/**
 * The banner, or null when there is none to show.
 *
 * Only a machine whose signed document opens the cloud board dials a hub, so Free never sees it. The
 * document says what the plan opens, and nothing here checks a plan (AGENTS.md rule 2). A link that
 * dropped (`waiting`) and one the cloud turned down (`refused`) are offline. `connecting` is not: every
 * start passes through it, and a banner on each start would cry wolf.
 *
 * Limit: read on each page load, as the rail's usage is, so a link that drops while a page is open
 * shows at the next page. Send the status on the Now stream when that is too late.
 */
export function offlineBanner(status: HubStatus, document: DisplayEntitlement): OfflineBanner | null {
  if (!shows(document, 'cloud-board')) return null;
  // The headline names the problem, so a refusal never reads as a machine with no network.
  const sentence = 'Answers and approvals from the phone and the web app wait in the cloud until this machine connects again.';
  if (status === 'waiting') return { headline: 'The connection to the cloud dropped.', sentence, fix: 'Nolzu dials again by itself.', settings: false };
  if (status === 'refused') return { headline: 'The cloud refused this machine.', sentence, fix: 'Nolzu stopped dialling.', settings: true };
  return null;
}
