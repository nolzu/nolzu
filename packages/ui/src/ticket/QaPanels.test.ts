import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import { TAKEN_DOWN } from '@nolzu/protocol';
import { type QaInput, qaView } from './qa.ts';
import QaPanels from './QaPanels.svelte';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

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

const draw = (over: Partial<QaInput> = {}): string =>
  render(QaPanels, { props: { view: qaView(input(over)), fileHref: (path: string) => `/f/${path}` } }).body;

it('draws both panels, the stack one and the verdict one', () => {
  const body = draw();

  expect(body).toContain('data-stack-panel');
  expect(body).toContain('data-verdict-panel');
});

it('draws a grey line in the status place while the status command runs', () => {
  const body = draw({ statusPending: true });

  expect(body).toContain('data-stack-pending');
  expect(body).toContain('data-skeleton');
  expect(text(body)).toContain('The status command is running.');
  expect(text(body)).not.toContain('has not run yet');
  expect(draw()).not.toContain('data-skeleton');
});

it('says off for a card with no own commands, and says where to set them', () => {
  const body = draw({ hasLoad: false, hasUnload: false, hasStatus: false });

  expect(body).toContain('data-stack-state="off"');
  expect(text(body)).toContain('No repository of this card has its own start commands. Add them in the QA question, or under Start the app in Settings, Project.');
});

const WORDS = { loading: 'Starting', up: 'Up', failed: 'Failed', unloading: 'Stopping' } as const;
it.each(['loading', 'up', 'failed', 'unloading'] as const)('draws the %s state with its word, not colour alone', (state) => {
  const body = draw({ stack: { state, reason: null } });

  expect(body).toContain(`data-stack-state="${state}"`);
  expect(text(body)).toContain(`${WORDS[state]} App`);
});

// The app is one line; what the Status commands printed folds under it.
it('prints the status output as the project wrote it, folded under the line', () => {
  const output = 'api   running\ndb    exited (1)';
  const body = draw({ status: { command: 'compose ps', code: 0, output, timedOut: false } });

  expect(/<pre data-stack-status[^>]*>([\s\S]*?)<\/pre>/.exec(body)?.[1]).toBe(output);
  expect(body).toMatch(/<details[^>]*>\s*<summary[^>]*>What the Status commands say<\/summary>/);
  expect(body).toContain('compose ps');
});

it('says not reported when no own command has a Status command', () => {
  const body = draw({ hasStatus: false });

  expect(text(body)).toContain("App Not reported. None of this card's own commands has a Status command.");
  expect(body).not.toContain('data-stack-status');
});

// Several own commands: the line lists which runs where, in the order Start runs them. One needs no list.
it('lists the own commands of several repositories under the line', () => {
  const apps = [
    { name: 'api', start: 'docker compose up -d' },
    { name: 'web', start: 'npm start' },
  ];
  expect(text(draw({ apps }))).toContain('api: docker compose up -d web: npm start');
  expect(draw({ apps: apps.slice(0, 1) })).not.toContain('data-stack-apps');
});

it('takes no press on a button the rules refused, and says why in its title', () => {
  const body = draw({ stackLane: 'APP-2' });

  expect(body).toMatch(/<button[^>]*data-stack="load"[^>]*disabled/);
  expect(body).toContain('APP-2 is running QA, which owns the app until it ends.');
});

it('offers Stop and Force on an app that is up, and no Start', () => {
  const body = draw({ stack: { state: 'up', reason: null } });

  expect(text(body)).toContain('Stop Force');
  expect(body).not.toContain('data-stack="load"');
  expect(body).not.toMatch(/<button[^>]*data-stack="force"[^>]*disabled/);
});

// Force stays pressable while a command is in flight, because a command that never came back is
// what leaves the card in that state. Its title is where a person reads what pressing it does.
it('keeps Force pressable while the state says a command is running, and says so in its title', () => {
  const body = draw({ stack: { state: 'loading', reason: null } });

  expect(body).not.toMatch(/<button[^>]*data-stack="force"[^>]*disabled/);
  expect(body).toMatch(/<button[^>]*data-stack="force"[^>]*title="Runs the Stop commands, whatever the state says."/);
  expect(body).not.toContain('data-stack="load"');
});

it('says QA has not run on a card that was never checked', () => {
  expect(text(draw())).toContain('QA has not run for this card yet.');
});

it.each(['PASS', 'FAIL', 'BLOCKED'] as const)('shows the %s verdict and its reason', (verdict) => {
  const body = draw({ run: { id: 7, state: 'complete', verdict, verdictReason: 'An empty search shows no recipes.' } });

  expect(body).toContain(`data-verdict="${verdict}"`);
  expect(text(body)).toContain(verdict);
  expect(text(body)).toContain('An empty search shows no recipes.');
});

