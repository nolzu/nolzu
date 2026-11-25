import type { Job } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { claudeArgs } from './claude-args.ts';

const job = (over: Partial<Job> = {}): Job => ({
  runId: 1,
  cardKey: 'APP-1',
  engine: 'claude-code',
  phase: 'refine',
  cwd: '/tmp/demo/worktrees/APP-1',
  taskDir: '/tmp/demo/.tasks/APP-1',
  prompt: 'Refine the ticket.',
  model: 'sonnet',
  effort: 'low',
  sessionId: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7',
  resumeFrom: null,
  timeoutMs: 30 * 60 * 1000,
  logPath: '/tmp/data/logs/1.ndjson',
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read', 'Grep', 'Glob'],
  ...over,
});

it('builds the whole argument list for a fresh run', () => {
  expect(claudeArgs(job())).toEqual([
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    '--permission-mode',
    'acceptEdits',
    '--add-dir',
    '/tmp/demo/.tasks/APP-1',
    '--model',
    'sonnet',
    '--effort',
    'low',
    '--tools',
    'Read,Grep,Glob',
    '--session-id',
    '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7',
  ]);
});

it('keeps both isolation flags in the list, named', () => {
  // Measured: without these a run loaded 141 tools, 22 MCP servers and the user's own
  // session hooks wrote lines into the stream. Asserting them by name means removing one
  // fails here rather than quietly on someone's machine.
  const args = claudeArgs(job());
  expect(args).toContain('--strict-mcp-config');
  expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual([
    '--setting-sources',
    'project',
  ]);
});

it('never passes safe mode, because it blocks the project skills the pipeline needs', () => {
  expect(claudeArgs(job())).not.toContain('--safe-mode');
  // bare mode reads only an API key and never the subscription login.
  expect(claudeArgs(job())).not.toContain('--bare');
});

it('resumes a session instead of naming a new one', () => {
  const args = claudeArgs(job({ sessionId: null, resumeFrom: 'b41e9a07-5c3d-4f28-8e6a-1d0c7b2f4e02' }));
  expect(args).toContain('--resume');
  expect(args).toContain('b41e9a07-5c3d-4f28-8e6a-1d0c7b2f4e02');
  expect(args).not.toContain('--session-id');
});

it('refuses a job that names a session and a resume target together', () => {
  expect(() => claudeArgs(job({ resumeFrom: 'b41e9a07-5c3d-4f28-8e6a-1d0c7b2f4e02' }))).toThrow(/sessionId.*resumeFrom|resumeFrom.*sessionId/);
});

// Measured on Claude Code 2.1.278: a run working in a card's checkout reads neither the project's
// `.claude/settings.json` nor a `CLAUDE_PROJECT_DIR` that points at the project, so the guard has to
// be named by its path or it refuses nothing at all.
it('names the settings file that holds the guard', () => {
  const args = claudeArgs(job({ settingsPath: '/home/you/.nolzu/engine-settings.json' }));

  expect(args.slice(args.indexOf('--settings'), args.indexOf('--settings') + 2)).toEqual(['--settings', '/home/you/.nolzu/engine-settings.json']);
});

it('passes no settings file when there is none', () => {
  expect(claudeArgs(job({ settingsPath: null }))).not.toContain('--settings');
});

// Resolved against the card checkout, which is the one place it is not.
it('refuses a settings path that is not absolute', () => {
  expect(() => claudeArgs(job({ settingsPath: '.nolzu/engine-settings.json' }))).toThrow(/absolute/);
});

it('keeps strict mcp config even when the phase passes no config of its own', () => {
  const args = claudeArgs(job({ mcpConfigPath: null }));
  expect(args).toContain('--strict-mcp-config');
  expect(args).not.toContain('--mcp-config');
});

it('passes the config when the phase has one', () => {
  const args = claudeArgs(job({ mcpConfigPath: '/tmp/demo/.tasks/APP-1/mcp.json' }));
  expect(args.slice(args.indexOf('--mcp-config'), args.indexOf('--mcp-config') + 2)).toEqual([
    '--mcp-config',
    '/tmp/demo/.tasks/APP-1/mcp.json',
  ]);
});

