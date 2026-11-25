---
name: nolzu-plan
description: Turns a refined brief into a numbered plan with the files each step touches, the tests to write first, the risks, how to undo the change and the list of what QA will check. Use it for the plan phase of a card, after refine and before any code is written.
---

# Plan a card

Read `<card folder>/refine/refined.md`, then `<card folder>/architecture/architecture.md` and `<card folder>/design/design.md` when they are there, then the repository. An epic drawn before the design phase had that name has `<card folder>/mockups/mockups.md` in place of the design list, so read that one when there is no design.md. Write the plan the implement phase works from, and the list of what QA will check. Write no source file and run no command. This phase writes nothing else, besides the discoveries and an epic's plan for other people.

When the project folder, not a card's checkout, has `.nolzu/phases/plan.md`, follow it too. It wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its prompt and need not open it.

The architecture's Touch points name where each piece lands, so start your steps from that table instead of searching the code again. Its decisions are settled: build on them, and ask before you go against one. The design list names the screens, the states each one draws and the acceptance checks each one covers, and a step that builds a screen names its HTML file.

Every file of this card is in the card folder, the folder the prompt names, next to the checkout
and not inside it.

## What to write

Write `<card folder>/plan/plan.md` with these sections, in this order, each under a second-level heading with this name. The skeleton shows the shape, and the rules under it say what goes in each part.

    ## Before you approve
    - Concluded: the api filters the recipes by title, and the page asks it again as the person types.
    - Decide: D1, the api filters, not the page.
    - My calls: D2, the box waits 200 ms after the last key.
    - Riskiest: A1 of the brief, that titles alone are enough.
    - Size: 2 steps, 3 files. AC1 and AC2 each go to a step.
    - Not read: nothing.
    - Next: Implement builds steps 1 and 2, and QA runs qa/checks.md.

    ## Approach
    Read at: 4f2a91c on 2026-10-24.
    The api takes a q option and filters by title. The page asks it again as the person types.

    ## Decisions
    - D1: The api filters the recipes. Not: filtering in the page, because the list will outgrow one fetch.

    ## Steps
    ## Risks
    ## Order
    ## Settled questions
    - Q1: titles only, the brief's default.

    ## Rules that apply
    ## Not doing
    ## Read first
    - api/src/recipes.ts: listRecipes, which step 1 extends.

`## Before you approve` is the review block the [finish rules](finish.md) describe, in the skeleton's order. Decide names the choices a person may want to change, with the option turned down. Size counts the steps and files and says where each acceptance check goes. Leave out Decide, My calls or Riskiest when there is nothing for them.

`## Approach` starts with `Read at:` and the commit and date from the prompt's line "The code you read is at commit ...", or `Read at: the prompt named no commit, <today's date>.` when it has none. Then how the change is built, in two to five sentences.

`## Decisions` holds each choice the steps build on, one line each, `D1`, `D2` and on: the rule, then `Not:` the option turned down and why. On an epic, go on from the architecture's last `D` id. Write `None.` when the plan makes no choice.

`## Steps` holds the numbered steps, in the form below. `## Risks` says what could go wrong, and what would show it early. `## Order` says which steps have to run before which, only where that is not obvious. `## Settled questions` gives each open question of the brief by its id, and on an epic those of the architecture and the design too, with the answer this plan builds on: the person's answer when the prompt has one, else the default. Write `None.` when there were none.

`## Rules that apply` holds only what the brief's own list missed, since Implement reads that list too: a rule from knowledge or the ticket, word for word with its source, and each rule from the project's Implement or QA instructions with the step or check that carries it. Write `None.` when there is nothing to add.

`## Not doing` says what a reader might expect from this plan and will not get, and why. `## Read first` lists the files Implement opens before step 1, one per line with why.

The ids never change once written. A later run that drops a decision leaves a gap rather than renumbering.

Every step carries these fields, in this order, because the implement phase reads them back. Leave out Uses and Copy when there is nothing to name.

