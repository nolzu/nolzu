import { spendOf } from '@nolzu/protocol';
import { type ComponentProps, createRawSnippet } from 'svelte';
import { readFileSync } from 'node:fs';
import { render } from 'svelte/server';
import { expect, it } from 'vitest';
import Overview from './Overview.svelte';
import { qaView } from './qa.ts';

// Svelte's markers are no space in the browser, so they are dropped before the tags read as one.
const text = (body: string) => body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const base = { changesHref: '/t/APP-1/changes', ticket: 'The list has no search.', extra: null, related: [] };
// Typed to the component, not to Record<string, unknown>. With the loose type a prop added to
// Overview left this fixture short of it, typecheck and svelte-check both passed, and the page
// rendered NaN.
const draw = (over: Partial<ComponentProps<typeof Overview>> = {}) => render(Overview, { props: { summary: null, ...base, ...over } }).body;
// Whether the block that folds starts open, read off its button.
const expanded = (body: string, id: string) => new RegExp(`aria-expanded="(\\w+)" aria-controls="${id}-body"`).exec(body)?.[1];

it('says there is no summary yet before a run finished with one', () => {
  expect(text(draw())).toContain('No summary yet');
});

it('shows the summary through the sanitizing renderer', () => {
  // On the server the renderer shows the source as text; the browser renders it once it can clean it.
  const body = draw({ summary: 'The list has a **search box**. <script>x</script>' });

  expect(body).toMatch(/<pre class="markdown[^"]*">The list has a \*\*search box\*\*\. &lt;script>x&lt;\/script><\/pre>/);
  expect(body).not.toContain('<script');
});

it('links See the diff to the changes tab', () => {
  expect(draw()).toMatch(/<a[^>]*href="\/t\/APP-1\/changes"[^>]*>See the diff<\/a>/);
});

// On a board with no Changes tab there is no diff, and a link into a page that is not there is worse
// than no link: the person did not type that address, the page offered it.
it('offers no diff link where there is no changes tab', () => {
  expect(text(draw({ changesHref: null }))).not.toContain('See the diff');
});

it('opens with the summary, above the ticket text', () => {
  const shown = text(draw({ summary: 'Clearer now.' }));
  expect(shown.indexOf('What changed, in plain words')).toBeLessThan(shown.indexOf('The list has no search.'));
});

it('shows each related card as a chip with a named remove control', () => {
  const body = draw({ related: [{ key: 'APP-2', title: 'Sort the list' }] });

  expect(text(body)).toContain('APP-2');
  expect(body).toMatch(/<button[^>]*aria-label="Remove the link to APP-2"/);
});

const BLOCKED = { runId: 4, question: 'Titles only, or ingredients too?', sessionId: '22222222-aaaa-4bbb-8ccc-000000000002' };

it('has no answer composer unless the card is blocked', () => {
  expect(draw({ blocked: null })).not.toContain('id="answer"');
});

it('opens with the question and a composer that names the session it continues', () => {
  const body = draw({ blocked: BLOCKED, summary: 'Clearer now.' });
  const shown = text(body);

  expect(body).toContain('id="answer"');
  expect(shown).toContain('Titles only, or ingredients too?');
  // Shortened as the facts name it.
  expect(shown).toContain(BLOCKED.sessionId.slice(0, 8));
  // The question waits on the person, so it comes before anything else on the page.
  expect(shown.indexOf('Titles only, or ingredients too?')).toBeLessThan(shown.indexOf('What changed, in plain words'));
});

// A question from before the options, or one whose run offered none, draws as it always did.
it('draws a plain question with no answer buttons', () => {
  const body = draw({ blocked: BLOCKED });

  expect(body).not.toContain('role="group"');
  expect(body).not.toContain('Answers the agent offered');
  expect(text(body)).toContain('Titles only, or ingredients too?');
});

it('draws the answers the run offered, each with what it means and none pressed', () => {
  const options = [
    { label: 'Titles only', means: 'The search reads the recipe title' },
    { label: 'Ingredients too', means: 'A second index, one migration' },
  ];
  const body = draw({ blocked: { ...BLOCKED, options } });
  const shown = text(body);

  expect(body).toContain('aria-label="Answers the agent offered"');
  for (const { label, means } of options) {
    expect(shown).toContain(label);
    expect(shown).toContain(means);
  }
  // The question comes first, then the answers, then the field they fill.
  expect(shown.indexOf('Titles only, or ingredients too?')).toBeLessThan(shown.indexOf('The search reads the recipe title'));
  expect(body.indexOf('Answers the agent offered')).toBeLessThan(body.indexOf('id="answer"'));
  expect(body.match(/aria-pressed="false"/g)).toHaveLength(2);
});

it('says a blocked run with no session cannot be continued, and still offers the send', () => {
  const shown = text(draw({ blocked: { runId: 4, question: 'Titles only?', sessionId: null } }));

  expect(shown).toMatch(/no session/i);
});

