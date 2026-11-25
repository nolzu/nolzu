import { SCOUT_AND_EVIDENCE } from '@nolzu/protocol';

// Every key of the client, in one list. The one key handler reads it, and so does the help, which
// draws only the keys a screen binds an action to. That is why the help never lists a key that does
// nothing.

// Where a key works: on every page, on a board, on a card page, or on Knowledge.
export type KeyScope = 'global' | 'board' | 'card' | 'knowledge';
// The section of the help a key is listed in.
export type KeyGroup = 'move' | 'board' | 'cards' | 'go' | 'tabs';

// One press of one key. `mod` is Cmd on a Mac and Ctrl elsewhere.
export interface Stroke {
  key: string;
  shift?: boolean;
  mod?: boolean;
}

export interface Binding {
  // The name a screen binds a function to.
  action: string;
  // Each way to press it. A chord, such as G then D, is two strokes.
  keys: readonly (readonly Stroke[])[];
  label: string;
  scope: KeyScope;
  group: KeyGroup;
  // Starts an agent run, so the screen asks first and the help draws a bolt.
  starts?: boolean;
  // Acts only while focus is on a card, or on nothing. A focused button keeps its own Enter, a scrolled
  // panel its arrows, and a key for the selected card does not reach past a control to a card the
  // person is not looking at.
  onCard?: boolean;
  // Keeps acting while held, as an arrow does. Any other key acts once a press, so a held M does not
  // minimize and restore in turn.
  repeats?: boolean;
  // Acts in a text field too. Only for a key that opens over the field and gives focus back to it, so
  // the typed text stays, or for the main button of a screen of fields.
  inFields?: boolean;
}

// What a screen does for an action. False means it did nothing here, so the key keeps its own job
// in the browser, such as an arrow that scrolls the page.
export type KeyRun = () => boolean | void | Promise<unknown>;
export type KeyActions = Readonly<Partial<Record<string, KeyRun>>>;

const one = (key: string, more: Omit<Stroke, 'key'> = {}): readonly Stroke[] => [{ key, ...more }];
const chord = (first: string, then: string): readonly Stroke[] => [{ key: first }, { key: then }];

