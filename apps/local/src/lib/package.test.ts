import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { base64urlEncode, packagePayload, sha256Base64url, type PackageManifest } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import type { Cloud } from '@nolzu/runner';
import { fetchPackage, installedEntry, installPackage, packageDir, PACKAGE_PUBLIC_KEYS, removePackages, syncPackage, type PackageDownload } from './package.ts';

const BUNDLE = 'export const id = "pro";\n';

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

async function sign(manifest: PackageManifest, pair: KeyPair): Promise<string> {
  return base64urlEncode(new Uint8Array(await subtle.sign({ name: 'Ed25519' }, pair.privateKey, packagePayload(manifest))));
}

// What the route answers with: the manifest, the signature over it, and the gzipped bundle.
async function download(
  pair: KeyPair,
  options: { bundle?: string; bytes?: Uint8Array; manifest?: Partial<PackageManifest> } = {},
): Promise<PackageDownload> {
  const gzipped = gzipSync(Buffer.from(options.bundle ?? BUNDLE));
  const manifest: PackageManifest = {
    id: 'pro',
    version: '1.0.0',
    entry: 'pro-1.0.0.js',
    sha256: await sha256Base64url(gzipped),
    size: gzipped.length,
    ...options.manifest,
  };
  const sent = options.bytes ?? gzipped;
  return { manifest, signature: await sign(manifest, pair), bytes: base64urlEncode(sent) };
}

const dir = () => mkdtempSync(join(tmpdir(), 'nolzu-package-'));

