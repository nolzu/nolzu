<script lang="ts">
  import NowPage from '$lib/NowPage.svelte';
  import { nowLive } from '$lib/now-live.svelte.ts';
</script>

<!-- Now, at the root. Every board sits at /b/<board>. -->
<NowPage stream={nowLive.state} />
