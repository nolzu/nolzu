import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dedup, type ScoutItem } from '@nolzu/core';
import { addScoutSource, assessScoutFinding, checkPasteSource, createCard, openDatabase, saveScoutFindings, scoutFinding, startRun } from '@nolzu/core/node';
import { assessKey } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ScoutFindingDetail from './ScoutFindingDetail.svelte';
import ScoutFindings from './ScoutFindings.svelte';
import { scoutFindingDetail } from './scout-detail.ts';
import { answerStart, markScoutSeen, muteScoutFinding, noFindingsLine, scoutFindingsFor, seenOften } from './scout-findings.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-findings-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const source = (label: string) => addScoutSource(db, { kind: 'paste', label });

// The address of one finding's own page, which the route builds with resolve() and hands in. The
// shape is the route's, so this is only what a rendered panel links to.
const href = (id: number) => `/scout/f/${id}`;

// The address of the card a started finding is on, which the route builds the same way.
const cardHref = (key: string) => `/t/${key}`;
// The left pane of the inbox, with the muted findings folded at its end.
const markup = () => render(ScoutFindings, { props: { view: scoutFindingsFor(db), href } }).body;
const shown = () => markup().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// The right pane, with one finding selected: the one seen last unless an id is given. Every button
// that acts on a finding sits here.
const pane = (id?: number, answer: { said?: string; problem?: string } = {}) => {
  const found = scoutFindingDetail(db, String(id ?? scoutFindingsFor(db).rows[0]?.id ?? 0));
  if (!found.ok) throw new Error(found.message);
  return render(ScoutFindingDetail, { props: { detail: found.detail, cardHref, self: href(found.detail.row.id), ...answer } }).body;
};
const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
// What the Dismiss and the Unmute button post, which is one field. Start posts the board as well, so
// its own helper adds it.
const post = (id: number | string): FormData => {
  const form = new FormData();
  form.set('id', String(id));
  return form;
};
const startPost = (id: number | string, board = 'delivery'): FormData => {
  const form = post(id);
  form.set('board', board);
  return form;
};

describe('the list', () => {
  // The order has to hold across sources, because the screen is one list and not one block per
  // source. Inside a source sqlite already holds it.
  it('puts the finding seen last at the top, across more than one source', () => {
    const first = source('Pasted by hand');
    const second = source('Pasted from the other log');
    checkPasteSource(db, first, 'Timeout after 5000ms calling /api/recipes');
    checkPasteSource(db, second, 'Out of memory in the recipe worker');

    const view = scoutFindingsFor(db);

    expect(view.rows.map((row) => row.title)).toEqual(['Out of memory in the recipe worker', 'Timeout after 5000ms calling /api/recipes']);
    expect(view.rows.map((row) => row.source)).toEqual(['Pasted from the other log', 'Pasted by hand']);

    // Both checks land in the same millisecond and the row written last also has the newer id, so the
    // two lines above would hold on the id alone. The stamp is moved by hand to set the two against
    // each other: the older row is the one seen last, and it belongs on top.
    db.prepare('UPDATE scout_findings SET last_seen = ? WHERE source_id = ?').run('2031-01-01T00:00:00.000Z', first);

    expect(scoutFindingsFor(db).rows.map((row) => row.source)).toEqual(['Pasted by hand', 'Pasted from the other log']);
  });

  // Two branches, because "Seen 1 times" is not English. The word is Seen on the row, in the detail's
  // labels and in the sentence the Scout screen answers a check with.
  it('counts once in words and the rest in numbers, with the time written out', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Request 4000 failed');

    expect(scoutFindingsFor(db).rows[0]?.seen).toMatch(/^Seen once, on \d{2} \w{3,4} \d{4}, \d{2}:\d{2}\.$/);

    checkPasteSource(db, id, 'Request 2a3f failed');

    expect(scoutFindingsFor(db).rows[0]?.seen).toMatch(/^Seen 2 times, last on \d{2} \w{3,4} \d{4}, \d{2}:\d{2}\.$/);
  });

  // A pasted message can be a whole stack trace, and the row has one line for it. Two checks with two
  // different first lines, because after one check the first message and the newest one are the same
  // string and the title could be read off either.
  it('takes the first line of the newest message as the row title', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes\n  at recipes.ts:20\n  at server.ts:8');
    checkPasteSource(db, id, 'Timeout after 9000ms calling /api/recipes\n  at recipes.ts:20\n  at server.ts:8');

    const row = scoutFindingsFor(db).rows[0];
    expect(row?.title).toBe('Timeout after 9000ms calling /api/recipes');
    expect(row?.firstMessage).toContain('5000ms');
    expect(row?.lastMessage).toContain('at recipes.ts:20');
  });
});

