import { readFileSync } from 'node:fs';
import { CLOUD_OPEN } from '@nolzu/protocol';
import { installedEntry, packageDir } from '$lib/package.ts';
import type { RequestHandler } from './$types';

// A client with no package installed, which is every free client. An empty module rather than a
// 404, so the app's one import always lands and nothing is logged on a normal start.
const EMPTY = 'export {};\n';

// The installed package, as a module the browser imports. `fileResponse` is no use here: it sends
// a sandbox policy and nosniff on purpose, which is the opposite of what an importable module
// needs. Nothing is cached, because an install flips the file under this same path.
export const GET: RequestHandler = () =>
  new Response(installed(), {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' },
  });

// A file that cannot be read is the empty module as well. The app imports this path on every start,
// so a folder somebody made unreadable has to mean the free client and not a 500.
function installed(): string {
  // While the cloud is closed no paid feature runs, so a package a sign-in left behind stays unloaded.
  if (!CLOUD_OPEN) return EMPTY;
  try {
    const entry = installedEntry(packageDir());
    return entry === null ? EMPTY : readFileSync(entry, 'utf8');
  } catch {
    return EMPTY;
  }
}
