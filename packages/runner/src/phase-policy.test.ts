import { ASK_POLICY, CHANGE_TOOLS, KNOWN_TOOLS, PHASE_POLICIES, policyFor, startsInCardFolder, vendorRefusal } from '@nolzu/core';
import type { Job } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { claudeArgs } from './claude-args.ts';
import { checkWall } from './wall-detect.ts';

// Where the run would start: a git project, with the wall ready or missing.
const WALL = { outsideGit: false, wall: { ready: true } } as const;
const NO_WALL = { outsideGit: false, wall: { ready: false, reason: 'bubblewrap is not installed. Install the bubblewrap package, for example with sudo apt install bubblewrap.' } } as const;
// The two Linux answers of the real probe, with its checks stood in for.
const NO_BWRAP = checkWall('linux', { exists: () => true, which: () => null, run: () => 0 });
const USERNS = checkWall('linux', { exists: () => true, which: () => '/usr/bin/bwrap', run: () => 1 });

// The policy table lives in `@nolzu/core`, because the board resolves a row against the same rule
// the spawn enforces. This file stays here, because the other half of it is what the Claude
// argument builder makes of a policy, and core may not import the runner.

const job = (over: Partial<Job> = {}): Job => ({
  runId: 1,
  cardKey: 'APP-1',
  engine: 'claude-code',
  phase: 'refine',
  cwd: '/tmp/demo/worktrees/APP-1',
  prompt: 'Refine the ticket.',
  model: 'sonnet',
  effort: 'low',
  sessionId: '9c7b2db6-ab54-4b9f-a1c0-ce1bb5237ec7',
  resumeFrom: null,
  timeoutMs: 30 * 60 * 1000,
  logPath: '/tmp/data/logs/1.ndjson',
  taskDir: '/tmp/demo/.tasks/APP-1',
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read', 'Grep', 'Glob'],
  ...over,
});

it.each(['refine', 'plan'])('lets %s read, search and write its own notes, and change nothing', (phase) => {
  // Every phase writes its summary, and refine and plan write their own artifact, so Write and Edit
  // are not the line between them and implement. Bash and the guard are.
  const policy = policyFor(phase);
  expect(policy.tools).toContain('Read');
  expect(policy.tools).toContain('Grep');
  expect(policy.tools).toContain('Write');
  expect(policy.readOnly).toBe(true);
  for (const tool of CHANGE_TOOLS) expect(policy.tools).not.toContain(tool);
});

// A real refine run called Edit to fix a line of its own brief, failed twice and wrote
// the whole file again. The guard holds Edit to the same folders as Write, and Edit changes no file
// Write could not overwrite, so every phase that holds Write holds Edit too.
it('gives Edit to every phase that holds Write', () => {
  for (const [phase, policy] of Object.entries(PHASE_POLICIES)) {
    if (policy.tools.includes('Write')) expect(policy.tools, phase).toContain('Edit');
  }
});

it('gives implement the tools that change the code', () => {
  const policy = policyFor('implement');
  expect(policy.readOnly).toBe(false);
  for (const tool of CHANGE_TOOLS) expect(policy.tools).toContain(tool);
  // It still reads before it writes.
  expect(policy.tools).toContain('Read');
  expect(policy.tools).toContain('Write');
});

// The tool written out. Every check around this one walks CHANGE_TOOLS, so a tool taken out of the
// constant takes the assertion with it: an implement run with no Bash cannot run the build, a test or
// git, and it reports done having verified nothing.
it('names Bash as the tool that changes the code', () => {
  expect([...CHANGE_TOOLS]).toEqual(['Bash']);
  expect(policyFor('implement').tools).toContain('Bash');
  expect(policyFor('implement').tools).toContain('Edit');
});

it('throws on a phase with no row, rather than letting it inherit write access', () => {
  expect(() => policyFor('merge')).toThrow(/PHASE_POLICIES/);
  // hasOwn, so an inherited name gets the same message and not a surprise row.
  expect(() => policyFor('constructor')).toThrow(/PHASE_POLICIES/);
});

