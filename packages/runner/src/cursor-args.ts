import type { Job } from '@nolzu/protocol';
import { guardName } from './args-guard.ts';
import { CURSOR_AUTO } from './cursor-models.ts';

/**
 * The arguments for one Cursor run.
 *
 * Pure, so every model choice is checked without starting a process.
 *
 * The prompt is not here. It goes on stdin, because a process listing is readable by anybody on the
 * machine and a long prompt would hit the argument length limit.
 *
 * There is no mode flag. Only a phase that may change the project reaches this engine, because
 * Cursor has no mode that holds a run to reading, and `spawnCursor` refuses the rest before the
 * process starts.
 *
 * There is no effort flag either. The effort is part of the model id, and 16 of the 241 ids carry
 * none, so the id goes to `--model` exactly as the list printed it. The job's effort is not read:
 * appending it would invent a model the engine does not offer, such as `gpt-5.3-codex-medium`.
 */
export function cursorArgs(job: Job, models: readonly string[], walled = true, approveMcps = false): string[] {
  if (job.sessionId !== null && job.resumeFrom !== null) {
    throw new Error(
      'A job set sessionId and resumeFrom together. Set sessionId to start a fresh run, or resumeFrom to continue an earlier one, never both.',
    );
  }
  const model = guardName(job.model, 'model');
  if (model === CURSOR_AUTO) {
    throw new Error('Cursor offers auto, and Nolzu never asks for it, because auto lets the vendor change the model inside the run and the card would name a model the run did not use. Pick a model by name.');
  }
  if (!models.includes(model)) {
    throw new Error(`The Cursor model list does not hold ${JSON.stringify(model)}, so nothing here knows what to ask the engine for. Pick a model the engine offers.`);
  }
  return [
    '-p',
    '--output-format',
    'stream-json',
    // Without it a directory nobody has trusted refuses the run with exit 1 and no JSON at all, and
    // every card runs in a fresh worktree, so every first run would meet that.
    '--trust',
    // Without it the engine answers every shell command with `rejected` and an empty reason, and the
    // run still ends `success`, so implement would read the project, change nothing it could check,
    // and report a green run. Measured on 2026-09-25 in a plain `-p` run with no mode flag.
    // `--auto-review` is the narrower flag, and it sends each call to a server classifier that
    // prompts for what it does not clear, which a headless run cannot answer.
    '--force',
    // A run inside Nolzu's wall turns the engine's own shell sandbox off, because a macOS sandbox
    // cannot start inside another one. Without the wall, which only Implement runs, it keeps its own.
    ...(walled ? ['--sandbox', 'disabled'] : []),
    // QA's browser server, which Nolzu wrote into the copy's .cursor/mcp.json. A print run cannot ask
    // to start a server, and without the flag it starts none of them.
    ...(approveMcps ? ['--approve-mcps'] : []),
    '--model',
    model,
    ...(job.resumeFrom === null ? [] : ['--resume', guardName(job.resumeFrom, 'session id')]),
  ];
}
