import { HUB_PATH, TEAM_HUB_PATH } from '@nolzu/protocol';
import { DEVICE_TOKEN_NAME } from './hub.ts';
import type { Keychain } from './keychain.ts';

// `nolzu login`, `nolzu logout` and `nolzu status`.
//
// The device flow of RFC 8628, the same one `gh auth login` uses: the client asks for a code, the
// person approves it in a browser, and the client polls until the server answers. What comes back is
// a device token with no expiry. It goes into the OS keychain under the name the hub connection reads,
// and every other call carries a short access token minted from it.
//
// Nothing here knows about plans or paid features. It signs a machine in, and the server decides what
// that account may do.

// The client names itself and the machine in the client id of a device request. The server reads the
// machine name back out of it, so the prefix and the name rule are the server's and not ours. The OS
// rides beside it in a field of its own (`osName`).
export const CLIENT_PREFIX = 'nolzu-cli/';

export const CLOUD_URL = 'https://app.nolzu.com';

// The hub is a service of its own on a host of its own, so it is a second address and not a path under
// CLOUD_URL. Websockets only, and never ws: a device token travels in the handshake.
//
// The host only. `hubUrl` and `teamHubUrl` below add the path, so the client dials
// `wss://hub.nolzu.com/connect`.
export const HUB_URL = 'wss://hub.nolzu.com';

// The server owns the shape of these, so they are in one place and nothing spells a path twice.
export const PATHS = {
  code: '/api/auth/device/code',
  token: '/api/device/token',
  access: '/api/device/access',
  account: '/api/device/account',
  revoke: '/api/device/revoke',
} as const;

export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

// RFC 8628 section 3.5: a client told to slow down adds five seconds to its wait and keeps the longer
// wait for the rest of the login. The server answers `slow_down` and no new interval, so the step is
// the client's to know.
export const SLOW_DOWN_SECONDS = 5;

// What the server says when nobody has approved the code yet. Everything else ends the login.
const PENDING = 'authorization_pending';
const SLOW_DOWN = 'slow_down';
const DENIED = 'access_denied';
const EXPIRED = 'expired_token';

// The server to talk to. Another server answers on a host of its own, and a test answers on none.
export const cloudUrl = (env: Record<string, string | undefined>): string => env.NOLZU_CLOUD_URL ?? CLOUD_URL;

// The hub host to dial. Another server answers on a host of its own, and a test answers on none. A
// trailing slash on the override is dropped, so a typed address cannot make a double slash in the path.
const hubHost = (env: Record<string, string | undefined>): string => (env.NOLZU_HUB_URL ?? HUB_URL).replace(/\/$/, '');

// The hub to dial, with the connect path both halves read from the protocol package.
export const hubUrl = (env: Record<string, string | undefined>): string => `${hubHost(env)}${HUB_PATH}`;

// The team hub, on the same host and a path of its own. A WebSocket sends no header its caller chose,
// so the path is the only thing that tells a team dial from the personal one: same host, same device
// token, same handshake.
export const teamHubUrl = (env: Record<string, string | undefined>): string => `${hubHost(env)}${TEAM_HUB_PATH}`;

// The server's rule for a machine name: letters, digits, dots, dashes and underscores, starting and
// ending on a letter or a digit, up to 64 characters. A hostname that breaks it is cleaned here rather
// than refused by the server, because the person did not choose their hostname.
export function machineName(hostname: string): string {
  const name = hostname
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .slice(0, 64)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '');
  return name === '' ? 'machine' : name;
}

