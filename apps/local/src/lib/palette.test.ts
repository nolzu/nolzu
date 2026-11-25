import type { BoardSnapshot, CardView } from '@nolzu/protocol';
import { liveKeys, scoped, tabKeys } from '@nolzu/ui';
import { boardFixture, cardFixture } from '@nolzu/ui/fixture';
import { describe, expect, it, vi } from 'vitest';
import { type Hrefs, type PaletteRow, paletteRows, rankRows } from './palette.ts';
import { ICONS } from './rail.ts';

// Scout and Evidence are off as shipped. These tests pin how they work once the switch is on again, and
// coming-soon.test.ts pins the off state.
vi.mock('@nolzu/protocol', async (actual) => ({ ...(await actual<typeof import('@nolzu/protocol')>()), CLOUD_OPEN: true, SCOUT_AND_EVIDENCE: true }));

const hrefs: Hrefs = {
  board: (kind) => `/b/${kind}`,
  card: (key) => `/t/${key}`,
  cardTab: (key, tab) => `/t/${key}/${tab}`,
  section: (id) => `/settings/${id}`,
  addCard: '/?add',
};

// The keys a board page hands the handler, with an action for each name.
const bound = (...names: string[]) => liveKeys([...scoped('global'), ...scoped('board')], Object.fromEntries(names.map((name) => [name, () => undefined])));
const GLOBAL = ['settings', 'theme', 'go:now', 'go:delivery', 'go:epics', 'go:research', 'go:prreview', 'go:workspace', 'go:knowledge', 'go:scout', 'go:evidence', 'palette', 'help'];

const rows = (over: { live?: ReturnType<typeof bound>; boards?: BoardSnapshot[]; off?: Parameters<typeof paletteRows>[2] } = {}) =>
  paletteRows(over.live ?? bound(...GLOBAL), over.boards ?? [], over.off ?? [], hrefs);
const byId = (list: readonly PaletteRow[], id: string) => list.find((row) => row.id === id);
const shown = (groups: ReturnType<typeof rankRows>) => groups.map((group) => [group.head, group.rows.map((row) => row.label)]);

