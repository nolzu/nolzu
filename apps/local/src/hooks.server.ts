import { error, type Handle, isHttpError, isRedirect, redirect, type ServerInit } from '@sveltejs/kit';
import { resolveDataDir, takeWriter } from '@nolzu/core/node';
import { SCOUT_AND_EVIDENCE } from '@nolzu/protocol';
import { processStart } from '@nolzu/runner';
import { crossSiteFetch, crossSiteWrite, foreignHost, localhostRedirect } from '$lib/bin.ts';
import { stopAllClones } from '$lib/add-repo.ts';
import { database } from '$lib/db.ts';
import { DEVTOOLS_PROBE } from '$lib/devtools-probe.ts';
import { closeHubLink, startHubLink } from '$lib/hub-link.ts';
import { loop } from '$lib/loop.ts';
import { startWhenAccepted, termsGate, termsState, workStarted } from '$lib/terms.ts';

// SvelteKit routes on the decoded path. A malformed escape leaves the raw one, which routes nowhere.
const decodedPath = (path: string): string => {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
};

/**
 * Server start, once, before the first request.
 *
 * The loop is built here and not on the first request, because a job from the hub can arrive before
 * anybody opens the board. That moves the writer lock earlier too: a second Nolzu on the same data
 * directory is now refused at start instead of on the first page.
 *
 * The dial is the only one in the product. It belongs here and not in `bin/nolzu.js`, because the loop
 * is one object per data directory and a dial from the CLI would build a second loop over the same
 * database.
 *
 * Before the person accepts the terms, none of it starts: building the loop sweeps old runs, makes the
 * moves Learn held and starts the pull request timer, and the hub can send jobs. Only the writer lock
 * is taken now, so a second Nolzu on the same data folder is still refused at start.
 */
export const init: ServerInit = () => {
  const db = database();
  if (termsState(db) !== 'accepted') takeWriter(db, { dataDir: resolveDataDir(process.env), startedAt: processStart });
  startWhenAccepted(db, () => startHubLink(loop(), process.env));
  // The heartbeat runs on an interval, which holds the process open after the HTTP server has closed.
  // adapter-node emits this once it has shut that server down. The module closes what it holds now, and
  // not the link this hook started: a dial again replaces it, and the handle from here would be the dead
  // one while the new socket and its heartbeat kept the process alive.
  process.on('sveltekit:shutdown', () => closeHubLink());
  stopOnSignals(async () => {
    // With the terms not accepted there is no loop, and building one here would sweep and start its boot.
    await Promise.all([workStarted() ? loop().shutdown() : undefined, stopAllClones()]);
  });
};

// How long a stop may take before Nolzu quits anyway. An engine that ignores its stop would otherwise
// hold the terminal for good.
export const FORCE_QUIT_MS = 15_000;

/**
 * Ctrl+C, the system stopping Nolzu, or the terminal closing (SIGHUP). adapter-node closes the HTTP
 * server on the first two, and that waits up to half a minute for an open page. The runs stop at once
 * instead, as Stop stops them. Alone on a signal, as under the dev server or for SIGHUP, which nothing
 * else listens for, the listener would swallow the default exit, so the signal goes again once the
 * runs have ended.
 *
 * One stop for all three signals. A repeat is nothing, because a closing terminal sends SIGHUP again as
 * the shell exits, and that one would kill Nolzu mid-stop and leave a detached engine running. A
 * second Ctrl+C is the person asking to quit now, so it does. A stop that hangs ends after
 * `FORCE_QUIT_MS` with a line that says so.
 */
