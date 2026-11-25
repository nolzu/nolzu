import { HUB_PATH, TEAM_HUB_PATH } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_TOKEN_NAME } from './hub.ts';
import type { Keychain } from './keychain.ts';
import {
  accountCommand,
  CLIENT_PREFIX,
  CLOUD_URL,
  cloudUrl,
  type Cloud,
  DEVICE_CODE_GRANT,
  type HttpAnswer,
  type HttpFetch,
  HUB_URL,
  hubUrl,
  login,
  logout,
  machineName,
  osName,
  PATHS,
  status,
  teamHubUrl,
} from './login.ts';

const MACHINE = 'studio-mbp';
const BASE = 'https://app.example.test';
const DEVICE_TOKEN = 'device-token-value';
const ACCESS_TOKEN = 'access-token-value';

// The keychain of a machine, in memory, so no test touches the real one. CI has none at all.
function stubKeychain(holds?: string) {
  const secrets = new Map<string, string>();
  if (holds !== undefined) secrets.set(DEVICE_TOKEN_NAME, holds);
  const keychain: Keychain = {
    read: async (name) => secrets.get(name) ?? null,
    write: async (name, secret) => void secrets.set(name, secret),
    remove: async (name) => void secrets.delete(name),
  };
  return { secrets, keychain };
}

const answer = (status: number, body: unknown = null): HttpAnswer => ({ ok: status >= 200 && status < 300, status, json: async () => body });

interface ServerRules {
  // How many polls the server answers before the person approves the code.
  approveAfterPolls?: number;
  deny?: boolean;
  expire?: boolean;
  // The wait the server tells the client to keep.
  interval?: number;
  // The wait the server enforces. Longer than `interval` is the case where the client is told
  // to slow down.
  needsSeconds?: number;
  expiresIn?: number;
  // 401 for a device token the server will not have, which is a revoked machine.
  accessStatus?: number;
  accountStatus?: number;
  revokeStatus?: number;
  plan?: string;
}

/**
 * The hosted server, stubbed. It answers the five paths the client calls, the way the real one answers them,
 * and refuses a poll that arrives too early exactly as the real one does: the refusal does not count
 * as a poll, so the next wait is still measured from the last poll it accepted.
 */
function stubServer(rules: ServerRules = {}) {
  const interval = rules.interval ?? 5;
  const needsMs = (rules.needsSeconds ?? interval) * 1000;
  const polledAt: number[] = [];
  const paths: string[] = [];
  const codeAsks: Record<string, unknown>[] = [];
  let acceptedPoll = 0;
  let polls = 0;

  const fetch: HttpFetch = async (url, init) => {
    const path = url.slice(BASE.length);
    // As strictly as the server reads it: a header with no scheme carries no token, so a client that
    // drops the prefix fails here instead of passing.
    const token = /^Bearer (.+)$/.exec(init.headers.authorization ?? '')?.[1];
    paths.push(path);

    if (path === PATHS.code) {
      const asked = JSON.parse(init.body ?? '{}') as { client_id?: string };
      codeAsks.push(asked);
      if (asked.client_id !== `${CLIENT_PREFIX}${MACHINE}`) return answer(400, { error: 'invalid_client', error_description: 'Invalid client ID' });
      return answer(200, {
        device_code: 'device-code-1',
        user_code: 'ABCD2345',
        verification_uri: `${BASE}/device`,
        verification_uri_complete: `${BASE}/device?user_code=ABCD2345`,
        expires_in: rules.expiresIn ?? 900,
        interval,
      });
    }

    if (path === PATHS.token) {
      const asked = JSON.parse(init.body ?? '{}') as { grant_type?: string };
      if (asked.grant_type !== DEVICE_CODE_GRANT) return answer(400, { error: 'unsupported_grant_type', error_description: 'That grant type is not supported' });
      polledAt.push(Date.now());
      if (acceptedPoll !== 0 && Date.now() - acceptedPoll < needsMs) return answer(400, { error: 'slow_down', error_description: 'Polling too frequently' });
      acceptedPoll = Date.now();
      polls += 1;
      if (rules.deny === true) return answer(400, { error: 'access_denied', error_description: 'The request was denied' });
      if (rules.expire === true) return answer(400, { error: 'expired_token', error_description: 'The device code has expired' });
      if (polls < (rules.approveAfterPolls ?? 1)) return answer(400, { error: 'authorization_pending', error_description: 'Nobody has approved this yet' });
      return answer(200, { device_token: DEVICE_TOKEN, token_type: 'Bearer', machine: MACHINE });
    }

    if (path === PATHS.access) {
      if (rules.accessStatus === 401 || token !== DEVICE_TOKEN) return answer(401, { error: 'invalid_token', error_description: 'That device token does not work' });
      return answer(200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 7200 });
    }

    if (path === PATHS.account) {
      if (rules.accountStatus === 401 || token !== ACCESS_TOKEN) return answer(401, { error: 'invalid_token', error_description: 'That access token does not work' });
      return answer(200, { email: 'someone@example.test', plan: rules.plan ?? 'solo', machine: MACHINE });
    }

    if (path === PATHS.revoke) {
      if (token !== ACCESS_TOKEN) return answer(401, { error: 'invalid_token', error_description: 'That access token does not work' });
      return answer(rules.revokeStatus ?? 204);
    }

    return answer(404, { error: 'not_found', error_description: `${path} is not a path here` });
  };

  // The wait the client kept between one poll and the next.
  const gaps = () => polledAt.slice(1).map((at, index) => at - (polledAt[index] ?? 0));
  return { fetch, polledAt, gaps, paths, codeAsks };
}

