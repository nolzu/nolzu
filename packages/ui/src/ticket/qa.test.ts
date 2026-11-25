import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAKEN_DOWN } from '@nolzu/protocol';
import { checkCount, checkOfShot, checkWord, NOT_REPORTED, parseQaChecklist, QA_RESULTS, type QaInput, qaView, type StackAction } from './qa.ts';

const input = (over: Partial<QaInput> = {}): QaInput => ({
  cardKey: 'APP-1',
  run: null,
  stack: null,
  hasLoad: true,
  hasUnload: true,
  hasStatus: true,
  status: null,
  statusProblem: null,
  stackLane: null,
  report: null,
  screenshots: [],
  hasBrowser: false,
  ...over,
});

const printed = (output: string, over: Partial<QaInput['status'] & object> = {}) => ({
  command: 'compose ps',
  code: 0,
  output,
  timedOut: false,
  ...over,
});

const refusal = (view: ReturnType<typeof qaView>, action: StackAction): string | null => {
  const button = view.stack.buttons.find((one) => one.action === action);
  if (button === undefined) throw new Error(`there is no ${action} button`);
  return button.refused;
};

describe('the stack panel', () => {
  it('says off, and where own commands are set, for a card with none', () => {
    const view = qaView(input({ hasLoad: false, hasUnload: false, hasStatus: false }));

    expect(view.stack.state).toBe('off');
    expect(view.stack.reason).toBe('No repository of this card has its own start commands. Add them in the QA question, or under Start the app in Settings, Project.');
    expect(refusal(view, 'load')).toBe('No repository of this card has its own start commands.');
  });

  it('shows the state the last stack command left, with its sentence', () => {
    const view = qaView(input({ stack: { state: 'failed', reason: 'The stack load command exited 3. no compose file' } }));

    expect(view.stack.state).toBe('failed');
    expect(view.stack.reason).toBe('The stack load command exited 3. no compose file');
  });

  // The panel shows the words the project printed. Nolzu never knows what the stack is, so reading
  // them would be guessing.
  it('shows the status output word for word, and parses none of it', () => {
    const output = 'NAME      STATE\napi       running\ndb        exited (1)\n';
    const view = qaView(input({ status: printed(output) }));

    expect(view.stack.status).toBe(output.trim());
    expect(view.stack.statusNote).toBeNull();
    expect(view.stack.command).toBe('compose ps');
  });

  it('says not reported for a project that writes no status command', () => {
    const view = qaView(input({ hasStatus: false }));

    expect(view.stack.status).toBeNull();
    expect(view.stack.statusNote).toBe(`${NOT_REPORTED}. None of this card's own commands has a Status command.`);
    expect(view.stack.said?.text).toBe("Not reported. None of this card's own commands has a Status command.");
  });

  it('says not reported, as a sentence, before the status command has run', () => {
    expect(qaView(input({ status: null })).stack.said?.text).toBe('Not reported. The status command has not run yet.');
  });

  // The command runs while the page draws, so "has not run yet" would be wrong then.
  it('says no status sentence while the status command runs, and marks it pending', () => {
    const view = qaView(input({ status: null, statusPending: true }));

    expect(view.stack.pending).toBe(true);
    expect(view.stack.statusNote).toBeNull();
    expect(view.stack.said).toBeNull();
    expect(qaView(input({ status: null })).stack.pending).toBe(false);
    expect(qaView(input({ hasStatus: false, statusPending: true })).stack.pending).toBe(false);
  });

  it('keeps the output of a status command that failed, and says it failed', () => {
    const view = qaView(input({ status: printed('no such compose file\n', { code: 2 }) }));

    expect(view.stack.status).toBe('no such compose file');
    expect(view.stack.statusNote).toBe('The status command exited 2.');
  });

  it('says the status command was stopped when it ran past its timeout', () => {
    const view = qaView(input({ status: printed('', { timedOut: true }) }));

    expect(view.stack.statusNote).toContain('still running after the timeout');
  });

  it('says a status command that printed nothing printed nothing', () => {
    const view = qaView(input({ status: printed('   \n') }));

    expect(view.stack.status).toBeNull();
    expect(view.stack.statusNote).toBe('The status command printed nothing.');
  });

  it('carries the reason a status command could not run', () => {
    const view = qaView(input({ statusProblem: 'This card has no checkout yet.' }));

    expect(view.stack.statusNote).toBe('This card has no checkout yet.');
  });

  it('offers the three buttons of the card page, in that order', () => {
    expect(qaView(input()).stack.buttons.map((button) => button.label)).toEqual(['Start', 'Stop', 'Force']);
  });

  // One QA run at a time owns the stack. Taking it down under a running check would make the
  // verdict meaningless, so the lane refuses Force too.
  it('refuses all three while another card runs QA on the stack lane', () => {
    const view = qaView(input({ stackLane: 'APP-2', stack: { state: 'up', reason: null } }));

    expect(view.stack.buttons.map((button) => button.refused)).toEqual([
      'APP-2 is running QA, which owns the app until it ends.',
      'APP-2 is running QA, which owns the app until it ends.',
      'APP-2 is running QA, which owns the app until it ends.',
    ]);
  });

  it('names this card when it is the one holding the lane', () => {
    const view = qaView(input({ stackLane: 'APP-1', stack: { state: 'up', reason: null } }));

    expect(refusal(view, 'load')).toContain('This card is running QA');
  });

  it('takes no second Load or Unload while a stack command for this card is running', () => {
    for (const state of ['loading', 'unloading'] as const) {
      const view = qaView(input({ stack: { state, reason: null } }));
      expect(refusal(view, 'load')).toContain('already running');
      expect(refusal(view, 'unload')).toContain('already running');
    }
  });

  // A command that never came back leaves the card in one of these two states for good. Force is
  // the only way out, so the state it exists to rescue must not be the state that refuses it.
  it('keeps Force pressable while the state says a command is running, and says what it does', () => {
    for (const state of ['loading', 'unloading'] as const) {
      const force = qaView(input({ stack: { state, reason: null } })).stack.buttons.find((one) => one.action === 'force');
      expect(force?.refused).toBeNull();
      expect(force?.note).toContain('whatever the state says');
    }
  });

  // Both refusals at once. The lane is the one a person can do nothing about, so it is the one the
  // button says.
  it('names the running QA run, not the state, when both would refuse', () => {
    const view = qaView(input({ stackLane: 'APP-2', stack: { state: 'loading', reason: null } }));

    expect(refusal(view, 'load')).toContain('APP-2 is running QA');
  });

  // Both sides of the state check, because Unload with nothing up is the case Force exists for.
  it('offers Unload on a stack that is up and sends the other case to Force', () => {
    const up = qaView(input({ stack: { state: 'up', reason: null } }));
    const off = qaView(input({ stack: { state: 'off', reason: null } }));

    expect(refusal(up, 'unload')).toBeNull();
    expect(refusal(off, 'unload')).toContain('Press Force');
    expect(refusal(off, 'force')).toBeNull();
  });

  // A Start that failed partway can leave earlier repositories up, so Stop is offered beside Start.
  it('offers Start and Stop after a failed start', () => {
    const view = qaView(input({ stack: { state: 'failed', reason: 'exited 3' } }));

    expect(view.stack.fits).toEqual(['load', 'unload']);
    expect(refusal(view, 'unload')).toBeNull();
  });

  it('refuses Stop and Force on a card with no own commands', () => {
    const view = qaView(input({ hasUnload: false, stack: { state: 'up', reason: null } }));

    expect(refusal(view, 'unload')).toBe('No repository of this card has its own start commands.');
    expect(refusal(view, 'force')).toBe('No repository of this card has its own start commands.');
    expect(refusal(view, 'load')).toBeNull();
  });
});

