import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { addScoutSource, assessScoutFinding, checkPasteSource, dismissScoutFinding, openDatabase, startRun, startScoutFinding, unmuteScoutFinding, writeSetting } from '@nolzu/core/node';
import { assessKey } from '@nolzu/protocol';
import { render } from 'svelte/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ScoutFindingDetail from './ScoutFindingDetail.svelte';
import { ASSESSMENT_HEADINGS } from './scout-assess.ts';
import { scoutFindingDetail } from './scout-detail.ts';
import { scoutFindingsFor } from './scout-findings.ts';

// One finding's own page. The assessment is a file in the run's own folder, so this test needs
// a project folder as well as a database.
let dir = '';
let project = '';
let db: DatabaseSync;

const LINE = 'Timeout after 5000ms calling /api/recipes';

// One finding, the way a check leaves it, and its id.
function addFinding(text = LINE): number {
  const source = addScoutSource(db, { kind: 'paste', label: 'Pasted by hand' });
  checkPasteSource(db, source, text);
  return scoutFindingsFor(db).rows[0]?.id ?? 0;
}

// The run row loop.assess writes before it starts the job. `ended` is what a run that is over looks
// like, which is the only thing this page asks of the row.
function assessRun(id: number, ended: boolean): void {
  const run = startRun(db, { cardKey: assessKey(id), phase: 'assess', engine: 'fake', model: null, effort: null, sessionId: null, logPath: 'runs/assess.log', lane: 'scout' });
  if (ended) db.prepare("UPDATE runs SET state = 'complete' WHERE id = ?").run(run);
}

// The assessment as the run wrote it, in the folder the run's key names.
function writeAssessment(id: number, text: string): void {
  const folder = join(project, '.tasks', assessKey(id), 'assess');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'assessment.md'), text);
}

const WHOLE = `## The evidence
src/recipes/list.ts:31, the call with no timeout

## The likely cause
The fetch has no timeout, so a slow reply holds the request open.

## The proposal
Pass a timeout to the fetch in src/recipes/list.ts.

## The effort
Hours.

## The risks
None found.
`;

// The address of the card a started finding is on, which the route builds with resolve() and hands in.
const cardHref = (key: string) => `/t/${key}`;

// The view, drawn. The page around it is on the route, which is the only place resolve() works.
const markup = (id: number, answer: { said?: string; problem?: string } = {}) => {
  const found = scoutFindingDetail(db, String(id));
  expect(found.ok).toBe(true);
  if (!found.ok) throw new Error(found.message);
  return render(ScoutFindingDetail, { props: { detail: found.detail, cardHref, ...answer } }).body;
};
const text = (body: string) =>
  body
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-detail-'));
  project = join(dir, 'project');
  db = openDatabase(join(dir, 'data'));
  writeSetting(db, 'projectPath', project);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('the address', () => {
  // An empty page at an address a person typed reads as a page that broke, so both misses answer the
  // same 404 and name what was asked for.
  it('answers 404 for a word and for a number no finding has', () => {
    addFinding();

    expect(scoutFindingDetail(db, 'wat')).toEqual({ ok: false, status: 404, message: expect.stringContaining('"wat"') });
    expect(scoutFindingDetail(db, '404')).toEqual({ ok: false, status: 404, message: expect.stringContaining('no finding 404 here') });
    // A blank is a broken address and not finding 0, which is what Number() would look up.
    expect(scoutFindingDetail(db, '')).toMatchObject({ ok: false, status: 404 });
    expect(scoutFindingDetail(db, undefined)).toMatchObject({ ok: false, status: 404 });
  });

  // The digits of an id and nothing else. `1e0` and `+1` and `1.0` are all 1 to Number(), so without
  // the guard those three addresses would quietly open finding 1 and say they were asked for it.
  it('answers 404 for an address Number() would turn into an id that is there', () => {
    const id = addFinding();

    expect(id).toBe(1);
    // A leading zero is all digits, so it passes a digits-only guard and Number() folds it to 1.
    // Without the guard one finding would have as many addresses as a person cares to type.
    for (const asked of ['1e0', '+1', '1.0', '0x1', '01', '0000001']) {
      expect(scoutFindingDetail(db, asked)).toMatchObject({ ok: false, status: 404 });
    }
  });

  it('reads the finding the id names, with the words the list uses', () => {
    const id = addFinding();

    const found = scoutFindingDetail(db, String(id));

    expect(found.ok).toBe(true);
    if (!found.ok) return;
    // The same row the list draws, so the two screens cannot print two status words for one finding.
    expect(found.detail.row).toEqual(scoutFindingsFor(db).rows[0]);
    expect(found.detail.row.status).toBe('New');
    expect(found.detail.row.source).toBe('Pasted by hand');
  });
});

