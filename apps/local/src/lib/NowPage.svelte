<script lang="ts">
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { findingOfKey, SCOUT_AND_EVIDENCE } from '@nolzu/protocol';
  import { tick } from 'svelte';
  import { Banner, Button, Chip, CoachNote, type KeyActions, KeyCaps, LaneChips, liveOf, Markdown, ranOn, refusalFromServer, scoped, Skeleton, SlotsMeter, StatePill } from '@nolzu/ui';
  import { answered, landed, pressed } from './board-page.ts';
  import { lastBoard } from './last-board.ts';
  import { suggestionText } from './chain.ts';
  import NowItem from './NowItem.svelte';
  import { doneLine, nearLines, type NowSnapshot, projectPath, rowPill, rowSays, type RunRow, todayStats, usageRows, waitingItems } from './now.ts';
  import { follow } from './follow.svelte.ts';
  import { pageKeys } from './page-keys.svelte.ts';
  import PeekPanel from './PeekPanel.svelte';
  import { askBeforeRetry, askFirst } from './qa-ask.svelte.ts';
  import type { BoardState } from './snapshot-client.ts';
  import { postWrite } from './ticket.ts';
  import { toastStack } from './toast-stack.svelte.ts';

  // Now: what waits on the person, what runs and what was done today, across every board that is on.
  // The state comes from the one Now stream the root layout opens, so this
  // page and the rail's count read the same snapshot. A fixed clock can be passed in, as the tests do.
  let { stream, now: fixed }: { stream: BoardState<NowSnapshot>; now?: Date } = $props();

  let ticking = $state(new Date());
  $effect(() => {
    if (fixed !== undefined) return;
    ticking = new Date();
    const timer = setInterval(() => (ticking = new Date()), 1000);
    return () => clearInterval(timer);
  });
  const clock = $derived(fixed ?? ticking);

  const machine = $derived(stream.snapshot);
  // Now shows the current project only, the one picked in the rail.
  const items = $derived(machine === null ? [] : waitingItems(machine));
  // Lanes belong to the machine, so the lane chips name a holder of another project by the name the
  // project selector lists.
  const projectNames = $derived(Object.fromEntries(((page.data.projects ?? []) as { id: number; name: string }[]).map((one) => [one.id, one.name])));
  // Slots, lanes and the quiet time belong to the machine, so every board carries the same ones.
  // Delivery is never off, so it is always the first.
  const first = $derived(machine?.boards[0] ?? null);
  const usage = $derived(machine === null ? [] : usageRows(machine.profiles, stream.limits, clock.getTime()));
  const near = $derived(machine === null ? [] : nearLines(machine.profiles, stream.limits, clock.getTime()));
  const day = $derived(new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).format(clock));

  // Encoded as the tab bar encodes it, because resolve puts the key in as it is.
  const cardHref = (key: string) => resolve('/t/[key]', { key: encodeURIComponent(key) });

  // A move, a retry or a stop, posted to the project the snapshot serves, because card keys repeat
  // across projects and another tab can pick another project. A refusal is the card's one toast in the
  // app's one stack, and the card changes only when the stream says so.
  async function write(key: string, path: string, body: unknown, asked = false): Promise<boolean> {
    // The first move into QA asks how QA gets the app first. False lets the item's button go.
    const to = path === resolve('/api/board/move') ? (body as { to?: unknown }).to : undefined;
    if (!asked && typeof to === 'string' && askFirst(key, to, () => write(key, path, body, true))) return false;
    if (!asked && path.endsWith('/retry') && askBeforeRetry(key, () => write(key, path, body, true))) return false;
    toastStack.state = pressed(toastStack.state, key);
    const mine = toastStack.state.press;
    const said = await postWrite(fetch, projectPath(path, machine?.project), body);
    toastStack.state = answered(toastStack.state, mine, { key, href: cardHref(key) }, said === null ? null : refusalFromServer(said));
    return said === null;
  }

  // The item shows a refused answer beside the field, where the person is typing.
  const answer = (key: string, text: string) => postWrite(fetch, projectPath(resolve('/api/card/[key]/answer', { key: encodeURIComponent(key) }), machine?.project), { answer: text });

  // A stop holds its button until the row leaves or changes state, read off the snapshot.
  let stopping = $state<Readonly<Record<number, RunRow['state'] | null>>>({});
  async function stop(row: RunRow): Promise<void> {
    if (stopping[row.runId] === row.state) return;
    stopping = { ...stopping, [row.runId]: row.state };
    if (!(await write(row.key, resolve('/api/board/stop'), { runId: row.runId }))) stopping = { ...stopping, [row.runId]: null };
  }

  // A run with no card is named by what it does, as the lane chips name it.
  const rowKey = (row: RunRow) => (row.kind === 'maintenance' ? 'maintenance' : row.kind === 'assessment' ? 'scout assess' : row.key);
  const rowTitle = (row: RunRow) =>
    row.kind === 'maintenance' ? 'Knowledge maintenance' : row.kind === 'assessment' ? `Assessment of Scout finding ${findingOfKey(row.key) ?? ''}` : (row.title ?? row.key);
  const runWith = (row: RunRow) => ranOn(row.engine, row.model, row.effort);

  // The chain slot. A refusal stays beside the buttons, where the person pressed.
  const chain = $derived(machine?.chain ?? null);
  const chainSlot = $derived(chain?.on ? 'on' : chain !== null && chain.approved !== null ? 'suggest' : null);
  let chainSending = $state(false);
  let chainSaid = $state('');
  // Not state: only the slot's change reads it.
  let chainPressed = false;
  async function setChain(body: unknown): Promise<void> {
    if (chainSending) return;
    chainSending = true;
    chainPressed = true;
    chainSaid = '';
    chainSaid = (await postWrite(fetch, resolve('/api/chain'), body)) ?? '';
    if (chainSaid !== '') chainPressed = false;
    chainSending = false;
  }
  // Got it on the workspace offer. The note hides at once; a store that failed shows it again on the next load.
  const closeNote = (note: string) => void postWrite(fetch, resolve('/api/notes'), { note });

  // Every press swaps or removes the pressed button, so the next snapshot drops focus to the page.
  // Focus goes to what the slot became, or on to Scout when it went.
  $effect(() => {
    void chainSlot;
    if (!chainPressed) return;
    chainPressed = false;
    if (document.activeElement !== null && document.activeElement !== document.body) return;
    (document.querySelector<HTMLElement>('[data-chain]') ?? document.querySelector<HTMLElement>('a.scout'))?.focus();
  });

  // Now draws no Add card. N goes to the board this tab was last on and opens Add card there, so
  // the card lands where the person can see it.
  // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() makes the address, the flag is its query
  const addOnBoard = () => void goto(`${resolve('/b/[board]', { board: lastBoard(page.data.offBoards ?? []) })}?add`);

  // The rows the keys move through, in the order the page draws them: what waits, then what runs. Only
  // the rows of a card: the key handler gives no key to a row without one, such as a Scout assessment,
  // so J would stop there.
  const ROW = 'article[data-now-row][data-card]';
  const rows = () => [...document.querySelectorAll<HTMLElement>(ROW)];
  const focusedRow = () => (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(ROW) ?? null;
  function step(by: 1 | -1): boolean | void {
    const found = rows();
    const at = found.indexOf(focusedRow() as HTMLElement);
    const next = at === -1 ? (by === 1 ? found[0] : undefined) : found[at + by];
    if (next === undefined) return false;
    next.focus();
  }

  // Peek: Space opens the sheet on the card of the row with the focus, and J and K move on with
  // the sheet following. The selection is the last row that had the focus.
  let selected = $state<string | null>(null);
  let peeking = $state(false);
  let opener: HTMLElement | null = null;
  let panel = $state<{ back: () => Promise<void> } | undefined>();
  $effect(() => {
    const heard = (event: FocusEvent) => {
      const row = (event.target as Element | null)?.closest?.(ROW);
      if (row != null) selected = row.getAttribute('data-card');
    };
    document.addEventListener('focusin', heard);
    return () => document.removeEventListener('focusin', heard);
  });
  // The card and its board, read off the snapshot, so the sheet draws what the stream says.
  const peekOn = $derived.by(() => {
    if (!peeking || selected === null || machine === null) return null;
    for (const board of machine.boards) {
      const card = board.cards.find((one) => one.key === selected);
      if (card !== undefined) return { card, board };
    }
    return null;
  });
  $effect(() => {
    if (peeking && peekOn === null) peeking = false;
  });
  // Esc returns the focus to the row the sheet showed, or to what opened it.
  function closePeek(): void {
    peeking = false;
    const row = selected === null ? null : document.querySelector<HTMLElement>(`article[data-now-row][data-card="${CSS.escape(selected)}"]`);
    (row ?? (opener?.isConnected ? opener : null))?.focus();
  }

  // A card the palette moved, given the focus again on its row once the stream shows it moved, as on the
  // board. A card that left Now's lists has no row, and nothing takes the focus then.
  $effect(() => {
    const key = machine === null ? null : landed(machine.boards.flatMap((board) => board.cards), follow.state);
    if (key === null) return;
    follow.state = null;
    const at = document.activeElement;
    if (at !== null && at !== document.body && focusedRow() === null) return;
    void tick().then(() => document.querySelector<HTMLElement>(`article[data-now-row][data-card="${CSS.escape(key)}"]`)?.focus());
  });

  // J and K go through the rows, N adds a card, Space peeks, Enter opens, Cmd . stops and Shift Up puts a
  // queued run first, as on the board. The board's own bindings, so the help names them the same way.
  // Esc closes the sheet, then leaves the row, and Shift Left is the sheet's Move back.
  const actions: KeyActions = {
    next: () => step(1),
    previous: () => step(-1),
    add: addOnBoard,
    peek: () => {
      if (peeking) {
        closePeek();
        return;
      }
      const key = focusedRow()?.getAttribute('data-card') ?? null;
      if (key === null) return false;
      opener = document.activeElement as HTMLElement | null;
      selected = key;
      peeking = true;
    },
    open: () => {
      const key = focusedRow()?.getAttribute('data-card') ?? null;
      if (key === null) return false;
      void goto(resolve('/t/[key]', { key: encodeURIComponent(key) }));
    },
    // The row's own Stop. A row that waits on the person runs nothing.
    stop: () => {
      const runId = focusedRow()?.getAttribute('data-run');
      const row = machine?.running.find((one) => String(one.runId) === runId);
      if (row === undefined) return false;
      void stop(row);
    },
    promote: () => {
      const row = focusedRow();
      const runId = Number(row?.getAttribute('data-run'));
      if (row?.getAttribute('data-state') !== 'queued' || !Number.isInteger(runId)) return false;
      void write(row.getAttribute('data-key') ?? '', resolve('/api/board/promote'), { runId });
    },
    back: () => {
      if (peeking) {
        closePeek();
        return;
      }
      const row = focusedRow();
      if (row === null) return false;
      row.blur();
    },
    'move-back': () => {
      const card = peekOn?.card;
      if (panel === undefined || card === undefined || focusedRow()?.getAttribute('data-card') !== card.key) return false;
      void panel.back();
    },
  };
  const NOW_KEYS = ['next', 'previous', 'add', 'peek', 'open', 'stop', 'promote', 'back'];
  // Shift Left is the sheet's Move back, so the help lists it only while the sheet is open.
  const sheetOpen = $derived(peekOn !== null);
  $effect(() => {
    const keys = sheetOpen ? [...NOW_KEYS, 'move-back'] : NOW_KEYS;
    return pageKeys.show({ keys: scoped('board').filter((binding) => keys.includes(binding.action)), actions });
  });
</script>

<!-- One row of Running. A card's row is one the keys reach: J and K move to it, Space peeks at its card,
     Shift Up puts a queued run first. A run with no card has no data-card, and the keys pass it. -->
{#snippet runRow(row: RunRow)}
  {@const live = liveOf({ state: row.state, runId: row.runId, runState: row.runState }, stream.activity[row.key], clock, first?.quietAfterMs)}
  {@const shown = rowPill(row, live, clock)}
  {@const says = rowSays(row, live, clock)}
  {@const busy = stopping[row.runId] === row.state}
  <article class="run" data-now-row data-card={row.kind === 'card' ? row.key : undefined} data-key={row.key} data-run={row.runId} data-state={row.state} tabindex="-1">
    <span class="pill"><StatePill state={shown.state} word={shown.word} detail={shown.detail} detailOnly={shown.state === 'running' && shown.detail !== null} /></span>
    <span class="k">{rowKey(row)}</span>
    <div class="tt">
      {#if row.kind === 'card'}<a href={resolve('/t/[key]', { key: encodeURIComponent(row.key) })}>{rowTitle(row)}</a>{:else}<b>{rowTitle(row)}</b>{/if}
      {#if says !== null}<span class:waits={row.state === 'queued' || row.runState === 'retrying'} title={says}>{says}</span>{/if}
    </div>
    <span class="phase"><Chip>{row.phase}</Chip>{#if row.kind === 'assessment'}<Chip>read-only</Chip>{/if}</span>
    <span class="m">{runWith(row)}</span>
    <!-- A queued run is taken out of the queue by the same stop, which ends its row as stopped. -->
    <Button
      variant="ghost"
      size="small"
      aria-label={row.state === 'queued' ? `Remove ${rowKey(row)} from the queue` : `Stop ${rowKey(row)}`}
      aria-busy={busy ? 'true' : undefined}
      aria-disabled={busy ? 'true' : undefined}
      data-stop={row.runId}
      onclick={() => void stop(row)}
    >
      <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"
        ><path d={row.state === 'queued' ? 'M6 6l12 12M18 6 6 18' : 'M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z'}></path></svg
      >
    </Button>
  </article>
{/snippet}

<svelte:head><title>Now · Nolzu</title></svelte:head>

<div class="split">
<div class="col">
<div class="top">
  <h1>Now</h1>
  <span class="sub">{day}</span>
  <span class="sp"></span>
  <span class="hint">Jump to the next one <KeyCaps combos={[[{ key: 'j' }]]} /></span>
</div>

{#if stream.reconnecting}
  <!-- Quiet on purpose. What the page had stays in view, and the stream comes back by itself. -->
  <p class="note" role="status">The boards are not answering. Trying again.</p>
{/if}

{#if machine === null || first === null}
  {#if !stream.reconnecting}<div class="first" aria-busy="true"><Skeleton shape="card" label="Waiting for the boards." /></div>{/if}
{:else}
  <div class="page" class:peeking>
    <div class="main">
      <section class="waiting" aria-labelledby="waiting-title">
        <div class="head">
          <h2 id="waiting-title">Waiting on you <span class="n" data-waiting-count>{items.length}</span></h2>
          <span class="sub">Answer, approve or send back from here. Oldest first.</span>
        </div>
        {#if items.length === 0}
          <p class="empty">Nothing waiting on you.</p>
        {:else}
          {#each items as item (item.card.key)}
            <NowItem {item} {clock} onanswer={answer} onwrite={write} />
          {/each}
        {/if}
      </section>

      <section aria-labelledby="running-title">
        <div class="head">
          <h2 id="running-title">Running <span class="n">{machine.running.length}</span></h2>
          <SlotsMeter slots={first.slots} />
          <span class="sp"></span>
          <!-- The Scout lane is idle while Scout waits for a later version, so it says nothing. -->
          <LaneChips lanes={SCOUT_AND_EVIDENCE ? first.lanes : first.lanes.filter((lane) => lane.name !== 'scout')} projects={projectNames} />
        </div>
        {#if machine.running.length === 0}
          <p class="empty">Nothing runs or waits for a slot.</p>
        {:else}
          <div class="panel runs">
            {#each machine.running as row (row.runId)}
              {@render runRow(row)}
            {/each}
          </div>
        {/if}
      </section>

      <section aria-labelledby="done-title">
        <div class="head"><h2 id="done-title">Done today <span class="n">{machine.done.length}</span></h2></div>
        {#if machine.done.length === 0}
          <p class="empty">Nothing done yet today.</p>
        {:else}
          <div class="panel">
            {#each machine.done as row (row.key)}
              <div class="done">
                <span class="check" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"></path></svg></span>
                <div class="what">
                  <p><span class="k">{row.key}</span> <a href={resolve('/t/[key]', { key: encodeURIComponent(row.key) })}>{row.title}</a></p>
                  {#if row.summary !== null}<div class="said"><Markdown source={row.summary} headingsFrom={4} /></div>{/if}
                </div>
                <span class="m">{doneLine(row)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    </div>

    <aside aria-label={SCOUT_AND_EVIDENCE ? 'Today, usage, the chain suggestion and Scout' : 'Today, usage and the chain suggestion'}>
      <!-- A project of one repository made before every project was a workspace. The
           layout names the note until Got it or the move, and the form stays in Settings, Project either way. -->
      {#if typeof page.data.workspaceNote === 'string'}
        <CoachNote note={page.data.workspaceNote} seen={[]} title="Make this a workspace" ondismiss={closeNote}>
          <p>This project is one repository. A workspace is a folder that holds several, and every new project is one.</p>
          <p>Settings, Project moves this repository into a new workspace, with its branches, cards and knowledge. <a href="{resolve('/settings/project')}#convert">Open Settings, Project</a></p>
          {#snippet hint()}The form stays in Settings, Project.{/snippet}
        </CoachNote>
      {/if}
      <section class="panel today" aria-labelledby="today-title">
        <h2 id="today-title" class="pad">Today</h2>
        <div class="stats">
          {#each todayStats(machine.today) as stat (stat.label)}
            <p class="stat"><b>{stat.value}</b> <span>{stat.label}</span></p>
          {/each}
        </div>
      </section>

      <!-- What each engine last reported. It stays on this machine. -->
      <section class="panel pad" aria-labelledby="usage-title">
        <h2 id="usage-title">Usage limits</h2>
        <!-- A window at 90% or more, with its profile. A neutral box, because nothing starts here. -->
        {#each near as line (line)}<Banner kind="warning">{line}</Banner>{/each}
        {#if usage.length === 0}
          <p class="empty">No engine profile is set. Add one in Settings, Models.</p>
        {/if}
        {#each usage as row, at (at)}
          <div class="eng">
            <p class="r"><span>{row.name}</span><span class="v">{row.share === null ? row.note : `${row.share}%`}</span></p>
            {#if row.share !== null}<div class="bar" aria-hidden="true"><i style:width="{Math.min(row.share, 100)}%"></i></div>{/if}
            {#if row.detail !== null}<p class="seen">{row.detail}</p>{/if}
          </div>
        {/each}
      </section>

      <!-- The chain suggestion. It only suggests: a press asks the server,
           and the slot draws what the next snapshot says. Once the chain is on, the same slot is where
           it is turned off. -->
      {#if chainSlot === 'on'}
        <section class="panel pad" aria-labelledby="chain-title" data-chain="on" tabindex="-1">
          <h2 id="chain-title">Implement after Plan</h2>
          <p class="ink2">On for Delivery cards where "Go on to Implement after Plan" is ticked on the Settings tab. When their plan is done, Implement starts without waiting for you.</p>
          <div class="row">
            <Button size="small" aria-disabled={chainSending ? 'true' : undefined} data-chain-off onclick={() => setChain({ board: 'delivery', on: false })}>Turn off</Button>
          </div>
          {#if chainSaid !== ''}<p class="refused" role="status">{chainSaid}</p>{/if}
        </section>
      {:else if chain !== null && chain.approved !== null}
        <section class="panel pad suggest" aria-labelledby="chain-title" data-chain="suggest" tabindex="-1">
          <h2 id="chain-title"><svg class="icon bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"></path></svg>A suggestion</h2>
          <p class="ink2">{suggestionText(chain.approved)}</p>
          <div class="row">
            <Button size="small" aria-disabled={chainSending ? 'true' : undefined} data-chain-on onclick={() => setChain({ board: 'delivery', on: true })}>Turn on</Button>
            <Button variant="ghost" size="small" aria-disabled={chainSending ? 'true' : undefined} data-chain-later onclick={() => setChain({ notNow: true })}>Not now</Button>
          </div>
          {#if chainSaid !== ''}<p class="refused" role="status">{chainSaid}</p>{/if}
        </section>
      {/if}

      {#if SCOUT_AND_EVIDENCE}
        <a class="panel pad scout" href={resolve('/scout')}>
          <span class="h">Scout {#if machine.scout.fresh > 0}<span class="new"><StatePill state="new" word="{machine.scout.fresh} new" /></span>{/if}</span>
          {#if machine.scout.newest !== null}
            <span class="title">{machine.scout.newest.title}</span>
            <span class="line">{machine.scout.newest.line}</span>
          {:else if machine.scout.sources === 0}
            <span class="line">No source yet. Scout reads logs and errors once you add one.</span>
          {:else}
            <span class="line">No findings yet.</span>
          {/if}
        </a>
      {/if}
    </aside>
  </div>
{/if}
</div>

{#if peekOn !== null}
  <PeekPanel
    bind:this={panel}
    card={peekOn.card}
    snapshot={peekOn.board}
    activity={stream.activity[peekOn.card.key]}
    onclose={closePeek}
  />
{/if}
</div>

<style>
  /* The page and the peek sheet beside it, as on the board. */
  .split {
    display: flex;
  }

  .col {
    flex: 1;
    min-width: 0;
  }

  /* The top bar: 54px, a line under it, the title and the date on the left. */
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    min-height: 54px;
    padding: 0 var(--space-6);
    border-bottom: 1px solid var(--line);
  }

  h1 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .sub,
  .hint {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .hint {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
  }

  .sp {
    flex: 1;
  }

  .icon {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The grey card until the first snapshot lands, in the page's side gutter. */
  .first {
    padding: var(--space-4) var(--space-6) 0;
  }

  .note {
    margin: 0;
    padding: var(--space-2) var(--space-6) 0;
    font-size: var(--text-xs);
    color: var(--ink-3);
  }

  /* The main column and the right column of 300px. The right one goes under the main one when the
     main one has no room left for a Running row, so Stop never sits out of view on a laptop. */
  .page {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 300px;
    align-items: start;
    gap: 28px;
    padding: 28px 32px 40px;
  }

  /* The sheet takes 448px of the width, so the right column goes under the main one, as on a laptop. */
  .page.peeking {
    grid-template-columns: minmax(0, 1fr);
  }

  @media (max-width: 1400px) {
    .page {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (max-width: 760px) {
    .top {
      padding: var(--space-3) var(--space-4);
    }

    .page {
      padding: 20px var(--space-4);
    }
  }

  .main,
  aside {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .main {
    gap: 28px;
  }

  aside {
    gap: var(--space-4);
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* The waiting cards sit closer than the other sections' rows, so two or three fit on a laptop. */
  .waiting {
    gap: var(--space-2);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  h2 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .main h2 {
    font-size: var(--text-md);
  }

  /* A section's count is plain: only the rail's count is a badge. */
  .n {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 400;
    color: var(--muted);
  }

  .empty {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  /* The panel padding. */
  .pad {
    padding: var(--space-4) 18px;
  }

  aside .panel.pad {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* The figures carry their own padding, so the head sits 4px over them. */
  .today {
    gap: 0;
  }

  h2.pad {
    padding: 14px 14px var(--space-1);
  }

  /* The row: pill, key, title with its line, phase, model, and Stop. The rows share one grid, so a
     wider phase on one row moves the column on every row. It scrolls sideways in its own panel on a
     narrow window, never the page. */
  .runs {
    display: grid;
    /* A row's side padding sits inside the first and the last column, so those two carry it. */
    grid-template-columns: calc(112px + var(--space-4)) 92px minmax(160px, 1fr) minmax(88px, auto) 116px calc(34px + var(--space-4));
    column-gap: var(--space-3);
    overflow-x: auto;
  }

  .run {
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: subgrid;
    align-items: center;
    padding: 11px var(--space-4);
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  /* The pill and the phase fill their columns. */
  .run > .pill,
  .phase {
    display: flex;
  }

  .run > .pill :global(.pill),
  .phase :global(.chip:first-child) {
    flex: 1;
  }

  .run:first-child,
  .done:first-child {
    border-top: 0;
  }

  .k,
  .m {
    font-family: var(--font-mono);
    color: var(--muted);
    white-space: nowrap;
  }

  .k {
    font-size: var(--mono-xs);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m {
    font-size: var(--mono-card-key);
  }

  .tt {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .tt a,
  .tt b {
    overflow: hidden;
    font-weight: 500;
    color: var(--ink);
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tt a:hover,
  .what a:hover {
    text-decoration: underline;
  }

  /* The activity line names files and commands, so it is mono, as on the card. */
  .tt span {
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--ink-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A retry reads as a sentence with a countdown, so it wraps and is not cut at the column's edge. */
  .tt span.waits {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--muted);
    white-space: normal;
  }

  .phase {
    gap: var(--space-1);
  }

  .done {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--line);
  }

  .check {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--green-bg);
    color: var(--green);
  }

  .what {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  .what p {
    margin: 0;
    font-size: var(--text-sm);
  }

  .what a {
    font-weight: 500;
    color: var(--ink);
    text-decoration: none;
  }

  /* The run's Markdown, held to three lines: the title links the card, where the rest is. */
  .said {
    max-height: calc(1.55em * 3);
    overflow: hidden;
    font-size: var(--text-base);
    line-height: 1.55;
  }

  .said :global(.markdown) {
    color: var(--ink-2);
  }

  .said :global(.markdown > :first-child) {
    margin-top: 0;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: var(--space-3) 14px;
  }

  .stat b {
    font-family: var(--font-mono);
    font-size: 20px;
    font-weight: 500;
    letter-spacing: -0.02em;
  }

  .stat span {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .eng {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: var(--text-xs);
  }

  .eng p {
    margin: 0;
  }

  .r {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* In words, as the rail's foot says it. */
  .seen {
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  .v {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  /* Ink on a faint track, as the rail draws it: a fainter track would be under 3:1, and amber means a run. */
  .bar {
    height: 4px;
    border-radius: 99px;
    background: var(--faint);
    overflow: hidden;
  }

  .bar i {
    display: block;
    height: 100%;
    border-radius: 99px;
    background: var(--ink-2);
  }

  /* The suggestion: the amber line and bolt, because what it offers starts an agent. */
  .suggest {
    border-color: var(--amber-line);
  }

  aside .panel.suggest {
    gap: 10px;
  }

  .bolt {
    color: var(--amber);
  }

  .ink2 {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
    color: var(--ink-2);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .refused {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  /* The 6px, over the 12px of the other side panels. */
  aside .panel.scout {
    gap: 6px;
    color: var(--ink);
    text-decoration: none;
  }

  .scout:hover {
    border-color: var(--line-2);
  }

  .h {
    display: flex;
    align-items: center;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .new {
    margin-left: auto;
  }

  .title {
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .line {
    font-size: var(--text-xs);
    color: var(--muted);
  }
</style>
