import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_STUB_LINE, recipeHeading, repoKnowledgePath, withRecipeSection } from '@nolzu/core';
import { isMaintenanceKey, type Job, QUESTION_FILE, repoOfLearnKey } from '@nolzu/protocol';
import { parseClaudeLine } from './claude.ts';
import { type Engine, withSentinels } from './engine.ts';
import { claudeModels } from './models.ts';
import { SHARE_PLAN_FILE } from './prompt.ts';

// Milliseconds before each line at delay scale 1, slow enough to watch a card on the board.
// A job replays the scenario named like its phase, so tests reach needs-input and api-error by name.
export const scenarioDelays: Record<string, number> = {
  refine: 400,
  plan: 400,
  implement: 400,
  qa: 400,
  wrapup: 400,
  // The five phases of the boards beside Delivery. Fake mode is the only mode a person can walk a
  // board in without spending money, so a stage with no scenario here is a column whose drop always
  // ends failed.
  architecture: 400,
  design: 400,
  investigate: 400,
  research: 400,
  'pr-review': 400,
  // Run triage on a Delivery card's PRs tab: reads the comments file and writes a verdict per ref.
  feedback: 400,
  optimize: 400,
  // Learn this project: the first round asks, and the answer resumes it into `orient`.
  orient: 400,
  'orient-asks': 400,
  // Learn your repositories: one repository's file and its run recipe section.
  'learn-repo': 400,
  assess: 400,
  // An Ask message: reads one file and answers, and writes nothing.
  ask: 400,
  // The pass behind the two message buttons on the Changes tab, so the demo fills the box too.
  'commit-message': 400,
  // The pass that names an Ask discussion after its first answer.
  'thread-title': 400,
  'needs-input': 400,
  'api-error': 1000,
  'rate-limit': 400,
  // The first rounds the two switches below turn on.
  'qa-fail': 400,
  'plan-asks': 400,
};

// Switches for a walk through the app in fake mode, which `selectEngine` reads from the environment
// and nothing else does. Each one takes a card's first round only, read off what the card folder
// holds, so the next round replays the phase's own scenario.
export interface FakeSwitches {
  // NOLZU_FAKE_QA_FAIL=1: a card's first QA run fails with a reason and a screenshot. Once a report
  // is there, QA passes, so Fix it has a FAIL to fix and a PASS to reach.
  qaFailsFirst?: boolean;
  // NOLZU_FAKE_PLAN_ASKS=1: a card's first plan run asks one question with two answers. The answer
  // resumes the session and the plan goes on.
  planAsks?: boolean;
  // NOLZU_FAKE_TRIAGE_BROKEN=1: every triage writes a file with a verdict outside the five, so the
  // PRs tab shows the sentence a file that does not parse gets.
  triageBroken?: boolean;
  // NOLZU_FAKE_FIX_ASKS=1: a Fix on a pull request comment asks one question, read off its message,
  // which the fake reads for this alone. The answer is the person's own text, so it goes on.
  fixAsks?: boolean;
}

// How the message of a Fix on a pull request comment opens (`fixFeedbackMessage` in apps/local).
const FIX_OPENS = 'A reviewer left this on the pull request';

// The phase's own scenario, or the first round a switch turns on.
function scenarioOf(job: Pick<Job, 'phase'> & Partial<Pick<Job, 'taskDir' | 'resumeFrom' | 'prompt'>>, switches: FakeSwitches): string {
  if (job.phase === 'implement' && switches.fixAsks === true && job.prompt?.includes(FIX_OPENS) === true) return 'needs-input';
  const dir = job.taskDir;
  if (dir === undefined) return job.phase;
  if (job.phase === 'qa' && switches.qaFailsFirst === true && !existsSync(join(dir, 'qa', 'report.md'))) return 'qa-fail';
  // Learn this project always asks first, as its skill does, so the walk shows the answer buttons.
  if (job.phase === 'orient' && job.resumeFrom == null) return 'orient-asks';
  if (job.phase === 'plan' && switches.planAsks === true && job.resumeFrom == null && !existsSync(join(dir, 'plan', 'plan.md'))) return 'plan-asks';
  return job.phase;
}

// Resolves early on abort and removes its listener, because one signal outlives many lines.
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });
}

