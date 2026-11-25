import type { RunEvent } from '@nolzu/protocol';
import { describe, expect, it } from 'vitest';
import { parseClaudeLine } from './claude.ts';
import { parseCodexLine } from './codex.ts';
import { parseCursorLine } from './cursor.ts';
import { limitReached, limitText, limitWindows, resetText, retryDelay, retryable } from './retry.ts';

const WAITS = [2 * 60_000, 5 * 60_000, 15 * 60_000];
const failed = (status: number | null, reason = 'API Error: 529 Overloaded'): Extract<RunEvent, { type: 'failed' }> => ({ type: 'failed', reason, status });

describe('retryDelay', () => {
  it('waits 2, then 5, then 15 minutes, and gives up after the third', () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelay(attempt, WAITS))).toEqual([2 * 60_000, 5 * 60_000, 15 * 60_000, null]);
  });
});

describe('retryable', () => {
  it.each([429, 500, 529])('retries status %i', (status) => {
    expect(retryable(failed(status), 'a-session')).toBe(true);
  });

  it('retries an API error that came with no status', () => {
    expect(retryable(failed(null, 'API Error: Connection error.'), 'a-session')).toBe(true);
  });

  // Codex gives no status, only its sentence, on the failed turn. A run printed the first one. The
  // second is the high demand sentence the 0.157.0 binary holds, which no run has printed yet.
  it.each([
    ['a Codex model at capacity', 'Selected model is at capacity. Please try a different model.'],
    ['Codex under high demand', 'We’re currently experiencing high demand, which may cause temporary errors.'],
    ['an overloaded service', 'The service is overloaded. Try again later.'],
  ])('retries %s with no status', (_, reason) => {
    expect(retryable(failed(null, reason), 'a-session')).toBe(true);
  });

  // A second try changes none of these, and each retry loads the whole project context again.
  it.each([
    ['max turns', failed(null, 'error_max_turns')],
    ['a refused permission', failed(null, 'Claude requested permissions to write, but you have not granted it yet.')],
    ['an authentication failure', failed(401, 'API Error: 401 authentication_error')],
    ['a bad request', failed(400, 'API Error: 400 invalid_request_error')],
    ['a request too long, with no status', failed(null, 'API Error: 400 prompt is too long')],
    ['an empty credit balance, with no status', failed(null, 'API Error: Credit balance is too low')],
    ['a model at capacity whose sentence also names a login failure', failed(null, 'At capacity: unauthorized')],
    ['a model at capacity whose sentence also names the credit', failed(null, 'At capacity, and the credit is used up')],
    ['a usage limit with no status', failed(null, "You've hit your usage limit. Try again later.")],
  ])('does not retry %s', (_, event) => {
    expect(retryable(event, 'a-session')).toBe(false);
  });

  it('does not retry a run with no session, because there is nothing to resume', () => {
    expect(retryable(failed(529), null)).toBe(false);
  });

  // The next attempt would read what the run left as the state before it, and the run chose the name.
  it('never retries a run a check stopped, whatever its sentence says', () => {
    expect(retryable({ ...failed(null, 'The run created or replaced /home/me/.cursor/overloaded, /home/me/.cursor/hooks.json'), halted: true }, 'a-session')).toBe(false);
  });
});

