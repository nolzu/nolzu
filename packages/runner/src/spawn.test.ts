import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Job } from '@nolzu/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubBinary, type StubBinary } from '../test/stub-binary.ts';
import { codexModelList } from './codex-models.ts';
import { PHASE_GUARD } from './project/hook.ts';
import { buildPrompt } from './prompt.ts';
import { claudeInit, CURSOR_RECORD, cursorMcp, cursorRoot, restoreCursorMcp, runProcess, spawnClaude, spawnCodex, spawnCursor } from './spawn.ts';

// The wall needs bubblewrap on Linux, which CI lacks, so the engine starts as it came here.
// spawn-wall.test.ts runs the real wall and the doubles.
vi.mock('./wall-detect.ts', async (actual) => ({
  ...(await actual<typeof import('./wall-detect.ts')>()),
  walledCommand: (_spec: unknown, command: string, args: readonly string[]) => ({ command, args: [...args] }),
  // The probe answers ready, so the run takes the walled path on every machine.
  wallHere: () => ({ ready: true, binary: '/usr/bin/sandbox-exec' }),
}));

let stub: StubBinary | null = null;
let cwd = '';

afterEach(() => {
  stub?.remove();
  stub = null;
  if (cwd !== '') rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  cwd = '';
});

function makeStub(body: string): string {
  stub = stubBinary(body);
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-cwd-'));
  return stub.path;
}

const job = (over: Partial<Job> = {}): Job => ({
  runId: 1,
  cardKey: 'APP-1',
  engine: 'claude-code',
  phase: 'refine',
  cwd,
  prompt: 'Refine the ticket.',
  model: 'sonnet',
  effort: 'low',
  sessionId: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7',
  resumeFrom: null,
  timeoutMs: 30 * 60 * 1000,
  logPath: '/tmp/data/logs/1.ndjson',
  // Inside the test's own folder, because a run makes its card folder.
  taskDir: join(cwd, '.tasks', 'APP-1'),
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read', 'Grep'],
  ...over,
});

async function collect(binary: string, over: Partial<Job> = {}, signal = new AbortController().signal): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of spawnClaude(binary, { ...job(), ...over, cwd }, signal)) lines.push(line);
  return lines;
}

