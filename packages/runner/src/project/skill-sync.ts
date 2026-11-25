import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { writablePath } from './writable.ts';

// What Nolzu wrote on the last sync, file by file, so a later sync can tell a file nobody touched from
// one the person changed. It is a file and not a folder, so the skills lint, which reads folders only,
// skips it.
export const SYNC_RECORD = '.nolzu-skills.json';

// The record's key for the Nolzu version that wrote it. A skill path always holds a slash, so no file
// can take this key.
export const RECORD_VERSION = 'version';

// The record's key for the files the person chose to keep with "Keep mine", each with the mark of the
// shipped text it was kept for. A sync stops calling such a file the person's edit until Nolzu ships
// another text for it. The first folder's record also holds the project files outside the skills, as
// AGENTS.md, by their path in the project: a skill path always sits in a folder that does not start
// with a dot, so neither kind can take the other's key.
export const RECORD_KEPT = 'kept';

// Where the engines read a project's skills. `.agents/skills` is the open Agent Skills folder, read by
// Codex and Cursor, and `.claude/skills` is Claude Code's (Cursor reads it too). Each holds the same
// copy with its own record. The order is the one a run looks for the person's edit in.
export const SKILL_FOLDERS = ['.agents/skills', '.claude/skills'] as const;

// The project's own extra skills, shared through git beside the MCP list. The sync copies them into the
// two folders with Nolzu's, under the same record, so a later sync removes one the folder dropped.
export const EXTRA_SKILLS = '.nolzu/skills';

export interface SyncResult {
  // Paths relative to the skills folder, sorted.
  copied: string[];
  removed: string[];
  // Files the person changed, had there before Nolzu wrote them, or reached through a symlink. Kept.
  conflicts: string[];
  // Files the person changed and chose to keep for the text Nolzu ships now. Kept, and not conflicts.
  kept: string[];
  // The version a newer Nolzu wrote the folder with. Set only when the sync wrote nothing because of it.
  newer?: string;
  // One sentence for each extra skill left out, because Nolzu ships a skill of that name.
  refused?: string[];
}

export interface SyncOptions {
  // The installed Nolzu's version, kept in the record. Without it the record gets none and no folder
  // counts as newer.
  version?: string;
  // Works out the same result and writes nothing, not even the folder.
  dryRun?: boolean;
}

const hash = (text: Buffer): string => createHash('sha256').update(text).digest('hex');

// Every file under the skill folders of `root`, relative to it, with `/` between the parts so the
// record reads the same on every system. Hidden files are left out: a Finder file from the machine the
// package was built on is part of no skill.
function filesOf(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const at = join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (entry.isFile()) found.push(relative(root, at).split(sep).join('/'));
    }
  };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) walk(join(root, entry.name));
  }
  return found.sort();
}

interface SyncRecord {
  files: Record<string, string>;
  version: string | null;
  kept: Record<string, string>;
}

function readRecord(target: string): SyncRecord {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(target, SYNC_RECORD), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { files: {}, version: null, kept: {} };
    // A record from before the key has no version, which is fine to write over.
    const { [RECORD_VERSION]: version, [RECORD_KEPT]: kept, ...files } = parsed as Record<string, unknown>;
    const strings = (from: unknown) => Object.fromEntries(Object.entries(typeof from === 'object' && from !== null ? from : {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    return { files: strings(files), version: typeof version === 'string' ? version : null, kept: strings(kept) };
  } catch {
    // No record, or one that does not parse, is a first sync: every file already there is the person's.
    return { files: {}, version: null, kept: {} };
  }
}

// Written only when it changed, so a sync with nothing to do touches no file, not even its time.
function writeRecord(target: string, { files, version, kept }: SyncRecord): void {
  const record = `${JSON.stringify({ ...(version === null ? {} : { [RECORD_VERSION]: version }), ...(Object.keys(kept).length === 0 ? {} : { [RECORD_KEPT]: kept }), ...files }, null, 2)}\n`;
  const recordAt = join(target, SYNC_RECORD);
  if (!isFile(recordAt) || readFileSync(recordAt, 'utf8') !== record) writeFileSync(recordAt, record);
}

// The mark "Keep mine" stores for a shipped text: its hash, or `gone` for a file Nolzu no longer ships.
export const shippedMark = (shipped: Buffer | string | null): string => (shipped === null ? 'gone' : hash(Buffer.from(shipped)));

// Whether version `a` comes after `b`: major, minor and patch as numbers, then a release after its own
// prereleases, then prereleases as text, which is time order for the stamp CI puts in them. A version
// that does not read as one is never newer.
export function newerVersion(a: string, b: string): boolean {
  const parse = (version: string) => /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return false;
  for (const at of [1, 2, 3]) {
    if (Number(x[at]) !== Number(y[at])) return Number(x[at]) > Number(y[at]);
  }
  if (x[4] === undefined || y[4] === undefined) return x[4] === undefined && y[4] !== undefined;
  return x[4] > y[4];
}

const isFile = (at: string): boolean => {
  try {
    return lstatSync(at).isFile();
  } catch {
    return false;
  }
};

// The `name:` in the frontmatter of a SKILL.md, or null.
function frontmatterName(file: string): string | null {
  try {
    const head = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))?.[1] ?? '';
    return /^name:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(head)?.[1] ?? null;
  } catch {
    return null;
  }
}

