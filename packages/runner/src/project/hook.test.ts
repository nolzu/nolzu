import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PHASE_GUARD } from './hook.ts';

let dir = '';
let guard = '';

beforeEach(() => {
  // Resolved, because a temp folder on macOS is a symlink into /private and the child's own
  // working directory is the real path. Without this the test and the guard disagree about where
  // the project is, and a guard that allowed its working directory looked correct here.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'nolzu-hook-')));
  guard = join(dir, 'guard.mjs');
  writeFileSync(guard, PHASE_GUARD);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Runs the hook the way the engine does: the payload on stdin, the answer in the exit code.
function ask(payload: unknown, env: Record<string, string> = {}, cwd = dir): { code: number; stderr: string } {
  try {
    execFileSync(process.execPath, [guard], {
      input: JSON.stringify(payload),
      env: { ...process.env, ...env },
      // The guard runs where the engine runs, which is the card's checkout inside the project.
      // Running it from the repository root instead hid a whole class of mistake: a guard that
      // allowed its own working directory would have let a read-only phase write the project's
      // source, and every test here would still have passed.
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { code: failure.status ?? -1, stderr: failure.stderr ?? '' };
  }
}

const write = (path: string) => ({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path } });

const readOnly = (taskDir: string) => ({ NOLZU_READ_ONLY: '1', NOLZU_TASK_DIR: taskDir });

it('allows a write inside the card folder', () => {
  const task = join(dir, '.tasks', 'APP-1');

  expect(ask(write(join(task, 'refine', 'refined.md')), readOnly(task)).code).toBe(0);
});

// Exit 2 is what blocks a call. A hook that never refuses anything would pass every other test
// here, which is why this one matters most.
it('refuses a write to the project source in a read-only phase', () => {
  const task = join(dir, '.tasks', 'APP-1');
  const answer = ask(write(join(dir, 'src', 'list.ts')), readOnly(task));

  expect(answer.code).toBe(2);
  expect(answer.stderr).toContain('src/list.ts');
});

describe('a phase that may run a command', () => {
  const allowed = (taskDir: string) => ({ ...readOnly(taskDir), NOLZU_ALLOW_COMMANDS: '1' });
  const bash = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'pnpm test' } };

  // QA runs the project's own checks, so it gets a command. It still may not edit the source,
  // which is what the guard is for: a run that fixed what it found would leave nobody able to say
  // the card ever worked.
  it('runs a command and is still refused a write to the source', () => {
    const task = join(dir, '.tasks', 'APP-1');

    expect(ask(bash, allowed(task)).code).toBe(0);
    expect(ask(write(join(dir, 'src', 'list.ts')), allowed(task)).code).toBe(2);
    expect(ask(write(join(task, 'qa', 'report.md')), allowed(task)).code).toBe(0);
  });

  // The other side. Without the flag a guarded phase gets no command at all, which is every
  // phase but QA.
  it('refuses a command to a phase that was not given one', () => {
    expect(ask(bash, readOnly(join(dir, '.tasks', 'APP-1'))).code).toBe(2);
  });
});

describe('the knowledge folder', () => {
  const knowledge = () => join(dir, '.nolzu', 'knowledge');
  const withKnowledge = (taskDir: string) => ({ ...readOnly(taskDir), NOLZU_KNOWLEDGE_DIR: knowledge() });

  // A wrap-up writes outside the card folder by design, and must still not touch the source. Both
  // sides of that in one place, because allowing the first and forgetting the second is the whole
  // risk.
  it('lets a knowledge run write knowledge and still refuses the source', () => {
    const task = join(dir, '.tasks', 'APP-1');

    expect(ask(write(join(knowledge(), 'importer.md')), withKnowledge(task)).code).toBe(0);
    expect(ask(write(join(task, 'wrapup', 'changes.md')), withKnowledge(task)).code).toBe(0);
    expect(ask(write(join(dir, 'src', 'list.ts')), withKnowledge(task)).code).toBe(2);
  });

  // Without the variable the folder is nobody's business, which is every other phase.
  it('refuses the knowledge folder to a phase that was not given it', () => {
    const task = join(dir, '.tasks', 'APP-1');

    expect(ask(write(join(knowledge(), 'importer.md')), readOnly(task)).code).toBe(2);
  });

  it('refuses a sibling of the knowledge folder with a longer name', () => {
    const task = join(dir, '.tasks', 'APP-1');
    const answer = ask(write(`${knowledge()}-other/importer.md`), withKnowledge(task));

    expect(answer.code).toBe(2);
  });

  // Correcting a knowledge file needs Edit, and a knowledge run still gets no command.
  it('allows an edit and refuses a command', () => {
    const task = join(dir, '.tasks', 'APP-1');
    const edit = { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(knowledge(), 'importer.md') } };
    const bash = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } };

    expect(ask(edit, withKnowledge(task)).code).toBe(0);
    expect(ask(bash, withKnowledge(task)).code).toBe(2);
  });

  it('names both folders when it refuses', () => {
    const task = join(dir, '.tasks', 'APP-1');
    const answer = ask(write(join(dir, 'src', 'list.ts')), withKnowledge(task));

    expect(answer.stderr).toContain(task);
    expect(answer.stderr).toContain(knowledge());
  });
});