describe('the QA verdict panel', () => {
  it('says QA has not run when the card has no QA run', () => {
    const view = qaView(input());

    expect(view.verdict.verdict).toBeNull();
    expect(view.verdict.note).toBe('QA has not run for this card yet.');
    expect(view.verdict.runId).toBeNull();
  });

  it.each(['PASS', 'FAIL', 'BLOCKED'] as const)('shows a %s verdict with its reason', (verdict) => {
    const view = qaView(input({ run: { id: 7, state: 'complete', verdict, verdictReason: 'An empty search shows no recipes.' } }));

    expect(view.verdict.verdict).toBe(verdict);
    expect(view.verdict.reason).toBe('An empty search shows no recipes.');
    expect(view.verdict.note).toBeNull();
    expect(view.verdict.runId).toBe(7);
  });

  // The loop stores its own sentence for this one, and that sentence is the whole answer.
  it('shows the stored sentence when the run printed no verdict line', () => {
    const said = 'This QA run printed no verdict, so nobody can say what it found. Read its log, then move the card yourself.';
    const view = qaView(input({ run: { id: 7, state: 'complete', verdict: null, verdictReason: said } }));

    expect(view.verdict.verdict).toBeNull();
    expect(view.verdict.note).toBe(said);
  });

  // The state nobody designs for: the run died before it wrote anything, so there is no verdict
  // and no sentence either.
  it('says the run ended before deciding when it left neither a verdict nor a reason', () => {
    const view = qaView(input({ run: { id: 7, state: 'failed', verdict: null, verdictReason: null } }));

    expect(view.verdict.note).toBe('The QA run ended before it decided anything. Its log says how far it got.');
    expect(view.verdict.runId).toBe(7);
  });

  it('says a stopped run decided nothing', () => {
    const view = qaView(input({ run: { id: 7, state: 'stopped', verdict: null, verdictReason: null } }));

    expect(view.verdict.note).toBe('The QA run was stopped, so it decided nothing.');
  });

  it.each(['queued', 'waiting_lane', 'running', 'retrying'] as const)('says the verdict is still coming while the run is %s', (state) => {
    const view = qaView(input({ run: { id: 7, state, verdict: null, verdictReason: null } }));

    expect(view.verdict.note).toBe('QA is running. The verdict comes when it ends.');
  });

  it('carries the report and the screenshots the run left in the card folder', () => {
    const view = qaView(
      input({
        run: { id: 7, state: 'complete', verdict: 'PASS', verdictReason: null },
        report: 'qa/report.md',
        screenshots: [{ path: 'qa/search.png', name: 'search.png' }],
      }),
    );

    expect(view.verdict.report).toBe('qa/report.md');
    expect(view.verdict.screenshots).toEqual([{ path: 'qa/search.png', name: 'search.png' }]);
    expect(view.verdict.screenshotNote).toBeNull();
  });

  // A project with no browser cannot take one, and saying so beats an empty block.
  it('says why there are no screenshots', () => {
    expect(qaView(input()).verdict.screenshotNote).toContain('once a browser is set up');
  });

  // The other empty. This project can take screenshots, so blaming the setup would be a lie.
  it('says the run took none when the project has a browser', () => {
    expect(qaView(input({ hasBrowser: true })).verdict.screenshotNote).toBe('This run took no screenshots.');
  });
});

