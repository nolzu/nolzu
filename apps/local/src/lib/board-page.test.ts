import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canMove, deliveryBoard } from '@nolzu/core';
import { BOARD_KINDS, CARD_STATES } from '@nolzu/protocol';
import { dropOutcome, lockReason, refuseDrop, startDrag } from '@nolzu/ui';
import { describe, expect, it, vi } from 'vitest';
import { boardFixture, cardFixture } from '@nolzu/ui/fixture';
import { goto } from '$app/navigation';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { drawnAt } from '../../../../test/stubs/app-paths.ts';
// eslint-disable-next-line no-restricted-imports -- a test stub, which belongs to no package
import { page } from '../../../../test/stubs/app-state.ts';
import { toggleFilter } from './board-keys.ts';
import { addedOf, addedToast, addOrHold, addRequest, allowedFor, answered, boardCount, boardKind, cardAdded, cardDeleted, confirmFix, confirmStage, dismissed, filterOn, filterQuery, fixLink, isBoardRoute, keyCopied, keyWrite, nextKey, NO_TOASTS, postCard, postJira, pressed, researchCard, landed, nextStepOf, pullsAddress, readPullsSaid, refusedDrop, sendMove, SETTING_TOAST, settingToast, stageBack, stageBefore, stageForward, streamAddress } from './board-page.ts';

// The filter's press goes somewhere, and the test reads where.
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }));

const board = deliveryBoard('pull-request');

it('lets a card go one stage forward and any number back', () => {
  const allowed = allowedFor(board, { stage: 'plan', state: 'idle' });

  expect(allowed('implement')).toBe('forward');
  expect(allowed('refine')).toBe('back');
  expect(allowed('inbox')).toBe('back');
  expect(allowed('qa')).toBe(false);
  expect(allowed('plan')).toBe(false);
});

it('lets a card its run holds go nowhere', () => {
  expect(allowedFor(board, { stage: 'plan', state: 'running' })('implement')).toBe(false);
});

it('allows nothing when no card is picked up', () => {
  expect(allowedFor(board, null)('refine')).toBe(false);
});

// A name that is not one of the five is a page that is not there, which is what keeps a made-up
// address out of the board the person is looking at. `/` is Now and names no board.
it.each([
  ['delivery', 'delivery'],
  ['epics', 'epics'],
  ['investigations', 'investigations'],
  ['questions', 'questions'],
  ['prreview', 'prreview'],
  ['Epics', null],
  ['pr-review', null],
  ['../delivery', null],
  ['', null],
])('reads the board name %j as %j', (name, kind) => {
  expect(boardKind(name)).toBe(kind);
});

// The five the protocol names, so a kind added there without a page here turns this red.
it('reads every kind the protocol names', () => {
  expect(BOARD_KINDS.map((kind) => boardKind(kind))).toEqual([...BOARD_KINDS]);
});

// packages/ui may import protocol only, so its fixture writes the stages out by hand. This is the one
// place that sees both, so the fixture cannot drift away from the real board without a test saying so.
it('holds the ui fixture to the real board', () => {
  expect(boardFixture('pull-request').stages.map((stage) => stage.id)).toEqual(deliveryBoard('pull-request').stages.map((stage) => stage.id));
});

// The board greys out a card with the ui's own copy of the lock rule, and core refuses the move with
// canMove. Two copies of one rule, held together here for every state.
it.each(CARD_STATES)('agrees with core about whether a %s card can move', (state) => {
  const locked = lockReason({ key: 'APP-1', state }) !== null;

  expect(locked).toBe(!canMove(board, { stage: 'plan', state }, 'implement'));
});

const answer = (status: number, body: string) => vi.fn(async () => new Response(body, { status }));

it('sends a move and has nothing to say when the server took it', async () => {
  const send = answer(200, '{"ok":true}');

  expect(await sendMove(send, '/api/board/move', 'APP-1', 'refine')).toBeNull();
  expect(send).toHaveBeenCalledWith('/api/board/move', expect.objectContaining({ body: '{"key":"APP-1","to":"refine"}' }));
});

// The card stays where the stream last put it, and the person reads one toast with the server's
// sentence. Nothing is added to it: the server names the rule that refused the move, and a line
// written on this side would send the person to the wrong thing.
it('turns a refused move into one refusal with the server sentence, and returns no board', async () => {
  const refusal = await sendMove(answer(409, '{"message":"APP-1 cannot move from inbox to refine while it is queued."}'), '/api/board/move', 'APP-1', 'refine');

  expect(refusal).toEqual({ message: 'APP-1 cannot move from inbox to refine while it is queued.', fix: null });
});

// The rail marks Delivery as the current page on the board routes only. `/` is Now. A 404 has no
// route id.
it.each([
  ['/', false],
  ['/b/[board]', true],
  ['/t/[key]/[tab]', false],
  [null, false],
])('treats the route %s as a board route: %s', (id, expected) => {
  expect(isBoardRoute(id)).toBe(expected);
});

// Which toasts the board shows, and for which card. Every press and every refused drag takes a number
// for its card, and an answer counts only for that card's latest press, so a late answer cannot cover a
// newer try of the same card. Another card's press never hides it.
const gone = { message: 'sonnet is gone.', fix: 'Settings, Models.' };
const busy = { message: 'APP-1 is queued.', fix: 'Wait for the run.' };
const card = (key: string) => ({ key, href: `/t/${key}` });
const said = (state: typeof NO_TOASTS) => state.toasts.map((toast) => [toast.card.key, toast.kind, toast.message]);

it('shows a refusal with the card the move was for, and the fix under it', () => {
  const sent = pressed(NO_TOASTS, 'APP-1');
  expect(answered(sent, sent.press, card('APP-1'), busy).toasts).toEqual([{ kind: 'error', refused: true, card: card('APP-1'), message: 'APP-1 is queued.', fix: 'Wait for the run.' }]);
});

it("takes the card's old toast down when it moves again, and leaves the other cards' toasts up", () => {
  const sent = pressed(refusedDrop(refusedDrop(NO_TOASTS, card('APP-1'), gone), card('APP-2'), gone), 'APP-1');
  expect(said(sent)).toEqual([['APP-2', 'error', 'sonnet is gone.']]);
  expect(answered(sent, sent.press, card('APP-1'), null)).toBe(sent);
});

it('drops the answer to an earlier move of the same card', () => {
  const first = pressed(NO_TOASTS, 'APP-1');
  const second = pressed(first, 'APP-1');
  expect(answered(second, first.press, card('APP-1'), busy)).toBe(second);
});

