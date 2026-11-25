<script lang="ts">
  import { onMount } from 'svelte';
  import { sanitize } from './markdown.ts';

  let { source, headingsFrom = 1 }: { source: string; headingsFrom?: number } = $props();

  // onMount never runs on the server, so the server shows the source as text and only the
  // browser, which has the DOM that DOMPurify needs, renders markup. With no DOM, DOMPurify
  // hands its input back uncleaned, so the server must not even try.
  let mounted = $state(false);
  onMount(() => {
    mounted = true;
  });
  const html = $derived(mounted ? sanitize(source, { headingsFrom }) : null);
</script>

{#if html === null}
  <pre class="markdown">{source}</pre>
{:else}
  <!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitize() is the one gate for markup, and this is its only outlet -->
  <div class="markdown">{@html html}</div>
{/if}

<style>
  /* Long text fills its box, and stops at 120ch only on a very wide screen: fuller lines
     over a short measure that leaves the box half empty. */
  .markdown {
    min-width: 0;
    max-width: min(100%, 120ch);
    color: var(--ink);
    font-size: var(--text-base);
  }

  /* The rendered markup arrives through @html, so these reach it with :global under the box. Inline
     code breaks inside a word only when the word cannot fit on a line of its own, so a path stays whole
     where it can. A code block keeps its lines and scrolls inside the box. */
  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    overflow-wrap: anywhere;
  }

  .markdown :global(pre) {
    max-width: 100%;
    overflow-x: auto;
  }

  .markdown :global(table) {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }

  pre.markdown {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