// The plain summary each phase skill writes to the card folder. A real run's skill writes it; the fake
// run writes it too, so the ticket page and the smoke run see what a real phase leaves behind.
const SUMMARIES: Record<string, string> = {
  refine: 'The ticket now says exactly what a person can do when it is done, and what is left out.',
  plan: 'There is a step by step plan for the change, and nothing in the product has changed yet.',
  implement: 'The change is made and its tests pass. It is not committed yet, so it can still be read first.',
  qa: 'Both acceptance checks were checked against the running stack, and both held.',
  'qa-fail': "Typing a word in the search box leaves every recipe in the list, so QA failed. The project's tests pass.",
  // The whole card, as the wrap-up skill asks, because a closed card shows it as its one summary.
  wrapup: 'The recipe list has a search box now, and QA checked that it finds recipes by title. One knowledge file says what the card taught.',
  architecture: 'The search filters in the API next to the recipe list, and the box keeps its text in the web app alone.',
  design: 'One screen changes: the recipe list gains a search box above it, and an empty box shows every recipe.',
  investigate: 'The recipe list maps over whatever the route hands it, and the route hands it nothing when the data file is empty.',
  research: 'The web page keeps nothing but the list it fetched, so a filter typed into it needs no store and no round trip.',
  // The round's review block, so the verdict and the counts follow the round below.
  'pr-review': 'Verdict: changes needed. The search misses a recipe when the case differs.\nFindings: 1 issue, 1 suggestion, 1 praise.\nNot reviewed: nothing, the whole diff was read.',
  optimize: 'One knowledge file is shorter and still true. Nothing else in the folder changed.',
  orient: 'Nolzu read what people wrote about the project and wrote down its rules in one knowledge file. It waits for your review.',
  'learn-repo': 'Nolzu read the README and the CI workflow of one repository and wrote what it is for and how to run it. It waits for your review.',
  assess: 'A recipe with no vote divides by nought when its average is worked out. The fix is one check, and it is small.',
  feedback: 'Each open comment has a verdict and a drafted reply to copy. The case of the search is the one point worth fixing first.',
};

// What the assessment scenario leaves behind, in the five sections the screen reads back. A real run
// writes its own; the fake writes one so a walk through the app in fake mode has an assessment to
// read, and so the reader is measured against a whole file and not only against a hand-written one.
const FAKE_ASSESSMENT = `# Assessment

## The evidence

src/recipes/rating.ts:31 divides the sum of the votes by their count.
The collected line: TypeError: Cannot read properties of undefined (reading 'length').

## The likely cause

The average is worked out before the vote list is checked, so a recipe nobody has voted on divides
by nought.
Confidence: high, because the line divides with no check of the count before it.
What would change it: a vote list that the importer never leaves empty.

## The proposal

Return no rating for a recipe with no vote, and draw the empty state the list already has. One file,
src/recipes/rating.ts.

## The effort

Under an hour, with the test that covers it.

## The risks

The recipe list reads the rating, so an empty rating has to draw as empty there and not as zero.
`;

// The brief after the refine skill's first line, which names the card, in the skill's sections.
export const FAKE_REFINED = `Search the recipe list
Kind: feature
Branch: recipe-search

## Before you approve

- Concluded: a search box above the recipe list filters it by title as the cook types.
- Decide: Q1, should the search also match ingredients? Default: no, titles only.
- My calls: A1, the search matches titles only.
- Not read: nothing, the fake engine reads no code.
- Next: Plan turns AC1 and AC2 into steps.

## Problem

The recipe list shows every recipe at once, so a cook with many recipes scrolls to find one.

## Scope

A search box above the recipe list filters it by title as the user types.

## Assumptions

- A1: The search matches recipe titles, not ingredients.

## Acceptance checks

- AC1 (must): Typing a word in the search box shows only recipes with that word in the title.
  Check: a browser test types a word and counts the rows.
- AC2 (should): Clearing the box shows every recipe again.
  Check: a browser test clears the box and counts the rows.

## Open questions

- Q1: Should the search also match ingredients? Default: no, titles only. blocks: no

## What the code does today

Read at: the prompt named no commit, 2026-10-25.
- The api returns every recipe, and the list page shows them all.

## Rules that apply

None.

## Out of scope

Searching by ingredient or by tag.

## Read first

- The recipe list in the api and the list page in the web app: where the search lands.
`;

// The shape the architecture skill asks for, the review block and eleven sections, so an epic walked in
// fake mode has one to read and the output check finds nothing missing.
const FAKE_ARCHITECTURE = `## Before you approve

- Concluded: nothing new is designed. The api filters the recipe list, and the web page sends what the person typed.
- Decide: D1, the api filters, not the page.
- Risks: none found, the fake engine reads no code.
- Not read: the code, because the fake engine reads none.
- Next: Design draws the search box and its states.

## The shape

Read at: the prompt named no commit, 2026-10-25.
Nothing new is designed. The api filters the recipe list, and the web page sends what the person typed.

## The pieces

- Recipe api: owns the recipe list and its filter.
- Web app: owns the search box and its text.

## Where they meet

The web app calls GET /recipes with a q option, and the api answers with the recipes that match.

## Interfaces

- GET /recipes?q=<text>: 200 with the matching recipes as a JSON array of { id, title, minutes, tags }, in title order. An empty q gives every recipe.
- GET /recipes on a failed read: 500 with the text "The recipes did not load.", and the same cross-origin header as the 200.

## The data

The query text crosses the line. Nothing new is stored.

## The decisions

- D1: Filter in the api. Not: filtering in the page, because the page will page the list later and would need every recipe at once. Keep: GET /recipes with no q answers as today.

## What is still open

Nothing.

## Touch points

| Piece | File or module | What changes |
|---|---|---|
| Recipe api | services/api/src/recipes | takes a q option and filters by title |
| Web app | web/src/routes | gains a search box above the list |

## Test surfaces

The api tests go beside the list module, copying services/api/src/recipes/list.test.ts.

## Not doing

Searching by ingredient or by tag, as the brief says.

## Read first

- services/api/src/recipes/list.ts: the list the filter extends.
`;

