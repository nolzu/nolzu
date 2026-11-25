import { describe, expect, it } from 'vitest';
import { DISPLAY_DOMAIN, base64urlEncode, displayPayload, type DisplayEntitlement } from './display.ts';
import {
  PACKAGE_DOMAIN,
  packagePayload,
  readPackage,
  sha256Base64url,
  type PackageManifest,
  type SignedPackage,
} from './package.ts';

// The DOM declares `CryptoKey` and `CryptoKeyPair`, and this package is typed without a DOM on
// purpose, so the keys are carried opaquely the way the module itself carries them.
type KeyPair = { privateKey: unknown; publicKey: unknown };
const subtle = crypto.subtle as unknown as {
  generateKey: (...a: unknown[]) => Promise<unknown>;
  exportKey: (...a: unknown[]) => Promise<ArrayBuffer>;
  sign: (...a: unknown[]) => Promise<ArrayBuffer>;
};

const manifest = (over: Partial<PackageManifest> = {}): PackageManifest => ({
  id: 'pro',
  version: '1.0.0',
  entry: 'pro-1.0.0.js',
  sha256: '3SK7zF9Tcgt3c-xh2SnV6qxN6K592piHRTbikghuNvU',
  size: 2048,
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

async function signBytes(payload: Uint8Array, pair: KeyPair): Promise<string> {
  return base64urlEncode(new Uint8Array(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, payload)));
}

async function sign(m: PackageManifest, pair: KeyPair): Promise<SignedPackage> {
  return { manifest: m, signature: await signBytes(packagePayload(m), pair) };
}

describe('the bytes that are signed', () => {
  it('does not change when the fields are built in another order', () => {
    const a = packagePayload({ id: 'pro', version: '1', entry: 'e.js', sha256: 's', size: 1 });
    const b = packagePayload({ size: 1, sha256: 's', entry: 'e.js', version: '1', id: 'pro' });

    expect([...a]).toEqual([...b]);
  });

  it('changes when anything in the manifest changes', () => {
    const base = packagePayload(manifest());

    for (const changed of [
      manifest({ id: 'other' }),
      manifest({ version: '1.0.1' }),
      manifest({ entry: 'other.js' }),
      manifest({ sha256: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU' }),
      manifest({ size: 2049 }),
    ]) {
      expect([...packagePayload(changed)]).not.toEqual([...base]);
    }
  });

  it('names this protocol and no other', () => {
    const bytes = new TextDecoder().decode(packagePayload(manifest()));

    expect(bytes.startsWith('nolzu-package-v1\n')).toBe(true);
  });
});

describe('the digest of the bundle', () => {
  it('matches the digest of the same bytes anywhere else', async () => {
    expect(await sha256Base64url(new Uint8Array())).toBe(
      '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
    );
    expect(await sha256Base64url(new TextEncoder().encode('nolzu'))).toBe(
      '3SK7zF9Tcgt3c-xh2SnV6qxN6K592piHRTbikghuNvU',
    );
  });

  it('changes when one byte of the bundle changes', async () => {
    const bytes = new Uint8Array(64).map((_, i) => i);
    const flipped = bytes.map((byte, i) => (i === 17 ? byte ^ 1 : byte));

    expect(await sha256Base64url(flipped)).not.toBe(await sha256Base64url(bytes));
  });
});

describe('reading a signed manifest', () => {
  it('reads one the server really signed', async () => {
    const { pair, publicKey } = await keys();

    expect(await readPackage(await sign(manifest(), pair), publicKey)).toEqual(manifest());
  });

  it('refuses a manifest whose digest was changed after it was signed', async () => {
    const { pair, publicKey } = await keys();
    const signed = await sign(manifest(), pair);

    // The whole point: the digest is what the client compares the downloaded bytes against,
    // so a manifest that names another digest installs another bundle.
    const tampered = {
      ...signed,
      manifest: { ...signed.manifest, sha256: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU' },
    };

    expect(await readPackage(tampered, publicKey)).toBeNull();
  });

  it('refuses a manifest whose version was changed after it was signed', async () => {
    const { pair, publicKey } = await keys();
    const signed = await sign(manifest(), pair);

    expect(
      await readPackage({ ...signed, manifest: { ...signed.manifest, version: '9.9.9' } }, publicKey),
    ).toBeNull();
  });

  it('refuses one signed by the display key', async () => {
    const display = await keys();
    const mine = await keys();

    // Both keys are real signing keys. A key that signs display documents must not be able to
    // ship code.
    expect(await readPackage(await sign(manifest(), display.pair), mine.publicKey)).toBeNull();
  });

  it('refuses a signature made under the display domain', async () => {
    const { pair, publicKey } = await keys();
    const m = manifest();

    // The same key signs both protocols, so the only thing that keeps them apart is the prefix
    // in the signed bytes. Without it this signature would install a package.
    const crossed = new TextEncoder().encode(
      DISPLAY_DOMAIN + new TextDecoder().decode(packagePayload(m)).slice(PACKAGE_DOMAIN.length),
    );

    expect(await readPackage({ manifest: m, signature: await signBytes(crossed, pair) }, publicKey)).toBeNull();
  });

  it('refuses a display document', async () => {
    const { pair, publicKey } = await keys();
    const document: DisplayEntitlement = {
      id: 'u1',
      plan: 'solo',
      features: ['projects'],
      seats: 1,
      expiresAt: 1_800_003_600,
    };

    // A genuine display document, signed by the same key, with the manifest fields hung on it so
    // that it gets past the shape check and only the signature can refuse it. `displayPayload`
    // drops those extras, so the signed bytes carry the display prefix. It is the replay the
    // package prefix exists for.
    const signature = await signBytes(displayPayload(document), pair);
    const replayed = { ...manifest(), ...document };

    expect(await readPackage({ manifest: replayed, signature } as unknown as SignedPackage, publicKey)).toBeNull();
  });

  it('refuses a signature made with no domain at all', async () => {
    const { pair, publicKey } = await keys();

    // The canonical JSON on its own, with nothing in front of it. Written out here rather than
    // sliced off `packagePayload`, so the case still fails if the prefix is dropped from the
    // module.
    const bare = new TextEncoder().encode(
      JSON.stringify({
        id: 'pro',
        version: '1.0.0',
        entry: 'pro-1.0.0.js',
        sha256: '3SK7zF9Tcgt3c-xh2SnV6qxN6K592piHRTbikghuNvU',
        size: 2048,
      }),
    );

    expect(
      await readPackage({ manifest: manifest(), signature: await signBytes(bare, pair) }, publicKey),
    ).toBeNull();
  });

  it('refuses an entry that is not a plain file name', async () => {
    const { pair, publicKey } = await keys();

    // The installer joins `entry` onto the packages directory and writes `current` there as the
    // pointer, so a signed manifest must not be able to name either.
    for (const entry of ['../../../current', 'sub/pro.js', 'current', '.hidden', '']) {
      expect(await readPackage(await sign(manifest({ entry }), pair), publicKey)).toBeNull();
    }
  });

  it('hands back only what was signed', async () => {
    const { pair, publicKey } = await keys();
    const signed = await sign(manifest(), pair);

    // Anything hung on the object beside the five signed fields is not covered by the
    // signature. Returning it would hand the installer attacker input under a valid signature.
    const smuggled = {
      ...signed,
      manifest: { ...signed.manifest, entry: 'pro-1.0.0.js', url: 'http://elsewhere/pro.js' },
    } as unknown as SignedPackage;

    expect(await readPackage(smuggled, publicKey)).toEqual(manifest());
  });

  it('refuses a size that is not a real number', async () => {
    const { pair, publicKey } = await keys();

    // Signed properly, so only the shape check can refuse it. JSON.stringify writes Infinity
    // as null, so this signs the same bytes as a manifest with no size at all.
    expect(await readPackage(await sign(manifest({ size: Infinity }), pair), publicKey)).toBeNull();
  });

  it('refuses a field of the wrong type even under a real signature', async () => {
    const { pair, publicKey } = await keys();

    // The installer passes `entry` to the filesystem and `sha256` to a comparison, so a number
    // or a null there has to die at the shape check and not two calls later.
    for (const field of ['id', 'version', 'entry', 'sha256'] as const) {
      const broken = { ...manifest(), [field]: 1 } as unknown as PackageManifest;

      expect(await readPackage(await sign(broken, pair), publicKey)).toBeNull();
    }
  });

  it('refuses rubbish instead of throwing', async () => {
    const { publicKey } = await keys();

    for (const rubbish of [
      null,
      {},
      { manifest: manifest(), signature: 'nope' },
      { manifest: manifest(), signature: 1 },
      { manifest: { ...manifest(), size: '2048' }, signature: 'a' },
      { manifest: { ...manifest(), entry: null }, signature: 'a' },
      { manifest: { ...manifest(), size: NaN }, signature: 'a' },
    ]) {
      expect(await readPackage(rubbish as unknown as SignedPackage, publicKey)).toBeNull();
    }
  });

  it('refuses when the public key is not a key', async () => {
    const { pair } = await keys();

    expect(await readPackage(await sign(manifest(), pair), 'not-a-key')).toBeNull();
  });
});
