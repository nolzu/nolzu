import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createCard, openDatabase, saveOutputCheck, saveRun, startRun, writeSetting } from '@nolzu/core/node';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { moveTo } from '../routes/api/board/writes.ts';
import { isGateAnswer } from './discussion.ts';
import { CHOICE_LIMIT, gateFor, settleQuestion, waitsOn } from './gate.ts';
import { createLoop, type Loop } from './loop.ts';
import { personsWords } from './persons-words.ts';

// The gate over a real database and card folder: the review block of the phase that ran last, the
// questions marked `blocks: yes`, the person's choice, and the forward move that waits on it.

const BRIEF = `# APP-1: Search the recipe list
Kind: feature
Branch: recipe-search

## Before you approve

- Concluded: a search box filters the list by title.
- Decide: Q1, should the search also match ingredients? Default: no, titles only.

## Open questions

- Q1: Should the search also match ingredients? Default: no, titles only. blocks: yes
- Q2: Should the box keep its text on reload? Default: no. blocks: no
- Q3: Which page shows it first? blocks: yes
`;

let dir = '';
let db: DatabaseSync;

const write = (key: string, path: string, text: string) => {
  mkdirSync(join(dir, '.tasks', key, path, '..'), { recursive: true });
  writeFileSync(join(dir, '.tasks', key, path), text);
};

const ran = (on: DatabaseSync, key: string, phase: string, state: 'complete' | 'running' = 'complete') => {
  const id = startRun(on, { cardKey: key, phase, engine: 'fake', model: 'haiku', effort: 'low', sessionId: null, logPath: '', lane: null });
  if (state === 'complete') {
    saveRun(on, id, { sessionId: null, model: 'haiku', costUsd: 0, durationMs: 1, tokens: null, question: null, failureReason: null, failureStatus: null, state, cardState: 'ready', retry: null });
  }
  return id;
};

const choose = (key: string, body: unknown) => settleQuestion(db, key, new Request('http://localhost/api', { method: 'POST', body: JSON.stringify(body) }), {});