describe('the screen', () => {
  it('says there is nothing yet and draws no row', () => {
    const body = markup();

    expect(shown()).toContain('No finding yet');
    expect(shown()).toContain('press Check now');
    expect(body).not.toContain('<li');
  });

  /**
   * The evidence, which is the whole detail.
   *
   * The two lines differ wherever the numbers in the two occurrences differ, which is why both are
   * kept: the fingerprint reads past `4000` and `2a3f`, so these are one finding with two lines.
   */
  it('shows the newest line on the row, and the first and the newest in the right pane', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Request 4000 failed');
    checkPasteSource(db, id, 'Request 2a3f failed');

    const right = text(pane());
    const fingerprint = scoutFindingsFor(db).rows[0]?.fingerprint ?? '';

    // The row is one line of the list, so it names the finding by the line seen last.
    expect(shown()).toContain('Request 2a3f failed');
    expect(shown()).not.toContain('Request 4000 failed');
    expect(right).toContain('Request 4000 failed');
    expect(right).toContain('Request 2a3f failed');
    expect(right).toContain('Found by Pasted by hand.');
    // Which line is which, and the id that folds the two into one finding. Nothing else on the screen
    // says them, so a tidy that dropped them would leave two lines with no way to tell them apart.
    expect(right).toContain('First line seen');
    expect(right).toContain('Newest line seen');
    expect(fingerprint).not.toBe('');
    expect(right).toContain(fingerprint);
  });

  // An event seen once has one line and one time, so the detail may not print that line twice under a
  // heading saying the two differ.
  it('draws one block for an event seen once', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Request 4000 failed');

    expect(pane().match(/<pre/g)).toHaveLength(1);
    expect(text(pane())).toContain('The line seen');
    expect(text(pane())).not.toContain('Newest line seen');
  });

  // Svelte escapes every expression in text position, so this passes as long as nobody reaches for
  // {@html} or puts a message into an attribute. A pasted log is text from a machine nobody vetted.
  it('draws a pasted script tag as characters', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, '<script>alert(1)</script> failed to load');

    const body = markup();

    // Svelte escapes the angle bracket that opens a tag, which is what stops one from being a tag.
    expect(body).not.toContain('<script');
    expect(body).toContain('&lt;script>alert(1)&lt;/script>');
  });
});

/**
 * Dismiss and Unmute, which is the whole of the Muted fold.
 *
 * The button posts to the route and the route calls `muteScoutFinding`, so the form is what these
 * tests hand over: a test that called the two core writers directly would pass with the id read off
 * the wrong field.
 */
