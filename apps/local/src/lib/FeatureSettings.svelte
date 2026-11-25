<script lang="ts">
  import { featureFailed, featureSettings } from '$lib/features.svelte.ts';

  const blocks = $derived(featureSettings());
</script>

{#each blocks as block (block.id)}
  {@const Block = block.component}
  <section class="panel" id={block.id} aria-labelledby="{block.id}-title">
    <h2 id="{block.id}-title">{block.title}</h2>
    <svelte:boundary onerror={featureFailed}>
      <Block />
      {#snippet failed()}
        <p class="failed">This settings section stopped drawing. The other sections are not affected.</p>
      {/snippet}
    </svelte:boundary>
  </section>
{/each}

<style>
  .panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    overflow: hidden;
  }

  .failed {
    margin: 10px 14px;
    font-size: var(--text-sm);
    color: var(--ink-2);
  }

  h2 {
    margin: 0;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    font-size: var(--text-sm);
    font-weight: 500;
  }
</style>