it('ends with the phase trail when there is a strip', () => {
  const strip = [{ phase: 'refine', label: 'Refine', run: null, count: 0, spend: spendOf([]) }];
  // Extra context that holds text, so its field is drawn: an empty one waits behind a button, and an
  // anchor that is not on the page would make the order below pass for any order.
  const shown = text(draw({ strip, logBase: '/t/APP-1/log', extra: 'Keep the old page.' }));

  expect(shown).toContain('Trail Refine');
  expect(shown).toContain('Extra context');
  expect(shown.indexOf('Trail Refine')).toBeGreaterThan(shown.indexOf('Extra context'));
});

// The left column of the card page: the lede with who wrote it, the plan steps with their files,
// then the ticket folded.
const PLAN = '1. Add a `q` option to GET /recipes.\n   Files: api/src/recipes.ts, api/test/recipes.test.ts (new)\n2. An empty box shows every recipe again.\n';

// The server's time seeds the clock, so the server render says the time ago the first paint says.
it('says under the lede which phase wrote it and when, as a time ago from the server time', () => {
  const body = draw({ summary: 'There is a plan now.', summaryFrom: 'Written after Plan', summaryAt: '2026-10-15T10:10:00.000Z', now: '2026-10-15T13:10:00.000Z' });

  // The header every block shares: the title, the meta in grey, the one link at the end.
  expect(text(body)).toContain('What changed, in plain words Written after Plan, 3 hours ago See the diff There is a plan now.');
  expect(body).toContain('<time datetime="2026-10-15T10:10:00.000Z" title="Thursday, 15 October 2026 at 10:10">3 hours ago</time>');
  expect(text(draw({ summary: 'There is a plan now.', summaryFrom: 'Written after Plan' }))).toContain('Written after Plan See the diff');
});

it('draws the plan steps with their files, after the lede and before the ticket', () => {
  const body = draw({ summary: 'There is a plan now.', plan: PLAN, planHref: '/api/card/APP-1/file?path=plan%2Fplan.md' });
  const shown = text(body);

  expect(shown).toContain('The plan 2 steps Open plan.md');
  expect(shown).toContain('1 Add a q option to GET /recipes. api/src/recipes.ts api/test/recipes.test.ts 2 An empty box shows every recipe again.');
  expect(body).toMatch(/<code[^>]*>q<\/code>/);
  expect(body).toMatch(/<a[^>]*href="\/api\/card\/APP-1\/file\?path=plan%2Fplan.md"[^>]*>Open plan.md<\/a>/);
  expect(shown.indexOf('What changed, in plain words')).toBeLessThan(shown.indexOf('The plan'));
  expect(shown.indexOf('The plan')).toBeLessThan(shown.indexOf('The list has no search.'));
});

// The plan skill ends each step with the acceptance checks it serves. A plan from before the ids has no
// Covers line and draws none.
it('draws the Covers ids of a step as mono chips, and nothing on a step without them', () => {
  const body = draw({ plan: '1. Add a `q` option to GET /recipes.\n   Files: api/src/recipes.ts\n   Covers: AC1, AC2\n2. An empty box shows every recipe again.\n' });

  expect(text(body)).toContain('1 Add a q option to GET /recipes. api/src/recipes.ts Covers AC1 AC2 2 An empty box shows every recipe again.');
  expect(body.match(/data-covers/g)).toHaveLength(1);
  expect(draw({ plan: PLAN })).not.toContain('data-covers');
});

it('shows a plan that left the form as written', () => {
  const body = draw({ plan: 'The search runs in the api.' });

  expect(body).toMatch(/<p class="plain[^"]*">The search runs in the api.<\/p>/);
  expect(text(body)).not.toContain('steps');
});

it('draws no plan section on a card with no plan to show', () => {
  expect(draw()).not.toContain('data-plan');
});

// Reference blocks fold to one line with a preview, and a real button opens them.
it('folds the ticket to its first paragraph behind a button that says it is folded', () => {
  // The source wraps mid sentence, so the preview joins the paragraph and the CSS cut adds the ellipsis.
  const body = draw({ ticket: '# Search\n\n- The list has no search, so finding one recipe\n  means scrolling the whole list.\n\nA second paragraph.' });

  expect(body).toMatch(/<button type="button" class="toggle[^"]*" aria-expanded="false" aria-controls="ticket-body">/);
  expect(body).toMatch(/<p class="peek[^"]*">The list has no search, so finding one recipe means scrolling the whole list\.<\/p>/);
  expect(draw({ ticket: '# Search\n\n' })).not.toContain('class="peek');
  expect(body).toMatch(/<div class="body[^"]*" id="ticket-body" hidden/);
  expect(text(body)).not.toContain('Show all');
});

