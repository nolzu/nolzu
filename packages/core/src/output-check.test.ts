import { describe, expect, it } from 'vitest';
import { checkedPaths, checkOutputs, gateFile, gateOf, outputCheck } from './output-check.ts';

// The shapes today's skills ask for. Each test breaks one thing in a clean set.
const REFINED = `# APP-1: Search the recipe list
Kind: feature
Branch: recipe-search

## Before you approve

- Concluded: a search box filters the list by title.
- Decide: Q1, should the search also match ingredients? Default: no.
- Next: Plan turns AC1 and AC2 into steps.

## Problem

The list shows every recipe at once.

## Scope

A search box filters the list by title.

## Assumptions

- A1: The search matches titles only.

## Acceptance checks

- AC1 (must): Typing a word shows only recipes with that word in the title.
  Check: a browser test types a word and counts the rows.
- AC2 (should): Clearing the box shows every recipe again.
  Check: a browser test clears the box.

## Open questions

- Q1: Should the search also match ingredients? Default: no. blocks: no

## What the code does today

Read at: 4f2a91c on 2026-10-24.
- The recipe api returns every row, in \`listRecipes\` (api/src/recipes.ts).

## Rules that apply

None.

## Out of scope

Searching by ingredient.

## Read first

- api/src/recipes.ts: the list the search filters.
`;

const PLAN = `## Before you approve

- Concluded: the api filters the list, and the page asks it as the person types.
- Decide: D1, the api filters, not the page.
- Size: 2 steps, 2 files. AC1 and AC2 each go to a step.
- Next: Implement builds steps 1 and 2.

## Approach

Read at: 4f2a91c on 2026-10-24.
The api filters the list. The page asks it as the person types.

## Decisions

- D1: The api filters the recipes. Not: the page, because the list will grow.

## Steps

1. Add a q option to GET /recipes.
   Files: api/src/recipes.ts
   Tests: an empty query and a title match.
   Check: npm test -- recipes fails first, then passes.
   Undo: revert the file.
   Covers: AC1
2. Put a search box above the list.
   Files: web/src/routes/+page.svelte
   Tests: an empty box shows every recipe.
   Check: npm test -- page passes.
   Undo: revert the page.
   Covers: AC1, AC2

## Risks

A slow list makes the box lag.

## Order

The steps run in their numbers.

## Settled questions

- Q1: titles only, the brief's default.

## Rules that apply

None.

## Not doing

Ingredient search.

## Read first

- api/src/recipes.ts: listRecipes, which step 1 extends.
`;

const CHECKS = `1. Run the project's tests, they pass (from AGENTS.md)
   How: npm test
2. AC1 (must): Type a word, only matching recipes show
   How: the page test from step 2
3. AC2 (should): Clear the box, every recipe shows
`;

const REPORT = `## 1. Verdict

- PASS: every check held, AC1 and AC2 with a screenshot each.
- For you: try a long title on a phone.

## 2. What QA checked

1. pass: Run the project's tests, they pass
   How: npm test
   Evidence: "Tests 12 passed"
2. pass: AC1 (must): Type a word, only matching recipes show
   How: typed "soup" in the browser
   Evidence: qa/evidence/2-soup.png, 3 rows show
3. pass: AC2 (should): Clear the box, every recipe shows
   How: cleared the box
   Evidence: qa/evidence/3-cleared.png, 12 rows show

## 3. What was not checked

Nothing.
`;

const PROGRESS = `Base: 4f2a91c

## Before you approve

- Concluded: both steps are done, and the list filters by title as you type.
- Deviations: 1, step 2 waits 300 ms. It changes no criterion.
- Surprises: none.
- QA first: AC1, type a word and count the rows.
- Tests: added api/test/recipes.test.ts, changed none, deleted none. No assertion was weakened.
- Not checked: the mobile layout, because no browser ran.

## Steps done

1. Added the q option to GET /recipes.
   Red: npm test -- recipes: "FAIL matches part of a word"
   Green: npm test -- recipes: "Tests 3 passed (3)"
2. Put the search box above the list.
   Check: npm test: "Tests 12 passed (12)"
- Fix: QA failed AC2, a cleared box kept the filter.
   Red: npm test -- page: "FAIL shows every recipe when cleared"
   Green: npm test -- page: "Tests 4 passed (4)"
`;

const PR = `Search recipes by title

## What changed

GET /recipes takes a q option, and the list page has a search box.

## How to test

npm test -- recipes
`;

const DEVIATIONS = '- Step 2: the box waits 300 ms, not 200 ms. Why: the list page already waits 300 ms. If wrong: the box feels slow, one constant to change.\n';

const SUMMARY = 'The list has a search box now.\n';
// The two files for other people, which every Implement run writes.
const SHARE = { 'share/SUMMARY.md': 'The recipe list has a search box.\n', 'share/TESTING.md': 'Open the recipe list and type bean.\n' };

const ARCHITECTURE = `## Before you approve

- Concluded: the api filters the recipes by title, and the web page asks it as the person types.
- Decide: D1, the api filters, not the page.
- Open: Q2, should the search match tags too? Default: no.
- Next: Design draws the search box, and Plan cuts the tasks.

## The shape

Read at: 4f2a91c on 2026-10-24.
The api takes a q option and filters by title.

## The pieces

- Recipe api: owns the list and its filter.

## Where they meet

The web page calls GET /recipes with q.

## Interfaces

- GET /recipes?q=<text>: 200 with Recipe[], the cross-origin header as today.

## The data

The query text crosses. Nothing new is stored.

## The decisions

- D1: The api filters the recipes. Not: the page, because the list will grow. Keep: GET /recipes with no q.

## What is still open

- Q2: Should the search match tags too? Default: no. blocks: no

## Touch points

| Piece | File or module | What changes |
|---|---|---|
| Recipe api | api/src/recipes.ts | takes q |

## Test surfaces

api/test/recipes.test.ts, copying the list test.

## Not doing

Paging. AC2 is the page's.

## Read first

- api/src/recipes.ts: listRecipes, which the filter extends.
`;

const DESIGN = `## Before you approve

- Concluded: the recipe list gains a search box.
- Screens: recipe-list.html, Q3.
- Next: Plan builds the screen with its states.

## Screens

Read at: 4f2a91c on 2026-10-24.
Tokens: from web/src/app.css.

### recipe-list.html

The recipe list, which a cook opens to find one recipe.
Address: / as today.
States:
- With matches (AC1): the rows whose title holds the text.
- No match (AC1, AC2): "No recipe has cake in its title."
Data: GET /recipes?q=<text>, a Recipe[].
Reuse: the row markup of renderList (web/src/list.ts).
Question: Q3: Should the empty sentence offer a button? Default: no. blocks: no

## Not doing

Tags.

## Read first

- web/src/list.ts: renderList, which draws the rows.
`;

const ANSWER = `The web page filters the recipe list in the browser, and the api returns every recipe.

Confidence: high, because the page and the route were both read.

## Why

The page keeps the list it fetched and filters it on each key press (web/src/list.ts, renderList). The route takes no query (api/src/recipes.ts, listRecipes).

## Searched and not found

- a query parameter on the recipes route, in api/src/server.ts

## If this becomes a card

Problem: the filter runs in the browser, so the api sends every recipe on each load.
- AC1 (must): The api answers only the recipes whose title holds the query.
  Check: a request to /recipes?q=bean counts the rows.
- Q1: Should the page keep its own filter? Default: no. blocks: no
Change: api/src/recipes.ts listRecipes, web/src/list.ts renderList.

## Sources

- web/src/list.ts:14 renderList filters the list
`;

const INVESTIGATION = `The route hands the page no list when the data file is empty.

Confidence: medium, because the empty file was read in the code and not run.

## What was reported

The recipe page is blank after the data file is cleared.

## What was found

The page shows no rows and no error.

## Hypotheses tried

- The page hides a failed fetch. Result: ruled out. web/src/list.ts:20 draws an error box on a failed fetch.
- The route answers nothing for an empty file. Result: held. api/src/server.ts:31 returns the parse of an empty string.

## The fix or next step

Answer an empty list for an empty file, in api/src/server.ts, readRecipes.

## Searched and not found

Nothing.

## Sources

- api/src/server.ts:31 the route
`;

const ASSESSMENT = `# Assessment

## The evidence

src/recipes/rating.ts:31 divides the sum of the votes by their count.

## The likely cause

The average is worked out before the vote list is checked.
Confidence: high, because the line divides with no check before it.
What would change it: a vote list that is never empty in the data.

## The proposal

Return no rating for a recipe with no vote, in src/recipes/rating.ts.

## The effort

Under an hour.

## The risks

The list draws the rating, so an empty one has to read as empty there.
`;