// The state nobody designs for: the run died before it wrote anything.
it('says the run ended before deciding when it left neither a verdict nor a reason', () => {
  const body = draw({ run: { id: 7, state: 'failed', verdict: null, verdictReason: null } });

  expect(body).not.toContain('data-verdict=');
  expect(text(body)).toContain('The QA run ended before it decided anything.');
});

it('shows the stored sentence of a run that printed no verdict line', () => {
  const body = draw({ run: { id: 7, state: 'complete', verdict: null, verdictReason: 'This QA run printed no verdict.' } });

  expect(text(body)).toContain('This QA run printed no verdict.');
});

it('links the report and the screenshots through the address the page built', () => {
  const body = draw({
    run: { id: 7, state: 'complete', verdict: 'PASS', verdictReason: null },
    report: 'qa/report.md',
    screenshots: [{ path: 'qa/search.png', name: 'search.png' }],
  });

  expect(body).toContain('href="/f/qa/report.md"');
  expect(body).toContain('href="/f/qa/search.png"');
  expect(body).not.toContain('No screenshots');
});

// A thumbnail is a plain link to the Files tab with its file open, so a middle click opens a new tab.
it('links each thumbnail to the Files tab with its file, and keeps the image on the file route', () => {
  const props = {
    view: qaView(input({ run: { id: 7, state: 'complete', verdict: 'PASS', verdictReason: null }, screenshots: [{ path: 'qa/3-search-soup.png', name: '3-search-soup.png' }] })),
    fileHref: (path: string) => `/f/${path}`,
    shotHref: (path: string) => `/t/APP-1/files?${new URLSearchParams({ file: path })}`,
  };
  for (const failed of [null, { run: null }]) {
    const body = render(QaPanels, { props: { ...props, failed } }).body;

    expect(body).toMatch(/<a class="frame[^"]*" href="\/t\/APP-1\/files\?file=qa%2F3-search-soup.png" data-shot="qa\/3-search-soup.png"><img src="\/f\/qa\/3-search-soup.png"/);
    expect(body).not.toMatch(/<a class="frame[^>]*target=/);
  }
});

// A card that passed shows every check with its result too, not only a card that failed. The verdict
// word and the count are the header of a block that starts folded.
it('draws the checklist with its count and every result on the verdict block of a card that did not fail', () => {
  const body = draw({
    run: { id: 7, state: 'complete', verdict: 'BLOCKED', verdictReason: 'The api has no recipe route.' },
    reportText: report(
      '## 2. What QA checked\n\n1. pass: AC1: Open the list\n   Ran: saw 5 recipes\n2. fail: AC2: Open a recipe\n   Reason: the api answered 404 for every recipe route\n3. not reached: AC3: Reload the recipe\n   Reason: blocked by the missing route\n4. not reached: AC4: Go back\n\n',
    ),
  });
  const shown = text(body);

  expect(shown).toContain('QA verdict BLOCKED , 1 passed, 1 failed, 2 not reached The api has no recipe route.');
  expect(body).toMatch(/aria-expanded="false" aria-controls="qa-panel-body"/);
  expect(shown).toContain('1 AC1 Open the list pass saw 5 recipes');
  expect(shown).toContain('2 AC2 Open a recipe fail the api answered 404 for every recipe route');
  expect(shown).toContain('3 AC3 Reload the recipe not reached blocked by the missing route');
  expect(shown).toContain('4 AC4 Go back not reached');
  expect(body.match(/<li data-result="(pass|fail|not reached)"/g)).toHaveLength(4);
});

// A pass rarely gives a reason, so the folded line names the checks instead of staying empty.
it('previews the checks on a folded pass with no reason', () => {
  const body = draw({
    run: { id: 7, state: 'complete', verdict: 'PASS', verdictReason: null },
    reportText: report('## 2. What QA checked\n\n1. pass: AC1: Open the list\n   Ran: saw 5 recipes\n2. pass: AC2: Open a recipe\n\n'),
  });

  expect(body).toMatch(/<p class="peek[^"]*">Open the list\. Open a recipe\.<\/p>/);
});

// A run with no screenshots, such as one on a project with no browser config, says so rather than
// drawing nothing.
it('says why there are no screenshots', () => {
  expect(text(draw())).toContain('No screenshots.');
});

it('links this run\'s log when the page gave an address for it', () => {
  const props = { view: qaView(input({ run: { id: 7, state: 'complete', verdict: 'PASS' as const, verdictReason: null } })), fileHref: (path: string) => path };
  const on = render(QaPanels, { props: { ...props, logHref: '/t/APP-1/log?run=7' } }).body;

  expect(on).toContain('href="/t/APP-1/log?run=7"');
  expect(render(QaPanels, { props }).body).not.toContain('data-qa-log');
});

it('sets no colour literal, so the panels follow the design tokens', () => {
  const source = readFileSync(new URL('./QaPanels.svelte', import.meta.url), 'utf8');

  expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  expect(source).not.toMatch(/oklch\(/);
});

// On a QA FAIL the panels open the overview with the verdict, the screenshots, the checklist
// and the stack as one line.
const FAILED_RUN = { id: 9, state: 'complete' as const, verdict: 'FAIL' as const, verdictReason: 'The page shows an empty list, not the message.' };
// Ended 22 minutes ago, which the run line says last.
const STRIP_RUN = {
  id: 9,
  phase: 'qa',
  state: 'complete' as const,
  model: 'sonnet',
  effort: 'medium',
  costUsd: 0.09,
  durationMs: 112_000,
  tokens: null,
  question: null,
  verdict: 'FAIL' as const,
  endedAt: new Date(Date.now() - 22 * 60_000 - 5_000).toISOString(),
};
const report = (section: string) => `## 1. Verdict\n\nFAIL\n\n${section}## 3. What was not checked\n\nNothing.\n`;
// The red box first in the column, and the record of every check with the stack line further down.
const failedProps = (over: Partial<QaInput> = {}) => ({
  view: qaView(input({ run: FAILED_RUN, report: 'qa/report.md', hasBrowser: true, stack: { state: 'off', reason: TAKEN_DOWN }, loadCommand: 'npm run dev', ...over })),
  fileHref: (path: string) => `/f/${path}`,
  logHref: '/t/APP-1/log?run=9',
  failed: { run: STRIP_RUN },
});
const drawBox = (over: Partial<QaInput> = {}): string => render(QaPanels, { props: { ...failedProps(over), box: true } }).body;
const drawFailed = (over: Partial<QaInput> = {}): string => render(QaPanels, { props: failedProps(over) }).body;
const THREE = {
  reportText: report(
    '## 2. What QA checked\n\n1. pass: Open the recipe list, it shows recipes\n2. fail: Stop the api and reload, a message shows\n   Reason: the list was empty and no message showed\n3. not reached: Start the api again, the list comes back\n\n',
  ),
  screenshots: [
    { path: 'qa/1-list.png', name: '1-list.png' },
    { path: 'qa/2-api-stopped.png', name: '2-api-stopped.png' },
    { path: 'qa/overview.png', name: 'overview.png' },
  ],
};

it('draws the red box of a QA FAIL with its reason, the run line, the failed check and its screenshot', () => {
  const body = drawBox(THREE);
  const shown = text(body);

  expect(shown).toContain(
    'FAIL QA found one problem qa · sonnet · medium · 1m 52s · $0.09 · 22 minutes ago The page shows an empty list, not the message. 2 Stop the api and reload, a message shows fail the list was empty and no message showed',
  );
  // Now's "See the QA report" lands on #qa-panel, and on a QA FAIL this is the box it means.
  expect(body).toMatch(/<section class="failed[^"]*" id="qa-panel"[^>]*>\s*<div class="verdict-line/);
  expect(body.match(/<li data-result="(pass|fail|not reached)"/g)).toEqual(['<li data-result="fail"']);
  expect(body).toMatch(/<li class="shot[^"]*" data-result="fail"[\s\S]*?alt="Screenshot of check 2, Stop the api and reload, a message shows"[\s\S]*?2-api-stopped.png[\s\S]*?Check 2[\s\S]*?>fail</);
  expect(body).not.toContain('qa/1-list.png');
  expect(body).not.toContain('qa/overview.png');
  // The box needs the person; the stack and the report are further down.
  expect(body).not.toContain('data-stack-panel');
  expect(body).not.toContain('Open the QA report');
});

it('draws the record of a QA FAIL: every check and screenshot open, the report at the end of the header, and the stack as one line', () => {
  const body = drawFailed(THREE);
  const shown = text(body);

  expect(shown).toContain('What QA checked 1 passed, 1 failed, 1 not reached Open the QA report');
  expect(body).toMatch(/aria-expanded="true" aria-controls="qa-checked-body"/);
  expect(shown).toContain(
    '1 Open the recipe list, it shows recipes pass 2 Stop the api and reload, a message shows fail the list was empty and no message showed 3 Start the api again, the list comes back not reached',
  );
  expect(body.match(/<li data-result="(pass|fail|not reached)"/g)).toEqual(['<li data-result="pass"', '<li data-result="fail"', '<li data-result="not reached"']);
  // Small thumbnails with their file name and their check, no browser bar, before the checks.
  expect(body).not.toContain('class="chrome');
  expect(body.indexOf('src="/f/qa/1-list.png"')).toBeLessThan(body.indexOf('<ol class="checks'));
  expect(body).toMatch(/<li class="shot[^"]*">[\s\S]*?alt="Screenshot overview.png"/);
  expect(body).toMatch(/<a class="plainlink end[^"]*" href="\/f\/qa\/report.md" data-qa-report="">Open the QA report<\/a>/);
  expect(shown).not.toContain("See this run's log");
  // The app as one line: its pill, the sentence naming the start command, and only the button that fits.
  expect(shown).toContain('Stopped App Started with npm run dev for QA, stopped after. Start');
  expect(body).toMatch(/<code[^>]*>npm run dev<\/code>/);
  expect(body).not.toContain('data-stack="unload"');
  expect(body).not.toContain('data-stack="force"');
  // Not the verdict block of a card that did not fail, and no red box.
  expect(shown).not.toContain('QA verdict');
  expect(body).not.toContain('class="failed');
});

it('puts a short reason beside the result on the row', () => {
  const shown = text(drawBox({ reportText: report('## 2. What QA checked\n\n1. fail: Stop the api and reload, a message shows\n   Reason: empty list\n\n') }));

  expect(shown).toContain('1 Stop the api and reload, a message shows fail, empty list');
});

// A row from an acceptance check carries its id as a mono chip in front of the step. A row with no id,
// and every row of a report written before the ids, has no chip.
it('draws the acceptance check id of a row as a mono chip before its step', () => {
  const body = drawFailed({
    reportText: report('## 2. What QA checked\n\n1. pass: Load the local stack\n2. fail: AC2: Stop the api and reload, a message shows\n   Reason: empty list\n   Expected: a message shows\n   Actual: an empty list\n\n'),
  });

  expect(body).toMatch(/<span class="chip[^"]*mono[^"]*">(?:<!---->)?AC2(?:<!---->)?<\/span>(?:<!--\]-->)?\s*<span class="step[^"]*">Stop the api and reload, a message shows<\/span>/);
  expect(body.match(/class="chip[^"]*mono/g)).toHaveLength(1);
  expect(text(body)).toContain('1 passed, 1 failed Open the QA report');
  expect(text(body)).toContain('1 Load the local stack pass 2 AC2 Stop the api and reload, a message shows fail, empty list');
});

