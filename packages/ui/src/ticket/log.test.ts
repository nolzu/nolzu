import type { RunEvent } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { clockTime, KIND_WORDS, LOG_WORDS, type LogRow, type LogRun, logRows, retryLine, runCount, runGroups, runTag, runTotals, sinceStart, withoutTools } from './log.ts';

const retry = (over: Partial<Extract<RunEvent, { type: 'api_retry' }>> = {}): RunEvent => ({
  type: 'api_retry',
  attempt: 2,
  delayMs: 300_000,
  status: 429,
  maxRetries: 3,
  reason: 'rate_limit',
  ...over,
});

describe('logRows', () => {
  it('gives each event one row of its own kind', () => {
    const rows = logRows([
      { type: 'session', sessionId: 'e93a6d12-8b4f-4c07-a2d5-6f1e0c9b8a03', model: 'sonnet', apiKeyMode: false },
      { type: 'text', text: 'Reading the list.' },
      { type: 'tool', name: 'Read', input: { file_path: 'src/list.ts' } },
      retry(),
      { type: 'rate_limit', windows: [{ name: 'five_hour', used: 0.4, resetsAt: 1_790_000_000, status: 'allowed' }] },
      { type: 'needs_input', question: 'Titles only?' },
      { type: 'permission_denied', denied: [{ tool: 'Write', id: null, path: 'src/list.ts' }] },
      { type: 'complete', costUsd: 0.04, durationMs: 18_000, tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 } },
      { type: 'failed', reason: 'The run went quiet.', status: null },
    ]);

    expect(rows.map((row) => row.kind)).toEqual(['session', 'text', 'tool', 'retry', 'limit', 'question', 'denied', 'complete', 'failed']);
  });

  it('makes no row for an event type it does not know', () => {
    expect(logRows([{ type: 'something_new' } as unknown as RunEvent])).toEqual([]);
  });

  it('says a retry in words: the attempt, the wait, the reason and the status', () => {
    expect(logRows([retry()])[0]?.text).toBe('Retry 2 after 5 min, rate limit, status 429');
  });

  it('says so when a retry came with no status or no reason', () => {
    expect(logRows([retry({ status: null, reason: null, delayMs: 30_000 })])[0]?.text).toBe('Retry 2 after 30 s, no reason given, no status');
  });

  it('keeps the tool name in view and the input folded away', () => {
    const [row] = logRows([{ type: 'tool', name: 'Read', input: { file_path: 'src/list.ts' } }]);

    expect(row?.text).toBe('Read');
    expect(row?.detail).toBe('{\n  "file_path": "src/list.ts"\n}');
  });

  it('names the refused tool and what it was refused on', () => {
    expect(logRows([{ type: 'permission_denied', denied: [{ tool: 'Write', id: null, path: 'src/list.ts' }] }])[0]?.text).toBe('Refused: Write on src/list.ts');
  });

  // The reason says whether a rule is missing or no rule can allow the call, which the tool name cannot.
  it('says why the engine refused, in its own words', () => {
    const refused = (...reasons: string[]) => logRows([{ type: 'permission_denied', denied: reasons.map((reason) => ({ tool: 'Bash', id: null, path: null, reason })) }])[0]?.text;

    expect(refused("A variable in this command can't be checked before it runs")).toBe("Refused: Bash. A variable in this command can't be checked before it runs");
    // A reason that ends its own sentence does not end it twice.
    expect(refused('Approve only if you trust it.', 'This command requires approval')).toBe('Refused: Bash, Bash. Approve only if you trust it. This command requires approval');
  });

  // The engine's rule matching stops at a variable set in front, so the line names the rule that allows it.
  it('names the rule for a refused command with a variable in front, and none for a chained one', () => {
    const refused = (...commands: string[]) =>
      logRows([{ type: 'permission_denied', denied: commands.map((path) => ({ tool: 'Bash', id: null, path })) }])[0]?.text;

    expect(refused('PORT=3000 npm start')).toBe(
      "Refused: Bash on PORT=3000 npm start. A command with a variable in front matches only a rule that names the variable too. To allow it, add PORT=3000 npm start to the project's allowed commands, with a * at the end for any arguments.",
    );
    expect(refused('node build', 'PORT=3000 HOST=0.0.0.0 node build')).toMatch(/add PORT=3000 HOST=0\.0\.0\.0 node build to/);
    expect(refused('PORT=3000 node build & sleep 3; kill %1')).toBe('Refused: Bash on PORT=3000 node build & sleep 3; kill %1');
    expect(refused('npm start')).toBe('Refused: Bash on npm start');
    expect(refused('PORT=3000')).toBe('Refused: Bash on PORT=3000');
    expect(refused('PORT=* npm start')).toBe('Refused: Bash on PORT=* npm start');
    expect(refused('PORT=3000 -x')).toBe('Refused: Bash on PORT=3000 -x');
    // A quoted or escaped value holds a space, so a split on spaces would name the wrong command.
    expect(refused('FOO="a b" npm start')).toBe('Refused: Bash on FOO="a b" npm start');
    expect(refused("FOO='a b' npm start")).toBe("Refused: Bash on FOO='a b' npm start");
    expect(refused('FOO=a\\ b npm start')).toBe('Refused: Bash on FOO=a\\ b npm start');
    // Only a shell command takes an allowed command. A path that looks like one says nothing more.
    expect(logRows([{ type: 'permission_denied', denied: [{ tool: 'Read', id: null, path: 'A=1 notes.md' }] }])[0]?.text).toBe('Refused: Read on A=1 notes.md');
  });

  // Claude Code names the model and reports a cost. Codex names neither, and a line that said
  // "on null" or "no cost yet estimated" would read as something the page failed to load.
  it('leaves out what the engine did not report', () => {
    const rows = logRows([
      { type: 'session', sessionId: 'e93a6d12', model: null, apiKeyMode: null },
      { type: 'complete', costUsd: null, durationMs: null, tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } },
    ]);

    expect(rows[0]?.text).toBe('Session e93a6d12');
    expect(rows[1]?.text).toBe('Done');
  });

  it('says the model, the API key and the cost when the engine reports them', () => {
    const rows = logRows([
      { type: 'session', sessionId: 'e93a6d12', model: 'sonnet', apiKeyMode: true },
      { type: 'complete', costUsd: 0.04, durationMs: 18_000, tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } },
    ]);

    expect(rows[0]?.text).toBe('Session e93a6d12 on sonnet, with an API key');
    expect(rows[1]?.text).toBe('Done in 18s, $0.04 estimated');
  });

  it('reads a usage window as a share and a reset time', () => {
    const [row] = logRows([{ type: 'rate_limit', windows: [{ name: 'five_hour', used: 0.4, resetsAt: 1_790_000_000, status: 'allowed' }] }]);

    expect(row?.text).toMatch(/^5-hour limit 40% used, resets /);
  });

  // The engine leaves both out in states it has not been seen in here. A zero in their place read
  // as 0% used and a reset in January 1970.
  it('says a share and a reset time the engine left out are missing', () => {
    const [row] = logRows([{ type: 'rate_limit', windows: [{ name: 'five_hour', used: null, resetsAt: null, status: 'rejected' }] }]);

    expect(row?.text).toBe('5-hour limit share not reported, no reset time reported');
  });
});