// A card on one repository of several starts in that repository's checkout inside the card root.
describe('a run that starts in one repository of the card', () => {
  const task = () => join(dir, '.tasks', 'APP-1');
  const repo = () => join(dir, 'worktrees', 'APP-1', 'api');
  beforeEach(() => mkdirSync(repo(), { recursive: true }));

  it('lets an implement write in the repository checkout, by full or relative path', () => {
    expect(ask(write(join(repo(), 'src', 'search.ts')), {}, repo()).code).toBe(0);
    expect(ask(write('src/search.ts'), {}, repo()).code).toBe(0);
  });

  it('lets QA run a command and write its card folder, and still refuses the source', () => {
    const qa = { ...readOnly(task()), NOLZU_ALLOW_COMMANDS: '1' };
    const bash = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } };

    expect(ask(bash, qa, repo()).code).toBe(0);
    expect(ask(write(join(task(), 'qa', 'report.md')), qa, repo()).code).toBe(0);
    expect(ask(write('src/search.ts'), qa, repo()).code).toBe(2);
  });
});

it('allows everything when the phase is not read-only', () => {
  expect(ask(write(join(dir, 'src', 'list.ts'))).code).toBe(0);
});

// Built by hand rather than with join, because join collapses the climb itself and the payload
// would then never carry one. Left uncollapsed, the string still starts with the card folder, so
// a guard that compares the path as written lets the write through.
it('refuses a path that climbs out of the card folder', () => {
  const task = join(dir, '.tasks', 'APP-1');
  const climbing = `${task}/../APP-2/notes.md`;

  expect(climbing).toContain('..');
  expect(ask(write(climbing), readOnly(task)).code).toBe(2);
});

// A folder whose name merely starts with the card folder's name is not inside it.
it('refuses a sibling folder with a longer name', () => {
  const task = join(dir, '.tasks', 'APP-1');

  expect(ask(write(`${task}-other/notes.md`), readOnly(task)).code).toBe(2);
});

it('refuses a command in a read-only phase, because a command can write anything', () => {
  const task = join(dir, '.tasks', 'APP-1');
  const answer = ask(
    { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf src' } },
    readOnly(task),
  );

  expect(answer.code).toBe(2);
});

it('says yes to a tool it does not know rather than blocking the run', () => {
  const task = join(dir, '.tasks', 'APP-1');

  expect(ask({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/anywhere' } }, readOnly(task)).code).toBe(0);
});

// Nothing on stdout, because a decision printed there would be parsed as JSON, and anything a
// shell profile prints would corrupt it. The exit code carries the answer instead.
it('prints nothing on stdout', () => {
  const task = join(dir, '.tasks', 'APP-1');
  const out = execFileSync(process.execPath, [guard], {
    input: JSON.stringify(write(join(task, 'notes.md'))),
    env: { ...process.env, ...readOnly(task) },
    encoding: 'utf8',
  });

  expect(out).toBe('');
});