describe('the rows', () => {
  // A key and its row share one action, so the row runs what the key runs and shows the key.
  it('gives each live key that needs no selected card a row that runs its action and shows its key', () => {
    const list = rows({ live: bound(...GLOBAL, 'add', 'filter', 'next', 'open', 'move-forward', 'retry') });

    expect(byId(list, 'key:go:now')).toMatchObject({ group: 'Go to', label: 'Now', keys: [{ key: 'g' }, { key: 'n' }], run: { kind: 'action', action: 'go:now' } });
    expect(byId(list, 'key:settings')).toMatchObject({ group: 'Go to', label: 'Settings', keys: [{ key: ',', mod: true }], run: { kind: 'action', action: 'settings' } });
    expect(byId(list, 'key:theme')).toMatchObject({ group: 'Actions', label: 'Light or dark theme', keys: [{ key: 't' }], run: { kind: 'action', action: 'theme' } });
    expect(byId(list, 'key:add')).toMatchObject({ group: 'Actions', label: 'Add card', keys: [{ key: 'n' }], run: { kind: 'action', action: 'add' } });
    expect(byId(list, 'key:filter')?.run).toEqual({ kind: 'action', action: 'filter' });
    // A key for the selected card, the help and the palette itself have no row.
    for (const action of ['next', 'open', 'move-forward', 'retry', 'help', 'palette']) expect(byId(list, `key:${action}`), action).toBeUndefined();
  });

  // Where N adds a card the row is the key's. Anywhere else it opens Add card on Now, and shows no key.
  it('adds a card from every screen, through N where the screen binds it and on Now elsewhere', () => {
    const elsewhere = rows();
    expect(byId(elsewhere, 'key:add')).toBeUndefined();
    expect(byId(elsewhere, 'add')).toEqual({ id: 'add', group: 'Actions', label: 'Add card', icon: expect.any(Array), beside: true, run: { kind: 'go', href: '/?add' } });

    const board = rows({ live: bound(...GLOBAL, 'add') });
    expect(byId(board, 'add')).toBeUndefined();
    expect(byId(board, 'key:add')?.run).toEqual({ kind: 'action', action: 'add' });
  });

  it('gives the card page tab keys their own group', () => {
    const tabs = tabKeys([
      { id: 'overview', label: 'Overview' },
      { id: 'files', label: 'Files' },
    ]);
    const list = paletteRows(liveKeys([...scoped('global'), ...scoped('card'), ...tabs], { 'tab:files': () => undefined, minimize: () => undefined }), [], [], hrefs);

    expect(byId(list, 'key:tab:files')).toMatchObject({ group: 'Card page tabs', label: 'Files', keys: [{ key: '2' }] });
    expect(byId(list, 'key:minimize')).toMatchObject({ group: 'Actions', label: 'Minimize' });
  });

  it('goes to every screen the rail links, through its G chord, and to each settings page', () => {
    const list = rows();
    const go = list.filter((row) => row.group === 'Go to').map((row) => [row.label, row.run.kind === 'go' ? row.run.href : row.run.kind]);

    // Research is one row, through G then R, where Investigations and Questions stood.
    expect(go).toEqual([
      ['Now', 'action'],
      ['Delivery', 'action'],
      ['Epics', 'action'],
      ['Research', 'action'],
      ['PR reviews', 'action'],
      ['Workspace', 'action'],
      ['Knowledge', 'action'],
      ['Scout', 'action'],
      ['Evidence', 'action'],
      ['Settings', 'action'],
    ]);
    // Each screen has its own icon, as in the rail, and not the chevron a row with none falls back to.
    for (const row of list.filter((one) => one.group === 'Go to')) expect(row.icon, row.label).not.toBe(ICONS.chevron);
    expect(list.filter((row) => row.group === 'Settings').map((row) => [row.label, row.run.kind === 'go' ? row.run.href : row.run.kind])).toEqual([
      ['Settings, Project', '/settings/project'],
      ['Settings, Engines', '/settings/engines'],
      ['Settings, Models', '/settings/models'],
      ['Settings, Phase instructions', '/settings/phases'],
      ['Settings, MCP servers', '/settings/mcp'],
      ['Settings, Runs', '/settings/runs'],
      ['Settings, Integrations', '/settings/integrations'],
      ['Settings, Wall', '/settings/wall'],
      ['Settings, Cloud', '/settings/cloud'],
    ]);
  });

  // The layout binds G then E only while Epics is on, so a board that is off has no row either way.
  it('has no row for a board that is off', () => {
    const list = rows({ live: bound(...GLOBAL.filter((name) => name !== 'go:epics')), off: ['epics'] });

    expect(list.some((row) => row.label === 'Epics')).toBe(false);
  });

  it('offers the project selector only while G then P opens it', () => {
    expect(byId(rows(), 'key:go:project')).toBeUndefined();
    expect(byId(rows({ live: bound(...GLOBAL, 'go:project') }), 'key:go:project')).toMatchObject({ group: 'Go to', label: 'Project selector' });
  });

  // The row runs the Scout page's Check all sources, through the action the layout registers.
  it('checks every Scout source through the Scout page', () => {
    expect(byId(rows(), 'scout-check')).toMatchObject({ group: 'Actions', label: 'Check every Scout source now', run: { kind: 'action', action: 'scout:check' } });
  });
});