it('keeps empty extra context behind Add context in the ticket header, and shows it when it holds text', () => {
  expect(draw()).toMatch(/<button type="button" class="plainlink end[^"]*" data-add-context="">Add context<\/button>/);
  expect(draw()).not.toContain('id="extra"');
  expect(draw({ extra: 'Keep the old page.' })).toContain('id="extra"');
});

// A closed card: the pull request as one line, What Nolzu learned open, then the QA verdict, the plan
// and the ticket folded as the record, and the checkouts last.
it('draws a closed card in the record order, with the checkouts last', () => {
  const qa = qaOf({ run: { id: 9, state: 'complete', verdict: 'PASS', verdictReason: 'Every check passed.' } }, { inQa: false });
  const body = draw({
    summary: 'The list sorts by cooking time.',
    summaryFrom: 'The whole card, written at wrap-up',
    plan: PLAN,
    qa,
    closed: { knowledge: [], knowledgeHref: '/knowledge', onpulls: async () => ({ pulls: [], said: null }), onrevert: async () => ({ ok: true, message: '' }) },
    checkouts: createRawSnippet(() => ({ render: () => '<section>Remove its checkouts</section>' })),
    related: [{ key: 'APP-2', title: 'Sort the list' }],
  });
  const shown = text(body);
  const order = ['What happened', 'The whole card, written at wrap-up', 'Reading the pull request state through gh.', 'What Nolzu learned', 'Read more', 'QA verdict', 'The plan', 'Ticket', 'Remove its checkouts'];

  expect(order.map((one) => shown.indexOf(one))).toEqual(order.map((one) => shown.indexOf(one)).toSorted((a, b) => a - b));
  expect(order.every((one) => shown.includes(one))).toBe(true);
  // Nothing needs the person on a closed card, so the zone is not drawn.
  expect(shown).not.toContain('Needs you');
  // The record starts folded, the plan too, and the stack line has no place.
  expect(expanded(body, 'plan')).toBe('false');
  expect(expanded(body, 'qa-panel')).toBe('false');
  expect(body).not.toContain('data-stack-panel');
  expect(body).not.toContain('data-add-context');
  // A closed card takes no more links, so the related cards and their remove buttons are gone.
  expect(shown).not.toContain('APP-2');
});

// The checkouts belong to a closed card, so an open card draws none even when the page hands them.
it('draws no checkouts on an open card', () => {
  expect(text(draw({ checkouts: createRawSnippet(() => ({ render: () => '<section>Remove its checkouts</section>' })) }))).not.toContain('Remove its checkouts');
});

// A blocked card: the question box, then Your answer over the options, the field, Send and resume in
// amber with Answer later beside it, and the line that names the session it resumes.
const ASKS = { ...BLOCKED, phase: 'plan', engine: 'claude-code', model: 'sonnet', effort: 'medium' };
const goButtons = (body: string) => body.match(/<button[^>]*class="[^"]*\bgo\b[^"]*"[^>]*>/g) ?? [];

it('draws the question box of a card that asks, with its options, and Send and resume in amber', () => {
  const options = [
    { label: '1 to 5 stars', means: 'New column in recipes, one migration' },
    { label: 'Thumbs up and down', means: 'Reuses the likes table, no migration' },
  ];
  const body = draw({ blocked: { ...ASKS, question: 'Should a rating be 1 to 5 stars, or thumbs up and down?', options }, laterHref: '/b/delivery' });
  const shown = text(body);

  // The board's Answer link lands on the box that holds the question.
  expect(body).toMatch(/<section class="ask[^"]*" id="asks"[^>]*>[\s\S]*?Plan asks you[\s\S]*?Should a rating be 1 to 5 stars, or thumbs up and down\?[\s\S]*?<\/section>/);
  expect(shown).toContain('Your answer 1 to 5 stars New column in recipes, one migration Thumbs up and down Reuses the likes table, no migration Or write your own answer');
  // The answer, Send and resume and the resume line sit in the same violet box as the question.
  const box = body.slice(body.indexOf('id="asks"'), body.indexOf('</section>', body.indexOf('id="asks"')));
  expect(box).toContain('Your answer');
  expect(box).toContain('data-send-answer');
  expect(box).toContain('Answer later');
  expect(box).toContain('data-resume');
  expect(goButtons(body)).toHaveLength(1);
  expect(goButtons(body)[0]).toContain('data-send-answer');
  expect(shown).toContain('Send and resume ⌘↵');
  expect(body).toMatch(/<a class="later[^"]*" href="\/b\/delivery"[^>]*>Answer later<\/a>/);
  expect(shown).toContain('Resumes the Plan session 22222222 . It runs on Claude Code · sonnet · medium');
  // No estimate, which nothing reads, and no asked time while the page has no wait start to read.
  expect(shown).not.toMatch(/asked \d|waiting \d|about \$/);
});

