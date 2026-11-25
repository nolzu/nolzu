<script lang="ts">
  // Grey shapes in the place of a part that is still on its way, drawn like the part, so nothing jumps
  // when it lands. The shapes are hidden from screen readers, which read `label` instead.
  let {
    shape = 'block',
    label,
    width = '160px',
    height = '80px',
    count = 3,
  }: {
    // line: one bar. block: a box. rows: list rows of a dot, a name and a meta line. list: rows of a
    // name over a meta line, for a narrow column. text: the lines of a paragraph. card: a tile.
    // pill: an inline count.
    shape?: 'line' | 'block' | 'rows' | 'list' | 'text' | 'card' | 'pill';
    label: string;
    // The line's width and the block's height.
    width?: string;
    height?: string;
    // How many rows, or lines of text.
    count?: number;
  } = $props();
</script>

<span class="skeleton" data-shape={shape} data-skeleton>
  <span class="shapes" aria-hidden="true">
    {#if shape === 'line'}
      <span class="bone" style:width></span>
    {:else if shape === 'block'}
      <span class="bone box" style:height></span>
    {:else if shape === 'rows'}
      {#each { length: count }, n (n)}
        <span class="row"><span class="bone dot"></span><span class="bone name"></span><span class="bone meta"></span></span>
      {/each}
    {:else if shape === 'list'}
      {#each { length: count }, n (n)}
        <span class="item"><span class="bone name"></span><span class="bone meta"></span></span>
      {/each}
    {:else if shape === 'text'}
      {#each { length: count }, n (n)}
        <span class="bone line" class:short={n === count - 1}></span>
      {/each}
    {:else if shape === 'card'}
      <span class="card"><span class="bone title"></span><span class="bone"></span><span class="bone short"></span></span>
    {:else}
      <span class="bone pill"></span>
    {/if}
  </span>
  <span class="sr">{label}</span>
</span>

<style>
  .skeleton,
  .shapes {
    display: block;
  }

  /* Nothing seen for a wait under 200ms, so a fast answer does not flash grey. The room is kept. */
  .skeleton {
    animation: appear 0s linear 200ms both;
  }

  @keyframes appear {
    from {
      visibility: hidden;
    }
    to {
      visibility: visible;
    }
  }

  .skeleton[data-shape='pill'],
  .skeleton[data-shape='pill'] .shapes {
    display: inline-block;
    vertical-align: middle;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* A slow change between the two line greys. No shimmer sweep, which reads as busy on a big box. */
  .bone {
    display: block;
    max-width: 100%;
    height: 10px;
    border-radius: var(--radius-sm);
    background: var(--line);
    animation: pulse 1.6s ease-in-out infinite alternate;
  }

  .box {
    border-radius: var(--radius-lg);
  }

  /* The row of a list: the same grid, padding and line between rows as the Tools rows on Settings,
     Engines, which first drew this shape. One column on a narrow screen. */
  .row {
    display: grid;
    grid-template-columns: 18px minmax(0, 250px) minmax(0, 1fr);
    align-items: center;
    gap: 6px 14px;
    padding: 13px 16px;
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .row:first-child {
    border-top: 0;
  }

  .dot {
    width: 18px;
    height: 18px;
    border-radius: 50%;
  }

  /* Each bar takes the height of the text line it stands for, so a skeleton row is as tall as a row
     of a found tool: a name line, then a mono path line (beside it, or under it on a narrow screen). */
  .name,
  .meta {
    margin-block: calc((1lh - 10px) / 2);
  }

  .name {
    width: 120px;
  }

  .meta {
    width: 180px;
    font-size: var(--mono-xs);
  }

  /* The row of a list in a side column, as the Workspace folders and the Knowledge files draw it. */
  .item {
    display: flex;
    flex-direction: column;
    padding: 8px var(--space-3);
    font-size: var(--text-sm);
  }

  .line {
    width: 100%;
    margin-block: calc((1lh - 10px) / 2);
    font-size: var(--text-sm);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .title {
    width: 60%;
    height: 12px;
  }

  .short {
    width: 40%;
  }

  .pill {
    width: 22px;
    height: 14px;
    border-radius: 999px;
  }

  @keyframes pulse {
    to {
      background: var(--line-2);
    }
  }

  /* Said here too, so the shapes stay still even if the global motion rule changes. */
  @media (prefers-reduced-motion: reduce) {
    .bone {
      animation: none;
    }
  }

  @media (max-width: 760px) {
    .row {
      grid-template-columns: 18px minmax(0, 1fr);
    }

    .meta {
      grid-column: 2;
    }
  }
</style>