describe('withoutTools', () => {
  it('drops the tool rows and says how many it hid', () => {
    const rows = logRows([
      { type: 'text', text: 'One.' },
      { type: 'tool', name: 'Read', input: {} },
      { type: 'tool', name: 'Grep', input: {} },
      { type: 'text', text: 'Two.' },
    ]);

    const shown = withoutTools(rows);

    expect(shown.rows.map((row) => row.text)).toEqual(['One.', 'Two.']);
    expect(shown.hidden).toBe(2);
  });
});

const usage = (id: string | null, input: number, output: number): RunEvent => ({ type: 'usage', id, tokens: { input, output, cacheRead: 26_000, cacheCreation: 0 } });

describe('the rows of the new engine events', () => {
  // The lines where the answer was text, and the size at the edge. A picture, or an event from before
  // the line count, has only its size.
  it('says how much a tool gave back, and when the engine marked it an error', () => {
    const rows = logRows([
      { type: 'tool_result', bytes: 2970, error: false, lines: 84 },
      { type: 'tool_result', bytes: 410, error: true, lines: 1 },
      { type: 'tool_result', bytes: 49_152, error: false },
      { type: 'tool_result', bytes: 0, error: true, lines: 0 },
    ]);

    expect(rows.map((row) => [row.kind, row.text, row.aside])).toEqual([
      ['result', '84 lines', '2.9 KB'],
      ['result', 'Error, 1 line', '410 B'],
      ['result', '', '48 KB'],
      ['result', 'Error, 0 lines', '0 B'],
    ]);
  });

  // The total is what a person reads, and a call that arrives on two lines adds nothing the second time.
  it('says the tokens so far after each call that changed them, and nothing for a repeat', () => {
    const rows = logRows([usage('msg_1', 2, 7800), { type: 'text', text: 'Reading the list.' }, usage('msg_1', 2, 7800), usage('msg_2', 3, 5400)]);

    expect(rows.filter((row) => row.kind === 'usage').map((row) => row.text)).toEqual(['7.8k tokens so far', '13.2k tokens so far']);
  });

  it('makes no tokens row for a run whose engine reported no usage', () => {
    const rows = logRows([{ type: 'text', text: 'Done.' }, { type: 'complete', costUsd: 0.04, durationMs: 18_000, tokens: { input: 1, output: 2, cacheRead: 0, cacheCreation: 0 } }]);

    expect(rows.map((row) => row.kind)).toEqual(['text', 'complete']);
  });

  it('hides a tool result with the tool calls, and counts only the calls', () => {
    const shown = withoutTools(logRows([{ type: 'tool', name: 'Read', input: {} }, { type: 'tool_result', bytes: 12, error: false }, { type: 'text', text: 'One.' }]));

    expect(shown.rows.map((row) => row.kind)).toEqual(['text']);
    expect(shown.hidden).toBe(1);
  });
});

