import { error } from '@sveltejs/kit';
import { getSetting } from '@nolzu/core/node';
import { settingsFor } from '$lib/card-models.ts';
import { changesCount } from '$lib/changes.ts';
import { isClosed } from '$lib/checkouts.ts';
import { database } from '$lib/db.ts';
import { openCommentCount } from '$lib/diff-comments.ts';
import { loop } from '$lib/loop.ts';
import { tabCounts } from '$lib/overview.ts';
import { runOnOffer } from '$lib/run-on.ts';
import { ticketLayout } from '$lib/ticket.ts';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ params }) => {
  const found = ticketLayout(database(), params.key);
  if (!found.ok) error(found.status, found.message);
  const models = loop().models();
  const changes = found.tabs.some((tab) => tab.id === 'changes');
  const closed = isClosed(found.ticket.board, found.ticket.stage, getSetting(database(), 'deliveryFlow'));
  // What "Run on" can offer, which the card shows only while it is failed, the card's own model rows
  // for the decision panel's picker, and what each tab holds. The page reads them again whenever the
  // board says the card's state moved, and after a pick.
  return {
    ticket: found.ticket,
    tabs: found.tabs,
    runOn: runOnOffer(database(), params.key, models),
    models: settingsFor(database(), params.key, models),
    counts: tabCounts(database(), params.key),
    // The Changes count asks git, so only a board with that tab asks. It counts what is not committed, the
    // view the tab opens on. A closed card's tag comes from its
    // pull request instead ("merged"), which the page reads after it has drawn. Not awaited: SvelteKit
    // streams it, so the card page draws before git answers, and every tab waits on this layout.
    changes: changes && !closed ? changesCount(database(), params.key) : null,
    closed,
    // The diff comments not sent back yet, which Send back with comments counts in its label.
    openComments: changes ? openCommentCount(database(), params.key) : 0,
    // The time the page is drawn with. The trail's "5 minutes ago" starts from it, on the server and in
    // the first paint, so the two say the same before the clock takes over.
    now: new Date().toISOString(),
  };
};
