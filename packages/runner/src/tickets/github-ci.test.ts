import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultBranch, failedRuns, ghLogRunner, LOG_MAX_STDOUT, LOG_TOO_LARGE, readJobLog, readRuns, trimLog } from './github-ci.ts';
import type { RunGh } from './github.ts';

/**
 * HAND WRITTEN, AND NOT RECORDED.
 *
 * No answer about CI runs has been read from the real API here, and none exists anywhere in this
 * project: a read would be a call to GitHub, and the tests make none. Every field below is
 * written from the REST API's shape. Treat a CI finding as unverified until somebody records one real
 * answer, and treat these fixtures as a description of what the parser expects rather than as
 * evidence of what GitHub sends.
 *
 * The first real recording has to confirm six facts these tests are built on: that the array is named
 * `workflow_runs`, that a failed run answers the literal word `failure` in `conclusion` while `status`
 * is `completed`, that `head_branch` carries the branch name and matches the default branch when the
 * query asked for it, that `name` carries the workflow's own name, that `id` is a number and rises
 * with every run of the repository, and that `conclusion` is null while a run is still going rather
 * than missing from the row.
 *
 * It also has to confirm two things about the call: that `gh api -X GET repos/{owner}/{repo}` answers
 * `default_branch`, and that the runs endpoint accepts `branch` and `status` as query fields, with
 * `status=failure` naming a conclusion and not a run state.
 */
const runRow = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'Tests',
  head_branch: 'main',
  head_sha: '9f2c1ab',
  status: 'completed',
  conclusion: 'failure',
  html_url: `https://github.com/acme/app/actions/runs/${id}`,
  run_number: id - 9000,
  event: 'push',
  created_at: '2026-09-26T10:04:11Z',
  ...extra,
});

const runs = (...rows: object[]): string => JSON.stringify({ total_count: rows.length, workflow_runs: rows });

// A `gh` that answers each call in turn, and records what it was asked. Two calls here, so the
// answers come in order: the repository first, then its runs.
const gh = (...stdout: string[]): { run: RunGh; calls: string[][] } => {
  const calls: string[][] = [];
  return {
    calls,
    run: async (args) => {
      const at = calls.length;
      calls.push([...args]);
      return { code: 0, stdout: stdout[Math.min(at, stdout.length - 1)] ?? '', stderr: '' };
    },
  };
};

const live = (): AbortSignal => AbortSignal.timeout(1000);

const repo = (branch: string): string => JSON.stringify({ name: 'app', full_name: 'acme/app', default_branch: branch });

describe('defaultBranch', () => {
  it('reads the branch the repository answers with', () => {
    expect(defaultBranch(repo('main'))).toBe('main');
  });

  it('names none for a body it cannot read or one that carries no branch', () => {
    expect(defaultBranch('gh: not found')).toBeNull();
    expect(defaultBranch(JSON.stringify({ name: 'app' }))).toBeNull();
    expect(defaultBranch(JSON.stringify({ default_branch: '' }))).toBeNull();
  });
});

describe('readRuns', () => {
  /**
   * The test the plan asks for: a failed run becomes an item and a passing one does not.
   *
   * Filtered here as well as in the query, because the query's own filter is the server's. A field
   * name spelled wrong, or one the API stopped reading, would otherwise turn every green run into a
   * finding that says the pipeline is red.
   */
  it('keeps a failed run and drops a passing one', () => {
    const found = readRuns('acme/app', 'main', runs(runRow(9001), runRow(9002, { conclusion: 'success' })));

    expect(found).toEqual([{ repo: 'acme/app', workflow: 'Tests', branch: 'main', id: 9001 }]);
  });

  it('drops a run that is still going, which has no conclusion yet', () => {
    expect(readRuns('acme/app', 'main', runs(runRow(9003, { status: 'in_progress', conclusion: null })))).toEqual([]);
  });

  it('drops a run of another branch rather than reporting it under the default one', () => {
    expect(readRuns('acme/app', 'main', runs(runRow(9004, { head_branch: 'fix/cache' })))).toEqual([]);
  });

  it('names a workflow with no name, so the finding says something', () => {
    expect(readRuns('acme/app', 'main', runs(runRow(9005, { name: null })))[0]?.workflow).toBe('CI');
  });

  it('answers an empty list for a repository whose default branch has no failed run', () => {
    expect(readRuns('acme/app', 'main', runs())).toEqual([]);
  });

  /**
   * An unreadable answer is a refusal and not a green pipeline.
   *
   * A rate limited or unauthorised `gh api` prints readable JSON with no rows in it. An empty list
   * there would tell a person their CI is fine, which is the one thing this source must never say
   * without having read it.
   */
  it('refuses a body it cannot read, and one that lists no runs at all', () => {
    expect(() => readRuns('acme/app', 'main', 'gh: rate limited')).toThrow(/could not read/);
    expect(() => readRuns('acme/app', 'main', JSON.stringify({ message: 'Bad credentials' }))).toThrow(/did not list the CI runs/);
  });
});

