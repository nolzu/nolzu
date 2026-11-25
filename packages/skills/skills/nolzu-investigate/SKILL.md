---
name: nolzu-investigate
description: Looks into a reported problem by reading the code, the logs and whatever the card carries, and writes a report with the evidence, the cause, and the fix or the next step. Use it for the investigate phase of a card on the Investigations board.
---

# Investigate a card

Read the card's ticket text, the extra context the person added and the files the card carries, then
find out what is going on. This run reads and searches and runs nothing. Read the project at the
path the prompt gives, because the folder a run starts in is not always the project. A log, or
anything else from outside the project, is there because a person copied it into the card folder, so
look there for it and go on without it when the folder holds none. This phase answers a question, it
changes nothing.

When the project folder, not a card's checkout, has `.nolzu/phases/investigate.md`, follow it too.
It wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its
prompt and need not open it.

Nothing else is handed to this run. The card title, the ticket text and the extra context all come
from the person, in the prompt, and no step before this one writes a file for you to read. Most cards
are a title and nothing more, and a title that names the problem is enough to start from. Ask with
`needs_input` only when the title, the ticket text and the extra context together say nothing to
investigate.

Every file of this card goes in the card folder, which is the folder the prompt names. It sits in the
project, next to the checkout and not inside it, so use the path the prompt gives.

## How to look

Start from what was reported and find the first point where the product does something other than
what the report expected. Work outwards from there, rather than from a guess about which part is at
fault. Follow one thread to its end before you open the next one, so a half-read thread does not end
up in the report as a finding.

Keep the evidence while you read, because you will not find it twice. For code that is the path and
the line number. For a log that is the line itself, with its timestamp. A sentence in the report with
neither of those behind it is an opinion, and the person reading it has no way to check it.

Stop when you can name what causes the reported behaviour and point at the evidence for it. When the
evidence runs out first, stop there as well and write down where it ran out. A cause nobody can
check costs more than an open question.

Each possible cause you look into is a hypothesis, and what the reading showed about it goes in the
report, the ones ruled out too, so the next reader does not check them again. Before you write that a
test, a check or a value would pass or fail, read the line that decides it and work the case through.
A claim you did not trace gets `(not checked)` after it.

## What to write

Write `<card folder>/investigate/report.md` in this shape, with these headings in this order. The
first two lines are this phase's review block, so a person reads the cause before any reasoning.

    <The cause, or what was found, in one sentence.>

    Confidence: medium, because <the reason, in a few words>.

    ## What was reported
    <Two or three sentences, close to the words of the person who reported it.>

    ## What was found
    <What the product does instead, as behaviour a reader can picture.>

    ## Hypotheses tried
    - <a possible cause>. Result: ruled out. <what showed it, with the path and line>.
    - <a possible cause>. Result: held. <what showed it, with the path and line>.

    ## The fix or next step
    <What to change, or what to look at next, and who decides it.>

    ## Searched and not found
    - <what you looked for>, in <the path you searched>

    ## If this becomes a card
    Problem: <what is wrong, in one or two sentences>.

    - AC1 (must): <what a person sees when it is fixed>.
      Check: <a test, a command, a request, or steps in a browser>.
    - Q1: <a choice the report leaves open>? Default: <the answer you would pick>. blocks: no

    Change: <each place to change, by path and symbol>.

    ## Sources
    - api/src/upload.ts:88 <what this line shows>

Confidence is `high` when the evidence shows the cause, `medium` when it rests on reading you could
not finish or on one step of inference, and `low` when it is mostly inference. When the cause is not
proven, the first sentence says so, and `## The fix or next step` says what would settle it. A claim
that is less certain than the answer says so in brackets, such as `(confidence: low)`.

Each hypothesis ends in one result: `held`, `ruled out` or `not settled`. Under `## Searched and not
found`, put each search that came up empty, or write "Nothing." when every search found what it
looked for.

Add `## If this becomes a card` when the report shows something to change. "Make a Delivery card"
hands this report to Refine, so write it in the brief's own lines: criteria with a level, each with
its `Check:` line under it, indented two spaces as the skeleton shows, at most three questions with
a default and `blocks: yes` or `blocks: no` (`yes` when the answer changes what a person using the
product sees or gets, such as an error or a fallback), and the places to change.

`## Sources` comes last. One item each, and each item starts with the path and line as `path:line`,
such as api/src/upload.ts:88. For a log line, give the log file's path and line, then the line
itself. The page shows each item as a chip, so nothing else goes under this heading.

The report is the answer and not a log of the reading, so what you opened and in which order belongs
nowhere in it.

Write the report even when you found nothing. The first sentence then says the product did what the
report expected, `## The fix or next step` names what would settle it, and `## Sources` holds what
you read. A run that ends with no file leaves the next reader with less than an empty answer does.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/investigate/work/`.

Write each paragraph and each list item of every file in the card folder on one line, and never break a sentence in the middle. A `Check:` line is the one exception: it goes on its own line under its acceptance check. Add each surprise you met on the way to `<card folder>/discoveries.md` as one line, in the form the [finish rules](finish.md) give. Write nothing there when nothing surprised you.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/investigate/summary.md`,
so the ticket page can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the report is written, whether or not the cause is proven:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/investigate/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
