<script lang="ts">
  import { Button } from '@nolzu/ui';

  // The value side of the branch row in the card facts. A pencil turns the name into a text box while
  // nothing was pushed and no run is going; `locked` says why not otherwise. A direct write and not a
  // run, so the row shows its own pending state, and a refusal stays beside the box.
  let { value, locked, onsave }: { value: string; locked: string | null; onsave: (name: string) => Promise<string | null> } = $props();

  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let refused = $state<string | null>(null);

  function open(): void {
    draft = value;
    refused = null;
    editing = true;
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (draft.trim() === value) {
      editing = false;
      return;
    }
    saving = true;
    refused = await onsave(draft.trim());
    saving = false;
    if (refused === null) editing = false;
  }
</script>

{#if editing && locked === null}
  <form class="edit" onsubmit={save}>
    <!-- The box opens on the pencil press, so the typing goes here. -->
    <!-- svelte-ignore a11y_autofocus -->
    <input class="value" aria-label="Branch name" bind:value={draft} spellcheck="false" autocomplete="off" autofocus disabled={saving} onkeydown={(event) => { if (event.key === 'Escape') editing = false; }} />
    <span class="actions">
      <Button size="small" variant="primary" type="submit" data-branch-save aria-busy={saving} disabled={saving}>{saving ? 'Saving' : 'Save'}</Button>
      <Button size="small" variant="ghost" data-branch-cancel disabled={saving} onclick={() => (editing = false)}>Cancel</Button>
    </span>
    {#if refused !== null}<p class="refused" role="alert">{refused}</p>{/if}
  </form>
{:else}
  <span class="shown">
    <span class="value" title={locked ?? undefined}>{value}</span>
    {#if locked === null}
      <button type="button" class="pencil" aria-label="Rename the branch" data-branch-edit onclick={open}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"></path><path d="m13 7 4 4"></path></svg>
      </button>
    {/if}
  </span>
{/if}

<style>
  /* A branch is evidence, so it is mono, as the other fact values are. */
  .value {
    min-width: 0;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    overflow-wrap: anywhere;
    text-align: right;
  }

  .shown {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .pencil {
    display: inline-flex;
    flex: none;
    padding: 2px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  .pencil:hover,
  .pencil:focus-visible {
    color: var(--ink-2);
  }

  .pencil svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .edit {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .edit input {
    box-sizing: border-box;
    width: 100%;
    padding: 4px 6px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--bg);
    text-align: left;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }

  .refused {
    margin: 0;
    color: var(--red);
  }
</style>
