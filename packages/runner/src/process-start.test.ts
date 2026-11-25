import { expect, it } from 'vitest';
import { processStart } from './process-start.ts';

// The writer lock compares this with the time its row was written.
it('reads when this process started, and null for a process that is not there', () => {
  const at = processStart(process.pid);
  expect(at).not.toBeNull();
  expect(at ?? 0).toBeLessThanOrEqual(Date.now());
  expect(processStart(2 ** 22 + 12345)).toBeNull();
});
