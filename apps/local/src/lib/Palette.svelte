<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { BoardKind } from '@nolzu/protocol';
  import { type Binding, capsOf, closeOnBackdrop, Kbd, type KeyActions, liveKeys } from '@nolzu/ui';
  import { tick } from 'svelte';
  import { answered, pressed, refusedDrop, sendMove } from './board-page.ts';
  import { follow } from './follow.svelte.ts';
  import { nowLive } from './now-live.svelte.ts';
  import { type Hrefs, type PaletteRow, paletteRows, rankRows } from './palette.ts';
  import { askFirst } from './qa-ask.svelte.ts';
  import { lastBoard } from './last-board.ts';
  import { ICONS } from './rail.ts';
  import { toastStack } from './toast-stack.svelte.ts';

  // The command palette, over any screen with the rail. The layout hands it what it hands the key
  // handler, so each key's row runs that key's own action and exists only where the key works. The
  // cards come from the one Now stream the layout keeps open, and a refusal goes to the app's one toast
  // stack, which the layout draws.
  let { keys, actions, offBoards = [] }: { keys: readonly Binding[]; actions: KeyActions; offBoards?: readonly BoardKind[] } = $props();

  const uid = $props.id();
  let open = $state(false);
  let query = $state('');
  // The chosen row by its id, so a snapshot that reorders the list never moves Enter to another row. A
  // row that leaves the list leaves nothing chosen, so Enter does not fall to a row nobody chose.
  let chosenId = $state<string | null>(null);
  let dialog = $state<HTMLDialogElement>();
  let field = $state<HTMLInputElement>();
  // What had focus when the palette opened, where focus goes back when it closes.
  let opener: HTMLElement | null = null;

  // Made at each use, because the address of a page depends on the page drawn. A key goes in encoded,
  // as the board encodes it, because resolve puts it in as it is.
  const hrefs = (): Hrefs => ({
    board: (kind) => (kind === 'research' ? resolve('/b/research') : resolve('/b/[board]', { board: kind })),
    card: (key) => resolve('/t/[key]', { key: encodeURIComponent(key) }),
    cardTab: (key, tab) => resolve('/t/[key]/[tab]', { key: encodeURIComponent(key), tab }),
    section: (id) => resolve('/settings/[section]', { section: id }),
    addCard: `${resolve('/b/[board]', { board: lastBoard(offBoards) })}?add`,
  });

  const rows = $derived(open ? paletteRows(liveKeys(keys, actions), nowLive.state.snapshot?.boards ?? [], offBoards, hrefs()) : []);
  const groups = $derived(rankRows(rows, query));
  const flat = $derived(groups.flatMap((group) => group.rows));
  const at = $derived(new Map(flat.map((row, index) => [row.id, index])));
  const selected = $derived(flat.find((row) => row.id === chosenId) ?? null);
  const optionId = (row: PaletteRow) => `${uid}-o${at.get(row.id) ?? 0}`;

  // On open and on each search the first row is chosen by its id, so a snapshot that lands before
  // Enter cannot put another row in its place.
  const chooseFirst = () => (chosenId = flat[0]?.id ?? null);

  // Cmd K and the rail's search button. Focus goes into the field, so typing starts at once.
  export async function show(): Promise<void> {
    if (open) return;
    opener = document.activeElement as HTMLElement | null;
    query = '';
    open = true;
    chooseFirst();
    await tick();
    dialog?.showModal();
    field?.focus();
  }

  // Closes the palette, gives focus back, and then runs the row, so a row that opens a dialog of its
  // own, such as Add card, opens it over the page and not over the palette.
  function finish(row: PaletteRow | null): void {
    if (!open) return;
    open = false;
    dialog?.close();
    if (opener?.isConnected) opener.focus();
    if (row !== null) run(row);
  }

  function run(row: PaletteRow): void {
    const what = row.run;
    if (what.kind === 'action') void actions[what.action]?.();
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- every address comes from hrefs(), which resolve()s it
    else if (what.kind === 'go') void goto(what.href);
    else if (what.refused !== null) toastStack.state = refusedDrop(toastStack.state, { key: what.key, href: hrefs().card(what.key) }, what.refused.refusal, what.refused.link);
    else void move(what.key, what.to);
  }

  // Enter on a move is the consent, as a drop is. It sends what a drop sends, to
  // the same route, and the stream moves the card. A refusal is the card's one toast. The page that
  // shows the card selects it once it lands, so the focus goes to the moved card.
  async function move(key: string, to: string, asked = false): Promise<void> {
    // The first move into QA asks how QA gets the app first, over the page the palette closed onto.
    if (!asked && askFirst(key, to, () => move(key, to, true))) return;
    follow.state = { key, to };
    toastStack.state = pressed(toastStack.state, key);
    const mine = toastStack.state.press;
    // Awaited on its own line, so the stack is read after the answer and keeps what came meanwhile.
    const said = await sendMove(fetch, resolve('/api/board/move'), key, to);
    if (said !== null && follow.state?.key === key) follow.state = null;
    toastStack.state = answered(toastStack.state, mine, { key, href: hrefs().card(key) }, said);
  }

  function step(by: number): void {
    const from = selected === null ? -1 : (at.get(selected.id) ?? -1);
    const next = flat[Math.max(0, Math.min(flat.length - 1, from + by))];
    if (next === undefined) return;
    chosenId = next.id;
    void tick().then(() => document.getElementById(optionId(next))?.scrollIntoView?.({ block: 'nearest' }));
  }

  // On the dialog, so the keys work wherever focus is inside it. Esc is handled here and not left to
  // the browser's cancel, so focus goes back the same way in every browser.
  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish(null);
    } else if (event.isComposing) {
      return;
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      // Already open. Kept from the browser, which would move focus to its own search field.
      event.preventDefault();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      step(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter' && selected !== null) {
      event.preventDefault();
      // Cmd Enter opens the card of the chosen row, as the card's Open row says.
      const card = selected.card;
      if (event.metaKey || event.ctrlKey) finish(card === undefined ? null : (rows.find((row) => row.id === `open:${card}`) ?? null));
      else finish(selected);
    }
  }
