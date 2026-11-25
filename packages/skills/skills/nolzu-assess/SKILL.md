---
name: nolzu-assess
description: Reads one finding Scout collected, checks it against the code, and writes an assessment with the evidence, the likely cause, a proposal, the effort and the risks. Use it for the assess phase, which runs on a finding before a person decides what to do with it.
---

# Assess a finding

Scout met an event in a source a person added, and this run says what is behind it. The prompt
carries the event itself: the line as it was collected, how often it was seen and where it happens.
Read the project at the path the prompt gives, because the folder a run starts in is not always the
project.

When the project folder, not a card's checkout, has `.nolzu/phases/assess.md`, follow it too. It
wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its
prompt and need not open it.

This run reads and searches, and it changes nothing. No file of the project, no command, no commit,
and nothing outside the card folder. The run guard refuses each of those, so a call that tries one
is turned down and the run has spent a turn on nothing.

Every file of this run goes in the card folder, which is the folder the prompt names. It sits in the
project, next to the checkout and not inside it, so use the path the prompt gives.

## How to look

Start from the line the prompt carries and find the code that could produce it. Read outwards from
there, rather than from a guess about which part is at fault. Follow one thread to its end before
you open the next one, so a half-read thread does not end up in the assessment as a finding.

Keep the evidence while you read, because you will not find it twice. For code that is the path and
the line number. For the collected line that is the line itself, with its time. A sentence with
neither of those behind it is an opinion, and the person reading it has no way to check it.

Stop when you can name the likely cause and point at the evidence for it. When the evidence runs out
first, stop there as well and write down where it ran out. A cause nobody can check costs more than
an open question.

The person reading this has not decided anything yet. They decide from what you write, so a proposal
with no effort and no risk beside it leaves them where they started.

## What to write

Write `<card folder>/assess/assessment.md` with these five sections, in this order and under these
exact headings, because the product reads them back by heading.

1. `## The evidence`. One line each: the path with the line number, or the collected line with its
   time. No prose around them.
2. `## The likely cause`. One short paragraph. When the cause is not proven, say so in the sentence
   that names it, and add what would settle it. Under it come two lines of their own, in this
   shape. Confidence is high, medium or low.

       Confidence: medium, because <the reason, in a few words>.
       What would change it: <the fact that would change this call>.

3. `## The proposal`. One change a person can decide on, and the files it touches. When the right
   next step is reading rather than building, say that instead.
4. `## The effort`. Hours, a day, or more than a day, and what would make it larger.
5. `## The risks`. What the proposal touches that works today, and what could go wrong if it is
   built. Write that you found none when you found none.

The file holds these five sections and nothing else. Put no heading inside a section, at any level,
because the screen starts a new section at every heading and a sub-heading cuts one in two. The file
is the answer and not a log of the reading, so what you opened and in which order belongs nowhere in
it.

Every section carries at least one sentence. The product refuses an assessment with a section
missing or empty, and the run is then wasted, so write the section that has the least in it as well.

Write the assessment even when the finding turns out to be nothing. The cause section then says the
code does what it should, the evidence section holds what you read, and the proposal section says
so. A run that ends with no file leaves the next reader with less than an empty answer does.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/assess/work/`.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/assess/summary.md`, so
the screen can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the assessment is written, whether or not the cause is proven:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/assess/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