function stubCloud(server: { fetch: HttpFetch }, keychain: Keychain) {
  const said: string[] = [];
  const cloud: Cloud = { keychain, baseUrl: BASE, machine: MACHINE, say: (line) => void said.push(line), fetch: server.fetch };
  return { cloud, said };
}

describe('machineName', () => {
  it('keeps a hostname the server already accepts', () => {
    expect(machineName('studio-mbp.local')).toBe('studio-mbp.local');
  });

  // The person did not choose their hostname, and a login refused over a character in it would be
  // impossible to act on.
  it('replaces a character the server would refuse', () => {
    expect(machineName('my laptop')).toBe('my-laptop');
  });

  it('cuts a long name to 64 characters and still ends on a letter or a digit', () => {
    const name = machineName(`${'a'.repeat(63)}-tail`);

    expect(name).toHaveLength(63);
    expect(name.endsWith('a')).toBe(true);
  });

  it('falls back to a name rather than sending an empty one', () => {
    expect(machineName('...')).toBe('machine');
    expect(machineName('')).toBe('machine');
  });
});

// The approval page names the machine with its OS, in a word a person reads.
describe('osName', () => {
  it('names the two systems Nolzu runs on in plain words', () => {
    expect(osName('darwin')).toBe('macOS');
    expect(osName('linux')).toBe('Linux');
  });

  it('names no other system, so the field is left out', () => {
    expect(osName('freebsd')).toBeNull();
  });
});

describe('cloudUrl', () => {
  it('is the hosted server', () => {
    expect(cloudUrl({})).toBe(CLOUD_URL);
  });

  // Another server answers on a host of its own, and so does the stub in a test.
  it('takes the address from the environment when it is set', () => {
    expect(cloudUrl({ NOLZU_CLOUD_URL: BASE })).toBe(BASE);
  });
});

describe('hubUrl', () => {
  it('is the hub host with the connect path both halves read from the protocol', () => {
    expect(hubUrl({})).toBe(`${HUB_URL}${HUB_PATH}`);
    // Websockets only. The device token travels in the handshake, so a plain ws address would put it
    // on the wire in the clear.
    expect(HUB_URL.startsWith('wss://')).toBe(true);
  });

  // Another hub answers on a host of its own, and a local test hub answers on localhost.
  it('takes the address from the environment, with or without a trailing slash', () => {
    expect(hubUrl({ NOLZU_HUB_URL: 'ws://localhost:8787' })).toBe('ws://localhost:8787/connect');
    expect(hubUrl({ NOLZU_HUB_URL: 'ws://localhost:8787/' })).toBe('ws://localhost:8787/connect');
  });

  // Two addresses, because the hub is a service of its own. One constant for both would send the
  // handshake to the web app.
  it('is not the cloud address', () => {
    expect(hubUrl({})).not.toContain(CLOUD_URL);
  });

  // The host written out, not read back from the constant, so a default that moved shows up here. The
  // override still wins over it, which is how another or a local hub is reached.
  it('dials hub.nolzu.com over wss unless the environment names another hub', () => {
    expect(hubUrl({})).toBe('wss://hub.nolzu.com/connect');
    expect(hubUrl({ NOLZU_HUB_URL: 'wss://staging-hub.example' })).toBe('wss://staging-hub.example/connect');
  });
});

