---
name: nolzu-design
description: Draws the screens an epic changes as finished HTML pages, one file per screen with every state a person meets, styled from one shared tokens.css taken from the repository's own look, with a list saying what each screen is for, which checks it covers and what it asks. Use it for the design phase of an epic, after architecture and before plan.
---

# Design the screens

Read `<card folder>/refine/refined.md` and `<card folder>/architecture/architecture.md`, then draw the screens this epic changes. Change no code and run no command. This phase reads files and writes files, and does nothing else. The design is the only thing it produces.

When the project folder, not a card's checkout, has `.nolzu/phases/design.md`, follow it too. It wins over this skill except on file names, headings, fields and ids. A Nolzu run has it in its prompt and need not open it.

Take the screens from the acceptance checks in the brief and from the places in the architecture where a person meets the change. Draw the screens this epic changes, and no others. A screen the epic leaves alone belongs to another card.

Every file of this epic goes in the card folder, which is the folder the prompt names. It sits in the project, next to the checkout and not inside it, so use the path the prompt gives.

## What the design is for

The design is the screen as it will ship. A person approves it before the plan is written, Implement builds to it, and QA compares the running screen with it. So draw the finished page, not a sketch: real spacing, real type, real colors and the real words.

Draw every state a person meets, not the full and happy one alone. A list with nothing in it yet, a load that failed, a title far longer than anyone expected, a field with a wrong value in it: that is where a screen gets decided. A state a click would show is drawn as its own block on the page, under a small heading that names the state.

Write the words a reader would see on the real screen. Placeholder text hides the problem the design exists to find. An empty state says what is missing and what to do. An error names the problem.

## The look comes from the repository

Before you draw, read how the repository already looks: its CSS variables, its theme file, its component library and the styles of the screens next to the ones you change. When it has a look, the design follows it and does not replace it. Take the colors, the type, the spacing and the corner sizes from there, under the names the repository uses.

When the repository has no look yet, such as a new app or a service with no screen, propose one. Keep it small: a few colors, one type scale, one spacing scale.

Either way, every text color on its background reads at 4.5:1 or more.

## How to write the files

Write the shared values as `<card folder>/design/tokens.css`: the epic's colors, type and spacing as CSS variables on `:root`, plus the few base rules every screen shares. Each screen links it with a relative path, as `<link rel="stylesheet" href="tokens.css">`, and adds its own rules in one style block. Use the variables in those rules, not new hex values, so a change of color is one line in one file.

Write each screen as `<card folder>/design/<screen-name>.html`, one file per screen, the name in lower case with hyphens. The `.html` ending is what a browser needs to draw it.

Each screen is a whole document: a doctype, a charset, a viewport meta tag, a title, the link to tokens.css, the style block, then the page. A fragment draws one way in the Files tab and another way when a person opens the file.

Write no script tag at all. Fetch nothing over the network: no font, no stylesheet, no picture from another address. The Files tab draws the page sandboxed, and a person may open it on a machine with no network. A picture you need is drawn inline or left as a labelled box. A font is the repository's own font stack or a system font.

Keep every file under 100 kB. The viewer refuses anything over 256 kB, and a file whose source a person cannot read cannot be argued with.

## The list

