<script lang="ts">
  import { featureFailed, featurePanels } from '$lib/features.svelte.ts';

  let { name }: { name: string } = $props();

  const panels = $derived(featurePanels(name));
</script>

{#each panels as panel, index (index)}
  {@const Panel = panel.component}
  <!-- This slot sits in the layout, so on every route. Without the boundary a panel that throws
  while it draws takes the whole app down, and the panel is code the app downloaded. -->
  <svelte:boundary onerror={featureFailed}>
    <Panel />
    {#snippet failed()}
      <p class="failed">A feature panel stopped drawing. The board is not affected.</p>
    {/snippet}
  </svelte:boundary>
{/each}

<style>
  .failed {
    margin: 16px 14px;
    font-size: var(--text-sm);
    color: var(--ink-2);
  }
</style>
