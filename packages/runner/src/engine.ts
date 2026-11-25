import { type EngineName, NEEDS_INPUT_PREFIX, SENTINEL_COMPLETE, type Job, type RunEvent } from '@nolzu/protocol';

export interface Engine {
  name: string;
  // The vendor whose model names `listModels` answers with. A profile row of another vendor means
  // nothing to this engine, so the board and the screens read this before calling a model gone.
  vendor: EngineName;
  spawn(job: Job, signal: AbortSignal): AsyncIterable<string>;
  parse(line: string): RunEvent[];
  // The models a run on this engine can name. The board marks a stored model outside it as gone.
  listModels(): readonly string[];
}

export type Sentinel = { kind: 'needs_input'; question: string } | { kind: 'complete' };

// The runtime contract asks for sentinels on their own line, so a mention inside a sentence
// never counts. A question wins over complete, because asking keeps a person in the loop.
//
// The two lines come from `@nolzu/protocol`, which is where the prompt and the skills take them
// from as well. Spelled again here, a change to the contract would leave the parser reading the
// old wording, which is exactly what the comment beside those constants asks not to happen.
export function detectSentinel(text: string): Sentinel | null {
  const lines = text.split('\n').map((line) => line.trim());
  for (const line of lines) {
    if (!line.startsWith(NEEDS_INPUT_PREFIX)) continue;
    const question = line.slice(NEEDS_INPUT_PREFIX.length).trim();
    if (question !== '') return { kind: 'needs_input', question };
  }
  return lines.includes(SENTINEL_COMPLETE) ? { kind: 'complete' } : null;
}

// A question becomes its own event so core can block the card. Completion needs no extra
// event: the engine's final result reports it together with the cost.
export function withSentinels(events: RunEvent[]): RunEvent[] {
  return events.flatMap((event): RunEvent[] => {
    const sentinel = event.type === 'text' ? detectSentinel(event.text) : null;
    return sentinel?.kind === 'needs_input' ? [event, { type: 'needs_input', question: sentinel.question }] : [event];
  });
}
