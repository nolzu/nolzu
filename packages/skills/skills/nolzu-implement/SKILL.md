---
name: nolzu-implement
description: Carries out a card's plan step by step in the card's checkout, with the test before the code for a pure module, and leaves a pull request text for a person to confirm. Use it for the implement phase of a card, after the plan.
---

# Implement a card

Every file of this card is in the card folder, which is the folder the prompt names. It sits in the
project and not in the checkout you start in, so use the path the prompt gives. The code you change
is the checkout you start in.

When the project folder, not a card's checkout, has `.nolzu/phases/implement.md`, follow it too. It
wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its
prompt and need not open it.

## Before the first step

Start by reading `<card folder>/implement/progress.md` when it is there. It lists the plan steps an
earlier run of this phase finished. That run may have stopped halfway through a step, and its changes
are still in the checkout, because nothing is committed for you. So when the file lists any step as
done, run the project's checks first, fix what they show, and then go on from the first step that is
not done. Do not redo a step the file lists as done.

Then read `<card folder>/plan/plan.md`. Each step names what it does, the files it touches, the tests
to write first, how to undo it and the acceptance checks it covers. Read
`<card folder>/refine/refined.md` for those checks, and `<card folder>/architecture/architecture.md`
and `<card folder>/design/design.md` when they are there. A card that is a task of an epic finds them among the epic's documents the prompt names. An epic drawn before the design phase had that name has `<card folder>/mockups/mockups.md` in place of the design list. The architecture's decisions are settled.

When the prompt lists the project's knowledge, read the files on the conventions and the traps of
the code you change before the first step, and the run recipe (`run-recipe.md`) for the commands. A
command that failed or needed something extra is a discovery that starts with `Run recipe:`, and so
is a command you used where the recipe says Not read. A package cache or an install log never goes in
the card folder: Nolzu points the caches outside it already.

A screen you build matches the design. Reuse the values in `<card folder>/design/tokens.css`, or in the epic's `tokens.css` the prompt names, under the names the repository already uses for them, and add a value to the repository's own styles only when the design needs one it lacks. Match the layout and the words of the screen's HTML file, every state it draws included. When the code cannot follow the design, follow the code and write the change in `<card folder>/implement/deviations.md`, the same as a change from the plan.

## How to work through the plan

Take the steps in order. For a pure module, write the test first, see it fail, then write the code
that makes it pass. Do the same for a fix that a test can reproduce: the failing test first, then the
fix. For the rest, write the test in the same step as the code. Run the project's test command after
each step, and do not start the next step while the last one fails.

Keep to the plan. When a step turns out wrong, change the smallest thing that makes it right and write
it down as a deviation (see below). Ask only when it cannot be made right without a real change of
scope.

Do not commit, never push and never open a pull request. The commit and the pull request are a
person's action on the card, after they have read what you did. Write no commit message either: the
person writes one, or asks for one, when they commit.

## The progress record

`<card folder>/implement/progress.md` is the record of this phase. QA checks your work against it,
and the next run finds its place in it, because a run can stop at any moment.

Make it when it is not there, with `Base:` and the commit the prompt names ("The code you read is at
commit ...") on the first line, or `Base: the prompt named no commit.` when it names none. Keep a
`Base:` line an earlier run wrote.

After every step you finish, add it under `## Steps done`: the step number and what it did on one
line, then, indented, the command that proved it and its real output line in quotes. A test-first step
gets `Red:`, the run that failed before the code, and `Green:`, the run that passed after it. Any other
step gets `Check:`. A fix after QA, or after a person sent the card back, is a `- Fix:` item at the end
with what failed and the same lines. Add to the file and never remove or rewrite a line an earlier run
wrote: that proof is what QA reads.

When the run ends, write `## Before you approve` between `Base:` and `## Steps done`, as the
[finish rules](finish.md) say, with these lines among the others: `Deviations:` with how many and what
they change, `Surprises:`, `QA first:` with what QA should check first, and `Tests:` with every test
file added, changed or deleted and any assertion you weakened or removed. A re-run replaces only this
block and says in it what changed. Only a step line starts with a number. Start every other line with
a word, as below, because Nolzu reads a line that starts with a number, or with "step" and a number,
as a finished step.

    Base: 4f2a91c

    ## Before you approve
    - Concluded: steps 1 and 2 are done, and the list filters by title as you type.
    - Deviations: 1, step 2 waits 300 ms. It changes no criterion.
    - Surprises: the list caches its first fetch, written to discoveries.md.
    - QA first: AC1, type "bean" and count the rows.
    - Tests: added api/test/recipes.test.ts, changed none, deleted none. No assertion was weakened.
    - Not checked: the mobile layout, because no browser ran.

    ## Steps done
    1. Added a q option to GET /recipes in api/src/recipes.ts.
       Red: npm test -- recipes: "FAIL matches part of a word"
       Green: npm test -- recipes: "Tests 3 passed (3)"
    2. Put the search box above the list in web/src/routes/+page.svelte.
       Check: npm test: "Tests 12 passed (12)"
    - Fix: QA failed AC2, a cleared box kept the filter.
       Red: npm test -- page: "FAIL shows every recipe when cleared"
       Green: npm test -- page: "Tests 4 passed (4)"

## What to write

Write `<card folder>/implement/pr.md`, the pull request text. The first line is the title. Then
`## What changed`, for the person who reviews the code, `## Why` when the title does not say it, and
`## How to test`, with the commands and the steps. Nolzu puts it under the plain summary, without the
title, as the pull request body, and the compare page carries only a few thousand characters, so keep
it short and do not repeat the summary.

Write `<card folder>/implement/deviations.md`, one line for each place the work left the plan or the design, as a ruling: which step or screen, what you did instead, `Why:`, and `If wrong:` with what it costs when your call was wrong. QA and the wrap-up read it, so a change from the plan or the design that is not in this file looks like a mistake to them. When the work followed the plan and the design, write one line: `None.`

    - Step 2: the search box waits 300 ms, not 200 ms. Why: the list page already waits 300 ms for its filter. If wrong: the box feels slow, and one value changes it.

Write `<card folder>/share/SUMMARY.md` and `<card folder>/share/TESTING.md`, and bring both up to date on every run of this phase, a fix after QA, a pull request comment or a discussion included. A colleague or a manager who never saw this card reads them, so keep them short and plain. SUMMARY.md says what the change is for, what it changes and what a reader needs to know. TESTING.md tells a person who does not write code how to try the change by hand: where to go, what to do, what they should see. When nobody can try it by hand, such as a docs or config change or a service with no screen, say so in a line or two and say where the effect shows or who can check it. Neither file names the card, its phases or how the work was done.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/implement/work/`.

Write each paragraph and each list item of every file in the card folder on one line, and never break a sentence in the middle. Add each surprise you met on the way to `<card folder>/discoveries.md` as one line, in the form the [finish rules](finish.md) give. Write nothing there when nothing surprised you.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/implement/summary.md`, so
the ticket page can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When every step is done and the checks pass:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/implement/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