it('offers Stop and Force on an app that is up, and names the command it started with', () => {
  const body = drawFailed({ stack: { state: 'up', reason: null } });

  expect(text(body)).toContain('Up App Started with npm run dev . Stop Force');
  // The words keep their space before the command, which tag-blind text above cannot see.
  expect(body.match(/<span class="sentence[^"]*">([\s\S]*?)<\/span>/)?.[1]?.replace(/<[^>]*>/g, '')).toBe('Started with npm run dev.');
  expect(body).not.toContain('data-stack="load"');
});

it('shows section 2 as written when the report drifted from the rows', () => {
  const body = drawFailed({ reportText: report('## 2. What QA checked\n\n| Step | Result |\n| --- | --- |\n| Load | passed |\n\n') });

  expect(body).toMatch(/<p class="plain[^"]*" data-checks-text[^>]*>\| Step \| Result \|\n\| --- \| --- \|\n\| Load \| passed \|<\/p>/);
  expect(body).not.toContain('<li data-result');
  // A drifted report counts no problem it cannot read.
  expect(text(drawBox({ reportText: report('## 2. What QA checked\n\n| Step | Result |\n| --- | --- |\n| Load | passed |\n\n') }))).toContain('FAIL QA failed');
});

it('draws no checklist when the report has no section 2, and keeps the link to the report', () => {
  const body = drawFailed({ reportText: report('') });

  expect(body).not.toContain('<ol class="checks');
  expect(body).not.toContain('data-checks-text');
  expect(body).toContain('Open the QA report');
});

// One model can run on two engines, so the run line of a QA FAIL names the engine.
it('names the engine on the run line of a QA FAIL', () => {
  const body = render(QaPanels, { props: { ...failedProps(), failed: { run: { ...STRIP_RUN, engine: 'cursor' } }, box: true } }).body;

  expect(text(body)).toContain('qa · Cursor · sonnet · 1m 52s');
});
