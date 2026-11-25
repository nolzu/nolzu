<script lang="ts">
  import { type CardView, estimateBrief, estimateText, type ProfileLimit, type RunActivity, type StageView } from '@nolzu/protocol';
  import { tick, type Snippet } from 'svelte';
  import RoleGlyph from '../RoleGlyph.svelte';
  import BoardCard from './BoardCard.svelte';
  import type { Allowed, Drag } from './drag.ts';
  import { dropOutcome, dropTarget, refuseDrop, startsCommand } from './drop.ts';
  import type { Refusal } from './drop.ts';

  // The board never decides whether a card may land here. `allowed` calls canMove in core, so
  // there is one copy of the rule, and this column only draws what it is told.
  let {
    stage,
    cards = [],
    total = null,
    focusKey = null,
    onFocus = () => {},
    now,
    drag = null,
    allowed = () => false,
    onMove = () => {},
    onDragEnter = () => {},
    onDragLeave = () => {},
    onDragStart = () => {},
    onRefuse = () => {},
    rounds = true,
    activity = {},
    quietAfterMs,
    limits = {},
    aside = undefined,
    cardAction = undefined,
    draggable = true,
    coaching = false,
    shut = false,
    onOpen = () => {},
    onClose,
    fixable = [],
    onFix = () => {},
    placeholder = undefined,
    tags = {},
  }: {
    stage: StageView;
    cards?: readonly CardView[];
    // The column's full count while a filter shows fewer cards, or null when nothing is filtered.
    total?: number | null;
    // Read by nothing now: an empty column folds, so it has no empty line to keep quiet. Kept so a
    // caller built before the fold still type checks.
    quiet?: boolean;
    // The board's one tab stop, when it is a card in this column.
    focusKey?: string | null;
    onFocus?: (key: string) => void;
    now?: Date;
    drag?: Drag | null;
    allowed?: Allowed;
    onMove?: (key: string, stage: string) => void;
    onDragEnter?: (stage: string) => void;
    // `gone` when the pointer went to a place outside this column, which ends the target here.
    onDragLeave?: (stage: string, gone: boolean) => void;
    onDragStart?: (key: string) => void;
    onRefuse?: (refusal: Refusal) => void;
    rounds?: boolean;
    // The last activity of each card's run, by card key, and the time a run may print nothing
    // before its card reads Quiet. Both come from the board.
    activity?: Readonly<Record<string, RunActivity>>;
    quietAfterMs?: number;
    // What each engine profile last reported about its usage windows, for the drop box. Only the local
    // board hands it in, because it stays on this machine.
    limits?: Readonly<Record<string, ProfileLimit>>;
    // Drawn under the cards, such as the first drag's coach note. A column holding one stays open, so
    // the note is there before the drag starts and nothing moves under the pointer when it does.
    aside?: Snippet;
    // Both handed on to each card as they came from the board.
    cardAction?: Snippet<[CardView]>;
    draggable?: boolean;
    // The first drag's coach note shows on this board, so the column holding it draws a resting drop
    // box, and Plan and Implement stay open with the line of what a drop there does.
    coaching?: boolean;
    // An archive column that folds over its cards ("Closed 14") until a click on its strip opens it.
    shut?: boolean;
    onOpen?: () => void;
    // Folds the opened archive column again. Absent on every other column.
    onClose?: () => void;
    // The cards Fix it can run on (a QA FAIL on a board with an Implement column), and what it does.
    fixable?: readonly string[];
    onFix?: (key: string) => void;
    // The sentence of an empty board (EmptyInbox), drawn as a dashed card that is no card: it is not dragged,
    // not focused and not counted. The column holding it stays open.
    placeholder?: Snippet;
    // A word beside a card's key, by card key, such as "Question" on Research. Handed on as it came.
    tags?: Readonly<Record<string, string>>;
  } = $props();

  // One handler, on the column. A drop on a card inside bubbles up to exactly this one, so the
  // move is sent once however deep the pointer was.
  function take(event: DragEvent) {
    event.preventDefault();
    // One pure decision, then obey it. The rule lives in dropOutcome, where a test can kill it,
    // rather than in this handler, which no server rendered test can fire.
    const outcome = dropOutcome(drag, stage, allowed);
    if (outcome === null) return;
    if (outcome.kind === 'refused') onRefuse(outcome.refusal);
    else onMove(outcome.key, outcome.stage);
  }

  // Whether a leave went outside this column. A browser that names no place, as some do, says
  // nothing sure, and the count decides as before.
  function left(event: DragEvent): boolean {
    const to = event.relatedTarget;
    return to instanceof Node && !(event.currentTarget as Node).contains(to);
  }

  const direction = $derived(drag === null ? false : allowed(stage.id));
  // A stage whose stored model the engine no longer reports. Nothing is sent, and the refusal
  // carries the name and the setting that fixes it.
  const refusal = $derived(refuseDrop(stage, direction));
  const target = $derived(direction !== false);
  const box = $derived(target ? dropTarget(stage, direction === 'forward', { limits, now: (now ?? new Date()).getTime() }) : null);

  // Open and Hide swap one button for the other, so focus moves to the new one rather than the page.
  let section: HTMLElement;
  async function swap(run: () => void, to: string) {
    run();
    await tick();
    section.querySelector<HTMLButtonElement>(to)?.focus();
  }

  const open = $derived(cards.filter((card) => !card.minimized));
  const minimized = $derived(cards.filter((card) => card.minimized));
  const cardsWord = (count: number) => (count === 1 ? 'card' : 'cards');
  const FIRST_DRAG_HINTS: Readonly<Record<string, string>> = { plan: 'Drop a card to plan it', implement: 'Drop a card to build it' };

  // An empty column gives its width to the columns with cards. During a drag it opens only under the
  // pointer, so the drop box shows where the card goes. Opening every target at the start moved the
  // columns under a pointer that had not moved, and letting go in place dropped the card on a column
  // nobody pointed at. It never folds over a card, so the arrows, which reach only columns with cards,
  // never point into a strip.
  // While the coach note shows, Plan and Implement stay open with a line on what a drop there does.
  const hint = $derived(coaching && cards.length === 0 ? (FIRST_DRAG_HINTS[stage.starts?.phase ?? ''] ?? null) : null);
  // Closed with cards folds too, and opens like an empty column under a drag.
  const hidden = $derived(shut && cards.length > 0);
  const folded = $derived(((cards.length === 0 && aside === undefined && hint === null && placeholder === undefined) || hidden) && (box === null || drag?.over !== stage.id));
  // What a forward drop starts, from the same dropTarget the drop box reads, so the header cannot
  // promise a start the box refuses. On a drag the stage carries the dragged card's own model, as in
  // the box.
  const starts = $derived(stage.role === 'agent' ? dropTarget(stage, true) : null);
  // An agent stage with no phase, or whose start is refused, starts nothing. It gets no amber, or
  // it promises a run that never happens.
  const startsNothing = $derived(stage.role === 'agent' && starts?.kind !== 'starts');
  // The coach note's column before any drag: a resting box, and the estimate only where measured.
  const resting = $derived(aside !== undefined && box === null && starts?.kind === 'starts');
  // The short form the board draws, "Claude Code · haiku · low · ~$0.05", in the drop box's words
  // so a row moved to another vendor never reads as the old one. A narrow column wraps it. The box
  // says the rest. The figure is there only when something measured the start.
  const startsLine = $derived.by(() => {
    if (starts?.kind !== 'starts' || stage.starts === null) return null;
    const { estimate } = stage.starts;
    return [startsCommand(stage.starts), ...(estimate === undefined ? [] : [estimateBrief(estimate)])].join(' · ');
  });
