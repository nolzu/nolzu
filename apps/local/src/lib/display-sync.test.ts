import { readFileSync } from 'node:fs';
import { base64urlEncode, displayPayload, type DisplayEntitlement, type SignedDisplay } from '@nolzu/protocol';
import { DEVICE_TOKEN_NAME, PATHS, type Cloud, type HttpAnswer, type Keychain } from '@nolzu/runner';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CloudLinks from './CloudLinks.svelte';
import { accountHref, FREE } from './display.ts';
import { currentDisplay, fetchDisplay, forgetDisplay, RETRY_AFTER_SECONDS, type DisplayFetch } from './display-sync.ts';

// The cloud waits for the paid plans. This file pins the asking kept for then, and cloud-closed.test.ts
// pins that a closed cloud asks nothing.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true }));

const NOW = 1_800_000_000;
const BASE = 'https://cloud.example';
const DEVICE_TOKEN = 'device-token-1';
const ACCESS_TOKEN = 'access-token-1';

type KeyPair = { privateKey: unknown; publicKey: unknown };
const subtle = crypto.subtle as unknown as {
  generateKey: (...a: unknown[]) => Promise<KeyPair>;
  exportKey: (...a: unknown[]) => Promise<ArrayBuffer>;
  sign: (...a: unknown[]) => Promise<ArrayBuffer>;
};

// No test can sign with the real key, so every one of them makes its own.
async function keys() {
  const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { pair, publicKey: base64urlEncode(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))) };
}

const document = (over: Partial<DisplayEntitlement> = {}): DisplayEntitlement => ({
  id: 'u1',
  plan: 'solo',
  features: ['cloud-board', 'evidence-history'],
  seats: 1,
  expiresAt: NOW + 900,
  ...over,
});

async function sign(doc: DisplayEntitlement, pair: KeyPair): Promise<SignedDisplay> {
  const signature = new Uint8Array(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, displayPayload(doc)));
  return { document: doc, signature: base64urlEncode(signature) };
}

const keychain = (token: string | null): Keychain => ({
  read: async (name) => (name === DEVICE_TOKEN_NAME ? token : null),
  write: async () => {},
  remove: async () => {},
});

const answer = (status: number, body: unknown = {}): HttpAnswer => ({ ok: status < 400, status, json: async () => body });

// A machine that is signed in. Only the access token path is answered here: the document itself
// comes from the fetch passed to currentDisplay, so a test can refuse it on its own.
function stubCloud(token: string | null = DEVICE_TOKEN): Cloud {
  return {
    keychain: keychain(token),
    baseUrl: BASE,
    machine: 'studio.local',
    say: () => {},
    fetch: async (url, init) => {
      if (url === `${BASE}${PATHS.access}` && init.headers.authorization === `Bearer ${DEVICE_TOKEN}`) {
        return answer(200, { access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 7200 });
      }
      return answer(401, { error: 'invalid_token' });
    },
  };
}

// What the route answers. `asked` records the calls, so a test can prove the token went with them.
function stubRoute(body: SignedDisplay | null, status = 200) {
  const asked: { url: string; authorization: string | undefined }[] = [];
  const fetch: DisplayFetch = async (url, init) => {
    asked.push({ url, authorization: init.headers.authorization });
    return { ok: status < 400, status, json: async () => body };
  };
  return { fetch, asked };
}

// The links Settings, Cloud draws. Only the account link changes with the document, so the
// test reads them the way a person does and not the prop they were given.
const links = (account: string | null) => render(CloudLinks, { props: { account, team: null } }).body;

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  forgetDisplay();
  vi.restoreAllMocks();
});

afterEach(() => {
  forgetDisplay();
});

