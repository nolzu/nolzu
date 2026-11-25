import { describe, expect, it } from 'vitest';
import { mergeSpend, type SpendRun, spendOf } from './spend.ts';

// What the two engines really report. Claude Code sends a cost with its counts, Codex sends counts
// and no cost at all, and its input count already holds the cached tokens.
const claude: SpendRun = { costUsd: 0.0412, durationMs: 18_240, tokens: { input: 9, output: 412, cacheRead: 14_820, cacheCreation: 3_310 } };
const codex: SpendRun = { costUsd: null, durationMs: null, tokens: { input: 21_430, output: 1_208, cacheRead: 18_944, cacheCreation: 0 } };
// A run a person stopped, and a run still queued. Neither reported anything.
const stopped: SpendRun = { costUsd: null, durationMs: null, tokens: null };

describe('spendOf', () => {
  it('shows one cost and one token count for a Claude Code run and a Codex run, and says the cost is partial', () => {
    const spend = spendOf([claude, codex]);

    // The Claude Code cost alone. Adding the Codex run as zero would read as the whole bill.
    expect(spend.costUsd).toBe(0.0412);
    expect(spend.partial).toBe(true);
    expect(spend.reported).toBe(1);
    expect(spend.runs).toBe(2);
    // Input and output of both runs, cache reads left out.
    expect(spend.tokens).toBe(23_059);
    expect(spend.tokensOnly).toBe(1);
  });

  it('is not partial when every run reported a cost', () => {
    const spend = spendOf([claude, { ...claude, costUsd: 0.5 }]);

    expect(spend.costUsd).toBeCloseTo(0.5412);
    expect(spend.partial).toBe(false);
    expect(spend.tokensOnly).toBe(0);
  });

  it('shows no cost when no run reported one, and says how many reported tokens instead', () => {
    const spend = spendOf([codex, codex]);

    expect(spend.costUsd).toBeNull();
    expect(spend.tokensOnly).toBe(2);
    expect(spend.tokens).toBe(45_276);
    expect(spend.partial).toBe(true);
  });

  // The case a `!cost` or a `cost ?? 0` in the code hides: the engine answered, and the answer was
  // nothing.
  it('counts a reported cost of nought as reported, and not as missing', () => {
    const spend = spendOf([{ ...claude, costUsd: 0 }]);

    expect(spend.costUsd).toBe(0);
    expect(spend.reported).toBe(1);
    expect(spend.partial).toBe(false);
    expect(spend.tokensOnly).toBe(0);
  });

  it('adds a known nought to a cost rather than dropping the run', () => {
    expect(spendOf([claude, { ...claude, costUsd: 0 }])).toMatchObject({ costUsd: 0.0412, reported: 2, partial: false });
  });

  it('reports nothing for a run that reported nothing, and still counts the run', () => {
    expect(spendOf([stopped])).toEqual({ runs: 1, reported: 0, costUsd: null, tokensOnly: 0, tokens: null, durationMs: 0, partial: true });
  });

  it('has no numbers and is not partial for no runs at all', () => {
    expect(spendOf([])).toEqual({ runs: 0, reported: 0, costUsd: null, tokensOnly: 0, tokens: null, durationMs: 0, partial: false });
  });

  // Null tokens mean the engine reported no usage. Zero counts mean it reported usage of nothing.
  it('tells a run that reported no counts from a run that counted nought', () => {
    expect(spendOf([{ ...claude, tokens: null }]).tokens).toBeNull();
    expect(spendOf([{ ...claude, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } }]).tokens).toBe(0);
  });

  // A cost column with no check on it can hold one of these. One bad row must not take the other
  // runs' costs down with it.
  it.each([Number.NaN, Number.POSITIVE_INFINITY])('counts %s as a missing cost', (bad) => {
    const spend = spendOf([claude, { ...claude, costUsd: bad }]);

    expect(spend.costUsd).toBe(0.0412);
    expect(spend.partial).toBe(true);
  });

  // The token counts are never turned into money, so a run on an engine that reports no cost adds
  // nothing to the figure however large its counts are.
  it('never makes a cost out of a token count', () => {
    expect(spendOf([{ ...codex, tokens: { input: 9_000_000, output: 500_000, cacheRead: 0, cacheCreation: 0 } }]).costUsd).toBeNull();
  });
});

describe('mergeSpend', () => {
  // A day total and the project total are the same runs grouped differently, so they have to agree.
  it('adds roll-ups to the same answer as one roll-up over every run', () => {
    const runs = [claude, { ...claude, costUsd: 0.5 }, codex, stopped, { ...claude, costUsd: 0 }];
    // The first part holds two paid runs, so a `reported` count that only ever reached one would
    // show here. A card whose phase was paid twice, which any retry makes, is the common case.
    const merged = mergeSpend([spendOf(runs.slice(0, 2)), spendOf(runs.slice(2))]);

    expect(merged).toEqual(spendOf(runs));
    expect(merged).toMatchObject({ runs: 5, reported: 3 });
  });

  it('has no numbers for no parts', () => {
    expect(mergeSpend([])).toEqual(spendOf([]));
  });
});
