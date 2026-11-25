// The display entitlements document.
//
// The server signs a short statement of what a person has paid for, and the client shows the
// right menus from it. It is display only: every paid capability is checked again on the server
// on every request, so a forged document opens nothing. It is here rather than in either app
// because both sides have to agree on the bytes, and two implementations of a signature check
// are one implementation too many.

export interface DisplayEntitlement {
  // The account the statement is about.
  id: string;
  plan: 'free' | 'solo' | 'team';
  // What the menus may show. Names come from the server; the client treats them as opaque.
  features: string[];
  seats: number;
  // Seconds since the epoch. Short, because a person who stops paying should not keep the menus
  // until their laptop restarts.
  expiresAt: number;
}

export interface SignedDisplay {
  document: DisplayEntitlement;
  // The signature over the canonical bytes of the document, base64url.
  signature: string;
}

export const DISPLAY_SIGNATURE_ALGORITHM = 'Ed25519' as const;

// Signed along with the document, so a signature made here is a signature for this and nothing
// else. The same key signs the paid package, and without this prefix a blob from one path could
// be a valid message on the other. The version is part of it, so a later shape cannot be
// mistaken for this one.
export const DISPLAY_DOMAIN = 'nolzu-display-v1\n';

// No key type appears in any signature here. `CryptoKey` is declared by the DOM and again by
// Node, and the two do not match, so a package imported by both a browser app and the server
// cannot name it. The key arrives as bytes and is imported inside.
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
};

const subtle = () => (globalThis.crypto as unknown as { subtle: Subtle }).subtle;

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

// The five fields that are signed, and nothing else. Anything a caller hangs on the object
// beside them is not covered by the signature, so it never comes back out of `readDisplay`.
function onlySignedFields(document: DisplayEntitlement): DisplayEntitlement {
  return {
    id: document.id,
    plan: document.plan,
    features: [...document.features].sort(),
    seats: document.seats,
    expiresAt: document.expiresAt,
  };
}

// The bytes both sides sign and check. Key order is fixed here, so the same document always
// makes the same bytes whatever order the fields were built in.
export function displayPayload(document: DisplayEntitlement): Uint8Array {
  return new TextEncoder().encode(DISPLAY_DOMAIN + JSON.stringify(onlySignedFields(document)));
}

export interface ReadDisplayOptions {
  // Seconds since the epoch.
  now?: number;
  // The account the reader expects. A document for somebody else is refused, which is what a
  // stale cache or a swapped profile looks like.
  expectedId?: string;
}

/**
 * Read a signed document, or null.
 *
 * Null for anything wrong: a bad signature, an expiry that has passed, a shape this version
 * does not understand, a document about somebody else. The caller shows Free, which is what
 * everybody without an account sees and is never an error.
 */
export async function readDisplay(
  signed: SignedDisplay,
  // The raw Ed25519 public key, base64url. 32 bytes, committed to the repository.
  publicKeyBase64url: string,
  options: ReadDisplayOptions = {},
): Promise<DisplayEntitlement | null> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!looksLikeDisplay(signed)) return null;

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
      displayPayload(signed.document),
    );
  } catch (cause) {
    // A key or a signature that is not even the right length throws rather than answering
    // false, and so does a runtime with no Ed25519. Worth a line: refusing every document for
    // ever looks exactly like being on Free, so nobody would otherwise notice.
    console.warn('Could not check the display document:', cause);
    return null;
  }
  if (!ok) return null;

  if (signed.document.expiresAt <= now) return null;
  if (options.expectedId !== undefined && signed.document.id !== options.expectedId) return null;

  // Only what was signed. An extra field on the way in is not covered by the signature, so it
  // must not come out as if it were.
  return onlySignedFields(signed.document);
}

function looksLikeDisplay(signed: unknown): signed is SignedDisplay {
  if (typeof signed !== 'object' || signed === null) return false;
  const { document, signature } = signed as Record<string, unknown>;
  if (typeof signature !== 'string') return false;
  if (typeof document !== 'object' || document === null) return false;
  const d = document as Record<string, unknown>;
  return (
    typeof d.id === 'string' &&
    (d.plan === 'free' || d.plan === 'solo' || d.plan === 'team') &&
    Array.isArray(d.features) &&
    d.features.every((f) => typeof f === 'string') &&
    // Finite, not merely a number. JSON.stringify writes NaN as null, so a NaN expiry signs the
    // same bytes as a null one and then never expires, because every comparison with NaN is
    // false.
    typeof d.seats === 'number' &&
    Number.isFinite(d.seats) &&
    typeof d.expiresAt === 'number' &&
    Number.isFinite(d.expiresAt)
  );
}
