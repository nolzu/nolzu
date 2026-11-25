import { expect, it } from 'vitest';
import { tabAnywhere, tabsFor } from './tabs.ts';

it('gives the delivery board its seven tabs, in order', () => {
  expect(tabsFor('delivery').map((tab) => tab.id)).toEqual([
    'overview',
    'files',
    'changes',
    'discussion',
    'prs',
    'log',
    'settings',
  ]);
});

// Before the Pull request column a card has no pull request, and an empty tab reads as a broken page.
it.each([
  ['inbox', false],
  ['review', false],
  ['pr-watch', true],
  ['wrapup', true],
  ['closed', true],
])('shows the PRs tab of a Delivery card on %s: %s', (stage, shown) => {
  expect(tabsFor('delivery', stage).some((tab) => tab.id === 'prs')).toBe(shown);
  expect(tabsFor('prreview', stage).some((tab) => tab.id === 'prs')).toBe(false);
});

// A card moved back from Pull request keeps the pull requests it had, and they stay in reach.
it('shows the PRs tab of an earlier Delivery card that holds a pull request', () => {
  expect(tabsFor('delivery', 'implement', true).some((tab) => tab.id === 'prs')).toBe(true);
  expect(tabsFor('delivery', 'implement', false).some((tab) => tab.id === 'prs')).toBe(false);
});

it('pins the labels, so a rename shows up here', () => {
  expect(tabsFor('delivery')).toEqual([
    { id: 'overview', label: 'Overview' },
    { id: 'files', label: 'Files' },
    { id: 'changes', label: 'Changes' },
    { id: 'discussion', label: 'Discussion' },
    { id: 'prs', label: 'PRs' },
    { id: 'log', label: 'Log' },
    { id: 'settings', label: 'Settings' },
  ]);
});

// Every board and every one of its tabs, so a tab added or dropped anywhere shows up in this list.
// The four boards beside Delivery run no code, so they have no diff and no Changes tab. A card can be
// made on all five, so a board left out of the list here would 404 on five of its six tabs.
it.each([
  ['delivery', ['overview', 'files', 'changes', 'discussion', 'prs', 'log', 'settings']],
  ['epics', ['overview', 'files', 'discussion', 'log', 'settings']],
  ['investigations', ['overview', 'files', 'discussion', 'log', 'settings']],
  ['questions', ['overview', 'files', 'discussion', 'log', 'settings']],
  ['prreview', ['overview', 'review', 'files', 'discussion', 'log', 'settings']],
  ['nonsense', ['overview']],
])('gives the %s board its tabs', (kind, ids) => {
  expect(tabsFor(kind).map((tab) => tab.id)).toEqual(ids);
});

it('keeps the labels and the order of the Delivery list on a board with no Changes tab', () => {
  expect(tabsFor('epics')).toEqual([
    { id: 'overview', label: 'Overview' },
    { id: 'files', label: 'Files' },
    { id: 'discussion', label: 'Discussion' },
    { id: 'log', label: 'Log' },
    { id: 'settings', label: 'Settings' },
  ]);
});

// A tab some board builds, against one nobody has built. The first on a card whose board has not got
// it is a page that is not there; the second still sends the reader to the overview.
it('tells a tab this app builds from one it does not', () => {
  expect(tabAnywhere('changes')).toEqual({ id: 'changes', label: 'Changes' });
  expect(tabAnywhere('settings')).toEqual({ id: 'settings', label: 'Settings' });
  expect(tabAnywhere('prs')).toEqual({ id: 'prs', label: 'PRs' });
  expect(tabAnywhere('nope')).toBeUndefined();
  expect(tabAnywhere(undefined)).toBeUndefined();
});

// The Review tab belongs to one board and Delivery has not got it, so a search of the Delivery list
// alone would read `/t/APP-1/review` as a screen nobody built and send the reader to the overview
// instead of saying the tab is not on that card.
it('finds a tab that only one board builds', () => {
  expect(tabAnywhere('review')).toEqual({ id: 'review', label: 'Review' });
  expect(tabsFor('delivery').map((tab) => tab.id)).not.toContain('review');
  for (const kind of ['epics', 'investigations', 'questions']) {
    expect(tabsFor(kind).map((tab) => tab.id), kind).not.toContain('review');
  }
});

it('gives the PR reviews board the Review tab second, and keeps the rest of its list', () => {
  expect(tabsFor('prreview')).toEqual([
    { id: 'overview', label: 'Overview' },
    { id: 'review', label: 'Review' },
    { id: 'files', label: 'Files' },
    { id: 'discussion', label: 'Discussion' },
    { id: 'log', label: 'Log' },
    { id: 'settings', label: 'Settings' },
  ]);
});
