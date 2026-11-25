import type { RunEvent } from '@nolzu/protocol';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { dirname } from 'node:path';

// The raw stream of one run, written and read back by this one module, so the log tab does no
// file work of its own.

export interface RunLog {
  write: (line: string) => void;
  close: () => void;
}

// Every line goes to disk before the next one is read, whole and with its newline, so a run that
// is killed in the middle leaves a file whose last line parses. The file is opened to append,
// because a retry of the same run writes into it, and what the first attempt printed stays.
export function openRunLog(path: string): RunLog {
  let fd: number;
  try {
    // Readable by its owner only: the log is the agent's whole transcript, with whatever it printed.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    fd = openSync(path, 'a', 0o600);
  } catch (error) {
    throw new Error(`The run log ${path} cannot be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}). Check that the data folder can be written to.`, { cause: error });
  }

  let open = true;
  return {
    write(line) {
      const data = Buffer.from(`${line}\n`);
      try {
        // The system may take part of a write, say how much, and raise no error, when the disk fills
        // or the file reaches its size limit. So the rest is written again until all of it is there,
        // and a real failure then shows up as an error on the next call.
        for (let at = 0; at < data.length; ) at += writeSync(fd, data, at, data.length - at);
      } catch (error) {
        throw new Error(`The run log ${path} could not take another line (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}). Check the free space and the data folder.`, { cause: error });
      }
    },
    close() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

// A line Nolzu itself adds to a run's log after the run, about what it did with what the run wrote.
// Its own type keeps every engine's parser from reading it as engine output, and `parseRunLine` reads
// it first, so the Log tab shows it whatever engine wrote the rest.
const NOTE_TYPE = 'nolzu';

// The same line, for a note the runner puts into the stream itself, such as the wall a run starts in.
export const noteLine = (text: string): string => JSON.stringify({ type: NOTE_TYPE, text });

export function noteInRunLog(path: string, text: string): void {
  const log = openRunLog(path);
  try {
    log.write(noteLine(text));
  } finally {
    log.close();
  }
}

// The text of such a line, or null for any other line.
export function runLogNote(line: string): string | null {
  if (!line.includes(`"${NOTE_TYPE}"`)) return null;
  try {
    const value = JSON.parse(line) as { type?: unknown; text?: unknown } | null;
    return value?.type === NOTE_TYPE && typeof value.text === 'string' ? value.text : null;
  } catch {
    return null;
  }
}

// A wait Nolzu holds after an API error. The engine printed nothing for it, so without this line the
// Log tab would show a run that went silent for minutes. Its own type, so no engine's parser reads it.
const RETRY_TYPE = 'nolzu.retry';

type Wait = Extract<RunEvent, { type: 'api_retry' }>;

export function retryInRunLog(path: string, wait: Wait, open: (path: string) => RunLog = openRunLog): void {
  const log = open(path);
  try {
    log.write(JSON.stringify({ type: RETRY_TYPE, retry: { ...wait, type: undefined } }));
  } finally {
    log.close();
  }
}

// The wait such a line holds, or null for any other line.
export function runLogRetry(line: string): Wait | null {
  if (!line.includes(`"${RETRY_TYPE}"`)) return null;
  try {
    const value = JSON.parse(line) as { type?: unknown; retry?: Partial<Record<keyof Wait, unknown>> } | null;
    const retry = value?.retry;
    if (value?.type !== RETRY_TYPE || typeof retry?.attempt !== 'number' || typeof retry.delayMs !== 'number') return null;
    const orNull = <T>(field: unknown, kind: 'number' | 'string'): T | null => (typeof field === kind ? (field as T) : null);
    return {
      type: 'api_retry',
      attempt: retry.attempt,
      delayMs: retry.delayMs,
      status: orNull<number>(retry.status, 'number'),
      maxRetries: orNull<number>(retry.maxRetries, 'number'),
      reason: orNull<string>(retry.reason, 'string'),
      ...(typeof retry.until === 'number' ? { until: retry.until } : {}),
    };
  } catch {
    return null;
  }
}

// When the lines after it came, in Unix milliseconds, for the Log tab's time column. The engines
// stamp nothing, so the runner writes one in front of a line, at most once a second. Its own type,
// so no engine's parser reads it.
const TIME_TYPE = 'nolzu.at';

export const timeInRunLog = (at: number): string => JSON.stringify({ type: TIME_TYPE, at });

// The time such a line holds, or null for any other line.
export function runLogTime(line: string): number | null {
  if (!line.includes(`"${TIME_TYPE}"`)) return null;
  try {
    const value = JSON.parse(line) as { type?: unknown; at?: unknown } | null;
    return value?.type === TIME_TYPE && typeof value.at === 'number' ? value.at : null;
  } catch {
    return null;
  }
}

export interface TailOptions {
  // How often a quiet file is looked at again. A watcher would say sooner, and misses an append on
  // some file systems, which a person staring at an unmoving log cannot tell from a stuck run.
  pollMs?: number;
  // False stops at the end of the file, and at once when there is none, which is what a download wants.
  follow?: boolean;
}

const POLL_MS = 250;
const CHUNK = 64 * 1024;

// Resolves after the wait, or at once when the signal is aborted, and leaves no listener behind.
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

// The lines already in the file, then every line added to it, until the signal is aborted. A line
// is handed on only once its newline is there, so a reader never gets half of one. A file that does
// not exist yet is waited for, because the log tab can open before the engine printed anything.
//
// Stop it with the signal. A `return()` sent while it is waiting for the next line is only seen once
// that line arrives, and the file stays open until then.
// Limit: a file that is cut shorter while it is read goes quiet here. Nothing rewrites a log today;
// compare the size with the offset on an empty read when something does.
export async function* tailLog(path: string, signal: AbortSignal, options: TailOptions = {}): AsyncGenerator<string> {
  const pollMs = options.pollMs ?? POLL_MS;
  const follow = options.follow ?? true;
  let file: FileHandle | null = null;
  try {
    while (file === null) {
      if (signal.aborted) return;
      try {
        file = await open(path, 'r');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (!follow) return;
        await pause(pollMs, signal);
      }
    }

    const decoder = new TextDecoder();
    const buffer = Buffer.alloc(CHUNK);
    let offset = 0;
    let carry = '';
    while (!signal.aborted) {
      const { bytesRead } = await file.read(buffer, 0, CHUNK, offset);
      if (bytesRead === 0) {
        if (!follow) return;
        await pause(pollMs, signal);
        continue;
      }
      offset += bytesRead;
      // stream: true, so a character cut in two by the chunk edge is joined, not replaced.
      carry += decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      for (let at = carry.indexOf('\n'); at !== -1; at = carry.indexOf('\n')) {
        const line = carry.slice(0, at).replace(/\r$/, '');
        carry = carry.slice(at + 1);
        if (line.trim() !== '') yield line;
        if (signal.aborted) return;
      }
    }
  } finally {
    await file?.close();
  }
}