describe('the document this machine draws its menus from', () => {
  it('draws the Solo shape from a document the server signed', async () => {
    const { pair, publicKey } = await keys();
    const route = stubRoute(await sign(document(), pair));

    const drawn = await currentDisplay(stubCloud(), route.fetch, [publicKey], NOW);

    expect(drawn.plan).toBe('solo');
    expect(drawn.features).toContain('cloud-board');
    // The access token minted from the keychain token, on the route the server owns.
    expect(route.asked).toEqual([{ url: `${BASE}/api/display`, authorization: `Bearer ${ACCESS_TOKEN}` }]);
    expect(text(links(accountHref(drawn, BASE)))).toContain('Account');
    expect(links(accountHref(drawn, BASE))).toContain(`href="${BASE}/account"`);
  });

  it('draws Free for a document signed with another key', async () => {
    const mine = await keys();
    const theirs = await keys();
    const route = stubRoute(await sign(document(), theirs.pair));

    const drawn = await currentDisplay(stubCloud(), route.fetch, [mine.publicKey], NOW);

    expect(drawn).toEqual(FREE);
    expect(text(links(accountHref(drawn, BASE)))).not.toContain('Account');
  });

  it('draws Free for a document that has run out', async () => {
    const { pair, publicKey } = await keys();
    const route = stubRoute(await sign(document({ expiresAt: NOW }), pair));

    const drawn = await currentDisplay(stubCloud(), route.fetch, [publicKey], NOW);

    expect(drawn).toEqual(FREE);
    expect(text(links(accountHref(drawn, BASE)))).not.toContain('Account');
  });

  it('draws Free with no error on screen when the route answers 503', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const route = stubRoute(null, 503);

    const drawn = await currentDisplay(stubCloud(), route.fetch, [], NOW);

    expect(drawn).toEqual(FREE);
    // Free is the whole local product. A server with no signing key is nothing to tell the
    // person about, so Settings loses the link and the screen says nothing.
    const drawnLinks = text(links(accountHref(drawn, BASE)));
    expect(drawnLinks).not.toContain('Account');
    expect(drawnLinks).not.toMatch(/error|failed|could not/i);
    expect(said).not.toHaveBeenCalled();
    expect(warned).not.toHaveBeenCalled();
  });

  // The test above cannot tell the status check from the signature check, because it hands the route
  // no body and no key. This one signs a real document with a key the client trusts and answers it
  // with a 503, so only the status can turn it down.
  it('turns down a document the route answers with 503, however well it is signed', async () => {
    const { pair, publicKey } = await keys();
    const route = stubRoute(await sign(document(), pair), 503);

    expect(await currentDisplay(stubCloud(), route.fetch, [publicKey], NOW)).toEqual(FREE);
  });

  it('draws Free for a machine with no account, and asks the route nothing', async () => {
    const route = stubRoute(null);

    expect(await currentDisplay(stubCloud(null), route.fetch, [], NOW)).toEqual(FREE);
    expect(route.asked).toEqual([]);
  });
});

describe('when the server is asked again', () => {
  it('holds the document until half its life is gone', async () => {
    const { pair, publicKey } = await keys();
    const route = stubRoute(await sign(document({ expiresAt: NOW + 900 }), pair));

    await currentDisplay(stubCloud(), route.fetch, [publicKey], NOW);
    await currentDisplay(stubCloud(), route.fetch, [publicKey], NOW + 449);
    expect(route.asked).toHaveLength(1);

    await currentDisplay(stubCloud(), route.fetch, [publicKey], NOW + 450);
    expect(route.asked).toHaveLength(2);
  });

  it('draws Free once a held document has run out, whatever the wait says', async () => {
    const { pair, publicKey } = await keys();
    // One second of life, so half of it rounds down to nothing and the wait falls back to the
    // minute. Without the expiry check the old menus would stay up for the rest of that minute.
    const route = stubRoute(await sign(document({ expiresAt: NOW + 1 }), pair));

    expect((await currentDisplay(stubCloud(), route.fetch, [publicKey], NOW)).plan).toBe('solo');
    expect(await currentDisplay(stubCloud(), route.fetch, [publicKey], NOW + 1)).toEqual(FREE);
    expect(route.asked).toHaveLength(1);
  });

  it('keeps a document that is still in life when the refresh fails', async () => {
    const { pair, publicKey } = await keys();
    const good = stubRoute(await sign(document({ expiresAt: NOW + 900 }), pair));
    const down = stubRoute(null, 503);

    expect((await currentDisplay(stubCloud(), good.fetch, [publicKey], NOW)).plan).toBe('solo');

    // Half life, and the server is down for this one call. The document has 450 seconds left, so
    // the menus must stay as they are: this is the flicker the half life refresh exists to avoid.
    const blip = await currentDisplay(stubCloud(), down.fetch, [publicKey], NOW + 450);
    expect(blip.plan).toBe('solo');
    expect(blip.features).toContain('cloud-board');
    expect(text(links(accountHref(blip, BASE)))).toContain('Account');

    // A minute, not half of what is left on the kept document: the failure is what sets the wait.
    expect((await currentDisplay(stubCloud(), down.fetch, [publicKey], NOW + 509)).plan).toBe('solo');
    expect(down.asked).toHaveLength(1);
    await currentDisplay(stubCloud(), down.fetch, [publicKey], NOW + 510);
    expect(down.asked).toHaveLength(2);

    // Kept, not made immortal. Once its own life is over the menus go back to Free.
    expect(await currentDisplay(stubCloud(), down.fetch, [publicKey], NOW + 901)).toEqual(FREE);
  });

  it('replaces the held document when the server signs a Free one', async () => {
    const { pair, publicKey } = await keys();
    const solo = stubRoute(await sign(document({ expiresAt: NOW + 900 }), pair));
    const free = stubRoute(await sign(document({ plan: 'free', features: [], seats: 0, expiresAt: NOW + 900 }), pair));

    expect((await currentDisplay(stubCloud(), solo.fetch, [publicKey], NOW)).plan).toBe('solo');

    // An account that really moved to Free is an answer, not a failure, so it wins over what is
    // held although the old document is still in life.
    const drawn = await currentDisplay(stubCloud(), free.fetch, [publicKey], NOW + 450);
    expect(drawn.plan).toBe('free');
    expect(text(links(accountHref(drawn, BASE)))).not.toContain('Account');
  });

  it('waits a minute before asking again when the answer was Free', async () => {
    const route = stubRoute(null, 503);

    await currentDisplay(stubCloud(), route.fetch, [], NOW);
    await currentDisplay(stubCloud(), route.fetch, [], NOW + RETRY_AFTER_SECONDS - 1);
    expect(route.asked).toHaveLength(1);

    await currentDisplay(stubCloud(), route.fetch, [], NOW + RETRY_AFTER_SECONDS);
    expect(route.asked).toHaveLength(2);
  });
});

