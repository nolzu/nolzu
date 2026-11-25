import type { DatabaseSync } from 'node:sqlite';
import { cardRuns, readRun } from '@nolzu/core/node';
import type { RunEvent } from '@nolzu/protocol';
import { runLogTime, tailLog, toolSubject } from '@nolzu/runner';
import type { LogRun } from '@nolzu/ui';
import { whenSaid } from './when-said.ts';

const plain = (status: number, text: string) => new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export interface LogOptions {
  // The file as it is, for download, rather than a stream that follows it.
  raw: boolean;
  pollMs?: number;
  // The largest file the download builds in memory. A test lowers it.
  rawCap?: number;
}

// Far past any run's log, and far under the string length V8 refuses.
const RAW_CAP = 64 * 1024 * 1024;

// One run's log. The file is read only through tailLog, so one module owns it. The stream sends the
// engine's own events, parsed here, one JSON object per line, and ends when the request is aborted.
// Each event carries `at`, the time the runner noted in front of its line, for the time column. A log
// written before the runner noted times sends none. A tool event also carries `subject`, what it acted
// on, read here because the tab's package reads only the protocol.
// The parser is handed the engine profile the run row recorded, because the file holds the lines of
// the engine that wrote it and not of the one the setting names now.
export async function logResponse(
  db: DatabaseSync,
  parse: (line: string, engine: string) => RunEvent[],
  key: string,
  runId: string,
  signal: AbortSignal,
  options: LogOptions,
): Promise<Response> {
  if (!/^\d+$/.test(runId)) return plain(400, `"${runId}" is not a run id.`);
  const run = readRun(db, Number(runId));
  // Another card's run is not there as far as this card is concerned.
  if (run === null || run.cardKey !== key) return plain(404, `${key} has no run ${runId}.`);
  if (run.logPath === '') return plain(404, `Run ${runId} has no log. It ended before it could start one.`);
  const lines = tailLog(run.logPath, signal, { pollMs: options.pollMs, follow: !options.raw });

  if (options.raw) {
    const cap = options.rawCap ?? RAW_CAP;
    let text = '';
    for await (const line of lines) {
      text += `${line}\n`;
      if (text.length > cap) return plain(413, `The log of run ${runId} is over ${cap} bytes, too large to download here. It is at ${run.logPath}.`);
    }
    return new Response(text, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="${key}-run-${runId}.ndjson"`,
      },
    });
  }

  const cwd = (db.prepare('SELECT cwd FROM runs WHERE id = ?').get(run.id) as { cwd: string | null } | undefined)?.cwd ?? '';
  const named = (event: RunEvent) => (event.type === 'tool' ? { ...event, subject: toolSubject(event.input, cwd) } : event);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let at: number | null = null;
        for await (const line of lines) {
          const noted = runLogTime(line);
          if (noted !== null) {
            at = noted;
            continue;
          }
          for (const event of parse(line, run.engine).map(named)) controller.enqueue(encoder.encode(`${JSON.stringify(at === null ? event : { ...event, at })}\n`));
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' } });
}

// Download raw names a run and nothing else. Any other field in the ask, a path above all, is refused,
// so no file but that run's own log can leave by this route.
export function rawLog(db: DatabaseSync, key: string, query: URLSearchParams, signal: AbortSignal, rawCap?: number): Promise<Response> {
  const other = [...query.keys()].find((name) => name !== 'run');
  if (other !== undefined) return Promise.resolve(plain(400, `Download raw serves only a run's own log, named by its run id. It does not read "${other}".`));
  return logResponse(db, () => [], key, query.get('run') ?? '', signal, { raw: true, rawCap });
}

// The runs the log tab offers, newest first, and the one it shows: the run asked for when it is this
// card's, else the newest. Each carries what its row knows, and the tab shows a figure only where the
// engine reported it.
export function logFor(db: DatabaseSync, key: string, asked: string | null, now = new Date()): { runs: LogRun[]; selected: number | null } {
  const runs = cardRuns(db, key)
    .reverse()
    .map(
      (run): LogRun => ({
        id: run.id,
        phase: run.phase,
        state: run.state,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        engine: run.engine,
        model: run.model,
        effort: run.effort,
        wall: run.wall,
        costUsd: run.costUsd,
        durationMs: run.durationMs,
        tokens: run.tokens === null ? null : run.tokens.input + run.tokens.output,
        started: run.startedAt === null ? null : whenSaid(run.startedAt, now),
        failureReason: run.state === 'failed' ? run.failureReason : null,
      }),
    );
  const wanted = runs.find((run) => String(run.id) === asked);
  return { runs, selected: wanted?.id ?? runs[0]?.id ?? null };
}
