import { describe, expect, it } from 'vitest';
import { type Binding, capsOf, CHORD_MS, helpSections, hintsOf, KEYS, liveKeys, matchKey, NO_LEAD, type Press, readPress, scoped, type Stroke, tabKeys } from './keymap.ts';

const press = (key: string, over: Partial<Press> = {}): Press => ({ key, shift: false, mod: false, alt: false, repeat: false, typing: false, onCard: true, dialog: false, ...over });

// The keys a screen hands the handler: the global ones and its own.
const BOARD = [...scoped('global'), ...scoped('board')];
const DELIVERY_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'files', label: 'Files' },
  { id: 'changes', label: 'Changes' },
  { id: 'discussion', label: 'Discussion' },
  { id: 'log', label: 'Log' },
  { id: 'settings', label: 'Settings' },
];
const EPIC_TABS = DELIVERY_TABS.filter((tab) => tab.id !== 'changes');
const CARD = [...scoped('global'), ...scoped('card'), ...tabKeys(DELIVERY_TABS)];

const action = (keys: readonly Binding[], pressed: Press, state = NO_LEAD, now = 0) => matchKey(keys, pressed, state, now).binding?.action ?? null;

describe('single keys', () => {
  it.each([
    ['?', 'help', { shift: true }],
    ['t', 'theme', {}],
    ['T', 'theme', { shift: true }],
    ['n', 'add', {}],
    ['N', 'add', { shift: true }],
    ['w', 'filter', {}],
    ['W', 'filter', { shift: true }],
    ['p', 'read-pulls', {}],
    ['j', 'next', {}],
    ['ArrowDown', 'next', {}],
    ['k', 'previous', {}],
    ['ArrowUp', 'previous', {}],
    ['ArrowRight', 'right', {}],
    ['ArrowLeft', 'left', {}],
    ['Enter', 'open', {}],
    ['Escape', 'back', {}],
    ['r', 'retry', {}],
    ['m', 'minimize', {}],
    ['c', 'copy', {}],
  ])('reads %s on the board as %s', (key, wanted, over) => {
    expect(action(BOARD, press(key, over))).toBe(wanted);
  });

  // A named key carries no Shift of its own, so Shift with an arrow is a key apart. A character
  // carries it: ? is Shift and /, and N is n with Shift.
  it('reads Shift with an arrow as a key of its own', () => {
    expect(action(BOARD, press('ArrowUp', { shift: true }))).toBe('promote');
    expect(action(BOARD, press('ArrowLeft', { shift: true }))).toBe('move-back');
    expect(action(BOARD, press('ArrowRight', { shift: true }))).toBe('move-forward');
    expect(action(BOARD, press('Enter', { shift: true }))).toBeNull();
  });

  it('takes Cmd or Ctrl only for the keys that ask for it', () => {
    expect(action(BOARD, press(',', { mod: true }))).toBe('settings');
    expect(action(BOARD, press('.', { mod: true }))).toBe('stop');
    expect(action(BOARD, press(','))).toBeNull();
    expect(action(BOARD, press('.'))).toBeNull();
    // Cmd T and Cmd N belong to the browser.
    expect(action(BOARD, press('t', { mod: true }))).toBeNull();
    expect(action(BOARD, press('n', { mod: true }))).toBeNull();
  });

  // Alt types letters on many keyboards, so a key with Alt is text and never a shortcut.
  it('leaves every key with Alt alone', () => {
    for (const key of ['n', 't', '?', 'Enter', ',']) expect(action(BOARD, press(key, { alt: true }))).toBeNull();
  });

  // A answers a blocked card. It opens the composer and starts nothing.
  it('reads A on a focused card as answer, which starts no run', () => {
    expect(action(BOARD, press('a'))).toBe('answer');
    expect(action(BOARD, press('A', { shift: true }))).toBe('answer');
    expect(action(BOARD, press('a', { onCard: false }))).toBeNull();
    expect(action(CARD, press('a'))).toBeNull();
    expect(KEYS.find((one) => one.action === 'answer')).toMatchObject({ label: 'Answer the question', scope: 'board', group: 'cards' });
    expect(KEYS.find((one) => one.action === 'answer')?.starts).toBeUndefined();
  });

  it('ignores a key it has no use for', () => {
    expect(action(BOARD, press('x'))).toBeNull();
    expect(action(BOARD, press('F5'))).toBeNull();
  });
});