it('draws the question box of a card that asks with no options, with the field and the resume line', () => {
  const body = draw({ blocked: ASKS });
  const shown = text(body);

  expect(shown).toContain('Plan asks you Titles only, or ingredients too?');
  expect(body).not.toContain('role="group"');
  expect(shown).toContain('Your answer Write your answer');
  expect(shown).not.toContain('Or write your own answer');
  expect(goButtons(body)).toHaveLength(1);
  expect(shown).toContain('Resumes the Plan session 22222222 . It runs on Claude Code · sonnet · medium');
  // No board link was handed in, so there is no Answer later to follow.
  expect(shown).not.toContain('Answer later');
});

// A card that waits in QA on a FAIL opens with the verdict, before the summary and the ticket.
it('opens with the QA FAIL, before the summary, and draws the panels once', () => {
  const view = qaView({
    cardKey: 'APP-1',
    run: { id: 9, state: 'complete', verdict: 'FAIL', verdictReason: 'The list stays empty.' },
    stack: null,
    hasLoad: true,
    hasUnload: true,
    hasStatus: false,
    status: null,
    statusProblem: null,
    stackLane: null,
    report: null,
    screenshots: [],
    hasBrowser: false,
  });
  const qa = { view, fileHref: (path: string) => `/f/${path}`, logHref: null, onstack: async () => '' };
  const failed = text(draw({ summary: 'The page catches a failed call.', qa: { ...qa, failed: { run: null } } }));

  expect(failed.indexOf('FAIL QA failed The list stays empty.')).toBeGreaterThan(-1);
  expect(failed.indexOf('FAIL QA failed')).toBeLessThan(failed.indexOf('changed, in plain words'));
  expect(failed.match(/ App /g)).toHaveLength(1);
  // A card that did not fail keeps the two panels at the end.
  const passed = text(draw({ summary: 'The page catches a failed call.', qa }));
  expect(passed.indexOf('QA verdict')).toBeGreaterThan(passed.indexOf('What changed, in plain words'));
});

// The parts of the overview.
const QA_BASE = {
  cardKey: 'APP-1',
  run: null,
  stack: null,
  hasLoad: true,
  hasUnload: true,
  hasStatus: false,
  status: null,
  statusProblem: null,
  stackLane: null,
  report: null,
  screenshots: [],
  hasBrowser: false,
} satisfies Parameters<typeof qaView>[0];
const qaOf = (over: Partial<Parameters<typeof qaView>[0]> = {}, extra: { failed?: { run: null }; inQa?: boolean } = {}) => ({
  view: qaView({ ...QA_BASE, ...over }),
  fileHref: (path: string) => `/f/${path}`,
  logHref: null,
  onstack: async () => '',
  ...extra,
});

it('says when the card started to wait, and draws the paragraphs and files under the question', () => {
  const since = new Date(Date.now() - 12 * 60_000 - 5_000).toISOString();
  const question = 'Should a rating be 1 to 5 stars, or thumbs up and down?\n\nThumbs reuse `api/src/likes.ts`.';
  const body = draw({ blocked: { ...ASKS, question, since } });
  const shown = text(body);

  expect(shown).toMatch(/Plan asks you asked \d\d:\d\d · waiting 12m Should a rating be 1 to 5 stars, or thumbs up and down\? Thumbs reuse api\/src\/likes.ts . api\/src\/likes.ts/);
});

it('links the plan as written on a card ready after Plan, and the diff after Implement', () => {
  const planHref = '/t/APP-1/files?file=plan%2Fplan.md';
  const ready = draw({ summary: 'There is a plan now.', summaryPhase: 'plan', plan: PLAN, planHref });

  expect(ready).toMatch(/<a class="plainlink end[^"]*" href="\/t\/APP-1\/files\?file=plan%2Fplan.md">See the plan as written<\/a>/);
  expect(text(ready)).not.toContain('See the diff');
  expect(text(draw({ summary: 'It is built.', summaryPhase: 'implement', plan: PLAN, planHref }))).toContain('See the diff');
});

it('draws Open plan.md as a plain ink link that stays in the app', () => {
  const body = draw({ plan: PLAN, planHref: '/t/APP-1/files?file=plan%2Fplan.md' });

  expect(body).toMatch(/<a class="plainlink[^"]*" href="\/t\/APP-1\/files\?file=plan%2Fplan.md">Open plan.md<\/a>/);
  expect(body).not.toContain('target="_blank"');
});

it('says where the ticket came from and when Refine ended, with Add context at the end', () => {
  const refinedAt = new Date(Date.now() - 20 * 60_000 - 5_000).toISOString();
  const long = Array.from({ length: 6 }, (_, at) => `Line ${at + 1} of the ticket.`).join('\n');
  const body = draw({ ticket: long, ticketSource: 'local', refinedAt });
  const shown = text(body);

  expect(shown).toContain('Ticket local, refined 20 minutes ago Add context Line 1 of the ticket.');
  expect(text(draw({ ticketSource: 'Jira' }))).toContain('Ticket Jira Add context The list has no search.');
});