describe('installing a package', () => {
  it('writes the file the manifest names and points current at it', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();

    const entry = await installPackage(into, await download(pair), [publicKey]);

    expect(entry).toBe(join(into, 'pro-1.0.0.js'));
    expect(readFileSync(entry!, 'utf8')).toBe(BUNDLE);
    expect(readFileSync(join(into, 'current'), 'utf8')).toBe('pro-1.0.0.js');
    expect(installedEntry(into)).toBe(entry);
  });

  it('refuses a manifest signed by a key this build does not carry, and writes nothing', async () => {
    const into = dir();
    const mine = await keys();
    const theirs = await keys();

    expect(await installPackage(into, await download(theirs.pair), [mine.publicKey])).toBeNull();

    // Nothing at all: the verification runs before the directory is even made.
    expect(existsSync(into)).toBe(true);
    expect(readdirSync(into)).toEqual([]);
    expect(installedEntry(into)).toBeNull();
  });

  it('takes a package signed by an older key, so a rotation does not strand a build', async () => {
    const into = dir();
    const fresh = await keys();
    const old = await keys();

    const entry = await installPackage(into, await download(old.pair), [fresh.publicKey, old.publicKey]);

    expect(entry).not.toBeNull();
  });

  it('refuses bytes the signed digest does not cover, and writes nothing', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    const tampered = gzipSync(Buffer.from('export const id = "theirs";\n'));
    // The signature is real. Only the bundle was swapped on the way, which is the whole reason
    // the manifest carries a digest.
    const got = await download(pair, { bytes: tampered, manifest: { size: tampered.length } });

    expect(await installPackage(into, got, [publicKey])).toBeNull();
    expect(readdirSync(into)).toEqual([]);
  });

  it('refuses bytes whose length the signed size does not match', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    const gzipped = gzipSync(Buffer.from(BUNDLE));
    const got = await download(pair, { manifest: { sha256: await sha256Base64url(gzipped), size: gzipped.length + 1 } });

    expect(await installPackage(into, got, [publicKey])).toBeNull();
    expect(readdirSync(into)).toEqual([]);
  });

  it('refuses a body whose bundle is not base64url, without throwing', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    const got = await download(pair);
    // A proxy that rewrote the body, or a server that is not the real one. The install has to
    // answer null here too, because a throw would take the client's start with it.
    got.bytes = 'not base64url!!';

    expect(await installPackage(into, got, [publicKey])).toBeNull();
    expect(readdirSync(into)).toEqual([]);
  });

  it('leaves the installed package in place when the write fails halfway', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    await installPackage(into, await download(pair), [publicKey]);

    // Bytes that pass the digest and are not gzip, so the write throws where a full disk or a
    // killed download would.
    const broken = new Uint8Array([1, 2, 3, 4]);
    const got = await download(pair, {
      bytes: broken,
      manifest: { entry: 'pro-2.0.0.js', sha256: await sha256Base64url(broken), size: broken.length },
    });

    expect(await installPackage(into, got, [publicKey])).toBeNull();
    expect(readdirSync(into).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(join(into, 'pro-2.0.0.js'))).toBe(false);
    // The client still runs what it ran before the attempt.
    expect(installedEntry(into)).toBe(join(into, 'pro-1.0.0.js'));
    expect(readFileSync(join(into, 'pro-1.0.0.js'), 'utf8')).toBe(BUNDLE);
  });

  it('clears the half written file when the rename fails', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    // A directory under the entry's own name, so the rename fails after the bytes are written.
    // A full disk or a permission that changed mid install lands in the same place.
    mkdirSync(join(into, 'pro-1.0.0.js'));

    expect(await installPackage(into, await download(pair), [publicKey])).toBeNull();
    expect(readdirSync(into).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(installedEntry(into)).toBeNull();
  });

  it('flips current to the new file and leaves the old one readable', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    await installPackage(into, await download(pair), [publicKey]);

    const next = await download(pair, { bundle: 'export const id = "pro2";\n', manifest: { version: '2.0.0', entry: 'pro-2.0.0.js' } });
    const entry = await installPackage(into, next, [publicKey]);

    expect(entry).toBe(join(into, 'pro-2.0.0.js'));
    expect(installedEntry(into)).toBe(join(into, 'pro-2.0.0.js'));
    // The browser may be importing the old file while the new one lands, so it stays.
    expect(readFileSync(join(into, 'pro-1.0.0.js'), 'utf8')).toBe(BUNDLE);
  });

  it('clears a .tmp a killed process left behind', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    writeFileSync(join(into, 'pro-1.0.0.js.999.tmp'), 'half a download');

    await installPackage(into, await download(pair), [publicKey]);

    expect(readdirSync(into).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('reading what is installed', () => {
  it('finds nothing in a directory that was never written', () => {
    expect(installedEntry(join(dir(), 'packages'))).toBeNull();
  });

  it('finds nothing when current names a file that is gone', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    await installPackage(into, await download(pair), [publicKey]);
    writeFileSync(join(into, 'current'), 'pro-9.9.9.js');

    expect(installedEntry(into)).toBeNull();
  });

  it('refuses a pointer that names a path of its own', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    await installPackage(into, await download(pair), [publicKey]);
    writeFileSync(join(into, 'secrets.txt'), 'not a package');

    // A pointer nobody signed. The route serves what this answers straight to the browser as a
    // module, so a name that climbs out of the folder has to be refused here.
    for (const name of ['../secrets.txt', 'sub/pro-1.0.0.js', '.hidden', 'current']) {
      writeFileSync(join(into, 'current'), name);
      expect(installedEntry(into)).toBeNull();
    }
  });

  it('keeps packages in their own folder under the data directory', () => {
    const data = dir();

    expect(packageDir({ NOLZU_DATA_DIR: data })).toBe(join(data, 'packages'));
  });
});

