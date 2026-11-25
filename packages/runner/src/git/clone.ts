import { isFolderName, NOLZU_FOLDERS } from '@nolzu/core';
import { cloneInto, type Cloned } from './clone-into.ts';
import type { CloneProgress } from './porcelain.ts';

export { CLONE_TIMEOUT_MS, type Cloned } from './clone-into.ts';

export type CloneTarget = { ok: true; name: string } | { ok: false; reason: string };

const NOT_A_REMOTE = 'Type an https:// or the user@host:path form of the repository URL. Nolzu clones nothing else, not a local path either.';
const CREDENTIAL = 'The URL holds a user name and password or a token. Type it without them, and let git find the login the way it does for a push.';

// The scp form of ssh. The user is there, so a Windows drive such as C:\ never reads as a host, and
// neither the host nor the path may start with "-", which ssh or git would read as an option.
const SCP = /^([A-Za-z0-9._~][A-Za-z0-9._~-]*)@([A-Za-z0-9][A-Za-z0-9.-]*):([^\s\\]+)$/;

/**
 * The folder a URL clones into, or the sentence that refuses it.
 *
 * Only https and the scp form of ssh pass. Git reads `<word>::` as a transport that can run any
 * command, and a file URL or a local path would copy a folder of this machine. A sentence never
 * repeats a URL, so a token typed into one is never shown or logged. `taken` is the workspace list,
 * read in lower case because the default macOS disk does.
 */
export function cloneTarget(typed: string, taken: readonly string[] = []): CloneTarget {
  const url = typed.trim();
  if (url === '') return { ok: false, reason: 'Type the URL of the repository to clone.' };
  if (url.startsWith('-')) return { ok: false, reason: 'The URL starts with "-", which git would read as an option.' };
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(url)) return { ok: false, reason: 'The URL names a git transport of its own, which can run any command. Type an https:// or user@host:path URL.' };
  if (/\s/.test(url)) return { ok: false, reason: 'The URL has a space in it. Type the URL alone.' };

  let path: string;
  if (/^https:\/\//i.test(url)) {
    // A URL parser reads a backslash as "/", but git hands the typed text to curl, which can read a
    // token before a backslash and "@" as a user name. The check and git would read two URLs.
    if (url.includes('\\')) return { ok: false, reason: 'The URL has a "\\" in it. Type it with "/" only.' };
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, reason: 'The URL cannot be read. Copy it again from the repository page.' };
    }
    if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: CREDENTIAL };
    // A token can travel in the query too, and a clone URL needs none.
    if (parsed.search !== '' || parsed.hash !== '' || url.includes('?') || url.includes('#')) return { ok: false, reason: 'The URL has a query or a # part. Type the repository URL without it.' };
    path = parsed.pathname;
  } else {
    // A password before the @ of the scp form, as in user:token@host:path.
    if (/^[^@/:]+:[^@/]*@/.test(url)) return { ok: false, reason: CREDENTIAL };
    const scp = SCP.exec(url);
    if (scp === null || scp[3]?.startsWith('-') === true) return { ok: false, reason: NOT_A_REMOTE };
    path = scp[3] ?? '';
  }

  const last = path.split('/').filter((part) => part !== '').at(-1);
  if (last === undefined) return { ok: false, reason: 'The URL names no repository, only a host. Type the URL of the repository itself.' };
  const name = last.replace(/\.git$/i, '');
  const quoted = JSON.stringify(name);
  if (NOLZU_FOLDERS.includes(name.toLowerCase())) return { ok: false, reason: `The repository would clone into ${quoted}, which is where Nolzu keeps its own files.` };
  if (!isFolderName(name)) return { ok: false, reason: `The repository name ${quoted} cannot name a folder in the workspace.` };
  const held = taken.find((one) => one.toLowerCase() === name.toLowerCase());
  if (held !== undefined) return { ok: false, reason: `There is a repository ${JSON.stringify(held)} in this workspace already.` };
  return { ok: true, name };
}

export interface CloneOptions {
  workspace: string;
  url: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  // The repositories the workspace lists now.
  taken?: readonly string[];
  // Where git's progress goes while it clones.
  onProgress?: (progress: CloneProgress) => void;
}

/**
 * Clones a repository into a new folder of the workspace, with git held to https and ssh, no prompt
 * and a time limit. A clone that fails, is stopped or brings no commit leaves no folder behind.
 */
export async function cloneRepository({ workspace, url, env, signal, taken = [], onProgress }: CloneOptions): Promise<Cloned> {
  const target = cloneTarget(url, taken);
  if (!target.ok) return target;
  return cloneInto({ workspace, url: url.trim(), name: target.name, env, signal, protocols: 'https:ssh', onProgress });
}
