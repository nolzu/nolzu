<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import WorkspacePage from '$lib/WorkspacePage.svelte';
  import type { PageData } from './$types';

  // `PageData` from the layout alone: the page has no load, because git status is read by the part once
  // it is on screen, so opening the page never waits on git.
  let { data }: { data: PageData } = $props();

  const send = async (address: string, body?: unknown) => {
    const answer = await fetch(address, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return answer.json();
  };
</script>

<svelte:head><title>Workspace · Nolzu</title></svelte:head>

<WorkspacePage
  name={data.project ?? 'Workspace'}
  folder={data.projectPath}
  onread={() => send(resolve('/api/workspace'))}
  onpatch={(repo, path) => send(`${resolve('/api/workspace/patch')}?${new URLSearchParams({ repo, path })}`)}
  oncommit={(repo, message, paths, hooks) => send(resolve('/api/workspace/commit'), { repo, message, paths, hooks })}
  onpush={(repo, hooks) => send(resolve('/api/workspace/push'), { repo, confirmed: true, hooks })}
  onchecked={() => void invalidateAll()}
/>
