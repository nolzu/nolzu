<script lang="ts">
  import { page } from '$app/state';
  import FeaturePage from '$lib/FeaturePage.svelte';
</script>

<FeaturePage path={page.params.path ?? ''} />
