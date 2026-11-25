<script lang="ts">
  import { resolve } from '$app/paths';
  import { boardFor } from '@nolzu/core';
  import { type BoardSnapshot, cardStarts, type CardView, type RunActivity } from '@nolzu/protocol';
  import { liveOf, PeekSheet, type PeekView, refusalFromServer, runView } from '@nolzu/ui';
  import { answered, nextStepOf, pressed, stageBefore } from './board-page.ts';
  import DeleteCard from './DeleteCard.svelte';
  import { follow } from './follow.svelte.ts';
  import { nextStepWrites } from './next-step.ts';
  import { postWrite } from './ticket.ts';
  import { toastStack } from './toast-stack.svelte.ts';

  // The peek sheet of one card, on the board and on Now. The card and its activity come from
  // the one stream; what its runs left on this machine (the summary so far, the last log rows, the
  // trail) is asked of the server, again when the card or its run changes and as the run works.
  let {
    card,
    snapshot,
    activity,
    onclose,
  }: {
    card: CardView;
    // The snapshot of the card's own board.
    snapshot: BoardSnapshot;
    activity?: RunActivity;
    onclose: () => void;
  } = $props();
  const board = $derived(boardFor(snapshot.kind, snapshot.flow));
  const stages = $derived(snapshot.stages);

  let clock = $state(new Date());
  $effect(() => {
    const timer = setInterval(() => (clock = new Date()), 1000);
    return () => clearInterval(timer);
  });

  // At most one ask every two seconds while the run works: each engine event moves the activity, and
  // the server reads the whole log for each ask.
  const EVERY_MS = 2000;
  let view = $state<PeekView | null>(null);
  let asked = 0;
  let later: ReturnType<typeof setTimeout> | undefined;

  async function ask(key: string): Promise<void> {
    asked = Date.now();
    try {
      const response = await fetch(resolve('/api/card/[key]/peek', { key: encodeURIComponent(key) }));
      const read = (await response.json()) as PeekView | null;
      // An answer about a card the sheet moved off since, or not a view at all, draws nothing.
      if (response.ok && read?.key === card.key && Array.isArray(read.trail)) view = read;
    } catch {
      // The sheet keeps what it had, and the next change asks again.
    }
  }

  // A new card is asked for at once, with the old card's view cleared, so the sheet never shows one
  // card's summary under another's title.
  let shown: string | null = null;
  $effect(() => {
    const key = card.key;
    // Read so a change of each asks again.
    void card.state;
    void card.runId;
    void card.stage;
    void activity?.outputAt;
    clearTimeout(later);
    if (key !== shown) {
      shown = key;
      view = null;
      void ask(key);
      return;
    }
    const wait = asked + EVERY_MS - Date.now();
    if (wait <= 0) void ask(key);
    else later = setTimeout(() => void ask(key), wait);
    return () => clearTimeout(later);
  });

  const live = $derived(liveOf(card, activity, clock, snapshot.quietAfterMs));
  const label = (id: string | null) => (id === null ? null : (stages.find((stage) => stage.id === id)?.label ?? id));
  const backTo = $derived(stageBefore(board, card.stage));
  // The model each phase to come would start on, for the trail, read off the card's columns.
  const models = $derived(
    Object.fromEntries(
      stages.flatMap((stage) => {
        const starts = cardStarts(stage, card);
        return starts === null ? [] : [[starts.phase, starts.model]];
      }),
    ),
  );

  // Held from the press until the snapshot shows the card moved on, never on the answer.
  let stopAsked = $state<{ runId: number; state: string } | null>(null);
  let backAsked = $state<{ key: string; stage: string } | null>(null);
  const stopping = $derived(stopAsked !== null && card.runId === stopAsked.runId && card.state === stopAsked.state);
  const moving = $derived(backAsked?.key === card.key && backAsked.stage === card.stage);
  // Let go once the card left that column, or the sheet moved to another card. Kept, it would hold
  // Move back again when the card comes back to the column it left.
  $effect(() => {
    if (backAsked !== null && (backAsked.key !== card.key || backAsked.stage !== card.stage)) backAsked = null;
  });

  // One write for this card, with the press and the answer of a move, so a refusal is the card's one toast.
  async function send(path: string, body: unknown): Promise<boolean> {
    const key = card.key;
    toastStack.state = pressed(toastStack.state, key);
    const mine = toastStack.state.press;
    const said = await postWrite(fetch, path, body);
    toastStack.state = answered(toastStack.state, mine, { key, href: resolve('/t/[key]', { key: encodeURIComponent(key) }) }, said === null ? null : refusalFromServer(said));
    return said === null;
  }

  async function stop(): Promise<void> {
    const runId = runView(card, null)?.kind === 'stop' ? card.runId : null;
    if (runId === null || stopping) return;
    stopAsked = { runId, state: card.state };
    if (!(await send(resolve('/api/board/stop'), { runId }))) stopAsked = null;
  }

  // The card page's Next step block, by the same rule and with the same writes. The open comments and
  // the Implement session come with the view, so the block waits for the first answer. A move forward
  // follows the card into its column, as Move back does, so the sheet stays on it.
  const step = $derived(
    view === null ? null : nextStepOf(snapshot, card.key, view.openComments, { card: resolve('/t/[key]/[tab]', { key: encodeURIComponent(card.key), tab: 'settings' }), models: resolve('/settings/[section]', { section: 'models' }) }),
  );
  // Delete card from the block's More actions. Once the card is gone it leaves the snapshot, and the
  // board closes the sheet.
  let deleting = $state<string | null>(null);
  const decision = $derived.by(() => {
    if (step === null) return null;
    const writes = nextStepWrites(card.key);
    const key = card.key;
    return {
      card: step.card,
      stage: label(step.card.stage) ?? step.card.stage,
      next: step.next,
      retry: step.retry,
      back: step.back,
      live,
      fix: step.fix,
      fixIt: step.fixIt,
      sendBack: step.sendBack,
      session: view?.session ?? null,
      level: 3 as const,
      inPeek: true,
      ...writes,
      ondelete: () => (deleting = key),
      // Let go of the card when nothing moved, as Move back does: a refusal or a closed QA question.
      onmove: async (to: string, reason?: string) => {
        follow.state = { key, to };
        const said = await writes.onmove(to, reason);
        if (said !== null && follow.state?.key === key) follow.state = null;
        return said;
      },
    };
  });

  /**
   * The column before, as a drop there moves the card. A running card is stopped first: the server
   * stops the run, waits for its row to end and then moves the card, so the two cannot race. The page
   * follows the card into the column, so the sheet stays on it. Shift Left on the board calls this too.
   */
  export async function back(): Promise<void> {
    const to = backTo;
    if (to === null || moving) return;
    const key = card.key;
    backAsked = { key, stage: card.stage };
    follow.state = { key, to };
    const busy = card.state === 'running' || card.state === 'queued';
    if (!(await send(resolve('/api/board/move'), busy ? { key, to, stop: true } : { key, to }))) {
      backAsked = null;
      if (follow.state?.key === key) follow.state = null;
    }
  }
</script>

<PeekSheet
  {card}
  stage={label(card.stage) ?? card.stage}
  {view}
  {live}
  {clock}
  back={label(backTo)}
  {models}
  {decision}
  {stopping}
  {moving}
  openHref={resolve('/t/[key]', { key: encodeURIComponent(card.key) })}
  logHref={resolve('/t/[key]/[tab]', { key: encodeURIComponent(card.key), tab: 'log' })}
  onstop={() => void stop()}
  onback={() => void back()}
  {onclose}
/>
{#if deleting === card.key}
  <DeleteCard cardKey={card.key} onclose={() => (deleting = null)} ondeleted={() => (deleting = null)} />
{/if}
