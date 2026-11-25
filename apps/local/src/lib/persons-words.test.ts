import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSetting } from '@nolzu/core/node';
import { GUARD_PATH } from '@nolzu/runner';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { addMessage } from './discussion.ts';
import { createLoop, type Loop } from './loop.ts';
import { cardHistory, personsWords } from './persons-words.ts';

// A fresh run of a later phase is told what the person said on the card, which was typed to one
// run and is otherwise only in the database.
let dir = '';
let project = '';
let live: Loop;

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

const run = (phase: string, question: string | null): number =>
  Number(live.db.prepare("INSERT INTO runs (card_key, phase, engine, state, question) VALUES ('APP-2', ?, 'fake', 'complete', ?)").run(phase, question).lastInsertRowid);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-persons-words-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-project-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project, env: GIT_ENV });
  live = createLoop(dir, { ...process.env, NOLZU_FAKE_AGENT: '1', NOLZU_FAKE_DELAY_SCALE: '0', ...GIT_ENV });
  writeSetting(live.db, 'projectPath', project);
  mkdirSync(join(project, '.claude', 'hooks'), { recursive: true });
  writeFileSync(join(project, GUARD_PATH), '// the guard the wizard writes.\n');
  live.db.prepare("INSERT INTO cards (key, board, stage, title) VALUES ('APP-2', 'delivery', 'implement', 'Search recipes')").run();
});

afterEach(() => {
  live.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

it('tells an answer from a Discussion message, and leaves out the agent', () => {
  const refine = run('refine', 'Does search cover the ingredients?');
  addMessage(live.db, 'APP-2', 'refine', 'agent', 'Does search cover the ingredients?', refine);
  addMessage(live.db, 'APP-2', 'refine', 'person', 'Yes, titles and ingredients.', refine);
  addMessage(live.db, 'APP-2', 'refine', 'person', 'And keep the old search page.', refine);
  const plan = run('plan', null);
  addMessage(live.db, 'APP-2', 'plan', 'agent', 'The plan has four steps.', plan);
  addMessage(live.db, 'APP-2', 'plan', 'person', 'Make step 2 smaller.', plan);
  // A run's own summary is no question, so the person's message after it is no answer.
  const qa = run('qa', 'Which port?');
  addMessage(live.db, 'APP-2', 'qa', 'agent', 'QA stopped before the checks.', qa);
  addMessage(live.db, 'APP-2', 'qa', 'person', 'Use port 4000.', qa);
  addMessage(live.db, 'APP-2', 'ask-2', 'person', 'Why two search boxes?', null);
  // Discuss on a pull request comment opens with the reviewer's words, so that thread stays out.
  addMessage(live.db, 'APP-2', 'T3', 'person', 'dana on src/search.ts:4: The search misses capitals.', null);
  live.db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, reason) VALUES ('APP-2', 'qa', 'wrapup', 'you', 'The flaky test fails on main too.')").run();
  live.db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who, reason) VALUES ('APP-2', 'wrapup', 'implement', 'you', 'Keep the old helper.')").run();
  live.db.prepare("INSERT INTO card_events (card_key, from_stage, to_stage, who) VALUES ('APP-2', 'plan', 'implement', 'you')").run();

  expect(personsWords(live.db, 'APP-2', live.boardOf('APP-2').stages)).toEqual({
    questions: [
      { phase: 'refine', question: 'Does search cover the ingredients?', answer: 'Yes, titles and ingredients.' },
      { phase: 'qa', question: 'Which port?', answer: null },
    ],
    moves: [
      { from: 'QA', to: 'Wrap-up', back: false, reason: 'The flaky test fails on main too.' },
      { from: 'Wrap-up', to: 'Implement', back: true, reason: 'Keep the old helper.' },
    ],
    messages: [
      { thread: 'refine', text: 'And keep the old search page.' },
      { thread: 'plan', text: 'Make step 2 smaller.' },
      { thread: 'qa', text: 'Use port 4000.' },
      { thread: 'ask', text: 'Why two search boxes?' },
    ],
  });
});

it("puts the person's words, the first QA answer and the allowed commands in a shell run's prompt", () => {
  const refine = run('refine', 'Does search cover the ingredients?');
  addMessage(live.db, 'APP-2', 'refine', 'agent', 'Does search cover the ingredients?', refine);
  addMessage(live.db, 'APP-2', 'refine', 'person', 'Yes, titles and ingredients.', refine);
  writeSetting(live.db, 'qaApp', { '.': { mode: 'dev', command: 'npm run dev', repo: '.' } });
  writeSetting(live.db, 'allowedCommands', ['npm test']);

  const implement = live.buildJob('APP-2', 'implement', 99).prompt;
  expect(implement).toContain('- Refine asked: Does search cover the ingredients?\n  Answer: Yes, titles and ingredients.');
  expect(implement).toContain('Nolzu starts it with `npm run dev`.');
  expect(implement).toContain('- `npm test`');

  // Refine has no shell, so it gets the words and no command list.
  const again = live.buildJob('APP-2', 'refine', 98).prompt;
  expect(again).toContain('Answer: Yes, titles and ingredients.');
  expect(again).not.toContain('npm');
});

it("gives the wrap-up the card's runs and the QA verdicts that did not pass, and no other phase", () => {
  run('refine', null);
  run('implement', null);
  const failed = run('qa', null);
  live.db.prepare("UPDATE runs SET verdict = 'FAIL', verdict_reason = 'AC2 fails.' WHERE id = ?").run(failed);
  run('implement', null);
  const passed = run('qa', null);
  live.db.prepare("UPDATE runs SET verdict = 'PASS', verdict_reason = 'Every must check passed.' WHERE id = ?").run(passed);
  run('ask', null);
  run('extract-summary', null);
  const wrapup = run('wrapup', null);

  expect(cardHistory(live.db, 'APP-2', wrapup)).toEqual({
    runs: [
      { phase: 'refine', count: 1 },
      { phase: 'implement', count: 2 },
      { phase: 'qa', count: 2 },
    ],
    verdicts: [{ verdict: 'FAIL', reason: 'AC2 fails.' }],
  });
  expect(live.buildJob('APP-2', 'wrapup', wrapup).prompt).toContain('How often each phase ran: Refine 1, Implement 2, QA 2.');
  expect(live.buildJob('APP-2', 'implement', wrapup).prompt).not.toContain('## What this card went through');
});
