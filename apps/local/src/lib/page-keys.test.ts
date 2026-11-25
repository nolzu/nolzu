import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tabsFor } from '@nolzu/core';
import { BOARD_KINDS } from '@nolzu/protocol';
import { CARD_TABS, type KeyScope, scoped, tabKeys } from '@nolzu/ui';
import { describe, expect, it } from 'vitest';
import { pageKeys } from './page-keys.svelte.ts';

// The pages cannot be mounted, because they need the running app, so their wiring is read off them.
const root = join(import.meta.dirname, '..', '..', '..', '..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const svelteFiles = (dir: string) =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.svelte'))
    .map((file) => `${dir}/${file}`);

const LAYOUT = 'apps/local/src/routes/+layout.svelte';
const BOARD = 'apps/local/src/lib/BoardPage.svelte';
const CARD = 'apps/local/src/routes/t/[key]/+layout.svelte';
const KNOWLEDGE = 'apps/local/src/routes/knowledge/+page.svelte';
// New project binds the one global key that belongs to a single screen, Make the project.
const NEW = 'apps/local/src/routes/new/+page.svelte';

describe('one key handler', () => {
  // Two handlers on one page would both act on one key, and a page with its own would miss the global
  // keys and the help.
  it('is mounted once, in the root layout, so every page has exactly one', () => {
    const mounting = svelteFiles('apps/local/src').filter((file) => /<Keyboard[\s/>]/.test(read(file)));

    expect(mounting).toEqual([LAYOUT]);
    expect(read(LAYOUT).match(/<Keyboard[\s/>]/g)).toHaveLength(1);
  });

  it('is the only window key listener in the app, beside the Esc hold of an open dialog', () => {
    const listening = [...svelteFiles('apps/local/src'), ...svelteFiles('packages/ui/src')].filter((file) => /<svelte:window[^>]*onkeydown/.test(read(file)));

    expect(listening.sort()).toEqual(['packages/ui/src/Dialog.svelte', 'packages/ui/src/Keyboard.svelte']);
  });

  // The handler gets the keys and the actions of both the global list and the screen on show. With the
  // actions alone, a board would bind its actions and no key would reach them.
  it('hands the handler the global keys and the keys of the screen on show', () => {
    expect(read(LAYOUT)).toContain('<Keyboard keys={[...globalKeys, ...(pageKeys.now?.keys ?? [])]} actions={{ ...actions, ...pageKeys.now?.actions }} />');
  });

  it('hears the board and the card page keys through the screen keys, once each', () => {
    expect(read(BOARD).match(/pageKeys\.show\(/g)).toHaveLength(1);
    // No toast stack of its own: the board, the palette and every other screen raise into the app's one.
    expect(read(BOARD)).toContain("pageKeys.show({ keys: scoped('board'), actions: boardKeys })");
    expect(read(CARD).match(/pageKeys\.show\(/g)).toHaveLength(1);
    expect(read(CARD)).toContain("keys: [...scoped('card'), ...tabKeys(data.tabs)],");
  });
});

// The help lists only keys a screen binds. This is the other half: every key in the list has its
// action on the screen of its scope, so none of them is left out of the help by accident.
describe('every registered key has its action', () => {
  const owner: Record<KeyScope, string> = { global: LAYOUT, board: BOARD, card: CARD, knowledge: KNOWLEDGE };

  it.each(['global', 'board', 'card', 'knowledge'] as const)('binds each %s key where that scope lives', (scope) => {
    const source = read(owner[scope]) + (scope === 'global' ? read(NEW) : '');
    // Help belongs to the handler itself.
    const actions = scoped(scope)
      .map((binding) => binding.action)
      .filter((action) => action !== 'help');
    for (const action of actions) expect(source, action).toMatch(new RegExp(`(?:^|[\\s{,])(?:'${action}'|${action}):`, 'm'));
  });

  // T is the theme key. The registry gives T the theme action, and this is the
  // other half: the action runs the same toggle as the rail's theme button.
  it('binds the theme action to the theme toggle', () => {
    const source = read(LAYOUT);

    expect(source).toContain('    theme: toggleTheme,');
    expect(source).toContain('ontheme={toggleTheme}');
  });

  // A board that is off has no key to go to it, so the help lists G then E only while Epics is on.
  it('binds G then E only while the Epics board is on', () => {
    expect(read(LAYOUT)).toContain("...(data.offBoards.includes('epics') ? {} : { 'go:epics':");
  });

  // G then U only while PR reviews is on, and G then W only while the rail links Workspace, which it does
  // with a project set.
  it('binds G then U and G then W only while their screen is in the rail', () => {
    expect(read(LAYOUT)).toContain("...(data.offBoards.includes('prreview') ? {} : { 'go:prreview':");
    expect(read(LAYOUT)).toContain("...(project === null ? {} : { 'go:workspace':");
  });

  // A card key acts on a control the card has, so it is bound only while the card has it. Or the help
  // would list Retry on a card that has not failed.
  it('binds the card run keys only while their button is shown', () => {
    const source = read(CARD);

    expect(source).toContain('const control = $derived(forward === null ? null : (runView(forward.card, null)?.kind ?? ');
    expect(source).toContain('...(control === null ? {} : { minimize:');
    expect(source).toContain("...(control === 'stop' ? { stop:");
    expect(source).toContain("...(control === 'retry'");
  });

  // A refused retry opens the confirm, which shows the refusal with Confirm off, so only a retry with
  // nothing to ask presses Retry at once. The confirm holds its card, and goes when that card is no
  // longer failed, or it would open again by itself the next time the card failed. The decision panel is
  // on the overview alone, so off it the key sends the retry itself.
  it('presses Retry at once only when there is nothing to ask, and keeps the confirm to its card', () => {
    const source = read(CARD);

    expect(source).toContain("const said = snapshot === null ? null : keyWrite(snapshot, data.ticket.key, 'retry');");
    expect(source).toMatch(/if \(said\.kind === 'send'\) act\('\[data-run="retry"\]', writes\.onretry\);\n\s*else starting = data\.ticket\.key;/);
    expect(source).toContain('if (press(selector)) return;');
    expect(source).toContain('const startStage = $derived(starting !== data.ticket.key || snapshot === null ? null : retryStage(snapshot, data.ticket.key));');
    expect(source).toMatch(/\$effect\(\(\) => \{\n\s*if \(startStage === null\) starting = null;\n\s*\}\);/);
  });

  it('binds a key for each tab the card page shows', () => {
    expect(read(CARD)).toContain('data.tabs.map((tab) => [`tab:${tab.id}`, () => press(`[data-tab="${tab.id}"]`)])');
    expect(read(CARD)).toContain('data-back>');
  });
});

// The number keys count the tabs in front of the reader, so key 7 is the last tab on a Delivery card
// with a pull request, and key 6 is the last one before it and on a board with six.
describe('the card page tab keys', () => {
  const key = (kind: string, digit: string) => tabKeys(tabsFor(kind)).find((binding) => binding.keys[0]![0]!.key === digit)?.action ?? null;

  it('counts the tabs of the board the card is on', () => {
    expect(key('delivery', '7')).toBe('tab:settings');
    expect(tabKeys(tabsFor('delivery', 'review')).find((binding) => binding.keys[0]![0]!.key === '6')?.action).toBe('tab:settings');
    expect(key('delivery', '3')).toBe('tab:changes');
    expect(key('epics', '6')).toBeNull();
    expect(key('epics', '5')).toBe('tab:settings');
    expect(key('prreview', '2')).toBe('tab:review');
  });

  // The board's help lists the Delivery card's tabs from its own copy, which cannot drift from core's.
  it("lists the Delivery card's tabs in the board's help", () => {
    expect(CARD_TABS).toEqual(tabKeys(tabsFor('delivery')));
  });

  it.each(BOARD_KINDS)('gives every tab of the %s board a key', (kind) => {
    expect(tabKeys(tabsFor(kind)).map((binding) => binding.label)).toEqual(tabsFor(kind).map((tab) => tab.label));
  });
});

describe('pageKeys', () => {
  const screen = (name: string) => ({ keys: [], actions: { [name]: () => undefined } });

  it('holds the keys of the screen on show, and drops them when it goes', () => {
    const board = screen('add');
    const done = pageKeys.show(board);

    expect(pageKeys.now).toBe(board);
    done();
    expect(pageKeys.now).toBeNull();
  });

  // The old page can go after the new one arrived, and its cleanup must not take the new keys away.
  it('keeps the keys of a screen that came after', () => {
    const goneBoard = pageKeys.show(screen('add'));
    const card = screen('retry');
    const doneCard = pageKeys.show(card);

    goneBoard();
    expect(pageKeys.now).toBe(card);
    doneCard();
  });
});
