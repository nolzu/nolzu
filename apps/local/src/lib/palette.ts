import { type BoardChoice, type BoardKind, type BoardSnapshot, choiceLabel, choiceOf, SCOUT_AND_EVIDENCE } from '@nolzu/protocol';
import { type Binding, dropTarget, KEYS, type Refusal, type Stroke, type ToastItem } from '@nolzu/ui';
import { fixLink, keyWrite, stageForward } from './board-page.ts';
import { ICONS, railKinds } from './rail.ts';
import { SECTIONS } from './settings-sections.ts';

// What a row of the command palette does. A key's row runs the key's own action, so the two never
// part. A move is the move a drop sends, or the refusal a refused drop raises.
export type PaletteRun =
  | { kind: 'action'; action: string }
  | { kind: 'go'; href: string }
  | { kind: 'move'; key: string; to: string; refused: { refusal: Refusal; link: NonNullable<ToastItem['link']> } | null };

export interface PaletteRow {
  id: string;
  // The head the row sits under: "Go to", "Actions", or the card's key and title.
  group: string;
  label: string;
  // Words a search finds the row by that its label and group do not hold.
  words?: string;
  // Set on the rows of a card, which show only when the search names that card.
  card?: string;
  // The board a card's rows sit on, as the rail names it.
  board?: BoardChoice;
  // A row that shows after the rows of a card the search names: true
  // beside every card, or a board beside its own cards.
  beside?: true | BoardChoice;
  icon: readonly string[];
  // A move that starts an agent run. Its mark is the one amber part of the palette.
  starts?: boolean;
  // The key that does the same, drawn as caps.
  keys?: readonly Stroke[];
  // The Starts line of a move, in the drop box's words.
  hint?: string;
  run: PaletteRun;
}

// The addresses the rows link, made by the caller, which has the router.
export interface Hrefs {
  board: (kind: BoardChoice) => string;
  card: (key: string) => string;
  cardTab: (key: string, tab: string) => string;
  section: (id: string) => string;
  // The board this tab was last on, with Add card open on arrival.
  addCard: string;
}

const GO = 'Go to';
const ACTIONS = 'Actions';

const ICON_OF: Readonly<Record<string, readonly string[]>> = {
  'go:now': ICONS.now,
  'go:delivery': ICONS.delivery,
  'go:epics': ICONS.epics,
  'go:research': ICONS.research,
  'go:prreview': ICONS.prreview,
  'go:workspace': ICONS.workspace,
  'go:knowledge': ICONS.knowledge,
  'go:scout': ICONS.scout,
  'go:evidence': ICONS.evidence,
  'go:project': ICONS.repos,
  settings: ICONS.settings,
  theme: ICONS.theme,
  add: ICONS.add,
};

const WORDS_OF: Readonly<Record<string, string>> = { 'go:delivery': 'board', 'go:epics': 'board', 'go:research': 'board questions investigations', theme: 'switch' };

// The row of a live key. Keys for the selected card act where focus is, which is in the palette's
// field, so those cards get rows of their own. The help and the palette are the keys' own.
function keyRow(binding: Binding): PaletteRow {
  const group = binding.group === 'go' || binding.action === 'settings' ? GO : binding.group === 'tabs' ? 'Card page tabs' : ACTIONS;
  const words = WORDS_OF[binding.action];
  return {
    id: `key:${binding.action}`,
    group,
    label: binding.label,
    ...(words === undefined ? {} : { words }),
    icon: ICON_OF[binding.action] ?? ICONS.chevron,
    keys: binding.keys[0] ?? [],
    run: { kind: 'action', action: binding.action },
  };
}

// The screens in the rail's order. A screen with a key goes through that key's action, and only while
// the screen binds it; one with no key links its address.
function screens(off: readonly BoardKind[], hrefs: Hrefs): ({ action: string; beside?: true | BoardChoice } | PaletteRow)[] {
  const keyed = (kind: BoardChoice) => KEYS.some((binding) => binding.action === `go:${kind}`);
  return [
    { action: 'go:now', beside: true },
    ...railKinds(off).map((kind) =>
      keyed(kind)
        ? { action: `go:${kind}`, beside: kind }
        : { id: `board:${kind}`, group: GO, label: choiceLabel(kind), words: 'board', icon: ICONS[kind], beside: kind, run: { kind: 'go' as const, href: hrefs.board(kind) } },
    ),
    { action: 'go:workspace' },
    { action: 'go:knowledge' },
    { action: 'go:scout' },
    { action: 'go:evidence' },
    { action: 'go:project' },
    { action: 'settings' },
  ];
}