describe('the checklist in section 2 of the QA report', () => {
  const report = (section: string) => `## 1. Verdict

FAIL: stopping the api leaves an empty list.

## 2. What QA checked

${section}

## 3. What was not checked

Nothing.
`;

  it('reads one row per check, with the reason under a fail', () => {
    const found = parseQaChecklist(
      report(`1. pass: Load the local stack
2. pass: Open the recipe list, it shows recipes
   Ran: opened the list page, saw 12 recipes
3. fail: Stop the api and reload, a message shows
   Reason: the list was empty and no message showed
4. not reached: Start the api again, the list comes back`),
    );

    expect(found).toEqual({
      text: null,
      rows: [
        { step: 'Load the local stack', result: 'pass', reason: null, ran: null },
        { step: 'Open the recipe list, it shows recipes', result: 'pass', reason: null, ran: 'opened the list page, saw 12 recipes' },
        { step: 'Stop the api and reload, a message shows', result: 'fail', reason: 'the list was empty and no message showed', ran: null },
        { step: 'Start the api again, the list comes back', result: 'not reached', reason: null, ran: null },
      ],
    });
  });

  // An agent writes these by hand. Case and spacing carry no meaning, so they do not make a report
  // drift.
  it('reads rows with odd spacing or case', () => {
    const found = parseQaChecklist(
      report(['1.   PASS :  Load the local stack  ', ' 2)  Fail:Open the recipe list: it shows recipes', '\treason :   the list was empty   ', '3. Not   Reached: Start the api again'].join('\n')),
    );

    expect(found?.rows).toEqual([
      { step: 'Load the local stack', result: 'pass', reason: null, ran: null },
      { step: 'Open the recipe list: it shows recipes', result: 'fail', reason: 'the list was empty', ran: null },
      { step: 'Start the api again', result: 'not reached', reason: null, ran: null },
    ]);
  });

  // The rows of a report written since the brief has ids. Expected and Actual under a fail are more
  // indented lines, which keep the row as it is.
  it('takes the acceptance check id off the front of a step, and leaves a row with none as it was', () => {
    const found = parseQaChecklist(
      report(`1. pass: Load the local stack
2. pass: AC1: Open the recipe list, it shows recipes
3. fail: ac2 : Stop the api and reload, a message shows
   Reason: no message showed
   Expected: a message says the recipes cannot load
   Actual: the list was empty and no message showed
4. not reached: AC3: Start the api again, the list comes back`),
    );

    expect(found?.rows).toEqual([
      { step: 'Load the local stack', result: 'pass', reason: null, ran: null },
      { step: 'Open the recipe list, it shows recipes', result: 'pass', reason: null, ran: null, ac: 'AC1' },
      { step: 'Stop the api and reload, a message shows', result: 'fail', reason: 'no message showed', ran: null, ac: 'AC2', expected: 'a message says the recipes cannot load', actual: 'the list was empty and no message showed' },
      { step: 'Start the api again, the list comes back', result: 'not reached', reason: null, ran: null, ac: 'AC3' },
    ]);
  });

  // Since the report gives each row How and Evidence, How is what the run did, and it takes the place
  // of the older Ran line under the row. Evidence is kept for Fix it.
  it('reads How as what ran, and keeps the Evidence line', () => {
    const found = parseQaChecklist(
      report(`1. pass: AC1 (must): Open the recipe list, it shows recipes
   How: opened the list page in the browser
   Evidence: qa/evidence/1-list.png, 12 recipes show
2. pass: Run the tests
   Ran: npm test, 12 passed`),
    );

    expect(found?.rows).toEqual([
      { step: 'Open the recipe list, it shows recipes', result: 'pass', reason: null, ran: 'opened the list page in the browser', ac: 'AC1', evidence: 'qa/evidence/1-list.png, 12 recipes show' },
      { step: 'Run the tests', result: 'pass', reason: null, ran: 'npm test, 12 passed' },
    ]);
  });

  // A run may copy the brief's level along with the id.
  it('takes the id off a step that carries the level too', () => {
    expect(parseQaChecklist(report('1. pass: AC1 (must): Open the recipe list, it shows recipes'))?.rows).toEqual([
      { step: 'Open the recipe list, it shows recipes', result: 'pass', reason: null, ran: null, ac: 'AC1' },
    ]);
  });

  it('reads Windows line ends', () => {
    expect(parseQaChecklist(report('1. pass: Load the local stack').replace(/\n/g, '\r\n'))?.rows).toEqual([
      { step: 'Load the local stack', result: 'pass', reason: null, ran: null },
    ]);
  });

  // A table, the shape this section had before it had rows. Showing only the lines that happen to
  // parse would hide the rest, so the whole section comes back as it was written.
  it('hands back the section as text when it drifted from the rows', () => {
    const table = `| Check | Ran | Result |
| --- | --- | --- |
| The list loads | opened the page | held |`;

    expect(parseQaChecklist(report(table))).toEqual({ rows: null, text: table });
    expect(parseQaChecklist(report(`Every check in the order of the plan.\n\n1. pass: Load the local stack`))).toEqual({
      rows: null,
      text: 'Every check in the order of the plan.\n\n1. pass: Load the local stack',
    });
  });

  it('hands back the section as text when an unindented prose line follows a row', () => {
    const section = '1. pass: Load the local stack\nEvery other check was skipped.';

    expect(parseQaChecklist(report(section))).toEqual({ rows: null, text: section });
  });

  // The rule that matters most. A word the parser does not know could mean anything, and reading
  // it as pass would show a green row for a check that did not hold.
  it('never reads an unknown result word as pass', () => {
    for (const word of ['passed', 'ok', 'done', 'skipped', '**pass**', 'held']) {
      const section = `1. pass: Load the local stack\n2. ${word}: Open the recipe list`;

      expect(parseQaChecklist(report(section)), word).toEqual({ rows: null, text: section });
    }
  });

  it('finds nothing when the report has no section 2', () => {
    expect(parseQaChecklist('## 1. Verdict\n\nPASS\n\n## 3. What was not checked\n\nNothing.\n')).toBeNull();
    expect(parseQaChecklist('')).toBeNull();
    expect(parseQaChecklist(report(''))).toBeNull();
  });

  // The heading is the part an agent is most likely to reword, so either half of it finds the
  // section, and the section ends at the next heading of its own level.
  it('finds the section by its number or its name', () => {
    const rows = [{ step: 'Load the local stack', result: 'pass', reason: null, ran: null }];

    expect(parseQaChecklist('# QA\n\n### 2) Checks\n\n1. pass: Load the local stack\n')?.rows).toEqual(rows);
    expect(parseQaChecklist('## What QA checked\n1. pass: Load the local stack\n## Notes\nNone.\n')?.rows).toEqual(rows);
  });

  // The skill and the parser are one pair. A word renamed in one and not the other would turn every
  // report into plain text, and nothing else in the suite would say so.
  it('reads the example the skill gives the run, in the three words it names', () => {
    const skill = readFileSync(join(import.meta.dirname, '..', '..', '..', 'skills', 'skills', 'nolzu-qa', 'SKILL.md'), 'utf8');
    const lines = skill.split('\n');
    const start = lines.indexOf('    ## 2. What QA checked');
    const end = lines.findIndex((line, at) => at > start && line !== '' && !line.startsWith('    '));
    const example = lines
      .slice(start, end)
      .map((line) => line.slice(4))
      .join('\n');

    expect(start).toBeGreaterThan(-1);
    for (const word of QA_RESULTS) expect(skill, word).toContain(`\`${word}\``);
    expect(parseQaChecklist(example)?.rows?.map((row) => row.result)).toEqual(['pass', 'pass', 'fail', 'not reached']);
  });
});