const ROUND = 'issue: api/src/recipes.ts:12\nThe match is case sensitive. Lower case both sides.\n\npraise: api/src/recipes.ts:20\nThe filter is pure.\n';
const reviewSummary = (verdict: string, findings: string, more = '') => `Verdict: ${verdict}. The search misses recipes when the case differs.\nFindings: ${findings}.\n${more}Not reviewed: nothing, the whole diff was read.\n`;
const REVIEW_SUMMARY = reviewSummary('changes needed', '1 issue, 1 praise');

const problemsOf = (phase: string, files: Record<string, string>) => (checkOutputs(phase, files) ?? []).map((one) => `${one.file}: ${one.problem}`);

describe('a clean set', () => {
  it.each([
    ['refine', { 'refine/refined.md': REFINED, 'refine/summary.md': SUMMARY }],
    ['plan', { 'refine/refined.md': REFINED, 'plan/plan.md': PLAN, 'qa/checks.md': CHECKS, 'plan/summary.md': SUMMARY }],
    ['architecture', { 'refine/refined.md': REFINED, 'architecture/architecture.md': ARCHITECTURE, 'architecture/summary.md': SUMMARY }],
    ['design', { 'refine/refined.md': REFINED, 'architecture/architecture.md': ARCHITECTURE, 'design/design.md': DESIGN, 'design/summary.md': SUMMARY }],
    ['design', { 'design/design.md': DESIGN.replace(/## Screens[\s\S]*?## Not doing/, '## Screens\n\nRead at: 4f2a91c on 2026-10-24.\nNone, because the epic moves data only.\n\n## Not doing'), 'design/summary.md': SUMMARY }],
    ['qa', { 'qa/checks.md': CHECKS, 'qa/report.md': REPORT, 'qa/summary.md': SUMMARY }],
    ['implement', { 'implement/progress.md': PROGRESS, 'implement/pr.md': PR, 'implement/deviations.md': DEVIATIONS, 'implement/summary.md': SUMMARY, ...SHARE }],
    ['implement', { 'implement/progress.md': PROGRESS, 'implement/pr.md': PR, 'implement/deviations.md': 'None.\n', 'implement/summary.md': SUMMARY, ...SHARE }],
    ['pr-review', { 'pr-review/round.md': ROUND, 'pr-review/summary.md': REVIEW_SUMMARY }],
    ['research', { 'research/answer.md': ANSWER, 'research/summary.md': SUMMARY }],
    ['research', { 'research/answer.md': ANSWER.replace(/## If this becomes a card[\s\S]*?## Sources/, '## Sources'), 'research/summary.md': SUMMARY }],
    ['investigate', { 'investigate/report.md': INVESTIGATION, 'investigate/summary.md': SUMMARY }],
    ['assess', { 'assess/assessment.md': ASSESSMENT, 'assess/summary.md': SUMMARY }],
  ])('finds nothing wrong in %s', (phase, files) => {
    expect(problemsOf(phase, files)).toEqual([]);
  });

  it('has no rules for an Ask or a pass, so it checks nothing there', () => {
    expect(checkOutputs('ask', {})).toBeNull();
    expect(checkOutputs('extract-summary', {})).toBeNull();
  });
});

describe('the structure', () => {
  it('names a missing main file and a missing summary, and checks nothing else in the file it lacks', () => {
    expect(problemsOf('refine', {})).toEqual(['refine/refined.md: The file is missing.', 'refine/summary.md: The file is missing.']);
  });

  it('names an empty summary', () => {
    expect(problemsOf('refine', { 'refine/refined.md': REFINED, 'refine/summary.md': '  \n' })).toEqual(['refine/summary.md: The file is empty.']);
  });

  it('names a missing heading and a required section with nothing under it', () => {
    const files = { 'refine/refined.md': REFINED.replace('## Scope\n\nA search box filters the list by title.\n\n', '').replace('Searching by ingredient.\n', ''), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', files)).toEqual(['refine/refined.md: The heading "## Scope" is missing.', 'refine/refined.md: The section "## Out of scope" is empty.']);
  });

  it('takes a heading in another case or spacing, as the pages that read it do', () => {
    const files = { 'refine/refined.md': REFINED.replace('## Out of scope', '## Out of Scope').replace('## Read first', '##  Read first '), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', files)).toEqual([]);
  });

  it('takes a deeper heading as content, and stops a section at the next second-level heading', () => {
    const files = { 'refine/refined.md': REFINED.replace('Searching by ingredient.\n', '### Later\n'), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', files)).toEqual([]);
  });

  it('names every file the skill says it writes', () => {
    expect(problemsOf('implement', { 'implement/summary.md': SUMMARY })).toEqual([
      'implement/progress.md: The file is missing.',
      'implement/pr.md: The file is missing.',
      'implement/deviations.md: The file is missing.',
      'share/SUMMARY.md: The file is missing.',
      'share/TESTING.md: The file is missing.',
    ]);
    // QA and the wrap-up correct the share files and are not held to them.
    expect(checkedPaths('qa')).not.toContain('share/TESTING.md');
    expect(checkedPaths('wrapup')).not.toContain('share/SUMMARY.md');
    expect(problemsOf('plan', { 'refine/refined.md': REFINED, 'plan/plan.md': PLAN, 'plan/summary.md': SUMMARY })).toEqual(['qa/checks.md: The file is missing.']);
  });

  // An epic's Plan writes the plan colleagues read, and a Delivery Plan writes none.
  it('holds the plan of an epic to the plan for other people, and no other board', () => {
    const files = { 'refine/refined.md': REFINED, 'plan/plan.md': PLAN, 'qa/checks.md': CHECKS, 'plan/summary.md': SUMMARY };
    expect(problemsOf('plan', files)).toEqual([]);
    expect(problemsOf('plan', files)).toEqual((checkOutputs('plan', files, 'delivery') ?? []).map((one) => `${one.file}: ${one.problem}`));
    expect((checkOutputs('plan', files, 'epics') ?? []).map((one) => `${one.file}: ${one.problem}`)).toEqual(['share/PLAN.md: The file is missing.']);
    const shared = { ...files, 'share/PLAN.md': 'A search box.\n\n## Tasks\n\n### 1. Filter by title\nThe api filters.\n' };
    expect(checkOutputs('plan', shared, 'epics')).toEqual([]);
    expect(checkOutputs('plan', { ...files, 'share/PLAN.md': 'A search box.\n' }, 'epics')).toEqual([{ file: 'share/PLAN.md', problem: 'The heading "## Tasks" is missing.' }]);
    expect(checkedPaths('plan', 'epics')).toContain('share/PLAN.md');
    expect(checkedPaths('plan')).not.toContain('share/PLAN.md');
  });

  it('names a main file of more than 300 lines', () => {
    const long = `${REFINED}${'More.\n'.repeat(300)}`;
    expect(problemsOf('refine', { 'refine/refined.md': long, 'refine/summary.md': SUMMARY })).toEqual(['refine/refined.md: The file has 349 lines, more than about 300 a person reads at a gate.']);
  });

  it('names placeholder text from the skill left in, outside code', () => {
    const files = { 'refine/refined.md': REFINED.replace('# APP-1: Search the recipe list', '# <KEY>: <title of at most 80 characters>').replace('The recipe api', 'The `<card folder>` api'), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', files)).toEqual(['refine/refined.md: Placeholder text is left in: "<KEY>", "<title of at most 80 characters>".']);
  });

  it('leaves a plain HTML tag alone', () => {
    const files = { 'refine/refined.md': REFINED.replace('A search box filters', 'An <input type=search> filters'), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', files)).toEqual([]);
  });
});

describe('the ids', () => {
  it('names an id that breaks its pattern and one that repeats', () => {
    const files = {
      'refine/refined.md': REFINED.replace('- A1: The search matches titles only.', '- A1: The search matches titles only.\n- The page filters, not the api.').replace('- AC2 (should): Clearing', '- AC1 (should): Clearing'),
      'refine/summary.md': SUMMARY,
    };
    expect(problemsOf('refine', files)).toEqual([
      'refine/refined.md: A line under "## Assumptions" does not start with its id (A1, A2 and on): "- The page filters, not the api."',
      'refine/refined.md: The id AC1 is used twice.',
    ]);
  });

  it('names a criterion with no level or no Check line', () => {
    const files = { 'refine/refined.md': REFINED.replace('- AC1 (must): Typing', '- AC1: Typing').replace('  Check: a browser test clears the box.\n', ''), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', files)).toEqual(['refine/refined.md: AC1 has no level after its id, (must) or (should).', 'refine/refined.md: AC2 has no "Check:" line under it.']);
  });

  // The check is there, on the criterion's own line, so the brief is not flagged for it.
  it('takes a Check written on the criterion line', () => {
    const inline = REFINED.replace('in the title.\n  Check: a browser', 'in the title. Check: a browser');
    expect(inline).not.toBe(REFINED);
    expect(problemsOf('refine', { 'refine/refined.md': inline, 'refine/summary.md': SUMMARY })).toEqual([]);
  });

  it('names a question with no id, no default or no blocks word, and a fourth question', () => {
    const q = (n: number) => `- Q${n}: Question ${n}? Default: yes. blocks: no`;
    const four = { 'refine/refined.md': REFINED.replace('- Q1: Should the search also match ingredients? Default: no. blocks: no', [1, 2, 3, 4].map(q).join('\n')), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', four)).toEqual(['refine/refined.md: There are 4 open questions, more than 3. A fourth becomes an assumption with its default.']);
    const three = { 'refine/refined.md': REFINED.replace('- Q1: Should the search also match ingredients? Default: no. blocks: no', [1, 2, 3].map(q).join('\n')), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', three)).toEqual([]);
    const broken = { 'refine/refined.md': REFINED.replace('- Q1: Should the search also match ingredients? Default: no. blocks: no', '- Q1: Match tags too?\n- Match ingredients? Default: no. blocks: yes'), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', broken)).toEqual([
      'refine/refined.md: A line under "## Open questions" does not start with its id (Q1, Q2 and on): "- Match ingredients? Default: no. blocks: yes"',
      'refine/refined.md: The question Q1 names no "Default:".',
      'refine/refined.md: The question Q1 does not end with "blocks: yes" or "blocks: no".',
    ]);
  });

  it('takes "None." for no questions, and asks for the commit the brief read', () => {
    const none = { 'refine/refined.md': REFINED.replace('- Q1: Should the search also match ingredients? Default: no. blocks: no', 'None.'), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', none)).toEqual([]);
    const unread = { 'refine/refined.md': REFINED.replace('Read at: 4f2a91c on 2026-10-24.\n', ''), 'refine/summary.md': SUMMARY };
    expect(problemsOf('refine', unread)).toEqual(['refine/refined.md: "## What the code does today" has no "Read at:" line.']);
  });

  // The brief Refine wrote before this format still has a reader in the app, but a new run of it
  // is told what the format lacks.
  it('names what a brief in the old shape lacks', () => {
    const old = `# APP-1: Search\n\n## Problem\n\nA.\n\n## Scope\n\nB.\n\n## Assumptions\n\n- A1: C.\n\n## Acceptance checks\n\n- AC1: D.\n\n## Out of scope\n\nE.\n\n## Open questions\n\nNone.\n\n## Likely touched areas\n\nF.\n`;
    expect(problemsOf('refine', { 'refine/refined.md': old, 'refine/summary.md': SUMMARY })).toEqual([
      'refine/refined.md: The heading "## Before you approve" is missing.',
      'refine/refined.md: The heading "## What the code does today" is missing.',
      'refine/refined.md: The heading "## Rules that apply" is missing.',
      'refine/refined.md: The heading "## Read first" is missing.',
      'refine/refined.md: AC1 has no level after its id, (must) or (should).',
      'refine/refined.md: AC1 has no "Check:" line under it.',
      'refine/refined.md: "## What the code does today" has no "Read at:" line.',
    ]);
  });
});

describe('the plan', () => {
  const planFiles = (plan: string, checks = CHECKS) => ({ 'refine/refined.md': REFINED, 'plan/plan.md': plan, 'qa/checks.md': checks, 'plan/summary.md': SUMMARY });

  it('names a cited criterion the brief does not have', () => {
    expect(problemsOf('plan', planFiles(PLAN.replace('Covers: AC1, AC2', 'Covers: AC1, AC2, AC9')))).toEqual(['plan/plan.md: Step 2 covers AC9, which the brief does not have.']);
  });

  it('names a criterion no step covers unless Not doing names it', () => {
    const uncovered = PLAN.replace('Covers: AC1, AC2', 'Covers: AC1');
    expect(problemsOf('plan', planFiles(uncovered))).toEqual(['plan/plan.md: No step covers AC2, and "## Not doing" does not name it.']);
    expect(problemsOf('plan', planFiles(uncovered.replace('Ingredient search.', 'Ingredient search. AC2 waits for the next card.')))).toEqual([]);
  });

  it('names a criterion with no line in the QA checks, and a check that cites one the brief lacks', () => {
    expect(problemsOf('plan', planFiles(PLAN, CHECKS.replace('3. AC2 (should): Clear', '3. AC7: Clear')))).toEqual([
      'qa/checks.md: No check names AC2.',
      'qa/checks.md: A check names AC7, which the brief does not have.',
    ]);
  });

  // A task of an epic names the epic check each of its own serves, which is not a criterion of its brief.
  it("leaves an id under another card's key alone", () => {
    expect(problemsOf('plan', planFiles(PLAN, CHECKS.replace('3. AC2 (should): Clear the box', '3. AC2 (should): Clear the box (serves APP-5 AC7)')))).toEqual([]);
    expect(problemsOf('plan', planFiles(PLAN, CHECKS.replace('3. AC2 (should): Clear the box', '3. AC2 (should): Clear the box, as From APP-5: AC7 asks')))).toEqual([]);
  });

  // A task's ticket copies a decision by its id, so the plan's D1 beside the architecture's D1 would
  // hand every task the architecture's.
  it("names a decision id the epic's architecture already gives", () => {
    const epic = { ...planFiles(PLAN), 'architecture/architecture.md': ARCHITECTURE };
    expect(problemsOf('plan', epic)).toEqual(['plan/plan.md: The decision D1 has an id the architecture already gives a decision. Go on from its last D id.']);
    expect(problemsOf('plan', { ...epic, 'plan/plan.md': PLAN.replaceAll('D1', 'D2') })).toEqual([]);
  });

  it('skips the brief checks when the card has no brief', () => {
    expect(problemsOf('plan', { 'plan/plan.md': PLAN.replace('Covers: AC1, AC2', 'Covers: AC9'), 'qa/checks.md': CHECKS, 'plan/summary.md': SUMMARY })).toEqual([]);
  });

  it('names a step with no Check line, a decision with no id, and an Approach with no commit', () => {
    const broken = PLAN.replace('   Check: npm test -- page passes.\n', '').replace('- D1: The api', '- The api').replace('Read at: 4f2a91c on 2026-10-24.\n', '');
    expect(problemsOf('plan', planFiles(broken))).toEqual([
      'plan/plan.md: Step 2 has no "Check:" line.',
      'plan/plan.md: A line under "## Decisions" does not start with its id (D1, D2 and on): "- The api filters the recipes. Not: the page, because the list will grow."',
      'plan/plan.md: "## Approach" has no "Read at:" line.',
    ]);
  });

  it('names a check that drops or changes the level its criterion has in the brief', () => {
    const checks = CHECKS.replace('AC1 (must):', 'AC1:').replace('AC2 (should):', 'AC2 (must):');
    expect(problemsOf('plan', planFiles(PLAN, checks))).toEqual([
      'qa/checks.md: The check for AC1 does not carry its level from the brief, "AC1 (must):".',
      'qa/checks.md: The check for AC2 does not carry its level from the brief, "AC2 (should):".',
    ]);
  });

  // A brief from before the levels gives a check nothing to carry, so a check without one is fine.
  it('asks no level of a check when the brief has none', () => {
    const oldBrief = REFINED.replace('AC1 (must):', 'AC1:').replace('AC2 (should):', 'AC2:');
    const checks = CHECKS.replace('AC1 (must):', 'AC1:').replace('AC2 (should):', 'AC2:');
    expect(problemsOf('plan', { ...planFiles(PLAN, checks), 'refine/refined.md': oldBrief })).toEqual([]);
  });

  // A plan written before this format still reads as steps on the card, but a new run of it is told
  // what the format lacks.
  it('names what a plan and checks in the old shape lack', () => {
    const old = `## Approach\n\nA.\n\n## Steps\n\n1. Add it.\n   Files: a.ts\n   Covers: AC1, AC2\n\n## Not doing\n\nB.\n\n## Risks\n\nC.\n\n## Order\n\nD.\n\n## Settled questions\n\nNone.\n`;
    expect(problemsOf('plan', planFiles(old, '1. AC1: Type a word\n2. AC2: Clear the box\n'))).toEqual([
      'plan/plan.md: The heading "## Before you approve" is missing.',
      'plan/plan.md: The heading "## Decisions" is missing.',
      'plan/plan.md: The heading "## Rules that apply" is missing.',
      'plan/plan.md: The heading "## Read first" is missing.',
      'plan/plan.md: Step 1 has no "Check:" line.',
      'plan/plan.md: "## Approach" has no "Read at:" line.',
      'qa/checks.md: The check for AC1 does not carry its level from the brief, "AC1 (must):".',
      'qa/checks.md: The check for AC2 does not carry its level from the brief, "AC2 (should):".',
    ]);
  });

  it('names a numbered line outside the steps', () => {
    expect(problemsOf('plan', planFiles(PLAN.replace('A slow list makes the box lag.', '1. A slow list makes the box lag.')))).toEqual(['plan/plan.md: A numbered line outside "## Steps" reads as a step: "1. A slow list makes the box lag."']);
  });
});

describe('the architecture', () => {
  const files = (architecture: string) => ({ 'refine/refined.md': REFINED, 'architecture/architecture.md': architecture, 'architecture/summary.md': SUMMARY });

  it('names a decision with no id or no option turned down, and a question with no default', () => {
    const broken = ARCHITECTURE.replace('- D1: The api filters the recipes. Not: the page, because the list will grow.', '- D1: The api filters the recipes.\n- The page asks again as the person types. Not: a button.').replace('Default: no. blocks: no', 'blocks: no');
    expect(problemsOf('architecture', files(broken))).toEqual([
      'architecture/architecture.md: A line under "## The decisions" does not start with its id (D1, D2 and on): "- The page asks again as the person types. Not: a button. Keep: GET /recipes with no q."',
      'architecture/architecture.md: The decision D1 names no option turned down, "Not:".',
      'architecture/architecture.md: The question Q2 names no "Default:".',
    ]);
  });

  // The plan settles each open question by its id, so an architecture's Q1 beside the brief's Q1 is two
  // questions under one name.
  it('names a question id the brief already has, and a criterion the brief does not have', () => {
    const broken = ARCHITECTURE.replace('- Q2: Should', '- Q1: Should').replace('Paging. AC2', 'Paging. AC7');
    expect(problemsOf('architecture', files(broken))).toEqual([
      'architecture/architecture.md: The question Q1 has an id the brief already gives a question. Go on from its last Q id.',
      'architecture/architecture.md: AC7 is cited, and the brief has no such criterion.',
    ]);
  });

  it('names what an architecture in the old shape lacks', () => {
    const old = ARCHITECTURE.replace(/## Before you approve[\s\S]*?## The shape/, '## The shape').replace('Read at: 4f2a91c on 2026-10-24.\n', '').replace(/## Interfaces\n\n.*\n\n/, '').replace('- D1: The api', '- The api').replace(/## Not doing[\s\S]*$/, '');
    expect(problemsOf('architecture', files(old))).toEqual([
      'architecture/architecture.md: The heading "## Before you approve" is missing.',
      'architecture/architecture.md: The heading "## Interfaces" is missing.',
      'architecture/architecture.md: The heading "## Not doing" is missing.',
      'architecture/architecture.md: The heading "## Read first" is missing.',
      'architecture/architecture.md: "## The shape" has no "Read at:" line.',
      'architecture/architecture.md: A line under "## The decisions" does not start with its id (D1, D2 and on): "- The api filters the recipes. Not: the page, because the list will grow. Keep: GET /recipes with no q."',
    ]);
  });
});

describe('the design', () => {
  const files = (design: string) => ({ 'refine/refined.md': REFINED, 'architecture/architecture.md': ARCHITECTURE, 'design/design.md': design, 'design/summary.md': SUMMARY });

  it('names a screen with no address, no states or no data, and a criterion the brief does not have', () => {
    const broken = DESIGN.replace('Address: / as today.\n', '').replace('Data: GET /recipes?q=<text>, a Recipe[].\n', '').replace('No match (AC1, AC2)', 'No match (AC1, AC5)');
    expect(problemsOf('design', files(broken))).toEqual([
      'design/design.md: The screen recipe-list.html has no "Address:" line.',
      'design/design.md: The screen recipe-list.html has no "Data:" line.',
      'design/design.md: AC5 is cited, and the brief has no such criterion.',
    ]);
    const stateless = DESIGN.replace(/States:\n(- .*\n)+/, 'States: all of them.\n');
    const noState = 'design/design.md: The screen recipe-list.html names no state as a "- <state> (<ids>): ..." line under "States:".';
    expect(problemsOf('design', files(stateless))).toEqual([noState]);
    expect(problemsOf('design', files(DESIGN.replace('States:\n', 'States:\nTwo of them.\n')))).toEqual([noState]);
    expect(problemsOf('design', files(DESIGN.replace('States:\n', 'States:\n\n')))).toEqual([]);
    expect(problemsOf('design', files(DESIGN.replace('States:\n', '')))).toEqual(['design/design.md: The screen recipe-list.html has no "States:" line.']);
  });

  it('names a question with no default, and one whose id the architecture already has', () => {
    const broken = DESIGN.replace('Question: Q3: Should the empty sentence offer a button? Default: no. blocks: no', 'Question: Q2: Should the empty sentence offer a button? blocks: no');
    expect(problemsOf('design', files(broken))).toEqual([
      'design/design.md: The question Q2 names no "Default:".',
      'design/design.md: The question Q2 has an id the architecture already gives a question. Go on from its last Q id.',
    ]);
  });

  // The plan settles each question by its id, so one with none, or two with one id, leave it guessing.
  it('names a question with no Q id or a Q id used twice, and takes a screen that asks nothing', () => {
    expect(problemsOf('design', files(DESIGN.replace('Question: Q3: ', 'Question: ')))).toEqual(['design/design.md: A screen\'s question has no Q id: "Should the empty sentence offer a button?"']);
    const twice = DESIGN.replace('## Not doing', '### recipe-page.html\n\nOne recipe.\nAddress: #/recipes/<id>.\nStates:\n- Found (AC1): the title.\nData: GET /recipes/<id>.\nQuestion: Q3: Show the minutes? Default: yes. blocks: no\n\n## Not doing');
    expect(problemsOf('design', files(twice))).toEqual(['design/design.md: The id Q3 is used twice.']);
    expect(problemsOf('design', files(DESIGN.replace(/Question: Q3: .*/, 'Question: none, the screen only shows the list.')))).toEqual([]);
  });

  // The list of screens the design skill asked for before this format still opens on the Files tab,
  // but a new run of it is told what the format lacks.
  it('names what a design list in the old shape lacks', () => {
    const old = '- main-page.html: the recipe list with the search box. States: with recipes, empty. Covers AC1, AC2. Question: should the empty sentence offer a button?\n';
    expect(problemsOf('design', files(old))).toEqual([
      'design/design.md: The heading "## Before you approve" is missing.',
      'design/design.md: The heading "## Screens" is missing.',
      'design/design.md: The heading "## Not doing" is missing.',
      'design/design.md: The heading "## Read first" is missing.',
      'design/design.md: "## Screens" has no "Read at:" line.',
    ]);
  });
});

describe('the implement record', () => {
  const implementFiles = (progress: string, pr = PR, deviations = DEVIATIONS) => ({ 'implement/progress.md': progress, 'implement/pr.md': pr, 'implement/deviations.md': deviations, 'implement/summary.md': SUMMARY, ...SHARE });

  it('names a record with no Base line on top and no proof under a step', () => {
    const progress = PROGRESS.replace('Base: 4f2a91c\n\n', '').replace('   Check: npm test: "Tests 12 passed (12)"\n', '').replace('   Green: npm test -- page: "Tests 4 passed (4)"\n', '');
    expect(problemsOf('implement', implementFiles(progress))).toEqual([
      'implement/progress.md: The file does not open with a "Base:" line, the commit the work started from.',
      'implement/progress.md: Step 2 has no "Check:" or "Green:" line with the command that proved it.',
      'implement/progress.md: "- Fix: QA failed AC2, a cleared box kept the filter." has a "Red:" line and no "Green:" line.',
    ]);
    // Below a title it is not the first line any more.
    expect(problemsOf('implement', implementFiles(`# Progress\n${PROGRESS}`))).toEqual(['implement/progress.md: The file does not open with a "Base:" line, the commit the work started from.']);
  });

  it('names a review block with no count of deviations or no tests changed', () => {
    const progress = PROGRESS.replace('- Deviations: 1, step 2 waits 300 ms. It changes no criterion.\n', '').replace('- Tests: added', '- Test files: added');
    expect(problemsOf('implement', implementFiles(progress))).toEqual([
      'implement/progress.md: The review block has no "- Deviations:" line.',
      'implement/progress.md: The review block has no "- Tests:" line.',
    ]);
  });

  // stepsDone reads such a line as a finished step, and the next run would skip that step.
  it('names a line outside the step lines that reads as a finished step', () => {
    const progress = PROGRESS.replace('- Surprises: none.', '- Step 3 is left for later.').replace('   Check: npm test:', '   12 tests pass, npm test:');
    expect(problemsOf('implement', implementFiles(progress))).toEqual([
      'implement/progress.md: Step 2 has no "Check:" or "Green:" line with the command that proved it.',
      'implement/progress.md: A line starts with a number, and the next run reads it as a finished step: "- Step 3 is left for later."',
      'implement/progress.md: A line starts with a number, and the next run reads it as a finished step: "   12 tests pass, npm test: "Tests 12 passed (12)""',
    ]);
  });

  // Older runs write their steps as "- Step 1: ...", which stepsDone reads as the step, so it is
  // a step line too. A block line that starts with a digit is named once, by the review block rule.
  it('takes a "- Step 1:" line as a step, and names a digit in the review block once', () => {
    const progress = PROGRESS.replace('1. Added the q option', '- Step 1: added the q option').replace('   Green: npm test -- recipes: "Tests 3 passed (3)"\n', '').replace('- Surprises: none.', '- 2 surprises, both in discoveries.md.');
    expect(problemsOf('implement', implementFiles(progress))).toEqual([
      'implement/progress.md: Step 1 has a "Red:" line and no "Green:" line.',
      'implement/progress.md: A review block line starts with a digit, which reads as a step: "- 2 surprises, both in discoveries.md."',
    ]);
  });

  it('names a deviation that is not a ruling, and a pull request text with no test part', () => {
    const deviations = '- Step 2: the box waits 300 ms, not 200 ms, because the list waits too.\n- Step 1: the match ignores case. Why: AC1 says so.\n';
    expect(problemsOf('implement', implementFiles(PROGRESS, PR.replace('## How to test\n\nnpm test -- recipes\n', ''), deviations))).toEqual([
      'implement/pr.md: The heading "## How to test" is missing.',
      'implement/deviations.md: A deviation has no "Why:" or no "If wrong:": "- Step 2: the box waits 300 ms, not 200 ms, because the list waits too."',
      'implement/deviations.md: A deviation has no "Why:" or no "If wrong:": "- Step 1: the match ignores case. Why: AC1 says so."',
    ]);
  });

  // A record written before this format still gives the next run its steps, but a new run is told
  // what it lacks.
  it('names what a record in the old shape lacks', () => {
    expect(problemsOf('implement', implementFiles('1. Added the q option, the api test passes\n', 'Search recipes by title\n\nAdds a box.\n', 'None.\n'))).toEqual([
      'implement/progress.md: The heading "## Before you approve" is missing.',
      'implement/progress.md: The heading "## Steps done" is missing.',
      'implement/progress.md: The file does not open with a "Base:" line, the commit the work started from.',
      'implement/pr.md: The heading "## What changed" is missing.',
      'implement/pr.md: The heading "## How to test" is missing.',
    ]);
  });
});

describe('the QA report', () => {
  const qaFiles = (report: string, checks = CHECKS) => ({ 'refine/refined.md': REFINED, 'qa/checks.md': checks, 'qa/report.md': report, 'qa/summary.md': SUMMARY });
  // A failed row as the skill writes it, in place of the AC1 row.
  const AC1 = '2. pass: AC1 (must): Type a word, only matching recipes show\n   How: typed "soup" in the browser\n   Evidence: qa/evidence/2-soup.png, 3 rows show\n';
  const failed = (word = 'fail') =>
    `2. ${word}: AC1 (must): Type a word, only matching recipes show\n   Reason: every row stayed\n   Expected: 3 rows\n   Actual: 12 rows\n   How: typed "soup"\n   Evidence: qa/evidence/2-soup.png\n`;

  it('names a check with no row in the report', () => {
    const report = REPORT.replace(/3\. pass: AC2[^]*?12 rows show\n/, '');
    expect(problemsOf('qa', qaFiles(report))).toEqual(['qa/report.md: qa/checks.md has 3 checks and the report has 2 rows.']);
  });

  it('names a row in no form the checklist reads', () => {
    expect(problemsOf('qa', qaFiles(REPORT.replace('3. pass: AC2', '3. PASSED: AC2')))).toEqual(['qa/report.md: A row does not start with pass, fail or not reached: "3. PASSED: AC2 (should): Clear the box, every recipe shows"']);
  });

  it('reads a result word in upper case, as the ticket page does', () => {
    expect(problemsOf('qa', qaFiles(REPORT.replace('2. pass: AC1', '2. PASS: AC1')))).toEqual([]);
    expect(problemsOf('qa', qaFiles(REPORT.replace(AC1, failed('FAIL'))))).toEqual(['qa/report.md: The verdict is PASS, but the must check AC1 did not pass.']);
  });

  // PASS needs every must criterion passed with evidence. A should
  // criterion that failed is named in section 1 and does not stop a PASS.
  it('names a PASS verdict beside a must criterion that failed or was not reached, and lets a should one go', () => {
    const report = REPORT.replace(AC1, failed()).replace(/3\. pass: AC2 \(should\)[^]*?12 rows show\n/, '3. not reached: AC2 (should): Clear the box, every recipe shows\n   Reason: no browser\n');
    expect(problemsOf('qa', qaFiles(report))).toEqual(['qa/report.md: The verdict is PASS, but the must check AC1 did not pass.']);
    expect(problemsOf('qa', qaFiles(report.replace('- PASS: every check held', '- FAIL: AC1 shows every recipe')))).toEqual([]);
    // BLOCKED is a question for a person, so the PASS rule does not hold it.
    expect(problemsOf('qa', qaFiles(report.replace('- PASS: every check held', '- BLOCKED: AC1 needs a person')))).toEqual([]);
    expect(problemsOf('qa', qaFiles(REPORT.replace('3. pass: AC2 (should)', '3. fail: AC2 (should)').replace('   How: cleared', '   Reason: one row hid\n   Expected: 12\n   Actual: 11\n   How: cleared')))).toEqual([]);
    // The brief owns the level, so a row that calls a must criterion should does not let it fail.
    expect(problemsOf('qa', qaFiles(REPORT.replace(AC1, failed().replace('AC1 (must)', 'AC1 (should)'))))).toEqual(['qa/report.md: The verdict is PASS, but the must check AC1 did not pass.']);
  });

  it('names a must criterion of the brief that no row checks, under PASS', () => {
    const report = REPORT.replace(AC1, '2. pass: Type a word, only matching recipes show\n   How: typed\n   Evidence: 3 rows\n');
    expect(problemsOf('qa', qaFiles(report, CHECKS.replace('2. AC1 (must): ', '2. ')))).toEqual(['qa/report.md: The verdict is PASS, but no row checks the must criterion AC1.']);
  });

  // A brief from before the levels has none, so each of its criteria counts as must.
  it('counts a criterion with no level as must, from the row or with no brief', () => {
    const report = REPORT.replace('2. pass: AC1 (must)', '2. fail: AC1').replace('   How: typed "soup" in the browser', '   Reason: r\n   Expected: e\n   Actual: a\n   How: typed');
    expect(problemsOf('qa', { 'qa/checks.md': CHECKS, 'qa/report.md': report, 'qa/summary.md': SUMMARY })).toEqual(['qa/report.md: The verdict is PASS, but the must check AC1 did not pass.']);
  });

  it('names a PASS beside a failed project check', () => {
    const report = REPORT.replace("1. pass: Run the project's tests, they pass\n   How: npm test", "1. fail: Run the project's tests, they pass\n   Reason: 1 failed\n   Expected: 0 failed\n   Actual: 1 failed\n   How: npm test");
    expect(problemsOf('qa', qaFiles(report))).toEqual(['qa/report.md: The verdict is PASS, but row 1 failed.']);
  });

  it('names a row with no How or Evidence line, and a failed or unreached row with no reason, expected or actual', () => {
    const report = REPORT.replace('   How: npm test\n', '').replace('   Evidence: qa/evidence/2-soup.png, 3 rows show\n', '').replace(/3\. pass: AC2 \(should\)[^]*?12 rows show\n/, '3. not reached: AC2 (should): Clear the box, every recipe shows\n');
    expect(problemsOf('qa', qaFiles(report.replace('- PASS', '- FAIL')))).toEqual([
      'qa/report.md: Row 1 has no "How:" line.',
      'qa/report.md: Row 2 has no "Evidence:" line.',
      'qa/report.md: Row 3 has no "Reason:" line.',
    ]);
    expect(problemsOf('qa', qaFiles(REPORT.replace(AC1, '2. fail: AC1 (must): Type a word\n   How: typed\n   Evidence: 12 rows\n').replace('- PASS', '- FAIL')))).toEqual([
      'qa/report.md: Row 2 has no "Reason:" line.',
      'qa/report.md: Row 2 has no "Expected:" line.',
      'qa/report.md: Row 2 has no "Actual:" line.',
    ]);
  });

  // A screenshot can be lost: two names that differed only in case were one file on the disk.
  it('names an evidence file with capital letters', () => {
    expect(problemsOf('qa', qaFiles(REPORT.replace('qa/evidence/3-cleared.png', 'qa/evidence/3-AC2-Cleared.png')))).toEqual([
      'qa/report.md: The evidence file qa/evidence/3-AC2-Cleared.png has capital letters. Name it in lower case, because a disk that ignores case keeps one of two such names.',
    ]);
  });

  it('holds section 1 to the review block rules', () => {
    expect(problemsOf('qa', qaFiles(REPORT.replace('- For you: try a long title on a phone.', 'For you: try a long title.\n- 2 checks left for you.')))).toEqual([
      'qa/report.md: A review block line is not a bullet: "For you: try a long title."',
      'qa/report.md: A review block line starts with a digit, which reads as a step: "- 2 checks left for you."',
    ]);
  });

  // A report from before these rules still opens, and the check names what it lacks without throwing.
  it('reads a report in the old form', () => {
    const old = "## 1. Verdict\n\nPASS\n\n## 2. What QA checked\n\n1. pass: Run the project's tests, they pass\n2. pass: AC1: Type a word\n   Ran: typed soup\n3. pass: AC2: Clear the box\n\n## 3. What was not checked\n\nNothing.\n";
    expect(problemsOf('qa', qaFiles(old))).toEqual([
      'qa/report.md: Row 1 has no "How:" line.',
      'qa/report.md: Row 1 has no "Evidence:" line.',
      'qa/report.md: Row 2 has no "How:" line.',
      'qa/report.md: Row 2 has no "Evidence:" line.',
      'qa/report.md: Row 3 has no "How:" line.',
      'qa/report.md: Row 3 has no "Evidence:" line.',
      'qa/report.md: A review block line is not a bullet: "PASS"',
    ]);
  });
});

describe('the review round', () => {
  it('names a review round block with no label', () => {
    const files = { 'pr-review/round.md': 'issue: a.ts:1\nWrong.\n\n  suggestion: a.ts:2\nBetter.\n', 'pr-review/summary.md': reviewSummary('changes needed', '1 issue') };
    expect(problemsOf('pr-review', files)).toEqual(['pr-review/round.md: The block starting "  suggestion: a.ts:2" is indented. A block starts at the left margin, so move it there and write the round again.']);
  });

  // The shape the skill writes now, with its place on a line of its own. The check reads it with the
  // Review tab's own parser, so the counts are the blocks the page draws.
  it('reads a round with location lines, and counts a comment marked non-blocking as no reason to wait', () => {
    const round = 'a.ts:1-4\nissue (non-blocking): The name hides the unit\n\nCall it timeoutMs.\n\nb.ts:9\ntodo: Add the empty case\n\nThe test skips an empty list.\n';
    expect(problemsOf('pr-review', { 'pr-review/round.md': round, 'pr-review/summary.md': reviewSummary('changes needed', '1 issue, 1 todo') })).toEqual([]);
    const soft = 'a.ts:1\nissue (non-blocking): The name hides the unit\n\nCall it timeoutMs.\n';
    expect(problemsOf('pr-review', { 'pr-review/round.md': soft, 'pr-review/summary.md': reviewSummary('changes needed', '1 issue') })).toEqual([
      'pr-review/summary.md: The verdict does not follow the round: with 0 blocking and 0 question blocks it is "ready to merge".',
    ]);
    expect(problemsOf('pr-review', { 'pr-review/round.md': 'issue: The name hides the unit\n\nCall it timeoutMs.\n\na.ts:1\nnote: Fine\n', 'pr-review/summary.md': REVIEW_SUMMARY })[0]).toContain('pr-review/round.md:');
  });

  it('checks the newest round and takes a later round as the main file', () => {
    const files = { 'pr-review/round.md': 'no label\n', 'pr-review/round-2.md': 'praise: a.ts:1\nGood.\n', 'pr-review/summary.md': reviewSummary('ready to merge', '1 praise') };
    expect(problemsOf('pr-review', files)).toEqual([]);
    expect(problemsOf('pr-review', { 'pr-review/summary.md': SUMMARY })).toEqual(['pr-review/round.md: The file is missing.']);
    expect(problemsOf('pr-review', { 'pr-review/round.md': ROUND })).toEqual(['pr-review/summary.md: The file is missing.']);
  });

  // The summary is the round's review block, so its verdict and counts follow the blocks.
  it('names a summary whose verdict or counts do not follow the round, or that says nothing about what was not reviewed', () => {
    const check = (summary: string) => problemsOf('pr-review', { 'pr-review/round.md': ROUND, 'pr-review/summary.md': summary });
    expect(check(reviewSummary('ready to merge', '1 issue, 1 praise'))).toEqual(['pr-review/summary.md: The verdict does not follow the round: with 1 blocking and 0 question blocks it is "changes needed".']);
    expect(check(reviewSummary('changes needed', '2 issues, 1 praise'))).toEqual(['pr-review/summary.md: "Findings:" does not match the round, which has 1 praise, 1 issue.']);
    expect(check(reviewSummary('changes needed', '1 praise'))).toEqual(['pr-review/summary.md: "Findings:" does not match the round, which has 1 praise, 1 issue.']);
    expect(check(reviewSummary('changes needed', '1 issue, 1 praise').replace(/Not reviewed:.*\n/, ''))).toEqual(['pr-review/summary.md: There is no "Not reviewed:" line, which says what the round did not read.']);
    expect(check(SUMMARY)).toEqual([
      'pr-review/summary.md: There is no "Verdict:" line (changes needed, questions first or ready to merge).',
      'pr-review/summary.md: There is no "Findings:" line with the count of blocks by label.',
      'pr-review/summary.md: There is no "Not reviewed:" line, which says what the round did not read.',
    ]);
    const asks = { 'pr-review/round.md': 'question: a.ts:1\nIs this meant?\n', 'pr-review/summary.md': reviewSummary('questions first', '1 question') };
    expect(problemsOf('pr-review', asks)).toEqual([]);
  });

  // The Review tab draws a label with a decoration, so the round check and the counts take it too.
  it('reads a label with a decoration, as the Review tab does', () => {
    const files = { 'pr-review/round.md': 'issue (blocking): a.ts:1\nWrong.\n', 'pr-review/summary.md': reviewSummary('changes needed', '1 issue') };
    expect(problemsOf('pr-review', files)).toEqual([]);
  });

  it('asks a re-review to say what became of the earlier issues', () => {
    const files = { 'pr-review/round.md': ROUND, 'pr-review/round-2.md': 'praise: api/src/recipes.ts:12\nThe match ignores case now.\n', 'pr-review/summary.md': reviewSummary('ready to merge', '1 praise') };
    expect(problemsOf('pr-review', files)).toEqual(['pr-review/summary.md: This is a re-review and there is no "Earlier issues:" line, which says how many issues of the earlier rounds are fixed.']);
    expect(problemsOf('pr-review', { ...files, 'pr-review/summary.md': reviewSummary('ready to merge', '1 praise', 'Earlier issues: 1 from round 1, fixed.\n') })).toEqual([]);
  });
});

describe('the research answer and the investigation', () => {
  const research = (answer: string) => problemsOf('research', { 'research/answer.md': answer, 'research/summary.md': SUMMARY });
  const investigate = (report: string) => problemsOf('investigate', { 'investigate/report.md': report, 'investigate/summary.md': SUMMARY });

  it('names sources that are not the last section', () => {
    expect(research(`${ANSWER}\n## Later\n\nMore.\n`)).toEqual(['research/answer.md: "## Sources" is not the last section.']);
  });

  it('names an answer that does not open with its sentence and how sure it is', () => {
    expect(research(ANSWER.replace('Confidence: high, because the page and the route were both read.\n\n', ''))).toEqual(['research/answer.md: There is no "Confidence:" line (high, medium or low) under the answer.']);
    expect(research(`## Answer\n\n${ANSWER}`)).toEqual(['research/answer.md: The file does not open with the answer in one sentence.', 'research/answer.md: There is no "Confidence:" line (high, medium or low) under the answer.']);
    expect(research(ANSWER.replace('Confidence: high', 'Confidence: sure'))).toEqual(['research/answer.md: There is no "Confidence:" line (high, medium or low) under the answer.']);
    expect(research(`- ${ANSWER}`)).toEqual(['research/answer.md: The file does not open with the answer in one sentence.']);
  });

  it('names a card draft with no problem, no places to change, or a criterion and question in the wrong shape', () => {
    const draft = (body: string) => ANSWER.replace(/## If this becomes a card\n[\s\S]*?\n## Sources/, `## If this becomes a card\n\n${body}\n\n## Sources`);
    expect(research(draft('- AC1: The api filters.\n- Q1: Should the page filter too?'))).toEqual([
      'research/answer.md: "## If this becomes a card" has no "Problem:" line.',
      'research/answer.md: "## If this becomes a card" has no "Change:" line with the places to change.',
      'research/answer.md: AC1 has no level after its id, (must) or (should).',
      'research/answer.md: AC1 has no "Check:" line under it.',
      'research/answer.md: The question Q1 names no "Default:".',
      'research/answer.md: The question Q1 does not end with "blocks: yes" or "blocks: no".',
    ]);
    expect(research(draft('Problem: slow.\nChange: api/src/recipes.ts.'))).toEqual(['research/answer.md: "## If this becomes a card" has no criterion, as "- AC1 (must): ..." with a "Check:" line.']);
  });

  it('names a hypothesis with no result, and a missing section of the report', () => {
    expect(investigate(INVESTIGATION.replace('Result: held.', 'Result: likely.'))).toHaveLength(1);
    expect(investigate(INVESTIGATION.replace(' Result: held.', ''))).toEqual(['investigate/report.md: A hypothesis has no "Result:" (held, ruled out or not settled): "- The route answers nothing for an empty file. api/src/server.ts:31 returns the parse of an empty string."']);
    expect(investigate(INVESTIGATION.replace('## Searched and not found\n\nNothing.\n\n', ''))).toEqual(['investigate/report.md: The heading "## Searched and not found" is missing.']);
  });

  // An answer from before these rules still reads on the Research page. The check names what it lacks.
  it('names what an answer and a report in the old shape lack', () => {
    expect(research('Yes, the api pages the list.\n\nIt reads a limit.\n\n## Sources\n\n- api/src/recipes.ts:14 the limit\n')).toEqual([
      'research/answer.md: The heading "## Why" is missing.',
      'research/answer.md: The heading "## Searched and not found" is missing.',
      'research/answer.md: There is no "Confidence:" line (high, medium or low) under the answer.',
    ]);
    expect(investigate('The list is undefined.\n\n## Sources\n\n- a.ts:1\n')).toEqual([
      'investigate/report.md: The heading "## What was reported" is missing.',
      'investigate/report.md: The heading "## What was found" is missing.',
      'investigate/report.md: The heading "## Hypotheses tried" is missing.',
      'investigate/report.md: The heading "## The fix or next step" is missing.',
      'investigate/report.md: The heading "## Searched and not found" is missing.',
      'investigate/report.md: There is no "Confidence:" line (high, medium or low) under the answer.',
    ]);
  });
});

describe('the assessment', () => {
  const assess = (text: string) => problemsOf('assess', { 'assess/assessment.md': text, 'assess/summary.md': SUMMARY });

  it('names a likely cause with no confidence or nothing that would change the call, as an old assessment has', () => {
    expect(assess(ASSESSMENT.replace(/Confidence:.*\n/, '').replace(/What would change it:.*\n/, ''))).toEqual([
      'assess/assessment.md: "## The likely cause" has no "Confidence:" line (high, medium or low).',
      'assess/assessment.md: "## The likely cause" has no "What would change it:" line.',
    ]);
  });

  // The screen splits the file at every heading, so a sub-heading cuts a section in two.
  it('names a heading the screen does not read', () => {
    // A deeper heading of one of the five is still read, so only the missing heading is named.
    expect(assess(ASSESSMENT.replace('## The effort', '### The effort'))).toEqual(['assess/assessment.md: The heading "## The effort" is missing.']);
    expect(assess(ASSESSMENT.replace('Under an hour.', 'Under an hour.\n\n### Why so short\n\nOne file.'))).toEqual(['assess/assessment.md: The heading "### Why so short" splits a section, because the screen starts a new section at every heading.']);
    expect(assess(`${ASSESSMENT}\n## Notes\n\nMore.\n`)).toEqual(['assess/assessment.md: The heading "## Notes" splits a section, because the screen starts a new section at every heading.']);
  });
});

describe('the knowledge entries', () => {
  const NOTE = '---\ndescription: Read before changing search. Why it lower cases both sides.\nsource: APP-12 at 1a2b3c4 (2026-10-25)\npaths: api/src/recipes.ts\n---\n\nSearch lower cases both sides.\n\nWhy: QA failed once on "Bean soup".\n';
  const wrapup = (knowledge: Record<string, string>) => problemsOf('wrapup', { 'wrapup/changes.md': '- added search.md: why search lower cases.\n', 'wrapup/summary.md': SUMMARY, ...knowledge });

  it('finds nothing wrong in a note of the entry shape, or a note with no paths', () => {
    expect(wrapup({ 'knowledge/search.md': NOTE, 'knowledge/words.md': NOTE.replace(/paths:.*\n/, '') })).toEqual([]);
  });

  it('names a note with no description, because the knowledge index then shows its first line', () => {
    expect(wrapup({ 'knowledge/search.md': 'Search lower cases both sides.\n' })).toEqual([
      'knowledge/search.md: The note has no "description:" in its frontmatter, which the knowledge index shows every run as the line that says when to read it.',
    ]);
  });

  // A note can point at design files in `.tasks/`, which git does not track.
  it('names a path that no base branch can hold', () => {
    expect(wrapup({ 'knowledge/search.md': NOTE.replace('paths: api/src/recipes.ts', 'paths: .tasks/APP-12/design/search.html, /tmp/x, ../other/a.ts, .tasks/, .tasksbook/a.md') })).toEqual([
      'knowledge/search.md: The path ".tasks/APP-12/design/search.html" is one git does not keep. Name only paths git tracks on the base branch, never the card folder.',
      'knowledge/search.md: The path "/tmp/x" is one git does not keep. Name only paths git tracks on the base branch, never the card folder.',
      'knowledge/search.md: The path "../other/a.ts" is one git does not keep. Name only paths git tracks on the base branch, never the card folder.',
      'knowledge/search.md: The path ".tasks" is one git does not keep. Name only paths git tracks on the base branch, never the card folder.',
    ]);
  });

  // A card's index lists the notes of its own repositories, so a note in another folder is missed.
  describe('where a note sits', () => {
    const files = (knowledge: Record<string, string>) => ({ 'wrapup/changes.md': '- added search.md: why search lower cases.\n', 'wrapup/summary.md': SUMMARY, ...knowledge });
    const placed = (knowledge: Record<string, string>, repos: readonly string[]) => (checkOutputs('wrapup', files(knowledge), undefined, repos) ?? []).map((one) => `${one.file}: ${one.problem}`);

    it('finds nothing wrong in a note in the folder of its repository, in shared/ or at the top for the project folder', () => {
      expect(placed({ 'knowledge/api/search.md': NOTE }, ['api', 'web'])).toEqual([]);
      expect(placed({ 'knowledge/shared/search.md': NOTE.replace('paths: api/src/recipes.ts', 'paths: api/src/recipes.ts, web/src/list.ts') }, ['api', 'web'])).toEqual([]);
      expect(placed({ 'knowledge/search.md': NOTE.replace('paths: api/src/recipes.ts', 'paths: src/recipes.ts') }, ['.'])).toEqual([]);
    });

    it('names a note outside the folder its paths belong in, and where to move it', () => {
      expect(placed({ 'knowledge/search.md': NOTE }, ['api', 'web'])).toEqual(['knowledge/search.md: The note sits in the top of the knowledge folder, but its paths belong in api/. Move it to api/search.md.']);
      expect(placed({ 'knowledge/api/search.md': NOTE.replace('paths: api/src/recipes.ts', 'paths: api/src/recipes.ts, web/src/list.ts') }, ['api', 'web'])).toEqual([
        'knowledge/api/search.md: The note sits in api/, but its paths belong in shared/. Move it to shared/search.md.',
      ]);
      expect(placed({ 'knowledge/web/search.md': NOTE.replace('paths: api/src/recipes.ts', 'paths: src/recipes.ts') }, ['.', 'web'])).toEqual([
        'knowledge/web/search.md: The note sits in web/, but its paths belong in the top of the knowledge folder. Move it to search.md.',
      ]);
    });

    // No paths, a path in no listed repository, the run recipe and a repository file all have no folder to check against.
    // A note at the old place before the run may wait for the move of an older folder.
    it('checks only the notes the run made, when it is told which', () => {
      expect((checkOutputs('wrapup', files({ 'knowledge/search.md': NOTE }), undefined, ['api', 'web'], []) ?? []).map((one) => one.problem)).toEqual([]);
      expect((checkOutputs('wrapup', files({ 'knowledge/search.md': NOTE }), undefined, ['api', 'web'], ['knowledge/search.md']) ?? []).map((one) => one.problem)).toEqual([
        'The note sits in the top of the knowledge folder, but its paths belong in api/. Move it to api/search.md.',
      ]);
    });

    it('leaves a note it cannot place, the run recipe and the repository files alone, and checks nothing with no list', () => {
      expect(placed({ 'knowledge/words.md': NOTE.replace(/paths:.*\n/, ''), 'knowledge/docs.md': NOTE.replace('paths: api/src/recipes.ts', 'paths: docs/a.md') }, ['api', 'web'])).toEqual([]);
      expect(placed({ 'knowledge/run-recipe.md': NOTE, 'knowledge/web/repository.md': NOTE }, ['api', 'web'])).toEqual([]);
      expect(placed({ 'knowledge/search.md': NOTE }, [])).toEqual([]);
    });
  });

  it('checks the note an Optimize run rewrote the same way, and leaves the card files to their own rules', () => {
    expect(problemsOf('optimize', { 'optimize/changes.md': '- cut one line.\n', 'optimize/summary.md': SUMMARY, 'knowledge/search.md': '# Search\n' })).toEqual([
      'knowledge/search.md: The note has no "description:" in its frontmatter, which the knowledge index shows every run as the line that says when to read it.',
    ]);
    expect(problemsOf('qa', { 'qa/checks.md': CHECKS, 'qa/report.md': REPORT, 'qa/summary.md': SUMMARY, 'knowledge/search.md': '# Search\n' })).toEqual([]);
  });
});

// Learn this project keeps a few lines a person can check, each with where it came from.
describe('the orientation run', () => {
  const NOTE = '---\ndescription: Read before running a command or touching generated code. The project rules people wrote down.\nsource: Learn this project (2026-10-25)\npaths: README.md\n---\n\n# Project rules\n\n- Never edit `generated/`, because the build writes it again. (from CONTRIBUTING.md)\n- Use `pnpm test`, not `npm test`, because the workspace needs pnpm. (told by the person)\n';
  const orient = (knowledge: Record<string, string>) => problemsOf('orient', { 'orient/changes.md': '- added project-rules.md: the rules people wrote down.\n', 'orient/summary.md': SUMMARY, ...knowledge });

  it('finds nothing wrong in notes whose every line names its source', () => {
    expect(orient({ 'knowledge/project-rules.md': NOTE })).toEqual([]);
  });

  it('asks for its changes file', () => {
    expect(problemsOf('orient', { 'orient/summary.md': SUMMARY })).toEqual(['orient/changes.md: The file is missing.']);
  });

  it('names a line with no source', () => {
    expect(orient({ 'knowledge/project-rules.md': `${NOTE}- Run the seed before the tests.\nA line of prose.\n` })).toEqual([
      'knowledge/project-rules.md: The line "- Run the seed before the tests." names no source. End it with (from <the file>) or (told by the person).',
      'knowledge/project-rules.md: The line "A line of prose." names no source. End it with (from <the file>) or (told by the person).',
    ]);
  });

  // The repository files and the run recipe keep the lines Nolzu wrote, which name their source their own way.
  it('leaves the lines of the repository files and the run recipe to their own shape', () => {
    const recipe = '---\ndescription: Read before you run a command.\n---\n\n# How to run each repository\n\n- Test: `npm test`, the `test` script in `package.json`.\n';
    expect(orient({ 'knowledge/run-recipe.md': recipe, 'knowledge/api/repository.md': recipe })).toEqual([]);
  });

  it('names more than three notes, and more than about 60 lines in all', () => {
    const notes = Object.fromEntries(['a', 'b', 'c', 'd'].map((name) => [`knowledge/${name}.md`, NOTE]));
    expect(orient(notes)).toEqual(['orient/changes.md: The run wrote 4 knowledge files, more than 3.']);
    const long = `${NOTE}${'- One more rule. (from README.md)\n'.repeat(59)}`;
    expect(orient({ 'knowledge/project-rules.md': long })).toEqual(['orient/changes.md: The knowledge files hold 61 lines, more than about 60.']);
  });
});

describe('the review block', () => {
  const withBlock = (block: string) => ({ 'refine/refined.md': REFINED.replace(/## Before you approve\n[\s\S]*?\n## Problem/, `## Before you approve\n${block}\n## Problem`), 'refine/summary.md': SUMMARY });

  it('takes a short block of bullets', () => {
    expect(problemsOf('refine', withBlock('- Concluded: a search box.\n- Next: Plan.\n'))).toEqual([]);
  });

  it('names a block over 15 lines, a line that is not a bullet, and a bullet that starts with a digit', () => {
    expect(problemsOf('refine', withBlock(`${'- A line.\n'.repeat(16)}`))).toEqual(['refine/refined.md: The review block has 16 lines, more than 15.']);
    expect(problemsOf('refine', withBlock('- Concluded.\n1. Decide this.\n- 2 risks left.\n'))).toEqual([
      'refine/refined.md: A review block line is not a bullet: "1. Decide this."',
      'refine/refined.md: A review block line starts with a digit, which reads as a step: "- 2 risks left."',
    ]);
  });
});

describe('the stored result', () => {
  it('says the phase had project instructions only when something is wrong', () => {
    expect(outputCheck('refine', {}, '.nolzu/phases/refine.md')).toEqual({
      problems: [
        { file: 'refine/refined.md', problem: 'The file is missing.' },
        { file: 'refine/summary.md', problem: 'The file is missing.' },
      ],
      note: 'This phase ran with the project instructions in .nolzu/phases/refine.md. They may have changed what it wrote, so look there first.',
    });
    expect(outputCheck('refine', { 'refine/refined.md': REFINED, 'refine/summary.md': SUMMARY }, '.nolzu/phases/refine.md')).toEqual({ problems: [], note: null });
    expect(outputCheck('refine', {}, null)?.note).toBeNull();
    expect(outputCheck('ask', {}, null)).toBeNull();
  });

  it('lists the fixed files a check reads, besides the phase folder', () => {
    expect(checkedPaths('plan')).toEqual(['plan/plan.md', 'qa/checks.md', 'plan/summary.md', 'refine/refined.md', 'architecture/architecture.md']);
    expect(checkedPaths('qa')).toEqual(['qa/report.md', 'qa/summary.md', 'qa/checks.md', 'refine/refined.md']);
    expect(checkedPaths('design')).toEqual(['design/design.md', 'design/summary.md', 'refine/refined.md', 'architecture/architecture.md']);
    expect(checkedPaths('ask')).toEqual([]);
  });
});

describe('the gate', () => {
  it('names the main file of each phase that opens with a review block', () => {
    expect(['refine', 'architecture', 'design', 'plan', 'implement', 'qa', 'research', 'wrapup', 'ask'].map(gateFile)).toEqual([
      'refine/refined.md',
      'architecture/architecture.md',
      'design/design.md',
      'plan/plan.md',
      'implement/progress.md',
      'qa/report.md',
      null,
      null,
      null,
    ]);
  });

  it('reads the review block and the questions that block the next move, by phase', () => {
    const blocking = REFINED.replace('Default: no. blocks: no', 'Default: no. blocks: yes');
    expect(gateOf('refine', blocking)).toEqual({
      lines: ['- Concluded: a search box filters the list by title.', '- Decide: Q1, should the search also match ingredients? Default: no.', '- Next: Plan turns AC1 and AC2 into steps.'],
      blocking: [{ id: 'Q1', question: 'Should the search also match ingredients?', answer: 'no', blocks: true }],
    });
    expect(gateOf('refine', REFINED).blocking).toEqual([]);
    // Only "blocks: yes" blocks. A line that says neither is the check's to name.
    expect(gateOf('refine', REFINED.replace(' blocks: no', '')).blocking).toEqual([]);
    // Of two blocking lines with one id, the first counts, as the choice names only the id.
    const twice = blocking.replace('blocks: yes\n', 'blocks: yes\n- Q1: Should it match tags? Default: no. blocks: yes\n');
    expect(gateOf('refine', twice).blocking.map((one) => one.question)).toEqual(['Should the search also match ingredients?']);
    expect(gateOf('architecture', ARCHITECTURE.replace('blocks: no', 'blocks: yes')).blocking.map((one) => one.id)).toEqual(['Q2']);
    expect(gateOf('design', DESIGN.replace('Default: no. blocks: no', 'Default: no. blocks: yes')).blocking).toEqual([
      { id: 'Q3', question: 'Should the empty sentence offer a button?', answer: 'no', blocks: true },
    ]);
    expect(gateOf('qa', REPORT).lines?.[0]).toMatch(/^- /);
  });

  it('reads a file from before the review block and the ids with no block and nothing that blocks', () => {
    const old = '# APP-1: Search\n\n## Open questions\n\n- Should it match tags? blocks: yes\n- Which page size?\n';
    expect(gateOf('refine', old)).toEqual({ lines: null, blocking: [] });
    expect(gateOf('plan', '')).toEqual({ lines: null, blocking: [] });
    // An empty block reads as none, so the page says so instead of drawing an empty box.
    expect(gateOf('plan', '## Before you approve\n\n## Approach\n').lines).toBeNull();
    expect(gateOf('research', '# Answer\n')).toEqual({ lines: null, blocking: [] });
  });
});
