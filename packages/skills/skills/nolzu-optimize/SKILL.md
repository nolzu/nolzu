---
name: nolzu-optimize
description: Rewrites one knowledge file so it stays short, true and easy to find, merging what repeats and cutting what the code now says itself. Use it when a person asks to optimize a knowledge file, never on its own.
---

# Optimize a knowledge file

Read the knowledge file the prompt names, and the other files in the knowledge folder the prompt
names. Rewrite that one file. Change no other knowledge file, and change no source file.

When the project folder, not a card's checkout, has `.nolzu/phases/optimize.md`, follow it too. It
wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its
prompt and need not open it.

The knowledge folder is the only folder outside the card folder you may write to. The card folder
is the folder the prompt names, and this run has no card of its own, so it holds only this run's
output.

## What to change

Cut what a reader now sees by opening one file of the code. A knowledge file that repeats a
function's name and what it does is a second copy that goes stale.

Merge what repeats inside the file, and keep the clearer wording of the two.

Keep every fact that is still true, including the ones that read as obvious. A trap that cost
somebody a day reads as obvious once it is written down, and cutting it is how it gets learned
again the hard way.

Keep the file to the [knowledge file rules](knowledge.md), and keep the `description` in its
frontmatter true to what the file now holds and to when a run should read it. Keep `source` as it
is, because this run has no card. When a path in `paths` is gone, find where the code moved and
correct the path, or say in the summary that you could not find it. A file from before these rules
gets the frontmatter they give, with what you can confirm from the code, and no `source`.

When another file in the folder contradicts this one, say so in the summary and leave both alone.
Deciding which is right is not this run's job, and a person has to see the contradiction.

## What not to change

Do not invent knowledge. This run has no card and no work behind it, so anything it adds comes
from a model and not from what happened. If the file is already short and true, change nothing and
say so.

Do not rename or move the file. The knowledge browser links to it by path, and a card's taught-by
link points at it.

Do not commit, and do not run any git command. The runner makes the commit, and a person keeps or
reverts it.

## What to write

Write `<card folder>/optimize/changes.md` with what you cut, what you merged and what you kept
against your own judgement, one line each. When you changed nothing, say why in one line.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/optimize/work/`.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/optimize/summary.md`, so
the knowledge page can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the file is rewritten, or when it needed nothing:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/optimize/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
