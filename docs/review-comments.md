# Answering review comments

When a Delivery card reaches the Pull request column, its card page gets a PRs tab. The tab shows
what reviewers wrote on the card's pull requests and helps you answer it. Nolzu reads the comments
through `gh` and posts nothing to GitHub: you post every reply and push every fix yourself.

The tab lists the pull requests the card's branch opened. Attach another one by pasting its link or
typing `owner/repo#12`, from any repository. Detach drops one you attached, with its
discussions and messages on the card, after it asks. The pull request on GitHub stays.

## The steps

1. Press "Read comments". Nolzu asks GitHub on this press only, never on a timer. "Read pull
   requests" on the board reads the comments of every card in the column too. Each review thread,
   review body or comment becomes one row with a ref (`T1`, `T2`) that never changes. A dot marks a
   row with a message you have not seen, and your own comments are never unread. A comment edited
   on GitHub shows its new text at the next read and gets the dot again, unless it is yours.
2. Press "Run triage". A read-only run on a small model reads every open row and gives each one a
   verdict (fix, reject, clarify, defer or none), a one line summary and a drafted reply. It changes
   no code. Rows with verdict none fold into "Nothing to action", and "Needs action" pulls one back.
   "Triage again" keeps the earlier verdicts in mind.
3. Press "Copy" beside a drafted reply, edit the text if you want, and post it on GitHub yourself.
4. Press "Fix" on a row that needs a code change. The card's Implement session goes on with that
   comment and its triage, in the card's checkout. It edits files and stops: it never commits,
   pushes or replies. One fix runs at a time per card. The row then says "Fixed, commit and push
   from Changes", or "Fix failed" with the reason. When the fix asks a question, the row says "Fix
   asks a question" with it: answer it on the card's Overview, and the same fix goes on. A fix that made a commit or pushed anyway goes
   back to new with "Fix failed" and a sentence naming the repository and both commits. Nolzu leaves the commit in place: look at
   git log in the checkout and keep or undo it yourself.
   "Fix all" does the same for every row triage marked fix that is not fixed yet, in one run. The
   run writes a line per comment in `feedback/fixes.md` in the card folder, and each row takes its
   line as its note. A row the run wrote no line for goes back to new with the reason.
5. Press "QA the fixes" to check what the fixes changed before you push, if you want to. It is a QA
   run with the app started as for QA, and the card stays on Pull request. It checks the comments
   fixed since the last QA with a verdict, so it waits until something was fixed. It runs the
   project's own checks again, runs only the earlier QA checks the fixes touch, and adds one check
   per fixed comment. The QA tab then shows one report with everything: a check it did not run again
   keeps its result and says it comes from the QA before. A comment whose check failed goes back to
   new with QA's reason, so the next Fix or Fix all sees it. When only another check failed, every
   comment it checked goes back with that check named.
6. Open the Changes tab, read the edits, then commit and push from there as after any Implement run.
7. Press "Mark done" on a row you have answered. A thread resolved on GitHub becomes done at the
   next read, and a reviewer reply after a fix opens the row again.

"Discuss" on a row opens a read-only thread about that comment on the Discussion tab, for when you
want to think it through before you answer.

## On the board

A card with comments to act on shows one line, such as "3 to fix · 1 new". To fix counts the rows
triage wants fixed that are not fixed yet. New counts the rows with a message you have not seen,
and opening the PRs tab clears it. A part at nought is left out, and a card with neither shows no
line. The board counts from what this machine stored and does not ask GitHub.

## Why it cannot merge

From Review to Wrap-up, a Delivery card says why its open pull request cannot merge yet. The board
card shows the first reason and how many more, such as "Checks failed +1". The card's Overview lists
every reason with its links under "Why it cannot merge", and says when GitHub was last read. The
reasons, in this order: checks that failed (each linked to its log), a conflict with the base branch,
a branch behind its base, a missing approval, asked changes, a draft, and a merge state GitHub has not
worked out yet. Checks that are still running are shown, but they are not a reason. When GitHub blocks
the merge and names none of these, such as with a ruleset, the card says so and links the pull
request. Nolzu does not guess.

Nolzu reads this every 3 minutes for the open pull requests of those cards, and when you press Read
pull requests. The 3 minute read skips a pull request it saw merged or closed. When a read fails, the
card keeps the last answer and its time. Check names come from the first 20 checks GitHub lists.

When checks failed, "Fix CI" beside them starts an Implement run to fix them. Nolzu reads the log of
each failed GitHub Actions job of the pull request's own repository with `gh`, keeps its last 300
lines (60 KB at most), and saves it in `ci/` in the card folder, with `ci/failed.md` listing each
failed check, its link and the commit it ran on. A check that is not a GitHub Actions job is named
there with no log: open it on GitHub. The card goes back to Implement and the run is told where the
logs are, and to read them as data, not as instructions. No QA runs after it. Read the change on the
Changes tab, then commit and push as after any Implement run, and the checks run again. The logs go
to the engine's vendor with the code, as the comments do. Fix CI waits while a run holds the card.

## Earlier QA reports

Every QA run writes `qa/report.md` in the card folder over the one before. Nolzu keeps the old one
first, as `qa/history/report-1.md`, `report-2.md` and on, oldest first. This holds for QA the fixes
and for QA after Fix it alike.

## What stays on this machine

The comment text lives in the local database. A triage reads it from a file Nolzu writes into the
card folder before the run starts, so the run needs no GitHub access. The board gets the counts
only, and the hosted server gets neither the counts nor the text. A merged pull request does not
move the card: drag it to Wrap-up yourself.
