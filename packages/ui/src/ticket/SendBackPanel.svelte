<script lang="ts">
  import type { CardView } from '@nolzu/protocol';
  import Button from '../Button.svelte';
  import { dropTarget, refuseDrop, startsCommand, type Usage } from '../board/drop.ts';
  import { type Seen, settle } from './actions.ts';
  import type { SendBack } from './decision.ts';

  // "Next step" on the Changes tab while comments are open: Send back to Implement
  // with them, amber, because it resumes a run. Busy state comes from the card in
  // the snapshot, so a press holds the button until the board shows the card moved. The page owns the
  // request, because this package never fetches.
  let {
    card,
    sendBack,
    open,
    session = null,
    usage,
    onsend,
    onrefuse = () => {},
  }: {
    card: CardView;
    // Null while the card cannot go back now, such as during a run, which the panel then says.
    sendBack: SendBack | null;
    // The comments of the card not sent yet. None, and the panel is not drawn.
    open: number;
    // The Implement session it goes on in, shortened. None, and Implement starts fresh.
    session?: string | null;
    usage?: Usage;
    // Answers with the sentence the server refused it with, or null once the run is queued.
    onsend: () => Promise<string | null>;
    onrefuse?: (said: string | null) => void;
  } = $props();

  const uid = $props.id();
  const refusal = $derived(sendBack === null ? null : refuseDrop(sendBack.implement, 'forward'));
  const target = $derived(sendBack === null || refusal !== null ? null : dropTarget(sendBack.implement, true, usage));
  const estimate = $derived(target?.kind === 'starts' ? target.estimate : undefined);
  const yours = $derived(sendBack?.count === 1 ? 'your comment' : `your ${sendBack?.count ?? open} comments`);

  // Let go when this card's key, stage or state moves, as the decision panel does.
  const at = $derived(`${card.key} ${card.stage} ${card.state}`);
  let pressed = $derived.by<Seen | null>(() => {
    void at;
    return null;
  });
  const held = $derived(settle(pressed, card) !== null);

  // The handler refuses the press, not the disabled attribute, so the button keeps the focus.
  async function press(): Promise<void> {
    if (held || sendBack === null || refusal !== null) return;
    const mine = { key: card.key, stage: card.stage, state: card.state };
    pressed = mine;
    onrefuse(null);
    const answer = await onsend();
    if (answer === null || pressed !== mine) return;
    pressed = null;
    onrefuse(answer);
  }
</script>

{#if open > 0}
  <section class="next" data-go={sendBack !== null && refusal === null ? 'true' : undefined} aria-labelledby="{uid}-next">
    <h2 class="sub" id="{uid}-next">Next step</h2>
    {#if sendBack !== null}
      <Button
        variant={refusal === null ? 'go' : 'default'}
        size="large"
        class="wide"
        data-run="send-back"
        aria-disabled={refusal !== null || held ? 'true' : undefined}
        aria-busy={held ? 'true' : undefined}
        aria-describedby="{uid}-why"
        onclick={press}>{sendBack.label}</Button
      >
      {#if sendBack.implement.starts !== null}<span class="command">{startsCommand(sendBack.implement.starts)}</span>{/if}
      {#if refusal !== null}<p class="refused">{refusal.message} The card's overview says how to fix it.</p>{/if}
      {#if estimate !== undefined}<p class="estimate"><span class="figure">{estimate.text}</span>, {estimate.from}</p>{/if}
      <p class="estimate">
        {#if session !== null}
          Goes on in the {sendBack.implement.label} session <span class="figure">{session}</span> with {yours} and {sendBack.count === 1 ? 'its line' : 'their lines'}.
        {:else}
          Starts {sendBack.implement.label} fresh with {yours}, since no {sendBack.implement.label} session is left.
        {/if}
      </p>
    {:else}
      <p class="lead">{open === 1 ? '1 comment waits' : `${open} comments wait`} for a send back. It opens once the card is ready in Implement or after it.</p>
    {/if}
    <p class="note" role="status" id="{uid}-why">{held ? 'Sent. Waiting for the board to show it.' : ''}</p>
  </section>
{/if}

<style>
  /* The Next step panel. Its edge is amber only while the button would resume a run;
     an edge is no control and carries no words. */
  .next {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .next[data-go='true'] {
    border-color: var(--amber-line);
  }

  p,
  h2 {
    margin: 0;
  }

  .sub {
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 400;
  }

  .lead {
    color: var(--ink-2);
    font-size: var(--text-sm);
  }

  .next > :global(.btn.wide) {
    width: 100%;
    height: auto;
    min-height: 42px;
    padding-block: 9px;
    line-height: 1.3;
    white-space: normal;
  }

  /* Mono, because it names an engine, a model and an effort. */
  .command {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    min-height: 26px;
    padding: 0 var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: 7px;
    background: var(--card);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .estimate,
  .note {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .note:empty {
    display: none;
  }

  /* The figure in mono and a text ink. Never amber: it is a figure, not the start. */
  .figure {
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  /* A neutral box, as every warning is. */
  .refused {
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink-2);
    font-size: var(--text-xs);
  }
</style>