describe('the rows of a card', () => {
  const one = (card: CardView, board = boardFixture('pull-request', [card])) => rows({ boards: [board] }).filter((row) => row.card === card.key);

  it('moves the card one column on with the Starts line of a drop, opens it, and opens its settings', () => {
    const list = one(cardFixture({ key: 'APP-1', stage: 'inbox' }));

    expect(list.map((row) => row.id)).toEqual(['move:APP-1:refine', 'open:APP-1', 'model:APP-1']);
    expect(new Set(list.map((row) => row.group))).toEqual(new Set(['APP-1 · Add a search box to the recipe list']));
    expect(list[0]).toMatchObject({ label: 'Move to Refine', hint: 'starts Claude Code · haiku · low', starts: true, run: { kind: 'move', key: 'APP-1', to: 'refine', refused: null } });
    expect(list[1]).toMatchObject({ label: 'Open the card', keys: [{ key: 'Enter', mod: true }], run: { kind: 'go', href: '/t/APP-1' } });
    expect(list[2]).toMatchObject({ label: 'Use another model for this card', run: { kind: 'go', href: '/t/APP-1/settings' } });
  });

  // A figure only where runs measured one.
  it('adds the estimate to the Starts line only where one was measured', () => {
    const board = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);
    const estimate = { costUsd: 0.048, lowMs: 18_000, highMs: 24_000, from: 'preset' as const, runs: 0 };
    const measured = { ...board, stages: board.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, estimate } } : stage)) };

    expect(one(cardFixture({ key: 'APP-1', stage: 'inbox' }), measured)[0]?.hint).toBe('starts Claude Code · haiku · low · about $0.05 · under a minute');
    expect(one(cardFixture({ key: 'APP-1', stage: 'inbox' }))[0]?.hint).not.toContain('$');
  });

  it('moves into a column that starts nothing with no amber mark', () => {
    expect(one(cardFixture({ key: 'APP-5', stage: 'qa', state: 'ready' }))[0]).toMatchObject({ label: 'Move to Review', hint: 'starts nothing', starts: false, run: { kind: 'move', to: 'review', refused: null } });
  });

  // The refusal and the link are the ones a refused drop raises, so the toast names the same fix.
  it('carries the refusal of a start the drop would refuse, with the setting that fixes it', () => {
    const board = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);
    const gone = { ...board, stages: board.stages.map((stage) => (stage.id === 'refine' ? { ...stage, starts: { ...stage.starts!, model: 'sonnet-4-5', modelState: 'gone' as const } } : stage)) };
    const move = one(cardFixture({ key: 'APP-1', stage: 'inbox' }), gone)[0];

    expect(move).toMatchObject({ label: 'Move to Refine', starts: false, hint: 'sonnet-4-5 is gone. Pick another model in the card settings, or in Settings, Models.' });
    expect(move?.run).toEqual({
      kind: 'move',
      key: 'APP-1',
      to: 'refine',
      refused: {
        refusal: { message: 'Refine uses sonnet-4-5, which Claude Code no longer offers.', fix: 'Pick another in the card settings, or in Settings, Models.', stage: 'Refine', code: 'sonnet-4-5', act: 'Pick another' },
        link: { label: 'Open Settings, Models', href: '/settings/models' },
      },
    });
  });

  it('offers no move to a card that cannot go on, and still opens it', () => {
    expect(one(cardFixture({ key: 'APP-2', stage: 'plan', state: 'running' })).map((row) => row.id)).toEqual(['open:APP-2', 'model:APP-2']);
    expect(one(cardFixture({ key: 'APP-9', stage: 'closed', state: 'idle' })).map((row) => row.id)).toEqual(['open:APP-9', 'model:APP-9']);
  });

  // A board that only grows its Closed column must not bury the open cards under old ones.
  it('lists the cards of every board that is on, closed cards last', () => {
    const epics = { ...boardFixture('pull-request', [cardFixture({ key: 'APP-7', stage: 'inbox' })]), kind: 'epics' as const };
    const delivery = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'closed' }), cardFixture({ key: 'APP-2', stage: 'inbox' })]);
    const cards = [...new Set(rows({ boards: [delivery, epics] }).flatMap((row) => (row.card === undefined ? [] : [row.card])))];

    expect(cards).toEqual(['APP-2', 'APP-7', 'APP-1']);
  });
});

// A card query still lists Now, the card's board, Add card and the Scout check.
describe('the rows beside a card', () => {
  it('marks Now, Add card and the Scout check for every card, and each board for its own cards', () => {
    const list = rows({ boards: [boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })])] });

    expect(byId(list, 'key:go:now')?.beside).toBe(true);
    expect(byId(list, 'add')?.beside).toBe(true);
    expect(byId(list, 'scout-check')?.beside).toBe(true);
    expect(byId(list, 'key:go:delivery')?.beside).toBe('delivery');
    expect(byId(list, 'key:go:research')?.beside).toBe('research');
    expect(byId(list, 'key:go:prreview')?.beside).toBe('prreview');
    expect(byId(list, 'key:go:knowledge')?.beside).toBeUndefined();
    expect(byId(list, 'key:theme')?.beside).toBeUndefined();
    expect(byId(list, 'open:APP-1')?.board).toBe('delivery');
    // Where N adds a card, its key's row is the one beside the card.
    expect(byId(rows({ live: bound(...GLOBAL, 'add') }), 'key:add')?.beside).toBe(true);
  });

  it('shows them after the card a search names', () => {
    const delivery = boardFixture('pull-request', [cardFixture({ key: 'APP-1', stage: 'inbox' })]);
    const epics = { ...boardFixture('pull-request', [cardFixture({ key: 'APP-7', title: 'Plan the meal week', stage: 'inbox' })]), kind: 'epics' as const };

    expect(shown(rankRows(rows({ boards: [delivery, epics] }), 'move app-1'))).toEqual([
      ['APP-1 · Add a search box to the recipe list', ['Move to Refine', 'Open the card', 'Use another model for this card']],
      ['Go to', ['Now', 'Delivery']],
      ['Actions', ['Add card', 'Check every Scout source now']],
    ]);
    expect(shown(rankRows(rows({ boards: [delivery, epics] }), 'app-7')).slice(1)).toEqual([
      ['Go to', ['Now', 'Epics']],
      ['Actions', ['Add card', 'Check every Scout source now']],
    ]);
  });

  // With no card named, the search filters them like any other row.
  it('leaves them to the filter when no card is named', () => {
    expect(shown(rankRows(rows(), 'scout')).map(([head]) => head)).toEqual(['Go to', 'Actions']);
    expect(rankRows(rows(), 'move')).toEqual([]);
  });
});

