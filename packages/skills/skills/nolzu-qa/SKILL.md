---
name: nolzu-qa
description: Checks a card's finished work against the acceptance checks in its brief, runs the project's own checks against the running app, and ends with a PASS, FAIL or BLOCKED verdict and a report. Use it for the QA phase of a card, after the implement phase.
---

# Check a card

Read `<card folder>/refine/refined.md` for the acceptance checks and their levels,
`<card folder>/plan/plan.md` for what the work was meant to touch, and
`<card folder>/implement/deviations.md` for where the work left the plan and why, then check the
changes in the checkout you start in against them. When `<card folder>/qa/checks.md` exists, it holds
the checks the person approved with the plan. Change no source file: fixing is a separate run on the
implement phase.

When the project folder, not a card's checkout, has `.nolzu/phases/qa.md`, follow it too. It wins
over this skill except on file names, headings, fields and ids. A Nolzu run has it in its prompt and
need not open it.

Every file of this card is in the card folder, the folder the prompt names, not in the checkout
you start in.

## The app

When the project says how to start the app, Nolzu starts it before this run and stops it after.
Do not start or stop it yourself, nor an app the person runs. When nothing was started, run the
checks that need no running app. Read `<card folder>/qa/app-start.md`, what the start printed,
first when it exists. When a check needs what is missing, such as an unreachable service, data the
app does not have, or the card's code where that file says other code runs, it is BLOCKED naming
exactly what is missing, never FAIL. Create test data only where the project's QA instructions
allow it, never on another host: start each name with `qa-<card key>-`, delete it when you are
done, and list it on the row's `How:` line.

When `<card folder>/qa/addresses.md` exists, check against its addresses, one name and address per
line, never a guessed host or port.

## How to check

When the prompt lists the project's knowledge, read the run recipe (`run-recipe.md`) first when it
is there: it says how to install, test and start each repository. A command that failed or needed
something extra is a discovery that starts with `Run recipe:`, and so is a command you used where
the recipe says Not read. Run the project's own checks first, the ones its README or its
`package.json` scripts name, because they fail fastest.

Then take the checks one at a time. With `<card folder>/qa/checks.md`, they are its steps, in its
order, and a step that names the project's own checks is the run you made first. Without it, you
make your own list: the project's own checks, then the acceptance checks in the brief. For each
check, find the way to observe it: a test, a command, a request against the running app, or a page
in a browser when this run has one. An acceptance check you could not observe is not a pass. With a
browser, judge a page by what it shows, not by a test alone, and name the page on the row's `How:`
line.

Read the changes in the checkout, so a check that passes for the wrong reason is caught. A test that
was changed to match the code proves nothing. A change listed in
`<card folder>/implement/deviations.md` is not a failure on its own: judge it by the acceptance
checks.

When the card has a design, which is `<card folder>/design/design.md` or the epic's design the
prompt names, compare each screen the work changed with its HTML file there. With a browser, open
the running screen and the design file, and write in the report what differs: the layout, the words,
the colors, a state the running screen does not have. Without a browser, say in the report that the
screens were not compared.

Stop checking when the answer cannot change. One failed `must` check is a FAIL. The checks you did
not get to stay in the report as not reached.

## Evidence

Keep the proof of each row in `<card folder>/qa/evidence/`: a screenshot of anything judged by
looking at a page, and any long output you save. Start each name with the row's number, then
lower-case words, such as `3-api-down-message.png`, and never reuse a name. Nolzu hands the
screenshot of a failed row to the next implement run by that number.

The browser saves screenshots in the checkout you start in. Move each one into
`<card folder>/qa/evidence/` once you take it. When you are done, delete what the browser left in
the checkout, the `.playwright-mcp` folder included, or a later run stages it into the card's
branch. Without a browser, judge a page check by the test its `How:` line names; one with none is not
reached.

## What to write

Write `<card folder>/qa/report.md` with three sections, in this order, under these headings.

1. `## 1. Verdict`: the review block. Bullets only, at most 15, none starting with a digit: the
   verdict and its reason in the words of the verdict line, the failing ids first, what was not
   checked and why, and the checks left for the person.
2. `## 2. What QA checked`: one row per check, in the form below.
3. `## 3. What was not checked`: what was not checked, and why. A brief with no acceptance checks
   is named here.

Section 1 looks like this:

    ## 1. Verdict

    - FAIL: AC2 (must) failed, no message shows when the api is down.
    - Not checked: AC3 (should), not reached after AC2 failed.
    - For you: open the list on a phone, QA had one screen size.

The ticket page reads section 2 as a checklist, so each row is one numbered line: the result, a
colon, then the step. The result is one of three words, in lower case.

- `pass`: the check ran and you saw it hold.
- `fail`: the check ran and did not hold.
- `not reached`: the run stopped before this check, or you could not see the result. Not seen is
  not checked, never a pass.

A row from an acceptance check starts its step with that check's id and level, such as
`AC2 (must):`.

Under a pass or fail row, write `How:` with what you ran or opened, and `Evidence:` with the key
output line quoted or the file in `<card folder>/qa/evidence/`, named from the card folder. A fail
row adds `Reason:` with what went wrong in a few words, `Expected:` with what should have happened,
and `Actual:` with what happened, which Fix it hands to Implement. A not reached row says why in
`Reason:`.

    ## 2. What QA checked

    1. pass: Run the project's tests, they pass
       How: npm test
       Evidence: "Tests 12 passed"
    2. pass: AC1 (must): Open the recipe list, it shows recipes
       How: opened the list page
       Evidence: qa/evidence/2-list.png, 12 recipes show
    3. fail: AC2 (must): Stop the api and reload, a message shows
       Reason: no message showed
       Expected: a message says the recipes cannot load
       Actual: the list was empty and no message showed
       How: stopped the api, reloaded the list page
       Evidence: qa/evidence/3-no-message.png
    4. not reached: AC3 (should): Start the api again, the list comes back
       Reason: AC2 failed, so the verdict could not change

With `<card folder>/qa/checks.md`, write one row for each of its steps, in its order and in its
words, so the person reads the result next to the test they approved. A check you add goes after
them. Write nothing else there: no table, no bold, no heading, or the page shows plain text with
no checklist.

Correct `<card folder>/share/TESTING.md` when it is there: you know what really works, so fix each step that did not work as written and each result a person would not see. Leave out this machine's setup, such as a service that is down: that is a discovery. Change no other file in `<card folder>/share/`.

## The verdict

Follow the [verdict rules](verdict.md) exactly. They also decide which of the three words fits.

## Output format

Proof goes in `<card folder>/qa/evidence/`, and anything else you store beyond these files in `<card folder>/qa/work/`.

Write each paragraph and each list item of every file in the card folder on one line, and never break a sentence in the middle. Add each surprise you met on the way to `<card folder>/discoveries.md` as one line, in the form the [finish rules](finish.md) give. Write nothing there when nothing surprised you.

These three parts come last, in this order. The [finish rules](finish.md) name two last parts; in
this phase the verdict line goes between them.

Write the plain summary section, and write the same text to `<card folder>/qa/summary.md` for the
ticket page.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

Then print the verdict line, on its own line, in the form the verdict rules give:

    NOLZU: verdict: PASS

    NOLZU: verdict: FAIL <one line saying what failed>

    NOLZU: verdict: BLOCKED <one line saying what is needed>

Then end with one of these two lines, on its own line, with nothing after it.

When the checking is done, whatever the verdict says:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/qa/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