// The stack holds one toast per card, so a press of APP-2 is no reason to hide that APP-1 did not move.
it('raises the refusal of a card when another card was pressed before the answer came', () => {
  const first = pressed(NO_TOASTS, 'APP-1');
  const other = refusedDrop(pressed(first, 'APP-2'), card('APP-3'), gone);
  expect(said(answered(other, first.press, card('APP-1'), busy))).toEqual([
    ['APP-3', 'error', 'sonnet is gone.'],
    ['APP-1', 'error', 'APP-1 is queued.'],
  ]);
});

it('keeps a refused drag when the answer to an earlier move of the same card arrives after it', () => {
  const sent = pressed(NO_TOASTS, 'APP-1');
  const refused = refusedDrop(sent, card('APP-1'), gone);
  expect(answered(refused, sent.press, card('APP-1'), null)).toBe(refused);
  expect(answered(refused, sent.press, card('APP-1'), busy)).toBe(refused);
  expect(said(refused)).toEqual([['APP-1', 'error', 'sonnet is gone.']]);
});

// Driven with APP-2, because the card the answer is about decides which latest press it is held to.
it('holds an answer to the latest press of its own card, not of another card', () => {
  const first = pressed(NO_TOASTS, 'APP-2');
  const later = pressed(first, 'APP-1');
  expect(said(answered(later, first.press, card('APP-2'), gone))).toEqual([['APP-2', 'error', 'sonnet is gone.']]);
  expect(answered(later, later.press, card('APP-2'), gone)).toBe(later);
});

it('takes down only the toast of the card that moves again', () => {
  const up = refusedDrop(refusedDrop(NO_TOASTS, card('APP-1'), gone), card('APP-2'), busy);
  expect(said(pressed(up, 'APP-2'))).toEqual([['APP-1', 'error', 'sonnet is gone.']]);
});

it('says the card the dialog made and the column it landed in, and takes it down on dismiss', () => {
  const added = cardAdded(NO_TOASTS, card('APP-4'), 'Incoming', 'GitHub was not read.');
  expect(added.toasts).toEqual([{ kind: 'success', card: card('APP-4'), message: 'added to Incoming.', fix: 'GitHub was not read.' }]);
  expect(dismissed(added, 'APP-4').toasts).toEqual([]);
});

// Delete card's toast has no Open, since the card is gone. A removal that failed makes it an error,
// which stays the longer time, with the failure first under it.
it('says a delete as a success, or as an error when something could not be removed', () => {
  expect(cardDeleted(NO_TOASTS, 'APP-3', 'Deleted APP-3.', []).toasts).toEqual([{ kind: 'success', card: { key: 'APP-3' }, title: 'Deleted APP-3.', message: '', fix: null }]);
  const failed = cardDeleted(NO_TOASTS, 'APP-3', 'Deleted APP-3.', ['The card folder .tasks/APP-3 stays.'], ['The run log x could not be removed.']).toasts[0];
  expect(failed).toMatchObject({ kind: 'error', fix: 'The run log x could not be removed. The card folder .tasks/APP-3 stays.' });
});

// Add and start is one press, the same consent as a drag. A start a drop there would
// refuse is left out of the request, so the card lands in its first column with nothing running, and the
// refusal is its toast, with the link that fixes it.
describe('Add and start', () => {
  const snapshot = boardFixture('pull-request', []);
  const refine = snapshot.stages.find((stage) => stage.id === 'refine')!;
  const retired = { ...snapshot, stages: snapshot.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, model: 'claude-retired-1', modelState: 'gone' as const } } : stage)) };
  const models = { label: 'Open Settings, Models', href: '/settings/models' };

  it('sends the start the go button asked for, and keeps the stage it runs', () => {
    const asked = { input: 'Sort recipes by rating', board: 'delivery', start: true };

    expect(addRequest(asked, snapshot)).toEqual({ payload: asked, start: { stage: refine, refusal: null } });
  });

  it('sends no start for Cmd Enter or Add to Inbox', () => {
    expect(addRequest({ input: 'Sort recipes by rating', board: 'delivery' }, snapshot)).toEqual({ payload: { input: 'Sort recipes by rating', board: 'delivery' }, start: null });
  });

  it('leaves a refused start out of the request and keeps the refusal for the toast', () => {
    const { payload, start } = addRequest({ input: 'Sort recipes by rating', start: true }, retired);

    expect(payload).toEqual({ input: 'Sort recipes by rating' });
    expect(start?.refusal).toMatchObject({ stage: 'Refine', code: 'claude-retired-1', act: 'Pick another' });
  });

  // The button showed nothing to consent to, so nothing starts.
  it('leaves the start out while the board has no snapshot', () => {
    expect(addRequest({ input: 'Sort recipes by rating', start: true }, null).payload).toEqual({ input: 'Sort recipes by rating' });
  });

  // While the first run waits for Learn your repositories, the card is only added and the page
  // opens the Learn dialog on the stage it held. A refused start stays the refusal it was.
  it('holds the start back while Learn gates the first run', () => {
    const asked = { input: 'Sort recipes by rating', board: 'delivery', start: true };
    expect(addOrHold(asked, snapshot, true)).toEqual({ payload: { input: 'Sort recipes by rating', board: 'delivery' }, start: null, held: 'refine' });
    expect(addOrHold(asked, snapshot, false)).toEqual({ payload: asked, start: { stage: refine, refusal: null }, held: null });
    const refused = addOrHold({ input: 'Sort recipes by rating', start: true }, retired, true);
    expect(refused.held).toBeNull();
    expect(refused.start?.refusal).toMatchObject({ code: 'claude-retired-1' });
    expect(addOrHold({ input: 'Sort recipes by rating', board: 'delivery' }, snapshot, true).held).toBeNull();
  });

  // A next stage that starts no run has no start to send.
  it('leaves the start out where the next stage starts nothing', () => {
    const manual = { ...snapshot, stages: snapshot.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: null } : stage)) };

    expect(addRequest({ input: 'Sort recipes by rating', start: true }, manual)).toEqual({ payload: { input: 'Sort recipes by rating' }, start: null });
  });

  // PR reviews starts at Incoming, so the column is read off the card's own board.
  it("names the first column of the card's own board", () => {
    const reviews = { ...snapshot, stages: snapshot.stages.map((stage, i) => (i === 0 ? { ...stage, label: 'Incoming' } : stage)) };

    expect(addedOf({ key: 'APP-5', note: null }, reviews, null)).toMatchObject({ column: 'Incoming' });
  });

  it('says where the card went: its first column, or the stage it started in', () => {
    expect(said(addedToast(NO_TOASTS, card('APP-5'), addedOf({ key: 'APP-5', note: null }, snapshot, null)))).toEqual([['APP-5', 'success', 'added to Inbox.']]);
    expect(said(addedToast(NO_TOASTS, card('APP-5'), addedOf({ key: 'APP-5', note: null }, snapshot, { stage: refine, refusal: null })))).toEqual([['APP-5', 'success', 'added to Refine.']]);
  });

  it('raises the refused toast with its fix link for a start refused here, and the card stays in Inbox', () => {
    const { start } = addRequest({ input: 'Sort recipes by rating', start: true }, retired);
    const added = addedOf({ key: 'APP-5', note: null }, retired, start);

    expect(added).toMatchObject({ key: 'APP-5', column: 'Inbox', at: 'refine' });
    expect(addedToast(NO_TOASTS, card('APP-5'), added, models).toasts).toEqual([
      {
        kind: 'error',
        refused: true,
        card: card('APP-5'),
        headline: 'did not move to Refine',
        message: 'Refine uses claude-retired-1, which Claude Code no longer offers.',
        code: 'claude-retired-1',
        fix: 'Pick another in Settings, Models.',
        link: models,
      },
    ]);
  });

  // The server's sentence says what happened, as a refused drop's does, so no column is named over it.
  it('raises the server sentence when the server refused the start', () => {
    const message = 'APP-5 moved to refine, but its run did not start. The card is marked failed.';
    const added = addedOf({ key: 'APP-5', note: null, refused: message }, snapshot, { stage: refine, refusal: null });
    // The link the pages pass for every added card, from fixLink. The server's sentence names its own fix.
    const raised = addedToast(NO_TOASTS, card('APP-5'), added, { label: 'Open Settings, Models', href: '/settings/models' });

    expect(added.at).toBeNull();
    expect(said(raised)).toEqual([['APP-5', 'error', message]]);
    expect(raised.toasts[0]).not.toHaveProperty('headline');
    expect(raised.toasts[0]).not.toHaveProperty('link');
    expect(raised.toasts[0]).toMatchObject({ fix: null });
  });
});

