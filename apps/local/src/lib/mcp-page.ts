import type { DatabaseSync } from 'node:sqlite';
import { getSetting, projectProfiles } from '@nolzu/core/node';
import { phaseLabel } from '@nolzu/protocol';
import type { Keychain } from '@nolzu/runner';
import { emptyEntry, entryProblem, gridPhases, MCP_FILE, type McpEntry, type McpValue, type SecretKey, secretKeysOf, unlimitedReadOnly, urlWarning } from './mcp-list.ts';
import { probeEntry, type ProbeOptions } from './mcp-probe.ts';
import { commitProblem, listShared, listUncommitted, missingSecrets, readMcpList, removeSecrets, secretName, writeMcpList } from './mcp-store.ts';

/**
 * Settings, MCP servers, the server side: the list with what this machine lacks, the edits, the grid
 * of servers by phase, and the secrets, which go to the keychain and never into the shared file.
 */

export interface McpRow {
  entry: McpEntry;
  // The secrets this machine has no value for. The server is left out of every run until then.
  missing: SecretKey[];
  // The labels of the read-only phases it is on for with no tool list, which the row warns about.
  unlimited: string[];
  // An address that looks like it holds a login, or null.
  urlWarning: string | null;
  // True when the server has a secret and a profile of this project runs on Cursor, whose agent can read it.
  cursorSecret: boolean;
}

export interface McpPageData {
  hasFolder: boolean;
  file: string;
  rows: McpRow[];
  problems: string[];
  phases: { phase: string; label: string; readOnly: boolean }[];
  // True when a profile runs on Cursor, which also starts the servers of the person's own config.
  cursor: boolean;
  // True when a profile runs on Codex, where a system or managed config may add servers, and which
  // leaves an SSE server out.
  codex: boolean;
  // A sentence when the file cannot be read at all, which also stops every write.
  broken: string | null;
  // False when the project folder is not its own git repository, so the list stays on this machine.
  shared: boolean;
  // True when the list has changes git has not committed, such as after a refused commit.
  uncommitted: boolean;
  // Why the list on disk is not committed, such as a hand edit with a secret value in it, or null.
  commitProblem: string | null;
  // Why the QA browser of the old setting is not moved into the list yet, or null.
  migration: string | null;
}

export async function mcpPage(db: DatabaseSync, keychain: Keychain, projectId: number, migration: string | null = null): Promise<McpPageData> {
  const project = getSetting(db, 'projectPath');
  const { servers, problems, broken } = readMcpList(project);
  const missing = await missingSecrets(projectId, servers, keychain);
  const profiles = projectProfiles(db);
  const cursor = profiles.some((profile) => profile.vendor === 'cursor');
  return {
    hasFolder: project !== null,
    file: MCP_FILE,
    rows: servers.map((entry) => ({ entry, missing: missing[entry.name] ?? [], unlimited: unlimitedReadOnly(entry).map(phaseLabel), urlWarning: urlWarning(entry), cursorSecret: cursor && secretKeysOf(entry).length > 0 })),
    problems,
    phases: gridPhases(getSetting(db, 'offBoards')),
    cursor,
    codex: profiles.some((profile) => profile.vendor === 'codex'),
    broken,
    shared: await listShared(project),
    uncommitted: await listUncommitted(project),
    commitProblem: commitProblem(project),
    migration,
  };
}

const field = (form: FormData, name: string): string => form.get(name)?.toString() ?? '';
const lines = (text: string): string[] =>
  text
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
// The tools of the form: the typed list, or one box per tool once a test listed them.
const toolsOf = (form: FormData): string[] => [...new Set(form.getAll('tools').flatMap((one) => lines(one.toString())))];

// The rows of one value list: names, modes and values, posted in the same order. A row with no name
// is an empty row of the form and is dropped.
function valueRows(form: FormData, prefix: string): { value: McpValue; typed: string }[] {
  const names = form.getAll(`${prefix}.name`).map(String);
  const modes = form.getAll(`${prefix}.mode`).map(String);
  const typed = form.getAll(`${prefix}.value`).map(String);
  return names.flatMap((name, index) => {
    const trimmed = name.trim();
    if (trimmed === '') return [];
    const secret = modes[index] === 'secret';
    const value = typed[index] ?? '';
    return [{ value: secret ? { name: trimmed, secret: true } : { name: trimmed, secret: false, value }, typed: secret ? value : '' }];
  });
}