export function stopOnSignals(
  shutdown: () => Promise<void>,
  out: { exit: (code: number) => void; say: (line: string) => void; waitMs: number } = {
    exit: (code) => process.exit(code),
    say: (line) => console.error(line),
    waitMs: FORCE_QUIT_MS,
  },
): void {
  let stopping = false;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    const handler = (): void => {
      if (stopping) {
        if (signal === 'SIGINT') {
          out.say('Quitting now. A run that was stopping may still be ending.');
          out.exit(130);
        }
        return;
      }
      stopping = true;
      if (signal === 'SIGINT') out.say('Stopping the runs. Press Ctrl+C again to quit now.');
      const late = setTimeout(() => {
        out.say(`The runs did not stop in ${out.waitMs / 1000} seconds, so Nolzu quits now.`);
        out.exit(1);
      }, out.waitMs);
      late.unref();
      void shutdown()
        .catch((error: unknown) => out.say(`Stopping the runs failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          clearTimeout(late);
          for (const [name, one] of handlers) process.off(name, one);
          if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
        });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
}

/**
 * No other site may draw a Nolzu page in a frame. The pages hold buttons that start agents, and the
 * port is easy to guess, so a framed page under a fake one would turn a click there into a run here.
 *
 * A response that names its own `frame-ancestors` keeps it: a card file the app shows in its own frame
 * says `'self'`, and DENY would blank it there.
 */
export function framed(response: Response): Response {
  const policy = response.headers.get('content-security-policy');
  if (policy?.includes('frame-ancestors') === true) return response;
  const set = (headers: Headers) => {
    headers.set('x-frame-options', 'DENY');
    // Over http a browser looks up the host of every link on a page, so a link in a stranger's comment
    // would tell that host's name server when the page was read.
    headers.set('x-dns-prefetch-control', 'off');
    headers.set('content-security-policy', policy === null ? "frame-ancestors 'none'" : `${policy}; frame-ancestors 'none'`);
  };
  try {
    set(response.headers);
    return response;
  } catch {
    // Some responses come with headers that cannot change, such as one a fetch answered.
    const copy = new Response(response.body, response);
    set(copy.headers);
    return copy;
  }
}

// What `guard` throws becomes a response here, so the refusals and redirects carry the frame headers too.
export const handle: Handle = async (input) => {
  try {
    return framed(await guard(input));
  } catch (thrown) {
    if (isRedirect(thrown)) return framed(new Response(null, { status: thrown.status, headers: { location: thrown.location } }));
    // In the shape SvelteKit answers a refusal in: JSON for a script, the sentence for a page.
    if (isHttpError(thrown)) {
      const page = (input.event.request.headers.get('accept') ?? '').includes('text/html');
      return framed(page ? new Response(thrown.body.message, { status: thrown.status, headers: { 'content-type': 'text/plain; charset=utf-8' } }) : Response.json(thrown.body, { status: thrown.status }));
    }
    throw thrown;
  }
};

const guard: Handle = ({ event, resolve }) => {
  // Chrome's DevTools probe: an empty 404 logs nothing. Under vite dev the plugin in vite.config.ts
  // answers it first, as SvelteKit's middleware would reach it before any hook.
  if (event.url.pathname === DEVTOOLS_PROBE) return new Response(null, { status: 404 });
  // Then, so no page, form, endpoint or stream answers a page that reached the server by another
  // site's name. That is DNS rebinding, and Sec-Fetch-Site cannot see it.
  if (foreignHost(event.request.headers.get('host'), event.url)) {
    error(403, 'Nolzu answers only at localhost on its own port. Open it at the address it printed and try again.');
  }
  const to = localhostRedirect(event.request.headers.get('host'), event.url);
  // 307 keeps the method, so nothing is turned into a GET on the way.
  if (to !== null) redirect(307, to);
  const headers = event.request.headers;
  if (crossSiteFetch(event.request.method, headers.get('sec-fetch-site'), headers.get('sec-fetch-mode'), headers.get('sec-fetch-dest'), event.url.pathname)) {
    error(403, 'Nolzu answers another site only with a page a person opened from a link. Open it at the address it printed.');
  }
  if (crossSiteWrite(event.request.method, event.request.headers.get('sec-fetch-site'), event.request.headers.get('origin'), event.url.port)) {
    error(403, 'Nolzu takes changes from its own pages only. Open it at the address it printed and try again.');
  }
  // Until the terms are accepted a page goes to them and an endpoint says why it refuses. After the
  // same-site checks, so the accept itself is a write from this server's own page.
  const terms = termsGate(() => termsState(database()), event.request.method, decodedPath(event.url.pathname), event.url.search);
  if (terms !== null && 'refuse' in terms) error(403, terms.refuse);
  if (terms !== null) redirect(303, terms.redirect);
  // Scout and Evidence come in a later version. A saved link or a typed address lands on Now, and a
  // form on those pages saves nothing.
  // Decoded, as SvelteKit routes it, so `/%73cout` does not get past.
  const path = decodedPath(event.url.pathname);
  if (!SCOUT_AND_EVIDENCE && /^\/(scout|evidence)(\/|$)/.test(path)) redirect(303, '/');
  // Their endpoints, the timesheet CSV among them, answer as if they were not there.
  if (!SCOUT_AND_EVIDENCE && /^\/api\/(scout|evidence)(\/|$)/.test(path)) error(404, 'Not found');
  return resolve(event);
};
