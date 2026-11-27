import { describe, expect, it } from 'vitest';
import { mergeBlockers, type MergeFields } from './merge.ts';

// A DOCUMENTED SHAPE NOBODY HAS MEASURED. Each node is a pull request as the branch lookup asks for it,
// written from the GitHub GraphQL schema the way the fixtures in `packages/runner/src/tickets/github.test.ts`
// are. One recorded answer has to confirm `mergeable`, `mergeStateStatus` and the two fragments of
// `statusCheckRollup.contexts` before the reader is trusted.
const URL = 'https://github.com/cook/recipes/pull/12';
const node = (extra: Partial<MergeFields> = {}): MergeFields => ({
  url: URL,
  isDraft: false,
  reviewDecision: null,
  baseRefName: 'main',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: { state: 'SUCCESS', contexts: { nodes: [] } },
  ...extra,
});
const run = (name: string, conclusion: string | null, status = 'COMPLETED') => ({ __typename: 'CheckRun', name, conclusion, status, detailsUrl: `https://github.com/cook/recipes/actions/runs/${name}` });
const status = (context: string, state: string) => ({ __typename: 'StatusContext', context, state, targetUrl: `https://ci.example.com/${context}` });

describe('mergeBlockers', () => {
  it('finds nothing on a clean pull request', () => {
    expect(mergeBlockers(node())).toEqual({ blockers: [], running: false });
  });

  // Rollup FAILURE or ERROR: the failed checks by name, each with its log. A passed one is left out.
  it('names each failed check with its link, from check runs and from commit statuses', () => {
    const read = mergeBlockers(
      node({
        mergeStateStatus: 'BLOCKED',
        statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [run('build', 'FAILURE'), run('lint', 'SUCCESS'), run('e2e', 'TIMED_OUT'), status('deploy', 'ERROR'), status('docs', 'SUCCESS')] } },
      }),
    );
    expect(read.blockers).toEqual([
      {
        kind: 'checks',
        failed: [
          { name: 'build', url: 'https://github.com/cook/recipes/actions/runs/build' },
          { name: 'e2e', url: 'https://github.com/cook/recipes/actions/runs/e2e' },
          { name: 'deploy', url: 'https://ci.example.com/deploy' },
        ],
      },
    ]);
    expect(mergeBlockers(node({ statusCheckRollup: { state: 'ERROR', contexts: { nodes: [status('ci', 'ERROR')] } } })).blockers).toEqual([{ kind: 'checks', failed: [{ name: 'ci', url: 'https://ci.example.com/ci' }] }]);
  });

  // Running checks hold the merge but end by themselves. A BLOCKED they explain is no unnamed reason.
  it('reads pending checks as running, not as a reason', () => {
    expect(mergeBlockers(node({ mergeStateStatus: 'BLOCKED', statusCheckRollup: { state: 'PENDING', contexts: { nodes: [run('build', null, 'IN_PROGRESS')] } } }))).toEqual({ blockers: [], running: true });
  });

  it('reads a conflict from mergeable or from a dirty merge state, once', () => {
    expect(mergeBlockers(node({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).blockers).toEqual([{ kind: 'conflict', base: 'main' }]);
    expect(mergeBlockers(node({ mergeable: 'CONFLICTING', mergeStateStatus: 'UNKNOWN' })).blockers).toEqual([{ kind: 'conflict', base: 'main' }]);
    expect(mergeBlockers(node({ mergeStateStatus: 'DIRTY', baseRefName: null })).blockers).toEqual([{ kind: 'conflict', base: null }]);
  });

  it('reads a branch behind its base', () => {
    expect(mergeBlockers(node({ mergeStateStatus: 'BEHIND', baseRefName: 'develop' })).blockers).toEqual([{ kind: 'behind', base: 'develop' }]);
  });

  // GitHub answers null when the repository asks for no review, and nothing is guessed from it.
  it('reads the review decision, and nothing when the repository asks for no review', () => {
    expect(mergeBlockers(node({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' })).blockers).toEqual([{ kind: 'approval' }]);
    expect(mergeBlockers(node({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' })).blockers).toEqual([{ kind: 'changes' }]);
    expect(mergeBlockers(node({ reviewDecision: 'APPROVED' })).blockers).toEqual([]);
    expect(mergeBlockers(node({ reviewDecision: null })).blockers).toEqual([]);
  });

  it('reads a draft', () => {
    expect(mergeBlockers(node({ isDraft: true, mergeStateStatus: 'DRAFT' })).blockers).toEqual([{ kind: 'draft' }]);
  });

  it('says GitHub is still working it out while mergeable is unknown', () => {
    expect(mergeBlockers(node({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).blockers).toEqual([{ kind: 'unknown' }]);
  });

  // A rule GitHub does not explain through this API, such as a ruleset. Named as such with the link,
  // never guessed.
  it('reads a bare BLOCKED as a reason GitHub does not name, with the pull request link', () => {
    expect(mergeBlockers(node({ mergeStateStatus: 'BLOCKED' })).blockers).toEqual([{ kind: 'blocked', url: URL }]);
    expect(mergeBlockers(node({ mergeStateStatus: 'BLOCKED', url: null })).blockers).toEqual([{ kind: 'blocked', url: null }]);
  });

  it('lists every reason in the order the card names them', () => {
    const read = mergeBlockers({
      url: URL,
      isDraft: true,
      reviewDecision: 'REVIEW_REQUIRED',
      baseRefName: 'main',
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
      statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [run('build', 'FAILURE')] } },
    });
    expect(read.blockers.map((one) => one.kind)).toEqual(['checks', 'conflict', 'approval', 'draft']);
  });

  // A field the answer left out claims nothing: no rollup is no checks, and a null in the list is skipped.
  it('reads a missing rollup, a context with no name and a null node as nothing', () => {
    expect(mergeBlockers(node({ statusCheckRollup: null }))).toEqual({ blockers: [], running: false });
    expect(mergeBlockers(node({ statusCheckRollup: { state: 'FAILURE', contexts: { nodes: [null, { __typename: 'CheckRun', conclusion: 'FAILURE' }] } } })).blockers).toEqual([{ kind: 'checks', failed: [] }]);
  });
});
