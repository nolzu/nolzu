import type { Job } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { claudeArgs } from './claude-args.ts';
import { claudeModels } from './models.ts';

const job = (model: string): Job => ({
  runId: 1,
  cardKey: 'APP-1',
  engine: 'claude-code',
  phase: 'refine',
  cwd: '/tmp/demo/worktrees/APP-1',
  taskDir: '/tmp/demo/.tasks/APP-1',
  prompt: 'Refine the ticket.',
  model,
  effort: 'low',
  sessionId: null,
  resumeFrom: null,
  timeoutMs: 60_000,
  logPath: '/tmp/data/logs/1.ndjson',
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read'],
});

it('lists the models the engine documents', () => {
  expect(claudeModels().length).toBeGreaterThan(0);
});

// The list and the argument builder are kept apart, so a name the builder refuses would be offered
// on the board and then fail every run started with it.
it.each(claudeModels())('offers %s, which the argument builder accepts', (model) => {
  const args = claudeArgs(job(model));

  expect(args[args.indexOf('--model') + 1]).toBe(model);
});

// `default` and `opusplan` let the engine pick or switch the model by itself, so the card would show
// one model and the run would use another.
it('offers no name that lets the engine choose the model on its own', () => {
  expect(claudeModels()).not.toContain('default');
  expect(claudeModels()).not.toContain('opusplan');
});

it('cannot be changed by a caller, because every board and every run reads the same list', () => {
  expect(Object.isFrozen(claudeModels())).toBe(true);
});
