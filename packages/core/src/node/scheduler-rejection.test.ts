import type { Job } from '@nolzu/protocol';
import { expect, it } from 'vitest';
import { createScheduler } from '../scheduler.ts';

// This one test lives under node/ because observing an unhandled rejection needs `process`, and
// pure core may not touch it. The scheduler itself stays pure: it only has to catch.
const job = (runId: number, cardKey: string): Job => ({
  runId,
  cardKey,
  engine: 'claude-code',
  phase: 'implement',
  cwd: '/demo',
  prompt: 'do the thing',
  model: 'sonnet',
  effort: 'medium',
  sessionId: null,
  resumeFrom: null,
  timeoutMs: 1000,
  logPath: 'log.ndjson',
  taskDir: '/tmp/demo/.tasks/APP-1',
  lane: null,
  mcpConfigPath: null,
  settingsPath: null,
  tools: ['Read'],
});

it('does not leave a failed run as an unhandled rejection', async () => {
  const seen: unknown[] = [];
  const watch = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', watch);

  try {
    const rejects: ((reason: Error) => void)[] = [];
    const scheduler = createScheduler(1, {
      startJob: () => new Promise<void>((_resolve, reject) => { rejects.push(reject); }),
      onChange: () => undefined,
    });
    scheduler.add(job(1, 'APP-1'));
    // Held in an array, because TypeScript narrows a variable assigned only inside a callback and
    // then refuses to call it.
    rejects[0]?.(new Error('the engine died'));
    // A microtask alone would not let the rejection reach the process.
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', watch);
  }

  expect(seen).toEqual([]);
});