// In the order the help draws them. A key is listed only when its action exists in the code today.
export const KEYS: readonly Binding[] = [
  { action: 'next', keys: [one('j'), one('ArrowDown')], label: 'Next card', scope: 'board', group: 'move', onCard: true, repeats: true },
  { action: 'previous', keys: [one('k'), one('ArrowUp')], label: 'Previous card', scope: 'board', group: 'move', onCard: true, repeats: true },
  { action: 'right', keys: [one('ArrowRight')], label: 'Column to the right', scope: 'board', group: 'move', onCard: true, repeats: true },
  { action: 'left', keys: [one('ArrowLeft')], label: 'Column to the left', scope: 'board', group: 'move', onCard: true, repeats: true },
  // Cmd K and Ctrl K both, as `mod` reads either. Only where the rail is, which is where the palette is.
  // In a field too, where the browser would take it for its own search field.
  { action: 'palette', keys: [one('k', { mod: true })], label: 'Search or run a command', scope: 'global', group: 'move', inFields: true },
  { action: 'back', keys: [one('Escape')], label: 'Back, or close what is open', scope: 'board', group: 'move', onCard: true },
  // On a focused control the page holds the person's own work, such as a commit message, so Esc there
  // is that control's and does not leave the page.
  { action: 'back', keys: [one('Escape')], label: 'Back to the board', scope: 'card', group: 'move', onCard: true },
  // The card before and after this one in the board's order, as the head's K and J draw them.
  { action: 'previous', keys: [one('k')], label: 'Previous card', scope: 'card', group: 'move' },
  { action: 'next', keys: [one('j')], label: 'Next card', scope: 'card', group: 'move' },
  { action: 'settings', keys: [one(',', { mod: true })], label: 'Settings', scope: 'global', group: 'move' },
  // The main button of the first run screens that bind it (New project, the idea page and the first
  // task), from any of their fields.
  { action: 'make', keys: [one('Enter', { mod: true })], label: 'Make the project or its first card', scope: 'global', group: 'move', inFields: true },
  { action: 'help', keys: [one('?')], label: 'This help', scope: 'global', group: 'move' },
  { action: 'theme', keys: [one('t')], label: 'Light or dark theme', scope: 'global', group: 'move' },

  { action: 'filter', keys: [one('w')], label: 'Only the cards waiting on you', scope: 'board', group: 'board' },
  // Puts the focus in the board's filter box, which narrows the cards by key or title.
  { action: 'find', keys: [one('/')], label: 'Filter cards', scope: 'board', group: 'board' },
  { action: 'view', keys: [one('b')], label: 'Board or list', scope: 'board', group: 'board' },
  // The queue moves a waiting run to the front, not one place up, and the label says so.
  { action: 'promote', keys: [one('ArrowUp', { shift: true })], label: 'Move a queued card to the front', scope: 'board', group: 'board', onCard: true },
  { action: 'read-pulls', keys: [one('p')], label: 'Read pull requests now', scope: 'board', group: 'board' },

  // On the board it peeks, as a click on the card does, and opens the card page from the open sheet, as
  // a double click does. Now shares the binding and opens the page at once.
  { action: 'open', keys: [one('Enter')], label: 'Open the card (peek first on a board), or double-click it', scope: 'board', group: 'cards', onCard: true },
  // Opens the side sheet on the chosen card, and closes it again. J and K move on and the sheet follows.
  { action: 'peek', keys: [one(' ')], label: 'Peek, without leaving the board', scope: 'board', group: 'cards', onCard: true },
  { action: 'add', keys: [one('n')], label: 'Add card', scope: 'board', group: 'cards' },
  // The move a drop on the next column sends. It asks first when that column starts a run.
  { action: 'move-forward', keys: [one('ArrowRight', { shift: true })], label: 'Move forward', scope: 'board', group: 'cards', starts: true, onCard: true },
  { action: 'move-back', keys: [one('ArrowLeft', { shift: true })], label: 'Move back', scope: 'board', group: 'cards', onCard: true },
  // Opens the card page at the composer, the place the card's Answer link goes.
  { action: 'answer', keys: [one('a')], label: 'Answer the question', scope: 'board', group: 'cards', onCard: true },
  { action: 'retry', keys: [one('r')], label: 'Retry the failed phase, or Fix it when QA failed', scope: 'board', group: 'cards', starts: true, onCard: true },
  { action: 'stop', keys: [one('.', { mod: true })], label: 'Stop the run', scope: 'board', group: 'cards', onCard: true },
  { action: 'minimize', keys: [one('m')], label: 'Minimize', scope: 'board', group: 'cards', onCard: true },
  { action: 'copy', keys: [one('c')], label: 'Copy the key', scope: 'board', group: 'cards', onCard: true },
  { action: 'retry', keys: [one('r')], label: 'Retry the failed phase, or Fix it when QA failed', scope: 'card', group: 'cards', starts: true },
  { action: 'stop', keys: [one('.', { mod: true })], label: 'Stop the run', scope: 'card', group: 'cards' },
  { action: 'minimize', keys: [one('m')], label: 'Minimize', scope: 'card', group: 'cards' },
  // Puts the focus in Search knowledge, which narrows the files by name and text.
  { action: 'find', keys: [one('/')], label: 'Search knowledge', scope: 'knowledge', group: 'move' },

  { action: 'go:now', keys: [chord('g', 'n')], label: 'Now', scope: 'global', group: 'go' },
  { action: 'go:delivery', keys: [chord('g', 'd')], label: 'Delivery', scope: 'global', group: 'go' },
  { action: 'go:epics', keys: [chord('g', 'e')], label: 'Epics', scope: 'global', group: 'go' },
  { action: 'go:research', keys: [chord('g', 'r')], label: 'Research', scope: 'global', group: 'go' },
  // U for pull requests, as P is the project selector's.
  { action: 'go:prreview', keys: [chord('g', 'u')], label: 'PR reviews', scope: 'global', group: 'go' },
  { action: 'go:workspace', keys: [chord('g', 'w')], label: 'Workspace', scope: 'global', group: 'go' },
  { action: 'go:knowledge', keys: [chord('g', 'k')], label: 'Knowledge', scope: 'global', group: 'go' },
  // Only while Scout and Evidence are on: a key to a later screen would only land on Now.
  ...(SCOUT_AND_EVIDENCE
    ? ([
        { action: 'go:scout', keys: [chord('g', 's')], label: 'Scout', scope: 'global', group: 'go' },
        { action: 'go:evidence', keys: [chord('g', 'v')], label: 'Evidence', scope: 'global', group: 'go' },
      ] satisfies Binding[])
    : []),
  // Opens the project selector at the top of the rail, which is there on every plan.
  { action: 'go:project', keys: [chord('g', 'p')], label: 'Project selector', scope: 'global', group: 'go' },
  // Opens the bell's panel over the page, as G then P opens the selector. B for the bell, since N is Now.
  { action: 'go:notifications', keys: [chord('g', 'b')], label: 'Notifications', scope: 'global', group: 'go' },
];

export function scoped(scope: KeyScope): Binding[] {
  return KEYS.filter((binding) => binding.scope === scope);
}

