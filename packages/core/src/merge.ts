import type { MergeBlocker, MergeRead } from '@nolzu/protocol';

// The Delivery columns where a card's pull request is watched: once a person reads the change, until
// the card is closed.
export const WATCHED_STAGES: readonly string[] = ['review', 'pr-watch', 'wrapup'];

// The fields of a pull request node the rule reads, as GitHub's GraphQL API answers them. Every one is
// optional, because a field the answer left out claims nothing.
export interface MergeFields {
  url?: string | null;
  isDraft?: boolean | null;
  reviewDecision?: string | null;
  baseRefName?: string | null;
  mergeable?: string | null;
  mergeStateStatus?: string | null;
  statusCheckRollup?: {
    state?: string | null;
    contexts?: { nodes?: readonly (CheckContext | null)[] | null } | null;
  } | null;
}

// A check run (GitHub Actions and other apps) or a commit status, the two kinds a rollup holds.
interface CheckContext {
  __typename?: string;
  name?: string | null;
  conclusion?: string | null;
  status?: string | null;
  detailsUrl?: string | null;
  context?: string | null;
  state?: string | null;
  targetUrl?: string | null;
}

// The conclusions and states GitHub counts as a failed check in the rollup.
const FAILED_RUN = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FAILED_STATUS = new Set(['FAILURE', 'ERROR']);

const failedCheck = (one: CheckContext | null): { name: string; url: string | null }[] => {
  if (one === null) return [];
  const run = one.__typename === 'CheckRun' || one.name !== undefined;
  const name = run ? one.name : one.context;
  const failed = run ? FAILED_RUN.has(one.conclusion ?? '') : FAILED_STATUS.has(one.state ?? '');
  if (!failed || typeof name !== 'string' || name === '') return [];
  return [{ name, url: (run ? one.detailsUrl : one.targetUrl) ?? null }];
};

/**
 * Why a pull request cannot merge, in the order the board card names the first: failed checks, a
 * conflict, a branch behind its base, a missing approval, asked changes, a draft, and a merge state
 * GitHub has not worked out yet. Running checks are a state and no reason. A BLOCKED that none of
 * these and no running check explains is a rule GitHub does not name through this API, such as a
 * ruleset, and it says so with the pull request link. Nothing is guessed: a field the answer left out
 * adds no reason.
 */
export function mergeBlockers(node: MergeFields): MergeRead {
  const base = node.baseRefName ?? null;
  const rollup = node.statusCheckRollup?.state ?? null;
  const running = rollup === 'PENDING';
  const blockers: MergeBlocker[] = [];
  // Limit: the names come from the first 20 contexts of the rollup, the page the query asks for.
  if (rollup === 'FAILURE' || rollup === 'ERROR') blockers.push({ kind: 'checks', failed: (node.statusCheckRollup?.contexts?.nodes ?? []).flatMap(failedCheck) });
  if (node.mergeable === 'CONFLICTING' || node.mergeStateStatus === 'DIRTY') blockers.push({ kind: 'conflict', base });
  if (node.mergeStateStatus === 'BEHIND') blockers.push({ kind: 'behind', base });
  if (node.reviewDecision === 'REVIEW_REQUIRED') blockers.push({ kind: 'approval' });
  if (node.reviewDecision === 'CHANGES_REQUESTED') blockers.push({ kind: 'changes' });
  if (node.isDraft === true) blockers.push({ kind: 'draft' });
  if (node.mergeable === 'UNKNOWN') blockers.push({ kind: 'unknown' });
  if (node.mergeStateStatus === 'BLOCKED' && blockers.length === 0 && !running) blockers.push({ kind: 'blocked', url: node.url ?? null });
  return { blockers, running };
}