// What the design skill leaves: one finished screen with its states, the tokens it links, and the list.
// The screen links the tokens by a relative path, so a walk in fake mode shows the Files tab preview
// loading them the way a real design does.
const FAKE_TOKENS = `:root {
  --paper: #ffffff;
  --ink: #1f2328;
  --muted: #57606a;
  --line: #d0d7de;
  --danger: #b42318;
  --font: system-ui, sans-serif;
  --space-2: 8px;
  --space-4: 16px;
  --radius: 6px;
}
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.5 var(--font); }
`;

const FAKE_SCREEN = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recipes</title>
<link rel="stylesheet" href="tokens.css">
<style>
  main { max-width: 640px; margin: 0 auto; padding: var(--space-4); }
  section { border-top: 1px solid var(--line); padding: var(--space-4) 0; }
  h2 { font-size: 13px; color: var(--muted); }
  input { width: 100%; padding: var(--space-2); border: 1px solid var(--line); border-radius: var(--radius); font: inherit; }
  li { overflow-wrap: anywhere; }
  .error { color: var(--danger); }
</style>
</head>
<body>
<main>
  <h1>Recipes</h1>
  <section>
    <h2>With recipes</h2>
    <input value="soup" aria-label="Search recipes">
    <ul><li>Bean soup</li><li>Tomato soup</li></ul>
  </section>
  <section>
    <h2>Empty</h2>
    <input value="cake" aria-label="Search recipes">
    <p>No recipe has cake in its title. Clear the box to see every recipe.</p>
  </section>
  <section>
    <h2>Error</h2>
    <p class="error">The recipes did not load. The server did not answer, so try again in a minute.</p>
  </section>
  <section>
    <h2>Long text</h2>
    <ul><li>Slow cooked white bean and smoked paprika soup with garlic bread, the version for a big family dinner on a cold Sunday</li></ul>
  </section>
</main>
</body>
</html>
`;

const FAKE_DESIGN = `## Before you approve

- Concluded: one screen changes, the recipe list, which gains a search box.
- Screens: main-page.html, with Q2 on the empty state.
- Not read: the code, because the fake engine reads none.
- Next: Plan builds the screen with its four states.

## Screens

Read at: the prompt named no commit, 2026-10-25.
Tokens: proposed, because the fake engine reads no look.

### main-page.html

The recipe list with the search box above it. A cook opens it to find one recipe.
Address: the list page as today. The search text stays in the box, not in the address.
States:
- With recipes (AC1): the rows whose title holds the text.
- Empty (AC1, AC2): "No recipe has cake in its title. Clear the box to see every recipe."
- Error (no check): "The recipes did not load. The server did not answer, so try again in a minute."
- Long text (no check): a long title wraps and never runs off the page.
Data: GET /recipes?q=<text> from the architecture's Interfaces.
Reuse: the list page's own rows.
Question: Q2: Should the empty sentence offer to clear the box with a button? Default: no, the sentence only. blocks: no

## Not doing

Tags and ingredients in the search, as the brief says.

## Read first

- design/main-page.html: the four states Implement builds.
`;

// What the plan scenario adds to the card's discoveries, in the one-line form of the finish rules.
const FAKE_DISCOVERY = '- The recipe list sorts by title before it filters, in services/api/src/recipes/list.ts: a filter added after the sort keeps the order for free (plan)\n';

// Where the implement scenario left the plan. The fake follows it, as most runs do.
const FAKE_DEVIATIONS = 'None.\n';

// The files the replays say they write and the output check reads, in the same words, so a run in
// fake mode stores no problem for a file nobody wrote. The research and investigate files end in
// the sources their replays read.
const FAKE_PROGRESS = `Base: 4f2a91c

## Before you approve
- Concluded: both steps are done, and typing part of a title narrows the recipe list.
- Deviations: none.
- Surprises: none.
- QA first: AC1, type part of a title and count the rows.
- Tests: added services/api/src/recipes/list.test.ts, changed none, deleted none. No assertion was weakened.
- Not checked: the page in a browser, because this run has none.

## Steps done
1. Added filterRecipes.
   Red: node --test services/api/src/recipes/list.test.ts: "not ok 1 - filters by part of a title"
   Green: node --test services/api/src/recipes/list.test.ts: "# pass 3"
2. Tested an empty and a mixed case query.
   Check: node --test services/api/src/recipes/list.test.ts: "# pass 5"
