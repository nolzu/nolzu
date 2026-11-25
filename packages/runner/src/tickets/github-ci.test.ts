import { describe, expect, it } from 'vitest';
import { defaultBranch, failedRuns, readRuns } from './github-ci.ts';
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
