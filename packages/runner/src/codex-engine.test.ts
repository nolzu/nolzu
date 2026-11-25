import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EngineProfile, Job, RunEvent } from '@nolzu/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import { stubBinary, type StubBinary } from '../test/stub-binary.ts';
import { codexEngine } from './codex-engine.ts';
import { codexModelList } from './codex-models.ts';
import type { Engine } from './engine.ts';
import { selectEngine } from './select.ts';

// What the wall probe answers. Left alone it is the real probe; a test of a machine with no wall
// sets a reason.
const probe = vi.hoisted(() => ({ missing: null as string | null }));
vi.mock('./wall-detect.ts', async (actual) => {
  const real = await actual<typeof import('./wall-detect.ts')>();
  return { ...real, wallHere: () => (probe.missing === null ? real.wallHere() : { ready: false, reason: probe.missing }) };
});
const NO_BWRAP = 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.';

// A stub that answers the model list, so the argument builder knows the levels, and then plays the
// lines the test asks for. Spawning a real process is what proves the stdin, the pipes and the
// exit code, rather than a mock of them.
const MODELS = JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }], visibility: 'list' }] });

let stub: StubBinary | null = null;
let cwd = '';

afterEach(() => {
  probe.missing = null;
  stub?.remove();
  stub = null;
  if (cwd !== '') rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  cwd = '';
});

function makeStub(run: string): string {
  stub = stubBinary(
    `
    const args = process.argv.slice(2);
    require('node:fs').writeFileSync(process.env.NOLZU_TEST_ARGS, JSON.stringify(args));
    ${run}
  `,
    'codex-stub',
  );
  // A shell answers the model list and hands every other call to the Node script.
  renameSync(stub.path, `${stub.path}.js`);
  writeFileSync(stub.path, `#!/bin/sh\nif [ "$1" = debug ]; then printf '%s' '${MODELS}'; exit 0; fi\nexec node "$0.js" "$@"\n`);
  chmodSync(stub.path, 0o755);
  // Read once here with a test's wait, and kept: a stub written a moment before can take longer than
  // the product's five seconds to start on a busy machine, which an installed binary never does.
  codexModelList(stub.path, process.env, 30_000);
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-codex-'));
  return stub.path;
}

const job = (over: Partial<Job> = {}): Job => ({
  runId: 1,
  cardKey: 'APP-1',
  engine: 'codex',
  // implement, because it is the one phase this version runs on Codex: every other one may not
  // change the project, and the Codex sandbox refuses such a run its own notes as well.
  phase: 'implement',
  cwd,
  taskDir: join(cwd, '.tasks', 'APP-1'),
  prompt: 'Refine the ticket.',
  model: 'gpt-5.6-sol',
  effort: 'xhigh',
  sessionId: null,
  resumeFrom: null,
  timeoutMs: 30 * 60 * 1000,
  logPath: join(cwd, 'run.ndjson'),
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read', 'Grep'],
  ...over,
});

async function run(binary: string, over: Partial<Job> = {}, profiles: readonly EngineProfile[] = []): Promise<RunEvent[]> {
  const engine = codexEngine(binary, { ...process.env, NOLZU_TEST_ARGS: join(cwd, 'args.json') }, profiles);
  const events: RunEvent[] = [];
  for await (const line of engine.spawn(job(over), new AbortController().signal)) events.push(...engine.parse(line));
  return events;
}

const TURN = `
  process.stdout.write('{"type":"thread.started","thread_id":"01a0d87e"}\\n');
  process.stdout.write('{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":3}}\\n');
`;

it('reads a run from the first line to its end', async () => {
  const binary = makeStub(`${TURN}process.exit(0);`);
  expect(await run(binary)).toEqual([
    { type: 'session', sessionId: '01a0d87e', model: null, apiKeyMode: null },
    { type: 'complete', costUsd: null, durationMs: null, tokens: { input: 12, output: 3, cacheRead: 0, cacheCreation: 0 } },
  ]);
});

// Measured on 2026-09-25: a run whose stdin stays open prints "Reading additional input from
// stdin..." and waits for ever. The prompt is written and stdin is closed, which is what ends it.
it('gives the prompt on stdin and closes it', async () => {
  const binary = makeStub(`
    let seen = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { seen += chunk; });
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: seen } }) + '\\n');
      process.exit(0);
    });
  `);
  expect(await run(binary)).toEqual([{ type: 'text', text: 'Refine the ticket.' }]);
});