it('shows the App line only in QA or with an app up, and the verdict only after a QA run', () => {
  const shown = (qa: ReturnType<typeof qaOf>, over: Partial<ComponentProps<typeof Overview>> = {}) => text(draw({ qa, ...over }));

  expect(shown(qaOf())).not.toContain(' App ');
  expect(shown(qaOf())).not.toContain('QA verdict');
  expect(shown(qaOf({}, { inQa: true }))).toContain(' App ');
  expect(shown(qaOf({ stack: { state: 'up', reason: null } }))).toContain(' App ');
  const ran = qaOf({ run: { id: 9, state: 'complete', verdict: 'PASS', verdictReason: null } });
  expect(shown(ran)).toContain('QA verdict');
  // A closed card keeps the verdict as part of the record.
  const closed = { knowledge: [], knowledgeHref: '/knowledge', onpulls: null, onrevert: async () => ({ ok: true, message: '' }) };
  expect(shown(ran, { closed })).toContain('QA verdict');
  expect(shown(qaOf({ stack: { state: 'up', reason: null } }), { closed })).not.toContain(' App ');
});

// The verdict of a pass folds with its checks and screenshots, with the word in the header, and sits
// first under Read more, never at the very bottom.
it('folds the verdict of a pass with its word in the header, above the plan and the ticket', () => {
  const qa = qaOf({ run: { id: 9, state: 'complete', verdict: 'PASS', verdictReason: 'Every check passed.' }, report: 'qa/report.md' }, { inQa: true });
  const body = draw({ summary: 'It is built.', plan: PLAN, qa });
  const shown = text(body);

  expect(shown).toContain('QA verdict PASS Open the QA report Every check passed.');
  expect(body).toMatch(/<span class="word[^"]*" data-verdict="PASS">PASS<\/span>/);
  expect(expanded(body, 'qa-panel')).toBe('false');
  const order = ['Read more', 'QA verdict', ' App ', 'The plan', 'Ticket'];
  expect(order.map((one) => shown.indexOf(one))).toEqual(order.map((one) => shown.indexOf(one)).toSorted((a, b) => a - b));
});

// A QA FAIL: the red box first, the change under What happened, then every check open with the stack
// line, and the plan and the ticket folded so the person can compare.
it('draws a QA FAIL in the zone order, with the plan and the ticket folded at the bottom', () => {
  const qa = qaOf({ run: { id: 9, state: 'complete', verdict: 'FAIL', verdictReason: 'The list stays empty.' }, report: 'qa/report.md' }, { failed: { run: null } });
  const body = draw({ summary: 'The page catches a failed call.', summaryPhase: 'implement', plan: PLAN, planHref: '/p', qa });
  const shown = text(body);
  const order = ['Needs you', 'FAIL QA failed', 'What happened', 'What Implement changed, in plain words See the diff', 'Read more', 'What QA checked', 'Open the QA report', ' App ', 'The plan', 'Ticket'];

  expect(order.every((one) => shown.includes(one))).toBe(true);
  expect(order.map((one) => shown.indexOf(one))).toEqual(order.map((one) => shown.indexOf(one)).toSorted((a, b) => a - b));
  expect(expanded(body, 'qa-checked')).toBe('true');
  expect(expanded(body, 'plan')).toBe('false');
  expect(expanded(body, 'ticket')).toBe('false');
});

// The red box holds the check that failed and its screenshot. The record below keeps every one.
it('puts the failed check and its screenshot in the red box, and every check in the record', () => {
  const reportText = '## 1. Verdict\n\nFAIL\n\n## 2. What QA checked\n\n1. pass: Open the list\n2. fail: Type Pasta, the same recipes show\n   Reason: no recipes\n\n## 3. What was not checked\n\nNothing.\n';
  const screenshots = [{ path: 'qa/1-list.png', name: '1-list.png' }, { path: 'qa/2-pasta.png', name: '2-pasta.png' }];
  const qa = qaOf({ run: { id: 9, state: 'complete', verdict: 'FAIL', verdictReason: 'Typing Pasta finds nothing.' }, report: 'qa/report.md', reportText, screenshots, hasBrowser: true }, { failed: { run: null } });
  const body = draw({ summary: 'It is built.', qa });
  const box = /<section class="failed[^"]*"[\s\S]*?<\/section>/.exec(body)?.[0] ?? '';

  expect(text(box)).toContain('FAIL QA found one problem Typing Pasta finds nothing. 2 Type Pasta, the same recipes show fail, no recipes');
  expect(box).toContain('data-shot="qa/2-pasta.png"');
  expect(box).not.toContain('data-shot="qa/1-list.png"');
  expect(box).not.toContain('Open the list');
  expect(body.match(/data-shot="qa\/1-list.png"/g)).toHaveLength(1);
  expect(body.match(/data-shot="qa\/2-pasta.png"/g)).toHaveLength(2);
});

