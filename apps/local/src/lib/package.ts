import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { resolveDataDir } from '@nolzu/core/node';
import { base64urlDecode, isPackageEntry, readPackage, sha256Base64url, type SignedPackage } from '@nolzu/protocol';
import { machineAccessToken, type Cloud } from '@nolzu/runner';

/**
 * The public keys this build trusts, newest first.
 *
 * A list rather than one key, for the reason `display.ts` gives: a rotated server key would
 * otherwise turn every client already installed into a permanent Free client.
 */
export const PACKAGE_PUBLIC_KEYS = ['mIU5eVpq8PZ-_7CJ7XZ6es4s452RxD2KknpJtplpsaw'] as const;

// The pointer. It holds the name of the installed file, and writing it is the step that makes a
// package live, so nothing half written is ever named here.
const CURRENT = 'current';

// What the route answers with: the signed manifest and the gzipped bundle, base64url.
export type PackageDownload = SignedPackage & { bytes: string };

// What this needs from fetch, so a test answers by hand and never opens a socket. Same shape as
// HubSocket in the runner, for the same reason.
export type PackageFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function packageDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDataDir(env), 'packages');
}

/**
 * Ask the server for the package this account may have, or null.
 *
 * Null for every refusal and every failure, because a client with no package is the free client
 * and that is not an error. The server's 402 is the real answer about the plan, so a client that
 * asks and is refused says nothing and carries on.
 */
export async function fetchPackage(base: string, accessToken: string, fetch: PackageFetch): Promise<PackageDownload | null> {
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/api/package`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as PackageDownload;
    return typeof body?.bytes === 'string' ? body : null;
  } catch {
    return null;
  }
}

/**
 * Check a download and install it, and answer the path of the installed file or null.
 *
 * Nothing reaches the disk until the signature and the digest both hold, so a package nobody
 * here can check leaves no trace. The file lands under a name with this process's id and is
 * renamed into place, and the pointer is renamed last, so a client that is killed mid install
 * still runs what it ran before. Every refusal is a null and never a throw: a package must not
 * be able to stop the client from starting.
 */
export async function installPackage(
  dir: string,
  got: PackageDownload,
  keys: readonly string[] = PACKAGE_PUBLIC_KEYS,
): Promise<string | null> {
  const manifest = await readAny(got, keys);
  if (manifest === null) return null;

  const entry = join(dir, manifest.entry);
  const partial = `${entry}.${process.pid}.tmp`;
  const pointer = join(dir, CURRENT);
  const pointerPartial = `${pointer}.${process.pid}.tmp`;
  try {
    // Inside the try because a body that is not base64url at all throws here, and a refusal has
    // to be a null like every other one.
    const bytes = base64urlDecode(got.bytes);
    if (bytes.length !== manifest.size) return null;
    if ((await sha256Base64url(bytes)) !== manifest.sha256) return null;

    mkdirSync(dir, { recursive: true });
    writeFileSync(partial, gunzipSync(bytes));
    // Same directory, so the same filesystem, so a rename is the one step that cannot half
    // happen. The pid is in the name because two clients can install at once.
    renameSync(partial, entry);
    writeFileSync(pointerPartial, manifest.entry);
    renameSync(pointerPartial, pointer);
  } catch {
    rmSync(partial, { force: true });
    rmSync(pointerPartial, { force: true });
    return null;
  }
  // Limit: old versions are left on disk, prune when there is a second one
  sweep(dir);
  return entry;
}

// The installed file, or null when the pointer or the file it names is missing. A .tmp a killed
// process left is never named here, so it is never read. The name is checked with the same rule the
// signature covers, so a pointer somebody edited by hand cannot name a file outside this folder.
export function installedEntry(dir: string): string | null {
  try {
    const name = readFileSync(join(dir, CURRENT), 'utf8').trim();
    if (!isPackageEntry(name)) return null;
    const entry = join(dir, name);
    return existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Fetch and install the package this machine's account may have, and answer the installed path or
 * null.
 *
 * This is the whole download path in one call, for the bin to run after a login. Null covers every
 * refusal: no account, a server that says Free, a body that does not verify. None of them is an
 * error, because a client with no package is the free client.
 *
 * Limit: the plan is read at install time only, so a package installed under Solo stays until
 * logout. A later login on a lapsed plan gets a refusal and removes nothing. Ask the server on a
 * timer when a lapsed plan has to lose its panels without the person signing out.
 */
export async function syncPackage(
  dir: string,
  cloud: Cloud,
  fetch: PackageFetch = httpGet,
  keys: readonly string[] = PACKAGE_PUBLIC_KEYS,
): Promise<string | null> {
  try {
    const token = await machineAccessToken(cloud);
    if (token === null) return null;
    const got = await fetchPackage(cloud.baseUrl, token, fetch);
    return got === null ? null : await installPackage(dir, got, keys);
  } catch {
    return null;
  }
}

// Everything installed, gone. Signing out takes the paid package with it, so a machine that is not
// signed in draws no paid panel and the entry route answers the empty module again.
export function removePackages(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A folder that cannot be removed is a machine problem, and there is nothing to tell the
    // person that `nolzu logout` failed at: the account is signed out either way.
  }
}

const httpGet: PackageFetch = (url, init) => fetch(url, init);

// The first key that reads the manifest. A signature from another protocol fails here too,
// because the package domain is not the display domain.
async function readAny(got: PackageDownload, keys: readonly string[]) {
  for (const key of keys) {
    const manifest = await readPackage(got, key);
    if (manifest !== null) return manifest;
  }
  return null;
}

// Limit: a sweep can take another install's .tmp while it is being written, which costs that
// install its rename and nothing else
function sweep(dir: string): void {
  try {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.tmp')) rmSync(join(dir, name), { force: true });
    }
  } catch {
    // The package is installed by now. A leftover .tmp costs disk and is never read.
  }
}
