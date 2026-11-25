---
name: nolzu-pr-review
description: Reviews one pull request and writes a round of findings as conventional comments, one block per finding, each with its file and line or range above it, its label and subject, and the problem and the fix. Use it for the pr-review phase of a card on the PR reviews board.
---

# Review a pull request

The card names the pull request. Its ticket text carries the repository and the number as
`repo#number`, the title and the description, and the diff is a file the runner wrote into the card
folder before this run started, at `<card folder>/pr-review/diff.patch`. Each line of a hunk in it
starts with its line number in the file after the change, then the line as the diff writes it. A
removed line has a blank there. Read both, then read the code around the changed lines. Then write the round file. Change no code and run no command. Commit nothing and push
nothing. A review says what is wrong, and fixing it is the author's work.

When the project folder, not a card's checkout, has `.nolzu/phases/pr-review.md`, follow it too. It wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its prompt and need not open it.

This run has no command and no network. Everything it can read is already on disk, so when
`<card folder>/pr-review/diff.patch` is not there, there is no diff to fetch and nothing to review.
End with the `needs_input` line and say the diff file is missing.

Every file of this card is in the card folder, which is the folder the prompt names. It sits in the
project, next to the checkout and not inside it, so use the path the prompt gives.

## How to review

Start with the description, because it says what the change is meant to do. Then read the diff and
judge it against that, and against what the rest of the repository already does. A change that works
but contradicts the code next to it costs the next reader more than it saved.

Read enough of each file around a changed line to know whether the change is right there. A diff
hides the callers, and a good part of what is worth saying is about code the change did not touch.
Read those files in the project, at the path the prompt gives. When a file there does not match the
diff, the diff is the change under review and the project is the code around it.

Keep to two questions: is the change correct, and does it do what its description says. A note on
style or naming is a `nitpick` at most, and a round needs none. Say fewer and truer things. A round
of thirty findings reads as noise, and the two that mattered go down with it.

A change that breaks a rule the rest of the code keeps, or a rule in the project's knowledge, is an
`issue`, not a `suggestion`, even when it works on its own. Such a rule is no style note: the next
change trusts it, such as every other route building its errors in one module while this one builds
its own.

## A re-review

When the prompt's Read first block lists earlier rounds, or `<card folder>/pr-review/` already holds
a round file, this run is a re-review. Read every earlier round before the diff. Then check each
earlier `issue` against the code as it is now. One that is still wrong goes into this round again
as an `issue` on the same file, its line as it is now, with "Still open from round 1." (the round
that raised it) at the start of its discussion. One that is fixed stays out of this round: the page
matches findings by label and file, so it shows that one as fixed. The summary says how many of the
earlier issues are fixed.

## What to write

List `<card folder>/pr-review/` before you write. The first round of a card is
`<card folder>/pr-review/round.md`. Every later round is `round-<n>.md` beside it, where `<n>` is
one higher than the highest round already in the folder: the second round is `round-2.md`, the third
`round-3.md`. Write over no round that is there. The page shows what changed since the round before,
so a round written over is a round nobody can compare this one with.

One finding per block. Each block is a conventional comment, as conventionalcomments.org writes
one, with its place on the line above it. The page shows the place beside the comment, and its copy
button copies the comment alone, so a person can paste it on that line of the pull request.

The first line of a block is its place: the path written the way the diff writes it, a colon and the
line, or the first and last line of a range when the finding spans lines (`path:12` or
`path:12-18`). The line is the number in front of that line in `diff.patch`, which is the line
GitHub shows on the pull request. It is not the line of `diff.patch` itself, which your file reader
may print beside it, and never a count from a `@@` header. A finding about a removed line takes the
number of the next line that has one. A line outside the diff has no number there, and the project
holds the code from before the change, so its line numbers can be off: put such a finding on the
numbered line of the diff it turns on. The second line is the label line: the label, any decorations in brackets, a colon
and the subject, one short sentence that says the finding. Then one blank line and the discussion:
the problem and the fix, in as many lines as it needs. A finding that names no fix is a complaint. A
`question` asks instead of naming a fix, and `praise` needs neither. One blank line separates two
blocks.

The labels:

- `praise`: something done well and worth keeping.
- `nitpick`: small and optional, such as a name, a wording or an order.
- `suggestion`: worth changing, and the author may say no.
- `issue`: something is wrong. It should not merge in this shape.
- `todo`: a small change the merge needs, such as a missing test case.
- `question`: you cannot tell yet, and the answer changes the finding.
- `thought`: an idea the change brought up, which asks for nothing now.
- `chore`: a step the project asks for before a merge, such as a changelog line.
- `note`: something the reader should know, which asks for nothing.

The decorations: `(blocking)` on a comment that must be settled before the merge, `(non-blocking)`
on one that need not be, and `(if-minor)` on one to act on only when the fix is small. An `issue` and
a `todo` block the merge unless marked `(non-blocking)`. Leave a decoration out when the label says
it already.

A block starts at the left margin with its place. A comment with no place above it reads as part of
the finding before it, so the page refuses the whole round.

```
src/recipes/import.ts:88-92
issue: An empty recipe file stops the whole import

A recipe file with no ingredients throws, so one bad file stops every other one. Return an
empty list here and let the caller name the file it came from.
```

Put the blocks in the order a reader walks the diff, by file and then by line.

A pull request with nothing wrong in it is a finished review, not a failed one. Write one `praise`
block for what the change does well, on the file and line it turns on, and say in it that the round
found nothing to change. Never invent a nitpick to fill the file.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/pr-review/work/`.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/pr-review/summary.md`, so
the ticket page can show it without reading the whole log. A round file allows no heading, so this
file is the round's review block. It holds these lines, in plain words, with no path and no function
name:

    Verdict: changes needed. <why, in one plain sentence>
    Findings: 1 issue, 1 suggestion, 1 praise.
    Earlier issues: 2 from round 1, 1 fixed and 1 still open.
    Not reviewed: <what the round did not read and why, or "nothing">.

The verdict is `changes needed` when a comment blocks the merge (an `issue` or a `todo` not marked
`(non-blocking)`, or any comment marked `(blocking)`), `questions first` when nothing blocks and the
round has a `question`, and `ready to merge` otherwise. Count every block of the round by its label. Write the Earlier issues line on a re-review only.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the round is written, including a round whose one block is praise:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/pr-review/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
