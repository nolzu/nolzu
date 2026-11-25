import { base64urlEncode, displayPayload, type DisplayEntitlement, type SignedDisplay } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import {
  activeProject,
  displayFrom,
  DISPLAY_PUBLIC_KEYS,
  EXPORT_FEATURE,
  FREE,
  HISTORY_FEATURE,
  refreshAfterSeconds,
  shows,
} from './display.ts';

const NOW = 1_800_000_000;

type KeyPair = { privateKey: unknown; publicKey: unknown };
const subtle = crypto.subtle as unknown as {
  generateKey: (...a: unknown[]) => Promise<KeyPair>;
  exportKey: (...a: unknown[]) => Promise<ArrayBuffer>;
  sign: (...a: unknown[]) => Promise<ArrayBuffer>;
};

const document = (over: Partial<DisplayEntitlement> = {}): DisplayEntitlement => ({
  id: 'u1',
  plan: 'solo',
  features: ['cloud-board'],
  seats: 1,
  expiresAt: NOW + 900,
  ...over,
});

async function keys() {
  const pair = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  return { pair, publicKey: base64urlEncode(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))) };
}

async function sign(doc: DisplayEntitlement, pair: KeyPair): Promise<SignedDisplay> {
  const signature = new Uint8Array(
    await subtle.sign({ name: 'Ed25519' }, pair.privateKey, displayPayload(doc)),
  );
  return { document: doc, signature: base64urlEncode(signature) };
}

describe('what the menus may show', () => {
  it('shows what a signed document says', async () => {
    const { pair, publicKey } = await keys();

    const read = await displayFrom(await sign(document(), pair), 'u1', [publicKey], NOW);

    expect(read.plan).toBe('solo');
    expect(shows(read, 'cloud-board')).toBe(true);
    expect(shows(read, 'team-costs')).toBe(false);
  });

  it('shows Free when there is no document at all', async () => {
    expect(await displayFrom(null, 'u1')).toEqual(FREE);
  });

  it('shows Free for a document nobody here can check', async () => {
    const mine = await keys();
    const theirs = await keys();

    const read = await displayFrom(await sign(document(), theirs.pair), 'u1', [mine.publicKey], NOW);

    // Silently: Free is the whole local product, not an error, and there is nobody to tell.
    expect(read).toEqual(FREE);
  });

  it('shows Free for a document about somebody else', async () => {
    const { pair, publicKey } = await keys();

    // A stale file left by another account on the same machine looks exactly like this, and
    // its signature is real.
    const read = await displayFrom(await sign(document({ id: 'u2' }), pair), 'u1', [publicKey], NOW);

    expect(read).toEqual(FREE);
  });

  it('shows Free once the document has run out', async () => {
    const { pair, publicKey } = await keys();
    const signed = await sign(document({ expiresAt: NOW }), pair);

    expect(await displayFrom(signed, 'u1', [publicKey], NOW)).toEqual(FREE);
  });

  it('takes a document signed by an older key, so a rotation does not strand a build', async () => {
    const fresh = await keys();
    const old = await keys();

    const read = await displayFrom(
      await sign(document(), old.pair),
      'u1',
      [fresh.publicKey, old.publicKey],
      NOW,
    );

    expect(read.plan).toBe('solo');
  });

  it('spells the history feature the way the hub signs it', () => {
    // A typo here draws the day fields off for a Solo machine whose document says it paid, and
    // nothing else in this app reads the name, so nothing else would say so.
    expect(HISTORY_FEATURE).toBe('evidence-history');
    expect(shows(document({ features: [HISTORY_FEATURE] }), HISTORY_FEATURE)).toBe(true);
    expect(shows(document({ features: [] }), HISTORY_FEATURE)).toBe(false);
  });

  it('spells the export feature the way the cloud mints it', () => {
    // The word is set by the server and nothing in this app reads it
    // anywhere else, so a typo here draws the free words for a machine that paid for the exporters.
    expect(EXPORT_FEATURE).toBe('exporters');
    expect(shows(document({ features: [EXPORT_FEATURE] }), EXPORT_FEATURE)).toBe(true);
    expect(shows(document({ features: [] }), EXPORT_FEATURE)).toBe(false);
  });

  it('ships with a key that is a key', () => {
    // A typo here turns every build into a permanent Free client, and nothing would say so.
    for (const key of DISPLAY_PUBLIC_KEYS) {
      expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe('when to ask again', () => {
  it('asks at half the life left, not at the end', () => {
    // Waiting for the expiry would drop the menus mid-work and only then ask for more.
    expect(refreshAfterSeconds(document({ expiresAt: NOW + 900 }), NOW)).toBe(450);
    expect(refreshAfterSeconds(document({ expiresAt: NOW + 2 }), NOW)).toBe(1);
  });

  it('asks at once for a document that is already out', () => {
    expect(refreshAfterSeconds(document({ expiresAt: NOW }), NOW)).toBe(0);
    expect(refreshAfterSeconds(document({ expiresAt: NOW - 100 }), NOW)).toBe(0);
  });
});

// Every plan holds as many projects as the person makes, and the project opened
// last stays open until a route names another.
describe('which project a route works on', () => {
  it('takes the current project, and the first one while none is set or the registry lost it', () => {
    expect(activeProject([1, 2, 3], 2)).toBe(2);
    expect(activeProject([1, 2], null)).toBe(1);
    expect(activeProject([1, 2], 7)).toBe(1);
  });

  it('takes a project the route names, on Free too', () => {
    expect(activeProject([1, 2, 3], 2, 3)).toBe(3);
    expect(activeProject([1, 2, 3], null, 1)).toBe(1);
    expect(activeProject([1, 2], 2, 2)).toBe(2);
  });

  it('refuses a project the registry does not have', () => {
    expect(() => activeProject([1, 2], 1, 5)).toThrow('There is no project 5 on this machine.');
  });
});