// The server the form describes, with the secret values typed in it, which go nowhere but the keychain
// or a probe. `before` is the saved one an edit starts from.
function entryFromForm(form: FormData, before: McpEntry | undefined): { entry: McpEntry; env: { value: McpValue; typed: string }[]; headers: { value: McpValue; typed: string }[] } {
  const kind = field(form, 'kind') === 'remote' ? 'remote' : 'local';
  const env = valueRows(form, 'env');
  const headers = kind === 'remote' ? valueRows(form, 'header') : [];
  const entry: McpEntry = {
    ...emptyEntry(),
    name: field(form, 'name').trim(),
    description: field(form, 'description').trim(),
    kind,
    command: kind === 'local' ? field(form, 'command').trim() : '',
    args: kind === 'local' ? field(form, 'args').split('\n').map((line) => line.trim()).filter((line) => line !== '') : [],
    cwd: kind === 'local' ? field(form, 'cwd').trim() : '',
    url: kind === 'remote' ? field(form, 'url').trim() : '',
    transport: field(form, 'transport') === 'sse' ? 'sse' : 'http',
    env: env.map((row) => row.value),
    headers: headers.map((row) => row.value),
    tools: toolsOf(form),
    // A new server is off everywhere. An edit keeps the grid as it was, and the keys this version
    // does not know.
    phases: before?.phases ?? [],
    ...(before?.extra === undefined ? {} : { extra: before.extra }),
  };
  return { entry, env, headers };
}

/**
 * Adds a server, or changes the one named `original`. A secret typed in the form goes to the keychain;
 * a secret left empty keeps the value this machine has. A renamed server takes its secrets along.
 * The sentence it was refused with, or null.
 */
export async function saveServer(db: DatabaseSync, keychain: Keychain, form: FormData, projectId: number): Promise<string | null> {
  const project = getSetting(db, 'projectPath');
  if (project === null) return 'This project has no folder, so there is nowhere to keep the list.';
  const { servers, broken } = readMcpList(project);
  if (broken !== null) return broken;
  const original = field(form, 'original');
  const before = servers.find((entry) => entry.name === original);
  if (original !== '' && before === undefined) return `There is no server ${original} any more. Reload the page.`;
  const { entry, env, headers } = entryFromForm(form, before);
  const others = servers.filter((one) => one !== before);
  // An address with a login in it would be committed for every teammate, so it is refused here too.
  const problem = entryProblem(entry, others) ?? urlWarning(entry);
  if (problem !== null) return problem;

  const typed = [...env.map((row) => ({ key: { where: 'env' as const, name: row.value.name }, typed: row.typed })), ...headers.map((row) => ({ key: { where: 'header' as const, name: row.value.name }, typed: row.typed }))];
  // The secret being written, so a refusal names it.
  let writing = '';
  try {
    for (const { key, typed: value } of typed) {
      if (!secretKeysOf(entry).some((one) => one.where === key.where && one.name === key.name)) continue;
      writing = key.name;
      if (value !== '') {
        await keychain.write(secretName(projectId, entry, key), value);
        continue;
      }
      // Kept under the server as it was, renamed or pointed elsewhere by the person here, so it moves along.
      if (before !== undefined && secretName(projectId, before, key) !== secretName(projectId, entry, key)) {
        const kept = await keychain.read(secretName(projectId, before, key));
        if (kept !== null) await keychain.write(secretName(projectId, entry, key), kept);
      }
    }
    // A secret the edit dropped, or every secret kept under the server as it was, leaves the keychain.
    if (before !== undefined) {
      const still = (key: SecretKey) => secretKeysOf(entry).some((one) => one.where === key.where && one.name === key.name && secretName(projectId, before, key) === secretName(projectId, entry, key));
      for (const key of secretKeysOf(before)) if (!still(key)) await keychain.remove(secretName(projectId, before, key));
    }
  } catch (error) {
    return `The keychain did not take ${writing}. ${(error as Error).message}`;
  }
  // Read again after the keychain, which may have waited for a person: a change saved meanwhile stays.
  const fresh = readMcpList(project);
  if (fresh.broken !== null) return fresh.broken;
  const there = fresh.servers.find((one) => one.name === (before?.name ?? entry.name) && before !== undefined);
  const again = entryProblem(entry, fresh.servers.filter((one) => one !== there));
  if (again !== null) return again;
  return writeMcpList(project, there === undefined ? [...fresh.servers, entry] : fresh.servers.map((one) => (one === there ? entry : one)));
}

