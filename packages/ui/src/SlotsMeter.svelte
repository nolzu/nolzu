<script lang="ts">
  import type { SlotMeter } from '@nolzu/protocol';

  // The snapshot's own count, so the meter shows what the scheduler runs and never a number a click
  // guessed. A sender with no slots sends a total of 0, and then there is nothing to show.
  let { slots }: { slots: SlotMeter } = $props();
</script>

{#if slots.total > 0}
  <span class="meter">
    <!-- The blocks repeat the sentence beside them, so a screen reader hears the sentence once. -->
    <span class="blocks" aria-hidden="true">
      {#each { length: slots.total }, at}<i data-busy={at < slots.busy ? 'true' : undefined}></i>{/each}
    </span>
    <span class="words">{slots.busy} of {slots.total} agent slots busy</span>
  </span>
{/if}

<style>
  .meter {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  .blocks {
    display: inline-flex;
    gap: 3px;
  }

  /* Faint and not line-2, for the 3:1 of a mark. A 3px radius is not on the scale, so a
     block takes the key cap radius. */
  i {
    width: 28px;
    height: 8px;
    border-radius: var(--radius-xs);
    background: var(--faint);
  }

  /* A busy slot is an agent at work, so it is amber. */
  [data-busy='true'] {
    background: var(--amber);
  }

  .words {
    color: var(--muted);
    font-size: var(--text-xs);
  }
</style>
