# Design system

The look of the client: tokens, fonts, sizes and the parts every screen is built from. `packages/ui/src/tokens.css` holds the values, and `docs.test.ts` checks that the tables below match it.

## Direction

Calm, dense, warm-neutral, keyboard-first. A tool for long hours, not a landing page. Dark
is the main theme, and light uses the same warm hue family. Status colors
are the only saturated colors, and they carry the same meaning on every screen. Nothing decorative. Motion is short and only for state change, such as a run
starting or a card coming to wait on you. Words people read are Geist, and evidence (keys,
costs, durations, tokens, models, commands and paths) is Geist Mono.

## Tokens

Every color is a CSS variable in `packages/ui/src/tokens.css`, in oklch, on a warm neutral hue
between 75 and 80 for every surface and ink. The file keeps one structure: dark on `:root`, light
on `data-theme="light"` and on the system preference when no theme is set, in four theme blocks,
and the `--space-*`, `--text-*` and `--radius-*` scales. `tokens.test.ts` measures every text
pair. A value that failed a contrast test changed its lightness, never its hue, until the test
passed. The values are in the table after the list.

- Surfaces, from back to front: `--bg`, `--rail` (the rail, a step above the page), `--panel`,
  `--card`, and `--card-2` (a raised part inside a card, such as an inline code chip).
- Lines: `--line` and the stronger `--line-2`.
- Inks: `--ink`, `--ink-2`, `--ink-3` (between ink-2 and muted), `--muted`, and `--faint`, which is
  for non-text only.
- Status: `--amber`, `--green`, `--red`, `--blue` and `--violet`, each with a `-bg` tint for the
  box behind it. Text on a tint over `--card-2` is ink, because muted falls to 4.4:1 there in
  dark. `--amber-line` draws the drop target and the queued outline. It is under 3:1, so it never
  marks a state alone: an amber word or a state word beside it says the same. `--hatch` is the
  faint amber stripe of an agent column, light enough that cards on top stay readable.
  `--amber-tint` stays as another name for `--amber-bg` until its last use moves.
- `--on-status` is the ink for text on a status fill. `--status-ink` stays as the same value.
- `--accent` and `--accent-ink`: the cream surface with dark ink in dark, and a dark surface with
  light ink in light.
- `--shadow`: the one shadow, for things that float.
- `--scrim`: the dimmed page behind an open dialog.

Each value is `oklch(L C H)`, and `/ A` is the opacity of a translucent tint.

| Token | Dark | Light |
|---|---|---|
| `--bg` | `0.145 0.006 75` | `0.968 0.004 80` |
| `--rail` | `0.163 0.006 75` | `0.944 0.006 80` |
| `--panel` | `0.183 0.007 75` | `0.984 0.003 80` |
| `--card` | `0.212 0.008 75` | `0.998 0.002 80` |
| `--card-2` | `0.245 0.009 75` | `0.958 0.005 80` |
| `--line` | `0.262 0.007 75` | `0.90 0.006 80` |
| `--line-2` | `0.32 0.008 75` | `0.85 0.007 80` |
| `--ink` | `0.94 0.006 80` | `0.21 0.008 75` |
| `--ink-2` | `0.82 0.007 80` | `0.35 0.008 75` |
| `--ink-3` | `0.75 0.008 80` | `0.42 0.008 75` |
| `--muted` | `0.68 0.008 80` | `0.48 0.008 75` |
| `--faint` | `0.53 0.008 80` | `0.62 0.006 80` |
| `--amber` | `0.81 0.14 72` | `0.51 0.14 62` |
| `--amber-bg` | `0.81 0.14 72 / 0.11` | `0.78 0.15 72 / 0.17` |
| `--amber-line` | `0.81 0.14 72 / 0.42` | `0.62 0.14 65 / 0.55` |
| `--hatch` | `0.81 0.14 72 / 0.035` | `0.70 0.14 70 / 0.07` |
| `--green` | `0.80 0.15 152` | `0.48 0.13 152` |
| `--green-bg` | `0.80 0.15 152 / 0.12` | `0.62 0.14 152 / 0.13` |
| `--red` | `0.72 0.18 25` | `0.52 0.19 25` |
| `--red-bg` | `0.72 0.18 25 / 0.13` | `0.62 0.19 25 / 0.10` |
| `--blue` | `0.77 0.11 245` | `0.50 0.15 250` |
| `--blue-bg` | `0.77 0.11 245 / 0.12` | `0.62 0.13 250 / 0.11` |
| `--violet` | `0.78 0.13 300` | `0.50 0.18 300` |
| `--violet-bg` | `0.78 0.13 300 / 0.13` | `0.62 0.16 300 / 0.11` |
| `--on-status`, `--status-ink` | `0.17 0.01 75` | `0.99 0 0` |
| `--amber-tint` | `var(--amber-bg)` | `var(--amber-bg)` |
| `--accent` | `0.93 0.03 85` | `0.22 0.01 75` |
| `--accent-ink` | `0.18 0.01 75` | `0.97 0.01 85` |
| `--scrim` | `0.1 0.005 75 / 0.6` | `0.25 0.01 75 / 0.38` |
| `--shadow` | `0 12px 32px` at `0 0 0 / 0.42`, then `0 2px 6px` at `0 0 0 / 0.3` | the same two layers at `0.20 0.01 75 / 0.12` and `0.20 0.01 75 / 0.08` |

