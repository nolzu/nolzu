import type { BoardSnapshot, CardView, DeliveryFlow } from '@nolzu/protocol';
import { deliveryBoard, tabsFor } from '@nolzu/core';
import { expect, it, vi } from 'vitest';
import { TAB_REDIRECT, clusterNote, forwardMove, gateMove, loadTicket, postWrite, resolveTab, retryStage, stageLabel, ticketLayout, ticketTab } from './ticket.ts';

const ROW = { key: 'APP-1', title: 'Add a search box to the recipe list', stage: 'refine', state: 'running', board: 'delivery' };

// The seam the route uses. A test needs no sqlite file and no data directory to prove the rules.
// `pulled` answers the question whether the card holds a pull request.
const stub = (row: unknown, pulled = false) => ({ prepare: (sql: string) => ({ get: () => (sql.includes('card_pulls') ? (pulled ? { one: 1 } : undefined) : row) }) });

it('answers with the card the reader asked for', () => {
  const found = loadTicket(stub(ROW), 'APP-1');

  expect(found).toEqual({ ok: true, ticket: ROW });
});

it('answers 404 and names the key that is not there', () => {
  const missing = loadTicket(stub(undefined), 'APP-9');

  expect(missing.ok).toBe(false);
  expect(missing.ok === false && missing.status).toBe(404);
  expect(missing.ok === false && missing.message).toContain('APP-9');
});

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
];

it('keeps a tab that is built', () => {
  expect(resolveTab('files', TABS)).toBe('files');
});

it('sends a tab that does not exist to the overview', () => {
  expect(resolveTab('nope', TABS)).toBe('overview');
  // Builds is a tab that is not built, so its URL must not 404 in the meantime.
  expect(resolveTab('builds', TABS)).toBe('overview');
  expect(resolveTab(undefined, TABS)).toBe('overview');
});

it('gives a card the tabs of the board it is on', () => {
  // Every card used to get the Delivery tabs, so an Epics card opened at a Delivery URL and was
  // offered a Changes tab that board does not have.
  const epic = ticketLayout(stub({ ...ROW, key: 'EPIC-1', board: 'epics' }), 'EPIC-1');

  expect(epic.ok).toBe(true);
  expect(epic.ok === true && epic.tabs.map((tab) => tab.id)).toEqual(['overview', 'files', 'discussion', 'log', 'settings']);

  const card = ticketLayout(stub(ROW), 'APP-1');
  expect(card.ok === true && card.tabs.map((tab) => tab.id)).toEqual(['overview', 'files', 'changes', 'discussion', 'log', 'settings']);
});

// The PRs tab comes with the pull request, and before that its address is one the card grows into.
it('shows the PRs tab from Pull request on, and sends it to the overview before', () => {
  const early = ticketLayout(stub({ ...ROW, stage: 'review' }), 'APP-1');
  const late = ticketLayout(stub({ ...ROW, stage: 'pr-watch' }), 'APP-1');

  expect(early.ok === true && early.tabs.map((tab) => tab.id)).not.toContain('prs');
  expect(late.ok === true && late.tabs.map((tab) => tab.id)).toEqual(['overview', 'files', 'changes', 'discussion', 'prs', 'log', 'settings']);
  expect(ticketTab('prs', tabsFor('delivery', 'review'), 'APP-1', 'delivery')).toEqual({ current: 'overview', redirect: '/t/APP-1/overview', gone: null });
  expect(ticketTab('prs', tabsFor('epics'), 'EPIC-1', 'epics').gone?.status).toBe(404);
  // A card moved back from Pull request keeps its pull requests in reach.
  const back = ticketLayout(stub({ ...ROW, stage: 'implement' }, true), 'APP-1');
  expect(back.ok === true && back.tabs.map((tab) => tab.id)).toContain('prs');
});

it('answers 404 through the layout as well, naming the key', () => {
  const missing = ticketLayout(stub(undefined), 'APP-9');

  expect(missing.ok).toBe(false);
  expect(missing.ok === false && missing.status).toBe(404);
  expect(missing.ok === false && missing.message).toContain('APP-9');
});

