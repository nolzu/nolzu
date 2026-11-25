<script lang="ts">
  import Button from '../Button.svelte';
  import Dialog from '../Dialog.svelte';

  let {
    cardKey,
    check,
    problem = null,
    held = false,
    onconfirm,
    onrecheck = async () => {},
    onclose,
  }: {
    cardKey: string;
    // What the server read as the confirm opened: what goes, what is lost or stays, the refusal, and the
    // card folder as the person finds it in the project (null when the card has none). Null while the
    // check is on its way.
    // A warning that `loses` something sits on the red tint.
    // `keepsBranch` is whether a card branch stays, so the folder note names it only then.
    check: { refused: string | null; goes: string; warnings: readonly { text: string; loses: boolean }[]; folder: string | null; keepsBranch?: boolean } | null;
    // Why the check could not be read, or why the delete was refused.
    problem?: string | null;
    // True while the delete runs, so the button and Esc wait for its answer.
    held?: boolean;
    // Whether the card folder goes too. The page sends the delete and moves on once it is done.
    onconfirm: (folder: boolean) => void;
    // Reads the check again, such as after the run or the app stopped.
    onrecheck?: () => Promise<void>;
    onclose: () => void;
  } = $props();

  const uid = $props.id();
  let shell: ReturnType<typeof Dialog>;
  // Off by default: other cards can read the folder, so keeping it is the safe choice.
  let folder = $state(false);
  const ready = $derived(check !== null && check.refused === null);

  // A disabled button does not stop a submit a script sends, so this guard is what holds a refused delete.
  function confirm(event: Event): void {
    event.preventDefault();
    if (held) return;
    if (check?.refused != null) void onrecheck();
    else if (ready) onconfirm(folder && check?.folder !== null);
  }
</script>

<Dialog bind:this={shell} title="Delete {cardKey}" sub="This cannot be undone." {held} {onclose} role="alertdialog" aria-describedby="{uid}-goes" data-delete-confirm>
  <form id="{uid}-form" onsubmit={confirm}>
    {#if check === null}
      <p class="goes" id="{uid}-goes">{problem ?? 'Reading the card and its checkout.'}</p>
    {:else}
      <p class="goes" id="{uid}-goes">{check.goes}</p>
      {#if check.warnings.length > 0}
        <ul class="warnings" data-delete-warnings>
          {#each check.warnings as line, index (index)}<li class:loses={line.loses} data-loses={line.loses ? '' : undefined}>{line.text}</li>{/each}
        </ul>
      {/if}
      {#if check.folder !== null}
        <div class="field">
          <input id="{uid}-folder" type="checkbox" bind:checked={folder} disabled={check.refused !== null} aria-describedby="{uid}-folder-note" data-delete-folder />
          <label for="{uid}-folder">Also delete the card folder <code>{check.folder}</code></label>
          <p class="note" id="{uid}-folder-note">Kept, it holds the card's plan, notes and files. A card added later on this key, such as this ticket added again, picks up this folder{check.keepsBranch ? ' and its branch' : ''}.</p>
        </div>
      {/if}
      {#if check.refused !== null}<p class="refused" role="alert">{check.refused}</p>{/if}
      {#if problem !== null}<p class="refused" role="alert">{problem}</p>{/if}
    {/if}
  </form>
  {#snippet footer()}
    <!-- Red and never amber, because deleting starts no run. While held it only says so, because a
         disabled button drops the focus it has to the body. -->
    {#if check?.refused != null}
      <!-- A refusal names what to stop first. Once it is stopped, this reads the card again. -->
      <Button type="submit" form="{uid}-form" aria-disabled={held ? 'true' : undefined} data-recheck>Check again</Button>
    {:else}
      <Button variant="danger" type="submit" form="{uid}-form" disabled={!ready} aria-disabled={held ? 'true' : undefined} aria-busy={held ? 'true' : undefined} data-confirm>Delete card</Button>
    {/if}
    <Button variant="ghost" key="Esc" disabled={held} onclick={() => shell.close()}>Cancel</Button>
  {/snippet}
</Dialog>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  p {
    margin: 0;
  }

  .goes {
    color: var(--ink);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .warnings {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    color: var(--ink);
    font-size: var(--text-xs);
    line-height: 1.4;
    list-style: none;
  }

  /* A line that keeps or loses nothing is a plain box. */
  .warnings li {
    padding: 6px 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
  }

  /* Ink on the red tint, as the Remove confirm draws work that cannot come back. */
  .warnings li.loses {
    border-color: transparent;
    background: var(--red-bg);
  }

  .field {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 4px var(--space-2);
  }

  label {
    color: var(--ink-2);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .note {
    grid-column: 2;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  /* A neutral box, as every refusal is. */
  .refused {
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink-2);
    font-size: var(--text-xs);
  }
</style>