describe('a retry wait Nolzu holds', () => {
  const until = 1_790_000_300_000;
  const held = retry({ attempt: 2, maxRetries: 3, status: 529, reason: 'API Error: 529 Overloaded', until } as Partial<Extract<RunEvent, { type: 'api_retry' }>>);

  it('counts down to the stored time the next try starts', () => {
    expect(logRows([held], until - 134_000)[0]).toMatchObject({ kind: 'retry', text: 'API Error: 529 Overloaded, retrying in 2m 14s, attempt 2 of 3, status 529' });
    expect(logRows([held], until - 400)[0]?.text).toBe('API Error: 529 Overloaded, retrying in 1s, attempt 2 of 3, status 529');
    expect(logRows([held], until + 5000)[0]?.text).toBe('API Error: 529 Overloaded, retrying now, attempt 2 of 3, status 529');
  });

  it('says a wait the run has moved past in the past tense', () => {
    const rows = logRows([held, { type: 'session', sessionId: 'e93a6d12', model: 'sonnet', apiKeyMode: false }], until - 134_000);

    expect(rows[0]?.text).toBe('API Error: 529 Overloaded, tried again after 5 min, attempt 2 of 3, status 529');
  });

  // A stop in the wait, or a restart, writes no later line. The wait must not count down for ever.
  it('says the wait ended for a run that ended in it', () => {
    expect(logRows([held], until + 600_000, true)[0]?.text).toBe('API Error: 529 Overloaded, stopped waiting to try again, attempt 2 of 3, status 529');
  });

  it('reads the countdown words alone for Now and the card', () => {
    expect(retryLine({ attempt: 1, maxRetries: null, reason: null, until }, until - 61_000)).toBe('No reason given, retrying in 1m 01s, attempt 1');
  });
});

