import { error, redirect } from '@sveltejs/kit';
import { boardFor } from '@nolzu/core';
import { cardDiscussions, cardPullRows, fixedSinceQa, getSetting } from '@nolzu/core/node';
import { parseRunLine } from '@nolzu/runner';
import { qaView } from '@nolzu/ui/qa';
import { crossSiteRead } from '$lib/bin.ts';
import { settingsFor } from '$lib/card-models.ts';
import { cardChain } from '$lib/chain-store.ts';
import { isClosed } from '$lib/checkouts.ts';
import { cardReposFor } from '$lib/card-repos.ts';
import { changeGroups } from '$lib/changes.ts';
import { markStep } from '$lib/coach.ts';
import { database } from '$lib/db.ts';
import { commentsOf, implementSession } from '$lib/diff-comments.ts';
import { discussionFor, withTools } from '$lib/discussion.ts';
import { triageOfferFor } from '$lib/feedback.ts';
import { cardFolder, filesFor } from '$lib/files.ts';
import { loop } from '$lib/loop.ts';
import { cardFacts, cardKnowledge, overviewFor } from '$lib/overview.ts';
import { reviewFor } from '$lib/review.ts';
import { qaInputFor, stackLane, stackStatusFor } from '$lib/qa-panel.ts';
import { logFor } from '$lib/run-log.ts';
import { TAB_REDIRECT, ticketTab } from '$lib/ticket.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, parent, request, url }) => {
  // The tabs come from the layout, which read the card's board. Asking for them again here would
  // read the database twice and could offer a Delivery tab on a card from another board.
  const { tabs, ticket } = await parent();
  const wanted = ticketTab(params.tab, tabs, params.key, ticket.board);
  // A tab of another board is a page that is not there, and an empty one would read as a page that
  // broke.
  if (wanted.gone !== null) error(wanted.gone.status, wanted.gone.message);
  // A tab that is not built yet is not an error: the reader lands on the overview instead.
  if (wanted.redirect !== null) redirect(TAB_REDIRECT, wanted.redirect);
  // Git is asked only on the tab that shows its answer. One group per card repository. Every part that
  // runs git or a project command is returned as a promise and not awaited, so SvelteKit streams it and
  // the page draws at once with what the database holds.
  // ?view picks Not committed or Whole card, and only the first reads the branch's commit list.
  const groups = wanted.current === 'changes' ? changeGroups(database(), params.key, process.env, request.signal, url.searchParams.get('view')) : null;
  const overview = wanted.current === 'overview' ? overviewFor(database(), params.key) : null;
  const thread = wanted.current === 'discussion' ? discussionFor(database(), params.key, url.searchParams.get('thread'), loop().models()) : null;
  // A closed card offers to remove its checkouts, on the overview of every board, and shows the
  // knowledge change its wrap-up made.
  const closed = wanted.current === 'overview' && isClosed(ticket.board, ticket.stage, getSetting(database(), 'deliveryFlow'));
  // The overview opens on the plain summary, so a summary shown here is Getting started's "Read what
  // changed". The rail reads it off the Now stream, which is told once.
  if ((overview?.summary ?? null) !== null && !crossSiteRead(request.headers.get('sec-fetch-site')) && markStep(database(), 'summary')) loop().changed();
  // The panels from the database and the card folder now, and the status command's answer streamed.
  // The stack buttons and their busy lane stay off the snapshot read here, never off the streamed part.
  const qaInput = wanted.current === 'overview' && ticket.board === 'delivery' ? qaInputFor(database(), params.key, { busy: stackLane(loop().snapshot()) }) : null;
  const qa = qaInput === null ? null : qaView(qaInput);
  // The card sits in a QA stage of its own board: the App line belongs there, and a FAIL there
  // opens the overview.
  const inQa = boardFor(ticket.board, getSetting(database(), 'deliveryFlow')).stages.find((stage) => stage.id === ticket.stage)?.phase === 'qa';
  return {
    current: wanted.current,
    // The card's board, where Answer later goes.
    board: ticket.board,
    // Read off the same tab list, so the overview never links to a Changes tab this board has not got.
    hasChanges: tabs.some((tab) => tab.id === 'changes'),
    overview,
    // The facts under the trail, which the layout draws beside the overview. One git call for the branch.
    // The models name the next step's engine on a card that never ran.
    facts: wanted.current === 'overview' ? cardFacts(database(), params.key, process.env, loop().models()) : null,
    closed,
    // The pull request state, which the page asks for once it has drawn. Only a Delivery card waits on
    // a pull request: asked for a closed epic, gh would look for a branch nobody pushed.
    pulls: closed && ticket.board === 'delivery',
    // The rows of the wrap-up's knowledge change from the database, and the patch each commit made
    // streamed, one git call per file.
    knowledge: closed ? await cardKnowledge(database(), params.key, process.env, false) : null,
    knowledgePatches: closed ? cardKnowledge(database(), params.key) : null,
    // The QA panels, on the overview of a Delivery card, as the input `qaView` draws, so the page adds
    // the status command's answer when it lands. The command runs here, because a panel that says what
    // the project reports has to ask the project.
    qa: qaInput,
    // Never for another site's request: an image pointed here would run the person's own command.
    qaStatus: qaInput === null || crossSiteRead(request.headers.get('sec-fetch-site')) ? null : stackStatusFor(database(), params.key, { signal: request.signal }),
    // The card waits in QA on a FAIL, so the overview opens with it. Read off the
    // card's stage too: a card moved back keeps its newest QA run, and a FAIL there is history.
    qaFailed: qa?.verdict.verdict === 'FAIL' && ticket.state === 'ready' && inQa,
    qaStage: qa !== null && inQa,
    files: wanted.current === 'files' ? filesFor(database(), params.key) : null,
    // The empty state of that tab names this, so a person knows where to copy a log for an
    // investigate run. It is a path on the person's own machine and the page is their own.
    filesFolder: wanted.current === 'files' ? cardFolder(database(), params.key) : null,
    groups,
    // The diff comments of every repository, which each group places on its own diff.
    comments: wanted.current === 'changes' ? commentsOf(database(), params.key) : null,
    // Read here and not off the facts git streams, so the button never waits on them.
    implementSession: wanted.current === 'changes' || wanted.current === 'overview' ? implementSession(database(), params.key) : null,
    // The models the thread's own profile offers, which the thread picks out of the list per vendor.
    discussion: thread,
    // The tool calls of each agent message, read from its run's log with that run's engine. Streamed,
    // because a long run's log takes a while to read.
    discussionTools: thread === null ? null : withTools(database(), thread, parseRunLine).then((tab) => tab.messages),
    log: wanted.current === 'log' ? logFor(database(), params.key, url.searchParams.get('run')) : null,
    // The round of findings, on the one board that has this tab. No second guard on the board: the
    // tab is only in that board's list, so `current` cannot be `review` anywhere else.
    review: wanted.current === 'review' ? reviewFor(database(), params.key, url.searchParams.get('round')) : null,
    // What each vendor offers now, so a stored model its engine dropped reads as gone.
    settings: wanted.current === 'settings' ? settingsFor(database(), params.key, loop().models()) : null,
    // Null on a project of one repository, which has no list to pick from.
    repos: wanted.current === 'settings' ? cardReposFor(database(), params.key) : null,
    // The tick "Go on to Implement after Plan", only where the chain is on for the card's board.
    chain: wanted.current === 'settings' ? cardChain(database(), params.key) : null,
    // The card's pull requests as the last read left them. Nothing here asks GitHub.
    prs: wanted.current === 'prs' ? cardPullRows(database(), params.key) : null,
    // Every discussion with its messages. The text stays on this page: the snapshot never carries it.
    prDiscussions: wanted.current === 'prs' ? cardDiscussions(database(), params.key) : null,
    // What Run triage runs on and costs, and why the triage file in the card folder was refused.
    prTriage: wanted.current === 'prs' ? triageOfferFor(database(), params.key, loop().models()) : null,
    // The comments fixed since the last QA with a verdict, which QA the fixes would check.
    prQaFixes: wanted.current === 'prs' ? fixedSinceQa(database(), params.key).map((row) => row.ref) : null,
  };
};
