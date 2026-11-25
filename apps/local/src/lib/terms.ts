import type { DatabaseSync } from 'node:sqlite';
import { getSetting, writeSetting } from '@nolzu/core/node';

// The date the words below last changed. A new date asks every person to accept them again, so it
// moves only when the meaning changes.
export const TERMS_VERSION = '2026-11-23';

// The page that asks. Every other page sends a person here until they accept.
export const ACCEPT_PATH = '/accept';

// A part of a sentence, with a link when `href` is set.
export interface TermsPart {
  text: string;
  href?: string;
}

// The words of the page. They change here and nowhere else.
export const TERMS = {
  heading: 'Before you start',
  changed: 'These terms changed since you accepted them. Read them again.',
  intro: 'Nolzu starts AI coding agents on your machine. They run as your user, with your files and your logins. Read this, and accept it to go on.',
  points: [
    [
      { text: "The agents can change and delete files, run commands, install packages and push code to your repositories. Nolzu's wall limits what a run can write, but it has known gaps, listed on the " },
      { text: 'Security page', href: 'https://nolzu.com/security#gaps' },
      { text: '.' },
    ],
    [{ text: "Every run uses your own agent plan or API key, under that vendor's terms. Runs can use up your quota or cost you money." }],
    [{ text: 'You decide what runs. Check what the agents did before you commit, push or merge it.' }],
    [
      { text: 'Nolzu is published under the ' },
      { text: 'FSL-1.1-ALv2', href: 'https://github.com/nolzu/nolzu/blob/main/LICENSE' },
      {
        text: ' license and comes as is, with no warranty of any kind. As far as the law allows, the people who make Nolzu are not liable for any damage or loss that comes from using it, such as lost data or work, a broken repository, costs, or a vendor suspending your account.',
      },
    ],
    [{ text: 'You can read how Nolzu works in its ' }, { text: 'source code on GitHub', href: 'https://github.com/nolzu/nolzu' }, { text: '.' }],
  ] satisfies TermsPart[][],
  checkbox: 'I have read this and I accept it.',
  button: 'Accept and start',
  after: 'If you do not accept, close this tab and stop Nolzu with Ctrl+C in the terminal.',
} as const;

// What a request without acceptance gets from an endpoint. It names the problem and the fix.
export const TERMS_REFUSAL = `Nolzu has not started yet, because its terms are not accepted. Open Nolzu in the browser and accept them on ${ACCEPT_PATH}.`;

// Never accepted, accepted, or accepted at an older version, which shows the changed line.
export type TermsState = 'new' | 'accepted' | 'changed';

export function termsState(db: DatabaseSync, version: string = TERMS_VERSION): TermsState {
  const accepted = getSetting(db, 'termsAccepted');
  if (accepted === null) return 'new';
  return accepted.version === version ? 'accepted' : 'changed';
}

// What the server hook does with a request before the terms are accepted: let it through (null), send a
// page to the terms, or refuse with `TERMS_REFUSAL`. `/api/health` passes, because a second `nolzu` asks it
// which data folder this server holds, and it starts nothing. The state is read only when the path needs
// it, so that answer needs no database.
export function termsGate(state: () => TermsState, method: string, path: string, search = ''): { redirect: string } | { refuse: string } | null {
  if (path === ACCEPT_PATH || path === '/api/health') return null;
  if (state() === 'accepted') return null;
  // A page form posts a write, so it is refused like an endpoint, never moved to another address.
  if (path.startsWith('/api/') || (method !== 'GET' && method !== 'HEAD')) return { refuse: TERMS_REFUSAL };
  const to = path === '/' ? '' : `?to=${encodeURIComponent(path + search)}`;
  return { redirect: `${ACCEPT_PATH}${to}` };
}

// Where to go after the accept: the page the person asked for, or the board. Only a path on this server,
// so a link cannot send the person to another site from here. The answer is checked as well as the
// input: `/.//host` parses to this origin, but its path `//host` would send a browser to that host.
export function afterAccept(to: string | null): string {
  const here = 'http://localhost';
  if (to === null || !URL.canParse(to, here)) return '/';
  const url = new URL(to, here);
  const out = url.pathname + url.search;
  return url.origin === here && new URL(out, here).origin === here && url.pathname !== ACCEPT_PATH ? out : '/';
}

// The work that starts on its own: the run loop, its boot and its timers, and the hub link. Held here
// until the terms are accepted, and started once.
let held: (() => void) | null = null;
let started = false;

// Called once at server start. Accepted terms start the work now. Otherwise it waits for `acceptTerms`.
export function startWhenAccepted(db: DatabaseSync, start: () => void): void {
  if (termsState(db) === 'accepted') {
    started = true;
    start();
    return;
  }
  held = start;
}

// Whether the held work has started, so Ctrl+C does not build a loop only to stop it.
export const workStarted = (): boolean => started;

// The accept: the box must be ticked. Stores the version and the time, then starts what was held.
// Returns the sentence that refuses it, or null.
export function acceptTerms(db: DatabaseSync, ticked: boolean, now: Date = new Date()): string | null {
  if (!ticked) return 'Tick the box to accept the terms.';
  writeSetting(db, 'termsAccepted', { version: TERMS_VERSION, at: now.toISOString() });
  const start = held;
  held = null;
  if (start !== null) {
    started = true;
    start();
  }
  return null;
}
