<script lang="ts">
  import type { Snippet } from 'svelte';

  // Each kind has its own icon, so the kind is not told by the tint alone.
  let { kind = 'info', children }: { kind?: 'info' | 'ok' | 'warning' | 'error'; children: Snippet } = $props();
</script>

<div class="banner" data-kind={kind} role={kind === 'error' ? 'alert' : 'status'}>
  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
    {#if kind === 'info'}
      <circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v5h1"></path>
    {:else if kind === 'ok'}
      <path d="m5 12 5 5 9-10"></path>
    {:else if kind === 'warning'}
      <path d="M12 3 2 20h20L12 3Z"></path><path d="M12 10v4M12 17h.01"></path>
    {:else}
      <path d="M6 6l12 12M18 6 6 18"></path>
    {/if}
  </svg>
  <div class="body">{@render children()}</div>
</div>

<style>
  /* The words are ink on every kind. Ink reaches 4.5:1 on each status tint over every surface, which
     tokens.test.ts holds. */
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    padding: 10px 14px;
    border-radius: var(--radius-lg);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .icon {
    flex: none;
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .body {
    flex: 1;
    min-width: 0;
  }

  [data-kind='info'] {
    background: var(--blue-bg);
  }

  [data-kind='info'] .icon {
    color: var(--blue);
  }

  [data-kind='ok'] {
    background: var(--green-bg);
  }

  [data-kind='ok'] .icon {
    color: var(--green);
  }

  [data-kind='error'] {
    background: var(--red-bg);
  }

  [data-kind='error'] .icon {
    color: var(--red);
  }

  /* Amber means a run starts, so a warning is a neutral box with a muted edge and the warning icon
     (`docs/design-system.md`). */
  [data-kind='warning'] {
    border: 1px solid var(--line-2);
    border-left: 2px solid var(--muted);
    background: var(--card);
  }

  [data-kind='warning'] .icon {
    color: var(--muted);
  }
</style>