// The number keys count the tabs that are shown, so a tab added later takes the next key and nothing
// is renumbered by hand. A screen binds each one as `tab:<id>`.
export function tabKeys(tabs: readonly { id: string; label: string }[]): Binding[] {
  return tabs.slice(0, 9).map((tab, index) => ({ action: `tab:${tab.id}`, keys: [one(String(index + 1))], label: tab.label, scope: 'card', group: 'tabs' }));
}

// The keys whose action the screen has, which are the only ones the handler acts on and the help lists.
export function liveKeys(keys: readonly Binding[], actions: KeyActions): Binding[] {
  return keys.filter((binding) => actions[binding.action] !== undefined);
}

export interface Press {
  key: string;
  shift: boolean;
  mod: boolean;
  alt: boolean;
  repeat: boolean;
  // A text field has focus, so the key is the person's text.
  typing: boolean;
  // Focus is on a card, or on nothing.
  onCard: boolean;
  // A modal dialog is open. It has the keys, and the page behind it gets none.
  dialog: boolean;
}

const TYPING = ['INPUT', 'TEXTAREA', 'SELECT'];

// The parts of a key event and of the page this reads, written out, because the shared typecheck has
// no DOM, so a pure module cannot lean on a browser global.
interface KeyEvent {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  target: unknown;
}

interface Focused {
  tagName?: string;
  isContentEditable?: boolean;
  matches?: (selector: string) => boolean;
}

// The one place a key press is read off the page. Every input counts as typing, a checkbox too, as
// it always has.
export function readPress(event: KeyEvent, page: { body: unknown; querySelector(selector: string): unknown }): Press {
  const target = event.target as Focused | null;
  return {
    key: event.key,
    shift: event.shiftKey,
    mod: event.ctrlKey || event.metaKey,
    alt: event.altKey,
    repeat: event.repeat,
    // A word an input method is still composing is text, wherever focus is.
    typing: event.isComposing || (target !== null && (target.isContentEditable === true || TYPING.includes(target.tagName ?? ''))),
    onCard: target === null || target === page.body || target.matches?.('article[data-card]') === true,
    // Read off the page, so any open dialog holds the keys, wherever focus has fallen inside it.
    dialog: page.querySelector('dialog[open]') !== null,
  };
}

// How long G waits for the letter after it.
export const CHORD_MS = 1500;

// The first key of a chord, while the handler waits for the second.
export interface KeyState {
  lead: Stroke | null;
  at: number;
}

export const NO_LEAD: KeyState = { lead: null, at: 0 };

// A browser sends a keydown for Shift itself before the D of G then Shift D, so a modifier alone is
// no key, and the chord waits on through it.
const MODIFIERS = ['Shift', 'Control', 'Meta', 'Alt', 'CapsLock'];

// A character carries Shift in itself: ? is Shift and /, and N is n with Shift. A named key, such as
// an arrow, does not, so Shift with it is a key of its own.
function same(want: Stroke, got: Stroke): boolean {
  if ((want.mod ?? false) !== (got.mod ?? false)) return false;
  if (got.key.length === 1) return want.key.toLowerCase() === got.key.toLowerCase();
  return want.key === got.key && (want.shift ?? false) === (got.shift ?? false);
}

// The binding a press reaches, and the chord state to keep for the next press. `now` is any clock in
// milliseconds, the same one every time.
export function matchKey(keys: readonly Binding[], press: Press, state: KeyState, now: number): { binding: Binding | null; state: KeyState } {
  // Alt types letters on many keyboards, so a key with Alt is text too.
  if (press.dialog || press.alt) return { binding: null, state: NO_LEAD };
  if (press.typing) {
    const field = keys.find((binding) => binding.inFields === true && !press.repeat && binding.keys.some((combo) => combo.length === 1 && same(combo[0]!, press)));
    return { binding: field ?? null, state: NO_LEAD };
  }
  if (MODIFIERS.includes(press.key)) return { binding: null, state };
  const acts = (binding: Binding) => (binding.onCard !== true || press.onCard) && (binding.repeats === true || !press.repeat);

  const lead = state.lead !== null && now - state.at <= CHORD_MS ? state.lead : null;
  if (lead !== null) {
    const second = keys.find((binding) => binding.keys.some((combo) => combo.length === 2 && same(combo[0]!, lead) && same(combo[1]!, press)));
    if (second !== undefined) return { binding: acts(second) ? second : null, state: NO_LEAD };
  }
  if (keys.some((binding) => binding.keys.some((combo) => combo.length === 2 && same(combo[0]!, press)))) {
    return { binding: null, state: { lead: { key: press.key, shift: press.shift, mod: press.mod }, at: now } };
  }
  // A key that does not finish the chord ends it, and counts as itself.
  const single = keys.find((binding) => acts(binding) && binding.keys.some((combo) => combo.length === 1 && same(combo[0]!, press)));
  return { binding: single ?? null, state: NO_LEAD };
}