describe('the typing guard', () => {
  const every = ['n', 't', '?', 'j', 'Enter', 'Escape', 'ArrowDown', '1'];

  it.each(every)('gives %s to the text field that has focus', (key) => {
    expect(action(CARD, press(key, { typing: true }))).toBeNull();
    expect(action(BOARD, press(key, { typing: true }))).toBeNull();
  });

  it('gives a Cmd key to the field too', () => {
    expect(action(BOARD, press(',', { mod: true, typing: true }))).toBeNull();
  });

  // Focus can sit on a dialog button, or fall to the body after a click on dialog text. The open
  // dialog holds the keys, so nothing acts on the page behind it.
  it.each(every)('does nothing for %s while a dialog is open', (key) => {
    expect(action(BOARD, press(key, { dialog: true }))).toBeNull();
    expect(action(BOARD, press(key, { dialog: true, onCard: false }))).toBeNull();
  });

  // A focused button keeps its Enter, a scrolled panel its arrows, and a key that acts on the
  // selected card does not reach past a focused control to a card the person is not looking at.
  it.each(['Enter', 'Escape', 'ArrowDown', 'j', 'r', 'm', 'c'])('leaves %s alone while focus is on a control that is not a card', (key) => {
    expect(action(BOARD, press(key, { onCard: false }))).toBeNull();
  });

  it.each([
    ['n', 'add'],
    ['w', 'filter'],
    ['t', 'theme'],
    ['?', 'help'],
    ['p', 'read-pulls'],
  ])('still takes %s away from a card, because no control uses a letter', (key, wanted) => {
    expect(action(BOARD, press(key, { onCard: false }))).toBe(wanted);
  });

  it('keeps moving while an arrow is held, and acts once for any other held key', () => {
    expect(action(BOARD, press('ArrowDown', { repeat: true }))).toBe('next');
    expect(action(BOARD, press('j', { repeat: true }))).toBe('next');
    expect(action(BOARD, press('m', { repeat: true }))).toBeNull();
    expect(action(BOARD, press('ArrowLeft', { shift: true, repeat: true }))).toBeNull();
  });
});

describe('chords', () => {
  const lead = (now = 0) => matchKey(BOARD, press('g'), NO_LEAD, now).state;

  it('waits after G and acts on the letter that follows', () => {
    const first = matchKey(BOARD, press('g'), NO_LEAD, 1000);

    expect(first.binding).toBeNull();
    expect(first.state.lead?.key).toBe('g');
    expect(action(BOARD, press('d'), first.state, 1000 + CHORD_MS)).toBe('go:delivery');
  });

  // The browser sends a keydown for Shift itself before the D, and a modifier alone is no key.
  it('waits on through a modifier pressed between G and its letter', () => {
    const shift = matchKey(BOARD, press('Shift', { shift: true }), lead(1000), 1100);

    expect(shift.binding).toBeNull();
    expect(action(BOARD, press('D', { shift: true }), shift.state, 1200)).toBe('go:delivery');
    expect(matchKey(BOARD, press('Meta', { mod: true }), lead(1000), 1100).state.lead?.key).toBe('g');
  });

  it.each([
    ['n', 'go:now'],
    ['d', 'go:delivery'],
    ['e', 'go:epics'],
    ['r', 'go:research'],
    ['k', 'go:knowledge'],
    ['u', 'go:prreview'],
    ['w', 'go:workspace'],
  ])('goes with G then %s to %s', (key, wanted) => {
    expect(action(BOARD, press(key), lead(), 10)).toBe(wanted);
  });

  // Scout and Evidence come in a later version, so their keys wait with them. `coming-soon.test.ts`
  // turns the switch on and finds them again.
  it.each(['s', 'v'])('has no key at G then %s while Scout and Evidence wait', (key) => {
    expect(action(BOARD, press(key), lead(), 10)).toBeNull();
  });

  // N alone adds a card on a board, and G then N is Now.
  it('reads N after G as the chord and not as Add card', () => {
    expect(action(BOARD, press('n'), lead(), 10)).toBe('go:now');
    expect(action(BOARD, press('n'), NO_LEAD, 10)).toBe('add');
  });

  // K alone is the previous card, and G then K is Knowledge.
  it('reads K after G as the chord and not as the previous card', () => {
    expect(action(BOARD, press('k'), lead(), 10)).toBe('go:knowledge');
    expect(action(BOARD, press('k'))).toBe('previous');
  });

  it('forgets G once the timeout has passed', () => {
    expect(action(BOARD, press('d'), lead(0), CHORD_MS + 1)).toBeNull();
    // K is a key of its own, so it acts as itself once G is forgotten.
    expect(action(BOARD, press('k'), lead(0), CHORD_MS + 1)).toBe('previous');
  });

  it('ends the chord on a key that does not finish it, and reads that key as itself', () => {
    const after = matchKey(BOARD, press('j'), lead(), 10);

    expect(after.binding?.action).toBe('next');
    expect(after.state).toEqual(NO_LEAD);
  });

  it('starts a new chord on a second G', () => {
    const again = matchKey(BOARD, press('g'), lead(0), 10);

    expect(again.binding).toBeNull();
    expect(action(BOARD, press('e'), again.state, 20)).toBe('go:epics');
  });

  it('drops G when a field takes the next key', () => {
    const typed = matchKey(BOARD, press('d', { typing: true }), lead(), 10);

    expect(typed.binding).toBeNull();
    expect(typed.state).toEqual(NO_LEAD);
  });

  it('acts on nothing for D alone', () => {
    expect(action(BOARD, press('d'))).toBeNull();
  });
});