describe('mute and memory', () => {
  it('takes a dismissed finding off the list and folds it under Muted with an Unmute button', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    const finding = scoutFindingsFor(db).rows[0];

    expect(muteScoutFinding(db, post(finding?.id ?? 0), true)).toMatchObject({ ok: true });

    const view = scoutFindingsFor(db);
    expect(view.rows).toEqual([]);
    expect(view.memory.map((row) => row.title)).toEqual(['Timeout after 5000ms calling /api/recipes']);
    // The fold, and not only the view model: the row says what was muted and how often it was seen,
    // and it carries the button that brings it back, which posts to the finding's own page.
    const body = markup();
    expect(body).toContain('Muted (1)');
    expect(body).toContain('Timeout after 5000ms calling /api/recipes');
    expect(text(body)).toContain('seen once');
    expect(body).toContain(`/scout/f/${view.memory[0]?.id}?/unmute#actions-title`);
    expect(text(body)).toContain('Unmute');
    // The field the route reads off the post. Without this line the input could be renamed and every
    // Unmute in the running app would post nothing, with the whole suite still green.
    expect(body).toContain(`name="id" value="${view.memory[0]?.id}"`);
    // The list says why it is empty, because every finding this machine has is muted.
    expect(shown()).toContain('What Scout found is muted');
  });

  // A muted finding met again is proved in the core tests. Here it is the two panels: the second check
  // does not put it back on the list, and it does not move up the Muted fold either.
  it('does not bring a dismissed finding back when a later check meets it again', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    const finding = scoutFindingsFor(db).rows[0];
    muteScoutFinding(db, post(finding?.id ?? 0), true);

    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes\nTimeout after 9000ms calling /api/recipes');

    const view = scoutFindingsFor(db);
    expect(view.rows).toEqual([]);
    // The same row but for the status word the mute wrote, and the pill that draws it: the count did
    // not grow and the last seen time did not move.
    // Start is gone with Assess: the writer refuses a muted finding, so neither button is offered.
    expect(view.memory).toEqual([{ ...finding, status: 'Muted', pill: { state: 'idle', word: 'Muted', detail: null }, canAssess: false, canStart: false }]);
  });

  it('brings it back at once, with the count and the first seen time it had', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Request 4000 failed');
    checkPasteSource(db, id, 'Request 2a3f failed');
    const finding = scoutFindingsFor(db).rows[0];
    muteScoutFinding(db, post(finding?.id ?? 0), true);

    expect(muteScoutFinding(db, post(finding?.id ?? 0), false)).toMatchObject({ ok: true });

    const view = scoutFindingsFor(db);
    expect(view.memory).toEqual([]);
    expect(view.rows).toEqual([finding]);
    expect(view.rows[0]?.seen).toContain('Seen 2 times');
    expect(view.rows[0]?.first).toBe(finding?.first);
  });

  // Nothing muted is the normal state, so the list draws no fold instead of an empty one.
  it('draws no Muted fold on a machine with no dismissed finding', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');

    expect(markup()).not.toContain('Muted (');
    // The right pane carries the button that fills the fold, with the id the route reads off the post.
    // Rename that field and every Dismiss in the running app posts nothing.
    expect(pane()).toContain('?/dismiss#actions-title');
    expect(pane()).toContain(`name="id" value="${scoutFindingsFor(db).rows[0]?.id}"`);
    expect(text(pane())).toContain('Dismiss');
  });

  // Nothing else on the screen prints what the two buttons answered, so a pane that dropped the line
  // would leave a person pressing Dismiss on a finding that is gone with no word at all.
  it('prints what Dismiss and Unmute answered under the buttons of the finding', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    const finding = scoutFindingsFor(db).rows[0]?.id ?? 0;

    expect(text(pane(finding, { said: muteScoutFinding(db, post(finding), true).message }))).toContain('A later check leaves it muted');
    expect(text(pane(finding, { problem: muteScoutFinding(db, post(404), true).message }))).toContain('There is no finding 404');
    expect(text(pane(finding, { said: muteScoutFinding(db, post(finding), false).message }))).toContain('back on the list');
    expect(text(pane(finding, { problem: muteScoutFinding(db, post(404), false).message }))).toContain('There is no finding 404');
  });

  // Both buttons answer a sentence rather than throwing, the way the source actions do. A button that
  // does nothing and says nothing is worse than a refusal.
  it('names the problem for a finding that is gone and for one that is not muted', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    const finding = scoutFindingsFor(db).rows[0];

    expect(muteScoutFinding(db, post(404), true)).toEqual({ ok: false, message: expect.stringContaining('404') });
    // A post with no id is a broken form, not finding 0, so it says to load the screen again rather
    // than printing a sentence with a blank where the number should be.
    expect(muteScoutFinding(db, post(''), true)).toEqual({ ok: false, message: expect.stringContaining('posted no finding id') });
    expect(muteScoutFinding(db, new FormData(), false)).toEqual({ ok: false, message: expect.stringContaining('posted no finding id') });
    expect(muteScoutFinding(db, post(finding?.id ?? 0), false)).toEqual({ ok: false, message: expect.stringContaining('not muted') });
    muteScoutFinding(db, post(finding?.id ?? 0), true);
    expect(muteScoutFinding(db, post(finding?.id ?? 0), true)).toEqual({ ok: false, message: expect.stringContaining('already') });
  });
});

// The Assess button is on a finding nobody has assessed yet, and the status word is on every row
// now that a second word is written.
describe('the assessment column', () => {
  it('offers Assess on a new finding and prints where the finding sits', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');

    expect(scoutFindingsFor(db).rows[0]?.canAssess).toBe(true);
    expect(pane()).toContain('?/assess#actions-title');
    expect(markup()).toMatch(/data-state="new"[^>]*>[\s\S]*?New/);
  });

  // A finding an assessment has started is not offered a second Assess: the run is going, and the
  // person reads what it wrote. A muted finding is offered none either.
  it('offers no Assess on a finding in assessment or a muted one', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    const finding = scoutFindingsFor(db).rows[0]?.id ?? 0;
    assessScoutFinding(db, finding);

    expect(scoutFindingsFor(db).rows[0]?.canAssess).toBe(false);
    expect(pane()).not.toContain('?/assess');

    muteScoutFinding(db, post(finding), true);
    expect(scoutFindingsFor(db).memory[0]?.canAssess).toBe(false);
    expect(scoutFindingsFor(db).memory[0]?.status).toBe('Muted');
  });
});

// The status pill of each row, in the words of the Scout design. The status word stays `assess` after
// the run ends, so Assessing is read off the run rows.
describe('the pill', () => {
  it('says Assessing while the assessment runs, and To decide once it ended', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    const finding = scoutFindingsFor(db).rows[0]?.id ?? 0;
    assessScoutFinding(db, finding);
    const run = startRun(db, { cardKey: assessKey(finding), phase: 'assess', engine: 'claude-code', model: null, effort: null, sessionId: null, logPath: 'runs/assess.log', lane: 'scout' });

    expect(scoutFindingsFor(db).rows[0]?.pill).toEqual({ state: 'running', word: 'Assessing', detail: null });
    expect(scoutFindingDetail(db, String(finding))).toMatchObject({ ok: true, detail: { row: { pill: { word: 'Assessing' } } } });

    db.prepare("UPDATE runs SET state = 'complete' WHERE id = ?").run(run);
    expect(scoutFindingsFor(db).rows[0]?.pill).toEqual({ state: 'ready', word: 'To decide', detail: null });
    expect(shown()).toContain('To decide');
  });
});

