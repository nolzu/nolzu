<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { Button, Dialog, dropTarget, Switch } from '@nolzu/ui';
  import QaChoices from './QaChoices.svelte';
  import type { QaAskOpen } from './qa-ask.svelte.ts';
  import type { QaSetup } from './qa-setup.ts';
  import { postWrite } from './ticket.ts';

  // The question at the first QA. Start QA is the
  // consent: it saves the answer for the repository, then sends the move the screen held back. Cancel the
  // move closes it, and nothing is saved or moved.
  let { ask, onclose }: { ask: QaAskOpen; onclose: () => void } = $props();
  // svelte-ignore state_referenced_locally
  let setup = $state.raw(ask.setup);

  const uid = $props.id();
  let shell: ReturnType<typeof Dialog> | undefined = $state();
  // The first choice is the one the repositories propose, and the box starts with the port a script names.
  // svelte-ignore state_referenced_locally
  let choice = $state<'dev' | 'running' | 'own' | 'code'>(ask.setup.dev !== null ? 'dev' : 'code');
  // Your own commands, kept while the person picks another option and comes back.
  let ownStart = $state('');
  let ownStop = $state('');
  let ownStatus = $state('');
  // svelte-ignore state_referenced_locally
  let address = $state(ask.setup.address);
  // On where Playwright is found, and where QA has a browser already.
  // svelte-ignore state_referenced_locally
  let browser = $state(ask.setup.browser || ask.setup.playwright);
  let problem = $state<string | null>(null);
  // The save is a direct write with its own pending state. The move after it goes through the stream.
  let sending = $state(false);
  // Set by Start QA, so a close without it is the cancel, which saves nothing and moves nothing.
  let started = false;
  // Set by any pick, so the card's start command never swaps a choice the person made.
  let picked = false;

  // Read again for the card's own copy. A card can be the one that makes the app, when the project folder
  // names no start command, and the scripts shown are the ones on the card's branch, which the start runs.
  // In a workspace the card's repository can be another than the stream's, and then it is asked about.
  // A failed read leaves the question as it is.
  const readCard = (): void => {
    void fetch(`${resolve('/api/qa-setup')}?key=${encodeURIComponent(ask.key)}`)
      .then((response) => (response.ok ? (response.json() as Promise<QaSetup>) : null))
      .then((card) => {
        // An answer with no `dev` at all is no question.
        if (card?.dev === undefined || sending || started) return;
        const moved = card.repo !== setup.repo;
        if (card.dev === null && !moved) return;
        // Without Chrome or Playwright before, the switch was not drawn, so nobody can have set it.
        if (!setup.chrome && !setup.playwright) browser = card.browser || card.playwright;
        if (moved || (setup.dev === null && !picked)) {
          choice = card.dev !== null ? 'dev' : 'code';
          address = card.address;
        }
        setup = card;
      })
      .catch(() => {});
  };
  onMount(readCard);

  // What starts, as the drop box says it: the phase, the model and the effort, and an estimate only
  // where measured runs give one.
  const target = $derived(dropTarget(ask.stage, true));
  const starts = $derived(ask.stage.starts);
  const line = $derived(
    target.kind === 'refused'
      ? target.reason
      : target.kind === 'starts' && starts !== null
        ? [`/${starts.phase}`, starts.model, starts.effort, ...(target.estimate === undefined ? [] : [target.estimate.text])].join(' · ')
        : null,
  );

  async function start(): Promise<void> {
    if (sending) return;
    sending = true;
    // The scripts shown go with the answer, so the server saves a yes only to the ones the person read.
    problem = await postWrite(fetch, resolve('/api/qa-setup'), { key: ask.key, choice, address, ...(choice === 'dev' ? { scripts: setup.scripts } : {}), ...(choice === 'own' ? { start: ownStart, stop: ownStop, status: ownStatus } : {}), ...(setup.chrome || setup.playwright ? { browser } : {}) });
    sending = false;
    // A refusal can be scripts that changed, so the card's copy is read again to show the new ones.
    if (problem !== null) return readCard();
    started = true;
    // Read before the close: the close clears the open question, and `ask` reads it live.
    const go = ask.go;
    shell?.close();
    go();
  }
</script>

<Dialog
  bind:this={shell}
  title="QA wants to run {setup.project} before it checks {ask.key}"
  sub="{setup.dev === null ? '' : 'Found in package.json. '}Pick one, it is saved for {setup.repo ?? 'the project'}."
  medium
  held={sending}
  onclose={() => {
    if (!started) ask.stay?.();
    onclose();
  }}
  data-qa-ask
>
  <QaChoices {setup} copy="{ask.key}'s copy" bind:choice bind:address bind:start={ownStart} bind:stop={ownStop} bind:status={ownStatus} onpick={() => (picked = true)} />
  {#if setup.chrome || setup.playwright}
    <!-- Only where Chrome or Playwright is on this machine, so the switch never offers a browser that
         is not there. The server comes from npx and needs no Playwright in the project. -->
    <div class="browser" data-browser>
      <Switch checked={browser} onchange={(on) => (browser = on)} aria-labelledby="{uid}-browser" />
      <span id="{uid}-browser">Let QA use a browser and take screenshots</span>
      <span class="found">Opens pages in Google Chrome</span>
    </div>
  {/if}
  {#if problem !== null}<p class="problem" role="alert">{problem}</p>{/if}
  {#snippet footer()}
    <Button variant="go" aria-busy={sending ? 'true' : undefined} onclick={start} data-start-qa>Start QA</Button>
    {#if line !== null}<span class="line">{line}</span>{/if}
    <Button variant="ghost" disabled={sending} onclick={() => shell?.close()} data-cancel>Cancel the move</Button>
  {/snippet}
</Dialog>

<style>
  .line {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .browser {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    font-size: var(--text-sm);
  }

  .found {
    margin-left: auto;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .line {
    color: var(--muted);
  }

  .problem {
    margin: 0;
    padding: 4px 8px;
    border-left: 2px solid var(--red);
    color: var(--ink);
    font-size: var(--text-sm);
  }
</style>
