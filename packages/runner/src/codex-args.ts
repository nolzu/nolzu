import type { Job, McpRule } from '@nolzu/protocol';
import { guardLeadingDash, guardName } from './args-guard.ts';
import type { McpRemote, McpServer } from './mcp-config.ts';

export interface CodexArgsOptions {
  // The effort levels the chosen model takes, from the model list the binary prints. Empty means
  // the list does not know the model, which is a refusal and not a free pass.
  levels: readonly string[];
  // True when the sandbox refuses every write. Only a phase that writes nothing runs that way, and
  // the summary pass is the one there is. A read-only phase that writes its own notes is started in
  // the card folder instead, where `-s workspace-write` gives the same limit from the other side.
  readOnly: boolean;
  // False when Nolzu's wall holds the run, which is the Codex row of `ENGINE_WALLS`. Codex's own
  // sandbox is then off, because one sandbox cannot start inside another, and the wall makes the
  // card folder and the knowledge folder writable. True, the default, is Codex's own sandbox alone,
  // so a caller that names nothing never gets a run with no wall at all.
  ownSandbox?: boolean;
  // The knowledge folder of a run that writes knowledge, a writable root under Codex's own sandbox.
  knowledgeDir?: string | null;
  // The package caches in Nolzu's data folder (`packageCaches`), a writable root under Codex's own
  // sandbox for a run that runs commands. Without it an install cannot write `~/.npm` and puts its
  // cache in the card folder.
  cachesDir?: string | null;
}

// A TOML string. A JSON string is one, as long as nothing in it needs an escape TOML lacks, and the
// only one is `\/`, which JSON.stringify never writes.
const toml = (text: string) => JSON.stringify(text);

// The first run of a server from npx downloads it, which takes longer than Codex's default wait.
const MCP_STARTUP_SEC = 120;

/**
 * The `-c` overrides that hand a run its servers, and the environment the secrets travel in.
 *
 * A secret never goes on the command line, where a process listing shows it to anybody on the
 * machine. A secret env variable is set in Codex's own environment and forwarded to its server by
 * `env_vars`, and a secret header is read from a variable by `env_http_headers`. Both names are then
 * taken out of the agent's shell with `shell_environment_policy.exclude`, because Codex keeps a name
 * holding KEY, SECRET or TOKEN by default. The current reference calls `exclude` the legacy form and
 * `filters` (a map of pattern to `exclude`) the canonical one, and still reads both. `exclude` stays,
 * because Nolzu was measured on Codex 0.145.0, and a release that does not know `filters` would drop
 * the key and with it the protection. An SSE server is left out: Codex speaks streamable HTTP only.
 */
export function codexMcp(
  servers: Readonly<Record<string, McpServer>>,
  remotes: Readonly<Record<string, McpRemote>> = {},
  rules: Readonly<Record<string, McpRule>> = {},
): { args: string[]; env: Record<string, string> } {
  const env: Record<string, string> = {};
  const hidden: string[] = [];
  const table = (pairs: [string, string][]) => `{ ${pairs.map(([key, value]) => `${toml(key)} = ${toml(value)}`).join(', ')} }`;
  const tools = (name: string) => {
    const list = rules[name]?.tools ?? [];
    return list.length === 0 ? [] : ['-c', `mcp_servers.${name}.enabled_tools=[${list.map(toml).join(', ')}]`];
  };
  const local = Object.entries(servers).flatMap(([name, server]) => {
    const key = `mcp_servers.${guardName(name, 'MCP server name')}`;
    const secret = new Set(rules[name]?.secretEnv ?? []);
    const plain = Object.entries(server.env).filter(([variable]) => !secret.has(variable));
    const forwarded = Object.entries(server.env).filter(([variable]) => secret.has(variable));
    for (const [variable, value] of forwarded) {
      env[variable] = value;
      hidden.push(variable);
    }
    const cwd = rules[name]?.cwd ?? null;
    return [
      '-c',
      `${key}.command=${toml(server.command)}`,
      '-c',
      `${key}.args=[${server.args.map(toml).join(', ')}]`,
      ...(plain.length === 0 ? [] : ['-c', `${key}.env=${table(plain)}`]),
      ...(forwarded.length === 0 ? [] : ['-c', `${key}.env_vars=[${forwarded.map(([variable]) => toml(variable)).join(', ')}]`]),
      ...(cwd === null ? [] : ['-c', `${key}.cwd=${toml(cwd)}`]),
      ...tools(name),
      '-c',
      `${key}.startup_timeout_sec=${MCP_STARTUP_SEC}`,
    ];
  });
  const remote = Object.entries(remotes)
    .filter(([, server]) => server.transport === 'http')
    .flatMap(([name, server]) => {
      const key = `mcp_servers.${guardName(name, 'MCP server name')}`;
      const secret = new Set(rules[name]?.secretHeaders ?? []);
      const plain = Object.entries(server.headers).filter(([header]) => !secret.has(header));
      const fromEnv = Object.entries(server.headers)
        .filter(([header]) => secret.has(header))
        .map(([header, value]): [string, string] => {
          const variable = `NOLZU_MCP_HEADER_${Object.keys(env).length}`;
          env[variable] = value;
          hidden.push(variable);
          return [header, variable];
        });
      return [
        '-c',
        `${key}.url=${toml(server.url)}`,
        ...(plain.length === 0 ? [] : ['-c', `${key}.http_headers=${table(plain)}`]),
        ...(fromEnv.length === 0 ? [] : ['-c', `${key}.env_http_headers=${table(fromEnv)}`]),
        ...tools(name),
        '-c',
        `${key}.startup_timeout_sec=${MCP_STARTUP_SEC}`,
      ];
    });
  const exclude = hidden.length === 0 ? [] : ['-c', `shell_environment_policy.exclude=[${hidden.map(toml).join(', ')}]`];
  return { args: [...local, ...remote, ...exclude], env };
}