// A card's own rows: the move one column on, open it, and its model settings. The move reads the
// snapshot the way a drop and Shift Right read it, so the row shows what the drop box shows.
function cardRows(board: BoardSnapshot, key: string, hrefs: Hrefs): PaletteRow[] {
  const card = board.cards.find((found) => found.key === key)!;
  const own = { group: `${card.key} · ${card.title}`, card: card.key, board: choiceOf(board.kind) };
  const stage = stageForward(board, key);
  const said = keyWrite(board, key, 'forward');
  const move: PaletteRow[] = [];
  if (stage !== null && said !== null) {
    const target = dropTarget(stage, true);
    const hint =
      target.kind === 'starts' ? `starts ${target.command}${target.estimate === undefined ? '' : ` · ${target.estimate.text}`}` : target.kind === 'nothing' ? 'starts nothing' : target.reason;
    const refused = said.kind === 'refused' ? { refusal: said.refusal, link: fixLink(board, key, said.at, { card: hrefs.cardTab(key, 'settings'), models: hrefs.section('models') }) } : null;
    // The column is in the id, so a card that moved on in the meantime is not the chosen row any more.
    move.push({ id: `move:${key}:${stage.id}`, ...own, label: `Move to ${stage.label}`, icon: target.kind === 'starts' ? ICONS.bolt : ICONS.chevron, starts: target.kind === 'starts', hint, run: { kind: 'move', key, to: stage.id, refused } });
  }
  return [
    ...move,
    { id: `open:${key}`, ...own, label: 'Open the card', icon: ICONS.arrow, keys: [{ key: 'Enter', mod: true }], run: { kind: 'go', href: hrefs.card(key) } },
    { id: `model:${key}`, ...own, label: 'Use another model for this card', words: 'settings', icon: ICONS.settings, run: { kind: 'go', href: hrefs.cardTab(key, 'settings') } },
  ];
}

/**
 * Every row the palette can show, in this order: the cards, then Go to, then Actions, then the
 * settings pages.
 *
 * `live` is what the key handler acts on, the keys of every page and of the screen on show, so a row
 * exists exactly where its key works. The cards come from the boards that are on, out of the one Now
 * stream; a board that is off is in no snapshot.
 */
export function paletteRows(live: readonly Binding[], boards: readonly BoardSnapshot[], off: readonly BoardKind[], hrefs: Hrefs): PaletteRow[] {
  // A board page and a card page each bind one scope, so an action is live once. The first one wins
  // anyway, because a row id must be unique.
  const byAction = new Map<string, Binding>();
  for (const binding of live) if (binding.onCard !== true && binding.action !== 'help' && binding.action !== 'palette' && !byAction.has(binding.action)) byAction.set(binding.action, binding);

  const go = screens(off, hrefs).flatMap((screen) => {
    if ('id' in screen) return [screen];
    const binding = byAction.get(screen.action);
    byAction.delete(screen.action);
    return binding === undefined ? [] : [{ ...keyRow(binding), ...(screen.beside === undefined ? {} : { beside: screen.beside }) }];
  });
  const cards = boards
    .flatMap((board) => {
      const archive = new Set(board.stages.filter((stage) => stage.role === 'archive').map((stage) => stage.id));
      return board.cards.map((card) => ({ board, key: card.key, closed: archive.has(card.stage) }));
    })
    .sort((a, b) => Number(a.closed) - Number(b.closed))
    .flatMap((one) => cardRows(one.board, one.key, hrefs));

  return [
    ...cards,
    ...go,
    // Where N adds no card, the row opens Add card on the last board, so a card can be added from any screen.
    ...(byAction.has('add') ? [] : [{ id: 'add', group: ACTIONS, label: 'Add card', icon: ICONS.add, beside: true as const, run: { kind: 'go' as const, href: hrefs.addCard } }]),
    ...[...byAction.values()].map((binding) => (binding.action === 'add' ? { ...keyRow(binding), beside: true as const } : keyRow(binding))),
    // The Scout page's Check all sources, which the layout's `scout:check` presses. Not while Scout waits
    // for a later version.
    ...(SCOUT_AND_EVIDENCE ? [{ id: 'scout-check', group: ACTIONS, label: 'Check every Scout source now', icon: ICONS.scout, beside: true as const, run: { kind: 'action' as const, action: 'scout:check' } }] : []),
    // Last, so an empty search shows the actions without a scroll past every settings page.
    ...SECTIONS.map((section) => ({ id: `section:${section.id}`, group: 'Settings', label: `Settings, ${section.title}`, icon: ICONS.settings, run: { kind: 'go' as const, href: hrefs.section(section.id) } })),
  ];
}