`;
const FAKE_PR = `Filter the recipe list by title

## What changed

filterRecipes keeps the recipes whose title holds the typed text, ignoring case. An empty box shows every recipe.

## How to test

node --test services/api/src/recipes/list.test.ts
`;
// The two files for other people, in plain words with no word on how the change was made.
const FAKE_SHARE_SUMMARY = `The recipe list now has a search box. Typing part of a title shows only the recipes whose title holds it, in any case. An empty box shows every recipe again.
`;
const FAKE_SHARE_TESTING = `Open the recipe list. Type "bean" in the search box above it, and only recipes with "bean" in their title stay. Clear the box, and every recipe comes back.
`;
const FAKE_ANSWER = `The web page holds no state of its own beyond the recipe list it fetched.

Confidence: high, because the workspace file says what each service holds.

## Why

AGENTS.md names the api as the one place that keeps data, and the web page as what draws it.

## Searched and not found

- a store or a cache in the web page, in services/web

## Sources

- AGENTS.md:1 what each service holds
`;
const FAKE_INVESTIGATION = `listRecipes maps over a list the route can hand it as undefined.

Confidence: medium, because the empty file was read in the code and not run.

## What was reported

The recipe list is blank when the data file is empty.

## What was found

The page draws no rows and shows no error.

## Hypotheses tried

- The page hides a failed fetch. Result: ruled out. The route answers, so there is no failed fetch to hide.
- The route hands the list nothing for an empty file. Result: held. services/api/src/server.ts:1 passes what it read straight on.

## The fix or next step

Hand listRecipes an empty list when the file is empty, in services/api/src/server.ts.

## Searched and not found

Nothing.

## If this becomes a card

Problem: an empty data file leaves the recipe list blank with no word on why.

- AC1 (must): An empty data file shows the empty list text.
  Check: node --test services/api/src/recipes/list.test.ts

Change: services/api/src/server.ts, the route that reads the file.

## Sources

- services/api/src/recipes/list.ts:1 listRecipes
- services/api/src/server.ts:1 the route
`;
const FAKE_WRAPUP = '- Added browser-filtering.md: the recipe list is filtered in the browser.\n';
const FAKE_OPTIMIZE_CHANGES = '- Shortened browser-filtering.md, and kept what is still true.\n';
const FAKE_ORIENT_CHANGES = '- Added project-rules.md: the rules AGENTS.md and the person gave.\n- Asked whether a folder is off limits. The answer: the tickets folder.\n- Read AGENTS.md and README.md, and found nothing else worth keeping.\n';
const FAKE_LEARN_CHANGES = '- Filled the repository file: what it is for and how to install, run, test, lint and build it.\n- Filled its run recipe section from the README and the CI workflow.\n';
const FAKE_MAIN_FILES: Record<string, [string, string]> = {
  research: ['answer.md', FAKE_ANSWER],
  investigate: ['report.md', FAKE_INVESTIGATION],
  wrapup: ['changes.md', FAKE_WRAPUP],
  optimize: ['changes.md', FAKE_OPTIMIZE_CHANGES],
  orient: ['changes.md', FAKE_ORIENT_CHANGES],
  'learn-repo': ['changes.md', FAKE_LEARN_CHANGES],
};

// The round the pr-review scenario leaves behind, in the block shape the Review tab parses: the place
// on a line of its own, then the conventional comment, a blank line and its discussion. Without it the
// tab a walk in fake mode opens has no round to draw, so it could only be read against a file written
// by hand.
const FAKE_ROUND = `services/api/src/recipes/list.ts:1-3
issue: The match is case sensitive

A person typing "bean" finds no recipe called "Bean soup". Lower case both sides before comparing
them.

services/api/src/recipes/list.ts:2
suggestion (non-blocking): Return every recipe for an empty query

An empty query matches nothing here, and the ticket asks for every recipe then. Return the list
unchanged when the query is empty.

services/api/src/recipes/list.ts:1
praise: The filter is pure

It sits next to the list it belongs to, which is where the next reader looks for it.
`;

// The verdicts the feedback scenario gives, in turn, to the refs of the comments file the loop wrote.
// The skill's block shape, so the loop's parser applies them as it would a real run's.
const FAKE_VERDICTS = [
  ['fix', 'The search should ignore case.', 'The reviewer is right, the match compares the raw strings.', 'Good catch. I will lower case both sides and add a test for it.'],
  ['clarify', 'Asks whether an empty box shows every recipe.', 'The ticket does not say, and the answer changes the fix.', 'Should an empty box show every recipe, or none until a word is typed?'],
  ['none', 'Praise for keeping the filter pure.', 'Nothing to act on.', ''],
] as const;

export function fakeTriage(discussions: string, broken = false): string {
  const refs = [...discussions.matchAll(/^## (T\d+)$/gm)].map((match) => match[1] ?? '');
  const blocks = refs.map((ref, at) => {
    const [verdict, summary, reason, reply] = FAKE_VERDICTS[at % FAKE_VERDICTS.length] ?? FAKE_VERDICTS[0];
    return `${ref}: ${broken && at === 0 ? 'maybe' : verdict}\nSummary: ${summary}\nReason: ${reason}\nReply: ${reply}`.trimEnd();
  });
  return `${blocks.join('\n\n')}\n`;
}

// What the optimize scenario leaves in the file it was asked to rewrite. Shorter than the wrap-up's
// note below, because shortening is what the pass is for.
const FAKE_OPTIMIZED = `---
description: Read before changing the recipe search. Why the list needs no search endpoint.
source: APP-7 at 4f2a91c (2026-10-24)
paths: services/api/src/recipes/list.ts
---

