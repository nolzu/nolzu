---
name: nolzu-research
description: Answers a question about the project from the repository and its own documents, with the answer first, then why, then the source a reader can check. Use it for the research phase of a question card, when someone asked something instead of asking for a change.
---

# Research a question

Read the question and the extra context the person added, then answer it from the repository and
from the project's own documents. Change no code and run no command.

When the project folder, not a card's checkout, has `.nolzu/phases/research.md`, follow it too. It
wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its
prompt and need not open it.

Every file of this card goes in the card folder, which is the folder the prompt names. It sits in
the project, next to the checkout and not inside it, so use the path the prompt gives.

## How to answer

Search before you write. The answer lives in the code, in a test or in one of the project's own
documents, and the run's job is to find it rather than to recall it. Read the file itself, not the
name of the file.

This phase reads files and nothing else. It runs no command, so git history, a commit message and
a pull request are all out of its reach, and a question that only they answer is an unanswerable
one. Anything from outside the project reaches this phase in one of two ways, and both come from the
person: the extra context they typed on the card, which the prompt carries, and any file they copied
into the card folder themselves. Look in the card folder for such a file, and treat its absence as
normal, because no step before this one writes one. The question itself is the card, in the prompt:
its title, its ticket text and the extra context. Most cards are a title and nothing more, and a
title that asks something is the question. Ask with `needs_input` only when the title, the ticket
text and the extra context together say nothing to answer.

Stop searching when the answer stops changing. A second source that says the same thing is worth
one line, and a third is worth none.

Give the source for every claim, so the reader can go and look: a file path with the line, or a
document with its section. A claim with no source is a guess wearing an answer's clothes.

Before you write that a test, a check or a value would pass or fail, read the line that decides it
and work the case through. A claim you did not trace gets `(not checked)` after it.

When the reading turns up options, such as where a fix could go or which values count as bad, take a
side: say which one the code points to, and why. A choice only a person can make goes under
`## If this becomes a card` as a question with the default you would pick.

When the repository cannot answer the question, that is the answer, and the run writes the same
file. The first sentence says the repository does not answer the question. `## Why` says how far the
reading got. `## What this does not answer` says what would answer it: a file that does not exist, a
decision nobody wrote down, a person to ask. `## Searched and not found` names each place searched,
the same paths a real answer would cite, and `## Sources` holds what you read. That is a finished
answer, not a failed run. Guessing here is worse than silence, because the reader cannot tell the
two apart.

## What to write

Write `<card folder>/research/answer.md` in this shape, with these headings in this order. The first
two lines are this phase's review block, so a person reads the answer before any reasoning.

    <The answer, in one sentence.>

    Confidence: high, because <the reason, in a few words>.

    ## Why
    <What the code or the document does, and why that settles the question.>

    ## What this does not answer
    <What is left open, and what would settle it.>

    ## Searched and not found
    - <what you looked for>, in <the path you searched>

    ## If this becomes a card
    Problem: <what is wrong or missing, in one or two sentences>.

    - AC1 (must): <what a person sees when it is done>.
      Check: <a test, a command, a request, or steps in a browser>.
    - Q1: <a choice the answer leaves open>? Default: <the answer you would pick>. blocks: no

    Change: <each place to change, by path and symbol>.

    ## Sources
    - api/src/validate.ts:14 <what this line shows>

Confidence is `high` when you read the code or the document that decides the answer, `medium` when
it rests on reading you could not finish or on one step of inference, and `low` when it is mostly
inference. A claim under `## Why` that is less certain than the answer says so in brackets, such as
`(confidence: low)`.

Leave out `## What this does not answer` when nothing is left open. Under `## Searched and not
found`, put each search that came up empty, so the next reader does not search there again, or
write "Nothing." when every search found what it looked for.

Add `## If this becomes a card` when the answer shows something to change. "Make a Delivery card"
hands this answer to Refine, so write it in the brief's own lines: criteria with a level, each with
its `Check:` line under it, indented two spaces as the skeleton shows, at most three questions with
a default and `blocks: yes` or `blocks: no` (`yes` when the answer changes what a person using the
product sees or gets, such as an error or a fallback), and the places to change.
Leave it out when nothing needs to change.

`## Sources` comes last. One item each, and each item starts with the path and line as `path:line`,
such as api/src/validate.ts:14. A few words may follow it. For a document, give its path and the line
where the section starts. The page shows each item as a chip, so nothing else goes under this
heading.

This file is the answer and not a log of the search. The ticket page renders it for a person who
asked a question and wants it answered, so a list of what you opened and in which order belongs
nowhere in it.

Keep it short enough to read in one go. A long answer hides the one sentence that matters.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/research/work/`.

Write each paragraph and each list item of every file in the card folder on one line, and never break a sentence in the middle. A `Check:` line is the one exception: it goes on its own line under its acceptance check. Add each surprise you met on the way to `<card folder>/discoveries.md` as one line, in the form the [finish rules](finish.md) give. Write nothing there when nothing surprised you.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/research/summary.md`,
so the ticket page can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the question is answered, including when the answer is that the repository cannot answer it:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/research/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