describe('the kind column', () => {
  it('gives every row kind a short word', () => {
    const kinds: LogRow['kind'][] = ['session', 'text', 'tool', 'result', 'usage', 'retry', 'limit', 'question', 'denied', 'complete', 'failed'];

    expect(kinds.map((kind) => KIND_WORDS[kind])).toEqual(['session', 'says', 'tool', 'result', 'tokens', 'retry', 'limit', 'asks', 'refused', 'done', 'failed']);
  });
});

const RUN: LogRun = {
  id: 7,
  phase: 'implement',
  state: 'running',
  startedAt: '2026-10-15T10:00:00.000Z',
  endedAt: null,
  engine: 'claude-code',
  model: 'sonnet',
  effort: 'high',
  costUsd: null,
  durationMs: null,
  tokens: null,
};

describe('runTotals', () => {
  const now = new Date('2026-10-15T10:02:14.000Z');

  it('counts a running run up to now, with the tokens so far and no cost', () => {
    expect(runTotals(RUN, [usage('msg_1', 400, 18_000)], now)).toEqual({ elapsed: '2m 14s', tokens: '18.4k', cost: null, unpriced: false });
  });

  it('reads an ended run off its row: the time it took, its tokens and the cost the engine reported', () => {
    const ended = { ...RUN, state: 'complete', endedAt: '2026-10-15T10:05:00.000Z', costUsd: 0.31, tokens: 21_000 };

    expect(runTotals(ended, [usage('msg_1', 400, 18_000)], now)).toEqual({ elapsed: '5m 00s', tokens: '21k', cost: '$0.31', unpriced: false });
  });

  // Codex and Cursor give no counts before the end, and a stopped run reports none at all. An ended
  // run with no cost says so, so the footer does not read as one still on its way.
  it('says nothing of tokens the engine did not report, and that an ended run reported no cost', () => {
    expect(runTotals({ ...RUN, state: 'stopped', endedAt: '2026-10-15T10:01:00.000Z' }, [{ type: 'text', text: 'One.' }], now)).toEqual({ elapsed: '1m 00s', tokens: null, cost: null, unpriced: true });
  });

  it('shows no time for a run that has not started, and never counts an ended run on', () => {
    expect(runTotals({ ...RUN, state: 'queued', startedAt: null }, [], now).elapsed).toBeNull();
    expect(runTotals({ ...RUN, state: 'interrupted', endedAt: null }, [], now).elapsed).toBeNull();
  });
});

describe('runTag', () => {
  it('says running for a run that goes, and queued for one that waits', () => {
    expect(runTag(RUN)).toBe('running');
    expect(runTag({ ...RUN, state: 'retrying' })).toBe('running');
    expect(runTag({ ...RUN, state: 'waiting_lane', startedAt: null })).toBe('queued');
  });

  it('gives an ended run its word first, then its time and cost', () => {
    expect(runTag({ ...RUN, state: 'complete', durationMs: 22_000, costUsd: 0.02 })).toBe('done · 22s · $0.02');
    expect(runTag({ ...RUN, state: 'complete' })).toBe('done');
    expect(runTag({ ...RUN, state: 'failed', durationMs: 300_000 })).toBe('failed · 5m 00s');
    expect(runTag({ ...RUN, state: 'stopped' })).toBe('stopped');
  });
});

describe('runGroups', () => {
  const run = (id: number, phase: string): LogRun => ({ id, phase, state: 'complete', startedAt: null });

  // Newest first, as the page hands them. A phase that ran once has no number, and a number counts
  // that phase's runs from its first, so a Plan after Implement is still Plan's second.
  it('puts runs of one phase in a row under one heading, and numbers a phase that ran more than once', () => {
    const groups = runGroups([run(6, 'plan'), run(5, 'implement'), run(4, 'plan'), run(3, 'plan'), run(1, 'refine')]);

    expect(groups.map((group) => [group.phase, group.runs.map((one) => [one.run.id, one.attempt])])).toEqual([
      ['plan', [[6, 3]]],
      ['implement', [[5, null]]],
      ['plan', [[4, 2], [3, 1]]],
      ['refine', [[1, null]]],
    ]);
  });

  it('gives no group for no run', () => {
    expect(runGroups([])).toEqual([]);
  });
});