# The fake engine's optimized note

The recipe list is filtered in the browser. A search box needs no endpoint.
`;

// What Learn this project leaves once answered: the project's rules as prohibitions, every line with
// where it came from, as the orient skill asks.
const FAKE_RULES = `---
description: Read before you run a command or change a folder. The rules people wrote down for this project.
source: Learn this project
paths: AGENTS.md, README.md
---

# Project rules

- Never reach the network in a test, because the demo has to run offline. (from AGENTS.md)
- Never change the tickets folder, because the recording follows the tickets in it. (told by the person)
- Run the tests with \`node --test\`, because there is nothing to install. (from README.md)
`;

// What Learn your repositories writes in place of the line that says nobody has written what the
// repository is for, every line with where it was read, as the learn-repo skill asks.
const FAKE_PURPOSE = `The recipe list and its search, for the recipe app. (from README.md)

- Install: nothing to install, the folder has no dependencies. (from README.md)
- Run: \`node server.js\`. (from README.md)
- Test: \`node --test\`. (from the ci.yml workflow)
- Lint: none, the CI workflow runs no linter. (from the ci.yml workflow)
- Build: none, the code runs as it is. (from README.md)`;

// Its section of the run recipe, in the shape the other sections have.
const fakeRecipeSection = (repo: string): string => `${recipeHeading(repo)}

Run these in ${repo === '.' ? 'the project folder' : `the \`${repo}\` folder of the project`}.

- Install: Nothing to install, the folder has no dependencies. (from README.md)
- Test: \`node --test\`. (from the ci.yml workflow)
- Lint: Not read. Looked in README.md and the ci.yml workflow.
- Type-check: Not read. Looked in README.md and the ci.yml workflow.
- Build: None, the code runs as it is. (from README.md)
- Start: \`node server.js\`. (from README.md)
- Catches: None written yet. A run that finds one adds it here.
`;

// The repository file and the run recipe with the fake's lines in, keeping every line Nolzu wrote.
function fakeLearnRepo(knowledgeDir: string, repo: string): void {
  const file = join(knowledgeDir, ...repoKnowledgePath(repo).split('/'));
  mkdirSync(join(file, '..'), { recursive: true });
  const before = existsSync(file) ? readFileSync(file, 'utf8') : `# The ${repo} repository\n\n${REPO_STUB_LINE}\n`;
  writeFileSync(file, before.includes(REPO_STUB_LINE) ? before.replace(REPO_STUB_LINE, FAKE_PURPOSE) : `${before.trimEnd()}\n\n${FAKE_PURPOSE}\n`);
  const recipe = join(knowledgeDir, 'run-recipe.md');
  const text = existsSync(recipe) ? readFileSync(recipe, 'utf8') : '# How to run each repository\n';
  writeFileSync(recipe, withRecipeSection(text, repo, fakeRecipeSection(repo)));
}

// The answers the orient scenario offers with its question, in the form the finish rules teach.
const FAKE_ORIENT_OPTIONS = `- The tickets folder: the recording follows the tickets in it, so no run may change them.
- None: every folder may change when a card needs it.
- Skip: nothing to add.
`;

// What one knowledge file looks like, in the entry shape the knowledge rules give. The wrap-up
// scenario writes it, because a knowledge run that wrote nothing would leave the runner's commit with
// nothing to commit, and the demo would show an empty wrap-up. A real run writes what the card taught.
const FAKE_KNOWLEDGE = `---
description: Read before changing the recipe search. Why the list is filtered in the browser.
source: APP-7 at 4f2a91c (2026-10-24)
paths: services/api/src/recipes/list.ts
---

# The fake engine's wrap-up note

The recipe list is filtered in the browser, so a search box needs no new endpoint.

Why: the fake engine writes this note so a wrap-up run has something to commit.
`;