Status: amber for an agent that starts or resumes work (running, queued, the go button, the drop
target, the agent column's hatch and glyph, the current pip), green for ready, pass and success,
red for failed and error, blue for information, links and New, violet for a question from the
agent. Count badges, switches that are on and the coach note use the cream accent. A warning is a
neutral box with a warning icon, never amber.

Buttons: primary uses the accent and is the one safe main action of a screen, such as making a
card. Go is amber and appears only where a run starts or resumes, such as "Approve and start
Implement" or "Send and resume", always with the engine, model and cost next to it. A go button
starts with a bolt for a run that starts and a send arrow for a session that resumes. Default and
ghost are for everything else, ghost for actions that only move or close. Three sizes: small
(26px), default (30px) and large (42px). Buttons always set an explicit background, because browser
defaults can make buttons unreadable. Contrast is measured, not guessed.

The shared parts are Svelte components in `packages/ui`: `Button` (default, primary, go, ghost and
danger, small and large, with an optional key cap), `Kbd`, `Chip` (plain and mono), `StatePill` (with
Quiet and New), `Switch`, `Banner` (info, ok, error and the neutral warning), `InfoBox` (a page's
explanation under its title), `HelpTip` (a "?" that opens a longer explanation in a native popover),
`Skeleton` (grey line, block, rows, card and pill shapes while a part loads, read to screen readers as
one line; every wait in the app uses it in place of a line of text, and a page that waits on git
streams that part so the page draws first), `ErrorBox`, `Dialog`,
`ConfirmTyped`, `ToastHost`, `SlotsMeter`, `LaneChips`, `CoachNote`, `OptionButtons`, `Keyboard`,
`KeyCaps`, `StartConfirm` and `WaitingToggle`, the board's filter button with its cream count. The rail
is the app's own `Rail` component, because it links the app's routes and reads the signed display
document. A source test fails when any other component puts amber on a button, a link or a disclosure.

`Dialog` is the one dialog shell, on the native `<dialog>` opened with `showModal`: the title, the body,
and a footer for the buttons with the main action first. It opens when it is put on the page, moves
focus to the field marked autofocus or the first control, and gives focus back to what opened it. Esc
and a click on the backdrop close it unless the caller holds it, as Add card does while the card is on
its way. The click closes it only when the press began on the backdrop too, so selecting text with a
drag that ends past the box keeps it open. Add card keeps what was typed when it closes without a card
and shows it at the next open, until the card is made. Scout's source dialog and the Remove confirm do
the same until a save or a send, and a token is never kept. While any dialog
is open, the board keys do nothing. `ConfirmTyped` is built on it for an action that deletes: it lists
what is lost first, puts work that exists nowhere else (such as commits that were never pushed) in a red
box, says in one quiet line what stays, and keeps its red danger button off until the exact folder name
is typed, with Cancel on Esc. A line of what is lost can set one part in mono, such as a path.
`ToastHost` draws the stack of toasts in one corner, newest at the bottom. The app keeps one stack,
one toast per card, which the root layout hands its one host, and the host draws the newest three,
so the oldest drops off. Each toast leads with its card key, then the sentence, then the mono line of
model, time and cost when the toast comes from a run, then Open, the one link to the card, and
Dismiss. A toast with a fix link has that link in place of Open, and one with nowhere to go, such as
a save on Settings, Project, the page the person is on, has no Open. A toast with no run has no mono
line. A toast with a headline puts the reason and the fix on one line under it, and a refusal, where
nothing ran, has the ban sign. The corner is a live region that is always on the page, so a screen
reader reads each new toast, and an error is read out as an alert. The countdown is the bar's own
CSS animation, so hover and focus pause both at once, and its end closes the toast.

Every key lives in one list in `packages/ui/src/keymap.ts`: the key or the chord, a label, a scope
(every page, a board, a card page) and the action's name. `Keyboard` is the one key handler. The root
layout mounts it once with the global keys, and a board or a card page hands it its own keys and the
actions they run. One guard decides when a key is text and not a shortcut: focus in a field, a word an
input method is composing, Alt held, or any open dialog. G waits 1.5 seconds for its letter. The help
(?) is a wide `Dialog` with a close button beside the title, laid out in columns, and it lists
only the keys whose action the screen has. `KeyCaps` draws a key's caps for the help and the board's key
row, with the words a screen reader says. `StartConfirm` is what a key that starts a run opens: the
drop's own Starts line on the amber tint, the estimate with where it came from ("about $0.40 · 6 to 10
min, from 8 runs in this project"), then Confirm, which has the focus so ↵ presses it, and Cancel
on Esc. A model that goes while it is open turns Confirm off.

`SlotsMeter` draws a block per agent slot from the board snapshot, the busy ones amber, and says "2 of 3
agent slots busy". `LaneChips` says for each lane whether it is free or which card holds it. Neither
draws anything when the snapshot has no slots or lanes. `CoachNote` is cream with a shadow and explains
one thing once: Got it hides it and stores its name in the `seenNotes` setting through
`POST /api/notes`, and a page that passes that list never draws it again. The page fills the hint
beside Got it, and a key cap in it takes the note's ink. `OptionButtons` draws the answers
the agent offered with its question. A press fills the answer and sends nothing, so Send stays the one
go button. The pressed option has an ink edge and a check, and a compact form draws pills with the
label only.

## Fonts

Geist for words and Geist Mono for evidence, both under the SIL Open Font License. The woff2 files
and the license are bundled in `packages/ui/src/fonts`, declared with `@font-face` and
`font-display: swap`, and named first in `--font-sans` and `--font-mono`, with today's system stacks
after them. The page draws them with antialiased smoothing. No request leaves
the machine for a font: there is no font CDN in the client, the hosted app or the website.

## Type scale

UI text 13px base with a line height of 1.45, 14px for body text, dense rows 11.5 to 12px, card
titles 13.5px medium, the top bar title 15px, page titles 26px semibold, the first run question
40px semibold with tight letter spacing, section titles 13px semibold in sentence case and never in
capitals, the lede under a title 16 to 18px, and rendered prose 14px with a line height of 1.6. Mono
runs 11 to 13px: keys 11.5px, chips 11px, key caps 10.5px. The sizes map onto the `--text-*` scale.
Line height is tight in tables and relaxed in rendered markdown.

## Layout and width

The rail is 232px, 56px folded on a board, and content uses the width right of the rail. No app page
sits in a centred box. The first run screens have no rail and centre one page of at most 1180px.
Line length is set on the text block and never on the page: a lede at most 68 characters, a short
note at most 72, and long text fills its box up to 120 (rendered Markdown such as a discussion, a run
summary, the card's plain-words summary, a file read on a card's Files tab). The top bar is 54px. The card page's decision panel is 360px and Now's right
column is 300px. Below 760px the rail moves to the top.

## Spacing and radius

A 4px grid. Card padding 10 to 12px. Column gap 8px. Borders are 1px. The radius scale runs by part:

| Token | Radius | Parts |
|---|---|---|
| `--radius-xs` | 4px | key caps and inline code |
| `--radius-sm` | 6px | chips, the role glyph and the items of a segmented control |
| `--radius-md` | 8px | buttons, inputs, the search button, the segmented control and question boxes |
| `--radius-lg` | 10px | cards, toasts, banners, the large button, the drop target and the error box |
| `--radius-xl` | 12px | panels, columns, terminals and text areas |
| `--radius-2xl` | 14px | dialogs, the coach note and the selector menu |

Pills are fully round.

## Shadows

Only things that float carry a shadow, in both themes: a dragged card, the coach note, a toast, a
dialog, the command palette, the selector menu and a popover. A card at rest has none, and dark
uses no other shadow for elevation.

## Iconography

Thin line glyphs, monochrome, colored only by status. Role glyphs for columns: person,
lightning (agent, in an amber box), clock (auto), archive box. Engine glyphs stay abstract, with no
vendor logos in the product UI.

## Accessibility

Everything is reachable by keyboard. A visible focus ring in the accent color. Status is
never shown by color alone (a pill or dot with its label). Reduced motion is respected. Text inks
meet AA (4.5:1) on every surface they sit on, in both themes. `faint` is for non-text only and
meets 3:1. Where a value fails one of these tests, the test wins.

## Voice inside the UI

Plain, short, specific. "Drop to start Implement · sonnet · high · about $0.40". "Asks you: 1 to 5
stars, or thumbs up and down?". "Quiet 6m". "Waiting for the knowledge lane". "Read-only. Scout never
changes code." Never "Something went wrong".

