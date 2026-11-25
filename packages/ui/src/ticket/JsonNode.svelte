<script lang="ts">
  import { untrack } from 'svelte';
  import JsonNode from './JsonNode.svelte';
  import { JSON_OPEN_LEVELS, JSON_PAGE, jsonCount, jsonEntries, jsonKind, jsonLeaf } from './json-tree.ts';

  let { name = null, value, depth = 0 }: { name?: string | number | null; value: unknown; depth?: number } = $props();

  const kind = $derived(jsonKind(value));
  // A native disclosure, so the keyboard and the expanded state come with it. The children are drawn
  // only while it is open, because a big file holds thousands of nodes nobody unfolds.
  let open = $state(untrack(() => depth < JSON_OPEN_LEVELS));
  // How many children show, one page at first and one more on each press.
  let shown = $state(JSON_PAGE);
  const entries = $derived(jsonEntries(value));
</script>

{#snippet key()}
  {#if name !== null}<span class="key">{typeof name === 'number' ? name : JSON.stringify(name)}</span><span class="punct">: </span>{/if}
{/snippet}

{#if kind === 'object' || kind === 'array'}
  <details class="node" bind:open data-json-depth={depth}>
    <summary>{@render key()}<span class="punct">{kind === 'array' ? '[' : '{'}</span><span class="count">{jsonCount(value)}</span><span class="punct">{kind === 'array' ? ']' : '}'}</span></summary>
    {#if open}
      <ul>
        {#each entries.slice(0, shown) as [child, item] (child)}
          <li><JsonNode name={child} value={item} depth={depth + 1} /></li>
        {/each}
        {#if entries.length > shown}
          <li><button type="button" class="more" data-json-more onclick={() => (shown += JSON_PAGE)}>Show {Math.min(JSON_PAGE, entries.length - shown)} more of {entries.length - shown}</button></li>
        {/if}
      </ul>
    {/if}
  </details>
{:else}
  <span class="leaf">{@render key()}<span class={kind}>{jsonLeaf(value)}</span></span>
{/if}

<style>
  .node > summary {
    cursor: pointer;
    border-radius: var(--radius-xs);
  }

  .node > summary:hover {
    background: var(--card-2);
  }

  ul {
    margin: 0;
    padding: 0 0 0 var(--space-4);
    list-style: none;
    border-left: 1px solid var(--line);
  }

  .more {
    margin: 2px 0 2px 14px;
    padding: 0 var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--card);
    color: var(--ink-2);
    font: inherit;
    cursor: pointer;
  }

  .more:hover {
    color: var(--ink);
  }

  .leaf {
    display: block;
    padding-left: 14px;
  }

  .key {
    color: var(--ink);
  }

  .punct,
  .count {
    color: var(--muted);
  }

  .count {
    padding: 0 var(--space-1);
  }

  /* No amber: amber means an agent starts work. Each status colour reaches 4.5:1 as text on every
     surface in both themes (tokens.test.ts). */
  .string {
    color: var(--green);
  }

  .number {
    color: var(--blue);
  }

  .boolean {
    color: var(--violet);
  }

  .null {
    color: var(--muted);
  }
</style>