// The plan the plan scenario's replay writes, the same two steps, in the sections and the step form
// the plan skill teaches, so the card page shows the steps with their files in fake mode too.
const FAKE_PLAN = `## Before you approve

- Concluded: the api filters the recipe list by title, and the page asks it again as the person types.
- Decide: D1, the api filters, not the page.
- Size: 2 steps, 2 files. AC1 and AC2 each go to a step.
- Not read: nothing, the fake engine reads no code.
- Next: Implement builds steps 1 and 2, and QA runs qa/checks.md.

## Approach

Read at: the prompt named no commit, 2026-10-25.
The api filters the recipe list by title. The page asks it again as the person types.

## Decisions

- D1: The api filters the recipes. Not: filtering in the page, because the list will outgrow one fetch.

## Steps

1. Add filterRecipes(recipes, query) to the recipe list module.
   Files: services/api/src/recipes/list.ts
   Uses: listRecipes in services/api/src/recipes/list.ts. Gives filterRecipes(recipes, query) to step 2.
   Tests: an empty query and a title match, written first.
   Check: npm test fails on the title match first, then passes.
   Undo: remove the function.
   Covers: AC1, AC2
2. Test an empty query and a title match.
   Files: services/api/src/recipes/list.test.ts (new)
   Tests: this step is the test.
   Check: npm test passes.
   Undo: delete the test file.
   Covers: AC1, AC2

## Risks

A slow list makes the box lag. The test with many recipes would show it.

## Order

Nothing to add: the steps run in their numbers.

## Settled questions

- Q1: titles only, the brief's default.

## Rules that apply

None.

## Not doing

Ingredient search, which the brief leaves out.

## Read first

- services/api/src/recipes/list.ts: listRecipes, which step 1 extends.
`;

// The plan for other people an epic's plan writes, one plain task per step of FAKE_PLAN.
const FAKE_SHARE_PLAN = `The recipe list gets a search box, because the list is too long to scan by eye.

## Approach

The api filters the recipes by title, so the page never loads the whole list to search it. The page asks the api again as the person types.

## Risks

A slow list makes the box lag. A test with many recipes would show it early.

## Order

The filter comes first, and its test checks it.

## Tasks

### 1. Filter recipes by title in the api
The recipe list grows past what one page can load, so the api filters it by a search word, in any case. Done when part of a title finds the recipe.

### 2. Test the recipe filter
A test proves the filter: an empty word returns every recipe, and a title match returns only that recipe. Done when the test passes.
`;

// What QA will check. The plan scenario writes the list and the qa scenario reports on it, row for
// row in the same order, as the two skills do.
const FAKE_CHECKS = [
  "Run the project's tests, they pass (from AGENTS.md)",
  'AC1 (must): Type a word in the search box, only recipes with that word in the title show',
  'AC2 (should): Clear the box, every recipe shows',
];
// How each check is observed, on the line under it in qa/checks.md, and what QA saw, on the report row.
const FAKE_HOW = ['npm test', 'a browser test types a word and counts the rows', 'a browser test clears the box and counts the rows'];
const FAKE_EVIDENCE = ['"Tests 12 passed"', '"3 of 12 rows show"', '"12 of 12 rows show"'];
const FAKE_CHECKS_FILE = FAKE_CHECKS.map((step, at) => `${at + 1}. ${step}\n   How: ${FAKE_HOW[at]}`).join('\n');
const proved = (at: number) => `   How: ${FAKE_HOW[at]}\n   Evidence: ${FAKE_EVIDENCE[at]}`;
const FAKE_REPORT = `## 1. Verdict

- PASS: every check held, the project's tests and both acceptance checks.
- Not checked: the search on a small screen, the browser had one size.
- For you: type a long word on a phone and see the list stay readable.

## 2. What QA checked

${FAKE_CHECKS.map((step, at) => `${at + 1}. pass: ${step}\n${proved(at)}`).join('\n')}

## 3. What was not checked

The search on a small screen, because the browser had one size.
`;

// The report of the QA switch's first round: the must criterion fails with its reason, and the third
// check is not reached, as the qa skill says to stop once the verdict cannot change.
const FAKE_FAIL_REPORT = `## 1. Verdict

- FAIL: AC1 (must) failed, typing a word in the search box leaves every recipe in the list.
- Not checked: AC2 (should), not reached after AC1 failed.

## 2. What QA checked

1. pass: ${FAKE_CHECKS[0]}
${proved(0)}
2. fail: ${FAKE_CHECKS[1]}
   Reason: every recipe stayed in the list
   Expected: only recipes with that word in the title show
   Actual: every recipe stayed in the list
   How: ${FAKE_HOW[1]}
   Evidence: qa/evidence/2-search-box.png, 12 of 12 rows show
3. not reached: ${FAKE_CHECKS[2]}
   Reason: check 2 failed, so the verdict could not change

## 3. What was not checked

Check 3, because check 2 failed and the verdict could not change.
`;

// A screenshot of one transparent pixel, named after its check the way the qa skill names one, so
// Fix it has a file to hand on and the QA panel has one to draw.
const FAKE_SHOT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

// The answers the plan switch's question offers, in the form the finish rules teach.
const FAKE_OPTIONS = `- Titles only: the box finds a recipe by its title, as the ticket says.
- Titles and ingredients: the box also finds a recipe by what goes in it.
`;