describe('scope', () => {
  it('gives a screen only its own keys and the global ones', () => {
    expect(action(CARD, press('n'))).toBeNull();
    expect(action(CARD, press('w'))).toBeNull();
    expect(action(CARD, press('Enter'))).toBeNull();
    expect(action(BOARD, press('1'))).toBeNull();
    expect(action(CARD, press('t'))).toBe('theme');
    expect(action(CARD, press('Escape'))).toBe('back');
  });

  // The head's K and J: the card before and after this one in the board's order.
  it('gives the card page K and J for the previous and next card', () => {
    expect(action(CARD, press('k'))).toBe('previous');
    expect(action(CARD, press('j'))).toBe('next');
    expect(action(CARD, press('ArrowDown'))).toBeNull();
  });

  // A focused control on the card page sits beside the person's own unsent text, such as a commit
  // message, and leaving the page would lose it.
  it('leaves Esc to a focused control on the card page', () => {
    expect(action(CARD, press('Escape', { onCard: false }))).toBeNull();
  });

  it('reads the card page keys wherever focus is, short of a field', () => {
    expect(action(CARD, press('r', { onCard: false }))).toBe('retry');
    expect(action(CARD, press('m', { onCard: false }))).toBe('minimize');
    expect(action(CARD, press('.', { mod: true, onCard: false }))).toBe('stop');
  });

  it('gives a page with no keys of its own the global ones alone', () => {
    const global = scoped('global');

    expect(global.every((one) => one.scope === 'global')).toBe(true);
    expect(action(global, press('n'))).toBeNull();
    expect(action(global, press('t'))).toBe('theme');
  });

  // The help lists what the handler acts on, so a key's scope is the screen its action lives on.
  // Knowledge's / puts the focus in Search knowledge.
  it('marks each key with one of the five scopes', () => {
    expect(new Set(KEYS.map((one) => one.scope))).toEqual(new Set(['global', 'board', 'card', 'knowledge']));
    expect(scoped('knowledge')).toEqual([expect.objectContaining({ action: 'find', keys: [[{ key: '/' }]], label: 'Search knowledge' })]);
  });
});

