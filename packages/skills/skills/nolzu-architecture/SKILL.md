---
name: nolzu-architecture
description: Turns a refined brief for an epic into the shape of the solution. It names the pieces, what each one owns, where they meet, the data that moves between them, and every decision with its reason and the alternative that was turned down. Use it for the architecture phase of an epic, after refine and before the design.
---

# Shape an epic

Read `<card folder>/refine/refined.md` and the repository, then write the shape of the solution the
rest of the epic is built from. This phase runs on an epic and not on one task, so it covers the
whole of it. Change no code and run no command.

When the project folder, not a card's checkout, has `.nolzu/phases/architecture.md`, follow it too.
It wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its
prompt and need not open it.

Every file of this epic goes in the card folder, which is the folder the prompt names. It sits in
the project, next to the checkout and not inside it, so use the path the prompt gives.

## How to shape it

Start from what is already there. Read the code the epic touches before you name a piece, because a
piece that already exists is a piece you do not have to design. The shape that fits the repository
beats the shape that would be nicer on an empty one.

A piece is something with its own folder, its own process or its own stored data. A single file is
never a piece, and neither is a function, a screen or a class. Most epics come out between three
and seven pieces. Fewer than three is a shape small enough to say in a sentence, and the document
says it that way. Over seven, the
epic is too big for one document, and that goes under what is still open.

Name the pieces, and for each one say what it owns and what it does not. A piece nobody can draw a
line around is two pieces or none. Then say where they meet: who calls whom, what crosses the line,
and what each side may assume about the other. A boundary you cannot describe in one sentence is
the part that will hurt later.

Write down every decision with its reason and the alternative you turned down. The reason is worth
more than the decision. A reader who knows why a door was closed can reopen it later; a reader who
finds only the decision has to redo the thinking.

Read the repository whenever it settles a question. A question you can answer by reading is not a
question, it is work.

## What to write

Write `<card folder>/architecture/architecture.md` with these sections, in this order, each under a second-level heading with exactly this name. The skeleton shows the shape, and the rules under it say what goes in each part.

    ## Before you approve
    - Concluded: the api filters the recipes by title, and the page asks it again as the person types.
    - Decide: D1, the api filters, not the page.
    - Open: Q2, should the search match tags too? Default: no.
    - Risks: the list page caches its first fetch, so the filter has to ask again.
    - Not read: the mobile styles, because the checkout has none.
    - Next: Design draws the search box and its states.

    ## The shape
    Read at: 4f2a91c on 2026-10-24.
    The api takes a q option and filters by title. The page sends what the person typed.

    ## The pieces
    ## Where they meet
    ## Interfaces
    - GET /recipes?q=<text>: 200 with Recipe[] (api/src/recipes.ts) in title order. An empty q gives every recipe.
    - GET /recipes on a failed read: 500 with the text "The recipes did not load.", and the same cross-origin header as the 200.

    ## The data
    ## The decisions
    - D1: The api filters the recipes. Not: the page, because the list will outgrow one fetch. Keep: GET /recipes with no q answers as today.

    ## What is still open
    - Q2: Should the search match tags too? Default: no, titles only. blocks: yes
    - Q3: Should the filter get its own module? Default: no, it stays in recipes.ts. blocks: no

    ## Touch points
    | Piece | File or module | What changes |
    |---|---|---|
    | Recipe api | api/src/recipes | takes a q option and filters by title |
    | Recipe list page | web/src/routes | gains a search box above the list |

    ## Test surfaces
    ## Not doing
    ## Read first
    - api/src/recipes.ts: listRecipes, which the filter extends.

`## Before you approve` is the review block the [finish rules](finish.md) describe: the shape in one or two sentences, the decisions a person may want to change with the option turned down, the open questions, the top risks, what you could not read, and what Design will do.

`## The shape` starts with `Read at:` and the commit and date from the prompt's line "The code you read is at commit ...", or `Read at: the prompt named no commit, <today's date>.` when it has none. Then what the solution is, in three or four sentences.

`## The pieces` gives one line per piece: its name, what it owns, and what it deliberately does not. `## Where they meet` gives one line per boundary: who calls whom, what crosses, and what each side may assume.

`## Interfaces` gives each shape that crosses a boundary as a signature: an endpoint, an event, a type or a file format. For an endpoint, give the address, the body of each answer, the errors included, and every header the other side needs to read it. Say what a malformed input gets. Name the words a person will see in an error. The design and every task build to these lines, so a fact left out here is a guess in each of them.

`## The data` says what is stored and where it lives.

`## The decisions` holds one line per decision, `D1`, `D2` and on: the rule, then `Not:` the option turned down and why, then `Keep:` what must not change, where something must not. This is the card's one `D` sequence, and Plan goes on from your last id.

`## What is still open` holds only the questions whose answer changes the shape, at most three, in the brief's line shape: `- Q2: <question> Default: <answer>. blocks: yes` (or `blocks: no`). A question whose answer changes what a person using the product sees or gets, such as an error or a fallback, is `blocks: yes` even with a default. Go on from the brief's last `Q` id. Write `Nothing.` when there is none.

`## Touch points` is a table with three columns: the piece, the file or module it lands in, and what changes there. Plan builds its steps from this table instead of searching the code again. `## Test surfaces` says where the tests of each piece go, and names one existing test that a new one can copy.

`## Not doing` says what a reader might expect and will not get, and why. `## Read first` lists the files Design and Plan open first, one per line with why.

The ids never change once written. A later run that drops a decision leaves a gap rather than renumbering.

An epic that needs no new shape still gets the file. Say under the shape that nothing new is being
designed, name the pieces the work lands in, and write one line under every section that has
nothing in it. A run that invents a piece to fill a section costs the phases after it more than an
empty section would.

A person opens this file from the epic's ticket page, so write it for a reader. Keep it short enough
to read in one go. A document nobody finishes is a document nobody builds from.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/architecture/work/`.

Write each paragraph and each list item of every file in the card folder on one line, and never break a sentence in the middle. Add each surprise you met on the way to `<card folder>/discoveries.md` as one line, in the form the [finish rules](finish.md) give. Write nothing there when nothing surprised you.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/architecture/summary.md`,
so the ticket page can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the shape is written:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/architecture/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