// A job reduced to what the fake engine reads, so a test can replay a scenario by its name alone.
// With the card folder it also writes the phase's summary, as the skill does. With the knowledge
// folder the wrap-up writes one knowledge file, and optimize rewrites the one the job names.
export type FakeEngine = Omit<Engine, 'spawn'> & {
  spawn(job: Pick<Job, 'phase'> & Partial<Pick<Job, 'cardKey' | 'taskDir' | 'knowledgeDir' | 'knowledgeFile' | 'repositories' | 'resumeFrom' | 'prompt'>>, signal: AbortSignal): AsyncIterable<string>;
};

// Only the process is fake. Parsing and the sentinel check are the ones the Claude engine uses.
export function fakeEngine(delayScale: number, switches: FakeSwitches = {}): FakeEngine {
  return {
    name: 'fake',
    // The streams it replays came from Claude Code, so its model names are that vendor's.
    vendor: 'claude-code',
    async *spawn(job, signal) {
      const scenario = scenarioOf(job, switches);
      // hasOwn, so a phase such as "constructor" gets this message and not a file error.
      const delay = Object.hasOwn(scenarioDelays, scenario) ? scenarioDelays[scenario] : undefined;
      if (delay === undefined) throw new Error(`The fake engine has no scenario for the phase "${job.phase}".`);
      // The streams were recorded on APP-1. A run of another card names its own folder and checkout, or
      // its activity line and its log point at APP-1's files.
      const recorded = readFileSync(new URL(`../fake/${scenario}.ndjson`, import.meta.url), 'utf8');
      const key = job.cardKey;
      const text = key === undefined || key === 'APP-1' || isMaintenanceKey(key) ? recorded : recorded.replaceAll('.tasks/APP-1/', `.tasks/${key}/`).replace(/worktrees\/APP-1(?=["/])/g, `worktrees/${key}`);
      const summary = SUMMARIES[scenario];
      const taskDir = job.taskDir;
      const writeSummary = () => {
        if (taskDir === undefined || summary === undefined) return;
        mkdirSync(join(taskDir, job.phase), { recursive: true });
        writeFileSync(join(taskDir, job.phase, 'summary.md'), `${summary}\n`);
      };
      let said = false;
      for (const line of text.split('\n').filter((line) => line.trim() !== '')) {
        if (!signal.aborted && delayScale > 0) await wait(delay * delayScale, signal);
        if (signal.aborted) return;
        yield line;
        // The skill keeps the summary current after each file it changes, so the
        // replay writes it after its first edit too, and the peek sheet has a summary while it runs.
        if (!said && /"name": ?"(Edit|Write)"/.test(line)) {
          said = true;
          writeSummary();
        }
      }
      writeSummary();
      const knowledgeDir = job.knowledgeDir ?? null;
      if (job.phase === 'wrapup' && knowledgeDir !== null) {
        mkdirSync(knowledgeDir, { recursive: true });
        writeFileSync(join(knowledgeDir, 'browser-filtering.md'), FAKE_KNOWLEDGE);
      }
      if (scenario === 'orient' && knowledgeDir !== null) {
        mkdirSync(knowledgeDir, { recursive: true });
        writeFileSync(join(knowledgeDir, 'project-rules.md'), FAKE_RULES);
      }
      const learning = job.cardKey === undefined ? null : repoOfLearnKey(job.cardKey);
      if (scenario === 'learn-repo' && knowledgeDir !== null && learning !== null) fakeLearnRepo(knowledgeDir, learning);
      if (scenario === 'orient-asks' && taskDir !== undefined) {
        mkdirSync(join(taskDir, job.phase), { recursive: true });
        writeFileSync(join(taskDir, job.phase, QUESTION_FILE), FAKE_ORIENT_OPTIONS);
      }
      // The file the run was asked to rewrite, and no other. A real optimize run is told which one
      // in its prompt; the fake is told in the job, because it reads no prompt.
      const knowledgeFile = job.knowledgeFile ?? null;
      if (job.phase === 'optimize' && knowledgeDir !== null && knowledgeFile !== null) {
        writeFileSync(join(knowledgeDir, ...knowledgeFile.split('/')), FAKE_OPTIMIZED);
      }
      // The assessment itself, beside the summary the block above wrote. It is the phase's artifact,
      // so it goes in the card folder like every other one.
      if (job.phase === 'assess' && job.taskDir !== undefined) {
        writeFileSync(join(job.taskDir, job.phase, 'assessment.md'), FAKE_ASSESSMENT);
      }
      // The round the Review tab reads. Always `round.md`, which is round 1, because the skill names
      // that one file and nothing numbers a second yet. A re-review in fake mode overwrites it, the
      // same way a real one does.
      if (job.phase === 'pr-review' && job.taskDir !== undefined) {
        writeFileSync(join(job.taskDir, job.phase, 'round.md'), FAKE_ROUND);
      }
      // The triage of the comments file the loop wrote before the run, one block per ref in it.
      if (job.phase === 'feedback' && job.taskDir !== undefined) {
        const comments = join(job.taskDir, job.phase, 'discussions.md');
        const text = existsSync(comments) ? readFileSync(comments, 'utf8') : '';
        writeFileSync(join(job.taskDir, job.phase, 'triage.md'), fakeTriage(text, switches.triageBroken === true));
      }
      // The plan the replay says it writes. On a project with several repositories it ends in the
      // line that names them, every one the job lists, so the loop picks the card's list from it.
      // The brief, with the short title, kind and branch the refine skill puts on top.
      if (scenario === 'refine' && job.taskDir !== undefined) {
        mkdirSync(join(job.taskDir, job.phase), { recursive: true });
        writeFileSync(join(job.taskDir, job.phase, 'refined.md'), `# ${job.cardKey ?? 'APP-1'}: ${FAKE_REFINED}`);
      }
      if (scenario === 'plan-asks' && job.taskDir !== undefined) {
        mkdirSync(join(job.taskDir, job.phase), { recursive: true });
        writeFileSync(join(job.taskDir, job.phase, QUESTION_FILE), FAKE_OPTIONS);
      }
      if (scenario === 'plan' && job.taskDir !== undefined) {
        const line = job.repositories === undefined ? '' : `\nRepositories: ${job.repositories.join(', ')}\n`;
        // On an epic the plan goes on from the architecture's D1, as the plan skill says.
        const epic = existsSync(join(job.taskDir, 'architecture', 'architecture.md'));
        const plan = epic ? FAKE_PLAN.replaceAll('D1', 'D2') : FAKE_PLAN;
        writeFileSync(join(job.taskDir, job.phase, 'plan.md'), `${plan}${line}`);
        // The fake reads no prompt, so the architecture an epic has is what tells it the card is one.
        if (epic) {
          mkdirSync(join(job.taskDir, 'share'), { recursive: true });
          writeFileSync(join(job.taskDir, SHARE_PLAN_FILE), FAKE_SHARE_PLAN);
        }
        mkdirSync(join(job.taskDir, 'qa'), { recursive: true });
        writeFileSync(join(job.taskDir, 'qa', 'checks.md'), `${FAKE_CHECKS_FILE}\n`);
        // Added at the end and never rewritten, as the finish rules say, and not again by a second plan,
        // which met nothing new.
        const discoveries = join(job.taskDir, 'discoveries.md');
        if (!existsSync(discoveries) || !readFileSync(discoveries, 'utf8').includes(FAKE_DISCOVERY)) appendFileSync(discoveries, FAKE_DISCOVERY);
      }
      if (scenario === 'architecture' && job.taskDir !== undefined) {
        writeFileSync(join(job.taskDir, job.phase, 'architecture.md'), FAKE_ARCHITECTURE);
      }
      if (scenario === 'design' && job.taskDir !== undefined) {
        writeFileSync(join(job.taskDir, job.phase, 'main-page.html'), FAKE_SCREEN);
        writeFileSync(join(job.taskDir, job.phase, 'tokens.css'), FAKE_TOKENS);
        writeFileSync(join(job.taskDir, job.phase, 'design.md'), FAKE_DESIGN);
      }
      if (scenario === 'implement' && job.taskDir !== undefined) {
        writeFileSync(join(job.taskDir, job.phase, 'deviations.md'), FAKE_DEVIATIONS);
        writeFileSync(join(job.taskDir, job.phase, 'progress.md'), FAKE_PROGRESS);
        writeFileSync(join(job.taskDir, job.phase, 'pr.md'), FAKE_PR);
        mkdirSync(join(job.taskDir, 'share'), { recursive: true });
        writeFileSync(join(job.taskDir, 'share', 'SUMMARY.md'), FAKE_SHARE_SUMMARY);
        writeFileSync(join(job.taskDir, 'share', 'TESTING.md'), FAKE_SHARE_TESTING);
      }
      const own = FAKE_MAIN_FILES[scenario];
      if (own !== undefined && job.taskDir !== undefined) writeFileSync(join(job.taskDir, job.phase, own[0]), own[1]);
      if (scenario === 'qa' && job.taskDir !== undefined) {
        writeFileSync(join(job.taskDir, job.phase, 'report.md'), FAKE_REPORT);
      }
      if (scenario === 'qa-fail' && job.taskDir !== undefined) {
        writeFileSync(join(job.taskDir, job.phase, 'report.md'), FAKE_FAIL_REPORT);
        mkdirSync(join(job.taskDir, job.phase, 'evidence'), { recursive: true });
        writeFileSync(join(job.taskDir, job.phase, 'evidence', '2-search-box.png'), FAKE_SHOT);
      }
    },
    parse: (line) => withSentinels(parseClaudeLine(line)),
    // The streams it replays came from Claude Code, so it offers what that engine offers.
    listModels: claudeModels,
  };
}
