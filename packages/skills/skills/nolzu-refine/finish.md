# How every phase ends

The two parts at the end, the summary and the last line, come last, in that order, and they belong
to your output format.

## Who reads your files

Write for a reader who has only the card folder, the repository and the knowledge folder: a fresh
agent with nothing else must be able to do the next phase from your files. Copy what the code
cannot tell: the intent, each decision with the option turned down, the rules. Point at what the
code can tell by path and symbol. A line number is a hint, never the anchor.

Refine, Architecture, Design, Plan and Implement open their main file with a review block under
`## Before you approve`, right after the lines code reads at the top (Implement: in `progress.md`,
written when the run ends). At most 15 lines, all bullets, none starting with a digit, because
Nolzu reads a leading number as a step. In this order: what the phase concluded in one or two
sentences, the decisions for the person ranked with the default the next phase will use, the calls
you made alone, the top risks, what was not checked or could not be read, and what the next phase
will do. Name each item by its id. QA's `## 1. Verdict`, the first sentence of a Research or
Investigate answer, and a review round's `summary.md` do this job.

Every claim about the code names its path. Every claim that something works names the command and
quotes its real output line. "Not checked" and "could not read" are results: write them where the
reader looks. What you cannot see, such as the order the work was done in, is not checked, never a
pass or a fail. An acceptance check is about what the product does, never the process or history
of the work.

Write only the files your skill names, each where it says. In `<card folder>/<phase>/` they sit at
the top, and anything else you store there goes in `work/` under it, or in the subfolder your skill
names. Make no other folder there. Record a disagreement with an earlier file as a deviation or a
discovery. A re-run reads its own earlier file first, keeps what the person approved and what it
proved, and says in the review block what changed.

Scale to the card: a one-step fix gets a one-step plan and a three-line review block. A plan holds
decisions, signatures, shapes, values and test assertions, not code bodies. Keep a main file under
about 300 lines.

Refine, Architecture, Design and Plan ask: they raise an open question with a default, and use
`needs_input` only when the default would waste the run. Implement and QA decide: they write the
ruling down, and stop only for a destructive step, a real change of scope, or input only a person
can give.

With a shell, run one plain command per call from the folder you start in: no `cd`, no variables,
loops or chained commands, and no `git -C` on that folder. Reach another repository with the
folder option the prompt names. Create and change files with your file tools, never
a shell redirect or heredoc. Put scratch files in `<card folder>/<phase>/work/`, never in `/tmp`.

## Files for other people

`<card folder>/share/` and `<card folder>/implement/pr.md` leave the card for colleagues and reviewers.
They never mention AI, agents, models, Nolzu, Claude, Codex, Cursor or any other tool or harness,
and they carry no generated-by line, no robot emoji line and no co-author trailer. Write them as the
person who owns the change would.

## One line per paragraph

In every file you write in the card folder or the knowledge folder, put each paragraph and each
list item on one line. Never break a sentence over two lines: the ticket page wraps the text and
shows a break as a broken line. Code and the project's own docs keep the project's style.

## Discoveries

A discovery is something you met on the way that the next person would want to know before they
start: a rule the code follows that is written nowhere, a trap that cost time, a file that does
not do what its name says. Add each one to `<card folder>/discoveries.md` as one list item on one
line, at most about four sentences: the fact, its paths and lines, the evidence, why it matters,
and your phase in brackets.

    - <what you found>, in <a path>: <why it matters> (<phase>)

Write the fact, never a gap: not "no knowledge file covers search", but what reading taught you
about search, or nothing.

Add yours at the end of the file, and make the file when it is not there. Never change or remove a
line that is already there, because another phase wrote it. When your tools cannot add to a file,
write it back whole with yours at the end. When nothing surprised you, write nothing: a line that
only proves the phase ran is noise. The wrap-up reads this file first and turns what holds into
knowledge.

## What changed, in plain words

Write a short section under that exact heading. Two to five sentences, for a reader who does
not read code: what you changed, what it means for a person using the product, and anything
they now have to decide. Name no file paths and no function names in it.

Write the same text to `<card folder>/<phase>/summary.md`.

## The last line

End with one of these two lines, on its own line, with nothing after it.

When the work is done:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

Ask only when the answer changes what you build. A question you could answer by reading the
repository is not a question, it is work.

When the question has a few clear answers, write them to `<card folder>/<phase>/question.md`
before you print that line, one per line in this form.

    - <a short answer>: <what it means for the work>
    - <a short answer>: <what it means for the work>

Write two to six answers and nothing else. The person sees each one as a button. Leave the file out
when the question has no short answers. One broken line shows no buttons.