it('reads the key the next local card gets, and nothing when the app does not answer', async () => {
  expect(await nextKey(answer(200, '{"key":"APP-21"}'), '/api/cards/next')).toBe('APP-21');
  expect(await nextKey(answer(500, 'not json'), '/api/cards/next')).toBeNull();
  expect(await nextKey(answer(404, '{"key":"APP-21"}'), '/api/cards/next')).toBeNull();
  const down = vi.fn(async (): Promise<Response> => {
    throw new TypeError('fetch failed');
  });
  expect(await nextKey(down, '/api/cards/next')).toBeNull();
});

it('connects Jira with one POST, and passes a refusal on in its own words', async () => {
  const form = { site: 'https://you.atlassian.net', email: 'dana@example.com', token: 'ATATT3xFfGF0-recipe-token' };
  const send = answer(200, '{"ticketSystem":"jira"}');
  expect(await postJira(send, '/api/tickets/jira', form)).toEqual({ ok: true });
  expect(send).toHaveBeenCalledWith('/api/tickets/jira', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) });
  expect(await postJira(answer(400, '{"message":"Paste an API token."}'), '/api/tickets/jira', form)).toEqual({ ok: false, reason: 'Paste an API token.' });
  expect(await postJira(answer(500, 'not json'), '/api/tickets/jira', form)).toEqual({ ok: false, reason: 'Jira was not connected. Nolzu answered 500 and gave no reason.' });
});

// A refused drop says which card did not move, to which column, why, and the setting that fixes it.
// Every refusal the board gives itself is about the row a start runs on.
describe('the toast of a refused drop', () => {
  const plan = boardFixture('pull-request', [cardFixture({ key: 'APP-18', stage: 'refine' })]).stages.find((stage) => stage.id === 'plan')!;
  const gonePlan = { ...plan, starts: { ...plan.starts!, model: 'sonnet-4-5', modelState: 'gone' as const } };
  const models = { label: 'Open Settings, Models', href: '/settings/models' };

  it('names the column the card did not reach and links the setting to fix', () => {
    const outcome = dropOutcome(startDrag('APP-18'), gonePlan, () => 'forward');
    if (outcome?.kind !== 'refused') throw new Error('the drop was not refused');

    expect(refusedDrop(NO_TOASTS, card('APP-18'), outcome.refusal, models).toasts).toEqual([
      {
        kind: 'error',
        refused: true,
        card: card('APP-18'),
        headline: 'did not move to Plan',
        message: 'Plan uses sonnet-4-5, which Claude Code no longer offers.',
        code: 'sonnet-4-5',
        // The link names the one place to fix it, so the fix names that place alone.
        fix: 'Pick another in Settings, Models.',
        link: { label: 'Open Settings, Models', href: '/settings/models' },
      },
    ]);
  });

  // A retry moves nothing, so its refusal names no column. The row it runs on is fixed in the same place.
  it('links the setting and names no column on a refusal that moved nothing', () => {
    const [toast] = refusedDrop(NO_TOASTS, card('APP-3'), gone, models).toasts;

    expect(toast).not.toHaveProperty('headline');
    expect(toast?.link).toEqual(models);
    // A refusal that names no act keeps its own fix.
    expect(toast?.fix).toBe('Settings, Models.');
  });

  // A login the machine has not got is fixed in the place the link names, as a gone model is.
  it('names only the linked place in the fix of a missing login', () => {
    const noLogin = { ...plan, starts: { ...plan.starts!, modelState: 'no-profile' as const } };
    const refusal = refuseDrop(noLogin, 'forward')!;
    const [toast] = refusedDrop(NO_TOASTS, card('APP-18'), refusal, { label: 'Open card settings', href: '/t/APP-18/settings' }).toasts;

    expect(toast?.fix).toBe('Set the row back to inherit in the card settings.');
  });

  // The row that refused is the one to fix. Settings, Models does not change a row the card set itself.
  describe('fixLink', () => {
    const hrefs = { card: '/t/APP-18/settings', models: '/settings/models' };
    const own = (starts: Record<string, unknown>) => boardFixture('pull-request', [cardFixture({ key: 'APP-18', stage: 'refine', starts })]);
    const sonnet = { ...plan.starts!, model: 'sonnet-4-5', modelState: 'gone' as const };

    it('links the card settings when the card runs the stage on a row of its own', () => {
      expect(fixLink(own({ plan: sonnet }), 'APP-18', 'plan', hrefs)).toEqual({ label: 'Open card settings', href: '/t/APP-18/settings' });
    });

    // A card that stores models of its own carries every phase, the ones it follows the project on too.
    it('links Settings, Models when the card follows the project for that stage', () => {
      expect(fixLink(own({ plan: plan.starts! }), 'APP-18', 'plan', hrefs)).toEqual(models);
      expect(fixLink(boardFixture('pull-request', [cardFixture({ key: 'APP-18', stage: 'refine' })]), 'APP-18', 'plan', hrefs)).toEqual(models);
      expect(fixLink(own({ plan: sonnet }), 'APP-18', null, hrefs)).toEqual(models);
    });
  });

  // The server's refusals are rules, such as a card that is queued, and no setting fixes them.
  it('links no setting on a refusal the server sent', () => {
    const sent = pressed(NO_TOASTS, 'APP-1');
    const [toast] = answered(sent, sent.press, card('APP-1'), busy).toasts;

    expect(toast).not.toHaveProperty('link');
    expect(toast).not.toHaveProperty('headline');
  });
});