// The QA failed overview draws the checklist beside the verdict, read from the report the page sent.
describe('the checklist on the verdict panel', () => {
  const run = { id: 7, state: 'complete' as const, verdict: 'FAIL' as const, verdictReason: 'The list stays empty.' };
  const REPORT = '## 1. Verdict\n\nFAIL\n\n## 2. What QA checked\n\n1. pass: Load the local stack\n2. fail: Stop the api and reload, a message shows\n   Reason: the list was empty\n';

  it('reads the rows of the report the page sent', () => {
    const view = qaView(input({ run, report: 'qa/report.md', reportText: REPORT }));

    expect(view.verdict.checklist?.rows?.map((row) => row.result)).toEqual(['pass', 'fail']);
    expect(view.verdict.checklist?.rows?.[1]?.reason).toBe('the list was empty');
  });

  it('carries the section as text when the report drifted', () => {
    const view = qaView(input({ run, reportText: '## 2. What QA checked\n\n| Step | Result |\n| --- | --- |\n| Load | passed |\n' }));

    expect(view.verdict.checklist).toEqual({ rows: null, text: '| Step | Result |\n| --- | --- |\n| Load | passed |' });
  });

  it('has no checklist with no section 2 or no report', () => {
    expect(qaView(input({ run, reportText: '## 1. Verdict\n\nFAIL\n' })).verdict.checklist).toBeNull();
    expect(qaView(input({ run })).verdict.checklist).toBeNull();
  });
});

