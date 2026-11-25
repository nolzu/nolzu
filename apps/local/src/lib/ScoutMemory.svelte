<script lang="ts">
  import { Button } from '@nolzu/ui';
  import type { Snippet } from 'svelte';
  import type { ScoutFindingRow } from '$lib/scout-findings.ts';

  // The muted findings, folded into "Muted (n)" at the end of the inbox list.
  // The row is the list's own (`item`), so a muted finding reads the way a listed one does. The fold
  // is open while the finding on show is a muted one, so its row is in view.
  //
  // Unmute posts to the finding's own page and not to the list: after the post that page shows the
  // finding and the answer beside it, wherever it landed in the list.
  let {
    rows,
    selected = null,
    item,
    href,
  }: { rows: readonly ScoutFindingRow[]; selected?: number | null; item: Snippet<[ScoutFindingRow]>; href: (id: number) => string } = $props();
</script>

{#if rows.length > 0}
  <details class="muted" id="muted" open={rows.some((row) => row.id === selected)}>
    <summary>Muted ({rows.length})</summary>
    <ul>
      {#each rows as row (row.id)}
        <li>
          {@render item(row)}
          <!-- Named by the row's title through aria-describedby and never by an aria-label: the only
               words that name a row are the collected line, which may hold a token. -->
          <form method="POST" action="{href(row.id)}?/unmute#actions-title">
            <input type="hidden" name="id" value={row.id} />
            <Button type="submit" size="small" aria-describedby="finding-{row.id}">Unmute</Button>
          </form>
        </li>
      {/each}
    </ul>
  </details>
{/if}

<style>
  .muted {
    margin-top: 10px;
    border-top: 1px solid var(--line);
  }

  summary {
    padding: var(--space-3);
    font-size: var(--text-xs);
    color: var(--muted);
    cursor: pointer;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* The row takes the width, and Unmute sits at its right edge. */
  li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-2);
  }

  form {
    margin: 0 var(--space-3) 0 0;
  }
</style>
