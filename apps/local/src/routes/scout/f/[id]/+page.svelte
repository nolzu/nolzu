<script lang="ts">
  import ScoutPage from '$lib/ScoutPage.svelte';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<!-- The id and never the collected line: a pasted message can hold a real token, and a page title is
     one of the places it must not reach. -->
<svelte:head><title>Finding {data.finding.row.id} · Nolzu</title></svelte:head>

<ScoutPage {data} {form} detail={data.finding} />