// The column one on, as a drop there reads it: with the card's own model over the stage's.
describe('stageForward', () => {
  it('gives the next stage with the card\'s own model', () => {
    const own = { phase: 'refine' as const, model: 'opus', effort: 'high' as const, engine: 'claude-code', modelState: 'ok' as const, refusal: null };
    const snapshot = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox', starts: { refine: own } })]);

    expect(stageForward(snapshot, 'APP-1')).toMatchObject({ id: 'refine', label: 'Refine', starts: own });
  });

  it('gives nothing for a card that cannot move forward', () => {
    expect(stageForward(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'closed' })]), 'APP-1')).toBeNull();
    expect(stageForward(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'plan', state: 'running' })]), 'APP-1')).toBeNull();
  });
});

// What a confirm stays open for, read off each snapshot. A move holds the column it was asked for, so a
// card that moved on in the meantime is never offered the column after it.
describe('confirmStage', () => {
  it('gives the stage a retry runs in, and the column a move goes to', () => {
    const snapshot = boardFixture('pull-request', [cardFixture({ key: 'APP-3', stage: 'implement', state: 'failed' }), cardFixture({ key: 'APP-1', stage: 'inbox' })]);

    expect(confirmStage(snapshot, { key: 'APP-3', move: null })?.id).toBe('implement');
    expect(confirmStage(snapshot, { key: 'APP-1', move: 'refine' })?.id).toBe('refine');
  });

  // R's confirm on a QA FAIL is Fix it: Implement first, then QA, until the card no longer offers it.
  it('gives Fix it its two runs on a QA FAIL, and nothing once the card moved', () => {
    const failed = boardFixture('pull-request', [cardFixture({ key: 'APP-3', stage: 'qa', state: 'ready', verdict: 'FAIL' })]);

    expect(confirmStage(failed, { key: 'APP-3', move: null })?.id).toBe('implement');
    expect(confirmFix(failed, { key: 'APP-3', move: null })).toMatchObject({ implement: { id: 'implement' }, qa: { id: 'qa' } });
    const moved = boardFixture('pull-request', [cardFixture({ key: 'APP-3', stage: 'implement', state: 'queued' })]);
    expect(confirmStage(moved, { key: 'APP-3', move: null })).toBeNull();
    expect(confirmFix(moved, { key: 'APP-3', move: null })).toBeNull();
  });

  it('closes a move whose card is no longer one column before it', () => {
    const moved = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'refine' })]);

    expect(confirmStage(moved, { key: 'APP-1', move: 'refine' })).toBeNull();
    expect(confirmStage(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox', state: 'queued' })]), { key: 'APP-1', move: 'refine' })).toBeNull();
  });
});

// Shift and the left arrow move a card one column back, the move a drop on that column sends.
describe('stageBack', () => {
  it('gives the stage before the card', () => {
    expect(stageBack(board, { stage: 'plan', state: 'idle' })).toBe('refine');
    expect(stageBack(board, { stage: 'review', state: 'ready' })).toBe('qa');
  });

  it('gives nothing for a card in the first column, or one its run holds', () => {
    expect(stageBack(board, { stage: 'inbox', state: 'idle' })).toBeNull();
    expect(stageBack(board, { stage: 'plan', state: 'running' })).toBeNull();
    expect(stageBack(board, { stage: 'plan', state: 'queued' })).toBeNull();
  });
});

// The card page and the peek both read the Next step block off this, so the two offer one step.
describe('nextStepOf', () => {
  const hrefs = { card: '/t/APP-1/settings', models: '/settings/models' };

  it('names the next column, the move back with its label, and the stage the button starts', () => {
    const step = nextStepOf(boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'plan', state: 'ready' })]), 'APP-1', 0, hrefs);

    expect(step?.next?.id).toBe('implement');
    expect(step?.back).toEqual({ to: 'refine', label: 'Refine' });
    expect(step?.go?.id).toBe('implement');
    expect(step?.sendBack).toBeNull();
  });

  it('offers no move back while a run holds the card, and nothing for a card the snapshot lacks', () => {
    const snapshot = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'plan', state: 'running' })]);

    expect(nextStepOf(snapshot, 'APP-1', 0, hrefs)?.back).toBeNull();
    expect(nextStepOf(snapshot, 'APP-9', 0, hrefs)).toBeNull();
  });
});