describe('the card page tabs', () => {
  // The number keys count the tabs that are shown, so a tab added later takes the next key.
  it('numbers the tabs shown, from 1', () => {
    expect(action(CARD, press('1'))).toBe('tab:overview');
    expect(action(CARD, press('4'))).toBe('tab:discussion');
    expect(action(CARD, press('6'))).toBe('tab:settings');
    expect(action(CARD, press('7'))).toBeNull();
    expect(action(CARD, press('0'))).toBeNull();
  });

  it('counts an epic, which has no Changes tab, with one key less', () => {
    const epic = [...scoped('global'), ...scoped('card'), ...tabKeys(EPIC_TABS)];

    expect(action(epic, press('5'))).toBe('tab:settings');
    expect(action(epic, press('6'))).toBeNull();
  });

  it('labels each tab key with the tab name, and stops at 9', () => {
    const many = Array.from({ length: 11 }, (_, index) => ({ id: `t${index}`, label: `Tab ${index}` }));

    expect(tabKeys(DELIVERY_TABS).map((one) => one.label)).toEqual(DELIVERY_TABS.map((tab) => tab.label));
    expect(tabKeys(many)).toHaveLength(9);
  });

  it('leaves a digit with Cmd or Ctrl to the browser, which uses it for its own tabs', () => {
    expect(action(CARD, press('1', { mod: true }))).toBeNull();
  });
});

describe('no key twice', () => {
  const same = (a: readonly Stroke[], b: readonly Stroke[]) => JSON.stringify(a.map(normal)) === JSON.stringify(b.map(normal));
  const normal = (stroke: Stroke) => ({ key: stroke.key.length === 1 ? stroke.key.toLowerCase() : stroke.key, shift: stroke.shift === true, mod: stroke.mod === true });

  it.each([
    ['the board', BOARD],
    ['the card page', CARD],
    ['any other page', scoped('global')],
  ])('gives every key on %s one action', (_, keys) => {
    const combos = keys.flatMap((one) => one.keys.map((combo) => ({ action: one.action, combo })));
    for (const [index, one] of combos.entries()) {
      for (const other of combos.slice(index + 1)) expect(same(one.combo, other.combo), `${one.action} and ${other.action}`).toBe(false);
    }
  });

  // A single key that also starts a chord could never act, because the handler waits for the
  // second key.
  it.each([
    ['the board', BOARD],
    ['the card page', CARD],
  ])('has no key on %s that is also the first key of a chord', (_, keys) => {
    const leads = keys.flatMap((one) => one.keys.filter((combo) => combo.length === 2).map((combo) => combo[0]!));
    const singles = keys.flatMap((one) => one.keys.filter((combo) => combo.length === 1).map((combo) => combo[0]!));
    for (const lead of leads) expect(singles.some((single) => same([single], [lead]))).toBe(false);
  });

  it('binds each action once per scope', () => {
    for (const scope of ['global', 'board', 'card', 'knowledge'] as const) {
      const actions = scoped(scope).map((one) => one.action);
      expect(new Set(actions).size).toBe(actions.length);
    }
  });
});