// The second address. The same host and a path of its own: a WebSocket sends no header its caller
// chose, so the path is the only thing that tells a team dial from the personal one.
describe('teamHubUrl', () => {
  it('is the hub host with the team connect path', () => {
    // Written out and not read back from the constant, so a path that moved shows up here.
    expect(teamHubUrl({})).toBe('wss://hub.nolzu.com/connect/team');
    expect(teamHubUrl({ NOLZU_HUB_URL: 'ws://localhost:8787' })).toBe('ws://localhost:8787/connect/team');
    expect(teamHubUrl({ NOLZU_HUB_URL: 'ws://localhost:8787/' })).toBe('ws://localhost:8787/connect/team');
  });

  // The personal path is the start of the team one. A client that dropped the tail would dial the
  // personal hub with the same token, and the hub could not tell the two requests apart.
  it('is a longer path than the personal hub, on the same host', () => {
    expect(teamHubUrl({})).not.toBe(hubUrl({}));
    expect(teamHubUrl({}).startsWith(hubUrl({}))).toBe(true);
    expect(TEAM_HUB_PATH.startsWith(HUB_PATH)).toBe(true);
  });
});

describe('npx nolzu@latest login', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('prints the code, waits for approval, and stores the device token', async () => {
    const server = stubServer({ approveAfterPolls: 2 });
    const { secrets, keychain } = stubKeychain();
    const { cloud, said } = stubCloud(server, keychain);

    const running = login(cloud);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await running).toEqual({ kind: 'signed-in', machine: MACHINE });
    expect(said.join('\n')).toContain(`${BASE}/device`);
    expect(said.join('\n')).toContain('ABCD2345');
    // Under the one name the hub connection reads, so login and the hub cannot drift apart.
    expect(secrets.get(DEVICE_TOKEN_NAME)).toBe(DEVICE_TOKEN);
  });

  it('sends the machine name and its OS with the device code request, and nothing else', async () => {
    const server = stubServer();
    const { cloud } = stubCloud(server, stubKeychain().keychain);

    const running = login(cloud);
    await vi.advanceTimersByTimeAsync(30_000);
    await running;

    const os = osName(process.platform);
    expect(server.codeAsks).toEqual([{ client_id: `${CLIENT_PREFIX}${MACHINE}`, ...(os === null ? {} : { os }) }]);
  });

  it('waits the interval the server asked for before the first poll', async () => {
    const server = stubServer({ interval: 5 });
    const { cloud } = stubCloud(server, stubKeychain().keychain);

    void login(cloud);
    await vi.advanceTimersByTimeAsync(4999);
    expect(server.polledAt).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(server.polledAt).toHaveLength(1);
  });

  /**
   * The case the client has to get right. The server tells the client five seconds and enforces ten,
   * which is what a tightened limit looks like from here. A client that ignores `slow_down` keeps
   * polling every five seconds, every poll is refused, and the login runs out of time without a
   * single real answer.
   */
  it('honours slow_down by waiting longer, instead of polling at the same rate', async () => {
    const server = stubServer({ interval: 5, needsSeconds: 10, approveAfterPolls: 2 });
    const { secrets, keychain } = stubKeychain();
    const { cloud } = stubCloud(server, keychain);

    const running = login(cloud);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await running).toEqual({ kind: 'signed-in', machine: MACHINE });
    expect(secrets.get(DEVICE_TOKEN_NAME)).toBe(DEVICE_TOKEN);
    // Five seconds, then ten for every poll after the refusal, and never five again.
    expect(server.gaps()[0]).toBe(5000);
    expect(server.gaps().slice(1).every((gap) => gap === 10_000)).toBe(true);
    // Three polls: the first one, the one that was refused, and the one the longer wait earned.
    expect(server.polledAt).toHaveLength(3);
  });

  it('keeps the longer wait for the rest of the login', async () => {
    const server = stubServer({ interval: 5, needsSeconds: 10, approveAfterPolls: 4 });
    const { cloud } = stubCloud(server, stubKeychain().keychain);

    const running = login(cloud);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await running).toMatchObject({ kind: 'signed-in' });
    // Five polls: one refusal and four the server accepted. A wait that went back to five seconds
    // would earn a second refusal and a sixth poll.
    expect(server.paths.filter((path) => path === PATHS.token)).toHaveLength(5);
  });

  it('stops when the person refuses the machine in the browser', async () => {
    const server = stubServer({ deny: true });
    const { secrets, keychain } = stubKeychain();
    const { cloud } = stubCloud(server, keychain);

    const running = login(cloud);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await running).toEqual({ kind: 'denied' });
    expect(secrets.size).toBe(0);
    // One poll and no more. A denied code is denied for good.
    expect(server.polledAt).toHaveLength(1);
  });

  it('stops on a code the server says has expired', async () => {
    const server = stubServer({ expire: true });
    const { secrets, keychain } = stubKeychain();
    const { cloud } = stubCloud(server, keychain);

    const running = login(cloud);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await running).toEqual({ kind: 'expired' });
    expect(secrets.size).toBe(0);
  });

  // A server that keeps saying "nobody has approved it" would otherwise leave the command waiting for
  // as long as the person leaves the terminal open.
  it('gives up when the code has run out of time, even if the server never says so', async () => {
    const server = stubServer({ expiresIn: 60, approveAfterPolls: 1000 });
    const { cloud } = stubCloud(server, stubKeychain().keychain);

    const running = login(cloud);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(await running).toEqual({ kind: 'expired' });
    // Thirteen polls fit in sixty seconds at five seconds each, and nothing polls after the deadline.
    expect(server.polledAt.length).toBeLessThanOrEqual(13);
  });

  it('says what the server said when it refuses to start the login', async () => {
    const { cloud } = stubCloud(stubServer(), stubKeychain().keychain);

    await expect(login({ ...cloud, machine: 'not-this-client' })).rejects.toThrow(/Invalid client ID/);
  });
});

