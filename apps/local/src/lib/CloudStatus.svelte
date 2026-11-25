<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button } from '@nolzu/ui';
  import type { HubStatus } from '@nolzu/runner';
  import { cloudState } from './cloud-status.ts';

  // What the connection was doing when the page loaded. The dial runs in the server process, so this
  // screen reads it once per load and never polls for it. `free` is a document without the cloud board.
  //
  // Limit: a reload is the refresh. Put the status in the board snapshot that already goes out over
  // SSE if a person needs to watch it change from connected to reconnecting.
  // `paused` is sync paused after Delete my cloud data.
  let { status, free = false, paused = false }: { status: HubStatus; free?: boolean; paused?: boolean } = $props();

  const state = $derived(cloudState(status, free, paused));
</script>

<div class="cloud" class:free>
  <div class="line">
    <p class="state" data-status={paused ? 'paused' : status}><span class="dot" aria-hidden="true"></span>{state.connection.word}</p>
    <!-- Connect again dials once, on the press and never on a load or a timer (`redialHub`). Plain and
         not amber: it starts no agent. -->
    <!-- Turn sync back on dials at once and sends the board again (`resumeSync`). Plain, like Connect again. -->
    {#if state.resume}
      <form method="POST" action="?/resume" use:enhance>
        <Button type="submit" size="small">Turn sync back on</Button>
      </form>
    {/if}
    {#if state.redial}
      <form method="POST" action="?/redial" use:enhance>
        <Button type="submit" size="small">Connect again</Button>
      </form>
    {/if}
  </div>
  <p class="quiet">{state.connection.sentence}</p>
  {#if state.connection.fix !== null}<p class="fix">{state.connection.fix}</p>{/if}
</div>

<style>
  .cloud {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 14px 16px 12px;
  }

  /* On Free the status is one row, the word then its sentence, with no box around it. */
  .cloud.free {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 0;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  form {
    margin-left: auto;
  }

  /* The word carries the state and the colour repeats it, the way StatePill does, so a reader who
     cannot tell the dots apart still reads the state. */
  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    margin: 0;
    padding: 0 9px;
    border: 1px solid var(--line-2);
    border-radius: 999px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--ink-2);
  }

  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted);
  }

  [data-status='open'] .dot {
    background: var(--green);
  }

  /* Blue and not amber: amber means an agent starts work, and a dial is not that. */
  [data-status='connecting'] .dot,
  [data-status='waiting'] .dot {
    background: var(--blue);
  }

  [data-status='refused'] .dot {
    background: var(--red);
  }

  /* The plan state has no colour rule on purpose. An account that does not include the cloud board is
     not a fault, so it reads in the default ink the way `closed` does. */

  /* var(--muted) and not a faded ink: text at reduced opacity drops under the contrast rule the
     design system holds. */
  .quiet {
    margin: 0;
    max-width: 72ch;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .fix {
    margin: 0;
    max-width: 72ch;
    font-size: var(--text-xs);
    color: var(--ink);
  }
</style>
