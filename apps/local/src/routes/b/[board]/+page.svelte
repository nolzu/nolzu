<script lang="ts">
  import BoardPage from '$lib/BoardPage.svelte';
  import BoardOff from '$lib/BoardOff.svelte';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<!-- An off board draws none of its cards. They stay as they are, and each card's own page still opens. -->
{#if data.off === null}
<BoardPage />
{:else}
<BoardOff kind={data.off} />
{/if}
