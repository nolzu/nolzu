<script lang="ts">
  import { Button } from '@nolzu/ui';
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { ProjectFilesStatus } from '$lib/onboard.ts';
  import { filesOffer, filesStatusLine, filesUpdatedLine, handEditedLine } from '$lib/project-files-notice.ts';

  let { status, project }: { status: ProjectFilesStatus | null; project: string | null } = $props();

  // What the last update said, for the project it updated. It stays after the reload of the status,
  // which then has nothing to update, and goes on a switch to another project.
  let done = $state<{ updated: string; hand: string | null; moved: string | null; for: string | null } | null>(null);
  let problem = $state<string | null>(null);
  let pending = $state(false);
  const line = $derived(filesStatusLine(status));
  const offer = $derived(filesOffer(status));

  // The same action as Write the project files on Settings, Project, which writes only what nobody changed.
  const update: SubmitFunction = () => {
    pending = true;
    problem = null;
    return async ({ result, update: reload }) => {
      pending = false;
      if (result.type === 'success') {
        const data = result.data as { updated?: number; handEdited?: number; moved?: string | null; project?: string | null } | undefined;
        done = { updated: filesUpdatedLine(data?.updated ?? 0, data?.project ?? project), hand: handEditedLine(data?.handEdited ?? 0), moved: data?.moved ?? null, for: project };
      } else if (result.type === 'failure') {
        problem = typeof result.data?.message === 'string' ? result.data.message : 'The project files were not written.';
      }
      await reload({ reset: false });
    };
  };
</script>

{#if done !== null && done.for === project}
  <div class="notice" data-project-files>
    <span>{done.updated}</span>
    <!-- The space goes between the two nodes, because Svelte drops one at the start of a block. -->
    {#if done.moved !== null}<span class="sub">{done.moved}</span>{/if}
    {#if done.hand !== null}<span class="sub">{done.hand} <a href="{resolve('/settings/project')}#files">See Settings, Project.</a></span>{/if}
    <!-- The line has said its piece, and the layout keeps it on every board until a reload. -->
    <Button size="small" variant="ghost" onclick={() => (done = null)}>Close</Button>
  </div>
{:else if line !== null || problem !== null}
  <form method="POST" action={`${resolve('/settings/project')}?/files`} class="notice" data-project-files use:enhance={update}>
    {#if line !== null}<span>{line}</span>{/if}
    {#if offer}<Button size="small" type="submit" disabled={pending} aria-busy={pending ? 'true' : undefined}>{pending ? 'Updating' : 'Update'}</Button>{/if}
    {#if problem !== null}<span class="sub" role="alert">{problem}</span>{/if}
  </form>
{/if}

<style>
  /* One quiet line under the offline banner's place: the card surface with a hairline, as that banner. */
  .notice {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: var(--space-3) var(--space-6) 0;
    padding: 8px 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-lg);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .sub {
    color: var(--muted);
  }

  .sub a {
    color: var(--ink);
  }

  /* The page's own 16px gutter on a phone, so the line sits flush with the board head. */
  @media (max-width: 760px) {
    .notice {
      margin-inline: var(--space-4);
    }
  }
</style>