const isFolder = (at: string): boolean => {
  try {
    return lstatSync(at).isDirectory();
  } catch {
    return false;
  }
};

const hashOf = (at: string): string | null => (isFile(at) ? hash(readFileSync(at)) : null);

// Removes the folders a removal left empty, up to the skills folder and never past it.
function pruneEmpty(dir: string, target: string): void {
  for (let at = dir; at !== target && at.startsWith(target + sep); at = dirname(at)) {
    if (readdirSync(at).length > 0) return;
    rmdirSync(at);
  }
}

// Copies the skills of `source` into `target`, the engine's skills folder in a project. It can run
// again after an upgrade. A file is written only when it is missing or still exactly what Nolzu wrote
// last time, so a skill the person edited is kept and reported instead of lost. Every other skill in
// `target` is left alone. A folder a newer Nolzu wrote is left alone whole, so an older one never puts
// back what the newer one replaced.
export function syncSkills(source: string | readonly string[], targetFolder: string, { version, dryRun = false }: SyncOptions = {}): SyncResult {
  // Resolved once, so a trailing slash or a relative name cannot make a later containment check fail.
  const target = resolve(targetFolder);
  const { files: recorded, version: wroteIt, kept: keptBefore } = readRecord(target);
  if (version !== undefined && wroteIt !== null && newerVersion(wroteIt, version)) return { copied: [], removed: [], conflicts: [], kept: [], newer: wroteIt };
  const next: Record<string, string> = {};
  // A kept entry this sync does not look at, as a project file's, goes on as it was.
  const kept = { ...keptBefore };
  const result: SyncResult = { copied: [], removed: [], conflicts: [], kept: [] };
  // Each file and the folder it comes from. The first source is Nolzu's own, and a later one's skill
  // with a name the first already has is refused whole, so a project cannot swap a phase's method.
  const origin = new Map<string, string>();
  const [own, ...extra] = [source].flat();
  for (const path of filesOf(own ?? '')) origin.set(path, own ?? '');
  const shipped = new Set([...origin.keys()].map((path) => (path.split('/')[0] ?? '').toLowerCase()));
  for (const root of extra) {
    const clashes = new Set<string>();
    // A skill is known by its folder and by the `name:` in its SKILL.md, and an engine goes by either.
    const named = (skill: string) => shipped.has(skill.toLowerCase()) || shipped.has((frontmatterName(join(root, skill, 'SKILL.md')) ?? '').toLowerCase());
    for (const path of filesOf(root)) {
      const skill = path.split('/')[0] ?? '';
      if (named(skill)) clashes.add(skill);
      else origin.set(path, root);
    }
    for (const skill of [...clashes].sort()) (result.refused ??= []).push(`The skill ${skill} in ${EXTRA_SKILLS} has the name of a skill Nolzu ships, in its folder or its SKILL.md, so it was not copied. Rename its folder and its name.`);
  }
  const wanted = [...origin.keys()].sort();
  // The same file on a disk that ignores case, which macOS does by default.
  const wantedFolded = new Set(wanted.map((path) => path.toLowerCase()));

  // A file kept for the person keeps the hash Nolzu wrote, so it becomes Nolzu's again once the
  // person's text is back to it.
  // A file the person kept for this very text is no conflict. Kept for an older text, it is one again.
  const keep = (path: string, mark: string) => {
    if (kept[path] === mark) result.kept.push(path);
    else {
      result.conflicts.push(path);
      delete kept[path];
    }
    if (typeof recorded[path] === 'string') next[path] = recorded[path];
  };

  for (const path of wanted) {
    const content = readFileSync(join(origin.get(path) ?? '', path));
    const fresh = hash(content);
    const at = writablePath(target, path);
    if (at === null) {
      keep(path, fresh);
      continue;
    }
    const missing = !isFile(at);
    const there = hashOf(at);

    // Nolzu's again, so a keep from before has nothing left to keep.
    if (there === fresh) {
      next[path] = fresh;
      delete kept[path];
      continue;
    }
    // Missing, or exactly what the last sync wrote: this file is Nolzu's to write.
    if (missing || (there !== null && there === recorded[path])) {
      if (!dryRun) {
        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, content);
      }
      next[path] = fresh;
      delete kept[path];
      result.copied.push(path);
      continue;
    }
    keep(path, fresh);
  }

  // Files the last sync wrote that the package no longer has.
  for (const path of Object.keys(recorded).sort()) {
    if (wanted.includes(path) || wantedFolded.has(path.toLowerCase())) continue;
    const at = writablePath(target, path);
    if (at === null) continue;
    const there = hashOf(at);
    if (there === null) {
      delete kept[path];
      continue;
    }
    if (there !== recorded[path]) {
      keep(path, shippedMark(null));
      continue;
    }
    if (!dryRun) {
      rmSync(at);
      pruneEmpty(dirname(at), target);
    }
    delete kept[path];
    result.removed.push(path);
  }

  result.conflicts.sort();
  result.kept.sort();
  if (dryRun) return result;
  mkdirSync(target, { recursive: true });
  writeRecord(target, { files: next, version: version ?? null, kept });
  return result;
}

