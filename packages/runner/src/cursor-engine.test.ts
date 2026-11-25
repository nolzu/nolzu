import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineProfile, Job, RunEvent } from '@nolzu/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { stubBinary, type StubBinary } from '../test/stub-binary.ts';
import { cursorEngine } from './cursor-engine.ts';
import { selectEngine } from './select.ts';

// The wall needs bubblewrap on Linux, which CI lacks, so the engine starts as it came here.
// spawn-wall.test.ts runs the real wall and the doubles.
// What the wall probe answers. A test of a machine with no wall sets a reason.
const probe = vi.hoisted(() => ({ missing: null as string | null }));
vi.mock('./wall-detect.ts', async (actual) => ({
  ...(await actual<typeof import('./wall-detect.ts')>()),
  walledCommand: (_spec: unknown, command: string, args: readonly string[]) => ({ command, args: [...args] }),
  wallHere: () => (probe.missing === null ? { ready: true, binary: '/usr/bin/sandbox-exec' } : { ready: false, reason: probe.missing }),
}));

// The list the stub answers `--list-models` with, in the shape the binary prints.
const MODELS = '\u001B[2mAvailable models\u001B[22m\n\u001B[36mauto\u001B[39m \u001B[2m- Auto\u001B[22m\n\u001B[36mgpt-5.3-codex\u001B[39m \u001B[2m- Codex 5.3\u001B[22m\n';

let stub: StubBinary | null = null;
let cwd = '';

afterEach(() => {
  probe.missing = null;
  stub?.remove();
  stub = null;
  if (cwd !== '') rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  cwd = '';
});

// A real process, so the pipes, the stdin and the exit code are the real ones and no test ever
// reaches the vendor binary or the network.
function makeStub(run: string): string {
  stub = stubBinary(
    `
    const args = process.argv.slice(2);
    if (args[0] === '--list-models') {
      process.stdout.write(${JSON.stringify(MODELS)});
      process.exit(0);
    }
    require('node:fs').writeFileSync(process.env.NOLZU_TEST_ARGS, JSON.stringify(args));
    ${run}
  `,
    'cursor-stub',
  );
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-cursor-'));
  return stub.path;
}

const job = (over: Partial<Job> = {}): Job =>
  ({
    runId: 1,
    cardKey: 'APP-1',
    engine: 'cursor',
    phase: 'implement',
    cwd,
    taskDir: join(cwd, '.tasks', 'APP-1'),
    prompt: 'Build the ticket.',
    model: 'gpt-5.3-codex',
    effort: 'medium',
    sessionId: null,
    resumeFrom: null,
    timeoutMs: 30 * 60 * 1000,
    logPath: join(cwd, 'run.ndjson'),
    lane: null,
    mcpConfigPath: null,
    settingsPath: null,
    tools: ['Read', 'Grep'],
    ...over,
  }) as Job;

async function run(binary: string, over: Partial<Job> = {}, profiles: readonly EngineProfile[] = [], env: Record<string, string> = {}): Promise<RunEvent[]> {
  const engine = cursorEngine(binary, { ...process.env, ...env, NOLZU_TEST_ARGS: join(cwd, 'args.json') }, profiles);
  const events: RunEvent[] = [];
  for await (const line of engine.spawn(job(over), new AbortController().signal)) events.push(...engine.parse(line));
  return events;
}

const readArgs = (suffix = ''): string => readFileSync(join(cwd, `args.json${suffix}`), 'utf8');

const TURN = `
  process.stdout.write('{"type":"system","subtype":"init","apiKeySource":"login","session_id":"a2e5f188","model":"Codex 5.3","permissionMode":"default"}\\n');
  process.stdout.write('{"type":"result","subtype":"success","duration_ms":9476,"is_error":false,"result":"done","usage":{"inputTokens":12,"outputTokens":3}}\\n');
`;

it('reads a run from the first line to its end', async () => {
  const binary = makeStub(`${TURN}process.exit(0);`);
  expect(await run(binary)).toEqual([
    { type: 'session', sessionId: 'a2e5f188', model: 'Codex 5.3', apiKeyMode: false },
    { type: 'complete', costUsd: null, durationMs: 9476, tokens: { input: 12, output: 3, cacheRead: 0, cacheCreation: 0 } },
  ]);
});

// The prompt goes on stdin, so it never shows in a process listing, and closing stdin is what tells
// the engine the prompt is complete.
it('gives the prompt on stdin and closes it', async () => {
  const binary = makeStub(`
    let seen = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { seen += chunk; });
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: seen }] } }) + '\\n');
      process.exit(0);
    });
  `);
  expect(await run(binary)).toEqual([{ type: 'text', text: 'Build the ticket.' }]);
});

it('runs the phase that changes the project in a folder it trusts, with a shell', async () => {
  const binary = makeStub(`${TURN}process.exit(0);`);
  await run(binary);
  expect((JSON.parse(readArgs()) as string[]).join(' ')).toContain('--trust --force --sandbox disabled --model gpt-5.3-codex');
});