describe('the assessment', () => {
  it('says in one line that nobody has assessed the finding', () => {
    const id = addFinding();

    const found = scoutFindingDetail(db, String(id));

    expect(found.ok && found.detail.assessment).toBeNull();
    expect(found.ok && found.detail.note).toEqual({ text: 'No assessment has been written for this finding.', refused: false });
    expect(text(markup(id))).toContain('No assessment has been written');
    // A state is not a problem. With the bar and the role on it a screen reader would read a finding
    // nobody has looked at as something that went wrong.
    expect(markup(id)).not.toContain('role="alert"');
  });

  // The run has started and written nothing yet, which is not the same as nobody having asked.
  it('says an assessment was started when a run of it is going with no file', () => {
    const id = addFinding();
    assessScoutFinding(db, id);
    assessRun(id, false);

    expect(text(markup(id))).toContain('An assessment of this finding was started');
  });

  // Dismiss writes its word over any column, so the status alone cannot say whether a run began.
  // Two clicks from the list reach this, and the old read promised a file nobody had asked for.
  it('says nobody assessed a finding that was muted straight from New', () => {
    const id = addFinding();
    dismissScoutFinding(db, id);

    const found = scoutFindingDetail(db, String(id));

    expect(found.ok && found.detail.note).toEqual({ text: 'No assessment has been written for this finding.', refused: false });
  });

  // Unmute writes `new` back, so the word loses the run as well. The row is still there and the page
  // reads it, rather than telling a person their assessment never happened.
  it('still says a run began after the finding was muted and brought back', () => {
    const id = addFinding();
    assessScoutFinding(db, id);
    assessRun(id, true);
    dismissScoutFinding(db, id);
    unmuteScoutFinding(db, id);

    expect(text(markup(id))).toContain('was started and ended without writing anything');
  });

  it('reads the five parts back out of the file the run wrote', () => {
    const id = addFinding();
    writeAssessment(id, WHOLE);

    const found = scoutFindingDetail(db, String(id));

    expect(found.ok && found.detail.note).toBeNull();
    expect(found.ok && found.detail.assessment?.cause).toContain('no timeout');
    expect(found.ok && found.detail.assessment?.effort).toBe('Hours.');
    // Each part under the heading the skill wrote it with, read off the reader's own list so a
    // renamed heading fails here as well as there.
    const shown = text(markup(id));
    for (const heading of ASSESSMENT_HEADINGS) expect(shown).toContain(heading);
    expect(shown).toContain('src/recipes/list.ts:31');
    expect(shown).toContain('None found.');
  });

  // The assessment names the read-only run that wrote it, above the parts.
  // A cost the engine never reported is left out, never shown as $0.00.
  it('names the run that wrote it: engine, model, time, and the cost only when reported', () => {
    const id = addFinding();
    writeAssessment(id, WHOLE);
    const run = startRun(db, { cardKey: assessKey(id), phase: 'assess', engine: 'claude-code', model: 'haiku', effort: null, sessionId: null, logPath: 'runs/assess.log', lane: 'scout' });
    db.prepare("UPDATE runs SET state = 'complete', duration_ms = 41000, cost_estimate = 0.02 WHERE id = ?").run(run);

    expect(scoutFindingDetail(db, String(id))).toMatchObject({ ok: true, detail: { run: 'read-only run, Claude Code · haiku · 41s · $0.02' } });
    expect(text(markup(id))).toContain('read-only run, Claude Code · haiku · 41s · $0.02');

    db.prepare('UPDATE runs SET cost_estimate = NULL WHERE id = ?').run(run);
    expect(scoutFindingDetail(db, String(id))).toMatchObject({ ok: true, detail: { run: 'read-only run, Claude Code · haiku · 41s' } });
  });

  it('names no run on a finding nobody assessed', () => {
    expect(scoutFindingDetail(db, String(addFinding()))).toMatchObject({ ok: true, detail: { run: null } });
  });

  // The reader refuses half an assessment whole, and its sentence names the section that is missing.
  // An empty screen there would leave a person deciding on four parts out of five.
  it('shows the reader sentence for an assessment with a section missing', () => {
    const id = addFinding();
    writeAssessment(id, WHOLE.replace('## The risks\nNone found.\n', ''));

    const found = scoutFindingDetail(db, String(id));

    expect(found.ok && found.detail.assessment).toBeNull();
    expect(found.ok && found.detail.note?.refused).toBe(true);
    expect(found.ok && found.detail.note?.text).toContain('The risks');
    // A refusal is marked with a bar and with a role, not with colour alone.
    expect(markup(id)).toContain('role="alert"');
  });

  // A run writes what it likes into its folder. A folder named like the file is not a finding nobody
  // assessed, so it may not read as one.
  it('shows the reader sentence for a file that cannot be read', () => {
    const id = addFinding();
    mkdirSync(join(project, '.tasks', assessKey(id), 'assess', 'assessment.md'), { recursive: true });

    const found = scoutFindingDetail(db, String(id));

    expect(found.ok && found.detail.note).toEqual({ text: expect.stringContaining('is a folder, not a file'), refused: true });
  });

  // A second run writes over the same file. Until it does, the file on disk is the round before it,
  // and with no line above it the page would draw the old answer as the new run's.
  it('marks the parts as the round before while a second run is going', () => {
    const id = addFinding();
    writeAssessment(id, WHOLE);
    assessRun(id, true);
    assessRun(id, false);

    const shown = text(markup(id));

    expect(shown).toContain('What is below is the round before it');
    // Still drawn, because they are the newest answer there is.
    expect(shown).toContain('None found.');
  });

  // An assessment is a file a run wrote, so it is drawn as text. Svelte escapes every expression in
  // text position, which holds as long as nobody reaches for {@html}.
  it('draws a script tag in an assessment as characters', () => {
    const id = addFinding();
    writeAssessment(id, WHOLE.replace('Hours.', '<script>alert(1)</script>'));

    const body = markup(id);

    expect(body).not.toContain('<script');
    expect(body).toContain('&lt;script>alert(1)&lt;/script>');
  });
});