</script>

{#snippet count()}
  {#if total === null}
    <span class="count" title="{stage.count} {cardsWord(stage.count)}">{stage.count}</span>
  {:else}
    <!-- The space between the two, because Svelte drops one at the start of an element and a screen
         reader would hear "1of 2". Outside the count, so it adds no width to it. -->
    <span class="count" title="{cards.length} of {total} {cardsWord(total)}">{cards.length}</span> <span class="hidden">of {total}</span>
  {/if}
{/snippet}

<!-- A group with a name, because a plain section carrying drop handlers is announced as nothing.
     Folded or open it is the same element, so its name, its handlers and a drop on it stay. -->
<section
  bind:this={section}
  class="column"
  role="group"
  aria-label={stage.label}
  data-stage={stage.id}
  data-role={stage.role}
  data-accent={stage.role === 'agent' && !startsNothing ? 'true' : undefined}
  data-folded={folded ? 'true' : undefined}
  data-count={stage.count}
  data-drop-target={target ? 'true' : undefined}
  data-drop-starts={box?.kind === 'starts' ? 'true' : undefined}
  data-refuses={refusal === null ? undefined : 'true'}
  ondragenter={() => onDragEnter(stage.id)}
  ondragleave={(event) => onDragLeave(stage.id, left(event))}
  ondragover={(event) => event.preventDefault()}
  ondrop={take}
>
  {#if folded && hidden}
    <!-- Closed with its cards: a click opens it until the board is left. -->
    <button class="unfold" type="button" onclick={() => swap(onOpen, '.fold')} aria-label="Show {stage.label}, {stage.count} {cardsWord(stage.count)}">
      <RoleGlyph role={stage.role} {startsNothing} />
      <span class="slim"><span>{stage.label}</span>{@render count()}</span>
    </button>
  {:else if folded}
    <RoleGlyph role={stage.role} {startsNothing} />
    <!-- Set on its side to fit 40px. Only the name and the count, as the boards draw a strip: the open
         header says what a drop starts. -->
    <p class="slim">
      <span>{stage.label}</span>
      {@render count()} <span class="hidden">{cardsWord(total ?? stage.count)}</span>
      {#if stage.cadence !== null}<span>{stage.cadence}</span>{/if}
    </p>
  {:else}
    <header>
      <RoleGlyph role={stage.role} {startsNothing} />
      <span class="label">{stage.label}</span>
      {@render count()}
      {#if onClose !== undefined}
        <button class="fold" type="button" onclick={() => swap(onClose!, '.unfold')} aria-label="Hide {stage.label}">Hide</button>
      {/if}
    </header>

    {#if startsLine !== null}
      <p class="line starts">{startsLine}</p>
    {:else if starts?.kind === 'refused'}
      <p class="line">Refused. {starts.reason}</p>
    {:else if stage.says !== undefined}
      <p class="line">{stage.says}</p>
    {/if}

    {#if stage.cadence !== null}
      <p class="line">{stage.cadence}</p>
    {/if}

    <div class="body">
      {#if placeholder !== undefined}
        <div class="placeholder" data-placeholder>{@render placeholder()}</div>
      {/if}
      <!-- Where the card will land: what starts, on which engine, what it
           likely costs and how much of the five-hour window is used, before the person lets go. -->
      {#if resting && stage.starts !== null}
        <!-- Neutral, not amber: it waits for the drop and starts nothing yet. -->
        <div class="drop rest" data-drop="rest">
          <p class="head">Drop here</p>
          {#if stage.starts.estimate !== undefined}<p class="estimate">{estimateText(stage.starts.estimate)}</p>{/if}
        </div>
      {/if}
      {#if box !== null}
        <div class="drop" data-drop={box.kind} role="status">
          {#if box.kind === 'starts'}
            <p class="head">
              <svg class="bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"></path></svg>Drop to start {stage.label}
            </p>
            <p class="command">{box.command}</p>
            {#if box.estimate !== undefined}
              <p class="estimate">{box.estimate.text}</p>
            {/if}
            {#if box.usage !== undefined}
              <p class="usage">{box.usage}</p>
            {/if}
            <p class="esc">Esc cancels. Moving back never starts a run.</p>
          {:else if box.kind === 'refused'}
            <p class="head">Refused</p>
            <p class="reason">{box.reason}</p>
          {:else}
            <p class="head">{box.says}</p>
          {/if}
        </div>
      {/if}

      {#each open as card (card.key)}
        <BoardCard {card} {now} {onDragStart} focusable={card.key === focusKey} {onFocus} {rounds} activity={activity[card.key]} {quietAfterMs} dragging={drag?.key === card.key} {cardAction} {draggable} {stage} tag={tags[card.key] ?? null} onFix={fixable.includes(card.key) ? onFix : null} />
      {/each}
      {#if hint !== null}<p class="hint">{hint}</p>{/if}
      {@render aside?.()}
    </div>

    {#if minimized.length > 0}
      <div class="strip" data-minimized-strip="true">
        {#each minimized as card (card.key)}
          <BoardCard {card} {now} {onDragStart} focusable={card.key === focusKey} {onFocus} {rounds} activity={activity[card.key]} {quietAfterMs} dragging={drag?.key === card.key} {cardAction} {draggable} {stage} tag={tags[card.key] ?? null} />
        {/each}
      </div>
    {/if}
  {/if}
</section>

<style>
  /* A column shares the board's width and never goes under 212px. No border and no fill, so a person's column sits on the page. It stops
     at 400px, wider than any column of a 1440px board, so one open column on a wide screen keeps a card short
     enough to read. The spare width stays empty on the right of the row. */
  .column {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    min-width: 212px;
    max-width: 400px;
    padding: 6px;
    border-radius: var(--radius-xl);
  }

  /* An empty column, 40px wide, with its glyph on top and its words on their side. */
  [data-folded='true'] {
    flex: 0 0 40px;
    align-items: center;
    gap: var(--space-2);
    min-width: 40px;
    padding: 6px 0;
  }

  /* A strip the card may land on stays folded until the pointer reaches it, and a mark shows it
     meanwhile: the amber ring below when the drop starts a run, else the dashed line of a drop box,
     because a move back or a refused start is no agent at work. Its children take
     no pointer, so the drag enters and leaves the strip itself. Then no element the pointer is on goes
     away when the strip opens, and no leave is lost from the count of enters in drag.ts. */
  [data-folded='true'][data-drop-target='true']:not([data-drop-starts='true']) {
    outline: 1px dashed var(--faint);
    outline-offset: -1px;
  }

  [data-folded='true'][data-drop-target='true'] > * {
    pointer-events: none;
  }

  /* An agent column that starts a run gets the faint amber stripe. The opacity is inside the token,
     so nothing on top of it fades. */
  [data-accent='true'] {
    background: repeating-linear-gradient(135deg, var(--hatch) 0 6px, transparent 6px 12px);
  }

  /* The ring on a target whose drop starts a run, folded or open. Full amber and not
     --amber-line, which is under 3:1, and on a folded strip the ring is the only mark (tokens.test.ts). */
  [data-accent='true'][data-drop-starts='true'] {
    box-shadow: inset 0 0 0 1.5px var(--amber);
  }

  header {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 8px 8px 3px;
  }

  .label {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--ink);
  }

  .count {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  /* The line under the name, 3px under it and 14px over the first card. A person's words
     are in Geist, and what a drop starts is in mono. */
  .line {
    margin: 0;
    padding: 0 8px 3px;
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  .starts {
    font-family: var(--font-mono);
  }

  /* Read bottom to top, so the name comes first. */
  .slim {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding-top: var(--space-2);
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
    color: var(--muted);
  }

  /* The strip's count takes the strip's ink: ink-2 on an agent strip. */
  .slim .count {
    margin-left: 0;
    color: inherit;
  }

  /* The folded Closed strip is one button, drawn as the strip it is. */
  .unfold {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .unfold:hover .slim {
    color: var(--ink);
  }

  /* Hide on the opened Closed header, as quiet as the count beside it. */
  .fold {
    padding: 0 var(--space-1);
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    font: inherit;
    font-size: var(--text-2xs);
    color: var(--muted);
    cursor: pointer;
  }

  .fold:hover {
    color: var(--ink);
  }

  /* The first drag box: centred, 88px high. */
  .rest {
    min-height: 88px;
    align-items: center;
    justify-content: center;
    text-align: center;
  }

  .hint {
    margin: 0;
    padding: 6px 8px;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  [data-accent='true'] .slim {
    color: var(--ink-2);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: 11px;
  }

  /* The empty board's sentence: the drop box's dashed line and a card's corners, so it reads as no card. */
  .placeholder {
    padding: var(--space-3);
    border: 1.5px dashed var(--line-2);
    border-radius: var(--radius-lg);
  }

  /* The drop box: a dashed box, its lines 5px apart. */
  .drop {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: var(--space-3);
    border: 1.5px dashed var(--line-2);
    border-radius: var(--radius-lg);
  }

  .drop p {
    margin: 0;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted);
  }

  [data-drop='starts'] {
    border-color: var(--amber);
    background: var(--amber-bg);
  }

  [data-drop='starts'] .head {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--amber);
  }

  .bolt {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The engine, the model and the effort, the estimate and the usage window, in mono and --ink-2,
     at 11.5px. In the narrowest column, five open at 1440, a line breaks after a dot. A model id too long for the box breaks inside the word
     rather than run past the edge. Never amber: they say what starts, they are not the start. */
  .command,
  .estimate,
  .usage {
    font-family: var(--font-mono);
    font-size: var(--mono-card-key);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  /* --muted, which tokens.test.ts holds at 4.5:1 on the drop box over the hatch. */
  .esc {
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  [data-drop='refused'] {
    border-color: var(--red);
  }

  [data-drop='refused'] .head {
    color: var(--red);
  }

  .reason {
    font-size: var(--text-xs);
    color: var(--ink-3);
  }

  .strip {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-top: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  /* An archive column is quieter than the rest, because nothing there needs attention. Fading the
     whole column would take its text below 4.5:1, so only its name goes to muted and
     every text keeps its contrast. */
  [data-role='archive'] .label {
    color: var(--muted);
  }

  /* Read out, not shown: the full count while a filter is on, and the word after a folded count. A
     title alone does not reach a screen reader. */
  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