1. What the step does, in one sentence.
2. Files: the paths it touches, with a note on each one that does not exist yet.
3. Uses: what it takes from the code or an earlier step, by path and symbol, and what it gives a later step, such as a signature.
4. Copy: existing code to follow, by path and symbol.
5. Tests: what to write first and what each test asserts. For a pure module the test comes before the code.
6. Check: the command that proves the step and the output it should give. For a test-first step, the test fails first, then passes.
7. Undo: how to take this step back on its own.
8. Covers: the acceptance checks of the brief this step serves, by their ids. A step that serves none, such as a move that makes room for the next step, says `none`.

Write the step on its numbered line, and each field on its own line under it, indented and starting
with its name and a colon. Put the files on one line, split by commas. The card page reads this form.

    1. Add a q option to GET /recipes that matches the title and ignores case.
       Files: api/src/recipes.ts, api/test/recipes.test.ts (new)
       Uses: listRecipes(db) in api/src/recipes.ts. Gives listRecipes(db, q?: string) to step 2.
       Copy: the name filter in listTags (api/src/tags.ts).
       Tests: an empty query, part of a word and mixed case, written before the code.
       Check: npm test -- recipes fails on "matches part of a word" first, then passes.
       Undo: revert both files.
       Covers: AC1
    2. Put a search box above the list that asks the api 200 ms after the last key.
       Files: web/src/routes/+page.svelte
       Tests: an empty box shows every recipe again.
       Check: npm test -- page passes.
       Undo: revert the page.
       Covers: AC1, AC2

Name what Implement would otherwise guess: the exact words a person will see, the ids and names a step adds, and what happens on an empty, malformed or failed input.

Every acceptance check of the brief is covered by at least one step. One that no step covers goes under Not doing with the reason.

Keep a step small enough to review on its own. A step that touches ten files is two steps. On an epic, each step becomes a task card that pays for whole runs of its own, so fold a small helper, or a step that covers none, into the step that first uses it. Name the decisions a step builds on by their `D` ids on its Uses line, because Nolzu copies them and the criteria of its Covers line into the task's ticket.

Read the repository whenever it settles a question. A question you can answer by reading is not a
question, it is work.

When the prompt lists the project's knowledge, read the files on the areas your steps will touch
before you read that code.

When the prompt names the project's own instructions for Implement or QA, read them and change
nothing in them. Turn each rule in them that you can check into a step or a line of the QA checks,
and name the file the rule came from, such as `(from implement.md)`.

## What QA will check

Write `<card folder>/qa/checks.md` too: what QA will check once the work is done. The person reads it
before approving, and QA reports one result per check in the same order and words. Write one
numbered line per check, a short sentence that says what to do and what should happen. Start with the project's own checks where it has any, each naming the file it
comes from, then one check for each acceptance check in `refined.md`, in the order QA can run them.
A check that comes from an acceptance check starts with its id, its level from the brief and a
colon. When a step or the brief says how to observe it, put that on a `How:` line under it. For what a
page shows, `How:` names the page to open, then the test after a semicolon.

    1. Run the project's tests, they pass (from AGENTS.md)
       How: npm test
    2. AC1 (must): Type a word in the search box, only recipes with that word in the title show
       How: open /recipes and type soup; the page test from step 2
    3. AC2 (should): Clear the box, every recipe shows

Write nothing else in the file: no result, no heading and no note. QA adds the results.

## For other people

On an epic only, as the prompt says, write `<card folder>/share/PLAN.md` for colleagues and their tickets: what changes and why, approach, risks, order, then `## Tasks` with one `### 1. <title>` per step of `plan.md`, same numbers and order, each saying what, why and when it is done. Name no card folder path, phase, prompt, knowledge note, `D`, `AC`, `Q` or step id, nor Nolzu, AI, agents or how the work was done.

## Several repositories

When the prompt lists the project's repositories, `refined.md` ends with a line such as
`Repositories: api, web`. Check it against the plan. End `plan.md` with the same line, with a
repository added where a step changes it and dropped where no step does. Use the names the prompt
gives. Nolzu reads this line, and the later of the two counts. Leave the line out when the prompt
lists no repositories.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/plan/work/`.

Write each paragraph and each list item of every file in the card folder on one line, and never break a sentence in the middle. Add each surprise you met on the way to `<card folder>/discoveries.md` as one line, in the form the [finish rules](finish.md) give. Write nothing there when nothing surprised you.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/plan/summary.md`, so the
ticket page can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the plan is written:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/plan/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