// The row is a link to the finding's own page, which is the inbox with that row selected. Both lists
// link: a muted finding keeps what a run wrote about it.
describe('the link to one finding', () => {
  it('links the row to its own page, and marks the row on show', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    const finding = scoutFindingsFor(db).rows[0]?.id ?? 0;

    const body = markup();

    expect(body).toMatch(new RegExp(`<a class="frow[^"]*" href="/scout/f/${finding}">`));
    // The link is named by what it holds, and the pasted line never goes into an attribute.
    expect(body).not.toMatch(/="[^"]*Timeout after/);
    const selected = render(ScoutFindings, { props: { view: scoutFindingsFor(db), href, selected: finding } }).body;
    expect(selected).toMatch(new RegExp(`<a class="frow[^"]*" href="/scout/f/${finding}" aria-current="true">`));
  });

  it('links a muted finding to its own page as well', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Out of disk space writing /var/log/recipes.log');
    const finding = scoutFindingsFor(db).rows[0]?.id ?? 0;
    muteScoutFinding(db, post(finding), true);

    expect(markup()).toMatch(new RegExp(`<a class="frow[^"]*" href="/scout/f/${finding}">`));
    // The fold opens while the muted finding is the one on show, so its row is in view.
    expect(markup()).not.toMatch(/<details[^>]*open/);
    expect(render(ScoutFindings, { props: { view: scoutFindingsFor(db), href, selected: finding } }).body).toMatch(/<details[^>]*open/);
  });
});

// What the screens do with a finding that becomes a card. What the writer may and may not do to
// a finding is proved in the core tests; here it is the answer a person reads and the row both Scout
// screens draw from.
describe('start as delivery', () => {
  // The loop hands its own connection and its change notice in. A stub, so no scheduler is built for a
  // write that starts no run.
  const live = () => {
    let told = 0;
    return { db, changed: () => { told += 1; }, told: () => told };
  };

  const oneFinding = (): number => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    return scoutFindingsFor(db).rows[0]?.id ?? 0;
  };

  it('names the card it made and says nothing is running', () => {
    const id = oneFinding();
    const told = live();

    const answer = answerStart(told, startPost(id));

    expect(answer).toEqual({ ok: true, message: expect.stringContaining('APP-1') });
    expect(answer.message).toContain('Nothing is running yet');
    expect(scoutFinding(db, id)?.cardKey).toBe('APP-1');
    // The open boards hear it, because a new card is a change no run announces.
    expect(told.told()).toBe(1);
  });

  it('hands the refusal of the writer on, and tells no board when nothing changed', () => {
    const id = oneFinding();
    const told = live();
    answerStart(told, startPost(id));

    const again = answerStart(told, startPost(id));

    expect(again).toEqual({ ok: false, message: expect.stringContaining('APP-1') });
    expect(told.told()).toBe(1);
  });

  // A form with no id posted is a screen that has to be loaded again, not finding 0.
  it('refuses a post with no finding id', () => {
    expect(answerStart(live(), startPost(''))).toEqual({ ok: false, message: expect.stringContaining('posted no finding id') });
    expect(answerStart(live(), startPost('wat'))).toMatchObject({ ok: false });
  });

  // The button where the writer takes it, and the card as a link once there is one.
  it('offers the button until the finding has a card, then links to the card', () => {
    const id = oneFinding();

    expect(scoutFindingsFor(db).rows[0]?.canStart).toBe(true);
    expect(pane()).toContain('?/start#actions-title');
    expect(text(pane())).toContain('Start as Delivery card');
    expect(text(pane())).toContain('Starting a card runs nothing. It lands in Inbox.');

    answerStart(live(), startPost(id));

    const row = scoutFindingsFor(db).rows[0];
    expect(row?.canStart).toBe(false);
    expect(row?.card).toEqual({ key: 'APP-1', here: true, board: 'Delivery', stage: 'Inbox' });
    expect(row?.status).toBe('Started');
    expect(row?.pill).toEqual({ state: 'idle', word: 'Started', detail: 'APP-1' });
    const body = pane();
    expect(body).not.toContain('Start as Delivery');
    expect(body).toContain('href="/t/APP-1"');
    // The board and the column the card sits in, which a started finding
    // says: without them a person cannot tell whether the work has moved without opening the card. The
    // row says it in place of how often the finding was seen.
    expect(text(body)).toContain('Started as card APP-1 in Inbox on the Delivery board.');
    expect(shown()).toContain('Pasted by hand · in Delivery, Inbox');
  });

  // A card somebody removed by hand. The row says so instead of linking to a page that answers
  // nothing, and the button comes back, because the finding is otherwise stuck on that key.
  it('says the card is gone when it is no longer on the board, and offers the start again', () => {
    const id = oneFinding();
    answerStart(live(), startPost(id));
    db.prepare('DELETE FROM cards WHERE key = ?').run('APP-1');

    const row = scoutFindingsFor(db).rows[0];

    expect(row?.card).toEqual({ key: 'APP-1', here: false, board: '', stage: '' });
    expect(row?.canStart).toBe(true);
    const body = pane();
    expect(body).not.toContain('href="/t/APP-1"');
    expect(text(body)).toContain('The card APP-1 it was started as is no longer on the board.');
    expect(text(body)).toContain('Start as Delivery');
    // The row goes back to how often it was seen, because there is no card to place.
    expect(shown()).not.toContain('in Delivery');
  });
});