describe('nolzu status', () => {
  it('says the machine is not signed in when the keychain holds no token', async () => {
    const server = stubServer();
    const { cloud } = stubCloud(server, stubKeychain().keychain);

    expect(await status(cloud)).toEqual({ kind: 'no-account' });
    // Nothing is asked of the server, because there is nothing to ask with.
    expect(server.paths).toEqual([]);
  });

  it('mints an access token first, then reads the account and the plan', async () => {
    const server = stubServer({ plan: 'team' });
    const { cloud } = stubCloud(server, stubKeychain(DEVICE_TOKEN).keychain);

    expect(await status(cloud)).toEqual({ kind: 'account', email: 'someone@example.test', plan: 'team', machine: MACHINE });
    // In that order: the access token is the path a paid feature uses, so `status` proves it works.
    expect(server.paths).toEqual([PATHS.access, PATHS.account]);
  });

  it('reports a device token the account no longer accepts', async () => {
    const { cloud } = stubCloud(stubServer({ accessStatus: 401 }), stubKeychain(DEVICE_TOKEN).keychain);

    expect(await status(cloud)).toEqual({ kind: 'refused' });
  });

  it('reports an access token the account no longer accepts', async () => {
    const { cloud } = stubCloud(stubServer({ accountStatus: 401 }), stubKeychain(DEVICE_TOKEN).keychain);

    expect(await status(cloud)).toEqual({ kind: 'refused' });
  });
});

