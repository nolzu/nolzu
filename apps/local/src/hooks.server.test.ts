import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { framed, handle, init, stopOnSignals } from './hooks.server.ts';
import { database } from '$lib/db.ts';
import { acceptTerms } from '$lib/terms.ts';

// `init` builds the one loop and dials the hub. Neither is wanted here: only what a signal does.
const live = vi.hoisted(() => ({ shutdown: vi.fn(() => Promise.resolve()) }));
vi.mock('$lib/loop.ts', () => ({ loop: () => live }));
vi.mock('$lib/hub-link.ts', () => ({ startHubLink: () => undefined, closeHubLink: () => undefined }));

// The server answers only the terms page until they are accepted, and this file tests what comes after.
acceptTerms(database(), true);

const ADDRESS = 'http://localhost:5173/api/board/pulls';

// `handle` answers a refusal and a redirect as a response of its own, with the frame headers on it.
const send = async (method: string, headers: Record<string, string>) =>
  handle({
    event: { request: new Request(ADDRESS, { method, headers }), url: new URL(ADDRESS) },
    resolve: () => new Response('passed'),
  } as unknown as Parameters<typeof handle>[0]);

// The rule reads the header the browser sets, not one the page can set itself.
describe('handle', () => {
  it('refuses a POST another site sent', async () => {
    const answer = (await send('POST', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })) as Response;
    expect(answer.status).toBe(403);
  });

  it('passes a POST from its own page', async () => {
    const answer = (await send('POST', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' })) as Response;
    expect(await answer.text()).toBe('passed');
  });

  // The Files tab frames a design screen in an empty sandbox, so the browser calls its stylesheet
  // another site's. Refused, the screen drew with no styles.
  it('passes the stylesheet a sandboxed card screen loads, and refuses another site\'s script there', async () => {
    const at = async (dest: string) => {
      const address = 'http://localhost:5173/api/card/APP-1/files/design/tokens.css';
      const headers = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': dest };
      return (await handle({ event: { request: new Request(address, { headers }), url: new URL(address) }, resolve: () => new Response('passed') } as unknown as Parameters<typeof handle>[0])) as Response;
    };
    expect(await (await at('style')).text()).toBe('passed');
    expect((await at('script')).status).toBe(403);
  });
});

// SvelteKit routes on the decoded path, so the gate reads it decoded too.
describe('handle, on the pages of a later version', () => {
  it('sends a percent-encoded Scout or Evidence address home, and hides their endpoints', async () => {
    const at = async (address: string) =>
      (await handle({ event: { request: new Request(address), url: new URL(address) }, resolve: () => new Response('routed') } as unknown as Parameters<typeof handle>[0])) as Response;
    expect((await at('http://localhost:5173/%73cout')).status).toBe(303);
    expect((await at('http://localhost:5173/%65vidence/x')).status).toBe(303);
    expect((await at('http://localhost:5173/api/%65vidence/timesheet')).status).toBe(404);
  });
});

// Chrome asks every local site for this file while DevTools is open. Each miss used to log a line.
describe('handle, on the DevTools probe', () => {
  it('answers an empty 404 without routing it', async () => {
    const PROBE = 'http://localhost:5173/.well-known/appspecific/com.chrome.devtools.json';
    const resolve = vi.fn(() => new Response('routed'));
    const answer = (await handle({
      event: { request: new Request(PROBE), url: new URL(PROBE) },
      resolve,
    } as unknown as Parameters<typeof handle>[0])) as Response;
    expect(answer.status).toBe(404);
    expect(await answer.text()).toBe('');
    expect(resolve).not.toHaveBeenCalled();
  });

  // Only that one file: a path that looks like it still goes through SvelteKit.
  it.each(['/.well-known/appspecific/com.chrome.devtools.json.bak', '/b/com.chrome.devtools.json'])('routes %s', async (path) => {
    const NEAR = `http://localhost:5173${path}`;
    const answer = (await handle({
      event: { request: new Request(NEAR), url: new URL(NEAR) },
      resolve: () => new Response('routed'),
    } as unknown as Parameters<typeof handle>[0])) as Response;
    expect(await answer.text()).toBe('routed');
  });
});

// DNS rebinding: the page is on another site's name, so the browser calls its requests same-origin.
describe('handle, by the name a request is addressed to', () => {
  const STREAM = 'http://localhost:5173/api/board';
  const to = async (address: string, method: string, host: string) =>
    handle({
      event: { request: new Request(address, { method, headers: { host, 'sec-fetch-site': 'same-origin' } }), url: new URL(address) },
      resolve: () => new Response('passed'),
    } as unknown as Parameters<typeof handle>[0]);

  it.each([
    ['a read', ADDRESS, 'GET'],
    ['a write', ADDRESS, 'POST'],
    ['the board stream', STREAM, 'GET'],
  ])('refuses %s for another name', async (_what, address, method) => {
    const answer = (await to(address, method, 'evil.example:5173')) as Response;
    expect(answer.status).toBe(403);
    expect(((await answer.json()) as { message: string }).message).toContain('localhost');
  });

  it('refuses a local name on a port the server is not on', async () => {
    expect(((await to(ADDRESS, 'GET', 'localhost:4319')) as Response).status).toBe(403);
  });

  it('serves localhost', async () => {
    const answer = (await to(ADDRESS, 'POST', 'localhost:5173')) as Response;
    expect(await answer.text()).toBe('passed');
  });

  // Served, and sent on to the spelling the cross-site rule trusts.
  it.each(['127.0.0.1:5173', '[::1]:5173'])('serves %s by sending it to localhost', async (host) => {
    const answer = (await to(ADDRESS, 'GET', host)) as Response;
    expect(answer.status).toBe(307);
    expect(answer.headers.get('location')).toBe(ADDRESS);
  });
});

// Clickjacking: the port is easy to guess, so another site must not draw a Nolzu page in a frame.
describe('handle, on framing', () => {
  const framing = (answer: Response) => [answer.headers.get('x-frame-options'), answer.headers.get('content-security-policy')];

  it('forbids framing on a page, a refusal, a redirect and the DevTools probe', async () => {
    const page = (await send('GET', { 'sec-fetch-site': 'same-origin' })) as Response;
    const refused = (await send('POST', { 'sec-fetch-site': 'cross-site' })) as Response;
    const PROBE = 'http://localhost:5173/.well-known/appspecific/com.chrome.devtools.json';
    const probe = (await handle({ event: { request: new Request(PROBE), url: new URL(PROBE) }, resolve: () => new Response('routed') } as unknown as Parameters<typeof handle>[0])) as Response;
    const LOOPBACK = 'http://127.0.0.1:5173/';
    const moved = (await handle({
      event: { request: new Request(LOOPBACK, { headers: { host: '127.0.0.1:5173' } }), url: new URL(LOOPBACK) },
      resolve: () => new Response('passed'),
    } as unknown as Parameters<typeof handle>[0])) as Response;

    for (const answer of [page, refused, probe, moved]) expect(framing(answer)).toEqual(['DENY', "frame-ancestors 'none'"]);
    expect(moved.status).toBe(307);
  });

  it('adds frame-ancestors to a policy that has none, and keeps one that names its own', () => {
    const own = framed(new Response('', { headers: { 'content-security-policy': "sandbox; frame-ancestors 'self'" } }));
    const other = framed(new Response('', { headers: { 'content-security-policy': "default-src 'self'" } }));

    expect(framing(own)).toEqual([null, "sandbox; frame-ancestors 'self'"]);
    expect(framing(other)).toEqual(['DENY', "default-src 'self'; frame-ancestors 'none'"]);
  });

  it('sets the headers on a response whose headers cannot change', () => {
    const fixed = Response.redirect('http://localhost:5173/', 302);

    expect(framing(framed(fixed))).toEqual(['DENY', "frame-ancestors 'none'"]);
  });
});

// Ctrl+C. No signal is sent: `stopOnSignals` registers its handlers on this process, the test calls
// them by hand, and every listener it added goes in afterEach, so no test leaves one behind.
describe('stopping on a signal', () => {
  type Signal = 'SIGINT' | 'SIGTERM' | 'SIGHUP';
  const SIGNALS: readonly Signal[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  let before: Record<Signal, unknown[]>;

  beforeEach(() => {
    before = Object.fromEntries(SIGNALS.map((signal) => [signal, process.rawListeners(signal)])) as Record<Signal, unknown[]>;
  });

  afterEach(() => {
    for (const signal of SIGNALS) for (const one of process.rawListeners(signal)) if (!before[signal].includes(one)) process.off(signal, one as () => void);
    vi.restoreAllMocks();
    vi.useRealTimers();
    live.shutdown.mockClear();
  });

  const ours = (signal: Signal) => process.rawListeners(signal).find((one) => !before[signal].includes(one)) as (() => void) | undefined;

  // Only the signals' counts: the test runner reads other counts of its own.
  const listening = (count: number) => {
    const real = process.listenerCount.bind(process);
    vi.spyOn(process, 'listenerCount').mockImplementation((name) => ((SIGNALS as readonly unknown[]).includes(name) ? count : real(name)));
  };

  const start = (shutdown: () => Promise<void> = () => Promise.resolve()) => {
    const said: string[] = [];
    const exits: number[] = [];
    stopOnSignals(shutdown, { exit: (code) => void exits.push(code), say: (line) => void said.push(line), waitMs: 50 });
    return { said, exits };
  };

  it('is what init registers, on the loop of the server', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    listening(1);
    init();

    ours('SIGTERM')!();

    await vi.waitFor(() => expect(live.shutdown).toHaveBeenCalledTimes(1));
  });

  // SIGHUP is the terminal closing, which has to stop the runs the way Ctrl+C does.
  it.each(SIGNALS)('stops the runs once on %s, and every other signal meanwhile is nothing', async (signal) => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    listening(1);
    const shutdown = vi.fn(() => Promise.resolve());
    start(shutdown);

    ours(signal)!();
    for (const other of SIGNALS.filter((one) => one !== 'SIGINT')) ours(other)?.();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  // adapter-node listens too and exits by itself, so the signal does not go again, and ours leave.
  it('leaves the exit to another listener, and takes all three of its listeners away', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    listening(1);
    start();

    ours('SIGTERM')!();

    await vi.waitFor(() => expect(SIGNALS.map(ours)).toEqual([undefined, undefined, undefined]));
    expect(kill).not.toHaveBeenCalled();
  });

  // Under the dev server, and for SIGHUP, nothing else listens, so the exit comes from sending it again.
  it.each(['SIGINT', 'SIGHUP'] as const)('sends %s again once the runs end, when nothing else listens', async (signal) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    listening(0);
    start();

    ours(signal)!();

    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, signal));
  });

  // The shell sends SIGHUP again as it exits. The repeat is nothing, so the default action cannot kill
  // Nolzu while the runs stop.
  it('takes a second SIGHUP as nothing while the runs stop', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    listening(0);
    let release: () => void = () => {};
    const shutdown = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { exits } = start(shutdown);

    ours('SIGHUP')!();
    ours('SIGHUP')!();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([]);

    release();
    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, 'SIGHUP'));
  });

  // Ctrl+C says what it does, and a second one is the person asking to quit now.
  it('quits on a second Ctrl+C, with a line each time', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    listening(0);
    const { said, exits } = start(() => new Promise<void>(() => {}));

    ours('SIGINT')!();
    expect(said).toEqual(['Stopping the runs. Press Ctrl+C again to quit now.']);
    ours('SIGINT')!();

    expect(exits).toEqual([130]);
    expect(said[1]).toMatch(/^Quitting now\./);
  });

  // A stop that hangs ends anyway, with a line that says so.
  it('quits when the stop takes longer than the wait', async () => {
    vi.spyOn(process, 'kill').mockImplementation(() => true);
    listening(0);
    const { said, exits } = start(() => new Promise<void>(() => {}));

    ours('SIGTERM')!();

    await vi.waitFor(() => expect(exits).toEqual([1]));
    expect(said).toEqual(['The runs did not stop in 0.05 seconds, so Nolzu quits now.']);
  });

  // A stop that throws says so in one line, and Nolzu still ends.
  it('says a failed stop in one line, and still sends the signal again', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    listening(0);
    const { said, exits } = start(() => Promise.reject(new Error('the queue is gone')));

    ours('SIGTERM')!();

    await vi.waitFor(() => expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM'));
    expect(said).toEqual(['Stopping the runs failed: the queue is gone']);
    await new Promise((resolve) => setTimeout(resolve, 80));
    // The wait was cleared with the stop, so it does not quit as well.
    expect(exits).toEqual([]);
  });
});