// A Codex run can print an ERROR about its own models cache, and two of the four recorded runs did.
// An adapter that read any stderr ERROR as a failure would fail those runs.
it('lets a run that printed the engine’s own noise finish', async () => {
  const binary = makeStub(`
    process.stderr.write('ERROR codex_models_manager::cache: failed to load models cache: missing field \`base_instructions\`\\n');
    ${TURN}
    process.exit(0);
  `);
  expect((await run(binary)).map((event) => event.type)).toEqual(['session', 'complete']);
});

// The sandbox refuses the write, the process still exits 0, and the refusal is only on stderr. A
// run that was refused a write has still done its work, so it is named and not failed.
it('names a write the sandbox refused, and still finishes the run', async () => {
  const binary = makeStub(`
    ${TURN}
    process.stderr.write('ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings\\n');
    process.exit(0);
  `);
  const events = await run(binary);
  expect(events.map((event) => event.type)).toEqual(['session', 'complete', 'permission_denied']);
  expect(events.at(-1)).toEqual({ type: 'permission_denied', denied: [{ tool: 'patch', id: null, path: null }] });
});

it('fails a run whose process stopped with a code, and says what it said', async () => {
  const binary = makeStub(`
    process.stderr.write('stream error: unexpected status 500\\n');
    process.exit(1);
  `);
  await expect(run(binary)).rejects.toThrow(/Codex CLI engine stopped with exit code 1.*unexpected status 500/s);
});

// A binary that is not there answers no model list either, and "this model is not in the list" is
// the wrong thing to tell somebody who has not installed the engine.
it('says the engine is missing rather than blaming the model', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-codex-'));
  await expect(run(join(cwd, 'no-such-codex'))).rejects.toThrow(/Install Codex CLI/);
});

// Codex runs inside Nolzu's wall with its own sandbox off, because one sandbox cannot start inside
// another. The wall makes the card folder writable, so it is not named to the engine.
it('starts implement in the checkout with its own sandbox off', async () => {
  const binary = makeStub(`${TURN}process.exit(0);`);
  await run(binary);
  const args = JSON.parse(readArgs()) as string[];
  expect(args.join(' ')).toContain('-c sandbox_mode="danger-full-access" -c approval_policy="never"');
  expect(args.join(' ')).toContain(`-C ${cwd}`);
  expect(args).not.toContain('--add-dir');
  expect(args).toContain('gpt-5.6-sol');
});

// Where the wall cannot start, Codex falls back to its own sandbox and still runs QA. The run starts
// in its throwaway copy, which the sandbox lets the project's checks write, and the card folder is
// added for the report. The real checkout lies outside both.
it('runs QA on its copy under its own sandbox where the wall cannot start', async () => {
  probe.missing = NO_BWRAP;
  const binary = makeStub(`${TURN}process.exit(0);`);
  const copy = join(cwd, 'copy');
  mkdirSync(copy);
  await run(binary, { phase: 'qa', qaCopy: copy, tools: ['Read', 'Grep', 'Glob', 'Write', 'Bash'] });
  const said = (JSON.parse(readArgs()) as string[]).join(' ');
  expect(said).toContain('-s workspace-write');
  expect(said).toContain(`-C ${copy}`);
  expect(said).toContain(`--add-dir ${realpathSync(join(cwd, '.tasks', 'APP-1'))}`);
  expect(said).not.toContain('danger-full-access');
});

// The wrap-up and optimize start in the card folder, and the knowledge folder is the one more
// writable root.
it.each(['wrapup', 'optimize'])('runs %s under its own sandbox with the knowledge folder writable where the wall cannot start', async (phase) => {
  probe.missing = NO_BWRAP;
  const binary = makeStub(`${TURN}process.exit(0);`);
  const knowledgeDir = join(cwd, 'docs', 'knowledge');
  await run(binary, { phase, knowledgeDir, tools: ['Read', 'Grep', 'Glob', 'Write', 'Edit'] });
  const said = (JSON.parse(readArgs()) as string[]).join(' ');
  expect(said).toContain('-s workspace-write');
  expect(said).toContain(`sandbox_workspace_write.writable_roots=${JSON.stringify([knowledgeDir])}`);
});

it('falls back to its own sandbox and starts a read-only phase in the card folder where the wall cannot start', async () => {
  probe.missing = NO_BWRAP;
  const binary = makeStub(`require('node:fs').writeFileSync(process.env.NOLZU_TEST_ARGS + '.cwd', process.cwd());${TURN}process.exit(0);`);
  await run(binary, { phase: 'refine', tools: ['Read', 'Grep', 'Glob', 'Write'] });
  expect(readFileSync(join(cwd, 'args.json.cwd'), 'utf8')).toBe(realpathSync(join(cwd, '.tasks', 'APP-1')));
  const args = JSON.parse(readArgs()) as string[];
  expect(args.join(' ')).toContain('-s workspace-write');
  expect(args).not.toContain('sandbox_mode="danger-full-access"');
});

