<script lang="ts">
  import type { Snippet } from 'svelte';

  // The explanation of a page, under its title: a few short lines in the information tint. A note and
  // no status, so a screen reader does not announce it as news.
  let { children }: { children: Snippet } = $props();
</script>

<div class="info" role="note" data-info-box>
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v5h1"></path></svg>
  <div class="body">{@render children()}</div>
</div>

<style>
  /* The look of the info Banner, with the icon at the first line, since this box holds several. The
     words are ink, which reaches 4.5:1 on the blue tint (tokens.test.ts). */
  .info {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    box-sizing: border-box;
    width: 100%;
    padding: var(--space-3) 14px;
    border-radius: var(--radius-lg);
    background: var(--blue-bg);
    color: var(--ink);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .icon {
    flex: none;
    width: 16px;
    height: 16px;
    margin-top: 2px;
    fill: none;
    stroke: var(--blue);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    flex: 1;
    min-width: 0;
  }

  .body :global(p) {
    margin: 0;
  }

  .body :global(a) {
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