// The run's servers in memory, as the loop hands them: a server by name, or each listed tool of it.
const rule = (tools: string[] = []) => ({ tools, secretEnv: [], secretHeaders: [], cwd: null });
const mcpOf = (names: string[], rules: Record<string, ReturnType<typeof rule>> = {}) => ({
  stdio: Object.fromEntries(names.map((name) => [name, { command: 'x', args: [], env: {} }])),
  remote: {},
  rules: { ...Object.fromEntries(names.map((name) => [name, rule()])), ...rules },
  dir: '/tmp/demo/mcp-runs/1',
});

it('allows the run servers by name, and none without a config', () => {
  const args = claudeArgs(job({ mcpConfigPath: '/tmp/demo/mcp.json', mcp: mcpOf(['playwright']) }));
  const at = args.indexOf('--allowedTools');
  expect(args.slice(at, at + 3)).toEqual(['--allowedTools', 'mcp__playwright', '--model']);

  expect(claudeArgs(job({ mcpConfigPath: null, mcp: mcpOf(['playwright']) }))).not.toContain('--allowedTools');
  expect(() => claudeArgs(job({ mcpConfigPath: '/tmp/demo/mcp.json', mcp: mcpOf(['-x']) }))).toThrow('MCP server name');
});

it('allows only the listed tools of a server that has a list', () => {
  const args = claudeArgs(job({ mcpConfigPath: '/tmp/demo/mcp.json', mcp: mcpOf(['db', 'docs'], { db: rule(['query', 'list']) }) }));
  const at = args.indexOf('--allowedTools');
  expect(args.slice(at, args.indexOf('--model'))).toEqual(['--allowedTools', 'mcp__db__query', 'mcp__db__list', 'mcp__docs']);
  expect(() => claudeArgs(job({ mcpConfigPath: '/tmp/demo/mcp.json', mcp: mcpOf(['db'], { db: rule(['-x']) }) }))).toThrow('MCP tool name');
});

it('never puts the prompt in the argument list', () => {
  // It goes to stdin, so it cannot appear in a process listing and cannot hit the argument
  // length limit.
  const prompt = 'x'.repeat(200 * 1024);
  const args = claudeArgs(job({ prompt }));
  expect(args.join(' ')).not.toContain('xxxx');
  expect(args.some((arg) => arg.length > 1000)).toBe(false);
});

it.each(['-sonnet', 'son net', 'sonnet\n'])('refuses the model %j, so a setting cannot inject a flag', (model) => {
  expect(() => claudeArgs(job({ model }))).toThrow(/model/i);
});

it('refuses a session id that could pass as a flag', () => {
  expect(() => claudeArgs(job({ sessionId: '--dangerously-skip-permissions' }))).toThrow(/session/i);
});

it('refuses an effort outside the three words the product offers', () => {
  // xhigh and max exist in the CLI and no screen sets them, so a value from a hand edited
  // setting stops here.
  expect(() => claudeArgs(job({ effort: 'xhigh' as never }))).toThrow(/effort/i);
});

it('refuses a phase with no tools at all', () => {
  // An empty list does not mean every tool, it means the policy forgot this phase.
  expect(() => claudeArgs(job({ tools: [] }))).toThrow(/tools/i);
});

it('asks for a permission mode that lets a phase write its own notes', () => {
  // Without it the engine runs in default mode, refuses every write, and the run still ends. A
  // phase that cannot write has no summary and no artifact, so the run ends well and leaves nothing.
  const args = claudeArgs(job());

  expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual([
    '--permission-mode',
    'acceptEdits',
  ]);
  // Not the mode that turns every check off.
  expect(args).not.toContain('bypassPermissions');
});

// The card folder sits in the project, next to the worktrees, and not inside the checkout the run
// starts in. Measured on Claude Code 2.1.278: without this flag a write there is refused even in
// acceptEdits mode, and the run still reports success.
it('opens the card folder to the run, which lies outside its working folder', () => {
  const args = claudeArgs(job({ taskDir: '/work/app/.tasks/APP-7' }));

  expect(args[args.indexOf('--add-dir') + 1]).toBe('/work/app/.tasks/APP-7');
});

// A relative folder is resolved by the engine against its own working folder, which is the one
// place the card folder is not. And a value that is not absolute is the only kind that could start
// with a dash and be read as a flag.
it.each(['.tasks/APP-1', '-rf', ''])('refuses the card folder %j, because it is not an absolute path', (taskDir) => {
  expect(() => claudeArgs(job({ taskDir }))).toThrow(/absolute/);
});

