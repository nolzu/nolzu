---
name: nolzu-learn-repo
description: Learns one repository from its README, CI files and stack files, and writes what it is for, how to install, run, test, lint and build it, and the rules its code keeps, for a person to review. Use it when a person starts Learn your repositories, never on its own.
---

# Learn a repository

A person started this run from Learn your repositories. It belongs to no card. It reads one
repository, the one the prompt names, and writes two things: that repository's file in the
knowledge folder, and its section of the run recipe. A person reviews what it wrote before it
reaches the knowledge folder, whatever the review setting says.

When the project folder, not a card's checkout, has `.nolzu/phases/learn-repo.md`, follow it too.
It wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its
prompt and need not open it.

The card folder is the folder the prompt names. This run has no card, so it holds only this run's
output. The knowledge folder is named separately in the prompt, and it is the only folder outside
the card folder you may write to. The prompt names the repository, where to read it, and the two
files to write. Read no other repository: each one gets its own run.

## What to read

Read the files people keep to say how the repository works, in this order:

- the README, and a contributing guide when there is one
- the CI files, such as the workflows folder under .github, .gitlab-ci.yml or a Jenkinsfile, because
  they hold the commands that really run
- the stack files at the top: package.json and its lockfile, composer.json, pyproject.toml,
  go.mod, Cargo.toml, build.gradle, pom.xml, Gemfile, a Makefile, a Dockerfile or a compose file

Read the two knowledge files first: the repository's file and its section of the run recipe.
Nolzu wrote their first lines from the folder and the stack files. Correct what is wrong and fill
what says "Not read", and keep what is right.

Do not read source code to learn what the repository does. Open a source file only to check that
a path or a command you write is real, such as the test folder a command names, or to find the
rules below.

When the CI file and the README name different commands for the same step, write the CI one,
because it is the one that runs, and name the other in the catch line.

## Rules the code keeps

Some rules hold in every file and are written nowhere: one module owns a job and every other file
calls it, every write goes through one function, or a naming rule that tests or pages rely on. A
change that breaks one passes its own tests and fails review, so a later run needs them written.

Look in a small sample: the entry point, two or three files in different source folders, a page or
a route when there are any, and two tests. When each file you opened does the same job the same
way, search the code for another way of doing it. Keep a rule only when the search finds no other
way. One file that does it its own way means it is no rule.

## What to write

Write the repository's file in the shape the [knowledge file rules](knowledge.md) give, with
`source: Learn your repositories`, because this run has no card and no commit. Keep the lines Nolzu
wrote at the top (the description, the heading, the folder and the base branch), and put these in
place of the line that says nobody has written what the repository is for:

- What it is for, in one or two sentences.
- How to install, run, test, lint and build it, one line each, with the command in backticks.
- What it needs to run, such as a database, a service or a file of settings, when the files say so.
- The rules the code keeps, under a `## Rules the code keeps` heading at the end, at most five, one
  line each: the rule, then two or three places that keep it, such as "Every error a route sends
  back is built by `httpError` in src/http/errors.ts. (seen in src/routes/recipes.ts,
  src/routes/menus.ts and test/routes.test.ts)". Add the file that owns the job to `paths`. Leave
  the heading out when you found none.

Write the repository's section of the run recipe under its own heading, which is already there or
the prompt names. Keep the shape the other sections have: the line that says where to run the
commands, then one list item each for Install, Test, Lint, Type-check, Build and Start, then Catches.
Change no other section and no other knowledge file.

Every line you write ends with where it came from, in brackets: `(from README.md)`, `(from
composer.json)` or the CI file by its name, such as `(from the ci.yml workflow)`. A step no file
names stays "Not read" with what you looked in, because a guessed command runs the wrong thing.

Write nothing a reader gets by opening one file, no secret, no token and no personal data. When the
files say nothing new, change nothing.

Do not commit, and do not run any git command. The runner keeps what you wrote aside for the
person's review.

## What to write in the card folder

Write `<card folder>/learn-repo/changes.md` for the person who reviews the files: one line per
knowledge file you changed, with what changed and which files it came from. Then one line that
names what you read and found nothing in.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/learn-repo/work/`.

Write each paragraph and each list item of every file in the card folder and the knowledge folder
on one line, and never break a sentence in the middle.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/learn-repo/summary.md`,
so the Knowledge screen can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with this line, on its own line, with nothing after it, when the files are written or when
there was nothing to change:

    NOLZU: complete

This run never asks. It belongs to no card, so a question has no place where a person would see
it, and the run would end with nothing written. What the files do not say stays "Not read", and a
repository that is not where the prompt says gets one line in the summary and no file.