describe('the help', () => {
  const bound = (...names: string[]) => Object.fromEntries(names.map((name) => [name, () => undefined]));

  it('keeps only the keys a screen binds an action to', () => {
    const live = liveKeys(BOARD, bound('add', 'help', 'go:knowledge'));

    expect(live.map((one) => one.action)).toEqual(['help', 'go:knowledge', 'add']);
  });

  it('lists exactly the live keys, each once, in its sections', () => {
    const live = liveKeys(BOARD, bound(...BOARD.map((one) => one.action)));
    const sections = helpSections(live);
    const listed = sections.flat().flatMap((section) => section.keys);

    expect(listed).toHaveLength(live.length);
    expect(new Set(listed)).toEqual(new Set(live));
    expect(sections.map((column) => column.map((section) => section.title))).toEqual([['Move around', 'Board'], ['Cards'], ['Go to']]);
  });

  it('drops a section and a column with no live key', () => {
    const sections = helpSections(liveKeys(CARD, bound('help', 'theme', 'tab:overview', 'tab:files')));

    expect(sections.map((column) => column.map((section) => section.title))).toEqual([['Move around'], ['Card page tabs']]);
    expect(sections[1]![0]!.keys.map((one) => one.label)).toEqual(['Overview', 'Files']);
  });

  it('notes the chord on the Go to section and the count on the tabs', () => {
    const sections = helpSections(liveKeys(CARD, bound('go:knowledge', 'tab:overview'))).flat();

    expect(sections.find((section) => section.group === 'go')?.note).toBe('G, then a letter');
    expect(sections.find((section) => section.group === 'tabs')?.note).toBe('Numbers count the tabs shown. Epics and Research cards have no Changes tab.');
  });

  // A board's help lists the card page tabs too, where no tab key is live.
  it("adds the card page tabs to a board's help, and keeps the card page's own", () => {
    const board = helpSections(liveKeys(BOARD, bound('help', 'go:knowledge', 'add')), true);
    const tabs = board.flat().find((section) => section.group === 'tabs');

    expect(board.map((column) => column.map((section) => section.title))).toEqual([['Move around'], ['Cards'], ['Go to', 'Card page tabs']]);
    expect(tabs?.keys.map((one) => [one.label, one.keys[0]![0]!.key])).toEqual([
      ['Overview', '1'],
      ['Files', '2'],
      ['Changes', '3'],
      ['Discussion', '4'],
      ['PRs', '5'],
      ['Log', '6'],
      ['Settings', '7'],
    ]);
    const card = helpSections(liveKeys(CARD, bound('tab:overview', 'tab:files')), true).flat();
    expect(card.find((section) => section.group === 'tabs')?.keys.map((one) => one.label)).toEqual(['Overview', 'Files']);
  });

  it('lists the filter box and the Board or list switch in the Board section', () => {
    const board = helpSections(liveKeys(BOARD, bound('filter', 'find', 'view', 'promote')))[0]!.find((section) => section.group === 'board');

    expect(board?.keys.map((one) => [one.label, one.keys[0]![0]!.key])).toEqual([
      ['Only the cards waiting on you', 'w'],
      ['Filter cards', '/'],
      ['Board or list', 'b'],
      ['Move a queued card to the front', 'ArrowUp'],
    ]);
    expect(capsOf([{ key: '/' }])).toEqual({ strokes: [['/']], said: 'slash' });
    expect(action(BOARD, press('/'))).toBe('find');
    expect(action(BOARD, press('B'))).toBe('view');
  });

  // Shift and the right arrow move a card forward, which starts the run of the next column, as a drop does.
  it('marks move forward and retry as the keys that start a run', () => {
    expect(KEYS.filter((one) => one.starts === true).map((one) => one.action)).toEqual(['move-forward', 'retry', 'retry']);
  });

  it('draws the caps as the help draws them, and says them in words', () => {
    expect(capsOf([{ key: ',', mod: true }])).toEqual({ strokes: [['⌘', ',']], said: 'Command comma' });
    expect(capsOf([{ key: 'ArrowUp', shift: true }])).toEqual({ strokes: [['⇧', '↑']], said: 'Shift Up arrow' });
    expect(capsOf([{ key: 'g' }, { key: 'd' }])).toEqual({ strokes: [['G'], ['D']], said: 'G then D' });
    expect(capsOf([{ key: 'Enter' }])).toEqual({ strokes: [['↵']], said: 'Enter' });
    expect(capsOf([{ key: 'Escape' }])).toEqual({ strokes: [['Esc']], said: 'Escape' });
    expect(capsOf([{ key: '?' }])).toEqual({ strokes: [['?']], said: 'question mark' });
  });

  it('draws the board key row in a fixed order, only with live keys', () => {
    const live = liveKeys(BOARD, bound('open', 'move-back', 'add', 'help'));

    expect(hintsOf(live).map((one) => [one.label, one.binding.action])).toEqual([['move back', 'move-back']]);
    expect(hintsOf(liveKeys(BOARD, bound('add')))).toEqual([]);
  });
});

// The board key row opens with ⇧→ move forward, then ⇧← move back.
it('draws move forward first in the board key row', () => {
  const live = liveKeys(BOARD, Object.fromEntries(['open', 'move-back', 'move-forward', 'answer'].map((name) => [name, () => undefined])));

  expect(hintsOf(live).map((one) => one.label)).toEqual(['move forward', 'move back', 'answer']);
  expect(hintsOf(live)[0]?.binding.keys).toEqual([[{ key: 'ArrowRight', shift: true }]]);
});

// Enter peeks on the board, as Space does, so the key row names it only on the open sheet, where it opens the card page.
it('draws no open in the board key row, and Enter as a peek first in the help', () => {
  const live = liveKeys(BOARD, Object.fromEntries(['open', 'move-back', 'answer'].map((name) => [name, () => undefined])));

  expect(hintsOf(live).map((one) => one.label)).toEqual(['move back', 'answer']);
  expect(KEYS.find((one) => one.action === 'open')?.label).toBe('Open the card (peek first on a board), or double-click it');
});