// The knowledge folder lies in the project too, outside the checkout. Measured on Claude Code
// 2.1.310: without it a wrap-up's Glob and Grep of the folder came back as "Path is outside allowed
// working directories", and the run read and wrote no knowledge while its result said success.
it('opens the knowledge folder to a run that carries one, under the same flag', () => {
  const args = claudeArgs(job({ phase: 'wrapup', knowledgeDir: '/tmp/demo/.nolzu/knowledge' }));
  const at = args.indexOf('--add-dir');

  expect(args.slice(at, at + 4)).toEqual(['--add-dir', '/tmp/demo/.tasks/APP-1', '/tmp/demo/.nolzu/knowledge', '--model']);
  expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(1);
});

it.each(['.nolzu/knowledge', '-rf', ''])('refuses the knowledge folder %j, because it is not an absolute path', (knowledgeDir) => {
  expect(() => claudeArgs(job({ phase: 'wrapup', knowledgeDir }))).toThrow(/absolute/);
});

// A project's list is the one way a background run may use the shell. The engine reads
// `Bash(<command>)` as that command and nothing else, and the list is never widened to bare `Bash`.
const IMPLEMENT = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'];

it('hands the project list to the engine exactly, one Bash entry per command', () => {
  const args = claudeArgs(job({ phase: 'implement', tools: IMPLEMENT, allowedCommands: ['npm install', 'npm test -- --run src/app.test.ts'] }));
  const at = args.indexOf('--allowedTools');

  expect(args.slice(at, at + 4)).toEqual(['--allowedTools', 'Bash(npm install)', 'Bash(npm test -- --run src/app.test.ts)', '--model']);
  expect(args).not.toContain('Bash');
});

it('adds nothing for an empty list, a missing list, or a phase with no Bash tool', () => {
  expect(claudeArgs(job({ phase: 'implement', tools: IMPLEMENT, allowedCommands: [] }))).not.toContain('--allowedTools');
  expect(claudeArgs(job({ phase: 'implement', tools: IMPLEMENT }))).not.toContain('--allowedTools');
  expect(claudeArgs(job({ allowedCommands: ['npm test'] }))).not.toContain('--allowedTools');
});

it('refuses a command that would allow more than it names', () => {
  expect(() => claudeArgs(job({ phase: 'implement', tools: IMPLEMENT, allowedCommands: ['*'] }))).toThrow(/names no command/);
});

// The setting keeps what was stored, spaces included, so the pattern is trimmed here.
it('writes a stored command without the spaces around it', () => {
  const args = claudeArgs(job({ phase: 'implement', tools: IMPLEMENT, allowedCommands: [' npm test '] }));

  expect(args).toContain('Bash(npm test)');
});

// The project's CLAUDE.md loads from the parent folder and points at these two files, so a run in a
// card checkout needs to read them. Read rules only: a second --add-dir would let the run write there.
it('lets a run in a card checkout read the two project files, and nothing else of the project', () => {
  const args = claudeArgs(job({ projectDir: '/tmp/demo' }));
  const at = args.indexOf('--allowedTools');

  expect(args.slice(at, at + 3)).toEqual(['--allowedTools', 'Read(//tmp/demo/AGENTS.md)', '--model']);
  expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(1);
  expect(args).not.toContain('/tmp/demo');
});

it('puts the Bash entries and the Read entries under one flag', () => {
  const args = claudeArgs(job({ phase: 'implement', tools: IMPLEMENT, allowedCommands: ['npm test'], projectDir: '/tmp/demo' }));

  expect(args.filter((arg) => arg === '--allowedTools')).toHaveLength(1);
  const at = args.indexOf('--allowedTools');
  expect(args.slice(at, at + 4)).toEqual(['--allowedTools', 'Bash(npm test)', 'Read(//tmp/demo/AGENTS.md)', '--model']);
});

it('adds no Read rule when the run starts in the project folder or there is no project', () => {
  expect(claudeArgs(job({ cwd: '/tmp/demo', projectDir: '/tmp/demo' }))).not.toContain('--allowedTools');
  expect(claudeArgs(job({ cwd: '/tmp/demo', projectDir: '/tmp/demo/' }))).not.toContain('--allowedTools');
  expect(claudeArgs(job({ projectDir: null }))).not.toContain('--allowedTools');
  expect(claudeArgs(job())).not.toContain('--allowedTools');
});

