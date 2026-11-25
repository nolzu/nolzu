<script lang="ts">
  import type { CardView, StageView } from '@nolzu/protocol';
  import Button from '../Button.svelte';
  import Toast from '../Toast.svelte';
  import { moveView, type RunOnOffer, runOnView, runView, type Seen } from './actions.ts';

  // Both callbacks answer with the sentence the server refused with, or nothing when it took the
  // write. The page owns the request, because this package never fetches.
  let {
    card,
    next,
    starts,
    runOn = null,
    onmove,
    onminimize,
    onretry = async () => null,
    onstop = async () => null,
    onrunon = async () => null,
    onrefuse,
  }: {
    card: CardView;
    next: StageView | null;
    starts: string | undefined;
    // The profiles this card's phase can start on, read on the server. Null when the page has none.
    runOn?: RunOnOffer | null;
    // Undefined when the page sent nothing after all, such as a question the person closed: the
    // button lets go and says nothing.
    onmove: (to: string) => Promise<string | null | undefined>;
    onminimize: (minimized: boolean) => Promise<string | null>;
    onretry?: () => Promise<string | null>;
    onstop?: (runId: number) => Promise<string | null>;
    onrunon?: (profile: string) => Promise<string | null>;
    // Where a refusal goes when the page has a toast host of its own: the sentence, or null when a new
    // press clears it. Without it the refusal is the old single toast drawn here.
    onrefuse?: (said: string | null) => void;
  } = $props();

  // The sentence as the page handed it over. It already names the problem, and a second line
  // written here would be a guess: a refused move and a board that cannot be reached need
  // different advice.
  let refusal = $state<string | null>(null);
  // Every change of the refusal goes through here, so the page's toast follows it.
  function say(said: string | null): void {
    refusal = said;
    onrefuse?.(said);
  }

  // Unique per instance and the same on the server and in the browser, so the button can point at
  // its reason.
  const uid = $props.id();

  // A plain string, so it changes only when this card's key, stage or state does. Every snapshot
  // hands over a new card object, also one that is about another card, and a click keyed on the
  // object would be let go by the first of those.
  const at = $derived(`${card.key} ${card.stage} ${card.state}`);
  // The click, let go as soon as the board moves this card on. A click kept past that would hold
  // the button again on the day the card comes back to the same stage and state.
  let clicked = $derived.by<Seen | null>(() => {
    void at;
    return null;
  });

  const view = $derived(moveView(card, next, starts, clicked));

  // Retry or Stop, let go the same way as the move: when the board shows the card in another state.
  let pressed = $derived.by<Seen | null>(() => {
    void at;
    return null;
  });
  const run = $derived(runView(card, pressed));
  // The same press state as Retry: both start a run of this card, so one of them going holds the
  // other too.
  const other = $derived(runOnView(card, runOn, pressed));

  async function control(): Promise<void> {
    if (run === null || run.busy) return;
    pressed = { key: card.key, stage: card.stage, state: card.state };
    say(null);
    const said = run.kind === 'retry' ? await onretry() : await onstop(run.runId as number);
    // A refusal ends the wait, because no snapshot will. A press the server took is ended by the board.
    if (said !== null) {
      pressed = null;
      say(said);
    }
  }

  // Starts this phase on another login. A fresh run, which the line above the buttons says.
  async function runOnProfile(profile: string): Promise<void> {
    if (other === null || other.busy) return;
    pressed = { key: card.key, stage: card.stage, state: card.state };
    say(null);
    const said = await onrunon(profile);
    if (said !== null) {
      pressed = null;
      say(said);
    }
  }

  // Counts the presses, so an answer can tell whether it is still the latest one.
  let presses = 0;

  // The handler is what refuses a press, not the disabled attribute. A disabled button cannot hold
  // the focus, so the browser would take it away at the press and the person would lose their
  // place on the page.
  async function move(): Promise<void> {
    if (view === null || view.disabled || next === null) return;
    presses += 1;
    const mine = presses;
    clicked = { key: card.key, stage: card.stage, state: card.state };
    say(null);
    const said = await onmove(next.id);
    if (said === undefined) {
      if (mine === presses) clicked = null;
      return;
    }
    // Only a refusal ends the wait here, because then no snapshot will. A move the server took is
    // ended by the board, never by this answer. An answer to an earlier press is dropped: the
    // board has moved on since, and ending the wait of a later press would let a third one through.
    if (said !== null && mine === presses) {
      clicked = null;
      say(said);
    }
  }

  // No wait of its own. The pressed state is the snapshot's, and the value travels with the
  // request, so a second press before the board answers asks for the same thing.
  async function minimize(): Promise<void> {
    say(null);
    const said = await onminimize(!card.minimized);
    say(said);
  }