// The QA run writes a summary too. On a FAIL it only repeats the verdict, so the change shown last is
// the build's.
it('shows the build summary last on a QA FAIL, not the QA run summary', () => {
  const qa = qaOf({ run: { id: 9, state: 'complete', verdict: 'FAIL', verdictReason: 'The list stays empty.' } }, { failed: { run: null } });
  const shown = text(draw({ summary: 'QA failed on the search box.', summaryPhase: 'qa', built: { summary: 'The list has a search box.', phase: 'implement', at: '2026-10-15T10:10:00.000Z' }, now: '2026-10-15T13:10:00.000Z', qa }));

  // The header keeps its time, when the build ended.
  expect(shown).toContain('What Implement changed, in plain words 3 hours ago');
  expect(shown).toContain('The list has a search box.');
  expect(shown).not.toContain('QA failed on the search box.');
});

// A QA FAIL leads with its own panels and keeps the gate out, except for what the output check
// found, which the board card's Check chip links to.
it('draws the gate on a QA FAIL only when the output check found problems', () => {
  const qa = qaOf({ run: { id: 9, state: 'complete', verdict: 'FAIL', verdictReason: 'The list stays empty.' } }, { failed: { run: null } });
  const gate = { phase: 'qa', file: 'qa/report.md', lines: null, questions: [], check: { problems: [], note: null } };

  expect(draw({ qa, gate })).not.toContain('data-gate');
  const body = draw({ qa, gate: { ...gate, check: { problems: [{ file: 'qa/report.md', problem: 'The heading "## 3. What was not checked" is missing.' }], note: null } } });
  expect(body).toContain('data-gate');
  expect(body).toMatch(/<details[^>]*id="output-check"/);
});

it('draws an epic with its progress, its documents and the excerpt of architecture.md', () => {
  const body = draw({
    tasks: [
      { key: 'APP-10', title: 'Store meal plans', done: true },
      { key: 'APP-22', title: 'Build the shopping list', done: false },
    ],
    docs: [
      { label: 'architecture.md', path: 'architecture/architecture.md', screens: null },
      { label: 'Mockups', path: 'mockups/mockups.md', screens: 3 },
    ],
    solution: 'A plan is a new `meal_plans` table.',
    docHref: (path: string) => `/t/APP-4/files?file=${encodeURIComponent(path)}`,
  });
  const shown = text(body);

  expect(shown).toContain('Solution from architecture.md A plan is a new meal_plans table.');
  expect(body).toMatch(/<a class="doc[^"]*" href="\/t\/APP-4\/files\?file=architecture%2Farchitecture.md"/);
  expect(shown).toContain('Mockups 3 screens');
  expect(shown).toContain('Progress 1 of 2 done 1 done 1 in Open Wrap-up opens when all 2 are done.');
  expect(body).toMatch(/role="img" aria-label="1 done, 1 in Open"/);
});

// What changed reads at the page's body size, with the body's line height.
it('draws What changed at the body size', () => {
  const source = readFileSync(new URL('./Overview.svelte', import.meta.url), 'utf8');
  const rule = /div\.big :global\(div\.markdown\) \{([^}]*)\}/.exec(source)?.[1] ?? '';

  expect(rule).toContain('font-size: var(--text-base);');
  expect(rule).toContain('line-height: 1.5;');
  expect(source).not.toContain('--text-lg');
  // Tight under the header: the first paragraph's own top margin would push it about 25px down.
  expect(/div\.big :global\(div\.markdown > :first-child\) \{([^}]*)\}/.exec(source)?.[1]).toContain('margin-top: 0;');
});

// The git compare after a read-only run marks the card. A warning is a neutral box,
// with the diff behind a disclosure.
const BROKE = { phase: 'Research', engine: 'Claude Code', restored: false, diff: 'In /work/recipes:\n+changed', undone: [], left: [] };

it('shows no read-only mark when no run changed files', () => {
  expect(text(draw())).not.toContain('read-only run');
});

it('says a read-only run changed the person\'s folder, with the engine, the phase and the diff', () => {
  const body = draw({ readOnlyBreak: BROKE });
  const shown = text(body);

  expect(shown).toContain('Files changed in your project folder while the Research run on Claude Code went.');
  expect(shown).toContain('Nolzu left the files as they are');
  expect(body).toContain('data-kind="warning"');
  expect(body).toMatch(/<details[^>]*>\s*<summary[^>]*>Show the diff<\/summary>\s*<pre[^>]*>In \/work\/recipes:\n\+changed<\/pre>/);
});

// Behind the wall the run could not write there, so the change is the person's or another program's.
it('says a walled read-only run could not have made the change', () => {
  const shown = text(draw({ readOnlyBreak: { ...BROKE, walled: true } }));

  expect(shown).toContain('The wall kept that run from writing there, so the change came from another program or from you.');
  expect(shown).not.toContain('A read-only run should change nothing');
});

