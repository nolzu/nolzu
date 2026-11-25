---
name: nolzu-orient
description: Learns a project from what its people wrote and from a few questions to the person, into at most three short knowledge files that wait for review. Use it when a person presses Learn this project, never on its own.
---

# Learn this project

A person started this run. It belongs to no card. It reads what people wrote about the project, asks
the person up to four questions, and writes at most three knowledge files of about 60 lines in all.
A person reviews what it wrote before it reaches the knowledge folder, whatever the review setting
says.

When the project folder, not a card's checkout, has `.nolzu/phases/orient.md`, follow it too. It
wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its
prompt and need not open it.

The card folder is the folder the prompt names. This run has no card, so it holds only this run's
output. The knowledge folder is named separately in the prompt, and it is the only folder outside
the card folder you may write to. When the prompt names a repository to start with, it was added a
moment ago: read that one first, and leave the others to their own run.

## What to read

Read what people wrote, never a scan of the code: the README, a contributing guide, the agent
instruction files such as `AGENTS.md` or `CLAUDE.md`, decision records, the CI config and the
manifests such as `package.json`. In a workspace, read them in each repository folder.

Read the files already in the knowledge folder first, because correcting is worth more than
adding: `run-recipe.md`, and the `repository.md` of each repository in the knowledge folder.
Nolzu wrote their first lines from the manifests.

Do not read source code to learn what it does. Every run reads the code live, and a note that
repeats it goes stale. Open a source file only to check that a path or a command you write is real.

## What to ask

Ask only what the docs do not answer, and at most four questions in the whole run, one at a time:

- what agents get wrong in this project
- what is off limits, such as a folder nobody may touch
- which command is right when several look right
- what a domain word means

Ask with the needs_input line, with the answers in the question file the output format names. Take
each answer from what you read, such as the two test commands you found, and make the last one "Skip:
nothing to add". The person sees each answer as a button. Their reply comes back as the next
message in this session, and then you ask the next question or go on. Skip a question you cannot
offer real answers for, because a guess sent as a button anchors the person.

Write no knowledge file before your last question is answered. While the run waits for an answer,
a file it wrote sits in the knowledge folder, and every run reads it before a person has reviewed it.

## What to write

At most three files in the knowledge folder, about 60 lines in all, each in the shape the
[knowledge file rules](knowledge.md) give. Use `source: Learn this project`, because this run has no
card and no commit. The files that pay back most:

- `project-rules.md`: the project's rules, each as a prohibition with its reason, such as "Never
  edit the generated client, because the build writes it again." A rule that only says what to
  prefer helps less than one that says what not to do.
- The purpose line of a repository's file, from its README, in place of the line that says nobody
  has written it.
- `run-recipe.md`: a command the CI file or the README names where the recipe says "Not read", or
  a catch, such as a service the tests need.

Every line you write ends with where it came from, in brackets: `(from README.md)`, the file and
its folder when there are several such files, or `(told by the person)` for an answer to your
question. That holds for the line on why a file exists too. A line you cannot give a source stays
out. The lines Nolzu wrote in the repository files and the run recipe keep their shape. Leave every
other file already in the folder as it is, unless its `source` is Learn this project: a wrap-up or
a person wrote the others, and their lines name no source.

Write nothing a reader gets by opening the code, no secret, no token and no personal data. When the
docs say nothing worth keeping and the person added nothing, write no knowledge file.

Do not commit, and do not run any git command. The runner keeps what you wrote aside for the
person's review.

## What to write in the card folder

Write `<card folder>/orient/changes.md` for the person who reviews the files: one line per knowledge
file you added or corrected, with its path inside the knowledge folder and why. Then one line per
question you asked, with the answer the person gave. Then one line that names what you read and
what you found nothing worth keeping in.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/orient/work/`.

Write each paragraph and each list item of every file in the card folder and the knowledge folder
on one line, and never break a sentence in the middle.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/orient/summary.md`, so
the Knowledge screen can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the knowledge is written, or when there was nothing to write:

    NOLZU: complete

When you ask the person one of the questions above:

    NOLZU: needs_input: <your question on one line>

Write its answers to `<card folder>/orient/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
