---
name: nolzu-wrapup
description: Turns what a finished card taught into the project's knowledge files, correcting what was wrong and adding only what was learned from the work itself. Use it for the wrap-up phase of a card after QA has passed, and of a question or an investigation once its answer or report was read.
---

# Wrap up a card

Read `<card folder>/discoveries.md` first: it is what every phase of this card met on the way, and
the main source of knowledge here. When the prompt names an epic's documents, read the epic's
`discoveries.md` among them too. Then read `<card folder>/refine/refined.md`,
`<card folder>/implement/deviations.md`, `<card folder>/plan/plan.md`,
`<card folder>/implement/pr.md`, `<card folder>/implement/progress.md` and
`<card folder>/qa/report.md`, whichever of them are there. A question or an investigation from the
Research board has no plan, diff or QA report: read `<card folder>/research/answer.md` or
`<card folder>/investigate/report.md` instead, because the answer is the whole work of that card.
What it found, and what it searched for and did not find, is the knowledge to keep. Those files are
the record of this card and they outlive its checkout, which goes once the card closes.

When the project folder, not a card's checkout, has `.nolzu/phases/wrapup.md`, follow it too. It wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its prompt and need not open it.

Then read the card's history, which the prompt gives when there is one. `## What the person said`
holds the questions earlier runs asked with the answers, and the reasons typed when the card moved
back or on anyway. `## What this card went through` says how often each phase ran, and gives each
QA that did not pass with its reason. A phase that ran again, a QA that failed and a question a
person had to answer show what cost time on this card, and that is where knowledge is earned.

Every file of this card is in the card folder, which is the folder the prompt names. It sits in
the project and not in the checkout you start in, so use the path the prompt gives. The knowledge
folder is named separately in the prompt, and it is the only folder outside the card folder you
may write to.

## What knowledge is

Knowledge is what somebody would have wanted to know before starting this card, and what is costly
to find again: learning it took reading more than one file or running something, or the obvious
reading of the code is wrong. A decision and its reason count too, because the code keeps only the
choice. The [knowledge file rules](knowledge.md) name the other kinds that qualify.

It is earned from the work, never generated from a scan. If this card taught nothing, write
nothing. A wrap-up that adds a file restating one function or one file makes the knowledge folder
worth less, not more.

Keep a learning only when losing it would cause rework and it will still hold in three months. A
fact about this card alone, such as which test was flaky that day, fails the bar.

"It is in the code" is no reason to drop a discovery. A test the test script never runs is in the
code too, and the next card loses a run to it. Drop one as visible only when a reader sees it by
opening one file.

Correcting is worth more than adding. When the card proved an existing knowledge file wrong, fix
that file first and say so. A folder of files that contradict each other cannot be trusted.

Each repository's `repository.md` describes it. When this card taught something about a
repository it changed, correct that file, and never remove one. A discovery that starts with `Run recipe:` goes into
`run-recipe.md`: correct or fill in that repository's command, or add its catch.

A rule the card had to follow is knowledge too when the whole repository keeps it, such as one module
that owns a job or one write path. Check that two or three files this card did not touch keep it,
then add it as one line under `## Rules the code keeps` in that repository's `repository.md`, with
those files as evidence. A rule only this card's files keep is a task fact, and stays out.

## How to write it

Every file follows the [knowledge file rules](knowledge.md), one subject per file, named after the
subject rather than after the card. A file you correct gets the same shape, and a new `source`.

Check each claim against the code before you write it: open the file, find the symbol, and confirm
each path in `paths` is a file of the repository and not of the card folder. A claim you cannot
confirm stays out.

Change one entry at a time, and change only the lines that are wrong. Rewriting a whole file wears
its detail away.

Do not commit, and do not run any git command. A person reads the diff and keeps or reverts it,
and the runner makes the commit.

## What to write

Write `<card folder>/wrapup/changes.md` for the person reading the card, with one line per
knowledge file you touched: whether you added, corrected or removed it, its path inside the
knowledge folder, and why in one line. When you touched none, say that in one line and say what
the card taught that was already written down.

Then say what became of each discovery, one line each: the knowledge file it went into, or that you
dropped it and why, such as it is already written down or it was true only while the card was open.
Before you drop one as already written down, open the file that says it and name that file. A
discovery the code later proved wrong is dropped with that reason.

Give `<card folder>/share/SUMMARY.md` and `<card folder>/share/TESTING.md` a last pass when they are there, so they match the final change as the record and QA show it. Keep them short.

This file is a record for a reader. The runner reads the knowledge folder itself to see what
changed, so a line here that does not match the folder helps nobody.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/wrapup/work/`.

Write each paragraph and each list item of every file in the card folder and the knowledge folder on one line, and never break a sentence in the middle. Add a discovery of your own to `<card folder>/discoveries.md` only when the wrap-up itself met something new, in the form the [finish rules](finish.md) give.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/wrapup/summary.md`, so
the ticket page can show it without reading the whole log.

Write that summary about the whole card, not only the wrap-up, because a closed card shows it as its
one summary. Say what the card changed for a person using the product and what QA checked, then in
one last sentence what Nolzu learned, or that the card taught nothing new.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the knowledge is written, or when there was nothing to write:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/wrapup/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