it('says what Nolzu put back in its own checkout, and what it could not', () => {
  const shown = text(draw({ readOnlyBreak: { ...BROKE, phase: 'QA', restored: true, undone: ['Put back src/list.ts.'], left: ['notes.md was already changed before the run, so Nolzu has no copy to put back.'] } }));

  expect(shown).toContain("The QA run on Claude Code changed the card's checkout. A read-only run should change nothing, so Nolzu put it back.");
  expect(shown).toContain('Put back src/list.ts.');
  expect(shown).toContain('Nolzu could not put back everything: notes.md was already changed');
});

// An Implement run that committed or pushed: the sentences in the same neutral box, nothing to undo.
it('shows the commit warning of the newest Implement run in a warning box, and nothing without one', () => {
  const said = 'The implement run made a commit in web (1111111 to 2222222). Nolzu does not commit for you.';
  const body = draw({ commitWarning: said });

  expect(text(body)).toContain(said);
  expect(body).toMatch(/data-commit-warning[^>]*>\s*<div[^>]*data-kind="warning"/);
  expect(draw()).not.toContain('data-commit-warning');
});

// The gate of the phase that ran last: its review block first, its blocking questions with the choice,
// and the output check as a badge with its list.
const GATE = {
  phase: 'refine',
  file: 'refine/refined.md',
  lines: ['- Concluded: a search box filters the list by title.', '- Decide: Q1, match ingredients too? Default: no.'],
  questions: [
    { id: 'Q1', question: 'Should the search also match ingredients?', answer: 'no, titles only', settled: null },
    { id: 'Q3', question: 'Which page shows it first?', answer: null, settled: null },
    { id: 'Q4', question: 'Keep the text on reload?', answer: 'no', settled: 'Q4: Keep the text on reload? I take the default: no.' },
  ],
  check: { problems: [{ file: 'refine/refined.md', problem: 'The heading "## Scope" is missing.' }], note: 'This phase ran with the project instructions in .nolzu/phases/refine.md.' },
};

it('draws the review block under the summary, with the forced choice and the check', () => {
  const body = draw({ summary: 'Clearer now.', gate: GATE, docHref: (path: string) => `/t/APP-1/files?file=${path}` });
  const shown = text(body);

  // It waits on the person, so it sits in Needs you, above the summary.
  expect(shown.indexOf('Needs you')).toBeLessThan(shown.indexOf('Before you approve'));
  expect(shown.indexOf('Before you approve')).toBeLessThan(shown.indexOf('What changed, in plain words'));
  expect(body).toMatch(/<div class="gate[^"]*\bpanel\b/);
  expect(shown).toContain('from Refine');
  expect(body).toMatch(/<a[^>]*href="\/t\/APP-1\/files\?file=refine\/refined.md"[^>]*>Open refined.md<\/a>/);
  expect(shown).toContain('- Concluded: a search box filters the list by title.');
  // Q1 has a default to take, Q3 none, so it offers an answer alone, and Q4 is settled.
  expect(body.match(/data-take-default/g)?.length).toBe(1);
  expect(body.match(/data-write-choice/g)?.length).toBe(2);
  expect(shown).toContain('The next move waits on this choice. Default: no, titles only.');
  expect(shown).toContain('Default: none given, so write an answer.');
  expect(shown).toContain('Settled, the next phase reads it: Q4: Keep the text on reload? I take the default: no.');
  expect(shown).toContain('Check 1 part of what Refine wrote is not in the shape its skill asks for');
  expect(shown).toContain('refine/refined.md The heading "## Scope" is missing.');
  expect(shown).toContain('.nolzu/phases/refine.md');
});

it('says a file from before the review block has none, and draws no gate on a closed card', () => {
  expect(text(draw({ gate: { ...GATE, lines: null, questions: [], check: null } }))).toContain('refined.md has no review block.');
  expect(draw({ gate: { ...GATE, check: { problems: [], note: null } } })).not.toContain('data-output-check');
  expect(draw({ gate: null })).not.toContain('data-gate');
});

// Once every question is settled the gate needs no answer: no box, and it folds to its header.
it('folds the gate to its header with no box once every question is settled', () => {
  const settled = { ...GATE, questions: [GATE.questions[2]!] };
  const body = draw({ gate: settled });

  expect(body).not.toMatch(/<div class="gate[^"]*\bpanel\b/);
  expect(expanded(body, 'gate')).toBe('false');
  expect(body).toMatch(/<p class="peek[^"]*">Concluded: a search box filters the list by title.<\/p>/);
});

// The answers start nothing: the next column's run reads them. Once all are settled the gate says so and
// offers that move, and only while the card can make it.
it('says the next column gets the answers once every question is settled, and offers to start it', () => {
  const settled = { ...GATE, questions: [GATE.questions[2]!] };

  const shown = text(draw({ gate: settled, gateNext: 'Plan' }));
  expect(shown).toContain('All answered. Plan gets your answers when you move the card.');
  expect(draw({ gate: settled, gateNext: 'Plan' })).toMatch(/<button[^>]*data-gate-start[^>]*>[\s\S]*?Start Plan/);
  expect(text(draw({ gate: settled, gateNext: null }))).not.toContain('All answered');
  expect(text(draw({ gate: GATE, gateNext: 'Plan' }))).not.toContain('All answered');
});

