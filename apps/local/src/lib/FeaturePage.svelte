<script lang="ts">
  import { featureFailed, featureRoute } from '$lib/features.svelte.ts';

  let { path }: { path: string } = $props();

  const found = $derived(featureRoute(path));
</script>

<svelte:head><title>{found?.title ?? 'No page here'} · Nolzu</title></svelte:head>

{#if found !== null}
  {@const Page = found.component}
  <svelte:boundary onerror={featureFailed}>
    <Page />
    {#snippet failed()}
      <p class="missing">This feature page stopped drawing. The rest of the app is not affected.</p>
    {/snippet}
  </svelte:boundary>
{:else}
  <p class="missing">No feature answers at /f/{path}. A feature adds its own pages when it loads, and this one is not loaded.</p>
{/if}

<style>
  .missing {
    margin: 16px 14px;
    font-size: var(--text-sm);
    color: var(--ink-2);
  }
</style>