</script>

{#snippet icon(paths: readonly string[], amber = false)}
  <svg class="ico" class:amber viewBox="0 0 24 24" aria-hidden="true">
    {#each paths as d, index (index)}<path {d}></path>{/each}
  </svg>
{/snippet}

{#if open}
  <dialog bind:this={dialog} aria-label="Command palette" {onkeydown} onclose={() => finish(null)} {@attach closeOnBackdrop(() => finish(null))} data-palette>
    <div class="in">
      {@render icon(ICONS.search)}
      <label class="hidden" for="{uid}-field">Command</label>
      <!-- A combobox over the list, so a screen reader hears the chosen row while focus stays here. -->
      <input
        id="{uid}-field"
        bind:this={field}
        value={query}
        oninput={(event) => {
          query = event.currentTarget.value;
          chooseFirst();
        }}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="{uid}-list"
        aria-autocomplete="list"
        aria-activedescendant={selected === null ? undefined : optionId(selected)}
        placeholder="Search or run a command"
        autocomplete="off"
        spellcheck="false"
      />
      <Kbd key="Esc" aria-hidden="true" />
    </div>
    <div class="list" id="{uid}-list" role="listbox" aria-label="Commands">
      {#each groups as group, g (group.head)}
        <div class="grp" role="group" aria-labelledby="{uid}-g{g}">
          <div class="gh" id="{uid}-g{g}">{group.head}</div>
          {#each group.rows as row (row.id)}
            <!-- The keys are the field's, as the combobox pattern has it. A click runs the row too. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div class="it" class:on={row === selected} class:starts={row.starts === true} role="option" id={optionId(row)} aria-selected={row === selected} tabindex="-1" onclick={() => finish(row)} onpointermove={() => (chosenId = row.id)} data-row={row.id}>
              {@render icon(row.icon, row.starts === true)}
              <span class="label">{row.label}</span>
              {#if row.hint !== undefined || row.keys !== undefined || row === selected}
                {@const caps = row.keys === undefined || row.keys.length === 0 ? null : capsOf(row.keys)}
                <!-- Caps with no word between strokes. The words go between the nodes, because
                     Svelte drops a space at the start of an element. -->
                <span class="x">
                  <!-- Mono for the command and the estimate only. A refusal is a sentence. -->
                  {#if row.hint !== undefined}<span class="hint" class:mono={row.starts === true} title={row.hint}>{row.hint}</span>{/if}
                  {#if caps !== null}<span class="caps" aria-hidden="true">{#each caps.strokes.flat() as cap, c (c)}<Kbd key={cap} />{/each}</span>
                    <span class="hidden">{caps.said}</span>
                    <!-- The chosen row is what Enter runs. A row with a key of its own keeps
                         only that key. The listbox already tells a screen reader. -->
                  {:else if row === selected}<span class="caps" aria-hidden="true"><Kbd key="↵" /></span>{/if}
                </span>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
    <!-- Always there, so a screen reader hears it when a search finds nothing. -->
    <p class="none" aria-live="polite">{flat.length === 0 ? `Nothing matches “${query.trim()}”. Search for a card by its key or title, or for a screen.` : ''}</p>
    <div class="ft">
      <span aria-hidden="true"><Kbd key="↑" /><Kbd key="↓" />choose</span>
      <span aria-hidden="true"><Kbd key="↵" />run</span>
      <span class="note">A move that starts an agent shows what it starts, like a drop does</span>
    </div>
  </dialog>
{/if}

<style>
  /* 640px wide and 120px from the top, centred across by the browser's
     own dialog rule. The radius is 16px, which the scale has not got. */
  dialog {
    box-sizing: border-box;
    width: min(640px, calc(100vw - 32px));
    max-height: calc(100dvh - min(120px, 14vh) - var(--space-6));
    margin-top: min(120px, 14vh);
    padding: 0;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-2xl);
    background: var(--card);
    color: var(--ink);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  /* The list scrolls between the field and the foot. */
  dialog[open] {
    display: flex;
    flex-direction: column;
  }

  dialog:focus-visible {
    outline: none;
  }

  dialog::backdrop {
    background: var(--scrim);
  }

  /* The field is 16px, which the scale has not got. */
  .in {
    display: flex;
    flex: none;
    align-items: center;
    gap: 10px;
    padding: var(--space-4) 18px;
    border-bottom: 1px solid var(--line);
    font-size: var(--text-md);
  }

  .in .ico {
    width: 16px;
    height: 16px;
    color: var(--muted);
  }

  /* No ring: the field has the focus the whole time the palette is open, and the caret marks
     it. */
  input {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--ink);
    font: inherit;
    outline: none;
  }

  input::placeholder {
    color: var(--muted);
    opacity: 1;
  }

  /* A fixed height. A taller list would cover the whole board on an empty search. */
  .list {
    flex: 1 1 auto;
    min-height: 0;
    max-height: 420px;
    overflow-y: auto;
  }

  .grp {
    padding: var(--space-2) var(--space-2) var(--space-1);
  }

  .grp:last-child {
    padding-bottom: var(--space-2);
  }

  /* The head is 11.5px, which the scale has not got. */
  .gh {
    overflow: hidden;
    padding: 6px 10px var(--space-1);
    font-size: var(--text-2xs);
    font-weight: 500;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The radius is 9px, which the scale has not got. */
  .it {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 38px;
    padding: 0 10px;
    border-radius: var(--radius-md);
    font-size: var(--text-card-title);
    color: var(--ink-2);
    cursor: pointer;
  }

  /* A chosen row that starts nothing is neutral, because amber means an agent starts or resumes work.
     The ring is faint, which reaches 3:1 on the panel, so the choice is not told by the fill alone. */
  .it.on {
    background: var(--panel);
    color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--faint);
  }

  /* A chosen move that starts an agent run is amber, because Enter there starts one. Ink and
     muted on the amber tint over the card are measured in tokens.test.ts. An --amber-line ring would be
     under 3:1, so the ring is full amber, as on a drop target. */
  .it.on.starts {
    background: var(--amber-bg);
    box-shadow: inset 0 0 0 1px var(--amber);
  }

  .ico {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The one amber part: the mark of a move that starts an agent run. */
  .ico.amber {
    color: var(--amber);
  }

  /* The label keeps its width and the Starts line gives way in a narrow box. A label that shrank by a
     fraction of a pixel would lose its last letters to an ellipsis. Every label fits a phone row. */
  .label {
    flex: none;
    white-space: nowrap;
  }

  .x {
    display: flex;
    flex: 0 1 auto;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-left: auto;
  }

  .hint {
    overflow: hidden;
    font-size: var(--text-xs);
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hint.mono {
    font-family: var(--font-mono);
    font-size: var(--mono-card-key);
  }

  .caps {
    display: inline-flex;
    flex: none;
    gap: var(--space-1);
  }

  .none {
    margin: 0;
    padding: var(--space-4) 18px;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .none:empty {
    display: none;
  }

  .ft {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
    padding: 10px var(--space-4);
    border-top: 1px solid var(--line);
    background: var(--panel);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .ft span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .ft .note {
    margin-left: auto;
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
