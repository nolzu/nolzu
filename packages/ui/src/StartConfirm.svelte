<script lang="ts">
  import type { ProfileLimit, StageView } from '@nolzu/protocol';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import { chainTarget, dropTarget, RUNS_HERE } from './board/drop.ts';

  // What a key that starts a run shows first: the same lines a drop shows, then Confirm, which ↵
  // presses, and Cancel, which Esc presses.
  let {
    title,
    stage,
    then = null,
    limits = {},
    onconfirm,
    onclose,
  }: {
    // What starts, such as "Retry APP-3 in Implement".
    title: string;
    // The stage the run starts in, with the card's own models already applied.
    stage: StageView;
    // The run that starts once the first one ends ready, which is Fix it's QA. The confirm then names
    // both runs and shows the sum of both estimates.
    then?: StageView | null;
    // What each engine profile last reported about its usage windows, as the drop box reads it. A caller
    // with none shows no window.
    limits?: Readonly<Record<string, ProfileLimit>>;
    onconfirm: () => void;
    onclose: () => void;
  } = $props();

  const uid = $props.id();
  let shell: ReturnType<typeof Dialog>;
  let form: HTMLFormElement;
  // Read again with every snapshot, so a model that goes while the dialog is open turns Confirm off.
  const target = $derived(then === null ? dropTarget(stage, true, { limits, now: Date.now() }) : chainTarget(stage, then, { limits, now: Date.now() }));
  const estimate = $derived(target.kind === 'starts' ? target.estimate : undefined);
  const usage = $derived(target.kind === 'starts' ? target.usage : undefined);
  const described = $derived([`${uid}-starts`, ...(estimate === undefined ? [] : [`${uid}-estimate`]), ...(usage === undefined ? [] : [`${uid}-usage`])].join(' '));

  // A disabled button does not stop a submit a script sends, so this guard is what holds a refused run.
  // The caller hears the confirm before the close, while what it opened the dialog for is still set.
  function confirm(event: Event): void {
    event.preventDefault();
    if (target.kind !== 'starts') return;
    onconfirm();
    shell.close();
  }

  // A click on the dialog's text leaves focus on the dialog box, where Enter would press nothing.
  function enter(event: KeyboardEvent): void {
    if (event.key === 'Enter' && event.target === event.currentTarget) form.requestSubmit();
  }
</script>

<Dialog
  bind:this={shell}
  {title}
  {onclose}
  aria-describedby={described}
  onkeydown={enter}
  data-start-confirm
>
  <form id="{uid}-form" bind:this={form} onsubmit={confirm}>
    {#if target.kind === 'starts'}
      <p class="starts" id="{uid}-starts">Starts: {target.command}</p>
      {#if estimate !== undefined}
        <p class="estimate" id="{uid}-estimate"><span class="figure">{estimate.text}</span>, {estimate.from}</p>
      {/if}
      {#if usage !== undefined}
        <p class="usage figure" id="{uid}-usage">{usage}</p>
      {/if}
      <p class="where">{RUNS_HERE}</p>
    {:else}
      <p class="reason" id="{uid}-starts">{target.kind === 'refused' ? target.reason : target.says}</p>
    {/if}
  </form>
  {#snippet footer()}
    <!-- The first control, so it has the focus when the dialog opens and Enter presses it. -->
    <Button variant="go" type="submit" form="{uid}-form" key="↵" aria-disabled={target.kind === 'starts' ? undefined : 'true'} data-confirm>Confirm</Button>
    <Button variant="ghost" key="Esc" onclick={() => shell.close()}>Cancel</Button>
  {/snippet}
</Dialog>

<style>
  form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* The Starts line on the amber tint, as the drop box draws it. tokens.test.ts holds ink at 4.5:1 on
     the tint over the card. It is a line of text, never a control. */
  .starts {
    margin: 0;
    padding: var(--space-2) 10px;
    border-radius: var(--radius-md);
    background: var(--amber-bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    line-height: 1.55;
  }

  .where,
  .reason,
  .estimate,
  .usage {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  /* The figure, in mono and a text ink. Never amber: it is a figure, not the start. */
  .figure {
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }
</style>