it('has no row with an MCP server, and none whose flag disagrees with its tools', () => {
  // Every row, not only the read-only ones. Skipping the write rows let a row ship with an MCP
  // server that no phase needs, and let the flag drift from the tools, which would
  // make the contract text tell a run it may write while the tool list refuses it.
  for (const [phase, policy] of Object.entries(PHASE_POLICIES)) {
    expect(policy.tools.length, phase).toBeGreaterThan(0);
    // `Bash` is the change tool, and a guarded phase holds it only by saying `commands`. The phase
    // that writes the project is the one that is not read only, and it holds the tool.
    if (!policy.readOnly) for (const tool of CHANGE_TOOLS) expect(policy.tools, phase).toContain(tool);
    // A phase that says it writes knowledge has to hold the tool that corrects a file, and must not
    // hold a command, because the runner makes the commit.
    if (policy.knowledge === true) {
      expect(policy.tools, phase).toContain('Edit');
      expect(policy.tools, phase).not.toContain('Bash');
    }
    if (policy.tools.includes('Bash') && policy.readOnly) {
      expect(policy.commands, `${phase} runs commands without saying so`).toBe(true);
    }
    // And the other way: a phase that says it runs commands has to hold the tool.
    if (policy.commands === true) expect(policy.tools, phase).toContain('Bash');
  }
});

// QA runs the project's own checks, so it needs a command, and it must not edit the project's
// code, because a run that fixed what it found would leave nobody able to say the card ever
// worked. Its Write and Edit reach only the card folder, through the guard that `readOnly` turns on.
it('lets QA run a command and holds its writes to the card folder', () => {
  const qa = policyFor('qa');

  expect(qa.tools).toContain('Bash');
  expect(qa.commands).toBe(true);
  expect(qa.readOnly).toBe(true);
  expect(qa.knowledge).toBeUndefined();
});

it('has no row the argument builder refuses', () => {
  for (const phase of Object.keys(PHASE_POLICIES)) {
    const policy = policyFor(phase);
    expect(() => claudeArgs(job({ phase, tools: policy.tools, mcpConfigPath: null }))).not.toThrow();
  }
});

it('wires the refine row into the argument list', () => {
  const policy = policyFor('refine');
  const args = claudeArgs(job({ phase: 'refine', tools: policy.tools, mcpConfigPath: null }));

  expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', 'Read,Grep,Glob,Write,Edit']);
  expect(args).not.toContain('--mcp-config');
  expect(args).toContain('--strict-mcp-config');
});

it('wires the implement row into the argument list', () => {
  const policy = policyFor('implement');
  const args = claudeArgs(job({ phase: 'implement', tools: policy.tools, mcpConfigPath: null }));
  const named = args[args.indexOf('--tools') + 1] ?? '';

  expect(named.split(',')).toContain('Edit');
  expect(named.split(',')).toContain('Read');
});

it('names only tools the engine actually has', () => {
  // A typo in a tool name is dropped by the engine without a word, so the phase loses that tool
  // and nothing says so. Checking the rows against a list of real names is what catches it.
  for (const [phase, policy] of Object.entries(PHASE_POLICIES)) {
    for (const tool of policy.tools) expect(KNOWN_TOOLS, `${phase} names ${tool}`).toContain(tool);
  }
  // The list the invariant is built from has to be real too, or the invariant checks nothing.
  for (const tool of CHANGE_TOOLS) expect(KNOWN_TOOLS).toContain(tool);
});

it('answers for the extraction pass, which is not in the skills table, as read only with only Read', () => {
  // The engine asks policyFor on every spawn. Without this the pass that writes a missing summary
  // failed before it started, on the real engine.
  expect(Object.keys(PHASE_POLICIES)).not.toContain('extract-summary');
  expect(policyFor('extract-summary')).toEqual({ tools: ['Read'], readOnly: true });
  expect(claudeArgs(job({ phase: 'extract-summary', tools: ['Read'] }))).toContain('Read');
});

// The commit message pass spawns the same way, so the real engine asks policyFor for it too.
it('answers for the commit message pass as read only with only Read', () => {
  expect(policyFor('commit-message')).toEqual({ tools: ['Read'], readOnly: true });
  expect(claudeArgs(job({ phase: 'commit-message', tools: ['Read'] }))).toContain('Read');
});