// "Take the new one" for a skill file the person changed: Nolzu's text goes in its place, or the file
// goes when Nolzu no longer ships it, and the record calls it Nolzu's again. False for a file reached
// through a link, which Nolzu never writes through.
export function takeShippedSkill(targetFolder: string, path: string, shipped: Buffer | null): boolean {
  const target = resolve(targetFolder);
  const at = writablePath(target, path);
  if (at === null) return false;
  const record = readRecord(target);
  delete record.kept[path];
  if (shipped === null) {
    if (isFile(at)) {
      rmSync(at);
      pruneEmpty(dirname(at), target);
    }
    delete record.files[path];
  } else {
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, shipped);
    record.files[path] = hash(shipped);
  }
  writeRecord(target, record);
  return true;
}

// "Keep mine": the record keeps `path` as the person's for the shipped text `mark` names, or forgets
// that with a null. The path is a skill file of this folder, or a project file in the first folder's.
export function keepForShipped(targetFolder: string, path: string, mark: string | null): void {
  const target = resolve(targetFolder);
  const record = readRecord(target);
  if (mark === null) delete record.kept[path];
  else record.kept[path] = mark;
  mkdirSync(target, { recursive: true });
  writeRecord(target, record);
}

// The shipped text a project file was kept for, from the first folder's record, or null.
export const keptMark = (targetFolder: string, path: string): string | null => readRecord(resolve(targetFolder)).kept[path] ?? null;

// The person's text of one file in the project's skills folder, or null when the file is Nolzu's. The
// same rule as the sync above: a plain file that is neither what Nolzu ships now nor what the last sync
// recorded is the person's. With no record at all, every such file is, as on a first sync. A run reads
// it from here, so a skill someone edited is the method every engine is handed.
export function personsSkillText(targetFolder: string, path: string, shipped: string | null): string | null {
  const target = resolve(targetFolder);
  const at = join(target, path);
  if (!isFile(at)) return null;
  const bytes = readFileSync(at);
  const text = bytes.toString('utf8');
  if (text === shipped) return null;
  return readRecord(target).files[path] === hash(bytes) ? null : text;
}

// Syncs every skills folder of a project. A folder that is a link, sits under one, or is not a folder
// is refused alone with a null: a linked `.claude` is a dotfiles arrangement, and copying through it
// would write into whatever else links to it. The record file names the folder itself, so one check
// covers both levels. The other folders still sync.
// The project's extra skills ride along when `.nolzu/skills` is a plain folder.
export function syncSkillFolders(source: string, project: string, options: SyncOptions = {}): { folder: string; synced: SyncResult | null }[] {
  const extra = join(resolve(project), EXTRA_SKILLS);
  const sources = writablePath(resolve(project), `${EXTRA_SKILLS}/${SYNC_RECORD}`) !== null && isFolder(extra) ? [source, extra] : [source];
  return SKILL_FOLDERS.map((folder) => ({
    folder,
    synced: writablePath(resolve(project), `${folder}/${SYNC_RECORD}`) === null ? null : syncSkills(sources, join(project, folder), options),
  }));
}

// The person's text of one skill file and the folder it came from, from the first folder that has an
// edit of it. Null when every copy is Nolzu's.
export function personsSkillEdit(project: string, path: string, shipped: string | null): { text: string; folder: string } | null {
  for (const folder of SKILL_FOLDERS) {
    const text = personsSkillText(join(project, folder), path, shipped);
    if (text !== null) return { text, folder };
  }
  return null;
}