describe('limitReached', () => {
  const now = Date.UTC(2026, 8, 21, 15, 0);
  const window = (name: 'five_hour' | 'seven_day', hoursOut: number, used = 1): RunEvent => ({
    type: 'rate_limit',
    windows: [{ name, used, resetsAt: Math.floor(now / 1000) + hoursOut * 3600, status: null }],
  });

  // A usage limit resets hours later. The three resumes would all fail, each loading the project again,
  // and the card would end on a status number where it could say when to try again.
  it('names a window that resets after the whole schedule is over', () => {
    expect(limitReached([window('five_hour', 4)], failed(429), now, WAITS)).toEqual({ name: 'five_hour', used: 1, resetsAt: Math.floor(now / 1000) + 4 * 3600, status: null });
  });

  it('is nothing when the window resets inside the schedule', () => {
    expect(limitReached([window('five_hour', 0.2)], failed(429), now, WAITS)).toBeNull();
  });

  it('is nothing for a 429 that came with no window, which still gets the schedule', () => {
    expect(limitReached([], failed(429), now, WAITS)).toBeNull();
  });

  // Every real run reports its windows, full or not. Measured on a run at 14 percent, both windows
  // reset hours out, and a 429 then is a busy server, not a usage limit.
  it('is nothing for windows that are not full, however late they reset', () => {
    const real: RunEvent = {
      type: 'rate_limit',
      windows: [
        { name: 'five_hour', used: 0.14, resetsAt: Math.floor(now / 1000) + 4 * 3600, status: null },
        { name: 'seven_day', used: 0.14, resetsAt: Math.floor(now / 1000) + 90 * 3600, status: null },
      ],
    };

    expect(limitReached([real], failed(429), now, WAITS)).toBeNull();
  });

  it('names the full window, not the one that resets last', () => {
    const both: RunEvent = {
      type: 'rate_limit',
      windows: [
        { name: 'five_hour', used: 1, resetsAt: Math.floor(now / 1000) + 4 * 3600, status: null },
        { name: 'seven_day', used: 0.14, resetsAt: Math.floor(now / 1000) + 90 * 3600, status: null },
      ],
    };

    expect(limitReached([both], failed(429), now, WAITS)?.name).toBe('five_hour');
  });

  it('is nothing for a failure that is not a 429', () => {
    expect(limitReached([window('five_hour', 4)], failed(529), now, WAITS)).toBeNull();
  });

  // The shape the engine sends when it refuses a window and reports no share for it. Reading the
  // share alone let the card burn the whole schedule on resumes that cannot succeed, and end on the
  // status number where the Engines screen already said the account was at its limit.
  it('names a window the engine refused although it reported no share for it', () => {
    const refused: RunEvent = { type: 'rate_limit', windows: [{ name: 'seven_day', used: null, resetsAt: Math.floor(now / 1000) + 90 * 3600, status: 'rejected' }] };

    expect(limitReached([refused], failed(429), now, WAITS)?.name).toBe('seven_day');
  });

  // A word this version has not seen is not a refusal, or a new status would stop every retry.
  it('is nothing for a window whose status is a word this version does not know', () => {
    const odd: RunEvent = { type: 'rate_limit', windows: [{ name: 'five_hour', used: 0.2, resetsAt: Math.floor(now / 1000) + 4 * 3600, status: 'throttled' }] };

    expect(limitReached([odd], failed(429), now, WAITS)).toBeNull();
  });
});

/**
 * What each engine's own lines say about a usage limit, and what is read from them.
 *
 * The lines come from what real runs recorded on 2026-09-25, in `docs/engines/`. Claude Code is the
 * one engine that reports a window. No recorded run hit a usage limit, so
 * the refused window below is built from the documented fields (`status` on the window
 * `rateLimitType` names) and not from a run that was refused.
 */
describe('limitWindows', () => {
  // The recorded shape of a Claude Code line, both windows reported and nothing refused. The
  // shares are chosen under the limit, because the recorded run was at 14 percent and a run near
  // the limit is what this test is about.
  const CLAUDE_ALLOWED =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1789551000,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.62,"resetsAt":1789551000},"seven_day":{"utilization":0.41,"resetsAt":1789830000}}},"session_id":"5e8c1a24"}';
  // The same line with the documented refusal on the window it names.
  const CLAUDE_REFUSED =
    '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1789551000,"rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":1,"resetsAt":1789551000},"seven_day":{"utilization":0.41,"resetsAt":1789830000}}},"session_id":"5e8c1a24"}';
  // Codex reports token counts and no window when a turn ends, recorded on 2026-09-25.
  const CODEX_DONE = '{"type":"turn.completed","usage":{"input_tokens":25709,"cached_input_tokens":14080,"cache_write_input_tokens":0,"output_tokens":130,"reasoning_output_tokens":40}}';
  // Cursor reports token counts and no window when a run ends, recorded on 2026-09-25.
  const CURSOR_DONE =
    '{"type":"result","subtype":"success","duration_ms":9476,"duration_api_ms":9476,"is_error":false,"result":"Done.","session_id":"a2e5","request_id":"8ad4","usage":{"inputTokens":15931,"outputTokens":435,"cacheReadTokens":27264,"cacheWriteTokens":12}}';

  it('reads the refused window out of a Claude Code stream', () => {
    expect(limitWindows(parseClaudeLine(CLAUDE_REFUSED), failed(429)).map((window) => window.name)).toEqual(['five_hour']);
  });

  it('reads no limit out of a Claude Code stream that reported both windows and refused neither', () => {
    expect(limitWindows(parseClaudeLine(CLAUDE_ALLOWED), failed(429))).toEqual([]);
  });

  // Codex has never been seen to report a window, and no recorded Codex run hit a usage
  // limit, so there is no Codex limit text to read. A Codex run that ends on a 429 carries the
  // engine's own reason to the card and no limit.
  it('reads no limit out of a Codex stream, which reports no window', () => {
    expect(limitWindows(parseCodexLine(CODEX_DONE), failed(429))).toEqual([]);
  });

  it('reads no limit out of a Cursor stream, which reports no window', () => {
    expect(limitWindows(parseCursorLine(CURSOR_DONE), failed(429))).toEqual([]);
  });

  // The false positive this guards: the words of a failure are never read as a limit. A refine run
  // whose own error quotes the card, and a card about rate limits, both say the words.
  it('reads no limit out of a failure that only mentions a usage limit in its text', () => {
    const mentions = failed(500, 'API Error: 500 while writing the section about the usage limit of the recipe API');

    expect(limitWindows(parseClaudeLine(CLAUDE_REFUSED), mentions)).toEqual([]);
    expect(limitText(limitWindows(parseClaudeLine(CLAUDE_REFUSED), mentions), Date.UTC(2026, 8, 21, 15, 0), 'UTC')).toBeNull();
  });

  it('reads no limit out of a 429 that came with no window at all', () => {
    expect(limitWindows([], failed(429))).toEqual([]);
  });

  // The engine reports its windows again and again, and the retries pile those readings up. Two
  // readings of one window are one window, or the card names the same limit twice.
  it('keeps the last reading of a window the engine reported more than once', () => {
    const twice = [...parseClaudeLine(CLAUDE_REFUSED), ...parseClaudeLine(CLAUDE_REFUSED)];

    expect(limitWindows(twice, failed(429))).toEqual([{ name: 'five_hour', used: 1, resetsAt: 1789551000, status: 'rejected' }]);
  });

  // The later reading is the engine's last word about that window, the same reading the Engines
  // screen stores, so the card says what that screen says.
  it('names the limit once when a later reading of it dropped the reset time', () => {
    const noReset = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 1 } } },
      session_id: '5e8c1a24',
    });
    const both = [...parseClaudeLine(CLAUDE_REFUSED), ...parseClaudeLine(noReset)];

    expect(limitText(limitWindows(both, failed(429)), Date.UTC(2026, 8, 21, 15, 0), 'UTC')).toBe(
      '5-hour limit reached. The engine reported no reset time, so when it frees up is not known.',
    );
  });
});