// An Ask reads the card's code and its card folder and writes nothing. The tool list
// the engine is handed is what refuses a write, and the guard is the wall behind it, as for every
// read-only phase. It has no skill, so it is not in the table the skills are checked against.
it('holds an Ask run to reading: no tool that writes or runs a command, on the engine flag the phases use', () => {
  const policy = policyFor('ask');

  expect(policy).toBe(ASK_POLICY);
  expect(Object.keys(PHASE_POLICIES)).not.toContain('ask');
  expect(policy.readOnly).toBe(true);
  expect(policy.knowledge).toBeUndefined();
  expect(policy.commands).toBeUndefined();
  for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash']) expect(policy.tools).not.toContain(tool);
  for (const tool of policy.tools) expect(KNOWN_TOOLS).toContain(tool);

  const args = claudeArgs(job({ phase: 'ask', tools: policy.tools }));
  expect(args[args.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
  // No shell at all, so the project's allowed commands are never handed over either.
  expect(args).not.toContain('--allowedTools');
});

// Without the wall, Codex runs it in the checkout under the sandbox that refuses every write, the
// card folder too, since it writes no notes. Cursor holds no run to reading on its own, so it is
// refused as for every read-only phase.
it('runs an Ask under the read-only sandbox on Codex and refuses it where nothing holds a run to reading', () => {
  expect(vendorRefusal('claude-code', 'ask', NO_WALL)).toBeNull();
  expect(vendorRefusal('codex', 'ask', NO_WALL)).toBeNull();
  expect(startsInCardFolder('codex', 'ask', true)).toBe(false);
  expect(vendorRefusal('cursor', 'ask', NO_WALL)).toContain('may not change the project');
});

// Optimize does the wrap-up's job on one file, so it takes the wrap-up's shape: it reads, it
// corrects a knowledge file, and it runs no command, because the runner makes the commit.
it('gives Optimize the same shape as the wrap-up', () => {
  expect(policyFor('optimize')).toEqual(policyFor('wrapup'));
  expect(policyFor('optimize').knowledge).toBe(true);
  expect(policyFor('optimize').tools).not.toContain('Bash');
});

// Learn this project and Learn your repositories write knowledge the way the wrap-up does, with no
// command, and what they write always waits for a person. No other
// row holds its output.
it.each(['orient', 'learn-repo'])('gives %s the wrap-up shape, and always holds what it writes', (phase) => {
  const { alwaysHeld, ...shape } = policyFor(phase);
  expect(shape).toEqual(policyFor('wrapup'));
  expect(alwaysHeld).toBe(true);
  expect(Object.entries(PHASE_POLICIES).filter(([, policy]) => policy.alwaysHeld === true).map(([phase]) => phase)).toEqual(['orient', 'learn-repo']);
});

/**
 * The phases each vendor cannot run, which both the spawn and the "Run on" offer read here.
 *
 * Where Nolzu's wall starts, nothing is refused. Where it cannot, Claude Code still runs every phase
 * under its guard, Codex falls back to its own sandbox, which starves QA and the three knowledge
 * phases, and Cursor runs Implement only, because plan mode is a mode a run can leave.
 */
const ALL_PHASES = [...Object.keys(PHASE_POLICIES), 'ask', 'extract-summary'];
const VENDORS = ['claude-code', 'codex', 'cursor'];

it.each(VENDORS)('refuses no phase on %s where the wall starts', (vendor) => {
  for (const phase of ALL_PHASES) expect(vendorRefusal(vendor, phase, WALL)).toBeNull();
});

// Written out rather than read off the table, so a phase dropped from the table cannot take its
// own case out of this file with it. The test below is what says the two lists are the same.
it.each(['refine', 'plan', 'implement', 'qa', 'wrapup', 'optimize', 'orient', 'learn-repo', 'assess'])('lets %s run on Claude Code without the wall', (phase) => {
  expect(vendorRefusal('claude-code', phase, NO_WALL)).toBeNull();
});

it('names every phase of the table in the case above', () => {
  expect(Object.keys(PHASE_POLICIES)).toEqual([
    'refine',
    'plan',
    'implement',
    'qa',
    'wrapup',
    'optimize',
    'orient',
    'learn-repo',
    'architecture',
    'design',
    'investigate',
    'research',
    'pr-review',
    'feedback',
    'assess',
  ]);
});

/**
 * The five phases of the other four boards.
 *
 * Each one reads the project and writes its own file in the card folder, which is the refine shape.
 * None of them changes the project, runs a command or writes knowledge, so the guard holds them to
 * the card folder and the Codex sandbox can take them too.
 */
it.each(['architecture', 'design', 'investigate', 'research', 'pr-review', 'feedback'])('holds %s to reading and its own notes', (phase) => {
  const policy = policyFor(phase);

  expect(policy.readOnly).toBe(true);
  expect(policy.tools).toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit']);
  expect(policy.commands).toBeUndefined();
  expect(policy.knowledge).toBeUndefined();
});

// They all take the read-only shape, so without the wall Codex runs them from the card folder and
// the two engines with no limit of their own refuse them, the way they refuse refine and plan.
it.each(['architecture', 'design', 'investigate', 'research', 'pr-review'])('runs %s on Claude Code and on Codex without the wall, and refuses it elsewhere', (phase) => {
  expect(vendorRefusal('claude-code', phase, NO_WALL)).toBeNull();
  expect(vendorRefusal('codex', phase, NO_WALL)).toBeNull();
  expect(startsInCardFolder('codex', phase, true)).toBe(true);
  expect(vendorRefusal('cursor', phase, NO_WALL)).toContain("only Nolzu's wall holds Cursor to reading");
});

// The sentence names the check that failed, so a person knows what to install or allow.
it.each(['cursor'])('refuses every read-only phase on %s without the wall, naming the failed check', (vendor) => {
  for (const wall of [NO_BWRAP, USERNS]) {
    if (wall.ready) throw new Error('the probe stand-in passed');
    for (const phase of ['refine', 'plan', 'qa', 'wrapup', 'optimize', 'assess', 'ask', 'extract-summary']) {
      const refused = vendorRefusal(vendor, phase, { outsideGit: false, wall });
      expect(refused).toContain('may not change the project');
      expect(refused).toContain(wall.reason);
    }
  }
  expect(vendorRefusal(vendor, 'plan', { outsideGit: false, wall: NO_BWRAP })).toContain('Install the bubblewrap package');
  expect(vendorRefusal(vendor, 'plan', { outsideGit: false, wall: USERNS })).toContain('user namespaces are blocked');
});

// Without the wall Codex runs under its own sandbox: refine and plan from the card folder, the
// wrap-up and optimize from there with the knowledge folder added, and QA on its throwaway copy.
it.each(['refine', 'plan', 'qa', 'wrapup', 'optimize', 'orient'])('lets %s run on Codex without the wall', (phase) => {
  expect(vendorRefusal('codex', phase, NO_WALL)).toBeNull();
});

// The one phase that may change the project, so no refusal applies to it, wall or not.
it('lets implement run on Codex and Cursor without the wall', () => {
  expect(vendorRefusal('codex', 'implement', NO_WALL)).toBeNull();
  expect(vendorRefusal('cursor', 'implement', NO_WALL)).toBeNull();
});

// The summary pass writes no file, so the Codex sandbox starves nothing.
it('lets the summary pass run on Codex without the wall', () => {
  expect(vendorRefusal('codex', 'extract-summary', NO_WALL)).toBeNull();
});

// A project folder that is not a git repository. Only Claude Code may run there until the other
// engines are measured in such a folder, so every phase is refused on them, implement included,
// and the wall changes nothing about it.
it.each(['codex', 'cursor'])('refuses every phase on %s when the project folder is not a repository', (vendor) => {
  for (const phase of ['refine', 'plan', 'implement', 'qa', 'wrapup', 'optimize', 'assess', 'extract-summary']) {
    for (const wall of [WALL.wall, NO_WALL.wall]) {
      const refused = vendorRefusal(vendor, phase, { outsideGit: true, wall });
      expect(refused).toContain('not a git repository');
      expect(refused).toContain('Run this phase on a Claude Code profile.');
    }
  }
});

it('lets Claude Code run every phase when the project folder is not a repository', () => {
  for (const phase of ['refine', 'plan', 'implement', 'qa', 'wrapup', 'optimize', 'assess', 'extract-summary']) {
    expect(vendorRefusal('claude-code', phase, { outsideGit: true, wall: NO_WALL.wall })).toBeNull();
  }
});

/**
 * Where a run starts, which decides the paths the prompt names.
 *
 * Under its own sandbox a read-only phase on Codex starts in the card folder, because the sandbox
 * makes the working folder the writable area and the project then lies outside it. Measured on
 * 2026-09-26 and written up in `docs/engines/codex.md`. The wrap-up and optimize add the knowledge
 * folder there as a writable root.
 */
it.each(['refine', 'plan', 'wrapup', 'optimize'])('starts %s on Codex under its own sandbox in the card folder', (phase) => {
  expect(startsInCardFolder('codex', phase, true)).toBe(true);
});

// Inside Nolzu's wall, which is where Codex runs while its own sandbox is off, the wall holds the
// card folder, so every phase starts in the checkout like on the other engines.
it.each(['refine', 'plan', 'assess', 'wrapup', 'optimize', 'implement', 'extract-summary', 'ask'])('starts %s on Codex inside the wall in the checkout', (phase) => {
  expect(startsInCardFolder('codex', phase, false)).toBe(false);
});

// Implement may change the project, so it starts in the checkout like every other writing run.
it('starts implement on Codex in the checkout', () => {
  expect(startsInCardFolder('codex', 'implement', true)).toBe(false);
});

// The summary pass writes nothing, so it keeps the read-only sandbox and the checkout.
it('starts the summary pass on Codex in the checkout', () => {
  expect(startsInCardFolder('codex', 'extract-summary', true)).toBe(false);
});

// QA runs the project's own checks, which write caches, so it starts in its throwaway copy instead.
it('does not start qa on Codex in the card folder', () => {
  expect(startsInCardFolder('codex', 'qa', true)).toBe(false);
});

// The other two engines keep the checkout. Claude Code has the guard, and Cursor runs implement
// alone.
it.each(['claude-code', 'cursor'])('starts every phase on %s in the checkout', (vendor) => {
  for (const phase of ['refine', 'plan', 'implement', 'extract-summary']) {
    expect(startsInCardFolder(vendor, phase, true)).toBe(false);
  }
});

/**
 * The Scout assessment.
 *
 * It reads a finding, reads the project and writes what it found in its own folder, which is the
 * refine shape again. Every limit of a Scout assessment comes out of that one row: no
 * `Edit`, so no file of the project changes; no `commands`, so the guard refuses every `Bash` call,
 * and a shell write and a git write are only reachable through one; no `knowledge`, so the card
 * folder is the only folder the guard allows; and the tool list names no network tool, so there is
 * no external write.
 */
it('holds the assessment to reading and its own notes', () => {
  const policy = policyFor('assess');

  expect(policy.readOnly).toBe(true);
  expect(policy.tools).toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit']);
  expect(policy.commands).toBeUndefined();
  expect(policy.knowledge).toBeUndefined();
});

// The vendor rule every read-only phase reads, with no second rule written for it: a
// row that says `readOnly` and neither `commands` nor `knowledge` already means Claude Code and
// Codex without the wall. All three vendors, because two of them passing says nothing about the one
// that must refuse.
it('runs the assessment on Claude Code and on Codex without the wall, and refuses it on Cursor', () => {
  expect(vendorRefusal('claude-code', 'assess', NO_WALL)).toBeNull();
  expect(vendorRefusal('codex', 'assess', NO_WALL)).toBeNull();
  // Codex has no read-only mode that leaves the card folder writable, so it starts in that folder
  // and the project lies outside its sandbox.
  expect(startsInCardFolder('codex', 'assess', true)).toBe(true);
  expect(vendorRefusal('cursor', 'assess', NO_WALL)).toContain("only Nolzu's wall holds Cursor to reading");
  // The sentence a person reads names the phase, so the label has to be there and not the key.
  expect(vendorRefusal('cursor', 'assess', NO_WALL)).toContain('Assessment');
});