// The same writer, with the board as its argument, so the two buttons are not two
// writes that can drift apart.
describe('start as investigation', () => {
  const live = () => ({ db, changed: () => {} });

  const oneFinding = (): number => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    return scoutFindingsFor(db).rows[0]?.id ?? 0;
  };

  it('puts the card on Research as an investigation and names it in the answer', () => {
    const id = oneFinding();

    const answer = answerStart(live(), startPost(id, 'investigations'));

    expect(answer).toEqual({ ok: true, message: expect.stringContaining('Finding 1 is on Research as INV-1.') });
    expect(scoutFindingsFor(db).rows[0]?.card).toEqual({ key: 'INV-1', here: true, board: 'Investigations', stage: 'Inbox' });
  });

  it('offers both buttons on a finding with no card', () => {
    oneFinding();

    const body = pane();

    expect(body).toContain('value="investigations"');
    expect(text(body)).toContain('Start as investigation');
  });

  // A board Scout may not start on would reach the card table as a column no screen draws.
  it('refuses a board it does not start on, and one that was not posted', () => {
    const id = oneFinding();

    expect(answerStart(live(), startPost(id, 'epics'))).toEqual({ ok: false, message: expect.stringContaining('no board to start on') });
    expect(answerStart(live(), post(id))).toEqual({ ok: false, message: expect.stringContaining('no board to start on') });
    expect(scoutFindingsFor(db).rows[0]?.card).toBe(null);
  });

  // The write takes the database lock, so another process holding it has to read as a sentence under
  // the buttons and not as a 500 page, the way the other three Scout writers answer.
  it('answers a write that throws with its sentence', () => {
    const broken = {
      db: {
        exec: () => {
          throw new Error('The database is busy.');
        },
        isTransaction: false,
      },
      changed: () => {},
    };

    expect(answerStart(broken as never, startPost(1))).toEqual({ ok: false, message: 'The database is busy.' });
  });
});

// A person starting a finding loses the assessment: assessScoutFinding moves a finding out of `new`
// alone. No button says so, so the sentence Start answers with does.
it('says the assessment is no longer offered once a finding is started', () => {
  const id = source('Pasted by hand');
  checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
  const one = scoutFindingsFor(db).rows[0]?.id ?? 0;

  const answer = answerStart({ db, changed: () => {} }, startPost(one));

  expect(answer.message).toContain('read-only assessment is not offered on this finding any more');
  expect(scoutFindingsFor(db).rows[0]?.canAssess).toBe(false);
});

// The second known limit of starting a finding, now closed. A finding muted after it was started
// named its card nowhere, so the card was only reachable from the finding's own page.
describe('the card of a muted finding', () => {
  const startedThenMuted = (): number => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    const finding = scoutFindingsFor(db).rows[0]?.id ?? 0;
    answerStart({ db, changed: () => {} }, startPost(finding));
    muteScoutFinding(db, post(finding), true);
    return finding;
  };

  it('links to the card, and names the board and the column it sits in', () => {
    const finding = startedThenMuted();

    expect(shown()).toContain('Pasted by hand · in Delivery, Inbox');
    expect(pane(finding)).toContain('href="/t/APP-1"');
    expect(text(pane(finding))).toContain('Started as card APP-1 in Inbox on the Delivery board.');
  });

  // Two started findings, so each one names and links its own card and not the first one made. Every
  // other test here has the one card APP-1.
  it('names and links each finding\'s own card when two are started', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    checkPasteSource(db, id, 'Disk full while writing /var/data');
    const [second, first] = scoutFindingsFor(db).rows.map((row) => row.id);
    answerStart({ db, changed: () => {} }, startPost(first ?? 0));
    answerStart({ db, changed: () => {} }, startPost(second ?? 0));

    const rows = scoutFindingsFor(db).rows;
    const one = rows.find((row) => row.id === first);
    const two = rows.find((row) => row.id === second);
    expect(one?.card?.key).toBe('APP-1');
    expect(two?.card?.key).toBe('APP-2');
    expect(two?.card).toMatchObject({ here: true, board: 'Delivery', stage: 'Inbox' });
    expect(two?.pill).toEqual({ state: 'idle', word: 'Started', detail: 'APP-2' });
    expect(pane(second)).toContain('href="/t/APP-2"');
    expect(pane(second)).not.toContain('href="/t/APP-1"');
    expect(text(pane(second))).toContain('Started as card APP-2 in Inbox on the Delivery board.');
  });

  // A card somebody removed by hand. The pane says so instead of linking to a page that answers
  // nothing, the same way it does for a finding on the list.
  it('says the card is gone rather than linking to it', () => {
    const finding = startedThenMuted();
    db.prepare('DELETE FROM cards WHERE key = ?').run('APP-1');

    expect(pane(finding)).not.toContain('href="/t/APP-1"');
    expect(text(pane(finding))).toContain('The card APP-1 it was started as is no longer on the board.');
    expect(shown()).not.toContain('in Delivery');
  });

  // A muted finding that was never started has no card, so neither pane names one.
  it('names no card on a finding that was never started', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Out of disk space writing /var/log/recipes.log');
    const finding = scoutFindingsFor(db).rows[0]?.id ?? 0;
    muteScoutFinding(db, post(finding), true);

    expect(text(pane(finding))).not.toContain('Started as card');
    expect(text(pane(finding))).not.toContain('no longer on the board');
    expect(shown()).not.toContain('in Delivery');
  });
});

