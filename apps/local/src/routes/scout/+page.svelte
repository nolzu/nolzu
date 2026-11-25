<script lang="ts">
  import ScoutPage from '$lib/ScoutPage.svelte';
  import type { ActionData, PageData } from './$types';

  // `PageData`, because the plan comes from the layout.
  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head><title>Scout · Nolzu</title></svelte:head>

<ScoutPage {data} {form} detail={data.finding} />