it('refuses a project folder that is not absolute', () => {
  expect(() => claudeArgs(job({ projectDir: 'demo' }))).toThrow(/absolute/);
});

it('adds no Read rule for a project folder a pattern would read as a wildcard', () => {
  expect(claudeArgs(job({ projectDir: '/tmp/demo [old]' }))).not.toContain('--allowedTools');
  expect(claudeArgs(job({ projectDir: '/tmp/de*mo' }))).not.toContain('--allowedTools');
});

// A task of an epic reads the epic's documents, which lie in another card folder. A Read rule opens
// them and grants no write, so the task cannot change the epic's folder.
it('lets a task read the epic documents it was handed, and adds no folder', () => {
  const args = claudeArgs(job({ epicFiles: ['/tmp/demo/.tasks/APP-9/refine/refined.md', '/tmp/demo/.tasks/APP-9/plan/plan.md'] }));
  const at = args.indexOf('--allowedTools');

  // One rule for the epic's folder, so a Glob of the folder before the reads is not refused.
  expect(args.slice(at, at + 3)).toEqual(['--allowedTools', 'Read(//tmp/demo/.tasks/APP-9/**)', '--model']);
  expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(1);
  expect(args).not.toContain('/tmp/demo/.tasks/APP-9');
});

it('adds no epic Read rule for a card with no epic, a relative path or a wildcard name', () => {
  expect(claudeArgs(job({ epicFiles: [] }))).not.toContain('--allowedTools');
  expect(claudeArgs(job({ epicFiles: null }))).not.toContain('--allowedTools');
  expect(() => claudeArgs(job({ epicFiles: ['.tasks/APP-9/plan/plan.md'] }))).toThrow(/absolute/);
  expect(claudeArgs(job({ epicFiles: ['/tmp/de*mo/.tasks/APP-9/plan/plan.md'] }))).not.toContain('--allowedTools');
});

// Plan reads the project's instructions for Implement and QA. They lie in the project folder, outside
// the checkout, so each one gets a Read rule and no write.
it('lets a run read the project files it was handed, one rule each', () => {
  const args = claudeArgs(job({ readFiles: ['/tmp/demo/.nolzu/phases/implement.md', '/tmp/demo/.nolzu/phases/qa.md'] }));
  const at = args.indexOf('--allowedTools');

  expect(args.slice(at, at + 4)).toEqual(['--allowedTools', 'Read(//tmp/demo/.nolzu/phases/implement.md)', 'Read(//tmp/demo/.nolzu/phases/qa.md)', '--model']);
  expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(1);
  expect(() => claudeArgs(job({ readFiles: ['.nolzu/phases/qa.md'] }))).toThrow(/absolute/);
});

// A phase that reads code gets the knowledge index, and one Read rule for the whole folder, so a Glob
// of it is not refused. Read only: the folder is no `--add-dir`, which would let the run write there.
it('lets a read-only phase read the knowledge folder and write nothing there', () => {
  const args = claudeArgs(job({ knowledgeReadDir: '/tmp/demo/.nolzu/knowledge' }));
  const at = args.indexOf('--allowedTools');

  expect(args.slice(at, at + 3)).toEqual(['--allowedTools', 'Read(//tmp/demo/.nolzu/knowledge/**)', '--model']);
  expect(args.filter((arg) => arg === '--add-dir')).toHaveLength(1);
  expect(args).not.toContain('/tmp/demo/.nolzu/knowledge');
  expect(() => claudeArgs(job({ knowledgeReadDir: '.nolzu/knowledge' }))).toThrow(/absolute/);
});

it('adds no knowledge Read rule for a wildcard name or a run that writes knowledge', () => {
  expect(claudeArgs(job({ knowledgeReadDir: '/tmp/de*mo/.nolzu/knowledge' }))).not.toContain('--allowedTools');
  expect(claudeArgs(job({ knowledgeReadDir: '/tmp/demo [old]/.nolzu/knowledge' }))).not.toContain('--allowedTools');
  const wrapup = claudeArgs(job({ knowledgeDir: '/tmp/demo/.nolzu/knowledge', knowledgeReadDir: '/tmp/demo/.nolzu/knowledge' }));
  expect(wrapup).not.toContain('--allowedTools');
  expect(wrapup.slice(wrapup.indexOf('--add-dir'), wrapup.indexOf('--add-dir') + 3)[2]).toBe('/tmp/demo/.nolzu/knowledge');
});