// A finding a ticket query found is that ticket, so the card takes the ticket's key. Where the
// ticket is already on the board, the sentence may not claim a card was made.
describe('starting a finding that is a ticket', () => {
  const ticketFinding = (key: string, title: string): number => {
    const id = addScoutSource(db, { kind: 'tickets', label: 'The ticket query' });
    saveScoutFindings(db, id, dedup([{ sourceKind: 'tickets', errorType: '', message: title, location: key, sourceId: key }]));
    return scoutFindingsFor(db).rows[0]?.id ?? 0;
  };

  it('names the ticket key in the answer and on the row', () => {
    const id = ticketFinding('PROJ-123', 'Search by ingredient');

    const answer = answerStart({ db, changed: () => {} }, startPost(id));

    expect(answer).toEqual({ ok: true, message: expect.stringContaining('Delivery board as PROJ-123') });
    expect(scoutFindingsFor(db).rows[0]?.card).toEqual({ key: 'PROJ-123', here: true, board: 'Delivery', stage: 'Inbox' });
  });

  // The card was there before the button was pressed, so it names no board: it may sit on another
  // one than the button asked for, and nothing moved it.
  it('says no card was made when the ticket is already on the board', () => {
    const id = ticketFinding('PROJ-123', 'Search by ingredient');
    createCard(db, { key: 'PROJ-123', board: 'delivery', stage: 'plan', title: 'What a person called it', summary: null, source: 'external', sourceRef: 'PROJ-123' });

    const answer = answerStart({ db, changed: () => {} }, startPost(id, 'investigations'));

    expect(answer.ok).toBe(true);
    expect(answer.message).toContain('no second card was made');
    expect(answer.message).not.toContain('on Research as');
    expect(scoutFindingsFor(db).rows[0]?.card).toEqual({ key: 'PROJ-123', here: true, board: 'Delivery', stage: 'Plan' });
  });
});

/**
 * A finding whose ticket key cannot be a card key.
 *
 * A ticket key is copied out of somebody else's answer, so it can be anything that answer held. A
 * key carrying a line break breaks the card address and forges a line in every text that pastes a
 * key. The reason is on the row and worked out from the row, so it is there on every load. The
 * sentence under the button is gone as soon as the page is loaded again, and the finding would then
 * say nothing about why it has no card.
 */
