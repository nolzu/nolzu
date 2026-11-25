---
name: nolzu-feedback
description: Triages the review comments on a card's own pull request. Reads every open discussion, gives each one a verdict (fix, reject, clarify, defer or none), a one line summary and reason, and a drafted reply the person copies. Use it for the feedback phase, which Run triage starts from a card's PRs tab.
---

# Triage the comments on a pull request

The card is one a person built, and its pull request has comments from reviewers. This run reads
them and says what each one asks for and what to do about it. Change no code and run no command.
Commit nothing, push nothing and post nothing. A drafted reply is text the person reads, edits and
posts on GitHub themselves.

When the project folder, not a card's checkout, has `.nolzu/phases/feedback.md`, follow it too. It wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its prompt and need not open it.

This run has no command and no network. The comments are a file the runner wrote into the card
folder before this run started, at `<card folder>/feedback/discussions.md`. When that file is not
there, there is nothing to fetch and nothing to triage. End with the `needs_input` line and say the
comments file is missing.

Every file of this card is in the card folder, which is the folder the prompt names. It sits in the
project, next to the checkout and not inside it, so use the path the prompt gives. The code the
comments are about is the checkout you start in.

## What the comments file holds

The file starts with the card's plan or summary, so you know what the change was meant to do. Then
comes one section per open discussion, headed by its ref, such as `T3`. A discussion is a whole
review thread on a line, a review's own text, or one comment on the pull request. Each section says
its kind, the file and line when it has one, its status, and the earlier verdict, summary and fix
note when an earlier triage or fix left them. Then come its messages, oldest first, each with its
author, its time and whether it is the person's own. A long thread keeps its newest messages, and a
line at the top says how many older ones were cut.

## How to triage

Read the plan or summary first. Then, for each discussion, read every message, and read the code at
the file and line it names. A comment is only right or wrong against the code as it is now.

Give each discussion one verdict:

- `fix`: the reviewer is right and the code should change.
- `reject`: the reviewer is wrong, or the change would break something, and the reply says why.
- `clarify`: you cannot tell what the reviewer wants, or the answer changes the fix, so the reply asks.
- `defer`: right, but outside this card. The reply says it goes in a later change.
- `none`: nothing to act on, such as praise, a bot note with no finding, or a point the thread already settled.

Respect what happened before. An earlier verdict stands unless a newer message changes it. A
discussion with a fix note was fixed: when the reviewer has not answered since, it is `none`, and
when the reviewer answered again, judge the new message. A thread where the person's own last
message answered the point is `none` unless the reviewer came back. Never argue a point the person
already gave up.

A bot comment that holds many findings stays one discussion. Judge the findings together: `fix` when
any of them should change the code, and name the ones that should in the summary.

## What to write

Write `<card folder>/feedback/triage.md`. One block per discussion in the comments file, every one
of them and no other ref, in the file's order. One blank line separates two blocks, and a block
holds exactly these four lines, each starting at the left margin:

```
T3: fix
Summary: The search ignores case, so "bean" misses "Bean soup".
Reason: The reviewer is right, the match compares the raw strings.
Reply: Good catch, thanks. I will lower case both sides before the match and add a test for it.
```

The first line is the ref, a colon and the verdict, and nothing else. `Summary:` says in one line
what the discussion asks for. `Reason:` says in one line why you gave that verdict. `Reply:` is the
answer the person may post, one paragraph on one line, written the way a colleague writes on a pull
request: plain, short and specific, with no greeting and no sign off. For `none`, leave the reply
empty when there is nothing worth saying, as `Reply:` with nothing after it.

The page reads this file whole or not at all. A block with a fifth line, a missing field, an
indented line or a verdict outside the five makes the page refuse the whole file, and no row gets
its verdict. Write it over whole on a second triage.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/feedback/work/`.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/feedback/summary.md`, so
the ticket page can show it without reading the whole log. Count the verdicts in it, such as "3 to
fix, 1 to clarify, 2 need nothing", and say which point matters most, with no path and no function
name.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the triage file is written:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/feedback/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