// What Test answers, for the row or the form it was pressed in. `tools` is what the server listed, and
// `chosen` the tools the row or the form allowed when it was pressed, so the boxes start from them.
export interface TestAnswer {
  name: string;
  from: 'row' | 'form';
  ok: boolean;
  said: string;
  tools: string[];
  chosen: string[];
}

/**
 * Test, on a saved row or in the open form: the probe starts the server as a run would and asks for its
 * tools. The form is tested as typed, with the secrets typed in it and the saved ones of the server it
 * edits for the rest, and nothing is saved. Never a refusal: a server that does not start is an answer.
 */
export async function testServer(db: DatabaseSync, keychain: Keychain, form: FormData, projectId: number, options: ProbeOptions = {}): Promise<TestAnswer> {
  const project = getSetting(db, 'projectPath');
  const { servers } = readMcpList(project);
  if (form.has('kind')) {
    const original = field(form, 'original');
    const saved = servers.find((one) => one.name === original);
    const { entry, env, headers } = entryFromForm(form, saved);
    // A box left empty takes the saved secret, read under the server as saved, also while the form
    // renames it or points it elsewhere, the way Save carries it along.
    const kept: Record<string, string> = {};
    if (saved !== undefined) {
      for (const key of secretKeysOf(saved)) kept[`${key.where}:${key.name}`] = (await keychain.read(secretName(projectId, saved, key)).catch(() => null)) ?? '';
    }
    const typed = Object.fromEntries(
      [...env.map((row) => [`env:${row.value.name}`, row.typed] as const), ...headers.map((row) => [`header:${row.value.name}`, row.typed] as const)].map(([where, value]) => [where, value === '' ? (kept[where] ?? '') : value]),
    );
    const probe = await probeEntry(entry, { project, projectId, keychain, typed }, options);
    return { name: original === '' ? entry.name : original, from: 'form', ok: probe.ok, said: probe.said, tools: probe.ok ? probe.tools : [], chosen: entry.tools };
  }
  const name = field(form, 'name');
  const entry = servers.find((one) => one.name === name);
  if (entry === undefined) return { name, from: 'row', ok: false, said: `There is no server ${name}. Reload the page.`, tools: [], chosen: [] };
  const probe = await probeEntry(entry, { project, projectId, keychain }, options);
  return { name, from: 'row', ok: probe.ok, said: probe.said, tools: probe.ok ? probe.tools : [], chosen: entry.tools };
}

/** Takes a server out of the list, with its secrets. */
export async function deleteServer(db: DatabaseSync, keychain: Keychain, name: string, projectId: number): Promise<string | null> {
  const project = getSetting(db, 'projectPath');
  const { servers, broken } = readMcpList(project);
  if (broken !== null) return broken;
  const found = servers.find((entry) => entry.name === name);
  if (project === null || found === undefined) return `There is no server ${name}. Reload the page.`;
  const problem = writeMcpList(project, servers.filter((entry) => entry !== found));
  if (problem !== null) return problem;
  await removeSecrets(projectId, found, keychain).catch(() => undefined);
  return null;
}

/** One cell of the grid. */
export function setPhase(db: DatabaseSync, name: string, phase: string, on: boolean): string | null {
  const project = getSetting(db, 'projectPath');
  const { servers, broken } = readMcpList(project);
  if (broken !== null) return broken;
  const found = servers.find((entry) => entry.name === name);
  if (found === undefined) return `There is no server ${name}. Reload the page.`;
  const phases = on ? [...new Set([...found.phases, phase])] : found.phases.filter((one) => one !== phase);
  const next = { ...found, phases };
  const problem = entryProblem(next, servers.filter((entry) => entry !== found));
  if (problem !== null) return problem;
  return writeMcpList(project, servers.map((entry) => (entry === found ? next : entry)));
}

/** The value of one secret this machine lacks, from the "Needs secret" field. */
export async function saveSecret(db: DatabaseSync, keychain: Keychain, name: string, where: string, key: string, value: string, projectId: number): Promise<string | null> {
  const project = getSetting(db, 'projectPath');
  const found = readMcpList(project).servers.find((entry) => entry.name === name);
  const secret = found === undefined ? undefined : secretKeysOf(found).find((one) => one.where === where && one.name === key);
  if (project === null || found === undefined || secret === undefined) return `${name} has no secret ${key}. Reload the page.`;
  if (value === '') return `Type the value of ${key}.`;
  try {
    await keychain.write(secretName(projectId, found, secret), value);
  } catch (error) {
    return (error as Error).message;
  }
  return null;
}
