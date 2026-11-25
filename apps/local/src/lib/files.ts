import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, resolveDataDir } from '@nolzu/core/node';
import type { CardFileGroup } from '@nolzu/protocol';
import { CARD_DOWNLOAD_CAP, CARD_FILE_CAP, cardFileKind, isPlainName, listCardFiles, readCardFile } from '@nolzu/runner';
import { whenSaid } from './when-said.ts';

// The card folder, where the loop puts it: in the project, or in the data folder when there is none,
// which is the fake engine's case. Null for a key that is not one plain name.
export function cardFolder(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env): string | null {
  if (!isPlainName(key)) return null;
  return join(getSetting(db, 'projectPath') ?? resolveDataDir(env), '.tasks', key);
}

// The card folder as the Files tab lists it, each file with when it last changed in the trail's words.
export function filesFor(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env, now = new Date()): CardFileGroup[] {
  const dir = cardFolder(db, key, env);
  if (dir === null) return [];
  return listCardFiles(dir).map((group) => ({ ...group, files: group.files.map((file) => ({ ...file, when: whenSaid(new Date(file.modified).toISOString(), now) })) }));
}

// No script, nothing from the network, and only this app may frame it. A design screen keeps its
// inline styles and the pictures and fonts it carries as data, and links its tokens.css from this app,
// which is what 'self' allows. 'self' is the address the file came from, though the sandbox gives the
// page no origin of its own.
// Limit: 'self' lets a screen link any stylesheet of this app, not only its card's. A stylesheet runs
// nothing and reaches no network here, so a path source per card is not worth the host it needs.
export const FILE_POLICY = "sandbox; default-src 'none'; style-src 'self' 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";

// One file as a response. A file the page shows is sent as what it is; anything else is an attachment.
// Nothing sent here runs as a page of this app: the sandbox policy and nosniff see to that.
export function fileResponse(db: DatabaseSync, key: string, path: string, download: boolean, env: Record<string, string | undefined> = process.env): Response {
  const dir = cardFolder(db, key, env);
  if (dir === null) return new Response(`The card key ${JSON.stringify(key)} is not one plain name.`, { status: 400 });
  // A picture is shown whole or not at all, so it gets the download cap even when the page asks for
  // it inline. A QA screenshot of a full page passes a quarter of a megabyte easily, and the panel
  // would otherwise answer the click with the size instead of the shot.
  const read = readCardFile(dir, path, download || cardFileKind(path) === 'image' ? CARD_DOWNLOAD_CAP : CARD_FILE_CAP);
  if (!read.ok) return new Response(read.reason, { status: read.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const name = path.split('/').pop() ?? 'file';
  const headers: Record<string, string> = {
    'content-type': read.type,
    'x-content-type-options': 'nosniff',
    'content-security-policy': FILE_POLICY,
  };
  // A plain name for old clients, and the real one in the form every current browser reads, because a
  // header may only hold bytes up to 255 and a name such as a Chinese one would otherwise crash here.
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  if (download || read.kind === 'download') headers['content-disposition'] = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
  return new Response(new Uint8Array(read.bytes), { status: 200, headers });
}
