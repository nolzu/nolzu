import type { Job } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { cursorArgs } from './cursor-args.ts';

// Two ids from the real list: one that carries its effort, one that carries none.
const MODELS = ['claude-opus-5-5-high', 'gpt-5.3-codex'];

const job = (over: Partial<Job> = {}): Job =>
  ({
    runId: 1,
    cardKey: 'APP-1',
    engine: 'cursor',
    phase: 'implement',
    cwd: '/tmp/app/worktrees/APP-1',
    taskDir: '/tmp/app/.tasks/APP-1',
    prompt: 'Plan the ticket.',
    model: 'claude-opus-5-5-high',
    effort: 'medium',
    sessionId: null,
    resumeFrom: null,
    timeoutMs: 1000,
    logPath: '/tmp/app/run.ndjson',
    lane: null,
    mcpConfigPath: null,
    settingsPath: null,
    tools: ['Read'],
    ...over,
  }) as Job;

it('starts a run that reads the stream, trusts the folder and may run a command', () => {
  expect(cursorArgs(job(), MODELS)).toEqual(['-p', '--output-format', 'stream-json', '--trust', '--force', '--sandbox', 'disabled', '--model', 'claude-opus-5-5-high']);
});

// Every card runs in a fresh worktree, and a folder nobody has trusted refuses the run with exit 1
// and no JSON at all, so a run without this flag never starts.
it('trusts the folder on every run', () => {
  expect(cursorArgs(job({ resumeFrom: 'a2e5f188' }), MODELS)).toContain('--trust');
});

// Measured on 2026-09-25 in a plain `-p` run with no mode flag: without this the engine answered
// every shell call with `rejected` and the run still ended `success`. An implement run would read
// the project, run no test and no build, and report a green run.
it('lets the run use a shell', () => {
  expect(cursorArgs(job({ resumeFrom: 'a2e5f188' }), MODELS)).toContain('--force');
});

// Plan mode is a mode the run can leave, so it is not a limit and nothing asks for it. The phases
// that may not write are refused before the process starts.
it('asks for no mode', () => {
  // The array and not the joined line: `--model` starts with `--mode`.
  expect(cursorArgs(job(), MODELS)).not.toContain('--mode');
  expect(cursorArgs(job(), MODELS)).not.toContain('plan');
});

it('continues an earlier session by its id', () => {
  expect(cursorArgs(job({ resumeFrom: 'a2e5f188' }), MODELS).join(' ')).toContain('--resume a2e5f188');
});

// The effort is part of the model id, and 16 of the 241 ids carry none. An adapter that appended
// the row's effort would ask for `gpt-5.3-codex-medium`, which the engine does not offer.
it('passes a model that carries no effort exactly as it is', () => {
  const args = cursorArgs(job({ model: 'gpt-5.3-codex', effort: 'medium' }), MODELS);
  expect(args.join(' ')).toContain('--model gpt-5.3-codex');
  expect(args.join(' ')).not.toContain('medium');
});

// The same for an id that carries one: the effort in the row says nothing here, and appending it
// would ask for `claude-opus-5-5-high-low`.
it('passes a model that carries an effort exactly as it is', () => {
  expect(cursorArgs(job({ effort: 'low' }), MODELS).join(' ')).toContain('--model claude-opus-5-5-high');
});

// There is no effort flag at all, so nothing in the arguments may name one.
it('passes no effort flag', () => {
  const args = cursorArgs(job({ effort: 'high' }), MODELS);
  expect(args.filter((arg) => arg.includes('effort'))).toEqual([]);
});

it('refuses a model the engine does not list', () => {
  expect(() => cursorArgs(job({ model: 'gpt-5.3-codex-medium' }), MODELS)).toThrow(/does not hold "gpt-5.3-codex-medium"/);
});

// auto is the one id the engine offers and Nolzu refuses, so it gets the reason and not "the list
// does not hold it", which would be untrue.
it('refuses auto, and says why', () => {
  expect(() => cursorArgs(job({ model: 'auto' }), MODELS)).toThrow(/change the model inside the run/);
});

it('refuses a model name that would be read as a flag', () => {
  expect(() => cursorArgs(job({ model: '--trust' }), MODELS)).toThrow(/read as a flag/);
});

it('refuses a job that starts and resumes at once', () => {
  expect(() => cursorArgs(job({ sessionId: 'new', resumeFrom: 'old' }), MODELS)).toThrow(/never both/);
});

// Without Nolzu's wall, which only Implement runs, the engine keeps its own shell sandbox.
it('keeps its own shell sandbox when no wall holds the run', () => {
  expect(cursorArgs(job(), MODELS, false)).not.toContain('--sandbox');
});

it('approves the MCP servers only when QA has a browser', () => {
  expect(cursorArgs(job(), MODELS)).not.toContain('--approve-mcps');
  const args = cursorArgs(job(), MODELS, true, true);
  expect(args.slice(args.indexOf('--approve-mcps') + 1, args.indexOf('--approve-mcps') + 2)).toEqual(['--model']);
});