describe('what the screen offers', () => {
  it('offers Assess and Dismiss on a new finding, and no Unmute', () => {
    const id = addFinding();

    const body = markup(id);

    expect(body).toContain('?/assess#actions-title');
    expect(body).toContain('?/dismiss#actions-title');
    expect(body).not.toContain('?/unmute');
    // The field all four writers read. Rename it and every button here posts nothing.
    expect(body).toContain(`name="id" value="${id}"`);
    // Assess starts a run, so it is the one amber go button. The two starts make a card and run nothing.
    expect(body).toMatch(/\?\/assess#actions-title"[\s\S]*?<button[^>]*class="btn go\b/);
    expect(body.match(/class="btn go\b/g)).toHaveLength(1);
  });

  // The status writer only moves a finding out of New, so a second Assess could answer nothing but a
  // refusal.
  it('offers no Assess once an assessment has started', () => {
    const id = addFinding();
    assessScoutFinding(db, id);

    expect(markup(id)).not.toContain('?/assess');
    expect(markup(id)).toContain('?/dismiss#actions-title');
  });

  // A muted finding can be brought back and cannot be muted twice, which is what the two writers do.
  it('offers Unmute and no Dismiss on a muted finding', () => {
    const id = addFinding();
    dismissScoutFinding(db, id);

    const found = scoutFindingDetail(db, String(id));

    expect(found.ok && found.detail.canUnmute).toBe(true);
    expect(found.ok && found.detail.canDismiss).toBe(false);
    const body = markup(id);
    expect(body).toContain('?/unmute#actions-title');
    expect(body).not.toContain('?/dismiss');
    expect(text(body)).toContain('Muted');
  });

  // Nothing else on the page prints what a button answered, so a screen that dropped the line would
  // leave a person pressing Dismiss on a finding that is gone with no word at all.
  it('prints what a button answered under the buttons', () => {
    const id = addFinding();

    expect(text(markup(id, { said: 'That finding is muted.' }))).toContain('That finding is muted.');
    expect(text(markup(id, { problem: 'There is no finding 404 on this machine.' }))).toContain('There is no finding 404');
  });
});

// The evidence the store holds, on the page rather than behind a click: the page is about one
// finding, so there is nothing to fold away.
describe('the evidence', () => {
  it('shows both collected lines, the times, the place and the fingerprint', () => {
    const source = addScoutSource(db, { kind: 'paste', label: 'Pasted by hand' });
    checkPasteSource(db, source, 'Request 4000 failed');
    checkPasteSource(db, source, 'Request 2a3f failed');
    const row = scoutFindingsFor(db).rows[0];

    const shown = text(markup(row?.id ?? 0));

    expect(shown).toContain('Request 4000 failed');
    expect(shown).toContain('Request 2a3f failed');
    expect(shown).toContain('First line seen');
    expect(shown).toContain('Newest line seen');
    expect(shown).toContain('Seen 2 times');
    expect(shown).toContain('Found by Pasted by hand.');
    expect(shown).toContain(row?.fingerprint ?? 'no fingerprint');
  });

  // Pasted text names no place, so the line comes from a source that does. The page has to say it:
  // it is the one thing on the row that points at the code.
  it('names where it happens when the source gave a place', () => {
    const id = addFinding();
    db.prepare('UPDATE scout_findings SET location = ? WHERE id = ?').run('src/recipes/rating.ts', id);

    expect(text(markup(id))).toContain('Where it happens: src/recipes/rating.ts');
  });

  // An event seen once has one line and one time, so the page may not print it twice under a heading
  // saying the two differ.
  it('draws one block for an event seen once', () => {
    const id = addFinding();

    const shown = text(markup(id));

    expect(shown).toContain('The line seen');
    expect(shown).not.toContain('Newest line seen');
  });
});

// The card a finding was started as, on the finding's own page. What the writer may do is proved
// in the core tests; here it is the button and the link a person sees.
describe('the card it was started as', () => {
  it('offers Start as Delivery on a finding with no card', () => {
    const id = addFinding();

    const body = markup(id);

    expect(body).toContain('?/start#actions-title');
    expect(text(body)).toContain('Start as Delivery');
  });

  it('names the card as a link once the finding has one, and offers no second start', () => {
    const id = addFinding();
    const start = startScoutFinding(db, id);

    const body = markup(id);

    expect(start.ok).toBe(true);
    expect(body).not.toContain('?/start');
    expect(body).toContain(`href="/t/${start.ok ? start.key : ''}"`);
    expect(text(body)).toContain('Started as card APP-1 in Inbox on the Delivery board.');
    // The column the writer wrote, in the words the list uses.
    expect(text(body)).toContain('Started');
  });

  // A card somebody removed by hand. The page says so rather than linking to a page that answers
  // nothing, and Start comes back, because the finding is otherwise stuck on that key.
  it('says the card is gone when it left the board, and offers the start again', () => {
    const id = addFinding();
    startScoutFinding(db, id);
    db.prepare('DELETE FROM cards WHERE key = ?').run('APP-1');

    const body = markup(id);

    expect(body).not.toContain('href="/t/APP-1"');
    expect(text(body)).toContain('The card APP-1 it was started as is no longer on the board.');
    expect(body).toContain('?/start#actions-title');
  });

  // A muted finding starts nothing: the writer refuses it, so the button may not be there to answer a
  // refusal.
  it('offers no start on a muted finding', () => {
    const id = addFinding();
    dismissScoutFinding(db, id);

    expect(markup(id)).not.toContain('?/start');
  });
});