export interface PaletteGroup {
  head: string;
  rows: PaletteRow[];
}

// Words and card keys, in lower case. A key such as APP-15 is a word, and each of its parts is one
// too, so "app", "15" and "app-15" all find it.
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .flatMap((word) => (word.includes('-') ? [word, ...word.split('-')] : [word]))
    .filter((word) => word !== '');

// How well one typed word fits a row: a whole word of the label or the whole card key, the start of a
// label word, the start of any other word of the row, or not at all.
function fit(word: string, label: readonly string[], rest: readonly string[], key: string | undefined): number {
  if (label.includes(word) || word === key) return 3;
  if (label.some((one) => one.startsWith(word))) return 2;
  return rest.some((one) => one.startsWith(word)) ? 1 : 0;
}

/**
 * The rows a search shows, grouped under their heads, the best first.
 *
 * Every typed word has to start a word of the row. A card's rows show only when a word names the card,
 * by its key or its title, so a long board does not bury the screens; they then show together
 * once every word is found among them. An empty search shows every row but
 * the cards, in the order given. Groups go by their best row, rows by their own fit, and ties keep the
 * order given. A shown card brings the rows marked `beside` it along, so a card query does not hide
 * Go to and Actions.
 */
export function rankRows(rows: readonly PaletteRow[], query: string): PaletteGroup[] {
  const typed = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter((word) => word !== '');
  const scored = rows.map((row, index) => {
    const rest = wordsOf(`${row.group} ${row.words ?? ''}`);
    return { row, index, rest, fits: typed.map((word) => fit(word, wordsOf(row.label), rest, row.card?.toLowerCase())) };
  });

  const cards = new Map<string, typeof scored>();
  for (const one of scored) if (one.row.card !== undefined) cards.set(one.row.card, [...(cards.get(one.row.card) ?? []), one]);
  const cardShown = (mine: typeof scored) => {
    const named = typed.some((word) => wordsOf(mine[0]!.row.group).some((one) => one.startsWith(word)));
    return named && typed.every((_, at) => mine.some((one) => one.fits[at]! > 0));
  };

  const matched = scored.filter((one) => {
    if (one.row.card !== undefined) return typed.length > 0 && cardShown(cards.get(one.row.card)!);
    return one.fits.every((value) => value > 0);
  });
  const boards = new Set(matched.flatMap((one) => (one.row.card === undefined || one.row.board === undefined ? [] : [one.row.board])));
  const cardOn = matched.some((one) => one.row.card !== undefined);
  const shown = scored.filter((one) => matched.includes(one) || (cardOn && (one.row.beside === true || (one.row.beside !== undefined && boards.has(one.row.beside)))));

  const total = (one: (typeof scored)[number]) => one.fits.reduce((sum, value) => sum + value, 0);
  const groups = new Map<string, { head: string; best: number; first: number; rows: typeof scored }>();
  for (const one of shown) {
    const group = groups.get(one.row.group) ?? { head: one.row.group, best: 0, first: one.index, rows: [] };
    group.best = Math.max(group.best, total(one));
    group.rows.push(one);
    groups.set(one.row.group, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.best - a.best || a.first - b.first)
    .map((group) => ({ head: group.head, rows: group.rows.sort((a, b) => total(b) - total(a) || a.index - b.index).map((one) => one.row) }));
}