// The keys that write read the card off the snapshot at the press, and answer null when the card has
// no such control, so the key does nothing and the browser keeps it.
describe('keyWrite', () => {
  const on = (...cards: Parameters<typeof cardFixture>[0][]) => boardFixture('pull-request', cards.map(cardFixture));

  it('asks first before a retry that starts a run', () => {
    expect(keyWrite(on({ key: 'APP-3', stage: 'implement', state: 'failed' }), 'APP-3', 'retry')).toEqual({ kind: 'ask' });
  });

  it('refuses a retry the way a drop refuses, and sends nothing', () => {
    const gone = { phase: 'implement' as const, model: 'opus', effort: 'high' as const, engine: 'claude-code', modelState: 'gone' as const, refusal: null };

    expect(keyWrite(on({ key: 'APP-3', stage: 'implement', state: 'failed', starts: { implement: gone } }), 'APP-3', 'retry')).toEqual({
      kind: 'refused',
      refusal: { message: 'Implement uses opus, which Claude Code no longer offers.', fix: 'Pick another in the card settings, or in Settings, Models.', code: 'opus', act: 'Pick another' },
      at: 'implement',
    });
  });

  it('sends a retry at once in a stage that starts no phase, and nothing for a card that has not failed', () => {
    expect(keyWrite(on({ key: 'APP-3', stage: 'wrapup', state: 'failed' }), 'APP-3', 'retry')).toEqual({ kind: 'send', to: 'retry', body: {} });
    expect(keyWrite(on({ key: 'APP-3', stage: 'implement', state: 'idle' }), 'APP-3', 'retry')).toBeNull();
  });

  // R on a QA FAIL offers Fix it: it asks first, as a retry does, and is refused the way a drop
  // refuses either of its two runs.
  it('asks first before Fix it on a QA FAIL, and refuses it when either run is refused', () => {
    const gone = { phase: 'qa' as const, model: 'opus', effort: 'high' as const, engine: 'claude-code', modelState: 'gone' as const, refusal: null };

    expect(keyWrite(on({ key: 'APP-3', stage: 'qa', state: 'ready', verdict: 'FAIL' }), 'APP-3', 'retry')).toEqual({ kind: 'ask' });
    expect(keyWrite(on({ key: 'APP-3', stage: 'qa', state: 'ready', verdict: 'FAIL', starts: { qa: gone } }), 'APP-3', 'retry')).toMatchObject({ kind: 'refused', at: 'qa' });
    // A QA PASS has nothing to fix.
    expect(keyWrite(on({ key: 'APP-3', stage: 'qa', state: 'ready', verdict: 'PASS' }), 'APP-3', 'retry')).toBeNull();
  });

  it('minimizes a card, and restores a minimized one', () => {
    expect(keyWrite(on({ key: 'APP-1' }), 'APP-1', 'minimize')).toEqual({ kind: 'send', to: '/api/board/minimize', body: { key: 'APP-1', minimized: true } });
    expect(keyWrite(on({ key: 'APP-1', minimized: true }), 'APP-1', 'minimize')).toEqual({ kind: 'send', to: '/api/board/minimize', body: { key: 'APP-1', minimized: false } });
  });

  // Two cards, so the write names the card the key was pressed on and reads that card's own state.
  it('minimizes the card it is given, not another card on the board', () => {
    const two = on({ key: 'APP-1', minimized: true }, { key: 'APP-2', stage: 'plan' });

    expect(keyWrite(two, 'APP-2', 'minimize')).toEqual({ kind: 'send', to: '/api/board/minimize', body: { key: 'APP-2', minimized: true } });
  });

  it('stops only a run that is on its way', () => {
    expect(keyWrite(on({ key: 'APP-2', stage: 'plan', state: 'running', runId: 7 }), 'APP-2', 'stop')).toEqual({ kind: 'send', to: '/api/board/stop', body: { runId: 7 } });
    expect(keyWrite(on({ key: 'APP-2', stage: 'plan', state: 'idle' }), 'APP-2', 'stop')).toBeNull();
  });

  it('moves only a queued run to the front of the queue', () => {
    expect(keyWrite(on({ key: 'APP-2', stage: 'plan', state: 'queued', runId: 9 }), 'APP-2', 'promote')).toEqual({ kind: 'send', to: '/api/board/promote', body: { runId: 9 } });
    expect(keyWrite(on({ key: 'APP-2', stage: 'plan', state: 'running', runId: 9 }), 'APP-2', 'promote')).toBeNull();
    expect(keyWrite(on({ key: 'APP-2', stage: 'plan', state: 'queued' }), 'APP-2', 'promote')).toBeNull();
  });

  it('does nothing for a card the board no longer has', () => {
    expect(keyWrite(on(), 'APP-9', 'minimize')).toBeNull();
  });

  // Shift and the right arrow: the move a drop on the next column sends, asked first when it starts a
  // run, refused the way that drop is refused, and sent at once when it starts nothing.
  it('asks first before a move forward that starts a run, and names the column', () => {
    expect(keyWrite(on({ key: 'APP-1', stage: 'inbox' }), 'APP-1', 'forward')).toEqual({ kind: 'ask', move: 'refine' });
  });

  it('refuses a move forward the way a drop refuses it, with the column the card did not reach', () => {
    const gone = { phase: 'refine' as const, model: 'opus', effort: 'high' as const, engine: 'claude-code', modelState: 'gone' as const, refusal: null };

    expect(keyWrite(on({ key: 'APP-1', stage: 'inbox', starts: { refine: gone } }), 'APP-1', 'forward')).toEqual({
      kind: 'refused',
      refusal: { message: 'Refine uses opus, which Claude Code no longer offers.', fix: 'Pick another in the card settings, or in Settings, Models.', stage: 'Refine', code: 'opus', act: 'Pick another' },
      at: 'refine',
    });
  });

  it('sends a move forward that starts nothing as the move a drop sends', () => {
    expect(keyWrite(on({ key: 'APP-5', stage: 'qa', state: 'ready' }), 'APP-5', 'forward')).toEqual({ kind: 'send', to: '/api/board/move', body: { key: 'APP-5', to: 'review' } });
  });

  it('does nothing for a card its run holds, or one in the last column', () => {
    expect(keyWrite(on({ key: 'APP-2', stage: 'plan', state: 'running', runId: 4 }), 'APP-2', 'forward')).toBeNull();
    expect(keyWrite(on({ key: 'APP-2', stage: 'plan', state: 'queued', runId: 4 }), 'APP-2', 'forward')).toBeNull();
    expect(keyWrite(on({ key: 'APP-7', stage: 'closed' }), 'APP-7', 'forward')).toBeNull();
    expect(keyWrite(on(), 'APP-9', 'forward')).toBeNull();
  });
});

// C copies a card's key with no control on screen, so the toast is the only word that it worked.
it('says the key was copied, or that the browser kept the clipboard, as the card toast', () => {
  expect(keyCopied(NO_TOASTS, card('APP-3'), true).toasts).toEqual([{ kind: 'success', card: card('APP-3'), message: 'copied to the clipboard.', fix: null }]);
  expect(keyCopied(NO_TOASTS, card('APP-3'), false).toasts).toEqual([
    { kind: 'error', card: card('APP-3'), message: 'not copied. The browser did not allow the clipboard.', fix: 'Select the key on the card and copy it from there.' },
  ]);
});

// Settings, Project saves in place, so the toast is where the answer shows. It is about no card: one
// placeholder key, so the next save replaces it, and the sentence is the title.
it('says Saved, what an action said, or the refusal, as one settings toast', () => {
  const at = { key: SETTING_TOAST };
  expect(settingToast(NO_TOASTS, false, { field: 'branchTemplate', saved: true }).toasts).toEqual([{ kind: 'success', card: at, title: 'Saved.', message: '' }]);
  expect(settingToast(NO_TOASTS, false, { field: 'rescan', said: 'Found 1 new repository.' }).toasts[0]?.title).toBe('Found 1 new repository.');
  const refused = settingToast(NO_TOASTS, true, { field: 'localKeyPrefix', message: 'A prefix is 2 to 10 letters.' });
  expect(refused.toasts).toEqual([{ kind: 'error', refused: true, card: at, title: 'A prefix is 2 to 10 letters.', message: '' }]);
  expect(settingToast(refused, false, { saved: true }).toasts).toHaveLength(1);
});