describe('the gate of a card', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nolzu-gate-'));
    db = openDatabase(dir);
    writeSetting(db, 'projectPath', dir);
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'refine', title: 'Search' });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('reads the review block, the blocking questions with an id, and the stored check of the newest run', () => {
    const id = ran(db, 'APP-1', 'refine');
    write('APP-1', 'refine/refined.md', BRIEF);
    saveOutputCheck(db, id, { problems: [{ file: 'refine/refined.md', problem: 'The heading "## Scope" is missing.' }], note: null });

    expect(gateFor(db, 'APP-1', {})).toEqual({
      runId: id,
      phase: 'refine',
      file: 'refine/refined.md',
      lines: ['- Concluded: a search box filters the list by title.', '- Decide: Q1, should the search also match ingredients? Default: no, titles only.'],
      questions: [
        { id: 'Q1', question: 'Should the search also match ingredients?', answer: 'no, titles only', settled: null },
        { id: 'Q3', question: 'Which page shows it first?', answer: null, settled: null },
      ],
      check: { problems: [{ file: 'refine/refined.md', problem: 'The heading "## Scope" is missing.' }], note: null },
    });
  });

  it('gives nothing while the newest run goes, and no lines or questions for a missing or old file', () => {
    expect(gateFor(db, 'APP-1', {})).toBeNull();
    ran(db, 'APP-1', 'refine');
    expect(gateFor(db, 'APP-1', {})).toBeNull();
    write('APP-1', 'refine/refined.md', '# APP-1: Search\n\n## Open questions\n\n- Should it match tags? blocks: yes\n');
    expect(gateFor(db, 'APP-1', {})).toMatchObject({ file: 'refine/refined.md', lines: null, questions: [] });
    // Refine again, over the file the last run wrote.
    ran(db, 'APP-1', 'refine', 'running');
    expect(gateFor(db, 'APP-1', {})).toBeNull();
  });

  // A PR review has no review block file, so a clean check leaves nothing to draw.
  it('shows a phase with no review block only when its check found a problem', () => {
    const problem = { file: 'pr-review/summary.md', problem: 'There is no "Verdict:" line.' };
    saveOutputCheck(db, ran(db, 'APP-1', 'pr-review'), { problems: [], note: null });
    expect(gateFor(db, 'APP-1', {})).toBeNull();
    saveOutputCheck(db, ran(db, 'APP-1', 'pr-review'), { problems: [problem], note: null });
    expect(gateFor(db, 'APP-1', {})).toMatchObject({ phase: 'pr-review', file: null, lines: null, questions: [], check: { problems: [problem] } });
  });

  it('stores a choice as the person words on the phase thread, which settles the question and reaches the next prompt', async () => {
    const id = ran(db, 'APP-1', 'refine');
    write('APP-1', 'refine/refined.md', BRIEF);
    expect(waitsOn(db, 'APP-1', 'plan', {})).toBe('APP-1 waits on 2 open questions (Q1, Q3), which the next phase builds on. Open the card, take the default or answer each one, then move it again.');

    expect((await choose('APP-1', { id: 'Q1' })).status).toBe(200);
    expect(waitsOn(db, 'APP-1', 'plan', {})).toBe(
      'APP-1 waits on the open question Q3, "Which page shows it first?", which the next phase builds on. Open the card, take the default or answer it, then move it again.',
    );
    expect((await choose('APP-1', { id: 'Q3', answer: '  The list page.  ' })).status).toBe(200);
    expect(waitsOn(db, 'APP-1', 'plan', {})).toBeNull();

    expect(gateFor(db, 'APP-1', {})?.questions.map((one) => one.settled)).toEqual([
      'Q1: Should the search also match ingredients? I take the default: no, titles only.',
      'Q3: Which page shows it first? My answer: The list page.',
    ]);
    expect(db.prepare('SELECT thread, run_id AS runId FROM messages').all()).toEqual([{ thread: 'refine', runId: id }, { thread: 'refine', runId: id }]);
    // The Discussion reads this wording back to mark both as answers for the next phase.
    expect((db.prepare('SELECT body FROM messages').all() as { body: string }[]).every((one) => isGateAnswer(one.body))).toBe(true);
    expect(personsWords(db, 'APP-1', []).messages.map((one) => one.text)).toEqual([
      'Q1: Should the search also match ingredients? I take the default: no, titles only.',
      'Q3: Which page shows it first? My answer: The list page.',
    ]);
  });

  it('asks again after the phase ran again, because the new file is a new question', async () => {
    ran(db, 'APP-1', 'refine');
    write('APP-1', 'refine/refined.md', BRIEF.replace('blocks: yes\n- Q2', 'blocks: no\n- Q2'));
    await choose('APP-1', { id: 'Q3', answer: 'The list page.' });
    expect(waitsOn(db, 'APP-1', 'plan', {})).toBeNull();
    ran(db, 'APP-1', 'refine');
    expect(waitsOn(db, 'APP-1', 'plan', {})).toContain('Q3');
    // Refine again is how the person disagrees with the brief, so it does not wait.
    expect(waitsOn(db, 'APP-1', 'refine', {})).toBeNull();
  });

  it('refuses a choice it cannot store', async () => {
    ran(db, 'APP-1', 'refine');
    write('APP-1', 'refine/refined.md', BRIEF);
    const said = async (body: unknown) => {
      const answer = await choose('APP-1', body);
      return [answer.status, ((await answer.json()) as { message: string }).message];
    };
    expect(await said({})).toEqual([400, 'A choice needs the id of the question, and an answer when it does not take the default.']);
    expect(await said({ id: 'Q2' })).toEqual([404, 'APP-1 has no open question Q2 that waits on a choice.']);
    expect(await said({ id: 'Q1', answer: '   ' })).toEqual([400, 'Write the answer to Q1, or take the default.']);
    expect(await said({ id: 'Q1', answer: 'x'.repeat(CHOICE_LIMIT + 1) })).toEqual([400, `The answer is over ${CHOICE_LIMIT} characters. Put the long part in the Discussion.`]);
    expect(await said({ id: 'Q3' })).toEqual([400, 'Q3 names no default, so write an answer.']);
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('counts a Discussion message that starts with the id', () => {
    const id = ran(db, 'APP-1', 'refine');
    write('APP-1', 'refine/refined.md', BRIEF);
    const say = db.prepare("INSERT INTO messages (card_key, thread, author, body, at, run_id) VALUES ('APP-1', 'refine', 'person', ?, '2026-10-25T10:00:00.000Z', ?)");
    // A message that only names the id further in is no choice.
    say.run('Not sure about Q1: or Q3: yet.', id);
    expect(gateFor(db, 'APP-1', {})?.questions.map((one) => one.settled)).toEqual([null, null]);
    say.run('q1: titles and ingredients', id);
    expect(gateFor(db, 'APP-1', {})?.questions[0]?.settled).toBe('q1: titles and ingredients');
  });
});

describe('a forward move past a blocking question', () => {
  let live: Loop;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nolzu-gate-move-'));
    live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0' });
    db = live.db;
    writeSetting(db, 'projectPath', dir);
    createCard(db, { key: 'APP-1', board: 'delivery', stage: 'refine', title: 'Search' });
    db.prepare("UPDATE cards SET state = 'ready' WHERE key = 'APP-1'").run();
    ran(db, 'APP-1', 'refine');
    write('APP-1', 'refine/refined.md', BRIEF.replace('Which page shows it first? blocks: yes', 'Which page shows it first? Default: the list. blocks: no'));
  });

  afterEach(() => {
    live.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const stage = () => (db.prepare("SELECT stage FROM cards WHERE key = 'APP-1'").get() as { stage: string }).stage;

  it('is refused for every mover until the person chose, and a move that starts nothing passes', async () => {
    for (const who of ['you', 'auto'] as const) {
      expect(await moveTo(live, 'APP-1', 'plan', who)).toEqual({ status: 409, message: expect.stringContaining('APP-1 waits on the open question Q1') });
    }
    expect(stage()).toBe('refine');
    expect(await moveTo(live, 'APP-1', 'inbox')).toBeNull();
    db.prepare("UPDATE cards SET stage = 'refine' WHERE key = 'APP-1'").run();

    expect((await choose('APP-1', { id: 'Q1' })).status).toBe(200);
    expect(await moveTo(live, 'APP-1', 'plan')).toBeNull();
    expect(stage()).toBe('plan');
  });
});
