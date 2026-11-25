import { describe, expect, it } from 'vitest';
import {
  base64urlDecode,
  base64urlEncode,
  displayPayload,
  readDisplay,
  type DisplayEntitlement,
  type SignedDisplay,
} from './display.ts';

const NOW = 1_800_000_000;

// The DOM declares `CryptoKey` and `CryptoKeyPair`, and this package is typed without a DOM on
// purpose, so the keys are carried opaquely the way the module itself carries them.
type KeyPair = { privateKey: unknown; publicKey: unknown };
const subtle = crypto.subtle as unknown as {
  generateKey: (...a: unknown[]) => Promise<unknown>;
  exportKey: (...a: unknown[]) => Promise<ArrayBuffer>;
  sign: (...a: unknown[]) => Promise<ArrayBuffer>;
};

const document = (over: Partial<DisplayEntitlement> = {}): DisplayEntitlement => ({
  id: 'u1',
  plan: 'solo',
  features: ['cloud-board', 'evidence-history'],
  seats: 1,
  expiresAt: NOW + 3600,
  ...over,
});

async function keys() {
  const pair = (await subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as KeyPair;
  const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return { pair, publicKey: base64urlEncode(raw) };
}

async function sign(doc: DisplayEntitlement, pair: KeyPair): Promise<SignedDisplay> {
  const payload = displayPayload(doc);
  const signature = new Uint8Array(
    await subtle.sign({ name: 'Ed25519' }, pair.privateKey, payload),
  );
  return { document: doc, signature: base64urlEncode(signature) };
}

describe('base64url', () => {
  it('survives a round trip, padding and all', async () => {
    for (const length of [0, 1, 2, 3, 31, 32, 64]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37) % 256);
      expect([...base64urlDecode(base64urlEncode(bytes))]).toEqual([...bytes]);
    }
  });

  it('uses no character that has to be escaped in a URL', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);

    expect(base64urlEncode(bytes)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('the bytes that are signed', () => {
  it('does not change when the fields are built in another order', () => {
    const a = displayPayload({ id: 'u1', plan: 'solo', features: ['b', 'a'], seats: 1, expiresAt: 5 });
    const b = displayPayload({ expiresAt: 5, seats: 1, features: ['a', 'b'], plan: 'solo', id: 'u1' });

    // Two documents that say the same thing have to sign the same, or a verifier starts
    // refusing what it should accept.
    expect([...a]).toEqual([...b]);
  });

  it('changes when anything in the document changes', () => {
    const base = displayPayload(document());

    for (const changed of [
      document({ id: 'u2' }),
      document({ plan: 'team' }),
      document({ features: ['cloud-board'] }),
      document({ seats: 2 }),
      document({ expiresAt: NOW + 7200 }),
    ]) {
      expect([...displayPayload(changed)]).not.toEqual([...base]);
    }
  });
});

describe('reading a signed document', () => {
  it('reads one the server really signed', async () => {
    const { pair, publicKey } = await keys();

    const read = await readDisplay(await sign(document(), pair), publicKey, { now: NOW });

    expect(read).toEqual(document());
  });

  it('refuses one signed by another key', async () => {
    const mine = await keys();
    const theirs = await keys();

    const read = await readDisplay(await sign(document(), theirs.pair), mine.publicKey, { now: NOW });

    expect(read).toBeNull();
  });

  it('refuses a document that was changed after it was signed', async () => {
    const { pair, publicKey } = await keys();
    const signed = await sign(document({ plan: 'solo' }), pair);

    // The whole point: a client that believed this would show Team menus to a Solo account,
    // and a client that stopped checking would show them to anybody.
    const tampered = {
      ...signed,
      document: { ...signed.document, plan: 'team' as const, features: ['team-costs'] },
    };

    expect(await readDisplay(tampered, publicKey, { now: NOW })).toBeNull();
  });

  it('refuses a signature from another genuine document', async () => {
    const { pair, publicKey } = await keys();
    const real = await sign(document(), pair);
    const other = await sign(document({ plan: 'team', features: ['team-costs'] }), pair);

    // Both halves are genuine, from the same key. Only the pairing is a lie.
    expect(
      await readDisplay({ document: real.document, signature: other.signature }, publicKey, {
        now: NOW,
      }),
    ).toBeNull();
  });

  it('hands back only what was signed', async () => {
    const { pair, publicKey } = await keys();
    const signed = await sign(document(), pair);

    // Anything hung on the object beside the five signed fields is not covered by the
    // signature. Returning it would hand the reader attacker input under a valid signature.
    const smuggled = {
      ...signed,
      document: { ...signed.document, isAdmin: true, badge: 'Team' },
    } as unknown as SignedDisplay;

    expect(await readDisplay(smuggled, publicKey, { now: NOW })).toEqual(document());
  });

  it('refuses a document about somebody else', async () => {
    const { pair, publicKey } = await keys();
    const signed = await sign(document({ id: 'u2' }), pair);

    // A stale cache or a swapped browser profile looks exactly like this, and the signature
    // on it is real.
    expect(await readDisplay(signed, publicKey, { now: NOW, expectedId: 'u1' })).toBeNull();
    expect(await readDisplay(signed, publicKey, { now: NOW, expectedId: 'u2' })).not.toBeNull();
  });

  it('refuses a seat count that is not a real number', async () => {
    const { pair, publicKey } = await keys();

    // Signed properly, so only the shape check can refuse it. JSON.stringify writes Infinity
    // as null, so this signs the same bytes as a document with no seat count at all.
    const signed = await sign(document({ seats: Infinity }), pair);

    expect(await readDisplay(signed, publicKey, { now: NOW })).toBeNull();
  });

  it('refuses an expiry that is not a real number', async () => {
    const { pair, publicKey } = await keys();

    // JSON.stringify writes NaN as null, so this signs the same bytes as a null expiry, and
    // then never expires, because every comparison with NaN is false.
    const signed = await sign(document({ expiresAt: NaN }), pair);

    expect(await readDisplay(signed, publicKey, { now: NOW })).toBeNull();
  });

  it('signs for this protocol and no other', async () => {
    // The same key signs the paid package. Without a name in the signed bytes, a signature
    // from one path could be a valid message on the other.
    const bytes = new TextDecoder().decode(displayPayload(document()));

    expect(bytes.startsWith('nolzu-display-v1\n')).toBe(true);
  });

  it('refuses one that has run out', async () => {
    const { pair, publicKey } = await keys();
    const signed = await sign(document({ expiresAt: NOW }), pair);

    // The boundary itself is out: a person who stopped paying keeps the menus no longer than
    // the document says.
    expect(await readDisplay(signed, publicKey, { now: NOW })).toBeNull();
    expect(await readDisplay(signed, publicKey, { now: NOW - 1 })).not.toBeNull();
  });

  it('refuses rubbish instead of throwing', async () => {
    const { publicKey } = await keys();

    for (const rubbish of [
      null,
      {},
      { document: document(), signature: 'nope' },
      { document: { ...document(), plan: 'enterprise' }, signature: 'a' },
      { document: { ...document(), features: [1, 2] }, signature: 'a' },
      { document: document(), signature: 1 },
      { document: { ...document(), seats: Infinity }, signature: 'a' },
    ]) {
      expect(await readDisplay(rubbish as unknown as SignedDisplay, publicKey, { now: NOW })).toBeNull();
    }
  });

  it('refuses when the public key is not a key', async () => {
    const { pair } = await keys();

    expect(await readDisplay(await sign(document(), pair), 'not-a-key', { now: NOW })).toBeNull();
  });
});
