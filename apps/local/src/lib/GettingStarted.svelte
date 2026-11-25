<script lang="ts">
  import { resolve } from '$app/paths';
  import { Button } from '@nolzu/ui';
  import type { FirstRun } from './getting-started.ts';
  import { postWrite } from './ticket.ts';

  // The rail's foot during the first run: Getting started, and "Start Nolzu when you log in?". A step
  // turns done from its own event on the server, never from a click here. Only Turn on changes the
  // machine, and only when it is pressed.
  let { firstRun }: { firstRun: FirstRun } = $props();

  const steps = $derived(firstRun.steps);
  const count = $derived(steps === null ? 0 : steps.filter((step) => step.done).length);
  const current = $derived(steps?.find((step) => !step.done)?.id ?? null);

  // The offer goes at the press, before the stream says it was answered.
  let answered = $state(false);
  let turning = $state(false);
  let refused = $state<string | null>(null);

  async function turnOn(): Promise<void> {
    if (turning) return;
    turning = true;
    refused = await postWrite(fetch, resolve('/api/login-item'), {});
    turning = false;
    if (refused === null) answered = true;
  }

  // Not now answers the offer for good, as Got it closes a coach note.
  function notNow(note: string): void {
    answered = true;
    void postWrite(fetch, resolve('/api/notes'), { note });
  }
</script>

{#if steps !== null}
  <section class="box" aria-labelledby="getting-started">
    <h2 id="getting-started">Getting started <span class="count" aria-hidden="true">{count}/{steps.length}</span><span class="hidden">, {count} of {steps.length} done</span></h2>
    <ol>
      {#each steps as step (step.id)}
        <li class:done={step.done} class:now={step.id === current} aria-current={step.id === current ? 'step' : undefined}>
          <span class="mark" aria-hidden="true"></span><span>{step.label}</span>{#if step.done}<span class="hidden">, done</span>{/if}
        </li>
      {/each}
    </ol>
  </section>
{/if}
{#if firstRun.loginOffer !== null && !answered}
  {@const note = firstRun.loginOffer}
  <section class="box" aria-labelledby="start-at-login">
    <p id="start-at-login">Start Nolzu when you log in?</p>
    <div class="row">
      <Button size="small" aria-busy={turning ? 'true' : undefined} onclick={turnOn} data-login-on>Turn on</Button>
      <Button size="small" variant="ghost" onclick={() => notNow(note)} data-login-later>Not now</Button>
    </div>
    <p class="said" role="status">{refused ?? ''}</p>
  </section>
{/if}

<style>
  /* The box: the panel with a hairline, 10px 12px. Nothing here is amber, because nothing here
     starts an agent. */
  .box {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 10px var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  h2,
  p,
  ol {
    margin: 0;
  }

  h2 {
    display: flex;
    align-items: center;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--ink);
  }

  .count {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    font-weight: 400;
    color: var(--muted);
  }

  ol {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* An open ring, and a green dot once done. The word is struck through and muted too, so done is
     never colour alone. */
  .mark {
    flex: none;
    box-sizing: border-box;
    width: 14px;
    height: 14px;
    border: 1.5px solid var(--line-2);
    border-radius: 50%;
  }

  .done {
    color: var(--muted);
    text-decoration: line-through;
  }

  .done .mark {
    border-color: var(--green);
    background: var(--green);
  }

  /* The step to do next: ink and weight, and an ink ring, not amber. */
  .now {
    font-weight: 500;
    color: var(--ink);
  }

  .now .mark {
    border-color: var(--ink);
  }

  .row {
    display: flex;
    gap: 6px;
  }

  .said:empty {
    display: none;
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* The narrow band at the top has no room for either, as it has none for the usage. */
  @media (max-width: 760px) {
    .box {
      display: none;
    }
  }
</style>
