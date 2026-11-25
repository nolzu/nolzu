---
name: nolzu-refine
description: Turns a rough ticket into a refined brief with the problem, the scope, the acceptance checks, what is out of scope and the open questions. Use it for the refine phase of a card, before anything is planned.
---

# Refine a card

Read the card's ticket text and the extra context the person added, then turn it into a brief
the plan phase can work from. Change no code and run no command.

When the project folder, not a card's checkout, has `.nolzu/phases/refine.md`, follow it too. It
wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its
prompt and need not open it.

When the extra context is a Research answer with `## If this becomes a card`, start from its
problem, criteria, questions and places to change, and check each one against the code.

## What to write

Every file of this card goes in the card folder, which is the folder the prompt names. It sits in
the project, next to the checkout and not inside it, so use the path the prompt gives.

Write `<card folder>/refine/refined.md`. Its first line is the card's key and a short title, and
right under it come two plain lines:

    # <KEY>: <title of at most 80 characters>
    Kind: feature
    Branch: <two to four lowercase words joined by hyphens>

Kind is one of feature, fix or chore. A bug card is fix. Branch names the work in a few words,
such as `recipe-search`. On a local card, Nolzu makes that title the card's title. A
GitHub or Jira card keeps the title its ticket has.

Then come these sections, in this order, each under a second-level heading with this name. The
skeleton shows the shape, and the rules under it say what goes in each part.

    ## Before you approve
    - Concluded: <what the card is for, in one sentence>.
    - Decide: Q1, <the question>? Default: <the answer Plan builds on>.
    - My calls: A1, <the guess>. A2, <the guess>.
    - Risks: <what could make this brief wrong>.
    - Not read: <what you could not read, or "nothing">.
    - Next: Plan turns AC1 and AC2 into steps.

    ## Problem
    ## Scope
    ## Assumptions
    - A1: The search matches recipe titles, not ingredients.

    ## Acceptance checks
    - AC1 (must): Typing "bean" in the search box shows only recipes with "bean" in the title.
      Check: a browser test types "bean" and counts the rows.
    - AC2 (should): Spaces around the word do not change the result.
      Check: the api test asks for " bean " and gets the same rows as "bean".

    ## Open questions
    - Q1: Should the search also match ingredients? Default: no, titles only. blocks: yes

    ## What the code does today
    Read at: 4f2a91c on 2026-10-24.
    - The api has no filter: `listRecipes` (api/src/recipes.ts) returns every row.

    ## Rules that apply
    - "Write the test first for a plain function." (knowledge/api-testing.md)
    - AGENTS.md, section "Tests".

    ## Out of scope
    ## Read first
    - api/src/recipes.ts: the list the search will filter.

`## Before you approve` is the review block the [finish rules](finish.md) describe: what a person reads at the gate, in this order and as bullets. Blocking questions come first under Decide, then the rest. Leave out Decide, Risks or My calls when there is nothing for them. Next says how many acceptance checks there are.

`## Problem` says in two or three sentences what is wrong today and who feels it. For a fix, add four lines under it: `Today:` what happens now, `Expected:` what should happen, `Unchanged:` what must keep working, and `Reproduce:` the steps or the request that shows it.

`## Scope` names what this card changes as behaviour, not as files. Name the exact words a person will see, such as a message or a label, because Plan and QA copy them.

`## Assumptions` holds each thing you decided without proof, one line each, `A1`, `A2` and on. A person reads these to correct you, so a guess goes here and not inside Scope.

`## Acceptance checks` holds one line each, `AC1`, `AC2` and on, with a level after the id: `must` when the card fails without it, `should` when it matters but does not fail the card. QA passes a card only when every `must` check passed. Word each one so a reader can see whether it passed. Every check, `should` ones too, is two lines: the check, then its `Check:` line under it, indented two spaces, with the test, the command, the request or the browser steps that prove it. Never put `Check:` on the check's own line. An edge case that changes the code, such as an empty input, extra spaces or a missing id, is a `should` check of its own, not a section, written the same way:

    - AC3 (should): An empty search box shows every recipe.
      Check: the api test asks for "" and gets every recipe.

A check is about what the product does, never how the work was done, so a project rule such as "write the test first" goes under Rules that apply. A task of an epic finds the epic's checks in its ticket, as `From APP-5: AC2 ...`: number your own from `AC1` anyway, and end each one that serves an epic check with it, such as `(serves APP-5 AC2)`. Earlier tasks may have built part of the epic already, so check every carried check and fact against the code in the checkout. When the code contradicts one, write the check the code supports and name the change under My calls, such as `A2: APP-5 AC7 says the id reader gives no id for abc, but the code gives abc, so AC4 checks that abc answers 404`.

`## Open questions` holds only the questions whose answer changes what gets built, at most three, each on one line as the skeleton shows: `Q1`, the question, `Default:` the answer you would build on, and `blocks: yes` when work should not start on that default, or `blocks: no` when it can. A question whose answer changes what a person using the product sees or gets, such as an error or a fallback, hiding or showing, failing or carrying on, is `blocks: yes` even with a default, because that choice is not yours to make. A person must pick the default or answer a `blocks: yes` question before the card moves on. A fourth question becomes an assumption with its default. Write `None.` when there are none.

`## What the code does today` starts with `Read at:` and the commit and date from the prompt's line "The code you read is at commit ...", as the skeleton shows. When the prompt has no such line, write `Read at: the prompt named no commit, <today's date>.` Then one line per fact Plan needs: what the code does now where this card lands, by path and symbol, such as the function the change extends, the test file beside it and how the tests are run. When the code offers two places for the change, name both and say which you expect. When the checkout holds no code to read, say so here and in the review block.

`## Rules that apply` copies each rule from the knowledge folder and the ticket word for word, in quotes, with its file or the ticket as the source. A rule in the project's own agent file, such as AGENTS.md, is named by file and section only, because every engine loads that file itself. Write `None.` when no rule applies.

`## Out of scope` is the brief's Not doing: what a reader might expect here and will not get.

`## Read first` lists the files Plan should open before anything else, one per line with why.

The ids never change once written. A later run that drops a check leaves a gap rather than renumbering, because other files already name it.

Read the repository whenever it settles a question. A question you can answer by reading is not
a question, it is work.

When the prompt lists the project's knowledge, first read the files that say what the repositories
are for and what the words of this domain mean.

Keep the brief short enough to read in one go. A brief nobody finishes is a brief nobody follows.

## Several repositories

When the prompt lists the project's repositories, read the knowledge file of each one first, then
the code where the card points. Change none of them. End `refined.md` with one line that names
the repositories this card changes, by the names the prompt gives, such as:

    Repositories: api, web

Nolzu keeps that line as the card's list. Plan can correct it, and implement works in the
repositories on it. Leave the line out when the prompt lists no repositories.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/refine/work/`.

Write each paragraph and each list item of every file in the card folder on one line, and never break a sentence in the middle. A `Check:` line is the one exception: it goes on its own line under its acceptance check. Add each surprise you met on the way to `<card folder>/discoveries.md` as one line, in the form the [finish rules](finish.md) give. Write nothing there when nothing surprised you.

These two parts come last, in this order, and they belong to this format. The wording they share
with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/refine/summary.md`, so
the ticket page can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write,
other than the summary itself, rewrite it with the plain summary of the work so far, in the same
plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the brief is written:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to
`<card folder>/refine/question.md` before you print that line, in the form the
[finish rules](finish.md) give.