it('sends a tab that is not built to the overview, and keeps one that is', () => {
  expect(ticketTab('files', TABS, 'APP-1')).toEqual({ current: 'files', redirect: null, gone: null });
  expect(ticketTab('builds', TABS, 'APP-1')).toEqual({ current: 'overview', redirect: '/t/APP-1/overview', gone: null });
  expect(ticketTab(undefined, TABS, 'APP-1')).toEqual({ current: 'overview', redirect: '/t/APP-1/overview', gone: null });
});

// A tab this app builds, on a card whose board has not got it. An empty Changes tab on an Epics card
// reads as a page that broke, and a redirect to the overview hides that the address was wrong.
it('answers 404 for a tab of another board, and names the tab and the card', () => {
  const epic = ticketTab('changes', tabsFor('epics'), 'EPIC-1');

  expect(epic.gone?.status).toBe(404);
  expect(epic.gone?.message).toContain('Changes');
  expect(epic.gone?.message).toContain('EPIC-1');
  expect(epic.redirect).toBeNull();
  // The same address on a Delivery card is the tab it asked for.
  expect(ticketTab('changes', tabsFor('delivery'), 'APP-1')).toEqual({ current: 'changes', redirect: null, gone: null });
});

it('builds the whole redirect target and encodes the key', () => {
  // The target used to be built in the route file, where no test could reach it, so the encoding
  // and the status were the two things the page needs and nothing checked.
  expect(ticketTab('nope', TABS, 'a/b')?.redirect).toBe('/t/a%2Fb/overview');
  expect(ticketTab('nope', TABS, 'ARV-1')?.redirect).toBe('/t/ARV-1/overview');
  // A pull request card is keyed repo#number. Unencoded, the hash cuts the address short and the
  // whole key is gone, so every read and every write on the page would land somewhere else.
  expect(ticketTab('nope', TABS, 'recipes#42')?.redirect).toBe('/t/recipes%2342/overview');
});

it('redirects with a status that keeps the method', () => {
  expect(TAB_REDIRECT).toBe(307);
});

it('names a stage in the words the board uses', () => {
  // The page showed the database id, so the ticket page and the board disagreed on one card.
  expect(stageLabel('delivery', 'wrapup')).toBe('Wrap-up');
  expect(stageLabel('delivery', 'pr-watch')).toBe('Pull request');
  // Merge was a column of a flow that is gone, so a card left on it reads as its id.
  expect(stageLabel('delivery', 'merge')).toBe('merge');
  expect(stageLabel('delivery', 'inbox')).toBe('Inbox');
  // A stage nobody knows is shown as it is, rather than as nothing.
  expect(stageLabel('delivery', 'nonsense')).toBe('nonsense');
});

/**
 * The label comes from the card's own board.
 *
 * Stage ids repeat: `plan` and `review` are on Epics as well as on Delivery, and `wrapup` is on
 * four of the five. One map over every board would answer with whichever was written last, so the
 * board is part of the key.
 */
it("names a stage of another board in that board's own words", () => {
  expect(stageLabel('epics', 'architecture')).toBe('Architecture');
  expect(stageLabel('epics', 'in-delivery')).toBe('In delivery');
  expect(stageLabel('prreview', 'pre-review')).toBe('Agent pre-review');
  expect(stageLabel('investigations', 'review')).toBe('Review');
});

// The other side. A stage of one board is not a stage of another, and the id is shown rather than
// a label borrowed from the board the card is not on.
it('does not borrow a label from another board', () => {
  expect(stageLabel('epics', 'implement')).toBe('implement');
  expect(stageLabel('delivery', 'architecture')).toBe('architecture');
  // The ids that repeat still answer, once per board, with that board's own word.
  expect(stageLabel('epics', 'review')).toBe('Review');
  expect(stageLabel('delivery', 'review')).toBe('Review');
});

const view = (key: string, stage: string, state: CardView['state'] = 'idle'): CardView => ({
  key,
  title: `${key} title`,
  stage,
  state,
  queuePosition: null,
  runId: null,
  runState: null,
  runStartedAt: null,
  lane: null,
  engine: null,
  model: null,
  effort: null,
  costUsd: null,
  totalUsd: null,
  question: null,
  failureReason: null,
  minimized: false,
  verdict: null,
  verdictReason: null,
  pull: null,
  starts: null,
  delivered: null,
});

