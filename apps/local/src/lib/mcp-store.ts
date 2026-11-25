import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, resolveDataDir, writeSetting } from '@nolzu/core/node';
import { type EngineName, isFakeMode, type McpRule, type McpRun } from '@nolzu/protocol';
import { commitKnowledgeFiles, createKeychain, cursorRoot, git, gitEnv, type Keychain, mcpConfigProblem, mcpRemotes, mcpRunsFolder, mcpServers, type RunGit, restoreCursorMcp, runKeychain, worktreesFolder, writablePath } from '@nolzu/runner';
import { inTurn } from './manifest.ts';
import { emptyEntry, entryProblem, MCP_FILE, type McpEntry, type McpList, mcpListText, parseMcpList, reservedName, type SecretKey, secretKeysOf, serversFor, urlWarning } from './mcp-list.ts';

/**
 * The project's MCP servers on disk: the shared file in the workspace, committed there on each change
 * so a teammate gets it with git, and the secrets in this machine's keychain, which each teammate
 * enters on their own machine.
 */

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

/** The servers of a project folder. A link where the file should be is read as no file, with a sentence. */
export function readMcpList(project: string | null): McpList {
  if (project === null) return parseMcpList(null);
  const path = writablePath(project, MCP_FILE);
  // A link could point at any file on this machine.
  if (path === null) {
    const broken = `${MCP_FILE} is a link or sits in a linked folder, so Nolzu reads no server from it and writes nothing to it.`;
    return { ...parseMcpList(null), problems: [broken], broken };
  }
  return parseMcpList(readText(path));
}

/**
 * Writes the list, or says why it could not. The file is read again first: what it holds besides the
 * servers goes back in as it was, and a file Nolzu cannot read at all is never written over.
 */
export function writeMcpList(project: string | null, servers: readonly McpEntry[]): string | null {
  if (project === null) return 'This project has no folder, so there is nowhere to keep the list.';
  const path = writablePath(project, MCP_FILE);
  if (path === null) return `${MCP_FILE} is a link or sits in a linked folder, so Nolzu did not write it.`;
  // The project folder itself is never made here: a folder that is gone is a sentence, not a new one.
  if (!existsSync(project)) return `The project folder ${project} is not there, so Nolzu did not write ${MCP_FILE}.`;
  const now = parseMcpList(readText(path));
  if (now.broken !== null) return now.broken;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, mcpListText(servers, now.rest));
  return null;
}

// Whether the project folder is the top of its own repository, the one place the list can be committed.
async function ownRepository(project: string, run: RunGit): Promise<boolean> {
  const top = await run(['rev-parse', '--show-prefix']);
  return top.code === 0 && top.stdout.trim() === '';
}

/**
 * Why the list on disk must not be committed, or null. Anything Nolzu could not read cleanly counts: a
 * file it cannot parse, a row it left out, a secret value written into it, an address with a login.
 */
export function commitProblem(project: string | null): string | null {
  const list = readMcpList(project);
  const why = list.broken ?? list.problems[0] ?? list.servers.map(urlWarning).find((warning) => warning !== null) ?? null;
  return why === null ? null : `${MCP_FILE} is not committed, so your team does not get this change: ${why}`;
}