describe('the waiting on me filter in the URL', () => {
  it('starts on for ?w=1, so a reload and a shared link keep it', () => {
    expect(filterOn(new URL('http://localhost/b/delivery?w=1'))).toBe(true);
  });

  it.each(['http://localhost/', 'http://localhost/?w=0', 'http://localhost/?w=yes'])('is off for %s', (url) => {
    expect(filterOn(new URL(url))).toBe(false);
  });

  it('turns on and off without losing the rest of the query', () => {
    const on = filterQuery(new URL('http://localhost/b/delivery?x=2'), true);
    expect(on).toBe('?x=2&w=1');
    expect(filterQuery(new URL(`http://localhost/b/delivery${on}`), false)).toBe('?x=2');
  });

  it('adds no bare question mark when the filter was the only parameter', () => {
    expect(filterQuery(new URL('http://localhost/b/delivery?w=1'), false)).toBe('');
  });

  // W, Esc and the button keep the person on the board they look at. It once sent every board to
  // Delivery, so W on the Epics board opened another board.
  it.each([
    ['epics', '/b/epics', '../b/epics?w=1'],
    ['delivery', '/b/delivery?w=1', '../b/delivery'],
    ['research', '/b/research', '../b/research?w=1'],
  ])('stays on the %s board on a press', async (board, path, want) => {
    // Research is its own route, with no board in the address.
    page.params = board === 'research' ? {} : { board };
    page.route = { id: board === 'research' ? '/b/research' : '/b/[board]' };
    page.url = new URL(`http://localhost${path}`);
    drawnAt(page.url.pathname);

    await toggleFilter();

    expect(vi.mocked(goto)).toHaveBeenLastCalledWith(want, { replaceState: true, keepFocus: true, noScroll: true });
  });
});

/**
 * The three rules the board page needs, where a test can reach them.
 *
 * All three were in the component, which has no test, so a wrong stream address, a wrong Add card
 * button and a filter key that walked off the board all passed the gate. The third one showed up in
 * the running app.
 */
it.each(BOARD_KINDS)('reads the %s board from its own stream', (kind) => {
  expect(streamAddress('/api/board', kind)).toBe(`/api/board?board=${kind}`);
});

// The PR reviews board reads its open pull requests on a press, and the status line under the
// title always says what came of it.
describe('Read open pull requests', () => {
  it('posts to the pull list route and shows what the board read', async () => {
    const send = answer(200, '{"added":[],"closed":[],"said":"cook/recipes has no open pull request."}');

    expect(await readPullsSaid(send, '/api/board/pulls')).toBe('cook/recipes has no open pull request.');
    expect(send).toHaveBeenCalledWith('/api/board/pulls', { method: 'POST' });
  });

  it('shows the refusal sentence the server gave', async () => {
    expect(await readPullsSaid(answer(409, '{"message":"This project has no GitHub remote."}'), '/api/board/pulls')).toBe('This project has no GitHub remote.');
  });

  it('says the status when the answer carries no sentence', async () => {
    expect(await readPullsSaid(answer(500, 'Internal Error'), '/api/board/pulls')).toBe('The pull requests were not read. The board answered 500 and gave no reason.');
  });

  it('says the board is gone when nothing answers', async () => {
    const send = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });

    expect(await readPullsSaid(send, '/api/board/pulls')).toBe('The board could not be reached. Check that Nolzu is still running.');
  });

  // The button and its status line belong to the boards with an address. Read from the page,
  // because the page has no mount test.
  it('draws the button and its status line on the boards that read pull requests alone', () => {
    const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');
    const only = page.split('{#if pullsAt !== null}').slice(1);

    expect(only).toHaveLength(2);
    expect(only[0]).toMatch(/^[^]*?onclick=\{readPulls\}[^]*?data-read-pulls[^]*?\{\/if\}/);
    expect(only[1]).toMatch(/^\s*<!--[^]*?-->\s*<p[^>]*data-read-said>\{read\[kind\] \?\? ''\}<\/p>\s*\{\/if\}/);
    expect(page).toContain("pullsAddress(resolve('/api/board/pulls'), kind)");
    expect(page).toContain('readPullsSaid(fetch, at)');
  });

  // P presses the same read, so it is bound only where the button is, or the help would list P on a
  // board where it does nothing.
  it('binds P only on the boards that draw the button', () => {
    const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

    expect(page).toContain("const boardKeys = $derived<KeyActions>(pullsAt === null ? actions : { ...actions, 'read-pulls': () => void readPulls() });");
    expect(page).not.toMatch(/const actions: KeyActions = \{[^]*?'read-pulls'[^]*?\n {2}\};/);
  });

  // The page stays between the two boards, so a press on one never shows as busy on the other.
  it('keeps the pending state and the sentence per board', () => {
    const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

    expect(page).toContain('if (reading[asked] === true || at === null) return;');
    expect(page).toContain("aria-busy={reading[kind] ? 'true' : undefined}");
    expect(page).toContain("{reading[kind] ? 'Reading pull requests' :");
  });

  // The person may go to the other board while gh runs, and the answer belongs to the board that asked.
  it('files the answer under the board that asked', () => {
    const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

    expect(page).toContain('const asked = kind;');
    expect(page).toContain('read[asked] = await readPullsSaid(fetch, at);');
    expect(page).toContain('reading[asked] = false;');
  });
});

// The PR reviews board keeps the address it always posted to, and the Delivery board names itself.
describe('pullsAddress', () => {
  it('posts the PR reviews read where it always went, and the Delivery lookup with its board', () => {
    expect(pullsAddress('/api/board/pulls', 'prreview')).toBe('/api/board/pulls');
    expect(pullsAddress('/api/board/pulls', 'delivery')).toBe('/api/board/pulls?board=delivery');
  });

  it.each(BOARD_KINDS.filter((kind) => kind !== 'prreview' && kind !== 'delivery'))('gives the %s board no button', (kind) => {
    expect(pullsAddress('/api/board/pulls', kind)).toBeNull();
  });
});

// The wire, read off the page because it cannot be rendered without the running app. The board above
// the columns is the heading and its buttons, with no line of stage names, and the page clears its drag
// whenever the board says a drag is over.
it('draws no flow line over the board, and clears the drag when the board ends it', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).not.toContain('class="flow"');
  expect(page).not.toContain('→ ');
  expect(page).toContain('onDragEnd={() => (drag = null)}');
});

// The Research add box keeps words as the title, so a question that looks like a key is not read as one.
// A GitHub issue link alone is read through gh as Add card reads it, so its title and text land on the card.
it('sends a GitHub issue link from the Research add box as input, and anything else as the title', () => {
  expect(researchCard(' https://github.com/cook/recipes/issues/12 ', 'questions')).toEqual({ input: 'https://github.com/cook/recipes/issues/12', board: 'questions' });
  expect(researchCard('Why is APP-3 slow?', 'investigations')).toEqual({ input: '', title: 'Why is APP-3 slow?', board: 'investigations' });
  expect(researchCard('APP-3', 'questions')).toEqual({ input: '', title: 'APP-3', board: 'questions' });
  // A pull request is no question: it stays words, as before.
  expect(researchCard('https://github.com/cook/recipes/pull/7', 'questions')).toEqual({ input: '', title: 'https://github.com/cook/recipes/pull/7', board: 'questions' });
  expect(readFileSync(join(import.meta.dirname, 'ResearchAdd.svelte'), 'utf8')).toContain("postCard(fetch, resolve('/api/cards'), researchCard(text, kind))");
});

