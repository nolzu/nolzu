<script lang="ts">
  import { page } from '$app/state';
</script>

<!-- SvelteKit's own error page has no padding, so its text sat on the rail's edge. The words stay its own. -->
<svelte:head><title>{page.status} {page.error?.message} · Nolzu</title></svelte:head>

<div class="error">
  <h1>{page.status}</h1>
  <p>{page.error?.message}</p>
</div>

<style>
  .error {
    padding: 16px 14px 60px;
  }
</style>