describe('nolzu logout', () => {
  it('revokes the machine on the server and then forgets the token', async () => {
    const server = stubServer();
    const { secrets, keychain } = stubKeychain(DEVICE_TOKEN);
    const { cloud } = stubCloud(server, keychain);

    expect(await logout(cloud)).toEqual({ kind: 'signed-out', revoked: true });
    expect(secrets.size).toBe(0);
    expect(server.paths).toEqual([PATHS.access, PATHS.revoke]);
  });

  // A token left on the machine because the network was down is the worse of the two failures.
  it('forgets the token even when the server cannot be reached', async () => {
    const { secrets, keychain } = stubKeychain(DEVICE_TOKEN);
    const cloud: Cloud = {
      keychain,
      baseUrl: BASE,
      machine: MACHINE,
      say: () => {},
      fetch: async () => {
        throw new Error('getaddrinfo ENOTFOUND app.example.test');
      },
    };

    expect(await logout(cloud)).toEqual({ kind: 'signed-out', revoked: false });
    expect(secrets.size).toBe(0);
  });

  it('forgets the token when the server refuses the revoke', async () => {
    const { secrets, keychain } = stubKeychain(DEVICE_TOKEN);
    const { cloud } = stubCloud(stubServer({ revokeStatus: 500 }), keychain);

    expect(await logout(cloud)).toEqual({ kind: 'signed-out', revoked: false });
    expect(secrets.size).toBe(0);
  });

  // The server forgot the machine already, which is what a revoke from the devices page leaves behind.
  it('counts a token the server has already forgotten as revoked', async () => {
    const { secrets, keychain } = stubKeychain(DEVICE_TOKEN);
    const { cloud } = stubCloud(stubServer({ accessStatus: 401 }), keychain);

    expect(await logout(cloud)).toEqual({ kind: 'signed-out', revoked: true });
    expect(secrets.size).toBe(0);
  });

  it('does nothing when the machine was not signed in', async () => {
    const server = stubServer();
    const { cloud } = stubCloud(server, stubKeychain().keychain);

    expect(await logout(cloud)).toEqual({ kind: 'no-account' });
    expect(server.paths).toEqual([]);
  });
});

describe('accountCommand', () => {
  it('names the command that signs in, and does not fail, when there is no account', async () => {
    const { cloud, said } = stubCloud(stubServer(), stubKeychain().keychain);

    expect(await accountCommand('status', cloud)).toBe(0);
    expect(said.join('\n')).toContain('npx nolzu@latest login');
  });

  it('prints the account, the plan and the machine', async () => {
    const { cloud, said } = stubCloud(stubServer({ plan: 'team' }), stubKeychain(DEVICE_TOKEN).keychain);

    expect(await accountCommand('status', cloud)).toBe(0);
    expect(said).toEqual(['Account: someone@example.test', 'Plan: team', `Machine: ${MACHINE}`]);
  });

  it('fails when the account no longer accepts this machine', async () => {
    const { cloud, said } = stubCloud(stubServer({ accessStatus: 401 }), stubKeychain(DEVICE_TOKEN).keychain);

    expect(await accountCommand('status', cloud)).toBe(1);
    expect(said.join('\n')).toContain('npx nolzu@latest login');
  });

  it('points at the devices page when the logout could not be told to the server', async () => {
    const { cloud, said } = stubCloud(stubServer({ revokeStatus: 500 }), stubKeychain(DEVICE_TOKEN).keychain);

    expect(await accountCommand('logout', cloud)).toBe(0);
    expect(said.join('\n')).toContain(`${BASE}/devices`);
  });

  it('says nothing about the devices page when the revoke worked', async () => {
    const { cloud, said } = stubCloud(stubServer(), stubKeychain(DEVICE_TOKEN).keychain);

    expect(await accountCommand('logout', cloud)).toBe(0);
    expect(said.join('\n')).not.toContain('/devices');
  });

  it('fails a login the person refused', async () => {
    vi.useFakeTimers();
    try {
      const { cloud, said } = stubCloud(stubServer({ deny: true }), stubKeychain().keychain);

      const running = accountCommand('login', cloud);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await running).toBe(1);
      expect(said.at(-1)).toContain('not signed in');
    } finally {
      vi.useRealTimers();
    }
  });
});