describe('a finding whose ticket key cannot be a card key', () => {
  // A line break, not a slash: a slash is allowed on a card key, which `cardKeyProblem` explains.
  const BAD_KEY = 'APP-42\nAPP-43, Ship it';

  const ticketFinding = (key: string) => {
    const id = addScoutSource(db, { kind: 'tickets', label: 'The ticket query' });
    const one: ScoutItem = { sourceKind: 'tickets', errorType: '', message: 'Search by ingredient', location: key, sourceId: key };
    saveScoutFindings(db, id, dedup([one]));
  };

  it('offers no Start, and says why beside the buttons', () => {
    ticketFinding(BAD_KEY);

    const row = scoutFindingsFor(db).rows[0];

    expect(row?.cardProblem).toBe('A card key is one line of plain text, with no line break and no control character.');
    expect(row?.canStart).toBe(false);
    expect(text(pane())).toContain(
      'No card can be made from this finding. Its ticket key cannot be a card key. A card key is one line of plain text, with no line break and no control character.',
    );
    expect(pane()).not.toContain('Start as Delivery');
  });

  // Start cuts a key with a path to its last part and keeps the rest as the card's source ref, so the
  // row checks the whole of it, the way Start does.
  it('says why on the row when the line break is before the last slash', () => {
    ticketFinding('PROJ-1\nPROJ-2/app#1');

    const row = scoutFindingsFor(db).rows[0];

    expect(row?.cardProblem).toBe('A card key is one line of plain text, with no line break and no control character.');
    expect(row?.canStart).toBe(false);
  });

  // Only the last part names a folder, so the row checks that part, as Start does. A long group in
  // front of it refuses nothing, and a last part of `..` refuses the Start.
  it('agrees with Start on the part of a reference that becomes the card key', () => {
    ticketFinding(`${'g'.repeat(300)}/app#1`);
    const long = scoutFindingsFor(db).rows[0];

    expect(long).toMatchObject({ cardProblem: null, canStart: true });
    expect(answerStart({ db, changed: () => {} }, startPost(long?.id ?? 0))).toMatchObject({ ok: true });

    ticketFinding('acme/..');
    const dots = scoutFindingsFor(db).rows.find((row) => row.id !== long?.id);

    expect(dots).toMatchObject({ cardProblem: 'A card key cannot be . or .., because the key names the card folder.', canStart: false });
  });

  it('leaves a finding alone whose key a card can carry', () => {
    ticketFinding('PROJ-123');

    const row = scoutFindingsFor(db).rows[0];

    expect(row?.cardProblem).toBe(null);
    expect(row?.canStart).toBe(true);
    expect(text(pane())).not.toContain('cannot be a card key');
  });

  // What a person sees if they post the form anyway, from an open page or a second window.
  it('answers the button with the same reason', () => {
    ticketFinding(BAD_KEY);
    const id = scoutFindingsFor(db).rows[0]?.id ?? 0;

    const answer = answerStart({ db, changed: () => {} }, startPost(id));

    expect(answer).toEqual({
      ok: false,
      message: `Finding ${id} is a ticket whose key cannot be a card key, so no card was made. A card key is one line of plain text, with no line break and no control character.`,
    });
  });
});

/**
 * Rows a version before this check wrote.
 *
 * Such a version put a key with a line break on the board, so both states below exist on a real
 * database and neither can be reached any more by pressing a button. `createCard` refuses the key
 * now, so the card row is written here by hand, which is what that older version left behind.
 */
describe('a finding whose bad key is already on the board', () => {
  const OLD_CARD = 'APP-42\nAPP-43, Ship it';

  const startedOnOldCard = (): number => {
    const sourceId = addScoutSource(db, { kind: 'tickets', label: 'The ticket query' });
    const one: ScoutItem = { sourceKind: 'tickets', errorType: '', message: 'Search by ingredient', location: OLD_CARD, sourceId: OLD_CARD };
    saveScoutFindings(db, sourceId, dedup([one]));
    db.prepare('INSERT INTO cards (key, board, stage, title, summary, source, source_ref) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      OLD_CARD,
      'delivery',
      'inbox',
      'Search by ingredient',
      null,
      'external',
      OLD_CARD,
    );
    const id = scoutFindingsFor(db).rows[0]?.id ?? 0;
    db.prepare("UPDATE scout_findings SET card_key = ?, status = 'started' WHERE id = ?").run(OLD_CARD, id);
    return id;
  };

  // The card is on the board and the person is looking at it, so the row may not say there is none.
  it('says nothing about the key, and points at the card', () => {
    startedOnOldCard();

    const row = scoutFindingsFor(db).rows[0];

    expect(row?.cardProblem).toBe(null);
    expect(row?.card).toEqual({ key: OLD_CARD, here: true, board: 'Delivery', stage: 'Inbox' });
    expect(text(pane())).not.toContain('cannot be a card key');
  });

  // A second query with other terms finds the same issue, so a second finding carries the key and no
  // card of its own. It has to point at the card that is there rather than be refused for the key.
  it('points a second finding at the card instead of refusing it for the key', () => {
    startedOnOldCard();
    const other = addScoutSource(db, { kind: 'tickets', label: 'The other ticket query' });
    const one: ScoutItem = { sourceKind: 'tickets', errorType: '', message: 'Search by ingredient', location: OLD_CARD, sourceId: OLD_CARD };
    saveScoutFindings(db, other, dedup([one]));
    const second = scoutFindingsFor(db).rows.find((row) => row.card === null)?.id ?? 0;

    const answer = answerStart({ db, changed: () => {} }, startPost(second));

    expect(answer.ok).toBe(true);
    expect(answer.message).toContain('no second card was made');
    expect(scoutFinding(db, second)?.cardKey).toBe(OLD_CARD);
  });

  // The card was removed by hand, so Start is offered again. The key still cannot make one, so the
  // button would only fail and the row says why instead of drawing it.
  it('draws no Start once the card is removed by hand, and says why', () => {
    startedOnOldCard();
    db.prepare('DELETE FROM cards WHERE key = ?').run(OLD_CARD);

    const row = scoutFindingsFor(db).rows[0];

    expect(row?.cardProblem).toBe('A card key is one line of plain text, with no line break and no control character.');
    expect(row?.canStart).toBe(false);
    expect(pane()).not.toContain('Start as Delivery');
    expect(text(pane())).toContain('No card can be made from this finding.');
  });
});

