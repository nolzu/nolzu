<script lang="ts">
  import { resolve } from '$app/paths';
  import type { CardView, RunActivity, StageView } from '@nolzu/protocol';
  import { cardPill, liveOf, ranOn, StatePill } from '@nolzu/ui';

  // The board's List view: the same cards as rows, in the board's order, which the page hands in. Each
  // row is an `article[data-card]` like a board card, so the page's open, peek and move keys reach it
  // the same way. Busy state is the snapshot's, as on the board.
  let {
    cards,
    stages,
    activity = {},
    quietAfterMs,
    now,
    selected = null,
    onSelect,
    empty,
    tags = {},
  }: {
    cards: readonly CardView[];
    stages: readonly StageView[];
    activity?: Readonly<Record<string, RunActivity>>;
    quietAfterMs?: number;
    now: Date;
    selected?: string | null;
    onSelect: (key: string) => void;
    // The one line said when no card is shown.
    empty: string;
    // A word before a card's title, by card key: "Question" or "Investigation" on Research.
    tags?: Readonly<Record<string, string>>;
  } = $props();

  const labels = $derived(new Map(stages.map((stage) => [stage.id, stage.label])));
  // One tab stop, as on the board: the selected row while it is shown, else the first.
  const focusKey = $derived(selected !== null && cards.some((card) => card.key === selected) ? selected : (cards[0]?.key ?? null));
</script>

{#if cards.length === 0}
  <p class="nothing">{empty}</p>
{:else}
  <div class="list" data-board-list>
    {#each cards as card (card.key)}
      {@const pill = cardPill(card, liveOf(card, activity[card.key], now, quietAfterMs), now, stages.find((stage) => stage.id === card.stage))}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <!-- The list's one focus stop, moved by the arrow keys and peeked at with Enter, as a board card is. -->
      <article class="row" data-card={card.key} data-state={card.state} role="group" aria-label={card.key} tabindex={card.key === focusKey ? 0 : -1} onfocus={() => onSelect(card.key)}>
        <span class="key">{card.key}</span>
        <span class="name">
          {#if tags[card.key] !== undefined}<span class="tag" data-card-tag>{tags[card.key]}</span>{/if}
          <a class="title" href={resolve('/t/[key]', { key: encodeURIComponent(card.key) })} tabindex="-1">{card.title}</a>
        </span>
        <span class="column">{labels.get(card.stage) ?? card.stage}</span>
        <span class="pill"><StatePill state={pill.state} word={pill.word} detail={pill.detail} check={pill.check} /></span>
        <!-- The engine before the model, as on a board card: one model name can run on two engines. -->
        <span class="model">{card.model === null ? '' : ranOn(card.engine, card.model, null)}</span>
      </article>
    {/each}
  </div>
{/if}

<style>
  .nothing {
    margin: 0;
    padding: var(--space-4) var(--space-6) 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .list {
    display: flex;
    flex: 1;
    flex-direction: column;
    padding: var(--space-4) var(--space-6) var(--space-6);
  }

  .row {
    display: grid;
    grid-template-columns: 7rem minmax(0, 1fr) 9rem 9rem 8rem;
    align-items: center;
    gap: var(--space-3);
    min-height: 40px;
    padding: 0 var(--space-3);
    border-bottom: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .row:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }

  /* On a phone the row wraps: key and title first, the rest under them. */
  @media (max-width: 760px) {
    .row {
      grid-template-columns: auto minmax(0, 1fr);
      padding: var(--space-2) 0;
    }
  }

  .key,
  .model {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--muted);
  }

  .name {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .tag {
    flex: none;
    padding: 0 6px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-2xs);
    line-height: 16px;
    color: var(--ink-2);
  }

  .title {
    overflow: hidden;
    color: var(--ink);
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .column {
    color: var(--ink-2);
  }
</style>