describe('asking the server for the package', () => {
  const body = { manifest: { id: 'pro' }, signature: 'sig', bytes: 'gz' };

  it('sends the access token and answers with what the route sent', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const got = await fetchPackage('https://app.example/', 'tok', (url, init) => {
      calls.push({ url, headers: init.headers });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    });

    expect(got).toEqual(body);
    expect(calls).toEqual([{ url: 'https://app.example/api/package', headers: { authorization: 'Bearer tok' } }]);
  });

  it('answers null for a refusal, because Free is not an error', async () => {
    const got = await fetchPackage('https://app.example', 'tok', () =>
      Promise.resolve({ ok: false, status: 402, json: () => Promise.resolve({ error: 'feature_refused' }) }),
    );

    expect(got).toBeNull();
  });

  it('answers null for a refusal that carries a package anyway', async () => {
    // The status is the answer about the plan. A body that looks installable next to a 402 is a
    // server that contradicts itself, and the client takes the refusal.
    const got = await fetchPackage('https://app.example', 'tok', () =>
      Promise.resolve({ ok: false, status: 402, json: () => Promise.resolve(body) }),
    );

    expect(got).toBeNull();
  });

  it('answers null when the request never arrives', async () => {
    const got = await fetchPackage('https://app.example', 'tok', () => Promise.reject(new Error('offline')));

    expect(got).toBeNull();
  });

  it('answers null for a body that carries no bundle', async () => {
    const got = await fetchPackage('https://app.example', 'tok', () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ manifest: { id: 'pro' }, signature: 'sig' }) }),
    );

    expect(got).toBeNull();
  });
});

describe('the whole download path', () => {
  // A machine with an account, and a server that answers the access mint. The keychain and the
  // network are both stubs here, the way the runner's own tests take them.
  const signedIn = (deviceToken: string | null): Cloud => ({
    keychain: { read: () => Promise.resolve(deviceToken), write: () => Promise.resolve(), remove: () => Promise.resolve() },
    baseUrl: 'https://app.example',
    machine: 'laptop',
    say: () => {},
    fetch: (url) =>
      Promise.resolve({
        ok: url.endsWith('/api/device/access'),
        status: url.endsWith('/api/device/access') ? 200 : 404,
        json: () => Promise.resolve({ access_token: 'access' }),
      }),
  });

  it('mints a token, asks the server and installs what it sent', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    const got = await download(pair);
    const asked: string[] = [];

    const entry = await syncPackage(
      into,
      signedIn('device'),
      (url, init) => {
        asked.push(`${url} ${init.headers.authorization}`);
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(got) });
      },
      [publicKey],
    );

    expect(asked).toEqual(['https://app.example/api/package Bearer access']);
    expect(entry).toBe(join(into, 'pro-1.0.0.js'));
    expect(installedEntry(into)).toBe(entry);
  });

  it('asks nothing when the machine has no account', async () => {
    const asked: string[] = [];

    const entry = await syncPackage(dir(), signedIn(null), (url) => {
      asked.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    });

    expect(entry).toBeNull();
    expect(asked).toEqual([]);
  });

  // docs/extensions.md promises this: only logout takes the package of a lapsed plan away.
  it('keeps the installed package when a login on a lapsed plan is refused', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    const first = await installPackage(into, await download(pair), [publicKey]);

    const entry = await syncPackage(into, signedIn('device'), () => Promise.resolve({ ok: false, status: 402, json: () => Promise.resolve({}) }), [publicKey]);

    expect(entry).toBeNull();
    expect(first).toBe(join(into, 'pro-1.0.0.js'));
    expect(installedEntry(into)).toBe(first);
  });

  it('takes the whole folder away, so signing out drops the paid package', async () => {
    const into = dir();
    const { pair, publicKey } = await keys();
    await installPackage(into, await download(pair), [publicKey]);

    removePackages(into);

    expect(existsSync(into)).toBe(false);
    expect(installedEntry(into)).toBeNull();
  });

  it('is quiet about a folder that was never there', () => {
    expect(() => removePackages(join(dir(), 'packages'))).not.toThrow();
  });

  // The other half of the promise in docs/extensions.md. A login cannot run in a test, because it
  // needs the keychain, so this reads the one line of the bin that removes the package.
  it('is removed by the bin on logout and on no other command', () => {
    const bin = readFileSync(new URL('../../bin/start.js', import.meta.url), 'utf8');

    expect([...bin.matchAll(/^.*\bremovePackages\(.*$/gm)].map(([line]) => line.trim())).toEqual(["if (command.kind === 'logout') removePackages(packages);"]);
  });
});

it('ships with keys that are keys', () => {
  // A typo here refuses every package the server ever signs, and nothing would say why.
  for (const key of PACKAGE_PUBLIC_KEYS) {
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }
});