// The qa skill starts a screenshot's name with its check's number, so the caption can say how that
// check went.
describe('the check a screenshot shows', () => {
  const checklist = parseQaChecklist('## 2. What QA checked\n\n1. pass: Open the list\n2. fail: Stop the api, a message shows\n3. not reached: Start it again\n');

  it('reads the number at the start of the name, and that row', () => {
    expect(checkOfShot('2-api-stopped.png', checklist)).toEqual({ number: 2, step: 'Stop the api, a message shows', result: 'fail' });
    expect(checkOfShot('1-list.png', checklist)).toEqual({ number: 1, step: 'Open the list', result: 'pass' });
  });

  it('matches nothing for a name with no number, a number with no row, or no rows', () => {
    expect(checkOfShot('search.png', checklist)).toBeNull();
    expect(checkOfShot('9-later.png', checklist)).toBeNull();
    expect(checkOfShot('12-list.png', checklist)).toBeNull();
    expect(checkOfShot('2-api-stopped.png', { rows: null, text: 'prose' })).toBeNull();
    expect(checkOfShot('2-api-stopped.png', null)).toBeNull();
  });
});

// The QA stack line: a state pill, one sentence naming the stack command where the data says so,
// and only the actions that fit the state.
describe('the stack line', () => {
  it('says Stopped, names the start command QA ran, and offers Start alone', () => {
    const view = qaView(input({ stack: { state: 'off', reason: TAKEN_DOWN }, loadCommand: 'npm run dev' }));

    expect(view.stack.word).toBe('Stopped');
    expect(view.stack.said).toEqual({ text: 'Started with ', command: 'npm run dev', tail: ' for QA, stopped after.' });
    expect(view.stack.fits).toEqual(['load']);
  });

  it('says Up, and offers Stop and Force', () => {
    const view = qaView(input({ stack: { state: 'up', reason: null }, loadCommand: 'npm run dev' }));

    expect(view.stack.word).toBe('Up');
    expect(view.stack.said).toEqual({ text: 'Started with ', command: 'npm run dev', tail: '.' });
    expect(view.stack.fits).toEqual(['unload', 'force']);
  });

  it('keeps the sentence the stack row holds when it names no QA load', () => {
    const view = qaView(input({ stack: { state: 'off', reason: 'Nolzu started no app. QA checks the code only.' }, loadCommand: 'npm run dev' }));

    expect(view.stack.said).toEqual({ text: 'Nolzu started no app. QA checks the code only.', command: null, tail: '' });
  });

  it('offers Force alone while a command is in the middle, the one way out', () => {
    expect(qaView(input({ stack: { state: 'loading', reason: null } })).stack.fits).toEqual(['force']);
  });
});