describe('readPress', () => {
  const body = { tagName: 'BODY', isContentEditable: false, matches: () => false };
  const page = (open = false) => ({ body, querySelector: (selector: string) => (open && selector === 'dialog[open]' ? {} : null) }) as never;
  const element = (tagName: string, over: Record<string, unknown> = {}) => ({ tagName, isContentEditable: false, matches: () => false, ...over });
  const event = (target: unknown, over: Record<string, unknown> = {}) =>
    ({ key: 'n', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false, target, ...over }) as never;

  it.each(['INPUT', 'TEXTAREA', 'SELECT'])('counts focus in %s as typing', (tagName) => {
    expect(readPress(event(element(tagName)), page()).typing).toBe(true);
  });

  it('counts an editable element and a word an input method is composing as typing', () => {
    expect(readPress(event(element('DIV', { isContentEditable: true })), page()).typing).toBe(true);
    expect(readPress(event(body, { isComposing: true }), page()).typing).toBe(true);
    expect(readPress(event(element('BUTTON')), page()).typing).toBe(false);
  });

  it('counts the body, no target and a card as being on a card, and a button as not', () => {
    expect(readPress(event(body), page()).onCard).toBe(true);
    expect(readPress(event(null), page()).onCard).toBe(true);
    expect(readPress(event(element('ARTICLE', { matches: (selector: string) => selector === 'article[data-card]' })), page()).onCard).toBe(true);
    expect(readPress(event(element('BUTTON')), page()).onCard).toBe(false);
  });

  it('reads an open dialog off the page, wherever focus has fallen', () => {
    expect(readPress(event(body), page(true)).dialog).toBe(true);
    expect(readPress(event(body), page(false)).dialog).toBe(false);
  });

  it('reads Cmd and Ctrl as one modifier, and Alt and Shift apart', () => {
    expect(readPress(event(body, { metaKey: true }), page()).mod).toBe(true);
    expect(readPress(event(body, { ctrlKey: true }), page()).mod).toBe(true);
    expect(readPress(event(body, { altKey: true }), page())).toMatchObject({ mod: false, alt: true });
    expect(readPress(event(body, { shiftKey: true, repeat: true }), page())).toMatchObject({ shift: true, repeat: true });
  });
});

// The rail has the project selector on every plan, so G then P opens it on every page. P alone stays
// the board's read of pull requests.
describe('the project selector key', () => {
  it('goes with G then P to the selector, and keeps P alone for the pull requests', () => {
    const lead = matchKey(BOARD, press('g'), NO_LEAD, 0).state;

    expect(action(BOARD, press('p'), lead, 10)).toBe('go:project');
    expect(action(BOARD, press('p'))).toBe('read-pulls');
    expect(scoped('global').find((one) => one.action === 'go:project')?.group).toBe('go');
  });
});

// The bell's panel is not a place, so it opens over the page as the project selector does, on a
// G chord. B alone stays the board's Board or list, and a key typed in a field opens nothing.
describe('the notifications key', () => {
  it('opens the notifications with G then B on every page, and never while typing', () => {
    const lead = matchKey(BOARD, press('g'), NO_LEAD, 0).state;

    expect(action(BOARD, press('b'), lead, 10)).toBe('go:notifications');
    expect(action(CARD, press('b'), matchKey(CARD, press('g'), NO_LEAD, 0).state, 10)).toBe('go:notifications');
    expect(action(BOARD, press('b'))).toBe('view');
    expect(action(BOARD, press('g', { typing: true }))).toBeNull();
    expect(scoped('global').find((one) => one.action === 'go:notifications')).toMatchObject({ label: 'Notifications', group: 'go' });
  });
});

// The PR reviews board has R for Read pull requests, C for copy findings and G for open on GitHub.
// Those three are retry, copy the key and the chord lead in this list, so the board takes its keys from
// the keyboard help instead, where Read pull requests is P.
describe('the PR reviews board keys', () => {
  it('reads pull requests on P, and leaves R, C and G to retry, copy the key and the chords', () => {
    expect(action(BOARD, press('p'))).toBe('read-pulls');
    expect(action(BOARD, press('r'))).toBe('retry');
    expect(action(BOARD, press('c'))).toBe('copy');
    expect(matchKey(BOARD, press('g'), NO_LEAD, 0).binding).toBeNull();
    expect(KEYS.filter((one) => one.action === 'read-pulls').flatMap((one) => one.keys)).toEqual([[{ key: 'p' }]]);
  });

  it('binds no action of its own for copying findings or opening GitHub', () => {
    expect(KEYS.some((one) => /finding|github/i.test(one.label))).toBe(false);
  });
});