// A page load waits on the whole round, and two of its three waits have no ceiling of their own: a
// locked keychain shows a dialog nobody is looking at, and a host that accepts the connection and
// never replies holds the token call for minutes. Both are answered here with a promise that never
// settles, which is what either one looks like to this code.
describe('what a page load is willing to wait for', () => {
  const stuck = <T>(): Promise<T> => new Promise<T>(() => {});

  it('draws Free rather than wait on a keychain that never answers', async () => {
    const cloud: Cloud = { ...stubCloud(), keychain: { read: () => stuck<string | null>(), write: async () => {}, remove: async () => {} } };
    const route = stubRoute(null);

    expect(await currentDisplay(cloud, route.fetch, [], NOW, 20)).toEqual(FREE);
    expect(route.asked).toEqual([]);
  });

  it('draws Free rather than wait on a token call that never answers', async () => {
    const cloud: Cloud = { ...stubCloud(), fetch: () => stuck<HttpAnswer>() };
    const route = stubRoute(null);

    expect(await currentDisplay(cloud, route.fetch, [], NOW, 20)).toEqual(FREE);
    expect(route.asked).toEqual([]);
  });

});

describe('fetchDisplay', () => {
  it('answers null for a body that is not a document at all', async () => {
    const route = stubRoute(null, 200);

    expect(await fetchDisplay(BASE, ACCESS_TOKEN, route.fetch)).toBeNull();
  });

  it('never doubles the slash when the base ends in one', async () => {
    const route = stubRoute(null, 500);

    await fetchDisplay(`${BASE}/`, ACCESS_TOKEN, route.fetch);

    expect(route.asked[0]?.url).toBe(`${BASE}/api/display`);
  });
});

describe('what the layout asks', () => {
  it('links the account only for a document that names the cloud board', () => {
    expect(accountHref(document(), BASE)).toBe(`${BASE}/account`);
    expect(accountHref(document({ features: ['evidence-history'] }), BASE)).toBeNull();
    expect(accountHref(FREE, BASE)).toBeNull();
  });

  // The lines that hand Settings, Cloud the link. Nothing renders that section with a paid
  // document in a test, so a merge that dropped them would pass the gate and take the link away.
  it('gives Settings, Cloud the account link', () => {
    const source = readFileSync(new URL('../routes/settings/[section]/+page.svelte', import.meta.url), 'utf8');
    const section = /<section id="cloud"[\s\S]*?<\/section>/.exec(source)?.[0] ?? '';

    expect(section).toContain('<CloudLinks {account} {team} />');
    expect(source).toContain('const account = $derived(accountHref(data.display, data.cloud));');
  });
});
