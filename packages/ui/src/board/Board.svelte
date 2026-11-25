<script lang="ts">
  import { type BoardSnapshot, type CardView, cardStarts, type ProfileLimit, type RunActivity, type StageView } from '@nolzu/protocol';
  import type { Snippet } from 'svelte';
  import { fixItOf } from '../ticket/decision.ts';
  import BoardColumn from './BoardColumn.svelte';
  import EmptyInbox from './EmptyInbox.svelte';
  import type { Allowed, Drag } from './drag.ts';
  import type { Refusal } from './drop.ts';
  import { keepDrag } from './drag.ts';
  import { matchesFilter, waitingOnMe } from './filter.ts';
  import { shutColumns, visibleColumns } from './keys.ts';

  // Stages arrive as data and no stage id is written here, so every board draws through this one
  // component and a new board needs no rewrite here.
  // A fixed clock can be passed in, which is what the tests do. Without one the board keeps its
  // own and moves it every second, so a running card's elapsed time actually counts up. The
  // snapshot carries no elapsed number on purpose: the browser counts, not the server.
  let {
    snapshot,
    // Waiting on me: only the cards a person has to act on.
    filtered = false,
    // The filter box: only the cards whose key or title holds this text. Empty keeps every card.
    query = '',
    // The card the keys last reached. The page owns it, because the keys are the page's.
    selected = null,
    onSelect = () => {},
    now: fixed,
    drag = null,
    allowed = () => false,
    onMove = () => {},
    onDragEnter = () => {},
    onDragLeave = () => {},
    onDragStart = () => {},
    onDragEnd = () => {},
    onRefuse = () => {},
    activity = {},
    limits = {},
    aside = null,
    cardAction = undefined,
    draggable = true,
    archiveOpen = $bindable(false),
    onFix = null,
    tags = {},
  }: {
    snapshot: BoardSnapshot;
    // The last activity of each card's run, by card key, from the stream's own event. It never comes
    // inside the snapshot, because it names files.
    activity?: Readonly<Record<string, RunActivity>>;
    // What each engine profile last reported about its usage windows, by profile id, for the drop box.
    // Only the local board has it: limit state never leaves the machine.
    limits?: Readonly<Record<string, ProfileLimit>>;
    filtered?: boolean;
    query?: string;
    selected?: string | null;
    onSelect?: (key: string) => void;
    now?: Date;
    drag?: Drag | null;
    allowed?: Allowed;
    onMove?: (key: string, stage: string) => void;
    onDragEnter?: (stage: string) => void;
    onDragLeave?: (stage: string, gone: boolean) => void;
    onDragStart?: (key: string) => void;
    // Every drop and every drag end, after the column has had its say. A drop back on the column the
    // card came from moves nothing, and without this the other columns stayed marked as targets.
    onDragEnd?: () => void;
    // Carried, not handled. The column decides and this only hands the answer on, because a refusal
    // the board keeps to itself is a card that will not move with nothing said about why.
    onRefuse?: (refusal: Refusal) => void;
    // Something the page draws inside one column, under its cards, such as the first drag's coach note.
    // The page decides what and where; the board only hands it to that column.
    aside?: { stage: string; content: Snippet } | null;
    // Something the page draws inside each full card, under its meta row, such as the web's Move
    // forward. The card keeps clicks and drags in it to the snippet.
    cardAction?: Snippet<[CardView]>;
    // False on a page that cannot move a card, such as the web, so a card never looks like it can be
    // picked up there.
    draggable?: boolean;
    // Closed folds over its cards until a click on its strip opens it. The page
    // binds it, so it holds until the board is left and the arrows skip the folded cards.
    archiveOpen?: boolean;
    // Fix it on a card whose QA failed. The page asks first with the same confirm as R. Null draws none.
    onFix?: ((key: string) => void) | null;
    // A word beside a card's key, by card key: "Question" or "Investigation" on Research.
    tags?: Readonly<Record<string, string>>;
  } = $props();

  let ticking = $state(new Date());

  $effect(() => {
    // A board given a fixed clock needs no timer, and one that ran anyway woke the page every
    // second for nothing.
    if (fixed !== undefined) return;
    // Started fresh, so a board that had a fixed clock and then lost it does not show the time
    // the clock stopped at until the first tick.
    ticking = new Date();
    const timer = setInterval(() => {
      ticking = new Date();
    }, 1000);
    return () => clearInterval(timer);
  });

  const now = $derived(fixed ?? ticking);

  // A snapshot can arrive while a card is being dragged. If it queues that card, the drag goes:
  // holding it would send a move the server refuses, after the person already let go.
  const live = $derived(keepDrag(drag, snapshot.cards));
  // While a card is dragged, each column says what that card starts, its own model over the stage's.
  const dragged = $derived(live === null ? null : (snapshot.cards.find((card) => card.key === live.key) ?? null));
  const forDrag = (stage: StageView): StageView => (dragged?.starts ? { ...stage, starts: cardStarts(stage, dragged) } : stage);

  const typed = $derived(query.trim() !== '');
  const shown = $derived(snapshot.cards.filter((card) => (!filtered || waitingOnMe(card)) && matchesFilter(card, query)));
  // Said once for the board, not once per column, when the filter leaves nothing.
  // Exactly one tab stop: the selected card while it is shown, else the first card shown.
  const shut = $derived(shutColumns(snapshot.stages, archiveOpen));
  const reachable = $derived(visibleColumns(snapshot.stages, shown, shut).flat());
  const fixable = $derived(onFix === null ? [] : snapshot.cards.filter((card) => fixItOf(card, snapshot.stages) !== null).map((card) => card.key));
  const focusKey = $derived(selected !== null && reachable.includes(selected) ? selected : (reachable[0] ?? null));
  const nothing = $derived(shown.length === 0 && snapshot.cards.length > 0);
  const empty = $derived(snapshot.cards.length === 0);