describe('failedRuns', () => {
  // `-X GET` is what keeps this read-only: `gh api` with a `-f` field defaults to POST, so three
  // deleted arguments would turn a read into a write and nothing else here would notice.
  it('asks for the default branch first, then its failed runs, with GET both times', async () => {
    const { run, calls } = gh(repo('trunk'), runs(runRow(9001, { head_branch: 'trunk' })));

    const found = await failedRuns(run, 'acme', 'app', 20, live());

    expect(found.map((one) => one.branch)).toEqual(['trunk']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['api', '-X', 'GET', 'repos/acme/app']);
    expect(calls[1]).toContain('-X');
    expect(calls[1]).toContain('GET');
    expect(calls[1]?.join(' ')).toContain('repos/acme/app/actions/runs');
    expect(calls[1]?.join(' ')).toContain('branch=trunk');
    expect(calls[1]?.join(' ')).toContain('status=failure');
    expect(calls[1]?.join(' ')).toContain('per_page=20');
  });

  it('asks for a page the API will accept when the caller wants more', async () => {
    const { run, calls } = gh(repo('main'), runs());

    await failedRuns(run, 'acme', 'app', 500, live());

    expect(calls[1]?.join(' ')).toContain('per_page=100');
  });

  it('refuses a name that is not a repository, and asks nothing', async () => {
    const { run, calls } = gh(repo('main'), runs());

    await expect(failedRuns(run, 'acme', 'app app', 20, live())).rejects.toThrow(/owner\/repo/);
    expect(calls).toEqual([]);
  });

  // A sentence that names the fix, because the answer may be a repository that is private to somebody
  // else or a name with a typo in it, and both are the person's to correct.
  it('says what to do when GitHub names no default branch', async () => {
    const { run } = gh(JSON.stringify({ message: 'Not Found' }), runs());

    await expect(failedRuns(run, 'acme', 'app', 20, live())).rejects.toThrow(/on the Scout page/);
  });
});

// Fix CI keeps the end of a job's log, where a failed job says why.
describe('trimLog', () => {
  const lines = (count: number) => Array.from({ length: count }, (_, at) => `line ${at + 1}`).join('\n');

  it('keeps a short log whole and says nothing was cut', () => {
    expect(trimLog('one\ntwo\n')).toEqual({ text: 'one\ntwo', cut: false, total: 2 });
  });

  it('keeps the last lines up to the line cap', () => {
    const kept = trimLog(lines(500), 300, 60_000);
    expect(kept.cut).toBe(true);
    expect(kept.total).toBe(500);
    expect(kept.text.split('\n')).toHaveLength(300);
    expect(kept.text.startsWith('line 201\n')).toBe(true);
    expect(kept.text.endsWith('line 500')).toBe(true);
  });

  it('keeps fewer lines when they pass the byte cap, counted in UTF-8 bytes', () => {
    const wide = Array.from({ length: 10 }, (_, at) => `${at}${'é'.repeat(49)}`).join('\n');
    // Each line is 99 bytes and its newline one more, so 300 bytes hold three.
    expect(trimLog(wide, 300, 300).text.split('\n')).toHaveLength(3);
    expect(trimLog(wide, 300, 300).text.startsWith('7')).toBe(true);
  });

  it('keeps the end of one last line that is longer than the byte cap', () => {
    const kept = trimLog(`start\n${'a'.repeat(100)}END`, 300, 40);
    expect(kept).toEqual({ text: `${'a'.repeat(7)}END`, cut: true, total: 2 });
  });
});

/**
 * Hand written. One read of a real failed public job confirmed the shapes these rest on: the job
 * endpoint answers `head_sha`, and `gh api -X GET` on the logs endpoint follows the redirect and prints
 * the log as plain text. The rate limit body is not confirmed: it is written from the API's docs.
 */