describe('limitText', () => {
  const now = Date.UTC(2026, 8, 21, 15, 0);
  const at = (hoursOut: number) => Math.floor(now / 1000) + hoursOut * 3600;

  it('names the limit and the reset time the engine reported', () => {
    expect(limitText([{ name: 'five_hour', used: 1, resetsAt: at(4), status: null }], now, 'UTC')).toBe('5-hour limit, resets 19:00');
  });

  // A card that showed the earlier time would send a person into a run the weekly window refuses
  // again.
  it('names the window that frees up last when two are full', () => {
    const both = [
      { name: 'five_hour', used: 1, resetsAt: at(4), status: null },
      { name: 'seven_day', used: 1, resetsAt: at(66), status: null },
    ];

    expect(limitText(both, now, 'UTC')).toBe('Weekly limit, resets Thu 09:00');
  });

  // Nothing is invented for a reset the engine did not report. A guessed time reads as a
  // measurement, and the person plans their day around it.
  it('says the reset time is not known when the engine reported none', () => {
    expect(limitText([{ name: 'seven_day', used: null, resetsAt: null, status: 'rejected' }], now, 'UTC')).toBe(
      'Weekly limit reached. The engine reported no reset time, so when it frees up is not known.',
    );
  });

  it('drops the reset time of the whole sentence when one full window has none', () => {
    const both = [
      { name: 'five_hour', used: 1, resetsAt: at(4), status: null },
      { name: 'seven_day', used: 1, resetsAt: null, status: null },
    ];

    expect(limitText(both, now, 'UTC')).toBe('5-hour limit and Weekly limit reached. The engine reported no reset time, so when it frees up is not known.');
  });

  it('is nothing when the run stopped on something other than a usage limit', () => {
    expect(limitText([], now, 'UTC')).toBeNull();
  });
});

describe('resetText', () => {
  const now = Date.UTC(2026, 8, 21, 15, 0);

  it('names the window and the time when it resets today', () => {
    expect(resetText({ name: 'five_hour', used: 1, resetsAt: Date.UTC(2026, 8, 21, 19, 0) / 1000, status: null }, now, 'UTC')).toBe('5-hour limit, resets 19:00');
  });

  it('adds the day when it resets on another day', () => {
    expect(resetText({ name: 'seven_day', used: 1, resetsAt: Date.UTC(2026, 8, 24, 9, 30) / 1000, status: null }, now, 'UTC')).toBe('Weekly limit, resets Thu 09:30');
  });
});