// Why the repository is in no state for Nolzu to commit in, or null: a detached HEAD, or a merge or a
// rebase the person is in the middle of.
async function repositoryBusy(run: RunGit): Promise<string | null> {
  if ((await run(['symbolic-ref', '-q', 'HEAD'])).code !== 0) return 'the project repository is on no branch (a detached HEAD). Check out a branch, then save again.';
  for (const [name, what] of [['MERGE_HEAD', 'a merge'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase'], ['CHERRY_PICK_HEAD', 'a cherry-pick']] as const) {
    const at = (await run(['rev-parse', '--git-path', name])).stdout.trim();
    if (at !== '' && existsSync(isAbsolute(at) ? at : join(await gitTop(run), at))) return `the project repository is in the middle of ${what}. Finish it, then save again.`;
  }
  return null;
}

const gitTop = async (run: RunGit): Promise<string> => (await run(['rev-parse', '--show-toplevel'])).stdout.trim();

/**
 * Commits the list in the project folder's own repository, so a teammate who pulls the workspace gets
 * it, the way the list of clones (`recordInRoot`) and the knowledge are committed. Only the file goes
 * into the commit. A project folder outside git has nothing to commit to, which the page says, and a
 * file with no change is left alone. The sentence a refused commit gets, or null.
 */
export function commitMcpList(project: string | null, env: Record<string, string | undefined> = process.env): Promise<string | null> {
  if (project === null) return Promise.resolve(null);
  return inTurn(project, async () => {
    const run: RunGit = (args) => git(args, { cwd: project, env: gitEnv(env as Record<string, string>) });
    if (!(await ownRepository(project, run))) return null;
    const changed = await run(['status', '--porcelain', '--', MCP_FILE]);
    if (changed.code !== 0 || changed.stdout.trim() === '') return null;
    // The file goes to every teammate as it is on disk, a hand edit included, so it is checked first.
    const unsafe = commitProblem(project);
    if (unsafe !== null) return unsafe;
    const busy = await repositoryBusy(run);
    if (busy !== null) return `${MCP_FILE} is not committed: ${busy}`;
    try {
      await commitKnowledgeFiles(run, 'chore: update the MCP servers', [MCP_FILE]);
      return null;
    } catch (error) {
      return `${MCP_FILE} is saved, but git could not commit it. ${(error as Error).message}`;
    }
  });
}

// The grid's boxes are clicked in bursts, so their commit waits for a quiet moment and takes them all.
const COMMIT_QUIET_MS = 3000;
const soon = new Map<string, NodeJS.Timeout>();

/** `commitMcpList` once the clicks stop for a moment. A failure stays as a changed file to commit. */
export function commitMcpListSoon(project: string | null, env: Record<string, string | undefined> = process.env, waitMs = COMMIT_QUIET_MS): void {
  if (project === null) return;
  clearTimeout(soon.get(project));
  const timer = setTimeout(() => {
    soon.delete(project);
    void commitMcpList(project, env).catch(() => undefined);
  }, waitMs);
  timer.unref();
  soon.set(project, timer);
}

/** Commits a waiting burst of grid clicks now, as a loop that closes does. Null with none waiting. */
export function flushMcpCommit(project: string | null, env: Record<string, string | undefined> = process.env): Promise<string | null> | null {
  if (project === null || !soon.has(project)) return null;
  clearTimeout(soon.get(project));
  soon.delete(project);
  return commitMcpList(project, env).catch(() => null);
}

/** Whether the list has changes git has not committed, which the page says. */
export async function listUncommitted(project: string | null, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (project === null) return false;
  const run: RunGit = (args) => git(args, { cwd: project, env: gitEnv(env as Record<string, string>) });
  if (!(await ownRepository(project, run))) return false;
  const changed = await run(['status', '--porcelain', '--', MCP_FILE]);
  return changed.code === 0 && changed.stdout.trim() !== '';
}

/**
 * Whether the list reaches the team: false for a project folder that is not its own repository, and
 * for a list the person's own git ignore rules leave out.
 */
export async function listShared(project: string | null, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  if (project === null) return false;
  const run: RunGit = (args) => git(args, { cwd: project, env: gitEnv(env as Record<string, string>) });
  if (!(await ownRepository(project, run))) return false;
  return (await run(['check-ignore', '-q', '--', MCP_FILE])).code !== 0;
}

/**
 * The keychain name of one secret: per project, server and key, as a hash, because a keychain name
 * holds lower case letters, digits and dashes only. The project is its id in the machine's registry,
 * not its folder, so a project that moves keeps its secrets. The keychain adds the data folder's tag.
 *
 * The server's address, or its command, arguments and folder, and its plain values are in it too. The list is a committed
 * file, so a pull can change where a server of the same name points, and the secret then stays behind:
 * the run says it is missing instead of sending it there. An edit on Settings moves it along.
 */
export const secretName = (projectId: number, server: Pick<McpEntry, 'name' | 'kind' | 'command' | 'args' | 'cwd' | 'url' | 'env' | 'headers'>, key: SecretKey): string => {
  const target = server.kind === 'remote' ? [server.url] : [server.command, ...server.args, server.cwd];
  // The plain values too: a server reads its host from one as often as from its arguments.
  const plain = [...server.env, ...server.headers].filter((one) => !one.secret).map((one) => `${one.name}=${one.value ?? ''}`);
  return `mcp-${createHash('sha256').update([String(projectId), server.name, ...target, ...plain, key.where, key.name].join('\0')).digest('hex').slice(0, 32)}`;
};

/**
 * The keychain the app uses for MCP secrets. The fake engine gets one in memory, so a test run or a
 * demo never writes the machine's keychain.
 */
const fakeKeychain = new Map<string, string>();
export function appKeychain(env: Record<string, string | undefined> = process.env): Keychain {
  if (isFakeMode(env)) {
    return {
      read: async (name) => fakeKeychain.get(name) ?? null,
      write: async (name, secret) => void fakeKeychain.set(name, secret),
      remove: async (name) => void fakeKeychain.delete(name),
    };
  }
  return createKeychain(process.platform, runKeychain, resolveDataDir(env));
}

/**
 * The secrets each server lacks on this machine, by server. A server with all of them is not listed. A
 * keychain that cannot be read counts as lacking, which is what a run would meet.
 */
export async function missingSecrets(projectId: number, servers: readonly McpEntry[], keychain: Keychain): Promise<Record<string, SecretKey[]>> {
  const missing: Record<string, SecretKey[]> = {};
  for (const entry of servers) {
    for (const key of secretKeysOf(entry)) {
      const held = await keychain.read(secretName(projectId, entry, key)).catch(() => null);
      if (held === null) (missing[entry.name] ??= []).push(key);
    }
  }
  return missing;
}

/** Takes every secret of a server off the keychain, as a delete of the server does. */
export async function removeSecrets(projectId: number, entry: McpEntry, keychain: Keychain): Promise<void> {
  for (const key of secretKeysOf(entry)) await keychain.remove(secretName(projectId, entry, key));
}

// Nolzu's own browser for QA: the Playwright MCP server with a home folder in the temp folder, so
// Chrome's profile and npx's cache stay out of the person's own. `{tmp}` is read as this machine's
// temp folder when a run starts, because the file goes to teammates whose temp folder is elsewhere.
// "The browser" everywhere means this server by its name, not any server on for QA.
export const BROWSER_NAME = 'playwright';
export const TMP_TOKEN = '{tmp}';
export const browserEntry = (): McpEntry => ({
  ...emptyEntry(),
  name: BROWSER_NAME,
  description: 'Google Chrome for QA, set up by Nolzu.',
  command: 'npx',
  args: ['@playwright/mcp@latest', '--headless', '--no-sandbox', '--allow-unrestricted-file-access'],
  env: [{ name: 'HOME', secret: false, value: `${TMP_TOKEN}/nolzu-browser-home` }],
  phases: ['qa'],
});

/** The servers a QA run gets, by name: what the QA browser row shows. */
export const qaServers = (project: string | null): string[] => serversFor(readMcpList(project).servers, 'qa').map((entry) => entry.name);

/** Whether QA has the browser: Nolzu's browser server on for QA, or a QA browser path not moved yet. */
export const qaHasBrowser = (db: DatabaseSync): boolean => getSetting(db, 'qaMcpConfigPath') !== null || qaServers(getSetting(db, 'projectPath')).includes(BROWSER_NAME);

type RawServer = Record<string, unknown>;

/**
 * Moves the QA browser of the old per-project setting into the list, once, as servers on for QA only.
 *
 * Every entry is checked like a typed one first; one that does not pass stops the move with its
 * sentence, and the old setting goes on giving QA its browser (`runMcp` reads it) until the move
 * succeeds. Nolzu's own config becomes `browserEntry`. Every env value and header of a config of the
 * person's own counts as a secret, because that file stayed on this machine and the list goes to
 * teammates, except an env name an engine reads for itself, which stays plain. A secret the keychain
 * refuses does not stop the move: the server comes in and shows "Needs secret". The setting is cleared
 * last. A server of the same name already in the list is kept as it is. Null when done or when there
 * was nothing to move.
 */
export async function migrateQaBrowser(db: DatabaseSync, projectId: number, keychain: Keychain, own: string): Promise<string | null> {
  const path = getSetting(db, 'qaMcpConfigPath');
  const project = getSetting(db, 'projectPath');
  if (path === null || project === null) return null;
  const notMoved = (why: string) => `The QA browser at ${path} is not moved to Settings, MCP servers yet, and QA still uses it from there. ${why}`;
  const gone = mcpConfigProblem(path);
  if (gone !== null) return `The QA browser at ${path} is not moved to Settings, MCP servers, and QA runs are refused until it is. ${gone}`;
  let raw: Record<string, RawServer>;
  try {
    const read = (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: unknown }).mcpServers;
    raw = typeof read === 'object' && read !== null ? (read as Record<string, RawServer>) : {};
  } catch {
    return notMoved('The file cannot be read as JSON. Fix it, or turn the browser off on Settings, Project.');
  }
  const list = readMcpList(project);
  if (list.broken !== null) return notMoved(list.broken);
  const added: McpEntry[] = [];
  const secrets: { entry: McpEntry; key: SecretKey; value: string }[] = [];
  const pairs = (value: unknown) => (typeof value === 'object' && value !== null ? Object.entries(value).map(([name, one]) => [name, String(one)] as const) : []);
  for (const [name, server] of Object.entries(raw)) {
    if ([...list.servers, ...added].some((entry) => entry.name.toLowerCase() === name.toLowerCase())) continue;
    if (path === own && name === BROWSER_NAME) {
      added.push(browserEntry());
      continue;
    }
    const remote = typeof server?.url === 'string' && typeof server.command !== 'string';
    const env = pairs(server?.env);
    const headers = remote ? pairs(server?.headers) : [];
    const entry: McpEntry = {
      ...emptyEntry(),
      name,
      kind: remote ? 'remote' : 'local',
      command: typeof server?.command === 'string' ? server.command : '',
      args: Array.isArray(server?.args) ? server.args.map(String) : [],
      url: remote ? String(server.url) : '',
      transport: server?.type === 'sse' ? 'sse' : 'http',
      env: env.map(([key, value]) => (reservedName(key) ? { name: key, secret: false, value } : { name: key, secret: true })),
      headers: headers.map(([key]) => ({ name: key, secret: true })),
      phases: ['qa'],
    };
    // An address with a login in it would be committed for every teammate, so the move waits for it.
    const problem = entryProblem(entry, [...list.servers, ...added]) ?? urlWarning(entry);
    if (problem !== null) return notMoved(problem);
    added.push(entry);
    secrets.push(...env.filter(([key]) => !reservedName(key)).map(([key, value]) => ({ entry, key: { where: 'env' as const, name: key }, value })));
    secrets.push(...headers.map(([key, value]) => ({ entry, key: { where: 'header' as const, name: key }, value })));
  }
  // `added` holds no name the list had when it was read above, and no wait came since, so no secret here
  // can land on a server of the same name. A secret the keychain will not take leaves its server asking
  // for it on Settings, MCP servers.
  for (const { entry, key, value } of secrets) await keychain.write(secretName(projectId, entry, key), value).catch(() => undefined);
  // Read again after the keychain, which may have waited for a person: a server saved meanwhile stays,
  // and one of the same name added meanwhile wins.
  const fresh = readMcpList(project);
  if (fresh.broken !== null) return notMoved(fresh.broken);
  const still = added.filter((entry) => !fresh.servers.some((one) => one.name.toLowerCase() === entry.name.toLowerCase()));
  const problem = still.length === 0 ? null : writeMcpList(project, [...fresh.servers, ...still]);
  if (problem !== null) return notMoved(problem);
  writeSetting(db, 'qaMcpConfigPath', null);
  return added.length === 0 ? null : commitMcpList(project);
}

/**
 * Puts back every `.cursor/mcp.json` a Cursor run left merged, then empties the data folder's
 * `mcp-runs` and makes it again with mode 700, so every run's wall has a folder to hide. Run at the boot
 * of the data folder, under its lock and before the QA copies go, when no run goes, so everything there
 * is left over from a crash.
 */
export function sweepMcpRuns(dataDir: string): void {
  const runs = mcpRunsFolder(dataDir);
  let found: string[] = [];
  try {
    found = readdirSync(runs);
  } catch {
    // Not made yet.
  }
  for (const name of found) restoreCursorMcp(join(runs, name));
  // A boot never stops on this: a folder that will not go is swept at the next one.
  try {
    rmSync(runs, { recursive: true, force: true });
    mkdirSync(runs, { recursive: true, mode: 0o700 });
  } catch (error) {
    console.error(`The MCP run folder ${runs} could not be cleared: ${(error as Error).message}`);
  }
}

export interface RunMcp {
  // The servers the run gets with their secrets, in memory, or null for none.
  mcp: McpRun | null;
  // One sentence for each server left out of the run, and for each limit the engine has.
  notes: string[];
}

/**
 * Whether Nolzu merges a Cursor run's servers into the `.cursor/mcp.json` Cursor reads. The run has to
 * start in QA's copy or under the project's worktrees folder, never in the person's own folder. The
 * file sits at the nearest git root above that (`cursorRoot`): the checkout for a Delivery card, the
 * project folder for a Research card, whose card folder holds checkouts and no `.git`. That root has to
 * lie inside the copy or the project, and its repository must not track the file, where `git add -u`
 * would take the merge into a commit.
 */
export async function cursorMergesHere(input: { project: string; cwd: string; qaCopy: string | null | undefined; tracked: (root: string) => Promise<boolean> }): Promise<boolean> {
  const inside = (folder: string, path: string) => path === folder || path.startsWith(`${folder}${sep}`);
  if (input.qaCopy != null) return inside(input.qaCopy, cursorRoot(input.qaCopy));
  const project = resolve(input.project);
  const worktrees = worktreesFolder(project);
  if (input.cwd === worktrees || !inside(worktrees, input.cwd)) return false;
  const root = cursorRoot(input.cwd);
  return inside(project, root) && !(await input.tracked(root));
}

/**
 * The servers a run of `phase` on `vendor` gets, with their secrets read from the keychain. Nothing is
 * written here: the runner hands Codex and Cursor their servers without a file, and writes Claude
 * Code's config for each attempt into `dir`, which the caller removes after the run.
 *
 * A server is left out with a sentence when this machine lacks a secret of it or the keychain cannot
 * read one, and for an SSE server on Codex, which speaks streamable
 * HTTP only. A Cursor run gets a server with a secret, with a sentence that its agent can read it.
 * `cursorHere` is `cursorMergesHere`: false where Nolzu merges nothing.
 * `legacy` is a QA browser path not moved into the list yet, which QA keeps until it is; a file that is
 * not there refuses the QA run with the reason.
 */
export async function runMcp(input: {
  project: string | null;
  projectId: number;
  phase: string;
  vendor: EngineName;
  keychain: Keychain;
  dir: string;
  cursorHere: boolean;
  legacy?: string | null;
}): Promise<RunMcp> {
  const { project, projectId, phase, vendor, keychain, dir } = input;
  const notes: string[] = [];
  const list = readMcpList(project);
  notes.push(...list.problems);
  const wanted = serversFor(list.servers, phase);
  const legacy = phase === 'qa' && input.legacy != null ? input.legacy : null;
  // A QA browser path not moved yet whose file is gone refuses the QA run, as it always did: a verdict
  // from a run with no browser says nothing about the pages.
  const gone = legacy === null ? null : mcpConfigProblem(legacy);
  if (gone !== null) throw new Error(gone);
  const fromLegacy = legacy === null ? {} : mcpServers(legacy);
  const remoteLegacy = legacy === null ? {} : mcpRemotes(legacy);
  const legacyNames = Object.keys({ ...fromLegacy, ...remoteLegacy }).filter((name) => !wanted.some((entry) => entry.name === name));
  const all = [...wanted.map((entry) => entry.name), ...legacyNames];
  if (all.length === 0) return { mcp: null, notes };
  const named = all.join(', ');
  if (vendor === 'cursor' && !input.cursorHere) {
    return { mcp: null, notes: [...notes, `This Cursor run starts in a folder where Nolzu merges no .cursor/mcp.json (your own folder, a checkout that tracks that file, or a folder whose git root lies outside the project), so ${named} ${all.length === 1 ? 'is' : 'are'} left out.`] };
  }
  const stdio: Record<string, McpRun['stdio'][string]> = {};
  const remote: Record<string, McpRun['remote'][string]> = {};
  const rules: Record<string, McpRule> = {};
  const codexEnv = new Map<string, string>();
  for (const entry of wanted) {
    if (vendor === 'codex' && entry.kind === 'remote' && entry.transport === 'sse') {
      notes.push(`Codex speaks to remote servers over streamable HTTP only, so the SSE server ${entry.name} is left out.`);
      continue;
    }
    const keys = secretKeysOf(entry);
    const values: Record<string, string> = {};
    const lacking: string[] = [];
    let unreadable: string | null = null;
    for (const key of keys) {
      try {
        const value = await keychain.read(secretName(projectId, entry, key));
        if (value === null) lacking.push(key.name);
        else values[`${key.where}:${key.name}`] = value;
      } catch (error) {
        unreadable = (error as Error).message;
        break;
      }
    }
    if (unreadable !== null) {
      notes.push(`${entry.name} is left out: the keychain could not be read for its secrets. ${unreadable}`);
      continue;
    }
    if (lacking.length > 0) {
      notes.push(`${entry.name} is left out: this machine has no secret ${lacking.join(', ')} for it. Enter it on Settings, MCP servers.`);
      continue;
    }
    const resolveValues = (where: 'env' | 'header', list: McpEntry['env']) =>
      Object.fromEntries(list.map((one) => [one.name, one.secret ? (values[`${where}:${one.name}`] ?? '') : (one.value ?? '').replaceAll(TMP_TOKEN, tmpdir())]));
    const env = resolveValues('env', entry.env);
    const secretEnv = entry.env.filter((one) => one.secret).map((one) => one.name);
    // Codex forwards a secret by its own name from its environment, so two servers with one name and
    // two values cannot both have it.
    const clash = vendor === 'codex' ? secretEnv.find((name) => codexEnv.has(name) && codexEnv.get(name) !== env[name]) : undefined;
    if (clash !== undefined) {
      notes.push(`${entry.name} is left out: Codex takes a secret by its name, and another server of this run has a different ${clash}.`);
      continue;
    }
    for (const name of secretEnv) codexEnv.set(name, env[name] ?? '');
    if (entry.kind === 'local') stdio[entry.name] = { command: entry.command, args: entry.args, env };
    else remote[entry.name] = { url: entry.url, transport: entry.transport, headers: resolveValues('header', entry.headers) };
    const cwd = entry.cwd === '' || project === null ? null : isAbsolute(entry.cwd) ? entry.cwd : join(project, entry.cwd);
    rules[entry.name] = { tools: entry.tools, secretEnv, secretHeaders: entry.headers.filter((one) => one.secret).map((one) => one.name), cwd };
    if (vendor === 'cursor' && entry.tools.length > 0) notes.push(`Cursor cannot limit single tools, so this run may call every tool of ${entry.name}.`);
    // Cursor's shell inherits cursor-agent's environment, where the values go, and the docs name no filter.
    if (vendor === 'cursor' && keys.length > 0) notes.push(`On Cursor the agent's shell can read the secret of ${entry.name}.`);
  }
  // The old QA browser, as it was handed before the list: its values plain, as its file held them.
  for (const name of legacyNames) {
    const local = fromLegacy[name];
    if (local !== undefined) stdio[name] = local;
    const far = remoteLegacy[name];
    if (far !== undefined) remote[name] = far;
    rules[name] = { tools: [], secretEnv: [], secretHeaders: [], cwd: null };
  }
  if (Object.keys(rules).length === 0) return { mcp: null, notes };
  return { mcp: { stdio, remote, rules, dir }, notes };
}

/** The servers of a run by name, for its prompt. */
export const mcpNames = (mcp: McpRun | null): string[] => (mcp === null ? [] : Object.keys(mcp.rules));

/**
 * What a run's prompt names before the run starts: QA's browser (Nolzu's browser server, or a QA
 * browser path not moved yet) and the other servers the phase is on for.
 */
export function promptMcp(project: string | null, phase: string, vendor: EngineName, legacy: string | null): { browser: string[]; servers: { name: string; description: string }[] } {
  const on = serversFor(readMcpList(project).servers, phase);
  const isBrowser = (name: string) => phase === 'qa' && name === BROWSER_NAME;
  const old = phase === 'qa' && legacy !== null ? Object.keys({ ...mcpServers(legacy), ...mcpRemotes(legacy) }).filter((name) => !on.some((entry) => entry.name === name)) : [];
  return {
    browser: [...on.filter((entry) => isBrowser(entry.name)).map((entry) => entry.name), ...old],
    servers: on.filter((entry) => !isBrowser(entry.name)).map((entry) => ({ name: entry.name, description: entry.description })),
  };
}