// Measured on 2026-09-25: a run in plan mode can write, so only Nolzu's wall holds a read-only
// phase. Where the wall cannot start, the phase is refused before the process starts, and the
// sentence names the check that failed.
it.each(['refine', 'plan', 'qa', 'wrapup', 'optimize', 'extract-summary'])('refuses the %s phase where the wall cannot start', async (phase) => {
  probe.missing = 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.';
  const binary = makeStub(`${TURN}process.exit(0);`);
  await expect(run(binary, { phase })).rejects.toThrow(/may not change the project.*only Nolzu's wall holds Cursor to reading.*Install the bubblewrap package.*Claude Code profile/s);
});

// Inside the wall the same phases run.
it.each(['refine', 'plan', 'qa', 'wrapup', 'optimize', 'extract-summary'])('runs the %s phase inside the wall', async (phase) => {
  const binary = makeStub(`${TURN}process.exit(0);`);
  await run(binary, { phase });
  expect(existsSync(join(cwd, 'args.json'))).toBe(true);
});

// The refusal happens before anything is started, so a refused phase spends nothing and leaves no
// process behind.
it('starts no process for a phase it refuses', async () => {
  probe.missing = 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.';
  const binary = makeStub(`${TURN}process.exit(0);`);
  await expect(run(binary, { phase: 'qa' })).rejects.toThrow();
  expect(existsSync(join(cwd, 'args.json'))).toBe(false);
});

// Implement still runs without the wall, under the engine's own sandbox, and the log says the run
// was not walled.
it('runs implement without the wall', async () => {
  probe.missing = 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.';
  const binary = makeStub(`${TURN}process.exit(0);`);
  await run(binary);
  expect(JSON.parse(readArgs()) as string[]).not.toContain('--sandbox');
});

// A run that is already stopped must not reach the model list, which is a network call, nor make a
// card folder. The binary is not there, so a run that got that far would throw instead.
it('does nothing for a signal that is already aborted', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-cursor-'));
  const controller = new AbortController();
  controller.abort();
  const engine = cursorEngine(join(cwd, 'no-such-cursor'), process.env, []);
  const lines: string[] = [];
  for await (const line of engine.spawn(job(), controller.signal)) lines.push(line);
  expect(lines).toEqual([]);
});

// A free plan refuses every named model, after two stream lines nobody reads. Nolzu never asks for
// auto, so no card can run on such a login, and the run says that rather than an error class.
it('names the free plan when it refuses the model', async () => {
  const binary = makeStub(`
    process.stdout.write('{"type":"system","subtype":"init","session_id":"8d2d","model":"Claude Opus 5.5","permissionMode":"default"}\\n');
    process.stderr.write('ActionRequiredError: Named models unavailable Free plans can only use Auto. Switch to Auto or upgrade plans to continue.\\n');
    process.exit(1);
  `);
  await expect(run(binary)).rejects.toThrow(/free plan, which runs the Auto model only/);
});

// Every other failure keeps the engine's own words.
it('fails a run whose process stopped with a code, and says what it said', async () => {
  const binary = makeStub(`
    process.stderr.write('stream error: unexpected status 500\\n');
    process.exit(1);
  `);
  await expect(run(binary)).rejects.toThrow(/Cursor CLI engine stopped with exit code 1.*unexpected status 500/s);
});

// A binary that is not there answers no model list either, and "this model is not in the list" is
// the wrong thing to tell somebody who has not installed the engine.
it('says the engine is missing rather than blaming the model', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-cursor-'));
  await expect(run(join(cwd, 'no-such-cursor'))).rejects.toThrow(/Install Cursor CLI/);
});

it('refuses a run that names another vendor’s login', () => {
  const binary = makeStub('process.exit(0);');
  const profiles = [{ id: 'codex', label: 'Codex', vendor: 'codex', configDir: null } as EngineProfile];
  expect(() => cursorEngine(binary, process.env, profiles).spawn(job({ engine: 'codex' }), new AbortController().signal)).toThrow(/codex login/);
});

it('sets the login folder of the profile the run belongs to, and drops the key that would outrank it', async () => {
  const binary = makeStub(`
    const said = [process.env.CURSOR_CONFIG_DIR, process.env.CURSOR_API_KEY, process.env.CURSOR_API_ENDPOINT, process.env.NOLZU_READ_ONLY];
    require('node:fs').writeFileSync(process.env.NOLZU_TEST_ARGS + '.env', said.map(String).join(' '));
    ${TURN}
    process.exit(0);
  `);
  const home = join(cwd, 'work-login');
  const profiles = [{ id: 'cursor#work', label: 'Work', vendor: 'cursor', configDir: home } as EngineProfile];
  // A key in the person's own shell replaces the login, and an endpoint sends the run elsewhere, so
  // the run would not be the run the card describes. The read-only pair belongs to a Claude Code
  // hook, and setting it here would say a limit is in force with nothing enforcing it.
  await run(binary, { engine: 'cursor#work' }, profiles, { CURSOR_API_KEY: 'key', CURSOR_API_ENDPOINT: 'https://example.invalid' });
  expect(readArgs('.env')).toBe(`${home} undefined undefined undefined`);
});

// The engine's name says nothing about the binary it spawns. With that map wrong, choosing Cursor
// would start another engine with Cursor arguments, so it is asked to start with nothing on its
// PATH and it names the binary it looked for.
it('looks Cursor up as cursor-agent', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-cursor-'));
  const empty = mkdtempSync(join(tmpdir(), 'nolzu-empty-path-'));
  try {
    const engine = selectEngine({}, { engine: 'cursor', path: () => empty });
    expect(engine.vendor).toBe('cursor');
    await expect(engine.spawn(job(), new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow(/engine at cursor-agent did not answer/);
  } finally {
    rmSync(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
