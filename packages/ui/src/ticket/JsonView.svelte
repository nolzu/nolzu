<script lang="ts">
  import JsonNode from './JsonNode.svelte';
  import { readJson } from './json-tree.ts';

  // The text the viewer already read under its size cap.
  let { text }: { text: string } = $props();

  const parsed = $derived(readJson(text));
  // A file whose numbers the tree cannot show exactly opens on the raw text, with a line that says why.
  let picked = $state<boolean | null>(null);
  const raw = $derived(picked ?? parsed?.lossy === true);
</script>

{#if parsed === null}
  <p class="quiet" role="status">This file could not be read as JSON, so it shows as plain text.</p>
  <pre>{text}</pre>
{:else}
  <div class="bar">
    <span class="seg" role="group" aria-label="Show">
      <button type="button" data-mode="tree" aria-pressed={!raw} onclick={() => (picked = false)}>Tree</button>
      <button type="button" data-mode="raw" aria-pressed={raw} onclick={() => (picked = true)}>Raw</button>
    </span>
  </div>
  {#if parsed.lossy}
    <p class="quiet" role="status">Some numbers here have more digits than the tree can show exactly, so the file opens on Raw.</p>
  {/if}
  {#if raw}
    <pre>{text}</pre>
  {:else}
    <div class="tree" data-json-tree><JsonNode value={parsed.value} /></div>
  {/if}
{/if}

<style>
  .bar {
    margin-bottom: var(--space-3);
  }

  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .seg button {
    height: 24px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .seg button[aria-pressed='true'] {
    background: var(--card-2);
    color: var(--ink);
  }

  .tree,
  pre {
    max-width: min(100%, 120ch);
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  pre {
    white-space: pre-wrap;
  }

  .quiet {
    margin: 0 0 var(--space-3);
    font-size: var(--text-xs);
    color: var(--muted);
  }
</style>
