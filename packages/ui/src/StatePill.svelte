<script lang="ts">
  import type { CardState } from '@nolzu/protocol';

  // Quiet and New are not card states, so the protocol does not carry them. A page shows Quiet in
  // place of Running once a run has said nothing for a while, so a stuck run never looks busy. New
  // marks a Scout finding or a row nobody has opened yet.
  type PillState = CardState | 'quiet' | 'new';

  // Every state carries a word. Colour alone would leave the state unreadable for anyone who
  // cannot tell the dots apart.
  const LABELS: Record<PillState, string> = {
    idle: 'Idle',
    queued: 'Queued',
    running: 'Running',
    quiet: 'Quiet',
    ready: 'Ready',
    blocked: 'Blocked',
    failed: 'Failed',
    new: 'New',
  };

  // `hideWord` is for the one-line minimized card, which shows the dot only. The word
  // stays in the page for screen readers. `word` is a screen's own word for the state, such as the
  // board card's "Asks you", and every other caller keeps the default. `detailOnly` shows the detail
  // alone and keeps the word for a screen reader: the running card's pill holds its run time, and a
  // time that counts up says running by itself. `check` draws a check in place of the dot, for a closed
  // card: done, and nothing moves.
  let {
    state,
    detail = null,
    hideWord = false,
    word = null,
    detailOnly = false,
    check = false,
  }: { state: PillState; detail?: string | null; hideWord?: boolean; word?: string | null; detailOnly?: boolean; check?: boolean } = $props();
</script>

<span class="pill" data-state={state} data-word-hidden={hideWord ? 'true' : undefined} data-detail-only={detailOnly && detail ? 'true' : undefined}>
  {#if state === 'quiet'}
    <!-- A clock and not a dot: nothing is moving, and the shape says so beside the word. -->
    <svg class="clock" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>
  {:else if check}
    <svg class="clock" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>
  {:else}
    <span class="dot" aria-hidden="true"></span>
  {/if}
  <!-- One text run, so the detail sits a word space after the state, not a flex gap away. -->
  <span><span class="label">{word ?? LABELS[state]}</span> {#if detail}<span class="detail">{detail}</span>{/if}</span>
</span>

<style>
  /* The words take the state colour on the state's own tint. Every status
     colour reaches 4.5:1 on its tint over every surface, which tokens.test.ts holds. Idle and Quiet
     have no tint, only a hairline ring, and write in muted. */
  .pill {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-sizing: border-box;
    height: 22px;
    padding: 0 var(--space-2);
    border-radius: 999px;
    box-shadow: inset 0 0 0 1px var(--line-2);
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
  }

  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }

  .clock {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  [data-state='queued'] {
    box-shadow: inset 0 0 0 1px var(--amber-line);
    color: var(--amber);
  }

  [data-state='queued'] .dot {
    box-sizing: border-box;
    background: transparent;
    border: 1.5px solid var(--amber);
  }

  [data-state='running'] {
    box-shadow: none;
    background: var(--amber-bg);
    color: var(--amber);
  }

  [data-state='running'] .dot {
    background: var(--amber);
    box-shadow: 0 0 0 3px var(--amber-bg);
    animation: pulse 1.6s ease-in-out infinite;
  }

  [data-state='ready'] {
    box-shadow: none;
    background: var(--green-bg);
    color: var(--green);
  }

  [data-state='blocked'] {
    box-shadow: none;
    background: var(--violet-bg);
    color: var(--violet);
  }

  [data-state='failed'] {
    box-shadow: none;
    background: var(--red-bg);
    color: var(--red);
  }

  [data-state='new'] {
    box-shadow: none;
    background: var(--blue-bg);
    color: var(--blue);
  }

  /* The dot alone, with no box around it, on the one-line card. */
  /* No gap: the hidden word leaves an empty item beside the dot. */
  [data-word-hidden='true'] {
    gap: 0;
    height: auto;
    padding: 0;
    box-shadow: none;
    background: none;
  }

  /* The run time is a duration, so it is set in mono like every other one. */
  [data-detail-only='true'] .detail {
    font-family: var(--font-mono);
  }

  [data-detail-only='true'] .label,
  [data-word-hidden='true'] .label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }
</style>
