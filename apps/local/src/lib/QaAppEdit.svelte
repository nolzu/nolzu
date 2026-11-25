<script lang="ts">
  import { Button } from '@nolzu/ui';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import QaChoices from './QaChoices.svelte';
  import type { AppRow } from './qa-setup.ts';

  // Edit on one row of Start the app: the four choices of the question at the first QA, saved for that
  // repository, or for every one under `*`. The page owns the post and its answer.
  let { row, onsubmit }: { row: AppRow; onsubmit: SubmitFunction } = $props();

  // What the boxes start with: the saved answer, else what the question would offer first.
  // svelte-ignore state_referenced_locally
  const { answer: saved, setup, repo } = row;
  let choice = $state<'dev' | 'running' | 'own' | 'code'>(saved?.mode ?? (setup.dev !== null ? 'dev' : 'code'));
  let address = $state(saved?.mode === 'running' ? saved.address : setup.address);
  let start = $state(saved?.mode === 'own' ? saved.start : '');
  let stop = $state(saved?.mode === 'own' ? (saved.stop ?? '') : '');
  let status = $state(saved?.mode === 'own' ? (saved.status ?? '') : '');
  // The answer for every repository runs once per card, in the card's checkout root, as the stack hook did.
  const ownPlace = repo === '*' ? "the card's checkout root, once per card" : null;
</script>

<form method="POST" action="?/qaRepo" class="edit" use:enhance={onsubmit}>
  <input type="hidden" name="repo" value={row.repo} />
  <input type="hidden" name="choice" value={choice} />
  <input type="hidden" name="address" value={address} />
  <input type="hidden" name="start" value={start} />
  <input type="hidden" name="stop" value={stop} />
  <input type="hidden" name="status" value={status} />
  <!-- The scripts shown go with a start command, so the server saves a yes only to the ones the person read. -->
  {#if choice === 'dev'}<input type="hidden" name="scripts" value={row.setup.scripts} />{/if}
  <QaChoices setup={row.setup} copy="the card's copy" {ownPlace} bind:choice bind:address bind:start bind:stop bind:status />
  <div><Button size="small" type="submit">Save</Button></div>
</form>

<style>
  .edit {
    display: grid;
    gap: var(--space-2);
  }
</style>