// The prompt goes on stdin, which both `exec` and `exec resume` take as `-`. It is out of the
// argument list for the same reason as the Claude one: a process listing is readable by anybody on
// the machine, and a long prompt would hit the argument length limit.
const STDIN = '-';

/**
 * The arguments for one Codex run.
 *
 * Pure, so every isolation and model choice is checked without starting a process.
 *
 * The two paths are not one list with a flag flipped, and that is the point of the shape.
 * `exec resume` takes neither `-s` nor `-C`: it answers "unexpected argument '-s' found" and
 * stops, measured on 2026-09-25. So the sandbox goes through `-c sandbox_mode` on a resume, and the
 * working folder comes from the process, which starts in the card's checkout either way.
 */
export function codexArgs(job: Job, { levels, readOnly, ownSandbox = true, knowledgeDir = null, cachesDir = null }: CodexArgsOptions): string[] {
  if (job.sessionId !== null && job.resumeFrom !== null) {
    throw new Error(
      'A job set sessionId and resumeFrom together. Set sessionId to start a fresh run, or resumeFrom to continue an earlier one, never both.',
    );
  }
  const model = guardName(job.model, 'model');
  if (levels.length === 0) {
    // Either the list does not hold the model, or it holds one with no reasoning levels. One
    // sentence covers both, because naming the wrong one sends a person looking for a model that
    // is right there.
    throw new Error(`The Codex model list gives no effort levels for ${JSON.stringify(model)}, so nothing here knows which level to ask for. Pick a model the engine offers.`);
  }
  if (!levels.includes(job.effort)) {
    throw new Error(`The effort ${JSON.stringify(job.effort)} is not one of ${levels.join(', ')}, which are the levels ${model} takes.`);
  }
  const sandbox = readOnly ? 'read-only' : 'workspace-write';
  // Inside the wall the sandbox goes through `-c` on both paths, since the resume refuses `-s`. A
  // headless run cannot answer an approval, so it is asked for none: the wall says no instead.
  const off = ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"'];

  // The card folder is the writable area only when the run starts in it, which is how a read-only
  // phase runs on this engine. `job.cwd` is then the card folder, and the two are the same path.
  const addCardFolder = !readOnly && job.taskDir !== job.cwd;

  const shared = [
    '--json',
    // Without it a value in the person's own config.toml, such as a model or a sandbox, outranks
    // what the card chose and the run would do something else than the card says. The login is not
    // in that file: it lives in `CODEX_HOME`, which the flag leaves alone. The person's own MCP servers
    // live in that file too, so only the servers Nolzu hands over start. `-c mcp_servers={}` would
    // not do it: Codex ignores an empty table there (openai/codex issue 16045).
    '--ignore-user-config',
    '-m',
    model,
    // The effort is a config override and not a flag of its own.
    '-c',
    `model_reasoning_effort=${job.effort}`,
    // Both `exec` and `exec resume` refuse a folder outside a git repository without it. Passed only
    // when the project folder is not a repository, so every other run keeps today's arguments.
    ...(job.outsideGit === true ? ['--skip-git-repo-check'] : []),
    // The run's servers. Codex takes no config file on the command line, and no file holds them.
    ...(job.mcp === undefined ? [] : codexMcp(job.mcp.stdio, job.mcp.remote, job.mcp.rules).args),
  ];

  if (!ownSandbox) {
    if (job.resumeFrom !== null) return ['exec', 'resume', ...shared, ...off, guardName(job.resumeFrom, 'session id'), STDIN];
    return ['exec', ...shared, ...off, '-C', guardLeadingDash(job.cwd, 'checkout path'), STDIN];
  }
  const opened = [...(knowledgeDir === null ? [] : [guardLeadingDash(knowledgeDir, 'knowledge folder')]), ...(cachesDir === null || readOnly ? [] : [guardLeadingDash(cachesDir, 'cache folder')])];
  const roots = (list: string[]) => (list.length === 0 ? [] : ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(list)}`]);

  if (job.resumeFrom !== null) {
    return [
      'exec',
      'resume',
      ...shared,
      // The value is TOML, so the quotes are part of it.
      '-c',
      `sandbox_mode="${sandbox}"`,
      ...roots([...(addCardFolder ? [job.taskDir] : []), ...opened]),
      guardName(job.resumeFrom, 'session id'),
      STDIN,
    ];
  }

  return [
    'exec',
    ...shared,
    '-s',
    sandbox,
    // A project folder may hold a space, so only a leading dash is refused here.
    '-C',
    guardLeadingDash(job.cwd, 'checkout path'),
    // The card folder lies outside the checkout, so a phase that writes its artifact needs it
    // added. A run that starts in the card folder already has it, and a run the sandbox refuses
    // every write to has no use for it.
    ...(addCardFolder ? ['--add-dir', guardLeadingDash(job.taskDir, 'card folder')] : []),
    ...roots(opened),
    STDIN,
  ];
}
