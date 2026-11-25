import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Job, RunEvent } from '@nolzu/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claudeModels } from './models.ts';
import { selectEngine } from './select.ts';

// The wall needs bubblewrap on Linux, which CI lacks, so the engine starts as it came here.
// spawn-wall.test.ts runs the real wall and the doubles.
vi.mock('./wall-detect.ts', async (actual) => ({
  ...(await actual<typeof import('./wall-detect.ts')>()),
  walledCommand: (_spec: unknown, command: string, args: readonly string[]) => ({ command, args: [...args] }),
  // The probe answers ready, so the run takes the walled path on every machine.
  wallHere: () => ({ ready: true, binary: '/usr/bin/sandbox-exec' }),
}));

let bin = '';
let cwd = '';
// The stand-in is a node script, so the PATH it runs with has to hold node as well.
const node = dirname(process.execPath);

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'nolzu-bin-'));
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-cwd-'));
});

afterEach(() => {
  rmSync(bin, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// A stand-in named `claude`, found the way the real one is: on the PATH the login shell reports.
function installClaude(body: string): void {
  const path = join(bin, 'claude');
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
}

const job = (): Job => ({
  runId: 1,
  cardKey: 'APP-1',
  engine: 'claude-code',
  phase: 'refine',
  cwd,
  taskDir: join(cwd, '.tasks', 'APP-1'),
  prompt: 'Refine the ticket.',
  model: 'haiku',
  effort: 'low',
  sessionId: null,
  resumeFrom: null,
  timeoutMs: 60_000,
  logPath: join(cwd, 'log.ndjson'),
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read'],
});

const RESULT = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, duration_ms: 10, usage: {} });

async function run(env: Record<string, string>, options: Parameters<typeof selectEngine>[1]): Promise<{ lines: string[]; events: RunEvent[] }> {
  const engine = selectEngine(env, options);
  const lines: string[] = [];
  const events: RunEvent[] = [];
  for await (const line of engine.spawn(job(), new AbortController().signal)) {
    lines.push(line);
    events.push(...engine.parse(line));
  }
  return { lines, events };
}

it('returns the Claude engine outside fake mode, named the way a profile names its vendor', () => {
  const engine = selectEngine({}, { path: () => bin });

  expect(engine.name).toBe('claude-code');
  expect(engine.listModels()).toEqual(claudeModels());
});

it('runs the claude it finds on the login shell PATH, with the isolation flags, and parses what it prints', async () => {
  installClaude(`
    process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + String.fromCharCode(10));
    process.stdout.write(${JSON.stringify(RESULT)} + String.fromCharCode(10));
  `);

  const { lines, events } = await run({}, { path: () => `${bin}:${node}` });

  const argv = (JSON.parse(lines[0] ?? '{}') as { argv: string[] }).argv;
  expect(argv).toContain('--strict-mcp-config');
  expect(argv[argv.indexOf('--model') + 1]).toBe('haiku');
  expect(events.at(-1)?.type).toBe('complete');
});

// The question a run ends with blocks the card, so the engine has to turn it into its own event.
it('turns a question the run ends with into its own event', async () => {
  const asks = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'NOLZU: needs_input: Which index name?' }] } });
  installClaude(`process.stdout.write(${JSON.stringify(asks)} + String.fromCharCode(10) + ${JSON.stringify(RESULT)} + String.fromCharCode(10));`);

  const { events } = await run({}, { path: () => `${bin}:${node}` });

  expect(events.map((event) => event.type)).toEqual(['text', 'needs_input', 'complete']);
});

// A process started outside a login shell misses the PATH of the person's shell profile, so the tools
// an agent runs, node and git among them, would go missing inside the run.
it('hands the login shell PATH on to the engine', async () => {
  installClaude(`process.stdout.write(JSON.stringify({ path: process.env.PATH }) + String.fromCharCode(10));`);

  const { lines } = await run({ PATH: '/usr/bin' }, { path: () => `${bin}:${node}:/opt/tools/bin` });

  expect((JSON.parse(lines[0] ?? '{}') as { path: string }).path).toBe(`${bin}:${node}:/opt/tools/bin`);
});

// A missing engine is a run that fails with a reason the person can act on, and not an app that
// cannot start, which would take every board with it.
it('fails the run with an install hint when claude is not on the PATH', async () => {
  await expect(run({ PATH: bin }, { path: () => bin })).rejects.toThrow(/Install Claude Code/);
});

it('refuses an engine it does not know, and names the setting and the engines it knows', () => {
  // Gemini CLI stopped serving these subscriptions in June 2026 and is not an engine here, so its
  // name is one this version cannot run.
  expect(() => selectEngine({}, { engine: 'gemini-cli', path: () => bin })).toThrow(/cannot run "gemini-cli".*claude-code, cursor, codex\.$/s);
});

// A leftover setting must never start a real run inside a test or a demo.
it('lets fake mode win over the profile\'s vendor', () => {
  expect(selectEngine({ NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' }, { engine: 'codex' }).name).toBe('fake');
});