</script>

<!-- The first column of an empty board opens with what goes here and how to add it, the same shape
     on every board. -->
{#snippet firstSteps()}
  <EmptyInbox kind={snapshot.kind} />
{/snippet}
<!-- Always in the page, so a screen reader is already listening when the text arrives. -->
<p class="nothing" role="status">{nothing ? (typed ? 'No card matches the filter.' : 'Nothing waiting on you.') : ''}</p>

<!-- On the board and not on each column, so a drop anywhere, and a drag let go off the board, both
     reach it. A column's own drop handler runs first, because the event bubbles up to here. -->
<div class="board" data-flow={snapshot.flow} role="presentation" ondrop={onDragEnd} ondragend={onDragEnd}>
  {#each snapshot.stages as stage, at (stage.id)}
    <BoardColumn
      {now}
      stage={forDrag(stage)}
      drag={live}
      {allowed}
      {onMove}
      {onDragEnter}
      {onDragLeave}
      {onDragStart}
      {onRefuse}
      cards={shown.filter((card) => card.stage === stage.id)}
      total={filtered || typed ? stage.count : null}
      {focusKey}
      onFocus={onSelect}
      rounds={snapshot.kind === 'prreview'}
      {activity}
      quietAfterMs={snapshot.quietAfterMs}
      {limits}
      aside={aside?.stage === stage.id ? aside.content : undefined}
      {cardAction}
      {draggable}
      coaching={aside !== null}
      shut={shut.includes(stage.id)}
      onOpen={() => (archiveOpen = true)}
      onClose={archiveOpen && stage.role === 'archive' ? () => (archiveOpen = false) : undefined}
      {fixable}
      onFix={onFix ?? undefined}
      placeholder={empty && at === 0 ? firstSteps : undefined}
      {tags}
    />
  {/each}
</div>

<style>
  /* One quiet line where the cards would be, muted at 13px as every empty line is. */
  .nothing {
    margin: 0;
    padding: var(--space-4) var(--space-6) 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .nothing:empty {
    padding: 0;
  }

  /* The columns share the width and an empty one folds to 40px, so all nine Delivery columns fit at
     1440px while four of them are empty. An open column stops at its maximum and the row stays packed
     on the left, so on a wide screen the folded strips follow the last open column. With more open
     columns than fit at 212px the row scrolls sideways, rather than squeezing every column until none of them is readable. It takes the height
     its page gives it and stretches the columns, so the hatch and a folded strip run to the foot. */
  .board {
    display: flex;
    flex: 1;
    align-items: stretch;
    gap: var(--space-2);
    overflow-x: auto;
    padding: var(--space-4) var(--space-5) var(--space-6);
    background: var(--bg);
  }
</style>