// The OS in the word a person reads on the approval page and the machines list, or null for a system
// Nolzu does not name, which leaves the field out. Today's server ignores a field it does not know.
export function osName(platform: string): string | null {
  return ({ darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[platform] ?? null;
}

// What the client needs from fetch, so a test answers with a stub and no test opens a socket.
export interface HttpAnswer {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpAnswer>;

export interface Cloud {
  keychain: Keychain;
  baseUrl: string;
  // This machine's name, as the person will see it on the approval page and on their devices list.
  machine: string;
  // Where a line for the person goes. The commands print as they go, because a login waits for a
  // human and a silent minute looks like a hang.
  say: (line: string) => void;
  fetch?: HttpFetch;
}

export type LoginOutcome = { kind: 'signed-in'; machine: string } | { kind: 'denied' } | { kind: 'expired' };

export type StatusReport =
  | { kind: 'no-account' }
  | { kind: 'refused' }
  | { kind: 'account'; email: string; plan: string; machine: string };

export type LogoutReport = { kind: 'no-account' } | { kind: 'signed-out'; revoked: boolean };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const fields = (body: unknown): Record<string, unknown> => (typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {});

const text = (body: unknown, name: string): string => {
  const value = fields(body)[name];
  return typeof value === 'string' ? value : '';
};

const seconds = (body: unknown, name: string, fallback: number): number => {
  const value = fields(body)[name];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
};

// Why the server said no, in its own words where it gave any. A status on its own tells the person
// nothing, but it is better than a sentence that invents a reason.
const refusal = (what: string, body: unknown, status: number): string => {
  const said = text(body, 'error_description') || text(body, 'error') || text(body, 'message');
  return said === '' ? `${what} (the server answered ${status}).` : `${what}: ${said}`;
};

const answered = (answer: HttpAnswer): Promise<unknown> => answer.json().catch(() => null);

const post = (cloud: Cloud, path: string, body?: unknown, token?: string): Promise<HttpAnswer> =>
  (cloud.fetch ?? httpFetch)(`${cloud.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const get = (cloud: Cloud, path: string, token: string): Promise<HttpAnswer> =>
  (cloud.fetch ?? httpFetch)(`${cloud.baseUrl}${path}`, { method: 'GET', headers: { authorization: `Bearer ${token}` } });

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

/** Ask the server for a code to show the person. */
export async function askForCode(cloud: Cloud): Promise<DeviceCode> {
  const os = osName(process.platform);
  const answer = await post(cloud, PATHS.code, { client_id: `${CLIENT_PREFIX}${cloud.machine}`, ...(os === null ? {} : { os }) });
  const body = await answered(answer);
  if (!answer.ok) throw new Error(refusal('This machine could not start the login', body, answer.status));

  const code = { deviceCode: text(body, 'device_code'), userCode: text(body, 'user_code'), verificationUri: text(body, 'verification_uri') };
  if (code.deviceCode === '' || code.userCode === '' || code.verificationUri === '') {
    throw new Error('The server started the login without a code. Run npx nolzu@latest login again.');
  }
  // The fallbacks are the values the server is configured with. A server that stopped sending them
  // would otherwise make the client poll with no wait at all.
  return { ...code, expiresInSeconds: seconds(body, 'expires_in', 900), intervalSeconds: seconds(body, 'interval', 5) };
}

/**
 * Poll until the person approves the code, denies it, or lets it expire.
 *
 * The wait between polls is the server's, and `slow_down` makes it longer for good. Polling faster
 * than the server allows earns nothing: every early poll is refused, and the login would run out of
 * time without a single real answer.
 */
async function waitForApproval(cloud: Cloud, code: DeviceCode): Promise<{ deviceToken: string; machine: string } | { kind: 'denied' | 'expired' }> {
  let waitMs = code.intervalSeconds * 1000;
  const deadline = Date.now() + code.expiresInSeconds * 1000;

  while (Date.now() < deadline) {
    await sleep(waitMs);
    const answer = await post(cloud, PATHS.token, { grant_type: DEVICE_CODE_GRANT, device_code: code.deviceCode, client_id: `${CLIENT_PREFIX}${cloud.machine}` });
    const body = await answered(answer);

    if (answer.ok) {
      const deviceToken = text(body, 'device_token');
      if (deviceToken === '') throw new Error('The server approved this machine without a token. Run npx nolzu@latest login again.');
      return { deviceToken, machine: text(body, 'machine') || cloud.machine };
    }

    const said = text(body, 'error');
    if (said === SLOW_DOWN) waitMs += SLOW_DOWN_SECONDS * 1000;
    else if (said === DENIED) return { kind: 'denied' };
    else if (said === EXPIRED) return { kind: 'expired' };
    else if (said !== PENDING) throw new Error(refusal('The login stopped', body, answer.status));
  }

  // The server would answer `expired_token` in time, but a client that trusts it alone polls forever
  // when it does not.
  return { kind: 'expired' };
}

/**
 * Sign this machine in.
 *
 * The device token is written to the keychain and nowhere else. A token that cannot be stored is a
 * failed login, not a login with the secret left in a file.
 */
export async function login(cloud: Cloud): Promise<LoginOutcome> {
  const code = await askForCode(cloud);
  cloud.say(`Open ${code.verificationUri} to approve this machine.`);
  cloud.say(`Your code is ${code.userCode}`);
  cloud.say('Waiting for approval.');

  const approved = await waitForApproval(cloud, code);
  if ('kind' in approved) return approved;

  await cloud.keychain.write(DEVICE_TOKEN_NAME, approved.deviceToken);
  return { kind: 'signed-in', machine: approved.machine };
}

/**
 * Trade the device token for an access token, or null when the server will not have it.
 *
 * Null covers a token that was revoked and one that was never issued. The server answers the same
 * either way on purpose, and there is nothing for the client to add.
 */
async function accessToken(cloud: Cloud, deviceToken: string): Promise<string | null> {
  const answer = await post(cloud, PATHS.access, undefined, deviceToken);
  const body = await answered(answer);
  if (answer.status === 401) return null;
  if (!answer.ok) throw new Error(refusal('This machine could not reach its account', body, answer.status));
  const token = text(body, 'access_token');
  if (token === '') throw new Error('The server answered with no access token. Run npx nolzu@latest login again.');
  return token;
}

/**
 * The access token this machine can use, or null.
 *
 * Null when the machine has no account and when the server will not have its device token. Every
 * failure is a null, because the callers are background steps that must not stop what they run in.
 */
export async function machineAccessToken(cloud: Cloud): Promise<string | null> {
  const deviceToken = await cloud.keychain.read(DEVICE_TOKEN_NAME);
  if (deviceToken === null) return null;
  return accessToken(cloud, deviceToken).catch(() => null);
}

/**
 * What `nolzu status` prints.
 *
 * The plan comes from the server, never from the signed display document. That document says what
 * menus to draw and is not an answer to a person asking what they pay for. Minting an access token
 * first is the point as much as the account is: it proves the whole path a paid feature uses.
 */
export async function status(cloud: Cloud): Promise<StatusReport> {
  const deviceToken = await cloud.keychain.read(DEVICE_TOKEN_NAME);
  if (deviceToken === null) return { kind: 'no-account' };

  const token = await accessToken(cloud, deviceToken);
  if (token === null) return { kind: 'refused' };

  const answer = await get(cloud, PATHS.account, token);
  const body = await answered(answer);
  if (answer.status === 401) return { kind: 'refused' };
  if (!answer.ok) throw new Error(refusal('This machine could not read its account', body, answer.status));

  return { kind: 'account', email: text(body, 'email'), plan: text(body, 'plan'), machine: text(body, 'machine') || cloud.machine };
}

/**
 * Sign this machine out.
 *
 * The keychain entry goes whatever the server says. A logout that leaves the token on the machine
 * because the network was down is the worse failure of the two, and the person can remove the machine
 * on the devices page.
 */
export async function logout(cloud: Cloud): Promise<LogoutReport> {
  const deviceToken = await cloud.keychain.read(DEVICE_TOKEN_NAME);
  if (deviceToken === null) return { kind: 'no-account' };

  const revoked = await revoke(cloud, deviceToken).catch(() => false);
  await cloud.keychain.remove(DEVICE_TOKEN_NAME);
  return { kind: 'signed-out', revoked };
}

async function revoke(cloud: Cloud, deviceToken: string): Promise<boolean> {
  const token = await accessToken(cloud, deviceToken);
  // A token the server has already forgotten is as revoked as one it forgets now.
  if (token === null) return true;
  const answer = await post(cloud, PATHS.revoke, undefined, token);
  return answer.ok;
}

/**
 * Run one of the three account commands and answer with the exit code.
 *
 * The bin holds no flow of its own: it builds the keychain and the address and calls this, so the
 * whole of `nolzu login` is testable without a process.
 */
export async function accountCommand(kind: 'login' | 'logout' | 'status', cloud: Cloud): Promise<number> {
  if (kind === 'login') {
    const outcome = await login(cloud);
    if (outcome.kind === 'signed-in') {
      cloud.say(`${outcome.machine} is signed in.`);
      return 0;
    }
    cloud.say(outcome.kind === 'denied' ? 'The login was refused in the browser. This machine is not signed in.' : 'The code ran out of time before it was approved. Run npx nolzu@latest login again.');
    return 1;
  }

  if (kind === 'status') {
    const report = await status(cloud);
    // Not being signed in is a normal state for this product, so it is not a failure.
    if (report.kind === 'no-account') {
      cloud.say('This machine is not signed in. Run npx nolzu@latest login to connect it to a Nolzu account.');
      return 0;
    }
    if (report.kind === 'refused') {
      cloud.say('The account no longer accepts this machine. Run npx nolzu@latest login again.');
      return 1;
    }
    cloud.say(`Account: ${report.email}`);
    cloud.say(`Plan: ${report.plan}`);
    cloud.say(`Machine: ${report.machine}`);
    return 0;
  }

  const report = await logout(cloud);
  if (report.kind === 'no-account') {
    cloud.say('This machine was not signed in.');
    return 0;
  }
  cloud.say('This machine is signed out.');
  if (!report.revoked) cloud.say(`The server could not be reached, so it may still list this machine. Remove it at ${cloud.baseUrl}/devices.`);
  return 0;
}

// The real fetch behind the small interface above.
export const httpFetch: HttpFetch = (url, init) => fetch(url, init);