</script>

<div class="actions" data-actions={card.key}>
  {#if view !== null}
    <!-- The label is inside the button, so it is part of the button's name.
         The button points only at the reason, which sits outside it. Go when the move starts a run,
         because amber is the colour of a run starting, and primary when it starts nothing. -->
    <Button
      variant={view.starts !== undefined ? 'go' : 'primary'}
      size="small"
      data-move={next?.id}
      aria-disabled={view.disabled ? 'true' : undefined}
      aria-busy={view.busy ? 'true' : undefined}
      aria-describedby="{uid}-why"
      onclick={move}
    >
      <span class="move">{view.text}</span>{#if view.starts !== undefined}<span aria-hidden="true" class="sep">·</span> <span class="starts">{view.starts}</span>{/if}
    </Button>
  {/if}
  {#if run !== null}
    <!-- Retry starts a run and Stop ends one, so only Retry is go. -->
    <Button
      variant={run.kind === 'retry' ? 'go' : 'ghost'}
      size="small"
      data-run={run.kind}
      aria-disabled={run.busy ? 'true' : undefined}
      aria-busy={run.busy ? 'true' : undefined}
      onclick={control}>{run.text}</Button
    >
  {/if}
  {#each other?.profiles ?? [] as profile (profile.id)}
    <!-- The profile's own label, because a person names their logins and the id is Nolzu's word. -->
    <Button
      variant="go"
      size="small"
      data-run-on={profile.id}
      aria-disabled={other?.busy ? 'true' : undefined}
      aria-busy={other?.busy ? 'true' : undefined}
      aria-describedby="{uid}-fresh"
      onclick={() => runOnProfile(profile.id)}
    >
      Run on {profile.label}
    </Button>
  {/each}
  <Button variant="ghost" size="small" data-minimize={card.key} aria-pressed={card.minimized ? 'true' : 'false'} onclick={minimize}>Minimize</Button>
</div>
<!-- Always on the page, also when empty. A status region that arrives together with its text is
     not announced, because the reader was not yet listening to it. -->
<p class="why" role="status" id="{uid}-why">{view?.why ?? ''}</p>
{#if other !== null}
  <!-- Before the click, never after it: a person who expected the stopped session to carry on would
       read this too late. The same line says why there is nothing to offer. -->
  <p class="fresh" id="{uid}-fresh">{other.fresh ?? other.note ?? ''}</p>
{/if}
{#if refusal !== null && onrefuse === undefined}
  <Toast kind="error" message={refusal} onclose={() => (refusal = null)} />
{/if}

<style>
  /* The row wraps, so a failed card with Retry and a Run on per login still fits a phone. A button
     alone on its line that is still wider than the row wraps its words, because the label of a move
     carries the model and grows with its name. */
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .actions > :global(.btn.sm) {
    max-width: 100%;
    height: auto;
    min-height: 26px;
    padding-block: 3px;
    white-space: normal;
  }

  /* Svelte drops a space at the start of a block, so the gap before the dot is a margin. The space
     after it is real, and it is the one the button's name needs. */
  .sep {
    margin-left: 0.35em;
  }

  /* On a phone the label wraps. The move keeps its words on one line and the Starts part wraps,
     read from the left like a sentence. */
  .move {
    flex: none;
  }

  .starts {
    font-family: var(--font-mono);
    font-weight: 400;
    text-align: left;
  }

  .why {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-3);
  }

  .fresh {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }
</style>
