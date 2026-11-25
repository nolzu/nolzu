import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cleanSummary, EXTRACT_SUMMARY_POLICY, foldRun, needsExtraction } from '@nolzu/core';
import { saveRun, savePlainSummary, startRun } from '@nolzu/core/node';
import type { Effort, Job, RunEvent } from '@nolzu/protocol';
import { extractSummaryPrompt } from '@nolzu/skills';

export interface SummaryDeps {
  db: DatabaseSync;
  // The engine the extraction runs on, named on its row.
  engine: string;
  // The model for the pass. A light one: it rewrites text it is handed, and the phase's own model
  // would be opus for implement.
  summaryModel: { model: string; effort: Effort };
  // The run's stop. A pass that was stopped is saved as stopped, not as failed with no reason.
  signal?: AbortSignal;
  // The file's text, or null when it is not there. Injected, so a test needs no card folder.
  read: (path: string) => string | null;
  // Runs the extraction job and hands back its events. Injected, so a test needs no engine.
  extract: (job: Job) => AsyncIterable<RunEvent>;
}

export const readText = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// What the run said, as one text. Only its own words: a tool result is the project's output, and
// reading a verdict or a summary out of one would take the project's words for the run's.
export const said = (events: readonly RunEvent[]): string =>
  events
    .filter((event) => event.type === 'text')
    .map((event) => event.text)
    .join('\n');

// After a phase run ends ready: the plain summary the skill wrote to the card folder, or, when it wrote
// none, one extraction pass over what the run said. The pass is its own run row, so its cost is
// visible, and nothing it does touches the card, which stays ready whatever happens here.
export async function recordSummary(deps: SummaryDeps, job: Job, events: readonly RunEvent[]): Promise<void> {
  const { db } = deps;
  const written = deps.read(join(job.taskDir, job.phase, 'summary.md'));
  const cleaned = written === null ? null : cleanSummary(written);
  if (cleaned !== null && !needsExtraction(cleaned)) {
    savePlainSummary(db, job.runId, cleaned);
    return;
  }

  const logPath = job.logPath.replace(/\.ndjson$/, '-summary.ndjson');
  const { model, effort } = deps.summaryModel;
  // Before the row, because the prompt reads the shared rules off disk. A read that fails after the
  // row is written leaves a run nothing will ever end.
  const prompt = extractSummaryPrompt(said(events));
  const runId = startRun(db, { cardKey: job.cardKey, phase: 'extract-summary', engine: deps.engine, model, effort, sessionId: null, logPath, lane: null });
  const extraction: Job = {
    ...job,
    runId,
    phase: 'extract-summary',
    // The pass has a row of its own in the action table, so it has a profile of its own. Named
    // here, the job and the run row cannot say two different logins.
    engine: deps.engine,
    model,
    effort,
    prompt,
    sessionId: null,
    resumeFrom: null,
    logPath,
    tools: EXTRACT_SUMMARY_POLICY.tools,
    mcpConfigPath: null,
    // The run's servers and their secrets stay with the run: the pass reads its prompt and nothing else.
    mcp: undefined,
    // The QA copy is deleted when the run ends, and the pass reads only its prompt, so it starts in
    // the checkout.
    qaCopy: null,
    // settingsPath comes from the run this summarises: the pass is read-only, so it needs the guard
    // as much as the phase did.
  };

  const answer: RunEvent[] = [];
  try {
    for await (const event of deps.extract(extraction)) answer.push(event);
  } catch (error) {
    answer.push({ type: 'failed', reason: (error as Error).message, status: null });
  }
  saveRun(db, runId, foldRun(answer, deps.signal?.aborted ?? false));

  const summary = cleanSummary(said(answer));
  if (!needsExtraction(summary)) savePlainSummary(db, job.runId, summary);
}