// The other path. Refine writes its notes and nothing else, so it runs, in the checkout like every
// other engine, and the wall holds it to the card folder.
it('starts a read-only phase in the checkout instead of refusing it', async () => {
  const binary = makeStub(`${TURN}process.exit(0);`);
  await run(binary, { phase: 'refine', tools: ['Read', 'Grep', 'Glob', 'Write'] });
  const args = JSON.parse(readArgs()) as string[];
  expect(args).toContain('sandbox_mode="danger-full-access"');
  expect(args.join(' ')).toContain(`-C ${cwd}`);
  expect(args).not.toContain('--add-dir');
});

// A run made when Codex still held a read-only phase in the card folder resumes there, because the
// paths its session wrote are read from that folder. The job builder says so on the job.
it('resumes a run that started in the card folder in the card folder', async () => {
  const binary = makeStub(`require('node:fs').writeFileSync(process.env.NOLZU_TEST_ARGS + '.cwd', process.cwd());${TURN}process.exit(0);`);
  await run(binary, { phase: 'refine', tools: ['Read', 'Grep', 'Glob', 'Write'], resumeFrom: '01a0d87e', startsInCardFolder: true });
  expect(readFileSync(join(cwd, 'args.json.cwd'), 'utf8')).toBe(realpathSync(join(cwd, '.tasks', 'APP-1')));
  const args = JSON.parse(readArgs()) as string[];
  expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
  expect(args).toContain('sandbox_mode="danger-full-access"');
});

// The summary pass writes no file at all. The wall holds it like every read-only phase.
it('runs the summary pass inside the wall with no folder added', async () => {
  const binary = makeStub(`${TURN}process.exit(0);`);
  await run(binary, { phase: 'extract-summary' });
  const args = JSON.parse(readArgs()) as string[];

  expect(args).toContain('sandbox_mode="danger-full-access"');
  expect(args).not.toContain('read-only');
  expect(args).not.toContain('--add-dir');
});

// The engine's name says nothing about the binary it spawns. With that map wrong, choosing Codex
// would start Claude Code with Codex arguments and every run would die on an unreadable error, so
// each engine is asked to start with nothing on its PATH and names the binary it looked for.
it('looks Codex up as codex, and Claude Code as claude', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-codex-'));
  const empty = mkdtempSync(join(tmpdir(), 'nolzu-empty-path-'));
  const start = (engine: Engine, over: Partial<Job> = {}) => engine.spawn(job(over), new AbortController().signal)[Symbol.asyncIterator]().next();
  try {
    await expect(start(selectEngine({}, { engine: 'codex', path: () => empty }))).rejects.toThrow(/engine at codex did not answer/);
    // Claude Code takes three effort levels and xhigh is not one of them, so its own job says medium.
    await expect(start(selectEngine({}, { engine: 'claude-code', path: () => empty }), { effort: 'medium' })).rejects.toThrow(/Claude Code engine was not found at claude/);
  } finally {
    rmSync(empty, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('refuses a run that names another vendor’s login', () => {
  const binary = makeStub('process.exit(0);');
  const profiles = [{ id: 'claude-code', label: 'Claude Code', vendor: 'claude-code', configDir: null } as EngineProfile];
  // A Codex run started under a Claude login would sign the run in as somebody else.
  expect(() => codexEngine(binary, process.env, profiles).spawn(job({ engine: 'claude-code' }), new AbortController().signal)).toThrow(/claude-code login/);
});

it('sets the login folder of the profile the run belongs to', async () => {
  const binary = makeStub(`
    require('node:fs').writeFileSync(process.env.NOLZU_TEST_ARGS + '.home', String(process.env.CODEX_HOME) + ' ' + String(process.env.NOLZU_READ_ONLY));
    ${TURN}
    process.exit(0);
  `);
  const home = join(cwd, 'work-login');
  await run(binary, { engine: 'codex#work' }, [{ id: 'codex#work', label: 'Work', vendor: 'codex', configDir: home }]);
  // The read-only pair belongs to a hook that only Claude Code loads. Set on a Codex run it would
  // say a limit is in force with nothing enforcing it, and a Claude Code the agent starts as a
  // tool would inherit the pair and be held to the card folder by a run that never asked for it.
  expect(readArgs('.home')).toBe(`${home} undefined`);
});

const readArgs = (suffix = ''): string => readFileSync(join(cwd, `args.json${suffix}`), 'utf8');

// The model list answers before the run, so a level the model does not take stops the job rather
// than reaching the engine.
it('refuses an effort the model does not take', async () => {
  const binary = makeStub('process.exit(0);');
  await expect(run(binary, { effort: 'ultra' })).rejects.toThrow(/ultra/);
});