describe('the filter and the ranking', () => {
  const row = (id: string, group: string, label: string, more: Partial<PaletteRow> = {}): PaletteRow => ({ id, group, label, icon: [], run: { kind: 'go', href: `/${id}` }, ...more });
  const card = (key: string, title: string, label: string) => row(`${label}:${key}`, `${key} · ${title}`, label, { card: key });
  const LIST = [
    card('APP-15', 'Remember the last search', 'Move to Refine'),
    card('APP-15', 'Remember the last search', 'Open the card'),
    card('APP-15', 'Remember the last search', 'Use another model for this card'),
    card('APP-16', 'Show what to cook now', 'Open the card'),
    row('now', 'Go to', 'Now'),
    row('delivery', 'Go to', 'Delivery', { words: 'board' }),
    row('knowledge', 'Go to', 'Knowledge'),
    row('models', 'Go to', 'Settings, Models'),
    row('add', 'Actions', 'Add card'),
    row('notes', 'Actions', 'Add a note to now'),
  ];

  it('lists every row but the cards in the order given, while the search is empty', () => {
    expect(shown(rankRows(LIST, ''))).toEqual([
      ['Go to', ['Now', 'Delivery', 'Knowledge', 'Settings, Models']],
      ['Actions', ['Add card', 'Add a note to now']],
    ]);
    expect(rankRows(LIST, '   ')).toEqual(rankRows(LIST, ''));
  });

  // The card the search names, its move first.
  it('shows every row of the card the search names, the best match first', () => {
    expect(shown(rankRows(LIST, 'move app-15'))).toEqual([['APP-15 · Remember the last search', ['Move to Refine', 'Open the card', 'Use another model for this card']]]);
  });

  // A long board would bury the screens under one Open row per card.
  it('shows a card only when a word names it by its key or its title', () => {
    expect(rankRows(LIST, 'open')).toEqual([]);
    expect(shown(rankRows(LIST, 'search'))).toEqual([['APP-15 · Remember the last search', ['Move to Refine', 'Open the card', 'Use another model for this card']]]);
    expect(shown(rankRows(LIST, '16'))).toEqual([['APP-16 · Show what to cook now', ['Open the card']]]);
    expect(shown(rankRows(LIST, 'app')).map(([head]) => head)).toEqual(['APP-15 · Remember the last search', 'APP-16 · Show what to cook now']);
  });

  it('matches the start of a word in any case, and needs every word', () => {
    expect(shown(rankRows(LIST, 'KNO'))).toEqual([['Go to', ['Knowledge']]]);
    expect(shown(rankRows(LIST, 'settings mod'))).toEqual([['Go to', ['Settings, Models']]]);
    expect(shown(rankRows(LIST, 'delivery board'))).toEqual([['Go to', ['Delivery']]]);
    expect(rankRows(LIST, 'nowl')).toEqual([]);
    expect(rankRows(LIST, 'owledge')).toEqual([]);
  });

  // A whole word of the label beats the start of one, which beats a word only the title holds, and a
  // group is placed by its best row.
  it('ranks a whole word of the label over the start of one, and both over a title', () => {
    expect(shown(rankRows(LIST, 'now'))).toEqual([
      ['Go to', ['Now']],
      ['Actions', ['Add a note to now']],
      ['APP-16 · Show what to cook now', ['Open the card']],
    ]);
    expect(shown(rankRows(LIST, 'add'))).toEqual([['Actions', ['Add card', 'Add a note to now']]]);
    expect(shown(rankRows(LIST, 'no'))).toEqual([
      ['Go to', ['Now']],
      ['Actions', ['Add a note to now']],
      ['APP-16 · Show what to cook now', ['Open the card']],
    ]);
  });

  it('ranks a whole card key over the start of one', () => {
    expect(shown(rankRows(LIST, 'app-16')).map(([head]) => head)).toEqual(['APP-16 · Show what to cook now']);
    expect(shown(rankRows([...LIST.slice(3), ...LIST.slice(0, 3)], 'app-15 open'))[0]).toEqual(['APP-15 · Remember the last search', ['Open the card', 'Move to Refine', 'Use another model for this card']]);
  });

  // "app-1" starts the key APP-15 too, and APP-15 comes first in the list.
  it('puts the card whose whole key is typed above one whose key only starts with it', () => {
    const list = [card('APP-15', 'Remember the last search', 'Open the card'), card('APP-1', 'Add a search box', 'Open the card')];

    expect(shown(rankRows(list, 'app-1')).map(([head]) => head)).toEqual(['APP-1 · Add a search box', 'APP-15 · Remember the last search']);
  });
});