describe('readJobLog', () => {
  const job = { owner: 'acme', repo: 'app', job: '456' };
  const answers = (job: { code: number; stdout: string; stderr?: string }, log: { code: number; stdout: string; stderr?: string }) => {
    const calls: string[][] = [];
    const run: RunGh = async (args) => {
      calls.push([...args]);
      const one = args.at(-1)?.endsWith('/logs') ? log : job;
      return { stderr: '', ...one };
    };
    return { run, calls };
  };

  it('reads the job for its head commit, then its log, both with GET', async () => {
    const { run, calls } = answers({ code: 0, stdout: JSON.stringify({ id: 456, head_sha: '9f2c1ab0d4e5', run_id: 123 }) }, { code: 0, stdout: '2026-11-27T10:00:00Z Error: expected 2\n' });
    expect(await readJobLog(run, job, AbortSignal.timeout(1000))).toEqual({ ok: true, log: '2026-11-27T10:00:00Z Error: expected 2\n', head: '9f2c1ab0d4e5' });
    expect(calls).toEqual([
      ['api', '-X', 'GET', 'repos/acme/app/actions/jobs/456'],
      ['api', '-X', 'GET', 'repos/acme/app/actions/jobs/456/logs'],
    ]);
  });

  it('answers gh\'s reason for a log GitHub does not hand over, and no head for one it did not name', async () => {
    const { run } = answers({ code: 0, stdout: '{}' }, { code: 1, stdout: '{"message":"Not Found"}', stderr: 'gh: Not Found (HTTP 404)\n' });
    expect(await readJobLog(run, job, AbortSignal.timeout(1000))).toEqual({ ok: false, why: 'GitHub did not hand over its log (gh: Not Found (HTTP 404)).' });
  });

  it('throws on a rate limit, which stops every other read too', async () => {
    const { run } = answers({ code: 1, stdout: '{"message":"API rate limit exceeded for user ID 1."}', stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }, { code: 0, stdout: '' });
    await expect(readJobLog(run, job, AbortSignal.timeout(1000))).rejects.toThrow("GitHub's rate limit for this gh login is used up, so the logs of acme/app were not read. Wait for it to reset, at most an hour, then press Fix CI again.");
  });

  it('calls nothing for a name that could leave the API path', async () => {
    const { run, calls } = answers({ code: 0, stdout: '{}' }, { code: 0, stdout: '' });
    expect(await readJobLog(run, { ...job, repo: 'app/../../x' }, AbortSignal.timeout(1000))).toEqual({ ok: false, why: 'The link names no job Nolzu can read.' });
    expect(calls).toEqual([]);
  });
});

// The log read has a cap and a sentence of its own: a log over the cap names that log, never "the
// issue", and Fix CI goes on with the other checks. A `gh` of our own on a PATH of our own, as in
// gh.test.ts; the real one is never spawned.
describe('ghLogRunner', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const fakeGh = (logChars: number): string => {
    const dir = mkdtempSync(join(tmpdir(), 'nolzu-gh-log-'));
    made.push(dir);
    const out = `process.stdout.write(process.argv.at(-1).endsWith("/logs") ? "x".repeat(${logChars}) : JSON.stringify({ head_sha: "9f2c1ab" }))`;
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\n'${process.execPath}' -e '${out}' -- "$@"\n`);
    chmodSync(join(dir, 'gh'), 0o755);
    return dir;
  };
  const job = { owner: 'example', repo: 'recipes', job: '456' };

  it('names a log over the cap as too large, and not the issue', async () => {
    // More than one pipe chunk, because the runner checks the cap as each chunk arrives.
    const dir = fakeGh(300_000);
    const run = ghLogRunner({ path: () => dir, maxStdout: 1000 });
    await expect(run(['api', '-X', 'GET', 'repos/example/recipes/actions/jobs/456/logs'], AbortSignal.timeout(10_000))).rejects.toThrow(LOG_TOO_LARGE);
    await expect(run(['api', '-X', 'GET', 'repos/example/recipes/actions/jobs/456/logs'], AbortSignal.timeout(10_000))).rejects.not.toThrow(/issue/);
    expect(await readJobLog(run, job, AbortSignal.timeout(10_000))).toEqual({ ok: false, why: 'The log is larger than Nolzu reads.' });
  });

  // Over the 4 MB every other gh read is held to, and under the log's own cap.
  it('reads a log larger than the shared cap', async () => {
    const dir = fakeGh(4_500_000);
    const read = await readJobLog(ghLogRunner({ path: () => dir }), job, AbortSignal.timeout(10_000));
    expect(read.ok && read.log.length).toBe(4_500_000);
    expect(LOG_MAX_STDOUT).toBe(32_000_000);
  });

  it('throws what stops every read, such as a missing gh', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nolzu-gh-log-'));
    made.push(dir);
    await expect(readJobLog(ghLogRunner({ path: () => dir }), job, AbortSignal.timeout(10_000))).rejects.toThrow(/gh is not on the PATH/);
  });
});