describe('checkWord', () => {
  it('puts a short reason beside the result, and a long one under it', () => {
    expect(checkWord({ step: 'Reload', result: 'fail', reason: 'empty list', ran: null })).toEqual({ word: 'fail, empty list', under: null });
    const long = 'the list was empty and no message showed after the reload';
    expect(checkWord({ step: 'Reload', result: 'fail', reason: long, ran: null })).toEqual({ word: 'fail', under: long });
  });

  it('says the result alone when there is no reason, or on a pass', () => {
    const edge = 'x'.repeat(32);
    expect(checkWord({ step: 'Reload', result: 'fail', reason: edge, ran: null })).toEqual({ word: `fail, ${edge}`, under: null });
    expect(checkWord({ step: 'Reload', result: 'fail', reason: `${edge}y`, ran: null })).toEqual({ word: 'fail', under: `${edge}y` });
    expect(checkWord({ step: 'Load', result: 'pass', reason: null, ran: null })).toEqual({ word: 'pass', under: null });
    expect(checkWord({ step: 'Load', result: 'not reached', reason: null, ran: null })).toEqual({ word: 'not reached', under: null });
  });

  // Every row says why or what ran, so a pass and a not reached are as readable as a fail.
  it('puts the reason of a not reached row under it, and the Ran line under any row without one', () => {
    expect(checkWord({ step: 'Reload', result: 'not reached', reason: 'the api is down', ran: null })).toEqual({ word: 'not reached', under: 'the api is down' });
    expect(checkWord({ step: 'Load', result: 'pass', reason: null, ran: '8 tests, 8 passed' })).toEqual({ word: 'pass', under: '8 tests, 8 passed' });
    expect(checkWord({ step: 'Reload', result: 'fail', reason: 'empty list', ran: 'curl /recipes' })).toEqual({ word: 'fail, empty list', under: 'curl /recipes' });
  });
});

describe('checkCount', () => {
  const row = (result: 'pass' | 'fail' | 'not reached') => ({ step: 'Check', result, reason: null, ran: null });

  it('counts each result in the order the skill names them, and leaves out a result no row has', () => {
    const rows = [row('not reached'), row('pass'), row('fail'), row('pass'), row('pass'), row('pass'), row('pass')];
    expect(checkCount(rows)).toBe('5 passed, 1 failed, 1 not reached');
    expect(checkCount([row('pass'), row('pass')])).toBe('2 passed');
    expect(checkCount([row('fail'), row('not reached'), row('not reached')])).toBe('1 failed, 2 not reached');
    expect(checkCount([])).toBe('');
  });

  // The shape a real FAIL run wrote: one fail, a pass at the end, and the rest not reached.
  it('reads a FAIL report with not reached rows and a Ran line', () => {
    const rows = parseQaChecklist(`## 2. What QA checked

1. fail: Check the api answers /recipes/3
   Reason: the api has no one-recipe route
   Expected: /recipes/3 answers JSON
   Actual: curl /recipes/3 answered 404
2. not reached: AC4: Click each recipe
   Reason: blocked by the missing api route.
3. not reached: AC2: Reload the page
4. pass: Open #/nothing, the list shows
   Ran: opened index.html#/nothing, 5 list items showed
`)?.rows;
    expect(rows?.map((one) => checkWord(one))).toEqual([
      { word: 'fail, the api has no one-recipe route', under: null },
      { word: 'not reached', under: 'blocked by the missing api route.' },
      { word: 'not reached', under: null },
      { word: 'pass', under: 'opened index.html#/nothing, 5 list items showed' },
    ]);
    expect(checkCount(rows ?? [])).toBe('1 passed, 1 failed, 2 not reached');
  });
});
