import type { Job } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { codexArgs, codexMcp } from './codex-args.ts';

// The levels `gpt-5.6-sol` carries, from `codex debug models --bundled` on 0.145.0.
const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const job = (over: Partial<Job> = {}): Job => ({
  runId: 1,
  cardKey: 'APP-1',
  engine: 'codex',
  phase: 'refine',
  cwd: '/projects/recipes/worktrees/APP-1',
  taskDir: '/projects/recipes/.tasks/APP-1',
  prompt: 'Refine the ticket.',
  model: 'gpt-5.6-sol',
  effort: 'xhigh',
  sessionId: null,
  resumeFrom: null,
  timeoutMs: 30 * 60 * 1000,
  logPath: '/data/logs/1.ndjson',
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read', 'Grep'],
  ...over,
});

const args = (over: Partial<Job> = {}, readOnly = true) => codexArgs(job(over), { levels: LEVELS, readOnly });

it('starts a run that writes nothing with the read-only sandbox, the model and the effort', () => {
  // The summary pass, which is the one run that writes no file at all.
  expect(args({ phase: 'extract-summary' })).toEqual([
    'exec',
    '--json',
    '--ignore-user-config',
    '-m',
    'gpt-5.6-sol',
    '-c',
    'model_reasoning_effort=xhigh',
    '-s',
    'read-only',
    '-C',
    '/projects/recipes/worktrees/APP-1',
    '-',
  ]);
});

/**
 * The shape a read-only phase takes on this engine.
 *
 * The run starts in the card folder under `-s workspace-write`, so the writable area is that folder
 * and the project lies outside it. Measured on 2026-09-26, `docs/engines/codex.md`. The card folder
 * is the working folder, so it is not added a second time, and the checkout is not added at all,
 * which is what keeps the project unwritable.
 */
it('starts a read-only phase in the card folder with the project outside it', () => {
  const list = args({ cwd: '/projects/recipes/.tasks/APP-1' }, false);
  expect(list).toEqual([
    'exec',
    '--json',
    '--ignore-user-config',
    '-m',
    'gpt-5.6-sol',
    '-c',
    'model_reasoning_effort=xhigh',
    '-s',
    'workspace-write',
    '-C',
    '/projects/recipes/.tasks/APP-1',
    '-',
  ]);
  expect(list).not.toContain('--add-dir');
  expect(list.join(' ')).not.toContain('/projects/recipes/worktrees/APP-1');
});

// A phase that may write gets the card folder as well, because it lies outside the checkout and
// the sandbox allows the workspace alone.
it('gives a writing phase the workspace and the card folder', () => {
  const list = args({ phase: 'implement' }, false);
  expect(list).toContain('workspace-write');
  expect(list.join(' ')).toContain('--add-dir /projects/recipes/.tasks/APP-1');
  expect(list).not.toContain('read-only');
});

// Measured on 2026-09-25: `codex exec resume -s read-only` answers "unexpected argument '-s'
// found" and stops. One argument list for both paths is the bug this shape exists to avoid.
it('continues a session without the flags the resume subcommand refuses', () => {
  // The whole list, not a few of its parts. A resume that lost `--json` would print prose, the
  // parser would read no event out of it, and every answer to a blocked card would be reported as
  // a failed run. `codex exec resume --help` on 0.145.0 takes all four of these.
  expect(args({ phase: 'extract-summary', resumeFrom: '01a0d87e-8520-7973-a8f2-6237813635d5' })).toEqual([
    'exec',
    'resume',
    '--json',
    '--ignore-user-config',
    '-m',
    'gpt-5.6-sol',
    '-c',
    'model_reasoning_effort=xhigh',
    // The sandbox rides in a config override instead of `-s`, and its value is TOML, so the quotes
    // are part of the argument.
    '-c',
    'sandbox_mode="read-only"',
    // The session id comes before the prompt, which is the order the subcommand reads them in.
    '01a0d87e-8520-7973-a8f2-6237813635d5',
    '-',
  ]);
});

