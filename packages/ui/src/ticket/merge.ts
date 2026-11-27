import { actionsJob, cardStarts, type CardView, type MergeBlocker, type MergeRead, type StageView } from '@nolzu/protocol';
import { refuseDrop } from '../board/drop.ts';

// One open pull request of a card with why it cannot merge, as the last read stored it, and when.
export interface MergePull {
  repo: string;
  number: number;
  url: string | null;
  read: MergeRead;
  at: string;
}

// The reason as the board chip names it.
export const BLOCKER_LABEL: Record<MergeBlocker['kind'], string> = {
  checks: 'Checks failed',
  conflict: 'Conflict',
  behind: 'Behind',
  approval: 'Approval',
  changes: 'Changes asked',
  draft: 'Draft',
  unknown: 'Unknown',
  blocked: 'Blocked',
};

export const RUNNING_WORDS = 'Checks are still running';

/**
 * The reason as the card page says it: the words, then the links that belong to them. The failed checks
 * are named one link each, and a merge GitHub blocks without a reason links the pull request.
 */
export function blockerLine(blocker: MergeBlocker): { text: string; links: readonly { name: string; url: string | null }[] } {
  const base = (blocker.kind === 'conflict' || blocker.kind === 'behind' ? blocker.base : null) ?? 'the base branch';
  switch (blocker.kind) {
    case 'checks': {
      const count = blocker.failed.length;
      return count === 0 ? { text: 'Checks failed', links: [] } : { text: `${count === 1 ? '1 check' : `${count} checks`} failed:`, links: blocker.failed };
    }
    case 'conflict':
      return { text: `It conflicts with ${base}. Resolve the conflicts on GitHub or in your checkout.`, links: [] };
    case 'behind':
      return { text: `${base} moved on, and this repository wants the branch up to date first`, links: [] };
    case 'approval':
      return { text: 'It needs an approval', links: [] };
    case 'changes':
      return { text: 'A reviewer asked for changes', links: [] };
    case 'draft':
      return { text: 'It is a draft', links: [] };
    case 'unknown':
      return { text: 'GitHub is still working out whether it can merge', links: [] };
    case 'blocked':
      return { text: 'GitHub blocks the merge for a reason it does not name here', links: blocker.url === null ? [] : [{ name: 'Open the pull request', url: blocker.url }] };
  }
}

// The same line as plain text, for a title and a screen reader.
export const blockerText = (blocker: MergeBlocker): string => {
  const line = blockerLine(blocker);
  return blocker.kind === 'checks' && line.links.length > 0 ? `${line.text} ${line.links.map((one) => one.name).join(', ')}` : line.text;
};

/**
 * The board chip: the first reason and how many more ("Checks failed +1"), with every reason in full
 * for its title and a screen reader. Null when nothing blocks, so the card draws no chip.
 */
export function blockerChip(blockers: readonly MergeBlocker[]): { short: string; full: string } | null {
  const [first] = blockers;
  if (first === undefined) return null;
  const more = blockers.length - 1;
  return { short: `${BLOCKER_LABEL[first.kind]}${more > 0 ? ` +${more}` : ''}`, full: `Cannot merge. ${blockers.map((one) => `${blockerText(one)}.`.replace(/\.\.$/, '.')).join(' ')}` };
}

// The pull requests the card page names: the ones with a reason or with checks still running.
export const mergeShown = (pulls: readonly MergePull[]): MergePull[] => pulls.filter((pull) => pull.read.blockers.length > 0 || pull.read.running);

// Fix CI beside the failed checks: what the button says and the line under it.
export const FIX_CI_LABEL = 'Fix CI';
export const FIX_CI_NOTE = "The failed logs go to the engine's vendor with the code, as the code and comments do.";

// What Fix CI starts: the Implement stage with the card's own models, and why a press is refused now.
export interface FixCi {
  implement: StageView;
  refusal: string | null;
}

// The server's sentences for a card a run or a question holds.
const BUSY: Record<string, string> = {
  queued: 'Wait for the run to start and end, then press Fix CI.',
  running: 'Wait for the run to end, then press Fix CI.',
  blocked: 'Answer the question on the overview first.',
  failed: 'Retry the card first, or move it back.',
};

/**
 * Fix CI on a card whose pull requests have failed checks, by the server's rule: a card in Implement or
 * after it, short of the last column. Null draws no button. A busy card, no failed check with a GitHub
 * Actions log of its own pull request, and an engine that cannot start are refused, as the server refuses them.
 */
export function fixCiOf(card: CardView, stages: readonly StageView[], pulls: readonly MergePull[]): FixCi | null {
  const checks = pulls.flatMap((pull) => pull.read.blockers.flatMap((one) => (one.kind === 'checks' ? one.failed.map((check) => ({ url: check.url, repo: pull.repo })) : [])));
  if (checks.length === 0) return null;
  const from = stages.findIndex((stage) => stage.starts?.phase === 'implement');
  const at = stages.findIndex((stage) => stage.id === card.stage);
  const stage = stages[from];
  if (stage === undefined || at < from || at === stages.length - 1) return null;
  const implement = { ...stage, starts: cardStarts(stage, card) };
  const busy = BUSY[card.state];
  if (busy !== undefined) return { implement, refusal: `${card.key} is ${card.state}. ${busy}` };
  if (!checks.some((check) => actionsJob(check.url, check.repo) !== null)) return { implement, refusal: 'None of the failed checks has a log Nolzu can read. Open them on GitHub.' };
  const engine = refuseDrop(implement, 'forward');
  return { implement, refusal: engine === null ? null : `${engine.message}${engine.fix === null ? '' : ` ${engine.fix}`}` };
}