describe('a says row', () => {
  // The marker is for the runner and the done row says the run ended. A question has its own row.
  it('leaves out the closing marker and the question line, and keeps the markdown', () => {
    const rows = logRows([
      { type: 'text', text: '## What changed\n\nA placeholder.\n\nNOLZU: complete\n' },
      { type: 'text', text: 'Which list?\n  NOLZU: needs_input: Titles only?' },
      { type: 'text', text: 'NOLZU: complete' },
    ]);

    expect(rows.map((row) => row.text)).toEqual(['## What changed\n\nA placeholder.', 'Which list?']);
  });

  // Only a line that is the marker goes. A sentence that names it is what the agent said.
  it('keeps a sentence that only names the marker', () => {
    expect(logRows([{ type: 'text', text: 'I print NOLZU: complete at the end.' }])[0]?.text).toBe('I print NOLZU: complete at the end.');
  });
});

describe('the time column', () => {
  it('counts from the start of the run, in minutes and seconds, and hours past the first', () => {
    expect([0, 4_000, 59_999, 131_000, 3_723_000, -2_000].map(sinceStart)).toEqual(['0:00', '0:04', '0:59', '2:11', '1:02:03', '0:00']);
  });

  it('times each row by the time the runner noted for its line, the tokens row too', () => {
    const start = Date.parse('2026-10-15T10:00:00.000Z');
    const rows = logRows([{ type: 'text', text: 'One.', at: start + 2_000 }, { ...usage('msg_1', 400, 7_400), at: start + 31_000 }, { type: 'text', text: 'Two.' }], 0, false, start);

    expect(rows.map((row) => [row.kind, row.time])).toEqual([
      ['text', '0:02'],
      ['usage', '0:31'],
      ['text', undefined],
    ]);
  });

  it('draws no times without a start to count from', () => {
    expect(logRows([{ type: 'text', text: 'One.', at: 5_000 }])[0]?.time).toBeUndefined();
  });
  // The peek sheet says the time of day, which the server formats in the machine's zone.
  it('says the time of day instead where the caller hands a clock', () => {
    const at = Date.parse('2026-10-15T14:02:31.000Z');
    const rows = logRows([{ type: 'text', text: 'One.', at }, { type: 'text', text: 'Two.' }], 0, false, null, (ms) => clockTime(ms, 'UTC'));

    expect(rows.map((row) => row.time)).toEqual(['14:02:31', undefined]);
  });
});

describe('the words of the full log', () => {
  it('names a says row assistant and a tool row tool call, and keeps the short words for the peek sheet', () => {
    expect([LOG_WORDS.text, LOG_WORDS.tool, LOG_WORDS.result, LOG_WORDS.usage]).toEqual(['assistant', 'tool call', 'result', 'tokens']);
    expect([KIND_WORDS.text, KIND_WORDS.tool]).toEqual(['says', 'tool']);
  });

  it('keeps what a tool acted on, where the route read one, and nothing where it did not', () => {
    const rows = logRows([
      { type: 'tool', name: 'Read', input: { file_path: 'web/src/lib/RecipeCard.svelte' }, subject: 'web/src/lib/RecipeCard.svelte' },
      { type: 'tool', name: 'Glob', input: {}, subject: null },
      { type: 'tool', name: 'Grep', input: {} },
    ]);

    expect(rows.map((row) => row.subject)).toEqual(['web/src/lib/RecipeCard.svelte', undefined, undefined]);
  });
});

// Each Run triage press is a run of its own, so three of them are not three attempts at one.
describe('runCount', () => {
  it('counts triage runs as runs and every other phase as attempts', () => {
    expect(runCount('feedback', 2)).toBe('Run 2');
    expect(runCount('implement', 2)).toBe('Attempt 2');
  });
});