// The snapshot as the server builds it: the real board's stages, with a model where a phase starts.
const snapshot = (flow: DeliveryFlow, cards: readonly CardView[]): BoardSnapshot => ({
  version: 1,
  kind: 'delivery',
  flow,
  stages: deliveryBoard(flow).stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    role: stage.role,
    count: 0,
    cadence: null,
    // A model per stage, so a label read off the wrong stage shows.
    starts: stage.phase === undefined ? null : { phase: stage.phase, model: `${stage.id}-model`, effort: 'medium', engine: 'claude-code', modelState: 'ok', refusal: null },
  })),
  cards,
  slots: { busy: 0, total: 3 },
  lanes: [],
});

it('finds the card, the stage one step forward and what the move starts', () => {
  const found = forwardMove(snapshot('pull-request', [view('APP-1', 'inbox'), view('APP-2', 'plan')]), 'APP-2');

  expect(found?.card.key).toBe('APP-2');
  expect(found?.next?.id).toBe('implement');
  expect(found?.starts).toBe('Starts: /implement · implement-model · medium');
});

it('goes from review to pr watch, which starts nothing', () => {
  const found = forwardMove(snapshot('pull-request', [view('APP-1', 'review')]), 'APP-1');

  expect(found?.next?.id).toBe('pr-watch');
  expect(found?.starts).toBeUndefined();
});

it('offers no stage after the last one', () => {
  const found = forwardMove(snapshot('pull-request', [view('APP-1', 'closed')]), 'APP-1');

  expect(found?.card.key).toBe('APP-1');
  expect(found?.next).toBeNull();
});

it('is nothing for a card the snapshot does not carry', () => {
  expect(forwardMove(snapshot('pull-request', [view('APP-1', 'inbox')]), 'APP-9')).toBeNull();
});

// The move the gate offers once its questions are settled: the next column, when it starts a run and the
// card is at rest, so it goes the moment the card moves or a run starts.
it('offers the gate the next column only while the card rests and the column starts a run', () => {
  expect(gateMove(snapshot('pull-request', [view('APP-1', 'refine', 'ready')]), 'APP-1')?.label).toBe('Plan');
  expect(gateMove(snapshot('pull-request', [view('APP-1', 'refine', 'running')]), 'APP-1')).toBeNull();
  expect(gateMove(snapshot('pull-request', [view('APP-1', 'refine', 'failed')]), 'APP-1')).toBeNull();
  expect(gateMove(snapshot('pull-request', [view('APP-1', 'review', 'idle')]), 'APP-1')).toBeNull();
  expect(gateMove(undefined, 'APP-1')).toBeNull();
});

// Retry runs the phase of the stage the card failed in again, with the card's own models, which is what
// its confirm has to show.
it('gives the stage a failed card retries, with the stage model', () => {
  const card = { ...view('APP-3', 'implement'), state: 'failed' as const };

  expect(retryStage(snapshot('pull-request', [card]), 'APP-3')).toMatchObject({ id: 'implement', starts: { phase: 'implement', model: 'implement-model' } });
});

it("names the card's own model in the stage a retry runs", () => {
  const own = { phase: 'implement' as const, model: 'opus', effort: 'high' as const, engine: 'claude-code', modelState: 'ok' as const, refusal: null };
  const card = { ...view('APP-3', 'implement'), state: 'failed' as const, starts: { implement: own } };

  expect(retryStage(snapshot('pull-request', [card]), 'APP-3')?.starts).toEqual(own);
});