// Cmd K on a Mac and Ctrl K elsewhere open the palette on every page with the rail. K alone stays the
// previous card, and G then K stays Knowledge.
describe('the palette key', () => {
  it('opens the palette on Cmd K or Ctrl K, and leaves K and G then K as they were', () => {
    expect(action(BOARD, press('k', { mod: true }))).toBe('palette');
    expect(action(CARD, press('K', { mod: true, shift: true }))).toBe('palette');
    expect(action(BOARD, press('k'))).toBe('previous');
    const lead = matchKey(BOARD, press('g'), NO_LEAD, 0).state;
    expect(action(BOARD, press('k'), lead, 10)).toBe('go:knowledge');
  });

  // Over a text field too, because the palette gives focus back to it and the browser would take the
  // key otherwise. K alone stays the field's. The palette is a dialog, and so is any other the page has
  // open, and neither lets a key reach the page.
  it('opens over a text field, and does nothing while a dialog is open', () => {
    expect(action(BOARD, press('k', { mod: true, typing: true }))).toBe('palette');
    expect(action(BOARD, press('k', { typing: true }))).toBeNull();
    expect(action(BOARD, press('k', { mod: true, typing: true, repeat: true }))).toBeNull();
    expect(action(BOARD, press('k', { mod: true, dialog: true }))).toBeNull();
    expect(action(BOARD, press('k', { mod: true, typing: true, dialog: true }))).toBeNull();
  });

  // Where the help lists it: after the column keys, in Move around.
  it('is listed in Move around after the column keys, with its caps and words', () => {
    const live = liveKeys(BOARD, Object.fromEntries(['left', 'back', 'palette', 'help'].map((name) => [name, () => undefined])));
    const move = helpSections(live)[0]![0]!;

    expect(move.title).toBe('Move around');
    expect(move.keys.map((one) => one.action)).toEqual(['left', 'palette', 'back', 'help']);
    expect(move.keys[1]?.label).toBe('Search or run a command');
    expect(capsOf(move.keys[1]!.keys[0]!)).toEqual({ strokes: [['⌘', 'K']], said: 'Command K' });
  });
});

// Space peeks at the chosen card, from the board and from Now, and the help names it so.
describe('peek', () => {
  const bound = (...names: string[]) => Object.fromEntries(names.map((name) => [name, () => undefined]));

  it('reads Space on a card as peek, and leaves it to a focused control', () => {
    expect(action(BOARD, press(' '))).toBe('peek');
    expect(action(BOARD, press(' ', { onCard: false }))).toBeNull();
    expect(capsOf([{ key: ' ' }])).toEqual({ strokes: [['Space']], said: 'Space' });
    expect(KEYS.find((one) => one.action === 'peek')?.label).toBe('Peek, without leaving the board');
  });

  // Esc is one step back at a time, and the open sheet is the first step.
  it('names the peek as the first step back of Esc', () => {
    expect(KEYS.find((one) => one.action === 'back' && one.scope === 'board')?.label).toBe('Back, or close what is open');
  });

  it('draws peek in the board key row after move back, and the peek row while the sheet is open', () => {
    const live = liveKeys(BOARD, bound('move-forward', 'move-back', 'peek', 'open', 'answer', 'next'));

    expect(hintsOf(live).map((one) => one.label)).toEqual(['move forward', 'move back', 'or click peek', 'answer']);
    expect(hintsOf(live, true).map((one) => [one.label, one.binding.keys.map((combo) => combo[0]?.key)])).toEqual([
      ['close peek', [' ']],
      ['next card, the sheet follows', ['j', 'k']],
      ['open', ['Enter']],
    ]);
    // Two caps side by side, with no "or" between.
    expect(hintsOf(live, true).map((one) => one.bare ?? false)).toEqual([false, true, false]);
  });
});
