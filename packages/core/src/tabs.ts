export interface Tab {
  id: string;
  label: string;
}

// What is built, not what is planned. A tab that opens an empty page reads as a broken page.
//
// Discussion sits after changes and the pull requests after it, so the number
// keys match what a reader sees left to right.
const DELIVERY: readonly Tab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'changes', label: 'Changes' },
  { id: 'discussion', label: 'Discussion' },
  { id: 'prs', label: 'PRs' },
  { id: 'log', label: 'Log' },
  { id: 'settings', label: 'Settings' },
];

// A Delivery card has a pull request from the Pull request column on, so the PRs tab shows from there.
const PR_STAGES: ReadonlySet<string> = new Set(['pr-watch', 'wrapup', 'closed']);

const OVERVIEW_ONLY: readonly Tab[] = [{ id: 'overview', label: 'Overview' }];

// The four boards that run no code of their own, so they have no worktree and no diff to show, and
// no QA column either. Built from the Delivery list, so a rename or a reorder there carries over.
const NO_CHANGES: readonly Tab[] = DELIVERY.filter((tab) => tab.id !== 'changes' && tab.id !== 'prs');

// The one tab Delivery has not got: the round of findings a review wrote. It sits second, because it
// is what the PR reviews board is for. Built from the list above by position and not by an id, so a
// rename there carries over and cannot quietly drop this tab.
const PR_REVIEW: readonly Tab[] = [...NO_CHANGES.slice(0, 1), { id: 'review', label: 'Review' }, ...NO_CHANGES.slice(1)];

// Every board this version knows, each with its own entry, so the file states each board's rule
// rather than leaving one of them to the fallback below.
const BOARD_TABS: Record<string, readonly Tab[]> = {
  delivery: DELIVERY,
  epics: NO_CHANGES,
  investigations: NO_CHANGES,
  questions: NO_CHANGES,
  prreview: PR_REVIEW,
};

// The one place a board's tabs are decided. The tab bar and the tab route both read it, because two
// lists of the same thing drift, and the drift is an empty screen or a 404 on a tab that is there.
// The fallback is for a board this version does not know: it gets the overview, which every board has.
// With a stage, a tab the card has not reached yet is left out: the PRs tab before Pull request, unless
// the card holds a pull request already (`pulled`), as one moved back from there does.
export function tabsFor(kind: string, stage?: string, pulled = false): readonly Tab[] {
  const tabs = BOARD_TABS[kind] ?? OVERVIEW_ONLY;
  return stage === undefined || kind !== 'delivery' || pulled || PR_STAGES.has(stage) ? tabs : tabs.filter((tab) => tab.id !== 'prs');
}

// The tab by that id on any board, or nothing.
//
// A tab some board builds, on a card whose board has not got it, is a screen that exists and is not
// this card's, so that address is not there.
// An id no board lists is a screen nobody has built yet, so it leads to the overview.
//
// Every board's list, because no one of them is the whole set any more: the Review tab is the PR
// reviews board's and Delivery has not got it.
export function tabAnywhere(id: string | undefined): Tab | undefined {
  return Object.values(BOARD_TABS)
    .flat()
    .find((tab) => tab.id === id);
}