Write `<card folder>/design/design.md` with these sections, in this order, each under a second-level heading with this name, and one third-level heading per screen named by its file. The skeleton shows the shape, and the rules under it say what goes in each part.

    ## Before you approve
    - Concluded: one screen changes, the recipe list, which gains a search box.
    - Screens: recipe-list.html, with Q3 on its empty state.
    - My calls: the error shows in the status line, as the list's errors do today.
    - Not read: nothing.
    - Next: Plan builds the screen with its four states.

    ## Screens
    Read at: 4f2a91c on 2026-10-24.
    Tokens: from web/src/app.css.

    ### recipe-list.html
    The recipe list, which a cook opens to find one recipe.
    Address: / as today. The search text stays in the box, not in the address.
    States:
    - With matches (AC1): the rows whose title holds the text, in title order.
    - No match (AC1, AC2): "No recipe has cake in its title. Clear the box to see every recipe."
    - Api error (no check): "The recipes did not load. Try again in a minute." in the status line.
    - Long title (no check): the title wraps, and the minutes stay on the right.
    Data: GET /recipes?q=<text> from the architecture's Interfaces, a Recipe[].
    Reuse: the row markup of renderList (web/src/list.ts), the .status style (web/src/app.css).
    Question: Q3: Should the empty sentence offer a button that clears the box? Default: no. blocks: yes

    ## Not doing
    ## Read first
    - web/src/list.ts: renderList, which draws the rows.

`## Before you approve` is the review block the [finish rules](finish.md) describe. Screens names the screens in the order a person meets them, with the question each one asks.

`## Screens` starts with `Read at:` and the commit and date from the prompt's line "The code you read is at commit ...", or `Read at: the prompt named no commit, <today's date>.` when it has none, then `Tokens:` with the files of the repository you took the tokens from, or that the repository had no look and these are proposed. Then one entry per screen, in the order a person meets them, with these fields in this order.

1. The heading: the file name.
2. What the screen is for and who opens it, in one or two sentences.
3. Address: where the code serves the screen and how a person gets there, as the real address and never the design file's name. A screen that opens from another one says which link opens it and where its back link goes.
4. States: one line per state, named as its heading in the HTML file names it, so QA can check it by that name. Then, in brackets, the acceptance checks it covers, by their ids in the brief, such as `AC1, AC3`, or `no check`. Then what shows, with the exact words and the element that holds them.
5. Data: what each state needs and where it comes from, such as an endpoint of the architecture's `## Interfaces` with the shape of its answer, and which answer leads to which state.
6. Reuse: the components and styles to reuse, by path and symbol. Leave it out when there is nothing to reuse.
7. Question: the one thing you want the person to decide on this screen, in the brief's line shape with a default and `blocks:`, which is `yes` when the answer changes what a person using the product sees or gets, even with a default. Go on from the last `Q` id of the brief and the architecture. A screen with no question gets looked at once and never again.

When a screen turns on an answer only a person can give, draw the version you would build, make it the default and name the choice in the question, rather than drawing both and leaving the reader to pick.

`## Not doing` says what a reader might expect and will not get, and why. `## Read first` lists the files Plan opens first, one per line with why.

When the epic needs no screen, write `<card folder>/design/design.md` with the review block, one or two sentences under `## Screens` after the `Read at:` line saying so and why, and the last two sections, and write no HTML file and no tokens.css. An epic that only moves data behind the product is finished here.

## Output format

Anything you store beyond the files this skill names goes in `<card folder>/design/work/`.

Write each paragraph and each list item of every file in the card folder on one line, and never break a sentence in the middle. Add each surprise you met on the way to `<card folder>/discoveries.md` as one line, in the form the [finish rules](finish.md) give. Write nothing there when nothing surprised you.

These two parts come last, in this order, and they belong to this format. The wording they share with every other phase is in the [finish rules](finish.md).

Write the plain summary section, and write the same text to `<card folder>/design/summary.md`, so the ticket page can show it without reading the whole log.

Keep that file current while you work, not only at the end. After each file you change or write, other than the summary itself, rewrite it with the plain summary of the work so far, in the same plain words. A person reads it while the run is still going.

End with one of these two lines, on its own line, with nothing after it.

When the screens, the tokens and the list are written, or when the epic needs no screen and design.md says so:

    NOLZU: complete

When a question blocks the work and a guess would waste the run:

    NOLZU: needs_input: <your question on one line>

When the question you ask has a few clear answers, write them to `<card folder>/design/question.md` before you print that line, in the form the [finish rules](finish.md) give.
