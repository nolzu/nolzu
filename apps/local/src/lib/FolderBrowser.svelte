<script lang="ts">
  import { resolve } from '$app/paths';
  import { Button, Skeleton } from '@nolzu/ui';
  import type { FolderList } from './folders.ts';

  // Browse: a web page cannot read a real path from the system file picker, so Nolzu lists the folders.
  // The page's Browse button sets `open`, and "Use this folder" hands the path on and closes.
  let { open = $bindable(false), onuse }: { open: boolean; onuse: (path: string) => void } = $props();

  let list = $state<FolderList | null>(null);
  let problem = $state<string | null>(null);
  const browse = async (path: string | null): Promise<void> => {
    problem = null;
    const answer = await fetch(path === null ? resolve('/api/folders') : `${resolve('/api/folders')}?path=${encodeURIComponent(path)}`);
    const body = (await answer.json()) as FolderList | { problem: string };
    if ('problem' in body) problem = body.problem;
    else list = body;
  };
  $effect(() => {
    if (open) void browse(null);
    else list = null;
  });
</script>

{#if problem !== null}<p class="refused" role="alert">{problem}</p>{/if}
{#if open && list === null && problem === null}
  <div class="browser">
    <Skeleton shape="rows" count={4} label="Reading the folders." />
  </div>
{:else if open && list !== null}
  {@const at = list}
  <div class="browser" role="group" aria-label="Folders in {at.path}">
    <p class="mono here">{at.path}</p>
    <ul>
      {#if at.parent !== null}
        {@const parent = at.parent}
        <li><button type="button" class="row-link mono" aria-label="Up to {parent}" onclick={() => void browse(parent)}>..</button></li>
      {/if}
      {#each at.folders as one (one)}
        {@const path = `${at.path}/${one}`}
        <li><button type="button" class="row-link mono" onclick={() => void browse(path)}>{one}</button></li>
      {:else}
        <li class="sub">No folders here.</li>
      {/each}
    </ul>
    <div class="foot">
      <Button
        size="small"
        onclick={() => {
          onuse(at.path);
          open = false;
        }}>Use this folder</Button
      >
    </div>
  </div>
{/if}

<style>
  .refused {
    margin: 0;
    color: var(--red);
    font-size: var(--text-sm);
  }

  .browser {
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .mono {
    font-family: var(--font-mono);
  }

  .browser ul {
    display: flex;
    flex-direction: column;
    max-height: 240px;
    margin: 0;
    padding: 0 0 var(--space-2);
    overflow-y: auto;
    list-style: none;
  }

  .here {
    margin: 0;
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    color: var(--ink-2);
    font-size: var(--mono-xs);
  }

  .row-link {
    width: 100%;
    padding: 6px 14px;
    border: 0;
    background: none;
    color: var(--ink);
    font-size: var(--mono-xs);
    text-align: left;
    cursor: pointer;
  }

  .row-link:hover,
  .row-link:focus-visible {
    background: var(--card);
  }

  .sub {
    padding: 6px 14px;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .foot {
    padding: 10px 14px;
    border-top: 1px solid var(--line);
  }
</style>