// The Add card dialog shows the reason it is handed, word for word. The server's own sentence, such as
// the one for a missing gh, must be that reason, and the page's fallback only when the server gave none.
// The board posts through postCard. Now has no Add card of its own.
it('hands the Add card dialog the sentence the server refused the card with', async () => {
  expect(readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8')).toContain("await postCard(fetch, resolve('/api/cards'), payload);");
  expect(readFileSync(join(import.meta.dirname, 'NowPage.svelte'), 'utf8')).not.toContain('AddCardDialog');
  expect(await postCard(answer(409, '{"message":"gh is not installed, so the pull request cannot be read."}'), '/api/cards', {})).toEqual({
    ok: false,
    reason: 'gh is not installed, so the pull request cannot be read.',
  });
  expect(await postCard(answer(500, 'not json'), '/api/cards', {})).toEqual({ ok: false, reason: 'The card was not made. The board answered 500 and gave no reason.' });
  expect(await postCard(answer(200, '{"key":"APP-9","note":null}'), '/api/cards', {})).toEqual({ ok: true, key: 'APP-9', note: null });
  // A card made with its start refused is a card made: the dialog closes on its key and the toast says
  // why. Read as a refusal, the dialog would stay open and a second press would make a second card.
  expect(await postCard(answer(201, '{"key":"APP-9","note":null,"refused":"APP-9 moved to refine, but its run did not start."}'), '/api/cards', {})).toEqual({
    ok: true,
    key: 'APP-9',
    note: null,
    refused: 'APP-9 moved to refine, but its run did not start.',
  });
  const down = vi.fn(async (): Promise<Response> => {
    throw new TypeError('fetch failed');
  });
  expect(await postCard(down, '/api/cards', {})).toEqual({ ok: false, reason: 'The board could not be reached. Check that Nolzu is still running.' });
});

// The dialog says where to turn PR reviews on only when it knows the board is off.
it('hands the Add card dialog the boards that are off', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).toContain('off={page.data.offBoards ?? []}');
});

// The page cannot be mounted, so its wiring is read off it. Its keys go to the layout's one handler,
// whose registry holds every key while a dialog is open, and every toast goes to the app's one stack,
// which the layout's one host draws.
it('hands its keys to the one handler, and raises its toasts into the one stack', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).not.toContain('<svelte:window');
  expect(page).toContain("return pageKeys.show({ keys: scoped('board'), actions: boardKeys });");
  expect(page).not.toMatch(/<dialog[\s>]/);
  expect(page).not.toMatch(/<Toast[\s>]/);
  expect(page).not.toMatch(/<ToastHost[\s>]/);
  expect(page).toContain("import { toastStack } from './toast-stack.svelte.ts';");
});

// A goes where the card's own Answer link goes, through the one helper both read, so the board answers
// on the card page's composer and nowhere new. It reads the selection as Enter does: it writes nothing.
it('sends A to the Answer link of the chosen card', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  const handler = /\n {4}answer: \(\) => \{([\s\S]*?)\n {4}\},/.exec(page)?.[1] ?? '';

  expect(handler).toContain('const card = chosen();');
  expect(handler).toContain('const to = card === null ? null : answerHref(card);');
  // A card that asks nothing hands the key back to the browser, before anything navigates.
  expect(handler).toContain('if (to === null) return false;');
  expect(handler.indexOf('if (to === null) return false;')).toBeLessThan(handler.indexOf('void goto(to);'));
});

// keyWrite decides, and the page only carries it out: the ask opens the confirm and sends nothing, and
// every write key acts on the card with the focus ring, never on a selection drawn nowhere.
it('opens the confirm on an ask, and writes only to the focused card', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).toContain("if (said.kind === 'ask') starting = { key: card.key, move: said.move ?? null };");
  expect(page).toContain('const said = card === null || on === null ? null : keyWrite(on, card.key, action);');
  expect(page).toContain('return card !== null && cardElement(card.key) === document.activeElement ? card : null;');
  for (const action of ['retry', 'stop', 'promote', 'minimize']) expect(page).toContain(`${action}: () => write('${action}'),`);
  expect(page).toContain("'move-forward': () => write('forward'),");
  expect(page.match(/const card = focused\(\);/g)).toHaveLength(3);
});

// The confirm holds the card it was opened for, so Confirm retries that card, on that card's own route,
// and a key write goes to the card the key was pressed on.
it('retries the card the confirm was opened for, on its own route', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).toContain("const retryPath = (key: string) => resolve('/api/card/[key]/retry', { key: encodeURIComponent(key) });");
  expect(page).toContain('if (starting?.move === null) void send(starting.key, retryPath(starting.key), {});');
  // A move goes through the function a drop goes through, so the two cannot send different moves.
  expect(page).toContain('else if (starting !== null) void move(starting.key, starting.move);');
  expect(page).toContain("else void send(card.key, said.to === 'retry' ? retryPath(card.key) : resolve(said.to), said.body);");
});

// Shift and the left arrow move the focused card back, and C copies that card's key.
it('moves back and copies the card the key was pressed on', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).toContain('const to = card === null || board === null ? null : stageBack(board, card);');
  expect(page).toContain('void move(card.key, to);');
  expect(page).toContain('const at = { key: card.key, href: cardHref(card.key) };');
  expect(page).toContain('void copyText(card.key).then((copied) => (toastStack.state = keyCopied(toastStack.state, at, copied)));');
});

// Each toast the board raises goes through one of the tested helpers above, at its own place on the page.
it('raises a toast for a refused drag, a refused move and a card added, and takes the old one down on a move', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).toContain('if (drag !== null) toastStack.state = refusedDrop(toastStack.state, { key: drag.key, href: cardHref(drag.key) }, said, fixOf(drag.key, drag.over));');
  expect(page).toContain("const settingsHref = resolve('/settings/[section]', { section: 'models' });");
  expect(page).toContain("fixLink(of, key, stage, { card: resolve('/t/[key]/[tab]', { key: encodeURIComponent(key), tab: 'settings' }), models: settingsHref })");
  expect(page).toContain('toastStack.state = pressed(toastStack.state, key);');
  expect(page).toContain('if (added !== null) toastStack.state = addedToast(toastStack.state, { key: added.key, href: cardHref(added.key) }, added, fixOf(added.key, added.at));');
  // The answer is awaited before the stack is read, or it lands on the stack from before the wait.
  expect(page).toMatch(/const said = await sendMove\(fetch, resolve\('\/api\/board\/move'\), key, stage\);\n\s*toastStack\.state = answered\(toastStack\.state, mine, \{ key, href: cardHref\(key\) \}, said\);/);
});

// Each toast's Open link goes to its own card, encoded as the tab bar encodes it.
it('links each toast to its own card', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).toContain("const cardHref = (key: string) => resolve('/t/[key]', { key: encodeURIComponent(key) });");
});

