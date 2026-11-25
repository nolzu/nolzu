# What a knowledge file looks like

The knowledge folder is read by people on the Knowledge screen and by every later run through the
knowledge index in its prompt, so every file in it has the same shape. Each skill that writes
knowledge carries these rules.

## The shape

    ---
    description: Read before changing the importer. Why it refuses a row with no id.
    source: APP-12 at 1a2b3c4 (2026-10-25)
    paths: src/importer/rows.ts, src/importer/rows.test.ts
    ---

    # Rows with no id

    The importer refuses a row with no id, because the sync matches rows by id and would write a second copy of the row.

    Why: APP-12 lost a QA round to it.

The `description` is one sentence that says when to read the file and what it holds, the way a
skill's description does. Every run gets it in the knowledge index as the line it picks files by,
so start it with the work it is for, such as "Read before changing the importer".

`source` is the card key and the commit the prompt names, with its date, so a reader can tell how
old the file is and find the work it came from. A prompt with no commit line gets the card key
alone.

`paths` lists the files and folders the file depends on, from the project folder, the way a plan
names them, without line numbers. Name only paths git tracks on the base branch: never the card
folder, `.tasks/` or a file git ignores, because those are gone once the card closes. The
Knowledge screen marks a file whose paths the base branch no longer has, so a reader checks it
before trusting it. Leave `paths` out only when the file depends on no file.

Under the frontmatter, the rule or the fact comes first, then one line on why it exists: what not
knowing it cost or would cost. A few lines, not a page.

One subject per file. Name the file after the subject, in lower case with hyphens, never after a
card. A card key in a file name ages badly, because the next person searches for the subject.

Put the file in the folder named after the repository its `paths` belong to: the top of the
knowledge folder for a repository at the project folder itself, `shared/` for paths in several
repositories. Make no other folder.

Write what is true now, not a history. "The importer refuses a row with no id" is knowledge. "We
changed the importer" is a commit message.

## What earns a file

Keep a fact when it is costly to find again: learning it took reading more than one file or
running something, or the obvious reading of the code is wrong. These kinds qualify:

- a silent trap, such as a test that never runs, a mock that hides a failure, or an error
  swallowed into a default
- a contract between files, such as two places kept in step by hand, or a read path and a write
  path that differ
- a precedent to copy, or one not to copy
- a dead end: where not to look
- which file holds the truth

## What does not belong in it

A restatement of one function or one file, a list of the stack, a folder tree, or anything true
only while the card was open. Such a file is a second copy that goes stale the first time somebody
edits the code. The one exception is `run-recipe.md`: how to install, test, lint, type-check,
build and start each repository, each command with where it comes from and its catch, because
every card needs it and finding the right command has cost real runs.

Never write client, tenant or production data, a secret or a token into a knowledge file or a card
file, and no personal data. This folder is committed, and on a paid plan it is synced.

No file that exists to prove the phase ran. When there is nothing to write, write nothing.
