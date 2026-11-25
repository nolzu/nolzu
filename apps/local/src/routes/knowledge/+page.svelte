<script lang="ts">
  import { KnowledgeBrowser, scoped } from '@nolzu/ui';
  import { applyAction, deserialize } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { knowledgeRun } from '$lib/now.ts';
  import { nowLive } from '$lib/now-live.svelte.ts';
  import { pageKeys } from '$lib/page-keys.svelte.ts';
  import Streamed from '$lib/Streamed.svelte';
  import type { ActionData, PageServerData } from './$types';

  let { data, form }: { data: PageServerData; form: ActionData } = $props();

  // "/" puts the focus in Search knowledge, through the layout's one key handler.
  let browser = $state<ReturnType<typeof KnowledgeBrowser>>();
  $effect(() => pageKeys.show({ keys: scoped('knowledge'), actions: { find: () => browser?.focusSearch() } }));

  // The lock line and Pending review come from the load. The rail's stream says when the knowledge lane
  // changes hands, and the page reads again then, so the line goes when the run ends and what it wrote
  // shows up without a reload.
  const holder = $derived(nowLive.state.snapshot?.boards.flatMap((board) => board.lanes).find((lane) => lane.name === 'knowledge')?.heldBy);
  let seenHolder: string | null | undefined;
  $effect(() => {
    const now = nowLive.state.snapshot === null ? undefined : (holder ?? null);
    if (now === undefined) return;
    if (seenHolder !== undefined && seenHolder !== now) void invalidateAll();
    seenHolder = now;
  });

  // The knowledge run going, named and timed off the same stream, with a clock that ticks only while
  // one goes.
  const running = $derived(knowledgeRun(nowLive.state.snapshot, nowLive.state.activity));
  let now = $state(new Date());
  $effect(() => {
    if (running === null) return;
    now = new Date();
    const tick = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(tick);
  });

  // Apply and Return post in place: a plain post loads the page at its top, far from the answer,
  // which reads as nothing happened. The answer lands in `form`.
  async function onpost(sent: HTMLFormElement): Promise<void> {
    try {
      const response = await fetch(sent.action, { method: 'POST', body: new FormData(sent), headers: { 'x-sveltekit-action': 'true' } });
      const result = deserialize(await response.text());
      if (result.type === 'success' || result.type === 'failure') await invalidateAll();
      await applyAction(result);
    } catch {
      // No answer at all, or not one SvelteKit wrote: say so, so an older "Applied" line is not read as this one.
      await applyAction({ type: 'failure', status: 500, data: { ok: false, message: 'Nolzu did not answer. Check that it still runs, then press again.' } });
    }
  }
</script>

<svelte:head><title>Knowledge · Nolzu</title></svelte:head>

<!-- One scope for the page, so picking another file keeps the open one drawn until the new view lands.
     The wait is the page itself with no view, so the header and Search stay put. -->
<Streamed promise={data.knowledge} scope="knowledge" waiting="Reading the knowledge folder with git." height="360px">
  {#snippet wait()}
    <KnowledgeBrowser view={null} said={form ?? null} review={data.review} learn={data.learn} repos={data.repos} {onpost} {running} {now} />
  {/snippet}
  {#snippet children(view)}
    <KnowledgeBrowser bind:this={browser} {view} said={form ?? null} review={data.review} learn={data.learn} repos={data.repos} {onpost} {running} {now} />
  {/snippet}
</Streamed>