const waitGone = async (pid: number): Promise<boolean> => {
  for (let tries = 0; tries < 100; tries += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

it('yields whole lines although the writes cut them in the middle', () => {
  // Stdout arrives in chunks that have nothing to do with line ends. A decoder that yields
  // per chunk would hand the parser half a JSON object.
  const binary = makeStub(`
    const parts = ['{"a":1}\\n{"b', '":2}\\n{"c":3}', '\\n'];
    let i = 0;
    const next = () => {
      if (i >= parts.length) return process.exit(0);
      process.stdout.write(parts[i++], next);
    };
    next();
  `);

  return expect(collect(binary)).resolves.toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
});

it('yields a last line that carries no trailing newline', () => {
  const binary = makeStub(`process.stdout.write('{"a":1}\\n{"last":true}');`);

  return expect(collect(binary)).resolves.toEqual(['{"a":1}', '{"last":true}']);
});

it('yields one very long line whole', async () => {
  const binary = makeStub(`process.stdout.write('{"text":"' + 'x'.repeat(200000) + '"}\\n');`);
  const lines = await collect(binary);

  expect(lines).toHaveLength(1);
  expect(lines[0]?.length).toBeGreaterThan(200000);
});

it('writes the prompt on stdin and never in the argument list', async () => {
  // The prompt can be large and private. In argv it would show up in a process listing.
  const binary = makeStub(`
    let input = '';
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
      process.stdout.write(JSON.stringify({ stdin: input, argv: process.argv.slice(2) }) + '\\n');
    });
  `);
  const lines = await collect(binary, { prompt: 'Refine the ticket, carefully.' });
  const seen = JSON.parse(lines[0] ?? '{}') as { stdin: string; argv: string[] };

  expect(seen.stdin).toBe('Refine the ticket, carefully.');
  expect(seen.argv.join(' ')).not.toContain('carefully');
  expect(seen.argv).toContain('--strict-mcp-config');
});

it('runs in the card worktree', async () => {
  const binary = makeStub(`process.stdout.write(JSON.stringify({ cwd: process.cwd() }) + '\\n');`);
  const lines = await collect(binary);

  expect(JSON.parse(lines[0] ?? '{}').cwd).toContain('nolzu-cwd-');
});

it('fails with the exit code and the stderr tail when the engine stops badly', async () => {
  const binary = makeStub(`
    process.stderr.write('claude: something went wrong upstream\\n');
    process.stdout.write('{"a":1}\\n');
    setTimeout(() => process.exit(1), 10);
  `);

  // The lines it did produce still arrive, and the failure surfaces after them.
  await expect(collect(binary)).rejects.toThrow(/something went wrong upstream/);
  await expect(collect(binary)).rejects.toThrow(/1/);
});

it('ends the stream and leaves no child behind when the signal aborts', async () => {
  const binary = makeStub(`
    process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n');
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  const lines: string[] = [];
  let pid = 0;

  for await (const line of spawnClaude(binary, job(), controller.signal)) {
    lines.push(line);
    pid = JSON.parse(line).pid as number;
    controller.abort();
  }

  expect(lines).toHaveLength(1);
  expect(pid).toBeGreaterThan(0);
  expect(await waitGone(pid)).toBe(true);
});

it('kills a child that ignores the polite signal', async () => {
  // The agent starts its own tool subprocesses, so a run that refuses to stop has to be
  // taken down rather than left running against the user's checkout.
  const binary = makeStub(`
    process.on('SIGTERM', () => {});
    process.stdout.write(JSON.stringify({ pid: process.pid }) + '\\n');
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  let pid = 0;

  for await (const line of spawnClaude(binary, job(), controller.signal, { killGraceMs: 50 })) {
    pid = JSON.parse(line).pid as number;
    controller.abort();
  }

  expect(await waitGone(pid)).toBe(true);
});

it('names the engine and how to fix it when the binary is not there', async () => {
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-cwd-'));

  await expect(collect(join(cwd, 'no-such-claude'))).rejects.toThrow(/claude/i);
  await expect(collect(join(cwd, 'no-such-claude'))).rejects.toThrow(/install|PATH/i);
});

// A real agent starts its own tools. They inherit the engine's stdout and can outlive it, which
// is the case the process group exists for, so the stub has to start one too.
const withTool = (body: string, toolBody = 'setInterval(() => {}, 1000)'): string => `
  import('node:child_process').then(({ spawn }) => {
    const tool = spawn(process.execPath, ['-e', ${JSON.stringify(toolBody)}], { stdio: ['ignore', 1, 'ignore'] });
    tool.unref();
    process.stdout.write(JSON.stringify({ tool: tool.pid }) + '\\n');
    ${body}
  });
`;

async function runError(binary: string, over: Partial<Job> = {}, options: { killGraceMs?: number } = {}): Promise<string> {
  try {
    for await (const line of spawnClaude(binary, { ...job(), ...over }, new AbortController().signal, options)) void line;
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

it('kills the tools the engine started, although the engine exited first', async () => {
  // The group outlives the leader. A stop that only looks at the engine leaves the tools running
  // against the user's checkout, and they hold the output pipe open, so the run never ends.
  const binary = makeStub(withTool('setTimeout(() => process.exit(0), 50);'));
  const controller = new AbortController();
  let tool = 0;

  for await (const line of spawnClaude(binary, job(), controller.signal, { killGraceMs: 50 })) {
    tool = JSON.parse(line).tool as number;
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
  }

  expect(tool).toBeGreaterThan(0);
  expect(await waitGone(tool)).toBe(true);
});

it('reports the exit code although a tool still holds the output pipe', async () => {
  const binary = makeStub(withTool("process.stderr.write('claude: upstream said no\\n'); setTimeout(() => process.exit(1), 20);"));

  const message = await runError(binary, {}, { killGraceMs: 50 });
  expect(message).toMatch(/exit code 1/);
  expect(message).toMatch(/upstream said no/);
}, 10000);

it('names the missing worktree instead of blaming the engine', async () => {
  // A worktree can be removed between two runs. Node reports the failed chdir with the same
  // ENOENT a missing binary gives, so the message has to tell the two apart.
  const binary = makeStub('process.exit(0);');

  const message = await runError(binary, { cwd: join(cwd, 'gone-worktree') });
  expect(message).toMatch(/worktree/i);
  expect(message).not.toMatch(/install/i);
});

it('yields the last line although a tool still holds the output pipe', async () => {
  // The result line carries the cost and the session id, and it arrives with no trailing newline.
  // Closing the reader threw it away, so a finished run looked like a run with no result.
  const binary = makeStub(withTool("process.stdout.write('{\"a\":1}' + String.fromCharCode(10) + '{\"result\":true}'); setTimeout(() => process.exit(0), 20);"));
  const lines: string[] = [];

  for await (const line of spawnClaude(binary, job(), new AbortController().signal, { killGraceMs: 50 })) {
    if (!line.includes('"tool"')) lines.push(line);
  }

  expect(lines).toEqual(['{"a":1}', '{"result":true}']);
}, 15000);

it('kills a tool that ignores the polite signal after a run that ended well', async () => {
  // The tool has to be given time to install its handler before the group is signalled, or the
  // test passes while the tool is still starting up and never reaches the escalation at all.
  const marker = join(tmpdir(), `nolzu-trap-${process.pid}-${Date.now()}`);
  const trap = `process.on('SIGTERM', () => { require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); }); setInterval(() => {}, 1000)`;
  const binary = makeStub(withTool('setTimeout(() => process.exit(0), 300);', trap));
  let tool = 0;

  for await (const line of spawnClaude(binary, job(), new AbortController().signal, { killGraceMs: 200 })) {
    tool = JSON.parse(line).tool as number;
  }

  expect(tool).toBeGreaterThan(0);
  // The handler ran, so the polite signal really was delivered and the kill really was needed.
  expect(existsSync(marker)).toBe(true);
  expect(await waitGone(tool)).toBe(true);
  rmSync(marker, { force: true });
}, 20000);

it('reports a failure that happened before the caller stopped the run', async () => {
  // The engine died on its own and the person pressed stop afterwards. The exit code was known
  // long before the abort, and throwing it away turns a crash into a quiet ending.
  const binary = makeStub(`
    process.stderr.write('real failure' + String.fromCharCode(10));
    process.stdout.write('{"a":1}' + String.fromCharCode(10));
    setTimeout(() => process.exit(9), 10);
  `);
  const controller = new AbortController();

  const run = async () => {
    for await (const line of spawnClaude(binary, job(), controller.signal)) {
      void line;
      await new Promise((resolve) => setTimeout(resolve, 300));
      controller.abort();
    }
  };

  await expect(run()).rejects.toThrow(/exit code 9/);
}, 15000);

it('never cuts a character in half at the start of the failure text', async () => {
  const binary = makeStub("process.stderr.write('\u{1F642}'.repeat(5000) + 'y'); setTimeout(() => process.exit(1), 10);");

  const message = await runError(binary, {}, { killGraceMs: 50 });

  expect(message.isWellFormed()).toBe(true);
});

it('stops the engine when the caller breaks out without aborting', async () => {
  // The cleanup used to sit after the yields, so a break unwound straight past it and left the
  // engine and everything it started running with no parent.
  const binary = makeStub(`
    process.stdout.write(JSON.stringify({ pid: process.pid }) + String.fromCharCode(10));
    setInterval(() => {}, 1000);
  `);
  let pid = 0;

  for await (const line of spawnClaude(binary, job(), new AbortController().signal, { killGraceMs: 50 })) {
    pid = JSON.parse(line).pid as number;
    break;
  }

  expect(pid).toBeGreaterThan(0);
  expect(await waitGone(pid)).toBe(true);
}, 15000);

it('does not wait out the whole grace when the tools go quietly', async () => {
  // The group was probed the moment the signal was sent, so a tool that dies at once was still
  // alive at the probe and every good run then paid the full grace before reporting done.
  // The tool takes 200ms to go after the stop and holds the engine's stdout until then, so the run
  // waits for it, and no longer.
  const binary = makeStub(withTool('setTimeout(() => process.exit(0), 300);', "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 200)); setInterval(() => {}, 1000);"));
  // Timed from the line the engine prints once its tool runs, and not from the spawn, so a busy
  // machine that takes a second to start Node does not count against the grace. A note Nolzu yields
  // before the spawn, such as the wall's, is no engine line. What is left is the engine's 300ms, the
  // tool's 200ms and the polls, well under half the grace.
  let started: number | null = null;

  for await (const line of spawnClaude(binary, job(), new AbortController().signal, { killGraceMs: 3000 })) {
    if (started === null && line.includes('"tool"')) started = Date.now();
  }

  expect(started).not.toBeNull();
  expect(Date.now() - started!).toBeLessThan(1500);
}, 15000);

it('names the worktree when its path is not a folder', async () => {
  // Node throws this one out of spawn itself rather than reporting it on the child, so the branch
  // that handled it could never run.
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-cwd-'));
  const file = join(cwd, 'a-file');
  writeFileSync(file, 'not a folder');
  const binary = makeStub('process.exit(0);');

  const message = await runError(binary, { cwd: join(file, 'inside') });

  expect(message).toMatch(/worktree/i);
  expect(message).not.toMatch(/install/i);
});

it('names the worktree when it cannot be entered', async () => {
  const binary = makeStub('process.exit(0);');
  cwd = mkdtempSync(join(tmpdir(), 'nolzu-cwd-'));
  const locked = join(cwd, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0o000);

  const message = await runError(binary, { cwd: locked });
  chmodSync(locked, 0o700);

  expect(message).toMatch(/worktree/i);
  expect(message).not.toMatch(/execute bit/i);
});

it('reports a crash the engine had already handed over when the stop arrived', async () => {
  // A crash Node has already delivered is reported, and this is what that is worth: a crash still
  // waiting to be delivered is treated as the stop instead, because a child is a zombie until the
  // loop reaps it and nothing in the process can tell the two apart. The caller here is idle, which
  // is the side of the line where the crash is reported.
  const binary = makeStub(`
    process.stderr.write('real failure' + String.fromCharCode(10));
    process.stdout.write('{"a":1}' + String.fromCharCode(10), () => process.exit(9));
  `);
  const controller = new AbortController();

  const run = async () => {
    for await (const line of spawnClaude(binary, job(), controller.signal)) {
      void line;
      // "Had already handed over" is the whole point of this test, so the wait makes that
      // ordering explicit instead of hoping for it. Without it the abort and the exit race, and
      // on a busy machine the abort wins: the run then ends as the stop the caller asked for,
      // which is correct behaviour and the other side of the line this test is about. It failed
      // that way on CI while passing here every time.
      await new Promise((done) => setTimeout(done, 200));
      controller.abort();
    }
  };

  await expect(run()).rejects.toThrow(/exit code 9/);
}, 15000);

it('reports nothing when the engine traps the stop and exits with a code', async () => {
  // A command line tool that cleans up on SIGTERM exits with a code, not by the signal. Forgiving
  // only a death by signal turned a stop the person asked for into a reported failure.
  const binary = makeStub(`
    process.on('SIGTERM', () => process.exit(143));
    process.stdout.write(JSON.stringify({ pid: process.pid }) + String.fromCharCode(10));
    setInterval(() => {}, 1000);
  `);
  const controller = new AbortController();
  const lines: string[] = [];

  for await (const line of spawnClaude(binary, job(), controller.signal, { killGraceMs: 200 })) {
    lines.push(line);
    controller.abort();
  }

  expect(lines).toHaveLength(1);
}, 20000);

// Prints the variables the run is judged by, as the child sees them.
const ECHO_ENV = `
  const names = ['ANTHROPIC_MODEL', 'CLAUDE_CODE_EFFORT_LEVEL', 'NOLZU_READ_ONLY', 'NOLZU_TASK_DIR', 'NOLZU_KNOWLEDGE_DIR', 'NOLZU_ALLOW_COMMANDS', 'HOME', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN'];
  const seen = Object.fromEntries(names.map((name) => [name, process.env[name] ?? null]));
  process.stdout.write(JSON.stringify(seen) + String.fromCharCode(10));
`;

// `over` can be a function, because the folder the stub runs in is made here and a test that names
// a path inside it has nothing to build that path from until then.
async function childEnv(
  over: Partial<Job> | ((at: string) => Partial<Job>),
  parent: Record<string, string | undefined>,
): Promise<Record<string, string | null>> {
  const binary = makeStub(ECHO_ENV);
  const fields = typeof over === 'function' ? over(cwd) : over;
  const lines: string[] = [];
  const started = spawnClaude(binary, { ...job(), ...fields, cwd }, new AbortController().signal, { env: { ...process.env, ...parent } });
  for await (const line of started) lines.push(line);
  return JSON.parse(lines[0] ?? '{}') as Record<string, string | null>;
}

it('starts the engine without a model or an effort the parent shell carried', async () => {
  // Both outrank the flags, so the card would show one model and run another.
  const seen = await childEnv({}, { ANTHROPIC_MODEL: 'opus', CLAUDE_CODE_EFFORT_LEVEL: 'max', HOME: '/home/dev' });

  expect(seen.ANTHROPIC_MODEL).toBeNull();
  expect(seen.CLAUDE_CODE_EFFORT_LEVEL).toBeNull();
  expect(seen.HOME).toBe('/home/dev');
});

it('starts the engine without the GitHub and npm tokens the parent shell carried', async () => {
  // With one the run could push or publish as the person. Dummy values: a test never reads a real one.
  const tokens = { GH_TOKEN: 'x', GITHUB_TOKEN: 'x', GH_ENTERPRISE_TOKEN: 'x', GITHUB_ENTERPRISE_TOKEN: 'x', NPM_TOKEN: 'x', NODE_AUTH_TOKEN: 'x' };
  const seen = await childEnv({}, tokens);

  for (const name of Object.keys(tokens)) expect(seen[name]).toBeNull();
});

it('turns the write guard on for a read-only phase', async () => {
  // Without it the guard in the project exits at once, and a refine run can write anywhere.
  const seen = await childEnv({ phase: 'refine', cardKey: 'APP-7' }, {});

  expect(seen.NOLZU_READ_ONLY).toBe('1');
});

// Asks the guard itself, with the environment the child was given. Comparing the folder to a path
// built here would only repeat the code under test, and would pass on a path the guard refuses.
function guardCall(env: Record<string, string | null>, payload: unknown): number {
  const guard = join(cwd, 'guard.mjs');
  writeFileSync(guard, PHASE_GUARD);
  try {
    execFileSync(process.execPath, [guard], {
      input: JSON.stringify(payload),
      env: {
        PATH: process.env.PATH ?? '',
        NOLZU_READ_ONLY: env.NOLZU_READ_ONLY ?? '',
        NOLZU_TASK_DIR: env.NOLZU_TASK_DIR ?? '',
        NOLZU_KNOWLEDGE_DIR: env.NOLZU_KNOWLEDGE_DIR ?? '',
        // The flag the policy sets for a phase that may run a command. Left out, the guard would
        // refuse every command whatever the policy says, and a test asking about one would pass on a
        // policy that allows it.
        NOLZU_ALLOW_COMMANDS: env.NOLZU_ALLOW_COMMANDS ?? '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

const guardAnswer = (env: Record<string, string | null>, target: string): number =>
  guardCall(env, { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: target } });

// The same question for a command. A phase that was given none may run none, and git and every other
// write outside the tool list is only reachable through a command, so this is the half of a policy
// that no file path can show.
const commandAnswer = (env: Record<string, string | null>, command: string): number =>
  guardCall(env, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });

// The layout the app builds: the card's checkout under `worktrees/`, and its card folder under
// `.tasks/`, both in the project, so the card folder is outside the folder the run starts in.
it('lets a read-only run write its own notes when the project sits behind a symlink', async () => {
  // The engine reports the physical folder, so that is where the agent's paths point. A limit
  // kept in the spelling the person typed matches none of them, and the run then loses every
  // write, its summary included, while the stream still says it went well.
  const binary = makeStub(ECHO_ENV);
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-real-')));
  mkdirSync(join(real, 'worktrees', 'APP-7'), { recursive: true });
  const link = join(cwd, 'project');
  symlinkSync(real, link);
  try {
    const run = { ...job(), phase: 'refine', cardKey: 'APP-7', cwd: join(link, 'worktrees', 'APP-7'), taskDir: join(link, '.tasks', 'APP-7') };
    const lines: string[] = [];
    for await (const line of spawnClaude(binary, run, new AbortController().signal)) lines.push(line);
    const seen = JSON.parse(lines[0] ?? '{}') as Record<string, string | null>;

    expect(guardAnswer(seen, join(real, '.tasks', 'APP-7', 'refine', 'summary.md'))).toBe(0);
    expect(guardAnswer(seen, join(real, 'worktrees', 'APP-7', 'src', 'list.ts'))).toBe(2);
    expect(guardAnswer(seen, join(real, '.tasks', 'APP-8', 'refine', 'summary.md'))).toBe(2);
    // Made before the run, so the first write into it does not depend on the agent making it.
    expect(existsSync(join(real, '.tasks', 'APP-7'))).toBe(true);
  } finally {
    rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The engine is pointed at the card folder with `--add-dir`, and the guard holds the run to it. Two
// spellings of one folder would let the engine refuse what the guard allows, or the reverse, so both
// get the physical one. That is also the spelling the engine was measured with.
it('opens the same physical card folder to the engine that it holds the guard to', async () => {
  const binary = makeStub(`
    const at = process.argv.indexOf('--add-dir');
    process.stdout.write(JSON.stringify({ added: process.argv[at + 1] ?? null, limit: process.env.NOLZU_TASK_DIR ?? null }) + String.fromCharCode(10));
  `);
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-real-')));
  mkdirSync(join(real, 'worktrees', 'APP-7'), { recursive: true });
  const link = join(cwd, 'project');
  symlinkSync(real, link);
  try {
    const run = { ...job(), cardKey: 'APP-7', cwd: join(link, 'worktrees', 'APP-7'), taskDir: join(link, '.tasks', 'APP-7') };
    const lines: string[] = [];
    for await (const line of spawnClaude(binary, run, new AbortController().signal)) lines.push(line);
    const seen = JSON.parse(lines[0] ?? '{}') as { added: string | null; limit: string | null };

    expect(seen.added).toBe(join(real, '.tasks', 'APP-7'));
    expect(seen.limit).toBe(seen.added);
  } finally {
    rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The agent reads the project's files by their physical path, like every other path it builds, so
// a Read rule in the spelling the person typed would let none of those reads through.
it('names the project files to the engine by their physical path', async () => {
  const binary = makeStub(`
    const at = process.argv.indexOf('--allowedTools');
    process.stdout.write(JSON.stringify(process.argv.slice(at + 1, at + 2)) + String.fromCharCode(10));
  `);
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-real-')));
  mkdirSync(join(real, 'worktrees', 'APP-7'), { recursive: true });
  const link = join(cwd, 'project');
  symlinkSync(real, link);
  try {
    const run = { ...job(), cardKey: 'APP-7', cwd: join(link, 'worktrees', 'APP-7'), taskDir: join(link, '.tasks', 'APP-7'), projectDir: link };
    const lines: string[] = [];
    for await (const line of spawnClaude(binary, run, new AbortController().signal)) lines.push(line);

    expect(JSON.parse(lines[0] ?? '[]')).toEqual([`Read(/${join(real, 'AGENTS.md')})`]);
  } finally {
    rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The epic's documents lie behind the same symlink, and the agent reads them by the physical path.
it("names the epic's documents to the engine by their physical path", async () => {
  const binary = makeStub(`
    const at = process.argv.indexOf('--allowedTools');
    process.stdout.write(JSON.stringify(process.argv.slice(at + 1, at + 2)) + String.fromCharCode(10));
  `);
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-real-')));
  mkdirSync(join(real, 'worktrees', 'APP-7'), { recursive: true });
  mkdirSync(join(real, '.tasks', 'APP-6', 'plan'), { recursive: true });
  writeFileSync(join(real, '.tasks', 'APP-6', 'plan', 'plan.md'), '1. Add a recipe\n');
  const link = join(cwd, 'project');
  symlinkSync(real, link);
  try {
    const run = { ...job(), cardKey: 'APP-7', cwd: join(link, 'worktrees', 'APP-7'), taskDir: join(link, '.tasks', 'APP-7'), epicFiles: [join(link, '.tasks', 'APP-6', 'plan', 'plan.md')] };
    const lines: string[] = [];
    for await (const line of spawnClaude(binary, run, new AbortController().signal)) lines.push(line);

    expect(JSON.parse(lines[0] ?? '[]')).toEqual([`Read(/${join(real, '.tasks', 'APP-6')}/**)`]);
  } finally {
    rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Both spellings of one folder must meet, or a run that starts in the project, behind a symlink,
// is given rules for files it can already read.
it('adds no Read rule when the run starts in the project folder behind a symlink', async () => {
  const binary = makeStub(`
    process.stdout.write(JSON.stringify(process.argv.includes('--allowedTools')) + String.fromCharCode(10));
  `);
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-real-')));
  const link = join(cwd, 'project');
  symlinkSync(real, link);
  try {
    const run = { ...job(), cardKey: 'APP-7', cwd: link, taskDir: join(link, '.tasks', 'APP-7'), projectDir: link };
    const lines: string[] = [];
    for await (const line of spawnClaude(binary, run, new AbortController().signal)) lines.push(line);

    expect(JSON.parse(lines[0] ?? 'null')).toBe(false);
  } finally {
    rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// The prompt names the card folder from the working folder, such as `../../.tasks/APP-7/`, and the
// engine resolves that from the physical checkout. When `worktrees/` or `.tasks/` is a symlink of
// its own, that path lands somewhere else, every write of the run is refused, and the run still
// says it went well. So the run does not start, and the card says what to change.
it.each(['worktrees', '.tasks'])('refuses to start when %s is a symlink the other folder does not share', async (linked) => {
  const binary = makeStub(`require('node:fs').writeFileSync('started', ''); process.stdout.write('{}' + String.fromCharCode(10));`);
  const project = join(cwd, 'project');
  const elsewhere = join(cwd, 'elsewhere');
  mkdirSync(join(elsewhere, linked === 'worktrees' ? 'APP-7' : ''), { recursive: true });
  mkdirSync(project);
  symlinkSync(elsewhere, join(project, linked));
  mkdirSync(join(project, 'worktrees', 'APP-7'), { recursive: true });
  const run = { ...job(), cardKey: 'APP-7', cwd: join(project, 'worktrees', 'APP-7'), taskDir: join(project, '.tasks', 'APP-7') };
  const started = async () => {
    for await (const line of spawnClaude(binary, run, new AbortController().signal)) void line;
  };

  await expect(started()).rejects.toThrow(/symlink/);
  expect(existsSync(join(run.cwd, 'started'))).toBe(false);
});

// QA's prompt names the card folder in full, so a copy in a data folder reached through a symlink
// of its own still finds it.
it('starts a QA run whose copy lies behind a symlink the card folder does not share', async () => {
  const binary = makeStub(`require('node:fs').writeFileSync('started', ''); process.stdout.write('{}' + String.fromCharCode(10));`);
  const project = join(cwd, 'project');
  mkdirSync(join(project, 'worktrees', 'APP-7'), { recursive: true });
  mkdirSync(join(cwd, 'disk', 'nolzu', 'qa-copies', 'qa-APP-7'), { recursive: true });
  symlinkSync(join(cwd, 'disk', 'nolzu'), join(cwd, 'data'));
  const run = { ...job(), phase: 'qa', cardKey: 'APP-7', cwd: join(project, 'worktrees', 'APP-7'), qaCopy: join(cwd, 'data', 'qa-copies', 'qa-APP-7'), taskDir: join(project, '.tasks', 'APP-7') };

  for await (const line of spawnClaude(binary, run, new AbortController().signal)) void line;

  expect(existsSync(join(run.qaCopy, 'started'))).toBe(true);
});

it('says in a sentence when the card folder cannot be made', async () => {
  const binary = makeStub(`process.stdout.write('{}' + String.fromCharCode(10));`);
  // A file where the folder should be.
  mkdirSync(join(cwd, '.tasks'));
  writeFileSync(join(cwd, '.tasks', 'APP-1'), 'not a folder');
  const started = async () => {
    for await (const line of spawnClaude(binary, job(), new AbortController().signal)) void line;
  };

  await expect(started()).rejects.toThrow(/The card folder .*APP-1 cannot be made/);
});

// A checkout that is gone gets the sentence written for it. Making the card folder first would
// rebuild a project folder that was deleted, as an empty shell, before failing anyway.
it('makes no card folder when the checkout is not there', async () => {
  const binary = makeStub(`process.stdout.write('{}' + String.fromCharCode(10));`);
  const project = join(cwd, 'gone');
  const run = { ...job(), cwd: join(project, 'worktrees', 'APP-7'), taskDir: join(project, '.tasks', 'APP-7') };
  const started = async () => {
    for await (const line of spawnClaude(binary, run, new AbortController().signal)) void line;
  };

  await expect(started()).rejects.toThrow(/is not there/);
  expect(existsSync(project)).toBe(false);
});

// The wrap-up is the one phase that writes outside the card folder, and it must still not touch
// the project's source. The guard itself answers here, with the environment the child was given,
// because an assertion on the variable alone cannot tell an allowed write from a refused one.
it('hands a wrap-up run the knowledge folder, and the guard then refuses the source', async () => {
  const seen = await childEnv((at) => ({ phase: 'wrapup', knowledgeDir: join(at, '.nolzu', 'knowledge') }), {});

  expect(seen.NOLZU_KNOWLEDGE_DIR).toBe(join(cwd, '.nolzu', 'knowledge'));
  expect(guardAnswer(seen, join(cwd, '.nolzu', 'knowledge', 'importer.md'))).toBe(0);
  expect(guardAnswer(seen, join(cwd, 'src', 'list.ts'))).toBe(2);
});

// The other side. A job built for another phase that carried a knowledge folder would open that
// folder to a run nobody commits for, so the policy decides and not the job.
it('gives no knowledge folder to a phase that writes no knowledge', async () => {
  const seen = await childEnv((at) => ({ phase: 'refine', knowledgeDir: join(at, '.nolzu', 'knowledge') }), {});

  expect(seen.NOLZU_KNOWLEDGE_DIR).toBeNull();
  expect(guardAnswer(seen, join(cwd, '.nolzu', 'knowledge', 'importer.md'))).toBe(2);
});

// The guard allowed a wrap-up to write the knowledge folder, and the engine still refused its first
// look at it, because the folder is outside the checkout the run starts in. So the engine is pointed
// at it as well, in the physical spelling the guard gets, for the reason the card folder test gives.
it('opens the knowledge folder to the engine in the spelling it holds the guard to', async () => {
  const binary = makeStub(`
    const at = process.argv.indexOf('--add-dir');
    process.stdout.write(JSON.stringify({ added: process.argv.slice(at + 1, at + 3), limit: process.env.NOLZU_KNOWLEDGE_DIR ?? null }) + String.fromCharCode(10));
  `);
  const real = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-real-')));
  mkdirSync(join(real, '.nolzu', 'knowledge'), { recursive: true });
  const link = join(cwd, 'project');
  symlinkSync(real, link);
  try {
    const run = { ...job(), phase: 'wrapup', knowledgeDir: join(link, '.nolzu', 'knowledge') };
    const lines: string[] = [];
    for await (const line of spawnClaude(binary, run, new AbortController().signal)) lines.push(line);
    const seen = JSON.parse(lines[0] ?? '{}') as { added: string[]; limit: string | null };

    expect(seen.added[1]).toBe(join(real, '.nolzu', 'knowledge'));
    expect(seen.limit).toBe(seen.added[1]);
  } finally {
    rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

it('opens no knowledge folder to the engine for a phase that writes no knowledge', async () => {
  const binary = makeStub(`process.stdout.write(JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));`);
  const knowledge = join(cwd, '.nolzu', 'knowledge');
  mkdirSync(knowledge, { recursive: true });
  const lines: string[] = [];
  for await (const line of spawnClaude(binary, { ...job(), phase: 'refine', knowledgeDir: knowledge }, new AbortController().signal)) lines.push(line);

  expect(JSON.parse(lines[0] ?? '[]')).not.toContain(knowledge);
  expect(JSON.parse(lines[0] ?? '[]')).not.toContain(realpathSync(knowledge));
});

it('leaves the write guard off for implement', async () => {
  const seen = await childEnv({ phase: 'implement' }, { NOLZU_READ_ONLY: '1', NOLZU_TASK_DIR: '/other/.tasks/APP-9' });

  expect(seen.NOLZU_READ_ONLY).toBeNull();
  expect(seen.NOLZU_TASK_DIR).toBeNull();
});

it('refuses a phase with no policy row before anything starts', async () => {
  // The marker is what says nothing started. The rejection alone would also come from a check
  // made after the engine was already running, and that engine would then have no parent.
  const binary = makeStub(`require('node:fs').writeFileSync('started', ''); setInterval(() => {}, 1000);`);
  const run = async () => {
    for await (const line of spawnClaude(binary, { ...job(), phase: 'nope', cwd }, new AbortController().signal)) void line;
  };

  await expect(run()).rejects.toThrow(/PHASE_POLICIES/);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(existsSync(join(cwd, 'started'))).toBe(false);
  expect(existsSync(join(cwd, '.tasks'))).toBe(false);
});

// A project folder that is not a git repository runs on Claude Code only, until the other engines
// are measured in such a folder. The spawn reads the same rule as the job builder, so a job built
// some other way is still refused before its process starts.
it.each([
  ['codex', spawnCodex],
  ['cursor', spawnCursor],
] as const)('refuses %s in a project folder that is not a git repository before anything starts', async (engine, spawn) => {
  // The marker path is absolute, because a model list call before the run would start the binary
  // in the test's own folder, where a relative marker is never looked for.
  const marks = mkdtempSync(join(tmpdir(), 'nolzu-marks-'));
  const marker = join(marks, 'started');
  const binary = makeStub(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); setInterval(() => {}, 1000);`);
  const run = async () => {
    for await (const line of spawn(binary, { ...job(), engine, phase: 'implement', outsideGit: true, cwd }, new AbortController().signal)) void line;
  };

  try {
    await expect(run()).rejects.toThrow('The project folder is not a git repository');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(cwd, '.tasks'))).toBe(false);
  } finally {
    rmSync(marks, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// A Codex stub that answers the model list and then one turn, so a whole spawn runs without the
// vendor binary. The list is read before the process starts, and an empty one is a refused run.
const CODEX_STUB = `
const args = process.argv.slice(2);
if (args[0] === 'debug') {
  console.log(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', supported_reasoning_levels: [{ effort: 'low' }] }] }));
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ type: 'turn.completed', usage: {} })));
`;

const codexJob = (over: Partial<Job> = {}): Job => ({
  ...job(),
  engine: 'codex',
  phase: 'implement',
  model: 'gpt-5.6-sol',
  effort: 'low',
  tools: ['Read', 'Write', 'Edit', 'Bash'],
  ...over,
});

async function runCodex(binary: string, over: Partial<Job> = {}): Promise<void> {
  // The model list read once with a test's wait and kept: a stub written a moment before can take
  // longer than the product's five seconds to start on a busy machine.
  codexModelList(binary, process.env, 30_000);
  const signal = new AbortController().signal;
  for await (const line of spawnCodex(binary, { ...codexJob(over), cwd }, signal)) void line;
}

// The engine has no skill to find, so this file is the only place the method reaches it. The path
// is taken out of the prompt the same run carries, so the two sides cannot name different files.
it('leaves the phase instructions where the prompt sends the Codex run to read them', async () => {
  const binary = makeStub(CODEX_STUB);
  const taskDir = join(cwd, '.tasks', 'APP-1');
  // Long, and compared whole below, because a write that cut the text short would leave a method
  // that stops in the middle and still reads like one.
  const method = `These are the instructions for the implement phase of this run. Follow them.

Read the plan in the card folder. Write the code it asks for, and nothing the plan does not name.
Run the project's own checks before you finish, and write what you changed to the card folder.

---

Linked file: finish.md

End with the line the prompt names. Leave no commit behind.
`;
  const prompt = buildPrompt({ phase: 'implement', key: 'APP-1', title: 'A card', ticket: '', extra: '', readOnly: false, folder: relative(cwd, taskDir) });

  await runCodex(binary, { instructions: method, prompt });

  const named = prompt.split('`')[1] ?? '';
  expect(readFileSync(resolve(cwd, named), 'utf8')).toBe(method);
});

// Claude Code reads the method from the same file as every other engine, where its prompt says.
it('leaves the phase instructions where the prompt sends the Claude Code run to read them', async () => {
  const binary = makeStub('process.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));');
  const taskDir = join(cwd, '.tasks', 'APP-1');
  const method = 'These are the instructions for the implement phase of this run. Follow them.\n';
  const prompt = buildPrompt({ phase: 'implement', key: 'APP-1', title: 'A card', ticket: '', extra: '', readOnly: false, folder: relative(cwd, taskDir) });

  await collect(binary, { phase: 'implement', instructions: method, prompt });

  expect(readFileSync(resolve(cwd, prompt.split('`')[1] ?? ''), 'utf8')).toBe(method);
});

// An Ask carries no method, so nothing is written for it.
it('writes no instructions file for a run that carries none', async () => {
  const binary = makeStub('process.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));');

  await collect(binary, { phase: 'implement' });

  expect(existsSync(join(cwd, '.tasks', 'APP-1', 'implement', 'instructions.md'))).toBe(false);
});

// A file left from an earlier run would hold a method this run never got, in a folder a person reads.
it('takes away the instructions file an earlier run left', async () => {
  const binary = makeStub('process.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));');
  const stale = join(cwd, '.tasks', 'APP-1', 'implement', 'instructions.md');
  mkdirSync(join(cwd, '.tasks', 'APP-1', 'implement'), { recursive: true });
  writeFileSync(stale, 'The method the run before this one was given.\n');
  const stalePrompt = join(cwd, '.tasks', 'APP-1', 'implement', 'prompt.md');
  writeFileSync(stalePrompt, 'The prompt the run before this one was sent.\n');

  await collect(binary, { phase: 'implement' });

  expect(existsSync(stale)).toBe(false);
  expect(existsSync(stalePrompt)).toBe(false);
});

// Every run may write its card folder. A link an earlier run left at the prompt's name, or in the place
// of the phase folder, never gets Nolzu to write or delete a file outside it, such as a shell's start file.
it('writes and removes no file outside the card folder through a link an earlier run left', async () => {
  const binary = makeStub('process.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));');
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-outside-'));
  try {
    const card = join(cwd, '.tasks', 'APP-1');
    mkdirSync(join(card, 'implement'), { recursive: true });
    symlinkSync(join(outside, '.zshenv'), join(card, 'implement', 'prompt.md'));
    await collect(binary, { phase: 'implement', instructions: 'The method.\n', prompt: 'echo ticket line\n' }).catch(() => undefined);
    expect(existsSync(join(outside, '.zshenv'))).toBe(false);

    rmSync(join(card, 'implement'), { recursive: true });
    writeFileSync(join(outside, 'instructions.md'), 'mine\n');
    symlinkSync(outside, join(card, 'implement'));
    await collect(binary, { phase: 'implement', instructions: 'The method.\n', prompt: 'p' }).catch(() => undefined);
    expect(readFileSync(join(outside, 'instructions.md'), 'utf8')).toBe('mine\n');
    expect(existsSync(join(outside, 'prompt.md'))).toBe(false);
    // A run with no method removes the old files, and none through the link.
    await collect(binary, { phase: 'implement' }).catch(() => undefined);
    expect(readFileSync(join(outside, 'instructions.md'), 'utf8')).toBe('mine\n');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

// The person reads what each run was told on the Files tab.
it('writes the prompt a fresh run is sent beside its method, and a resume keeps it', async () => {
  const binary = makeStub('process.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));');
  const file = join(cwd, '.tasks', 'APP-1', 'implement', 'prompt.md');

  await collect(binary, { phase: 'implement', instructions: 'The method.\n', prompt: 'Run the implement phase for APP-1.\n' });
  expect(readFileSync(file, 'utf8')).toBe('Run the implement phase for APP-1.\n');

  // A resume is sent the answer alone, and the prompt that started the session is the one to read.
  await collect(binary, { phase: 'implement', instructions: 'The method.\n', prompt: 'Yes, the settings page.', sessionId: null, resumeFrom: 'session-1' });
  expect(readFileSync(file, 'utf8')).toBe('Run the implement phase for APP-1.\n');
});

// The summary pass is built by spreading the phase job, so it carries that phase's method. It has
// no skill, no stage and a prompt that names no file, so a copy in the card folder is one more file
// a person has to read past and nobody ever opens.
it('writes no instructions file for a pass that is not a phase', async () => {
  const binary = makeStub('process.stdin.resume();\nprocess.stdin.on("end", () => process.exit(0));');

  await collect(binary, { phase: 'extract-summary', tools: ['Read'], instructions: 'Rewrite what the run said as a summary.\n' });

  expect(existsSync(join(cwd, '.tasks', 'APP-1', 'extract-summary', 'instructions.md'))).toBe(false);
  expect(existsSync(join(cwd, '.tasks', 'APP-1', 'extract-summary', 'prompt.md'))).toBe(false);
});

// A stub that records the folder it was started in and the arguments it was given. Where the
// process starts is the whole read-only limit on this engine, so it is read off a real spawn
// rather than off the argument builder alone.
const CODEX_WHERE_STUB = `
const args = process.argv.slice(2);
if (args[0] === 'debug') {
  console.log(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol', supported_reasoning_levels: [{ effort: 'low' }] }] }));
  process.exit(0);
}
require('node:fs').writeFileSync('where.txt', process.cwd() + '\\n' + args.join(' '));
process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({ type: 'turn.completed', usage: {} })));
`;

/**
 * A read-only phase starts in the checkout, like on every other engine.
 *
 * Codex runs inside Nolzu's wall with its own sandbox off, because its sandbox modes still read
 * `~/.ssh` and `.env`, and one sandbox cannot start inside another. The wall holds the run to the
 * card folder, so neither the card folder nor the checkout is named to the engine. The stub writes
 * into the folder it was started in, which is what proves the process got it.
 */
it('starts a read-only phase on Codex in the checkout, with its own sandbox off', async () => {
  const binary = makeStub(CODEX_WHERE_STUB);

  await runCodex(binary, { phase: 'refine', tools: ['Read', 'Grep', 'Glob', 'Write'] });

  const [where, args] = readFileSync(join(cwd, 'where.txt'), 'utf8').split('\n');
  expect(where).toBe(realpathSync(cwd));
  expect(args).toContain('-c sandbox_mode="danger-full-access" -c approval_policy="never"');
  expect(args).not.toContain('-s ');
  expect(args).not.toContain('--add-dir');
});

// Implement starts in the same folder, and the wall opens the checkout to it.
it('starts implement on Codex in the checkout, with no folder added', async () => {
  const binary = makeStub(CODEX_WHERE_STUB);

  await runCodex(binary, { phase: 'implement' });

  const [where, args] = readFileSync(join(cwd, 'where.txt'), 'utf8').split('\n');
  expect(where).toBe(realpathSync(cwd));
  expect(args).toContain('sandbox_mode="danger-full-access"');
  expect(args).not.toContain('--add-dir');
});

/**
 * The Scout assessment, refused by the guard and not by the prompt.
 *
 * The environment comes out of the real spawn, which reads the policy row and never the job, and the
 * real guard script answers with it. Nothing in the prompt is load-bearing here: the four limits of
 * a Scout assessment are a tool list plus these exit codes.
 *
 * Every path is built from the folder the child was really given, because a temp folder on macOS is a
 * symlink and a path spelled by hand here would be refused for the wrong reason.
 */
it('hands an assessment run a guard that refuses the project, the knowledge folder and every command', async () => {
  const seen = await childEnv((at) => ({ phase: 'assess', cardKey: 'assess-1', taskDir: join(at, '.tasks', 'assess-1') }), {});
  const task = seen.NOLZU_TASK_DIR ?? '';
  // The card folder is `<project>/.tasks/<key>`, so this is the project the run reads.
  const project = resolve(task, '..', '..');

  expect(seen.NOLZU_READ_ONLY).toBe('1');
  // No knowledge folder and no command flag, so the card folder is the only folder the guard allows
  // and there is no way to a shell at all.
  expect(seen.NOLZU_KNOWLEDGE_DIR).toBeNull();
  expect(seen.NOLZU_ALLOW_COMMANDS).toBeNull();
  expect(guardAnswer(seen, join(task, 'assess', 'assessment.md'))).toBe(0);
  expect(guardAnswer(seen, join(project, 'src', 'list.ts'))).toBe(2);
  expect(guardAnswer(seen, join(project, '.nolzu', 'knowledge', 'importer.md'))).toBe(2);
  expect(guardAnswer(seen, join(project, '.tasks', 'assess-2', 'assess', 'assessment.md'))).toBe(2);
  // No command at all, which is where the no-shell-write and no-git-write halves come from.
  expect(commandAnswer(seen, 'pnpm test')).toBe(2);
  expect(commandAnswer(seen, 'git commit -am notes')).toBe(2);
});

/**
 * An Ask run, refused a write by the tool list and the guard, not by its prompt.
 *
 * The engine is handed reading and searching only, so it has no tool that writes. The guard behind it
 * is the one every read-only phase gets: a write outside the card folder and every command are refused.
 */
it('hands an Ask run no tool that writes, and a guard that refuses a write to the project and every command', async () => {
  const seen = await childEnv((at) => ({ phase: 'ask', tools: ['Read', 'Grep', 'Glob'], taskDir: join(at, '.tasks', 'APP-1') }), {});
  const task = seen.NOLZU_TASK_DIR ?? '';
  const project = resolve(task, '..', '..');

  expect(seen.NOLZU_READ_ONLY).toBe('1');
  expect(seen.NOLZU_KNOWLEDGE_DIR).toBeNull();
  expect(seen.NOLZU_ALLOW_COMMANDS).toBeNull();
  expect(guardAnswer(seen, join(project, 'services', 'api', 'src', 'recipes', 'list.ts'))).toBe(2);
  expect(guardAnswer(seen, join(project, '.nolzu', 'knowledge', 'recipes.md'))).toBe(2);
  expect(commandAnswer(seen, 'rm -rf services')).toBe(2);
  expect(commandAnswer(seen, 'git commit -am notes')).toBe(2);

  const binary = makeStub(`process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }) + String.fromCharCode(10));`);
  const [line] = await collect(binary, { phase: 'ask', tools: ['Read', 'Grep', 'Glob'] });
  const argv = (JSON.parse(line ?? '{}') as { argv: string[] }).argv;
  expect(argv[argv.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
});

// An Ask writes no notes, and the wall holds it like every read-only phase.
it('starts an Ask on Codex in the checkout inside the wall', async () => {
  const binary = makeStub(CODEX_WHERE_STUB);

  await runCodex(binary, { phase: 'ask', tools: ['Read', 'Grep', 'Glob'] });

  const [where, args] = readFileSync(join(cwd, 'where.txt'), 'utf8').split('\n');
  expect(where).toBe(realpathSync(cwd));
  expect(args).toContain('sandbox_mode="danger-full-access"');
  expect(args).not.toContain('--add-dir');
  expect(args).not.toContain('workspace-write');
});

// Nolzu stops an engine that stays up after its result, and what the engine said on stderr still goes
// into the run's log: a sandbox refusal, or the wall's note of a file the run left in the checkout.
it('hands over the lines read off stderr when Nolzu stops the engine', async () => {
  const binary = makeStub(`
    process.stderr.write('refused: write to src/a.ts');
    process.stdout.write('first' + String.fromCharCode(10));
    setInterval(() => {}, 1000);
  `);
  const stop = new AbortController();
  const lines: string[] = [];

  for await (const line of runProcess({ name: 'Stub', binary, args: [], cwd, env: { ...process.env } as Record<string, string>, stdin: '', killGraceMs: 200, afterExit: (stderr) => (stderr === '' ? [] : [`stderr: ${stderr}`]) }, stop.signal)) {
    lines.push(line);
    if (line === 'first') stop.abort();
  }

  expect(lines).toEqual(['first', 'stderr: refused: write to src/a.ts']);
}, 15000);

const plainRule = { tools: [], secretEnv: [], secretHeaders: [], cwd: null };

it("writes the run's servers into the copy's .cursor/mcp.json, keeping the project's other servers", () => {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-browser-'));
  try {
    const copy = join(dir, 'copy');
    mkdirSync(join(copy, '.cursor'), { recursive: true });
    const theirs = JSON.stringify({ mcpServers: { theirs: { command: 'x' }, playwright: { command: 'old' } } });
    writeFileSync(join(copy, '.cursor', 'mcp.json'), theirs);
    const mcp = { stdio: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'], env: {} } }, remote: {}, rules: { playwright: plainRule }, dir: join(dir, 'mcp-runs', '1') };
    // The copy sits in the data folder, outside the project.
    const job = { mcpConfigPath: null, qaCopy: copy, cwd: dir, projectDir: join(dir, 'project'), mcp } as unknown as Job;

    const made = cursorMcp(job);
    expect(made).not.toBeNull();
    expect(JSON.parse(readFileSync(join(copy, '.cursor', 'mcp.json'), 'utf8')).mcpServers).toEqual({
      theirs: { command: 'x' },
      playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], env: {} },
    });
    // The project's own file comes back after the run.
    made?.restore();
    expect(readFileSync(join(copy, '.cursor', 'mcp.json'), 'utf8')).toBe(theirs);
    expect(cursorMcp({ mcpConfigPath: null, qaCopy: copy } as Job)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A server's secret reaches Cursor's file as a reference only. A `.cursor` Nolzu makes ignores itself; one that was
// there gets Nolzu's exclude line alone. A crash leaves a record the next start puts back from.
describe("Cursor's merge in a card's checkout", () => {
  const servers = (dir: string) => ({
    stdio: { db: { command: 'db-mcp', args: [], env: { DB_LOGIN: 'hunter2' } }, notes: { command: 'notes-mcp', args: [], env: { LEVEL: '1' } } },
    remote: { docs: { url: 'https://mcp.example.com/sse', transport: 'sse' as const, headers: { 'X-Team': 'web' } } },
    rules: { db: { ...plainRule, secretEnv: ['DB_LOGIN'] }, notes: plainRule, docs: plainRule },
    dir,
  });
  let dir = '';
  const repo = () => {
    const checkout = join(dir, 'worktree');
    mkdirSync(join(checkout, '.git', 'info'), { recursive: true });
    writeFileSync(join(checkout, '.git', 'info', 'exclude'), '/worktrees/\n');
    return checkout;
  };
  const exclude = () => readFileSync(join(dir, 'worktree', '.git', 'info', 'exclude'), 'utf8');
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cursor-mcp-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('starts a server that names a folder in it, since Cursor takes no folder', () => {
    const checkout = repo();
    const mcp = { ...servers(join(dir, 'mcp-runs', '8')), rules: { db: { ...plainRule, secretEnv: ['DB_LOGIN'] }, notes: { ...plainRule, cwd: '/work/tools' }, docs: plainRule } };
    const made = cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: checkout, mcp } as unknown as Job);
    expect(JSON.parse(readFileSync(join(checkout, '.cursor', 'mcp.json'), 'utf8')).mcpServers.notes).toEqual({
      type: 'stdio',
      command: '/bin/sh',
      args: ['-c', 'cd "$0" && exec "$@"', '/work/tools', 'notes-mcp'],
      env: { LEVEL: '1' },
    });
    made?.restore();
  });

  it('merges a secret as a reference with its value apart, and a .cursor it made ignores itself', () => {
    const checkout = repo();
    const runDir = join(dir, 'mcp-runs', '7');
    const env = cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: checkout, mcp: servers(runDir) } as unknown as Job)?.env ?? {};
    const [variable] = Object.keys(env);
    expect(variable).toMatch(/^NOLZU_MCP_SECRET_[0-9a-f]{16}_0$/);
    expect(env).toEqual({ [variable ?? '']: 'hunter2' });
    const written = readFileSync(join(checkout, '.cursor', 'mcp.json'), 'utf8');
    expect(written).not.toContain('hunter2');
    expect(JSON.parse(written).mcpServers).toEqual({
      db: { type: 'stdio', command: 'db-mcp', args: [], env: { DB_LOGIN: `\${env:${variable}}` } },
      notes: { type: 'stdio', command: 'notes-mcp', args: [], env: { LEVEL: '1' } },
      docs: { url: 'https://mcp.example.com/sse', headers: { 'X-Team': 'web' } },
    });
    expect(readFileSync(join(checkout, '.cursor', '.gitignore'), 'utf8')).toBe('/mcp.json\n/.gitignore\n');
    expect(exclude()).toBe('/worktrees/\n');

    // The process died before its own restore: the next start reads the record.
    expect(restoreCursorMcp(runDir)).toBe(true);
    expect(existsSync(join(checkout, '.cursor'))).toBe(false);
    expect(restoreCursorMcp(runDir)).toBe(false);

    // A file another tool put in the folder meanwhile keeps the folder, and only Nolzu's two files go.
    const again = join(dir, 'mcp-runs', '8');
    cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: checkout, mcp: servers(again) } as unknown as Job);
    writeFileSync(join(checkout, '.cursor', 'rules.md'), 'theirs');
    restoreCursorMcp(again);
    expect(readdirSync(join(checkout, '.cursor'))).toEqual(['rules.md']);
  });

  // A name known before the run could be named by a plain value of another entry Cursor loads.
  it('gives each run its own secret names', () => {
    const checkout = repo();
    const names = ['5', '6'].map((id) => {
      const made = cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: checkout, mcp: servers(join(dir, 'mcp-runs', id)) } as unknown as Job);
      made?.restore();
      return Object.keys(made?.env ?? {})[0];
    });
    expect(names[0]).toMatch(/^NOLZU_MCP_SECRET_[0-9a-f]{16}_0$/);
    expect(names[1]).not.toBe(names[0]);
  });

  it('adds only its own exclude line to a .cursor that was there, keeps it while another run needs it, and keeps an edit', () => {
    const checkout = repo();
    mkdirSync(join(checkout, '.cursor'));
    const second = join(dir, 'worktree2');
    mkdirSync(join(second, '.cursor'), { recursive: true });
    // A second checkout of the same repository, as a worktree points at the main `.git`.
    writeFileSync(join(second, '.git'), `gitdir: ${join(checkout, '.git')}\n`);
    const one = join(dir, 'mcp-runs', '1');
    const two = join(dir, 'mcp-runs', '2');
    cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: checkout, mcp: servers(one) } as unknown as Job);
    cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: second, mcp: servers(two) } as unknown as Job);
    expect(exclude()).toBe('/worktrees/\n/.cursor/mcp.json\n');
    // The person adds a line while the runs go.
    writeFileSync(join(checkout, '.git', 'info', 'exclude'), `${exclude()}/build/\n`);

    restoreCursorMcp(one);
    expect(exclude()).toBe('/worktrees/\n/.cursor/mcp.json\n/build/\n');
    restoreCursorMcp(two);
    expect(exclude()).toBe('/worktrees/\n/build/\n');
    expect(existsSync(join(checkout, '.cursor'))).toBe(true);
    expect(existsSync(join(checkout, '.cursor', 'mcp.json'))).toBe(false);
  });

  it('never takes out an exclude line the person wrote before', () => {
    const checkout = repo();
    mkdirSync(join(checkout, '.cursor'));
    writeFileSync(join(checkout, '.git', 'info', 'exclude'), '/.cursor/mcp.json\n');
    const runDir = join(dir, 'mcp-runs', '3');
    cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: checkout, mcp: servers(runDir) } as unknown as Job);
    restoreCursorMcp(runDir);
    expect(exclude()).toBe('/.cursor/mcp.json\n');
  });

  // The run went between the merge and the restore, and could put a link where Nolzu writes or
  // removes. Nothing outside the checkout changes, whatever the link points at.
  describe('with a link the run left', () => {
    const outside = () => {
      const away = join(dir, 'away');
      mkdirSync(away, { recursive: true });
      writeFileSync(join(away, 'mcp.json'), 'mine\n');
      writeFileSync(join(away, '.gitignore'), 'mine\n');
      writeFileSync(join(away, 'exclude'), '/.cursor/mcp.json\nmine\n');
      return away;
    };
    const kept = (away: string) => {
      for (const name of ['mcp.json', '.gitignore']) expect(readFileSync(join(away, name), 'utf8')).toBe('mine\n');
      expect(readFileSync(join(away, 'exclude'), 'utf8')).toBe('/.cursor/mcp.json\nmine\n');
    };

    // Every way the restore touches the file: the bytes from before, a removal when there were none, and
    // a file changed meanwhile that loses only Nolzu's servers.
    it('writes and removes nothing through a link at the merged file or at the .cursor folder', () => {
      for (const at of ['file', 'folder'] as const) {
        for (const had of [true, false]) {
          for (const target of ['same', 'changed'] as const) {
            const checkout = repo();
            if (had) {
              mkdirSync(join(checkout, '.cursor'));
              writeFileSync(join(checkout, '.cursor', 'mcp.json'), '{"mcpServers":{}}\n');
            }
            const away = outside();
            const runDir = join(dir, 'mcp-runs', `${at}-${had}-${target}`);
            cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: checkout, mcp: servers(runDir) } as unknown as Job);
            const theirs = target === 'same' ? readFileSync(join(checkout, '.cursor', 'mcp.json'), 'utf8') : '{"mcpServers":{"db":{},"mine":{}}}\n';
            writeFileSync(join(away, 'mcp.json'), theirs);
            if (at === 'file') {
              rmSync(join(checkout, '.cursor', 'mcp.json'));
              symlinkSync(join(away, 'mcp.json'), join(checkout, '.cursor', 'mcp.json'));
            } else {
              rmSync(join(checkout, '.cursor'), { recursive: true });
              symlinkSync(away, join(checkout, '.cursor'));
            }

            expect(restoreCursorMcp(runDir)).toBe(true);
            expect(readFileSync(join(away, 'mcp.json'), 'utf8')).toBe(theirs);
            expect(readFileSync(join(away, '.gitignore'), 'utf8')).toBe('mine\n');
            rmSync(dir, { recursive: true, force: true });
            mkdirSync(dir);
          }
        }
      }
    });

    it('rewrites no exclude file through a link, at the file, the info folder or the git folder', () => {
      for (const at of ['file', 'info', 'git'] as const) {
        const checkout = repo();
        mkdirSync(join(checkout, '.cursor'));
        const away = outside();
        const runDir = join(dir, 'mcp-runs', `exclude-${at}`);
        cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: checkout, mcp: servers(runDir) } as unknown as Job);
        expect(exclude()).toContain('/.cursor/mcp.json');
        if (at === 'file') {
          rmSync(join(checkout, '.git', 'info', 'exclude'));
          symlinkSync(join(away, 'exclude'), join(checkout, '.git', 'info', 'exclude'));
        } else {
          // The info folder, or the whole git folder, swapped for a link to one of the same shape.
          const swapped = at === 'info' ? join(checkout, '.git', 'info') : join(checkout, '.git');
          const there = at === 'info' ? join(away, 'info') : join(away, 'git');
          rmSync(swapped, { recursive: true });
          mkdirSync(join(away, 'git', 'info'), { recursive: true });
          mkdirSync(join(away, 'info'), { recursive: true });
          writeFileSync(join(away, 'info', 'exclude'), '/.cursor/mcp.json\nmine\n');
          writeFileSync(join(away, 'git', 'info', 'exclude'), '/.cursor/mcp.json\nmine\n');
          symlinkSync(there, swapped);
        }

        restoreCursorMcp(runDir);
        kept(away);
        if (at !== 'file') expect(readFileSync(join(away, at === 'info' ? 'info' : 'git/info', 'exclude'), 'utf8')).toBe('/.cursor/mcp.json\nmine\n');
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir);
      }
    });

    // A link an earlier run with no wall left at the exclude file stops this run before it starts,
    // and the merge goes back at once.
    it('starts no run when the exclude file is a link, and puts the merge back', () => {
      const checkout = repo();
      mkdirSync(join(checkout, '.cursor'));
      const away = outside();
      rmSync(join(checkout, '.git', 'info', 'exclude'));
      writeFileSync(join(away, 'exclude'), 'mine\n');
      symlinkSync(join(away, 'exclude'), join(checkout, '.git', 'info', 'exclude'));
      const runDir = join(dir, 'mcp-runs', 'start');

      expect(() => cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: checkout, mcp: servers(runDir) } as unknown as Job)).toThrow('is a link or a pipe');
      expect(readFileSync(join(away, 'exclude'), 'utf8')).toBe('mine\n');
      expect(existsSync(join(checkout, '.cursor', 'mcp.json'))).toBe(false);
      expect(existsSync(join(runDir, CURSOR_RECORD))).toBe(false);
    });
  });

  // The restore reads the merged file and the exclude file after the run went, and must neither read
  // through a link there nor hold the app on a named pipe.
  it('reads no merged file or exclude file through a link, and answers at once for a pipe', () => {
    for (const shape of ['link', 'pipe'] as const) {
      const checkout = repo();
      // A `.cursor` folder that was there, so the run adds its exclude line and the restore reads the file.
      mkdirSync(join(checkout, '.cursor'));
      const runDir = join(dir, 'mcp-runs', `read-${shape}`);
      cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: checkout, mcp: servers(runDir) } as unknown as Job);
      // What a person's file outside could hold: one of Nolzu's server names, so a read of it would
      // lead the restore to write the file back without that server.
      const away = join(dir, 'away');
      mkdirSync(away, { recursive: true });
      writeFileSync(join(away, 'mcp.json'), '{"mcpServers":{"db":{},"mine":{}}}\n');
      writeFileSync(join(away, 'exclude'), '/.cursor/mcp.json\nmine\n');
      for (const [file, target] of [[join(checkout, '.cursor', 'mcp.json'), join(away, 'mcp.json')], [join(checkout, '.git', 'info', 'exclude'), join(away, 'exclude')]] as const) {
        rmSync(file);
        if (shape === 'link') symlinkSync(target, file);
        else execFileSync('mkfifo', [file]);
      }
      expect(restoreCursorMcp(runDir)).toBe(true);
      expect(readFileSync(join(away, 'mcp.json'), 'utf8')).toBe('{"mcpServers":{"db":{},"mine":{}}}\n');
      // Read as no file, as there was none before the merge: the link goes as a link.
      if (shape === 'link') expect(lstatSync(join(checkout, '.cursor', 'mcp.json'), { throwIfNoEntry: false })).toBeUndefined();
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
    }
  }, 10_000);

  it('skips a file whose folder is gone and still drops the record', () => {
    const runDir = join(dir, 'mcp-runs', '4');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, CURSOR_RECORD), JSON.stringify({ file: join(dir, 'gone', '.cursor', 'mcp.json'), before: Buffer.from('x').toString('base64'), madeFolder: null, exclude: join(dir, 'gone', '.git', 'info', 'exclude'), added: true }));
    expect(restoreCursorMcp(runDir)).toBe(true);
    expect(existsSync(join(runDir, CURSOR_RECORD))).toBe(false);
    expect(existsSync(join(dir, 'gone'))).toBe(false);
  });
});

// Cursor reads `.cursor/mcp.json` at the nearest git root above where it starts. A Research card starts
// in its card folder, which holds checkouts and no `.git`, so its servers go into the project folder's
// file, and two such runs take turns at it.
describe("Cursor's merge where Cursor reads it", () => {
  let dir = '';
  let project = '';
  let card = '';
  const servers = (id: string) => ({
    stdio: { catalog: { command: 'node', args: ['catalog.ts'], env: { CATALOG_KEY: 'k-123' } } },
    remote: {},
    rules: { catalog: { ...plainRule, secretEnv: ['CATALOG_KEY'] } },
    dir: join(dir, 'mcp-runs', id),
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cursor-root-'));
    project = join(dir, 'Toolshed');
    mkdirSync(join(project, '.git', 'info'), { recursive: true });
    card = join(project, 'worktrees', 'Q-1');
    mkdirSync(join(card, 'repo'), { recursive: true });
    writeFileSync(join(card, 'repo', '.git'), 'gitdir: elsewhere\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds the folder Cursor reads from as its CLI does', () => {
    expect(cursorRoot(card)).toBe(project);
    expect(cursorRoot(join(card, 'repo'))).toBe(join(card, 'repo'));
    const loose = join(dir, 'loose', 'deep');
    mkdirSync(loose, { recursive: true });
    expect(cursorRoot(loose)).toBe(loose);
  });

  it("merges a Research card's servers into the project folder's file and puts it back", () => {
    // A job that names no project folder keeps to the folder it starts in.
    expect(cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: card, mcp: servers('0') } as unknown as Job)).toBeNull();
    expect(cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: card, projectDir: join(dir, 'other'), mcp: servers('0') } as unknown as Job)).toBeNull();
    // A project path with a trailing slash names the same folder.
    const made = cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: card, projectDir: `${project}/`, mcp: servers('1') } as unknown as Job);
    expect(Object.keys(JSON.parse(readFileSync(join(project, '.cursor', 'mcp.json'), 'utf8')).mcpServers)).toEqual(['catalog']);
    expect(existsSync(join(card, '.cursor'))).toBe(false);
    made?.restore();
    expect(existsSync(join(project, '.cursor'))).toBe(false);
  });

  // The file sits in the person's own folder for the whole run, and Cursor's settings write it too.
  it('keeps a change made to the file during the run, and takes out only its own servers', () => {
    const file = join(project, '.cursor', 'mcp.json');
    mkdirSync(join(project, '.cursor'));
    writeFileSync(file, JSON.stringify({ mcpServers: { catalog: { command: 'theirs' }, notes: { command: 'notes' } } }));
    const made = cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: card, projectDir: project, mcp: servers('3') } as unknown as Job);
    const during = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...during, mcpServers: { ...during.mcpServers, mine: { command: 'mine' } } }));
    made?.restore();
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers).toEqual({ catalog: { command: 'theirs' }, notes: { command: 'notes' }, mine: { command: 'mine' } });

    // Nothing of its own left to take out of a file that does not parse, so it stays as it is.
    const again = cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: card, projectDir: project, mcp: servers('4') } as unknown as Job);
    writeFileSync(file, '{ broken');
    again?.restore();
    expect(readFileSync(file, 'utf8')).toBe('{ broken');
  });

  it("never writes the person's own Cursor config", () => {
    vi.stubEnv('HOME', project);
    try {
      expect(cursorMcp({ mcpConfigPath: null, qaCopy: null, cwd: card, projectDir: project, mcp: servers('2') } as unknown as Job)).toBeNull();
      expect(existsSync(join(project, '.cursor'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('lets two runs with servers in one project take turns at the file', async () => {
    const seen = join(dir, 'seen.txt');
    const binary = makeStub(`
      const fs = require('node:fs');
      if (process.argv.includes('--list-models')) { console.log('composer-2.5 - Composer 2.5'); process.exit(0); }
      const file = ${JSON.stringify(join(project, '.cursor', 'mcp.json'))};
      fs.appendFileSync(${JSON.stringify(seen)}, 'start ' + Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers).join(',') + '\\n');
      setTimeout(() => {
        fs.appendFileSync(${JSON.stringify(seen)}, 'end\\n');
        console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
      }, 300);
    `);
    const run = async (runId: number) => {
      const lines: string[] = [];
      const one = { ...job(), runId, engine: 'cursor', phase: 'research', model: 'composer-2.5', cwd: card, projectDir: project, taskDir: join(project, '.tasks', 'Q-1'), mcp: servers(String(runId)) } as unknown as Job;
      for await (const line of spawnCursor(binary, one, new AbortController().signal)) lines.push(line);
      return lines;
    };

    const [first, second] = await Promise.all([run(1), run(2)]);

    expect(readFileSync(seen, 'utf8')).toBe('start catalog\nend\nstart catalog\nend\n');
    expect(first.join('\n')).not.toContain('Waits for another Cursor run');
    expect(second[0]).toContain('Waits for another Cursor run to end');
    expect(existsSync(join(project, '.cursor'))).toBe(false);
  }, 20000);

  it('lets a run stopped while it waits end at once, without starting', async () => {
    const seen = join(dir, 'seen.txt');
    const binary = makeStub(`
      const fs = require('node:fs');
      if (process.argv.includes('--list-models')) { console.log('composer-2.5 - Composer 2.5'); process.exit(0); }
      fs.appendFileSync(${JSON.stringify(seen)}, 'start\\n');
      setTimeout(() => console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })), 1500);
    `);
    const run = async (runId: number, signal: AbortSignal) => {
      const one = { ...job(), runId, engine: 'cursor', phase: 'research', model: 'composer-2.5', cwd: card, projectDir: project, taskDir: join(project, '.tasks', 'Q-1'), mcp: servers(String(runId)) } as unknown as Job;
      for await (const line of spawnCursor(binary, one, signal)) void line;
      return Date.now();
    };
    const stop = new AbortController();
    const first = run(1, new AbortController().signal);
    const second = run(2, stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop.abort();
    const [firstEnd, secondEnd] = await Promise.all([first, second]);

    expect(secondEnd).toBeLessThan(firstEnd);
    expect(readFileSync(seen, 'utf8')).toBe('start\n');
    // It never merged: its run folder was never made.
    expect(existsSync(join(dir, 'mcp-runs', '2'))).toBe(false);
  }, 20000);

  // The stopped run's place goes, and the run after it still waits for the one holding the file.
  it('keeps the next run waiting for the holder when one in between stops', async () => {
    const seen = join(dir, 'seen.txt');
    const binary = makeStub(`
      const fs = require('node:fs');
      if (process.argv.includes('--list-models')) { console.log('composer-2.5 - Composer 2.5'); process.exit(0); }
      const id = process.env.NOLZU_RUN_MARK;
      fs.appendFileSync(${JSON.stringify(seen)}, 'start ' + id + '\\n');
      setTimeout(() => {
        fs.appendFileSync(${JSON.stringify(seen)}, 'end ' + id + '\\n');
        console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }));
      }, id === '1' ? 1200 : 100);
    `);
    const run = async (runId: number, signal: AbortSignal) => {
      const one = { ...job(), runId, engine: 'cursor', phase: 'research', model: 'composer-2.5', cwd: card, projectDir: project, taskDir: join(project, '.tasks', 'Q-1'), mcp: servers(String(runId)) } as unknown as Job;
      for await (const line of spawnCursor(binary, one, signal, { env: { ...process.env, NOLZU_RUN_MARK: String(runId) } as Record<string, string> })) void line;
    };
    const stop = new AbortController();
    const first = run(1, new AbortController().signal);
    const second = run(2, stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop.abort();
    await second;
    await run(3, new AbortController().signal);
    await first;

    expect(readFileSync(seen, 'utf8')).toBe('start 1\nend 1\nstart 3\nend 3\n');
  }, 20000);

  // The quiet timeout stops a run that prints nothing, and one that only waits is not hung.
  it('says now and then that it still waits', async () => {
    const binary = makeStub(`
      if (process.argv.includes('--list-models')) { console.log('composer-2.5 - Composer 2.5'); process.exit(0); }
      setTimeout(() => console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'done' })), 900);
    `);
    const run = async (runId: number) => {
      const lines: string[] = [];
      const one = { ...job(), runId, engine: 'cursor', phase: 'research', model: 'composer-2.5', cwd: card, projectDir: project, timeoutMs: 400, taskDir: join(project, '.tasks', 'Q-1'), mcp: servers(String(runId)) } as unknown as Job;
      for await (const line of spawnCursor(binary, one, new AbortController().signal)) lines.push(line);
      return lines;
    };

    const [, second] = await Promise.all([run(1), run(2)]);

    expect(second.filter((line) => line.includes('Still waits for the other Cursor run')).length).toBeGreaterThanOrEqual(2);
  }, 20000);
});

// A caller that stops reading early, as a run whose log cannot be written does, still gets the check
// after the run, or what the run left would read as the state before the next one.
it('runs the check after the run when the caller stops reading early', async () => {
  const binary = makeStub(`process.stdout.write('first' + String.fromCharCode(10)); setTimeout(() => {}, 200);`);
  let checked = 0;
  const read = async () => {
    for await (const line of runProcess({ name: 'Stub', binary, args: [], cwd, env: { ...process.env } as Record<string, string>, stdin: '', killGraceMs: 200, afterRun: () => ((checked += 1), 'left a hook') }, new AbortController().signal)) {
      if (line === 'first') break;
    }
  };
  await expect(read()).rejects.toThrow('left a hook');
  expect(checked).toBe(1);

  // Read to the end, it runs once too.
  checked = 0;
  for await (const line of runProcess({ name: 'Stub', binary, args: [], cwd, env: { ...process.env } as Record<string, string>, stdin: '', killGraceMs: 200, afterRun: () => ((checked += 1), null) }, new AbortController().signal)) void line;
  expect(checked).toBe(1);
}, 15000);

// Node quotes a bad env value in its error, and that value may be a secret.
it('names no env value when a null byte stops the start', async () => {
  const run = async () => {
    for await (const line of runProcess({ name: 'Stub', binary: process.execPath, args: [], cwd, env: { ...process.env, LOGIN: 'hunter2\0' } as Record<string, string>, stdin: '' }, new AbortController().signal)) void line;
  };
  const error = await run().catch((caught: Error) => caught);
  expect(String(error)).toContain('holds a null byte');
  expect(String(error)).not.toContain('hunter2');
});

// Claude Code's config goes on its init message, before any tool call: every line passes `onLine`
// before it is handed on, and `claudeInit` knows the init message.
it('hands each line to onLine before the caller gets it, and knows the init message', async () => {
  const binary = makeStub(`
    process.stdout.write('one' + String.fromCharCode(10) + 'two' + String.fromCharCode(10));
  `);
  const seen: string[] = [];
  for await (const line of runProcess({ name: 'Stub', binary, args: [], cwd, env: { ...process.env } as Record<string, string>, stdin: '', onLine: (line) => seen.push(`saw ${line}`) }, new AbortController().signal)) seen.push(line);
  expect(seen).toEqual(['saw one', 'one', 'saw two', 'two']);
  expect(claudeInit(JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [] }))).toBe(true);
  expect(claudeInit(JSON.stringify({ type: 'system', subtype: 'hook_response' }))).toBe(false);
  expect(claudeInit('not json')).toBe(false);
});

// A stop that came while the caller read Nolzu's first line starts no engine at all: the binary is not
// even looked for, so a missing one raises nothing.
it('starts no process when the stop came during the first line', async () => {
  const stop = new AbortController();
  const out: string[] = [];
  for await (const line of runProcess({ name: 'Stub', binary: join(cwd, 'no-such-engine'), args: [], cwd, env: { ...process.env } as Record<string, string>, stdin: '', firstLine: 'walled' }, stop.signal)) {
    out.push(line);
    stop.abort();
  }
  expect(out).toEqual(['walled']);
});