it('gives the stage to retry for an idle card whose run in that stage was stopped', () => {
  const idle = (stage: string, runState: 'stopped' | 'complete', runPhase: string) => snapshot('pull-request', [{ ...view('APP-3', stage), state: 'idle' as const, runState, runPhase }]);

  expect(retryStage(idle('implement', 'stopped', 'implement'), 'APP-3')?.id).toBe('implement');
  // A finished run leaves nothing to start again.
  expect(retryStage(idle('implement', 'complete', 'implement'), 'APP-3')).toBeNull();
  // Moved back after the stop: the run is still the newest, but starting Plan is a run nobody asked for.
  expect(retryStage(idle('plan', 'stopped', 'implement'), 'APP-3')).toBeNull();
  // Moved on to a column that starts no run, also on a view built with no run phase.
  expect(retryStage(idle('review', 'stopped', 'qa'), 'APP-3')).toBeNull();
  expect(retryStage(snapshot('pull-request', [{ ...view('APP-3', 'review'), state: 'idle', runState: 'stopped' }]), 'APP-3')).toBeNull();
  expect(retryStage(snapshot('pull-request', [{ ...view('APP-3', 'implement'), state: 'ready', runState: 'stopped', runPhase: 'implement' }]), 'APP-3')).toBeNull();
});

it('gives no stage to retry for a card that has not failed, or is not on the board', () => {
  expect(retryStage(snapshot('pull-request', [view('APP-3', 'implement')]), 'APP-3')).toBeNull();
  expect(retryStage(snapshot('pull-request', [view('APP-3', 'implement')]), 'APP-9')).toBeNull();
});

const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));

it('sends the write as JSON and answers nothing when the server took it', async () => {
  const send = answer(200, '{"ok":true}');

  expect(await postWrite(send, '/api/board/move', { key: 'APP-1', to: 'refine' })).toBeNull();
  expect(send).toHaveBeenCalledWith('/api/board/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"key":"APP-1","to":"refine"}',
  });
});

it('hands back the sentence the server refused with', async () => {
  const said = await postWrite(answer(409, '{"message":"APP-1 cannot move from inbox to plan while it is idle."}'), '/api/board/move', {});

  expect(said).toBe('APP-1 cannot move from inbox to plan while it is idle.');
});

it.each(['<html>not json</html>', '{"message":42}', 'null'])('names the status when the refusal carries no sentence: %s', async (body) => {
  expect(await postWrite(answer(500, body), '/api/board/move', {})).toBe('The board answered 500 and gave no reason.');
});

it('says the board could not be reached when the request itself fails', async () => {
  const down = vi.fn(async () => {
    throw new TypeError('fetch failed');
  });

  expect(await postWrite(down, '/api/board/move', {})).toBe('The board could not be reached. Check that Nolzu is still running.');
});

const board = snapshot('pull-request', [view('APP-1', 'inbox')]);

it('says nothing while the first snapshot is on its way', () => {
  expect(clusterNote(null, false, 'APP-1')).toBeNull();
});

// No snapshot means no buttons. A page that then shows nothing reads as a page with no actions.
it('says the board is not answering when the stream failed before any snapshot came', () => {
  expect(clusterNote(null, true, 'APP-1')).toBe('The board is not answering. Check that Nolzu is still running.');
});

it('says the card left the board, because the header then still shows what the page loaded', () => {
  expect(clusterNote(board, false, 'APP-9')).toBe('APP-9 is not on the board any more. What this page shows may be out of date.');
});

it('says nothing when the card is on the board, also while the stream is reconnecting', () => {
  expect(clusterNote(board, false, 'APP-1')).toBeNull();
  expect(clusterNote(board, true, 'APP-1')).toBeNull();
});

// A card that stores its own model starts on it, and the button says so.
it('names the card own model and effort in what the move starts', () => {
  const card = { ...view('APP-2', 'plan'), starts: { implement: { phase: 'implement' as const, model: 'opus', effort: 'high' as const, engine: 'claude-code', modelState: 'ok' as const, refusal: null } } };

  expect(forwardMove(snapshot('pull-request', [card]), 'APP-2')?.starts).toBe('Starts: /implement · opus · high');
});

// The button checks the same model its label names, so a card whose own model is gone cannot start a run
// that fails at once.
it('hands on the next stage with the card own starts, which is what the button checks', () => {
  const card = { ...view('APP-2', 'plan'), starts: { implement: { phase: 'implement' as const, model: 'old', effort: 'high' as const, engine: 'claude-code', modelState: 'gone' as const, refusal: null } } };

  expect(forwardMove(snapshot('pull-request', [card]), 'APP-2')?.next?.starts).toEqual(card.starts.implement);
});
