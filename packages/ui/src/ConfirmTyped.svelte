<script lang="ts">
  import Button from './Button.svelte';
  import { typedName } from './confirm.ts';
  import Dialog from './Dialog.svelte';
  import { splitCode } from './toasts.ts';

  // A sentence and the paths in it that are set in mono.
  type Coded = { text: string; code: string | readonly string[] };

  let {
    title,
    sub = null,
    name,
    lost,
    checked = [],
    gone = [],
    blocked = false,
    kept = null,
    action,
    held = false,
    typed = $bindable(''),
    onconfirm,
    onclose,
  }: {
    // What happens, such as "Remove repository web".
    title: string;
    sub?: string | null;
    // The folder name the person types out before the button turns on.
    name: string;
    // What the action deletes, one line each. It comes before the field, so it is read before the
    // name is typed. A line can set its paths in mono, in the order they stand.
    lost: readonly (string | Coded)[];
    // What was checked and holds, such as "No card has a checkout of it", each with a tick.
    checked?: readonly string[];
    // Work that exists nowhere else, such as commits that were never pushed. It sits in the red box,
    // because it cannot come back.
    gone?: readonly string[];
    // True while a check failed. Then the confirm asks for no name, and the button stays off whatever
    // is sent, so nothing in the red box is lost.
    blocked?: boolean;
    // What stays, such as the repository on GitHub, in one quiet line.
    kept?: string | Coded | null;
    // The words on the red button, such as "Remove web".
    action: string;
    // True while the action runs, so the button and Esc wait for its answer.
    held?: boolean;
    // The name as typed. Bound by a caller that keeps it while the dialog is closed, so a stray click on
    // the backdrop does not make the person type it again.
    typed?: string;
    // Gets what was typed, so the caller can send it and the server check the name again.
    onconfirm: (typed: string) => void;
    onclose: () => void;
  } = $props();

  const uid = $props.id();
  let shell: ReturnType<typeof Dialog>;
  const ready = $derived(!blocked && typedName(typed, name));

  // Enter in the field submits too, a disabled button does not stop a submit event a script sends, and
  // the held button stays on so it keeps the focus. This guard is what stops a second confirm.
  function confirm(event: Event): void {
    event.preventDefault();
    if (ready && !held) onconfirm(typed);
  }

  // For the caller once the action is done, so the dialog closes the way Cancel does and focus goes back
  // to what opened it. Taking it off the page instead gives focus to the body.
  export function close(): void {
    shell.close();
  }
</script>

<!-- Each path in its code box. A path the sentence does not hold is skipped. -->
{#snippet codes(text: string, paths: readonly string[])}
  {@const parts = paths.length === 0 ? null : splitCode(text, paths[0])}
  {#if parts !== null}{parts[0]}<code>{parts[1]}</code>{@render codes(parts[2], paths.slice(1))}{:else if paths.length > 1}{@render codes(text, paths.slice(1))}{:else}{text}{/if}
{/snippet}

{#snippet coded(line: string | Coded)}
  {#if typeof line === 'string'}{line}{:else}{@render codes(line.text, typeof line.code === 'string' ? [line.code] : line.code)}{/if}
{/snippet}

<Dialog bind:this={shell} {title} {sub} {held} {onclose} role="alertdialog" aria-describedby={gone.length > 0 ? `${uid}-lost ${uid}-gone` : `${uid}-lost`}>
  <form id="{uid}-form" onsubmit={confirm}>
    <ul class="lost" id="{uid}-lost">
      {#each lost as line, index (index)}
        <li>{@render coded(line)}</li>
      {/each}
    </ul>
    {#if checked.length > 0}
      <ul class="checked">
        {#each checked as line, index (index)}
          <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>{line}</li>
        {/each}
      </ul>
    {/if}
    {#if gone.length > 0}
      <ul class="gone" id="{uid}-gone">
        {#each gone as line, index (index)}<li>{line}</li>{/each}
      </ul>
    {/if}
    {#if kept}<p class="kept">{@render coded(kept)}</p>{/if}
    <!-- The name is asked only once every check holds, so it is never typed for a remove that cannot run. -->
    {#if !blocked}
      <div class="field">
        <label for="{uid}-name">Type <span class="mono">{name}</span> to confirm</label>
        <!-- svelte-ignore a11y_autofocus -->
        <input id="{uid}-name" bind:value={typed} autocomplete="off" spellcheck="false" autofocus />
      </div>
    {/if}
  </form>
  {#snippet footer()}
    <!-- Red and never amber, because deleting starts no run. Off until the name is typed. While
         held it only says so, because a disabled button drops the focus it has to the body. -->
    <Button variant="danger" type="submit" form="{uid}-form" disabled={!ready} aria-disabled={held ? 'true' : undefined} aria-busy={held ? 'true' : undefined} data-confirm>{action}</Button>
    <Button variant="ghost" key="Esc" disabled={held} onclick={() => shell.close()}>Cancel</Button>
  {/snippet}
</Dialog>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .lost,
  .gone {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0;
    padding: 0;
    color: var(--ink);
    list-style: none;
  }

  .lost {
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .checked {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) 18px;
    margin: 0;
    padding: 0;
    color: var(--ink-2);
    font-size: var(--text-xs);
    list-style: none;
  }

  .checked li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  /* The tick is green: the check holds. The words carry it too, so it is not colour alone. */
  .checked svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: var(--green);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Ink on the red tint, which reaches 4.5:1 over every surface. 12.5px is off the scale, so the
     box takes the nearest step. */
  .gone {
    padding: var(--space-2) 10px;
    border-radius: var(--radius-md);
    background: var(--red-bg);
    font-size: var(--text-xs);
    line-height: 1.4;
  }

  .kept {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  label {
    color: var(--ink-2);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .mono {
    color: var(--ink);
    font-family: var(--font-mono);
  }

  /* The code box: mono on the raised surface with a hairline. */
  code {
    padding: 0 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius-xs);
    background: var(--card-2);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }

  input {
    box-sizing: border-box;
    width: 100%;
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