// The three zones: what needs you, what happened, then what to read. A zone with nothing in it is
// not drawn.
it('labels the three zones, and draws no Needs you when nothing waits on the person', () => {
  const asks = text(draw({ blocked: BLOCKED, summary: 'Clearer now.' }));
  const order = ['Needs you', 'Titles only, or ingredients too?', 'What happened', 'What changed, in plain words', 'Read more', 'Ticket'];

  expect(order.map((one) => asks.indexOf(one))).toEqual(order.map((one) => asks.indexOf(one)).toSorted((a, b) => a - b));
  expect(asks.indexOf('Needs you')).toBeGreaterThan(-1);
  const quiet = text(draw({ summary: 'Clearer now.' }));
  expect(quiet).not.toContain('Needs you');
  expect(quiet).toContain('What happened');
  expect(quiet).toContain('Read more');
});

// Plan and Implement work from the plan, so it starts open there and folded after.
it('opens the plan when the page says so, and folds it with a preview of its steps otherwise', () => {
  expect(expanded(draw({ plan: PLAN, planOpen: true }), 'plan')).toBe('true');
  const folded = draw({ plan: PLAN });

  expect(expanded(folded, 'plan')).toBe('false');
  // Each step is a sentence, so the preview reads them as sentences and never as "recipes., An".
  expect(folded).toMatch(/<p class="peek[^"]*">Add a q option to GET \/recipes\. An empty box shows every recipe again\.<\/p>/);
});

it('folds the related cards with their keys and titles as the preview', () => {
  const body = draw({ related: [{ key: 'APP-4', title: 'Sort recipes' }, { key: 'APP-7', title: 'Search by ingredient' }] });

  expect(text(body)).toContain('Related 2 cards APP-4 Sort recipes, APP-7 Search by ingredient');
  expect(expanded(body, 'related')).toBe('false');
});

// Why the open pull requests cannot merge: each reason on its own line with its links, and when it was
// read. A card with several pull requests names each repository.
it('lists why the pull request cannot merge with its links and when it was read', () => {
  const read = { blockers: [{ kind: 'checks' as const, failed: [{ name: 'build', url: 'https://ci.example.com/build' }] }, { kind: 'behind' as const, base: 'main' }], running: true };
  const body = draw({ now: '2026-11-01T10:02:00Z', merge: [{ repo: 'cook/recipes', number: 12, url: 'https://github.com/cook/recipes/pull/12', read, at: '2026-11-01T10:00:00Z' }] });

  expect(body).toContain('Why it cannot merge');
  expect(body).toMatch(/<li data-blocker="checks">[^<]*1 check failed:[\s\S]*?<a class="link[^"]*" href="https:\/\/ci\.example\.com\/build"/);
  // The space before a link is the page's own, not one a tag stands for.
  expect(body.replace(/<!--[^>]*-->/g, '').replace(/<[^>]*>/g, '')).toContain('1 check failed: build');
  expect(text(body)).toContain('main moved on, and this repository wants the branch up to date first');
  expect(text(body)).toContain('Checks are still running');
  expect(text(body)).toMatch(/read 2 minutes ago/);
  // One pull request is not named: the block is about it.
  expect(text(body)).not.toContain('cook/recipes#12');
});

it('names each repository of a card with several pull requests', () => {
  const at = '2026-11-01T10:00:00Z';
  const body = draw({
    merge: [
      { repo: 'cook/recipes', number: 12, url: null, read: { blockers: [{ kind: 'draft' }], running: false }, at },
      { repo: 'cook/api', number: 3, url: null, read: { blockers: [{ kind: 'blocked', url: 'https://github.com/cook/api/pull/3' }], running: false }, at },
      { repo: 'cook/web', number: 4, url: null, read: { blockers: [], running: false }, at },
    ],
  });

  expect(body).toContain('href="https://github.com/cook/recipes/pull/12"');
  expect(text(body)).toContain('cook/recipes#12');
  expect(text(body)).toContain('cook/api#3');
  expect(text(body)).toContain('GitHub blocks the merge for a reason it does not name here Open the pull request');
  // Nothing blocks the third, so it is not named.
  expect(text(body)).not.toContain('cook/web#4');
});

it('draws no merge block when nothing blocks', () => {
  expect(draw({ merge: [{ repo: 'cook/recipes', number: 12, url: null, read: { blockers: [], running: false }, at: '2026-11-01T10:00:00Z' }] })).not.toContain('Why it cannot merge');
  expect(draw()).not.toContain('Why it cannot merge');
});