// A stale added would raise the old toast again on the next Cancel. A confirm left set would open again
// by itself, with focus on Confirm, the next time its card failed, so it goes on a close and also when a
// snapshot says the card is no longer failed. Help is the handler's and has its own test.
it('resets the dialog state when a dialog closes', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).toContain('onclose={() => (starting = null)}');
  expect(page).toMatch(/\$effect\(\(\) => \{\n\s*if \(startStage === null\) starting = null;\n\s*\}\);/);
  expect(page).toMatch(/function addClosed\(\): void \{\n\s*adding = false;[\s\S]*?\n\s*added = null;\n\s*const held = heldStart;\n\s*heldStart = null;/);
  expect(page).toContain('onsubmit={addCard} onclose={addClosed} bind:draft={cardDraft} />');
});

// Waiting on me moved from the header into the board's top bar. Its count
// comes from this board's snapshot, so there is no bridge to the layout, and no button before the first
// snapshot. Read off the page, because it cannot be mounted.
it('draws Waiting on me in its top bar from its own snapshot', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).toContain('const waiting = $derived(snapshot === null ? null : snapshot.cards.filter(waitingOnMe).length);');
  expect(page).toMatch(/<div class="title">\s*<h1>\{title\}<\/h1>[\s\S]*?\{#if waiting !== null\}<WaitingToggle on=\{filtered\} count=\{waiting\} onclick=\{\(\) => void toggleFilter\(\)\} \/>\{\/if\}/);
  expect(page).not.toContain('boardState');
});

// The board runs down to a key row at the window's foot: the page is a column as tall as the
// window, and the key row takes the room left above it. A render carries no CSS, so this reads the rules.
it('puts the key row at the foot of the window', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');
  const rule = (selector: string) => new RegExp(`\\n  ${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(page)?.[1] ?? '';

  // The window less the offline banner, so the banner never pushes the key row out of view.
  expect(rule('.page')).toMatch(/display: flex;[\s\S]*flex-direction: column;[\s\S]*min-height: calc\(100vh - var\(--offline-height, 0px\)\);/);
  expect(rule('.keys')).toContain('margin: auto 0 0;');
});

// The count in the top bar leaves out the archive, which only grows, and names what the board holds.
describe('boardCount', () => {
  const card = (key: string, stage: string) => cardFixture({ key, stage });

  it('counts the cards not yet closed and leaves Closed out', () => {
    const snapshot = boardFixture('pull-request', [card('APP-1', 'inbox'), card('APP-2', 'plan'), card('APP-3', 'closed')]);

    expect(boardCount(snapshot, 'delivery')).toBe('2 cards');
    expect(boardCount(boardFixture('pull-request', [card('APP-1', 'inbox')]), 'delivery')).toBe('1 card');
  });

  it('names epics and pull requests on their own boards', () => {
    const snapshot = boardFixture('pull-request', [card('APP-1', 'inbox')]);

    expect(boardCount(snapshot, 'epics')).toBe('1 epic');
    expect(boardCount({ ...snapshot, cards: [] }, 'prreview')).toBe('0 open');
  });

  // The Epics line counts the Delivery tasks of the open epics.
  it('adds the Delivery tasks of the open epics on the Epics board', () => {
    const task = (key: string) => ({ key, title: key, state: 'idle' as const, done: false });
    const epic = (key: string, stage: string, tasks: string[]) => cardFixture({ key, stage, tasks: tasks.map(task) });
    const snapshot = boardFixture('pull-request', [epic('APP-1', 'inbox', ['APP-4', 'APP-5']), epic('APP-2', 'plan', ['APP-6']), epic('APP-3', 'closed', ['APP-7'])]);

    expect(boardCount(snapshot, 'epics')).toBe('2 epics · 3 tasks on Delivery');
    expect(boardCount(boardFixture('pull-request', [epic('APP-1', 'inbox', ['APP-4'])]), 'epics')).toBe('1 epic · 1 task on Delivery');
    expect(boardCount(boardFixture('pull-request', [card('APP-1', 'inbox')]), 'epics')).toBe('1 epic');
  });

  // The PR reviews line: the open pull requests and the repositories they come from, off the card keys.
  it('counts the open pull requests and names their repositories on PR reviews', () => {
    const pulls = [card('api#1', 'inbox'), card('web#2', 'plan'), card('api#3', 'inbox'), card('docs#4', 'closed'), cardFixture({ key: 'docs#5', stage: 'inbox', pull: { author: null, decision: 'REVIEW_REQUIRED', headCommittedAt: null, draft: false, round: null, ended: 'merged' } })];

    expect(boardCount(boardFixture('pull-request', pulls), 'prreview')).toBe('3 open · api and web');
    expect(boardCount(boardFixture('pull-request', [card('api#1', 'inbox')]), 'prreview')).toBe('1 open · api');
    expect(boardCount(boardFixture('pull-request', [card('api#1', 'inbox'), card('web#2', 'inbox'), card('cli#3', 'inbox')]), 'prreview')).toBe('3 open · api, web and cli');
  });
});

// After a key or palette move the focus can fall to the page: the stream redraws the card in its
// new column. The page selects it again once it is there, and not before, or the focus
// would go to the old element the stream is about to drop.
describe('landed', () => {
  const cards = [{ key: 'APP-1', stage: 'refine' }, { key: 'APP-2', stage: 'inbox' }];

  it('names the moved card once the stream shows it in the column it went to', () => {
    expect(landed(cards, { key: 'APP-1', to: 'refine' })).toBe('APP-1');
  });

  it('waits while the card is still where it was, and names nothing it does not show', () => {
    expect(landed(cards, { key: 'APP-2', to: 'refine' })).toBeNull();
    expect(landed(cards, { key: 'APP-9', to: 'refine' })).toBeNull();
    expect(landed(cards, null)).toBeNull();
  });
});

describe('stageBefore', () => {
  it('gives the column before, whatever the card is doing, and none in the first column', () => {
    expect(stageBefore(deliveryBoard('pull-request'), 'implement')).toBe('plan');
    expect(stageBefore(deliveryBoard('pull-request'), 'inbox')).toBeNull();
    expect(stageBefore(deliveryBoard('pull-request'), 'nowhere')).toBeNull();
  });
});

// Mutation round: the page is reused across /b/[board], so the reset of the Closed fold must stay tied to
// the board kind. The test stub for the page is not reactive, so this is a source guard.
it('closes the Closed fold again whenever the board kind changes', () => {
  const page = readFileSync(join(import.meta.dirname, 'BoardPage.svelte'), 'utf8');

  expect(page).toMatch(/\$effect\.pre\(\(\) => \{\s*void kind;\s*closedOpen = false;\s*\}\);/);
});