const SECTIONS: readonly { group: KeyGroup; title: string; note: string | null; column: number }[] = [
  { group: 'move', title: 'Move around', note: null, column: 0 },
  { group: 'board', title: 'Board', note: null, column: 0 },
  { group: 'cards', title: 'Cards', note: null, column: 1 },
  { group: 'go', title: 'Go to', note: 'G, then a letter', column: 2 },
  { group: 'tabs', title: 'Card page tabs', note: 'Numbers count the tabs shown. Epics and Research cards have no Changes tab.', column: 2 },
];

export interface HelpSection {
  group: KeyGroup;
  title: string;
  note: string | null;
  keys: Binding[];
}

// The Delivery card's tabs, which the help on a board lists too. They act once a
// card is open, so a board shows them for reference. Written out because this package cannot read
// core's `tabsFor`; a test in the app holds the two lists together.
export const CARD_TABS: readonly Binding[] = tabKeys([
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'changes', label: 'Changes' },
  { id: 'discussion', label: 'Discussion' },
  { id: 'prs', label: 'PRs' },
  { id: 'log', label: 'Log' },
  { id: 'settings', label: 'Settings' },
]);

// The help's columns: moving and the board, then the cards, then the jumps and the tabs.
// A section with no live key is left out, and so is a column with no section. `cardTabs` adds the
// card page tabs where no tab key is live, which is the board's help.
export function helpSections(live: readonly Binding[], cardTabs = false): HelpSection[][] {
  const shown = cardTabs && !live.some((binding) => binding.group === 'tabs') ? [...live, ...CARD_TABS] : live;
  // The order of the list, wherever the screen put a key. A tab key is not in it and keeps its place.
  const rank = (binding: Binding) => (KEYS.includes(binding) ? KEYS.indexOf(binding) : KEYS.length);
  const sorted = [...shown].sort((a, b) => rank(a) - rank(b));
  const columns: HelpSection[][] = [[], [], []];
  for (const section of SECTIONS) {
    const keys = sorted.filter((binding) => binding.group === section.group);
    if (keys.length > 0) columns[section.column]!.push({ group: section.group, title: section.title, note: section.note, keys });
  }
  return columns.filter((column) => column.length > 0);
}

// The key row at the foot of a board, in a fixed order. Help comes after it.
// Enter peeks on the board, as Space does, so the row names it only on the open sheet.
const HINTS: readonly { action: string; label: string }[] = [
  { action: 'move-forward', label: 'move forward' },
  { action: 'move-back', label: 'move back' },
  { action: 'peek', label: 'or click peek' },
  { action: 'answer', label: 'answer' },
];

// The row while the peek sheet is open. J and K share one hint, so the
// next key's binding carries the two letters alone, drawn side by side with no word between.
const PEEK_HINTS: readonly { action: string; label: string }[] = [
  { action: 'peek', label: 'close peek' },
  { action: 'next', label: 'next card, the sheet follows' },
  { action: 'open', label: 'open' },
];

export function hintsOf(live: readonly Binding[], peeking = false): { label: string; binding: Binding; bare?: true }[] {
  return (peeking ? PEEK_HINTS : HINTS).flatMap((hint) => {
    const binding = live.find((found) => found.action === hint.action);
    if (binding === undefined) return [];
    if (peeking && hint.action === 'next') return [{ label: hint.label, binding: { ...binding, keys: [one('j'), one('k')] }, bare: true as const }];
    return [{ label: hint.label, binding }];
  });
}

const NAMES: Readonly<Record<string, readonly [shown: string, said: string]>> = {
  ArrowUp: ['↑', 'Up arrow'],
  ArrowDown: ['↓', 'Down arrow'],
  ArrowLeft: ['←', 'Left arrow'],
  ArrowRight: ['→', 'Right arrow'],
  Enter: ['↵', 'Enter'],
  Escape: ['Esc', 'Escape'],
  ',': [',', 'comma'],
  '.': ['.', 'period'],
  '?': ['?', 'question mark'],
  '/': ['/', 'slash'],
  ' ': ['Space', 'Space'],
};

// The caps for one way to press a key, and the words a screen reader says for them. Mac glyphs only,
// as the help shows them. A chord is one group of caps per stroke.
export function capsOf(combo: readonly Stroke[]): { strokes: string[][]; said: string } {
  const name = (key: string) => NAMES[key] ?? [key.toUpperCase(), key.toUpperCase()];
  return {
    strokes: combo.map((stroke) => [...(stroke.mod === true ? ['⌘'] : []), ...(stroke.shift === true ? ['⇧'] : []), name(stroke.key)[0]]),
    said: combo.map((stroke) => [...(stroke.mod === true ? ['Command'] : []), ...(stroke.shift === true ? ['Shift'] : []), name(stroke.key)[1]].join(' ')).join(' then '),
  };
}