// The empty line of the States design: no findings, and what Scout last did, so an empty list reads as
// checked and clean rather than as never looked at.
describe('noFindingsLine', () => {
  const now = new Date('2026-10-12T16:30:00Z');
  const at = (lastChecked: string | null) => ({ lastChecked });

  it('leaves the line to the screen when there is no source yet', () => {
    expect(noFindingsLine([], now, 'UTC')).toBeNull();
  });

  it('counts the sources checked and gives the time of the last check today', () => {
    expect(noFindingsLine([at('2026-10-12T13:10:00.000Z'), at('2026-10-12T14:00:00.000Z'), at('2026-10-12T09:00:00.000Z')], now, 'UTC')).toBe('No findings. Scout checked 3 sources at 14:00.');
  });

  it('gives the day of a last check before today, and counts only the sources it checked', () => {
    expect(noFindingsLine([at('2026-10-11T14:00:00.000Z'), at(null)], now, 'UTC')).toBe('No findings. Scout checked 1 source on 11 Oct at 14:00.');
  });

  it('says Scout has not checked yet when no source was checked', () => {
    expect(noFindingsLine([at(null)], now, 'UTC')).toBe('No findings. Scout has not checked its source yet. Press Check now on a source under Sources.');
    expect(noFindingsLine([at(null), at(null)], now, 'UTC')).toBe('No findings. Scout has not checked its 2 sources yet. Press Check now on a source under Sources.');
  });
});

describe('the screen with a source and no finding', () => {
  it('says no findings and what Scout checked, and not to add a source', () => {
    source('Recipe API logs');

    expect(shown()).toContain('No findings. Scout has not checked its source yet.');
    expect(shown()).not.toContain('Add a source');
  });
});

// How often and over how long a finding was seen, as the list row and Now's teaser print it after the
// source: "seen 12 times in 2 days".
describe('seenOften', () => {
  const now = new Date('2026-10-12T15:00:00.000Z');

  it('says once for a finding seen once', () => {
    expect(seenOften(1, '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z', now, 'UTC')).toBe('seen once');
  });

  it('says today when every time was today, and the day when every time was one earlier day', () => {
    expect(seenOften(3, '2026-10-12T09:00:00.000Z', '2026-10-12T12:15:00.000Z', now, 'UTC')).toBe('seen 3 times today');
    expect(seenOften(3, '2026-10-09T09:00:00.000Z', '2026-10-09T12:15:00.000Z', now, 'UTC')).toBe('seen 3 times on 9 Oct');
  });

  it('counts the days between the first time and the last', () => {
    expect(seenOften(12, '2026-10-10T16:40:00.000Z', '2026-10-12T13:02:00.000Z', now, 'UTC')).toBe('seen 12 times in 2 days');
    expect(seenOften(4, '2026-10-11T23:00:00.000Z', '2026-10-12T01:00:00.000Z', now, 'UTC')).toBe('seen 4 times in a day');
  });
});

// The seen marker: a finding first seen after the newest one the person saw on the Scout page is new,
// which is what the rail's dot and Now's count read.
describe('the seen marker', () => {
  const stamp = (id: number, at: string) => db.prepare('UPDATE scout_findings SET first_seen = ? WHERE id = ?').run(at, id);

  it('counts every finding as new before Scout is opened, and none after', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes\nOut of memory in the recipe worker');

    expect(scoutFindingsFor(db).fresh).toBe(2);
    expect(markScoutSeen(db)).toBe(true);
    expect(scoutFindingsFor(db).fresh).toBe(0);
    // A second visit with nothing newer writes nothing, so the page load does not wake every stream.
    expect(markScoutSeen(db)).toBe(false);
  });

  it('counts a finding first seen after the marker, and never a muted one', () => {
    const id = source('Pasted by hand');
    checkPasteSource(db, id, 'Timeout after 5000ms calling /api/recipes');
    const [old] = scoutFindingsFor(db).rows;
    stamp(old?.id ?? 0, '2026-10-12T09:00:00.000Z');
    markScoutSeen(db);

    checkPasteSource(db, id, 'Out of memory in the recipe worker\nDisk full writing /var/log/recipes.log');
    const fresh = scoutFindingsFor(db).rows.filter((row) => row.id !== old?.id);
    for (const row of fresh) stamp(row.id, '2026-10-12T10:00:00.000Z');
    muteScoutFinding(db, post(fresh[0]?.id ?? 0), true);

    expect(scoutFindingsFor(db).fresh).toBe(1);
    // A finding met again keeps its first seen time, so it is not new a second time.
    checkPasteSource(db, id, 'Timeout after 9000ms calling /api/recipes');
    expect(scoutFindingsFor(db).fresh).toBe(1);
  });
});
