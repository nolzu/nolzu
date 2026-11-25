<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { type Estimate, learnEstimateText, WRITE_IT_MYSELF } from '@nolzu/protocol';
  import { Button, Dialog, Skeleton, startsCommand } from '@nolzu/ui';
  import type { SetupGateOpen } from './setup-gate.svelte.ts';
  import { postWrite } from './ticket.ts';

  // The Learn gate of Set up the project: the first run waits for Learn your repositories. Learn
  // and then start is the consent for the Learn runs and the card's run after them; "I will write it
  // myself" marks the step done and sends the move the screen held back. A close sends nothing.
  let { gate, onclose }: { gate: SetupGateOpen; onclose: () => void } = $props();

  interface Offer {
    repos: readonly { path: string }[];
    starts: { engine: string; model: string; effort: string; severalProfiles: boolean; estimate?: Estimate; like?: Estimate };
    refusal: string | null;
  }

  let shell: ReturnType<typeof Dialog> | undefined = $state();
  let offer = $state.raw<Offer | null>(null);
  let problem = $state<string | null>(null);
  let sending = $state(false);
  // Set when the screen's own move is sent, so any other close lets the screen's button go. Learn and
  // then start leaves the move to the server, so the button goes then too.
  let sent = false;

  onMount(() => {
    void fetch(resolve('/api/setup'))
      .then(async (response) => (response.ok ? (offer = (await response.json()) as Offer) : (problem = 'What the Learn runs start on could not be read. Close this and try again.')))
      .catch(() => (problem = 'The board could not be reached. Check that Nolzu is still running.'));
  });

  const count = $derived(offer === null ? '' : offer.repos.length === 1 ? '1 repository' : `${offer.repos.length} repositories`);

  async function press(body: unknown, then?: () => unknown): Promise<void> {
    if (sending) return;
    sending = true;
    problem = await postWrite(fetch, resolve('/api/setup'), body);
    sending = false;
    if (problem !== null) return;
    sent = then !== undefined;
    shell?.close();
    then?.();
  }
</script>

<Dialog
  bind:this={shell}
  title="Learn your repositories before the first run"
  sub="Runs read what each repository is for, and how to run and test it, from Knowledge. Nothing is there yet."
  medium
  held={sending}
  onclose={() => {
    if (!sent) gate.stay?.();
    onclose();
  }}
  data-setup-gate
>
  {#if offer === null && problem === null}
    <Skeleton shape="rows" count={2} label="Reading what the Learn runs start on" />
  {:else if offer !== null}
    <p class="lead">Learns {count}{offer.repos.length > 1 ? ', one after another' : ''}, then starts {gate.key}. What each run writes waits on Knowledge for your review.</p>
    {#if offer.refusal === null}
      <p class="starts">Starts: {startsCommand(offer.starts)}</p>
      <p class="quiet">
        {learnEstimateText(offer.starts)}
      </p>
    {:else}
      <p class="problem" role="alert">{offer.refusal}</p>
    {/if}
  {/if}
  {#if problem !== null}<p class="problem" role="alert">{problem}</p>{/if}
  <p class="quiet" data-lacks>If you write it yourself: {WRITE_IT_MYSELF}</p>
  {#snippet footer()}
    <Button
      variant="go"
      disabled={offer === null || offer.refusal !== null || offer.repos.length === 0}
      aria-busy={sending ? 'true' : undefined}
      onclick={() => press({ then: { key: gate.key, to: gate.to } })}
      data-learn-then-start>Learn and then start</Button
    >
    <Button disabled={sending} onclick={() => press({ step: 'learn', mark: 'self' }, gate.go)} data-write-myself>I will write it myself</Button>
  {/snippet}
</Dialog>

<style>
  .lead {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .quiet {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
    line-height: 1.5;
  }

  /* The Starts line on the amber tint, as the drop box and Knowledge draw it. A line of text, never a control. */
  .starts {
    margin: 0;
    padding: var(--space-2) 10px;
    border-radius: var(--radius-md);
    background: var(--amber-bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    line-height: 1.55;
    overflow-wrap: anywhere;
  }

  .problem {
    margin: 0;
    padding: 4px 8px;
    border-left: 2px solid var(--red);
    color: var(--ink);
    font-size: var(--text-sm);
  }
</style>