it('gives a resumed writing phase the card folder through the config too', () => {
  const list = args({ phase: 'implement', resumeFrom: '01a0d87e-8520-7973-a8f2-6237813635d5' }, false);
  // The shared flags are on this branch as well, which the read-only resume proves one by one.
  expect(list.slice(0, 8)).toEqual(['exec', 'resume', '--json', '--ignore-user-config', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=xhigh']);
  expect(list).toContain('sandbox_mode="workspace-write"');
  expect(list).toContain('sandbox_workspace_write.writable_roots=["/projects/recipes/.tasks/APP-1"]');
  expect(list).not.toContain('--add-dir');
});

// A resume takes no `-C`, so the working folder is the one the process starts in, and the spawn
// starts it in the card folder for this phase. Nothing is added as a writable root, because the
// working folder already is one, and adding the checkout would open the project.
it('resumes a read-only phase with the card folder as the whole writable area', () => {
  const list = args({ cwd: '/projects/recipes/.tasks/APP-1', resumeFrom: '01a0d87e-8520-7973-a8f2-6237813635d5' }, false);
  expect(list).toContain('sandbox_mode="workspace-write"');
  expect(list.join(' ')).not.toContain('writable_roots');
  expect(list.join(' ')).not.toContain('/projects/recipes/worktrees/APP-1');
});

// A project folder that is not a git repository holds plain folders, and `codex exec` refuses to
// start outside a repository without this flag. `codex exec --help` and `codex exec resume --help`
// on 0.145.0 both take it.
it('passes the flag that allows a folder outside git once, on exec and on a resume', () => {
  const skip = (list: string[]) => list.filter((one) => one === '--skip-git-repo-check').length;
  const fresh = args({ outsideGit: true });
  const resumed = args({ outsideGit: true, resumeFrom: '01a0d87e-8520-7973-a8f2-6237813635d5' });
  expect(skip(fresh)).toBe(1);
  expect(skip(resumed)).toBe(1);
  expect(skip(args({ phase: 'implement', outsideGit: true }, false))).toBe(1);
  expect(skip(args({ phase: 'implement', outsideGit: true, resumeFrom: 'a1' }, false))).toBe(1);
  // The rest of each list is the list it always was.
  expect(fresh.filter((one) => one !== '--skip-git-repo-check')).toEqual(args());
  expect(resumed.filter((one) => one !== '--skip-git-repo-check')).toEqual(args({ resumeFrom: '01a0d87e-8520-7973-a8f2-6237813635d5' }));
  expect(fresh.at(-1)).toBe('-');
  expect(resumed.slice(-2)).toEqual(['01a0d87e-8520-7973-a8f2-6237813635d5', '-']);
});

it('leaves the flag out of a project whose folder is a repository', () => {
  for (const list of [args(), args({ resumeFrom: 'a1' }), args({ phase: 'implement' }, false)]) {
    expect(list).not.toContain('--skip-git-repo-check');
  }
});

it('keeps the prompt out of the arguments', () => {
  // A process listing is readable by anybody on the machine, and the prompt carries the ticket.
  for (const list of [args(), args({ resumeFrom: 'a1' })]) {
    expect(list.join(' ')).not.toContain('Refine the ticket');
    expect(list.at(-1)).toBe('-');
  }
});

it('refuses an effort the chosen model does not take', () => {
  // `gpt-5.5` has no ultra level, and the three words of the other engine are not this engine's.
  expect(() => codexArgs(job({ effort: 'ultra' }), { levels: ['low', 'medium', 'high', 'xhigh'], readOnly: true })).toThrow(/ultra/);
  expect(() => codexArgs(job({ effort: 'ultra' }), { levels: ['low', 'medium', 'high', 'xhigh'], readOnly: true })).toThrow(/low, medium, high, xhigh/);
});

it('takes a level the other engine does not have', () => {
  expect(codexArgs(job({ effort: 'ultra' }), { levels: LEVELS, readOnly: true })).toContain('model_reasoning_effort=ultra');
});

it('refuses a model the list gives no effort levels for', () => {
  // An empty level list is a model the list does not hold, or one that names no levels. Neither is
  // a free pass, and the sentence names the model without guessing which of the two it is.
  expect(() => codexArgs(job({ model: 'gpt-4' }), { levels: [], readOnly: true })).toThrow(/no effort levels for "gpt-4"/);
});

it('refuses a job that sets a session and a resume together', () => {
  expect(() => args({ sessionId: 'a', resumeFrom: 'b' })).toThrow(/never both/);
});

it('refuses a name that would be read as a flag', () => {
  expect(() => args({ model: '-m' })).toThrow(/flag/);
  expect(() => args({ resumeFrom: '--help' })).toThrow(/flag/);
  expect(() => args({ model: 'gpt 5' })).toThrow(/whitespace/);
});

/**
 * Codex inside Nolzu's wall, which is the shape while the Codex row of `ENGINE_WALLS` says
 * `ownSandbox: false`. Exactly one wall per run, so Codex's own sandbox is off on both paths, through
 * the config override the resume takes as well, and nothing asks for an approval a headless run
 * cannot give. The wall holds the card folder and the knowledge folder, so neither is named here.
 */
describe('inside the wall', () => {
  const walled = (over: Partial<Job> = {}, readOnly = false) => codexArgs(job(over), { levels: LEVELS, readOnly, ownSandbox: false, knowledgeDir: '/projects/recipes/knowledge' });
  const OFF = ['-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"'];

  it('starts a read-only phase in the checkout with its own sandbox off', () => {
    expect(walled({}, true)).toEqual(['exec', '--json', '--ignore-user-config', '-m', 'gpt-5.6-sol', '-c', 'model_reasoning_effort=xhigh', ...OFF, '-C', '/projects/recipes/worktrees/APP-1', '-']);
  });

  it('resumes with its own sandbox off and no flag the resume refuses', () => {
    expect(walled({ resumeFrom: '01a0d87e-8520-7973-a8f2-6237813635d5' })).toEqual([
      'exec',
      'resume',
      '--json',
      '--ignore-user-config',
      '-m',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=xhigh',
      ...OFF,
      '01a0d87e-8520-7973-a8f2-6237813635d5',
      '-',
    ]);
  });

  it.each(['refine', 'implement', 'wrapup', 'extract-summary'])('names no sandbox flag, writable root or added folder for %s', (phase) => {
    for (const list of [walled({ phase }), walled({ phase, resumeFrom: 'a1' })]) {
      const text = list.join(' ');
      expect(list).not.toContain('-s');
      expect(list).not.toContain('--add-dir');
      expect(text).not.toContain('writable_roots');
      expect(text).not.toContain('workspace-write');
      expect(text).not.toContain('"read-only"');
    }
  });
});

// Codex's own sandbox, the shape the switch keeps for when the wall measurements move the secret
// denial into a permission profile. The wrap-up and optimize start in the card folder like refine,
// and the knowledge folder is the one more writable root.
describe('under its own sandbox', () => {
  const own = (over: Partial<Job> = {}) => codexArgs(job({ cwd: '/projects/recipes/.tasks/APP-1', ...over }), { levels: LEVELS, readOnly: false, ownSandbox: true, knowledgeDir: '/projects/recipes/knowledge' });

  it('adds the knowledge folder as a writable root on exec', () => {
    const list = own({ phase: 'wrapup' });
    expect(list).toContain('workspace-write');
    expect(list.join(' ')).toContain('-c sandbox_workspace_write.writable_roots=["/projects/recipes/knowledge"]');
    expect(list).not.toContain('--add-dir');
    expect(list.join(' ')).not.toContain('danger-full-access');
  });

  it('adds the knowledge folder beside the card folder on a resume', () => {
    const list = own({ phase: 'wrapup', cwd: '/projects/recipes/worktrees/APP-1', resumeFrom: 'a1' });
    expect(list).toContain('sandbox_workspace_write.writable_roots=["/projects/recipes/.tasks/APP-1","/projects/recipes/knowledge"]');
  });

  it('opens the package caches as a writable root, on a fresh run and a resume, and never under read-only', () => {
    const caches = '/home/me/.nolzu/caches';
    const fresh = codexArgs(job({ phase: 'implement' }), { levels: LEVELS, readOnly: false, ownSandbox: true, cachesDir: caches });
    expect(fresh).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify([caches])}`);
    const resumed = codexArgs(job({ phase: 'implement', resumeFrom: 'a1' }), { levels: LEVELS, readOnly: false, ownSandbox: true, cachesDir: caches });
    expect(resumed.join(' ')).toContain(caches);
    expect(codexArgs(job({ phase: 'summary' }), { levels: LEVELS, readOnly: true, ownSandbox: true, cachesDir: caches }).join(' ')).not.toContain(caches);
  });

  it('keeps every list of today when no knowledge folder is named', () => {
    const today = codexArgs(job({ phase: 'implement' }), { levels: LEVELS, readOnly: false });
    expect(codexArgs(job({ phase: 'implement' }), { levels: LEVELS, readOnly: false, ownSandbox: true, knowledgeDir: null })).toEqual(today);
  });
});

const rule = { tools: [], secretEnv: [], secretHeaders: [], cwd: null };
const mcpOf = (stdio: Record<string, { command: string; args: string[]; env: Record<string, string> }>) => ({ stdio, remote: {}, rules: Object.fromEntries(Object.keys(stdio).map((name) => [name, rule])), dir: '/tmp/mcp-runs/1' });

describe("QA's browser", () => {
  const playwright = { playwright: { command: 'npx', args: ['@playwright/mcp@latest', '--no-sandbox'], env: { HOME: '/tmp/nolzu "home"' } } };

  it('passes each server as -c overrides, on a fresh run and on a resume', () => {
    const want = [
      '-c',
      'mcp_servers.playwright.command="npx"',
      '-c',
      'mcp_servers.playwright.args=["@playwright/mcp@latest", "--no-sandbox"]',
      '-c',
      'mcp_servers.playwright.env={ "HOME" = "/tmp/nolzu \\"home\\"" }',
      '-c',
      'mcp_servers.playwright.startup_timeout_sec=120',
    ];
    for (const resumeFrom of [null, 'session-1']) {
      const got = codexArgs(job({ phase: 'qa', resumeFrom, mcp: mcpOf(playwright) }), { levels: LEVELS, readOnly: true });
      const at = got.indexOf('mcp_servers.playwright.command="npx"') - 1;
      expect(got.slice(at, at + want.length)).toEqual(want);
    }
  });

  it('adds nothing without a server, and leaves out env when it has none', () => {
    expect(args().join(' ')).not.toContain('mcp_servers');
    const got = codexArgs(job({ mcp: mcpOf({ b: { command: 'b', args: [], env: {} } }) }), { levels: LEVELS, readOnly: true });
    expect(got).toContain('mcp_servers.b.args=[]');
    expect(got.join(' ')).not.toContain('mcp_servers.b.env');
  });
});

describe('the servers of any phase', () => {
  const servers = { db: { command: 'db-mcp', args: [], env: { DB_LOGIN: 'hunter2', LEVEL: '1' } } };
  const remotes = {
    docs: { url: 'https://mcp.example.com/mcp', transport: 'http' as const, headers: { 'X-Login': 'Bearer abc', 'X-Team': 'web' } },
    feed: { url: 'https://feed.example.com/sse', transport: 'sse' as const, headers: {} },
  };
  const mcpRules = {
    db: { tools: ['query'], secretEnv: ['DB_LOGIN'], secretHeaders: [], cwd: '/work/tools' },
    docs: { tools: [], secretEnv: [], secretHeaders: ['X-Login'], cwd: null },
  };

  it('keeps every secret off the command line and hands it over in the environment', () => {
    const { args: got, env } = codexMcp(servers, remotes, mcpRules);
    const line = got.join(' ');
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('Bearer abc');
    expect(got).toEqual([
      '-c',
      'mcp_servers.db.command="db-mcp"',
      '-c',
      'mcp_servers.db.args=[]',
      '-c',
      'mcp_servers.db.env={ "LEVEL" = "1" }',
      '-c',
      'mcp_servers.db.env_vars=["DB_LOGIN"]',
      '-c',
      'mcp_servers.db.cwd="/work/tools"',
      '-c',
      'mcp_servers.db.enabled_tools=["query"]',
      '-c',
      'mcp_servers.db.startup_timeout_sec=120',
      '-c',
      'mcp_servers.docs.url="https://mcp.example.com/mcp"',
      '-c',
      'mcp_servers.docs.http_headers={ "X-Team" = "web" }',
      '-c',
      'mcp_servers.docs.env_http_headers={ "X-Login" = "NOLZU_MCP_HEADER_1" }',
      '-c',
      'mcp_servers.docs.startup_timeout_sec=120',
      // Out of the agent's shell, since Codex keeps a name with KEY, SECRET or TOKEN by default.
      '-c',
      'shell_environment_policy.exclude=["DB_LOGIN", "NOLZU_MCP_HEADER_1"]',
    ]);
    expect(env).toEqual({ DB_LOGIN: 'hunter2', NOLZU_MCP_HEADER_1: 'Bearer abc' });
    // The SSE server is not there at all: Codex speaks streamable HTTP only.
    expect(line).not.toContain('feed');
  });

  it("passes the job's rules on every run, and never loads the person's own config.toml", () => {
    for (const resumeFrom of [null, 'session-1']) {
      for (const ownSandbox of [true, false]) {
        const got = codexArgs(job({ phase: 'plan', resumeFrom, mcp: { stdio: servers, remote: remotes, rules: mcpRules, dir: '/tmp/mcp-runs/1' } }), { levels: LEVELS, readOnly: true, ownSandbox });
        // Without it the servers of ~/.codex/config.toml would start too.
        expect(got).toContain('--ignore-user-config');
        expect(got).toContain('mcp_servers.db.enabled_tools=["query"]');
        expect(got.join(' ')).not.toContain('hunter2');
      }
    }
    expect(args()).toContain('--ignore-user-config');
  });
});
