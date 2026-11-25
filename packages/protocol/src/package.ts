// The paid package manifest.
//
// The server signs a short statement about one downloaded file, and the client checks it before
// anything reaches the disk. What is signed is the manifest, not the bundle bytes, so the client
// has something to compare the bytes against while they are still in memory. A manifest that
// does not verify is a refusal to install, never a silent downgrade.
//
// It lives here for the same reason `display.ts` does: both sides have to agree on the bytes,
// and two implementations of a signature check are one too many.

import { DISPLAY_SIGNATURE_ALGORITHM, base64urlDecode, base64urlEncode } from './display.ts';

export interface PackageManifest {
  // The feature the package ships, and the release of it.
  id: string;
  version: string;
  // The file name the client writes and reads back. Signed, so a manifest cannot name one file
  // while the pointer on disk names another.
  entry: string;
  // The digest of the gzipped bundle, base64url, from `sha256Base64url`.
  sha256: string;
  // The length of the gzipped bundle in bytes.
  size: number;
}

export interface SignedPackage {
  manifest: PackageManifest;
  // The signature over the canonical bytes of the manifest, base64url.
  signature: string;
}

/**
 * Whether a name may be the installed file.
 *
 * The installer joins it onto a path and writes the pointer file `current` beside it, so a name
 * with a slash, a leading dot or the pointer's own name is refused. The check is here because both
 * sides need it: the signature covers the name, and the client checks the pointer it reads back.
 */
export function isPackageEntry(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.startsWith('.') && name !== 'current';
}

// The same key signs the display document, so the prefix is the only thing that keeps one
// protocol's signature from being a valid message on the other. The version is inside it,
// because a version in the JSON is attacker chosen inside a signature over an older shape and a
// version in the prefix is not.
export const PACKAGE_DOMAIN = 'nolzu-package-v1\n';

// `CryptoKey` is declared by the DOM and again by Node, and the two do not match, so this
// package cannot name it. See the same note in `display.ts`.
type OpaqueKey = { readonly type: string };

type Subtle = {
  importKey(
    format: 'raw',
    key: Uint8Array,
    algorithm: { name: string },
    extractable: boolean,
    usages: string[],
  ): Promise<OpaqueKey>;
  verify(
    algorithm: { name: string },
    key: OpaqueKey,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
};

const subtle = () => (globalThis.crypto as unknown as { subtle: Subtle }).subtle;

// The five fields that are signed, and nothing else. Anything a caller hangs on the object
// beside them is not covered by the signature, so it never comes back out of `readPackage`.
function onlySignedFields(manifest: PackageManifest): PackageManifest {
  return {
    id: manifest.id,
    version: manifest.version,
    entry: manifest.entry,
    sha256: manifest.sha256,
    size: manifest.size,
  };
}

// The bytes both sides sign and check. Key order is fixed here, so the same manifest always
// makes the same bytes whatever order the fields were built in.
export function packagePayload(manifest: PackageManifest): Uint8Array {
  return new TextEncoder().encode(PACKAGE_DOMAIN + JSON.stringify(onlySignedFields(manifest)));
}

// The digest the manifest carries, over the gzipped bundle. base64url, so the manifest is plain
// JSON and the digest reads the same as every other key and signature here.
export async function sha256Base64url(bytes: Uint8Array): Promise<string> {
  return base64urlEncode(new Uint8Array(await subtle().digest('SHA-256', bytes)));
}

/**
 * Read a signed manifest, or null.
 *
 * Null for anything wrong: a bad signature, a signature from another protocol, a shape this
 * version does not understand. The caller writes nothing and logs once itself, because a
 * package that does not verify has to stop the install.
 */
export async function readPackage(
  signed: SignedPackage,
  // The raw Ed25519 public key, base64url. 32 bytes, committed to the repository.
  publicKeyBase64url: string,
): Promise<PackageManifest | null> {
  if (!looksLikePackage(signed)) return null;

  let ok: boolean;
  try {
    const key = await subtle().importKey(
      'raw',
      base64urlDecode(publicKeyBase64url),
      { name: DISPLAY_SIGNATURE_ALGORITHM },
      false,
      ['verify'],
    );
    ok = await subtle().verify(
      { name: DISPLAY_SIGNATURE_ALGORITHM },
      key,
      base64urlDecode(signed.signature),
      packagePayload(signed.manifest),
    );
  } catch {
    // A key or a signature that is not even the right length throws rather than answering
    // false, and so does a runtime with no Ed25519.
    return null;
  }
  if (!ok) return null;

  // Only what was signed. An extra field on the way in is not covered by the signature, so it
  // must not come out as if it were.
  return onlySignedFields(signed.manifest);
}

function looksLikePackage(signed: unknown): signed is SignedPackage {
  if (typeof signed !== 'object' || signed === null) return false;
  const { manifest, signature } = signed as Record<string, unknown>;
  if (typeof signature !== 'string') return false;
  if (typeof manifest !== 'object' || manifest === null) return false;
  const m = manifest as Record<string, unknown>;
  return (
    typeof m.id === 'string' &&
    typeof m.version === 'string' &&
    typeof m.entry === 'string' &&
    isPackageEntry(m.entry) &&
    typeof m.sha256 === 'string' &&
    // Finite, not merely a number. JSON.stringify writes NaN and Infinity as null, so a size of
    // either signs the same bytes as a manifest with no size, and then every comparison with it
    // is false.
    typeof m.size === 'number' &&
    Number.isFinite(m.size)
  );
}
