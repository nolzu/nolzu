<script lang="ts">
  import type { CardView, StageView } from '@nolzu/protocol';
  import { tick } from 'svelte';
  import Button from '../Button.svelte';
  import { chainTarget, dropTarget, refuseDrop, startsCommand, type Usage } from '../board/drop.ts';
  import type { Live } from '../board/quiet.ts';
  import { splitCode } from '../toasts.ts';
  import { type RunOnOffer, runOnView, runView, type Seen, settle } from './actions.ts';
  import { decisionOf, type FixIt, type SendBack } from './decision.ts';
  import ModelPicker from './ModelPicker.svelte';
  import MoreMenu from './MoreMenu.svelte';

  // The card's own row for the phase the button starts, as the Settings tab reads it: what it runs on
  // now, and the profiles a row may name with the models each offers.
  interface Picker {
    action: string;
    engine: string;
    model: string;
    effort: string;
    profiles: readonly { id: string; label: string; models: readonly string[] }[];
  }

  // Every write answers with the sentence the server refused it with, or null when it took it. A move
  // answers undefined when the page sent nothing after all, such as a question the person closed. The
  // page owns the requests, because this package never fetches.
  let {
    card,
    stage,
    next,
    retry = null,
    back = null,
    live = null,
    usage,
    runOn = null,
    picker = null,
    fix = null,
    fixIt = null,
    sendBack = null,
    session = null,
    since = null,
    phone = null,
    threadHref = null,
    why = null,
    findings = null,
    onmove,
    onretry = async () => null,
    onfix = async () => null,
    onsendback = async () => null,
    onstop = async () => null,
    onrunon = async () => null,
    onpick = async () => null,
    onrefuse = () => {},
    oncopy = async () => null,
    ondelete = null,
    level = 2,
    inPeek = false,
  }: {
    card: CardView;
    // The label of the card's stage, such as "Plan".
    stage: string;
    // The stage one column on and the card's own stage for a retry, with the card's own models.
    next: StageView | null;
    retry?: StageView | null;
    // The column a move back goes to, by the rule a drop there follows, or null.
    back?: { to: string; label: string } | null;
    live?: Live | null;
    usage?: Usage;
    runOn?: RunOnOffer | null;
    picker?: Picker | null;
    // Where a refused start is fixed: the toast's sentence and its link.
    fix?: { text: string | null; label: string; href: string } | null;
    // Fix it on a QA FAIL, read off the snapshot's stages, and the Implement session it goes on in,
    // shortened as the facts show it. No session means Implement starts fresh.
    fixIt?: FixIt | null;
    // Send back with comments, while the card has open diff comments. It goes on in the same session.
    sendBack?: SendBack | null;
    session?: string | null;
    // When a blocked card started to wait, as the page says a time ("15:02"), or null.
    since?: string | null;
    // "Answer from your phone too" on a blocked card: locked on Free, from the display document. Null
    // draws no line.
    phone?: 'free' | 'paid' | null;
    threadHref?: string | null;
    // Why the next step makes sense, said over its button. The Review tab says why another round does.
    why?: string | null;
    // The shown review round as conventional comments, for Copy all findings in the foot.
    findings?: { text: string; round: number } | null;
    // `reason` goes with Accept anyway alone: the line the person wrote for the trail.
    onmove: (to: string, reason?: string) => Promise<string | null | undefined>;
    onretry?: () => Promise<string | null>;
    onfix?: () => Promise<string | null>;
    onsendback?: () => Promise<string | null>;
    onstop?: (runId: number) => Promise<string | null>;
    onrunon?: (profile: string) => Promise<string | null>;
    // Engine and model always go together, because a model name means nothing under another engine.
    onpick?: (action: string, choice: { engine: string; model: string } | { effort: string }) => Promise<string | null>;
    // A refusal for the app's one toast stack, or null when a new press takes it down.
    onrefuse?: (said: string | null) => void;
    // The page puts the text on the clipboard, because this package never touches the browser. It
    // answers with the sentence the copy was refused with, or null once the text is there.
    oncopy?: (text: string) => Promise<string | null>;
    // Opens the page's Delete card confirm. It is always the last row of More actions, never the plain
    // button, so a delete is never the most likely other action. Null draws no row.
    ondelete?: (() => void) | null;
    // The heading's level, one under the page's own title: the peek sheet titles the card with an h2.
    level?: 2 | 3;
    // The peek sheet draws its own Stop and Move back in its foot, with their keys, and its Move back
    // stops a running card first. So the block leaves out its own two there.
    inPeek?: boolean;
  } = $props();

  const uid = $props.id();
  const view = $derived(decisionOf(card, stage, next, retry, live, fixIt, sendBack, since));
  // A phase inside a sentence, in lower case ("the plan thread"), and QA kept as it is.
  const lower = (label: string): string => (label === label.toUpperCase() ? label : label.toLowerCase());
  const failedQa = $derived(view.kind === 'qa-failed');
  const go = $derived(view.go);
  // Fix it starts two runs, so it is refused when either one is, and its estimate is their sum.
  const refusal = $derived(go === null ? null : (refuseDrop(go.stage, 'forward') ?? (go.then === undefined ? null : refuseDrop(go.then, 'forward'))));
  const target = $derived(go === null || refusal !== null ? null : go.then === undefined ? dropTarget(go.stage, true, usage) : chainTarget(go.stage, go.then, usage));
  const estimate = $derived(target?.kind === 'starts' ? target.estimate : undefined);
  const window = $derived(target?.kind === 'starts' ? target.usage : undefined);
  // The refusal with its model set apart, so the page can set it in mono as the toast does.
  const said = $derived(refusal === null ? null : (splitCode(refusal.message, refusal.code) ?? [refusal.message, '', '']));
  // The picker belongs to the row the button starts, and to no other.
  const pick = $derived(go !== null && go.stage.starts !== null && picker?.action === go.stage.starts.phase ? picker : null);

  // A plain string, so a press is let go only when this card's key, stage or state moves, and not by a
  // new snapshot object that says the same.
  const at = $derived(`${card.key} ${card.stage} ${card.state}`);
  // Any press holds every button until the board shows the card moved, because each of them starts or
  // ends this card's run. The answer to the request never lets go: the stream does.
  let pressed = $derived.by<Seen | null>(() => {
    void at;
    return null;
  });
  const held = $derived(settle(pressed, card) !== null);
  const run = $derived(runView(card, pressed));
  const other = $derived(runOnView(card, runOn, pressed));

  // Every action besides the main button, most likely first: the first is the one plain
  // button under it, and the rest go into More actions. The peek sheet draws its own Move back. On a
  // QA FAIL the left column links the QA thread, so the panel leaves it out.
  type Extra = { kind: 'back' | 'instead' | 'accept' | 'copy' | 'thread' } | { kind: 'run-on'; id: string; label: string };
  const extras = $derived<Extra[]>([
    ...(back !== null && !inPeek ? [{ kind: 'back' as const }] : []),
    ...(view.instead ? [{ kind: 'instead' as const }] : []),
    ...(view.accept !== null ? [{ kind: 'accept' as const }] : []),
    ...(other?.profiles ?? []).map((profile) => ({ kind: 'run-on' as const, id: profile.id, label: profile.label })),
    ...(findings !== null ? [{ kind: 'copy' as const }] : []),
    ...(threadHref !== null && !failedQa ? [{ kind: 'thread' as const }] : []),
  ]);

  async function send(write: () => Promise<string | null | undefined>): Promise<void> {
    if (held) return;
    const mine = { key: card.key, stage: card.stage, state: card.state };
    pressed = mine;
    onrefuse(null);
    const answer = await write();
    // A refusal ends the wait, because no snapshot will, and so does a move that sent nothing.
    if (answer === null || pressed !== mine) return;
    pressed = null;
    if (answer !== undefined) onrefuse(answer);
  }

  // The handler refuses the press, not the disabled attribute, so the button keeps the focus.
  function start(): void {
    if (go === null || refusal !== null) return;
    const to = go.to;
    void send(() => (go.back ? onsendback() : go.then !== undefined ? onfix() : to === null ? onretry() : onmove(to)));
  }

  // A copy is no write and holds nothing. Its answer goes when the page shows another card.
  let copied = $derived.by(() => (void card.key, ''));
  async function copyFindings(): Promise<void> {
    if (findings === null) return;
    const { text, round } = findings;
    copied = '';
    copied = (await oncopy(text)) ?? `Round ${round} is on the clipboard. Paste it into the pull request.`;
  }

  // Accept anyway asks one line of reason first, for the trail. An empty line is
  // refused here with a sentence and sends nothing; the server refuses one too. All three start over
  // when the card moves, because the page keeps this panel when it shows another card.
  let accepting = $derived.by(() => (void at, false));
  let reason = $derived.by(() => (void at, ''));
  let reasonSaid = $derived.by(() => (void at, ''));
  let reasonField = $state<HTMLInputElement | null>(null);
  async function openReason(): Promise<void> {
    accepting = true;
    await tick();
    reasonField?.focus();
  }
  function accept(event: SubmitEvent, to: string): void {
    event.preventDefault();
    if (reason.trim() === '') {
      reasonSaid = 'Write one line on why it goes on. The reviewer reads it in the trail.';
      reasonField?.focus();
      return;
    }
    reasonSaid = '';
    void send(() => onmove(to, reason.trim()));
  }
</script>

<!-- One action besides the main button: the plain button under it, or a row of More actions. -->
{#snippet extra(one: Extra, menu: boolean)}
  {#if one.kind === 'back' && back !== null}
    {@const to = back.to}
    {@render press(menu, { 'data-move-back': to }, () => send(() => onmove(to)), `${failedQa ? 'Move back to' : 'Send back to'} ${back.label}`, null, true)}
  {:else if one.kind === 'instead' && view.instead}
    {@const to = view.instead.to}
    {@render press(menu, { 'data-move': to }, () => send(() => onmove(to)), view.instead.label, next?.starts ? { text: `Starts: ${startsCommand(next.starts)}` } : null, true)}
  {:else if one.kind === 'accept' && view.accept !== null}
    {@const to = view.accept.to}
    {@render press(menu, { 'data-accept': to, 'aria-disabled': held ? 'true' : undefined }, openReason, view.accept.label, null, false)}
  {:else if one.kind === 'run-on'}
    <!-- Plain, because the one amber button is Retry. The profile's own label, as a person names it. -->
    {@render press(menu, { 'data-run-on': one.id, 'aria-describedby': `${uid}-fresh` }, () => send(() => onrunon(one.id)), `Run on ${one.label}`, null, true)}
  {:else if one.kind === 'copy' && findings !== null}
    <!-- Plain: a copy starts nothing. Nolzu posts nothing to GitHub, so the person pastes it. -->
    {@render press(menu, { 'data-copy-all': '' }, copyFindings, 'Copy all findings', { text: `round ${findings.round}, as conventional comments`, words: true }, false)}
  {:else if one.kind === 'thread' && threadHref !== null}
    {@const label = card.state === 'ready' ? `Ask about the ${lower(stage)}` : `Open the ${lower(stage)} thread`}
    {#if menu}
      <a role="menuitem" href={threadHref}>{label}</a>
    {:else}
      <!-- A link that reads as the quiet buttons beside it, because it opens a page and starts nothing. -->
      <a class="btn-link" href={threadHref}>{label}</a>
    {/if}
  {/if}
{/snippet}

<!-- `holds` marks a press that starts or ends this card's run, so it shows the hold every such press shares. -->
{#snippet press(menu: boolean, attrs: Record<string, string | undefined>, onclick: () => void, label: string, note: { text: string; words?: boolean } | null, holds: boolean)}
  {@const busy = holds && held ? 'true' : undefined}
  {#if menu}
    <button type="button" role="menuitem" aria-disabled={busy} aria-busy={busy} {...attrs} {onclick}>{label}{#if note !== null}<span class="starts" class:copy-note={note.words}>{` ${note.text}`}</span>{/if}</button>
  {:else}
    <Button size="small" aria-disabled={busy} aria-busy={busy} {...attrs} {onclick}>{label}</Button>
    {#if note !== null}<span class="starts" class:copy-note={note.words}>{note.text}</span>{/if}
  {/if}
{/snippet}

{#if view.kind !== 'closed'}
  <section class="decide" data-decision={view.kind} data-go={go !== null && refusal === null ? 'true' : undefined} data-asks={view.kind === 'asks' ? 'true' : undefined} aria-labelledby="{uid}-next">
    <div class="body">
      <svelte:element this={`h${level}`} class="sub" id="{uid}-next">Next step</svelte:element>
      {#if view.title !== null}<p class="title">{view.title}</p>{/if}
      {#if view.lead !== null && view.lead !== ''}<p class="lead">{view.lead}</p>{/if}
      {#if view.link !== undefined}<a class="link wait" href={view.link.href}>{view.link.label}</a>{/if}
      {#if why !== null}<p class="why" data-why>{why}</p>{/if}
      {#if view.kind === 'asks' && phone !== null}
        <!-- Shown only when the page passes `phone`. On Free it reads Coming soon, and a plan that has
             the phone names it. -->
        <p class="phone" data-phone={phone}>
          <svg viewBox="0 0 24 24" aria-hidden="true">{#if phone === 'free'}<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>{:else}<rect x="7" y="3" width="10" height="18" rx="2"></rect><path d="M11 18h2"></path>{/if}</svg>
          Answer from your phone too{#if phone === 'free'}<span class="hide">, locked on Free</span>{/if}
          <span class="chip">{phone === 'free' ? 'Coming soon' : 'Solo'}</span>
        </p>
      {/if}

      {#if go !== null}
        <!-- Amber only while the press would start the run. A refused start keeps its words and loses
             the amber, so the panel never promises a run the server refuses. -->
        <Button
          variant={refusal === null ? 'go' : 'default'}
          size="large"
          class="wide"
          data-run={go.back ? 'send-back' : go.then !== undefined ? 'fix' : go.to === null ? 'retry' : undefined}
          data-move={go.to ?? undefined}
          data-go-button
          aria-disabled={refusal !== null || held ? 'true' : undefined}
          aria-busy={held ? 'true' : undefined}
          aria-describedby="{uid}-why"
          onclick={start}>{go.label}</Button
        >
        {#if go.stage.starts !== null}
          <!-- A pick here changes this card's row only. That is said on hover and with the model select,
               not as a line under it. -->
          <div class="row" title={pick !== null ? 'Applies to this card only' : undefined}>
            {#if pick !== null}
              {@const starts = go.stage.starts}
              <ModelPicker step={go.stage.label} engine={starts.engine} model={starts.model} effort={starts.effort} profiles={pick.profiles} describedby="{uid}-scope" onpick={(choice) => onpick(pick.action, choice)} />
              <span class="hide" id="{uid}-scope">Applies to this card only</span>
            {:else}
              <span class="command">{startsCommand(go.stage.starts)}</span>
            {/if}
          </div>
        {/if}
        {#if refusal !== null && said !== null}
          <!-- The refused toast's words and its link, so the panel and the toast name one fix. -->
          <p class="refused">
            {said[0]}{#if said[1] !== ''}<code>{said[1]}</code>{/if}{said[2]}{#if fix?.text}{` ${fix.text}`}{/if}
            {#if fix !== null}<a class="link" href={fix.href}>{fix.label}</a>{/if}
          </p>
        {/if}
        {#if estimate !== undefined}
          <p class="estimate"><span class="figure">{estimate.text}</span>, {estimate.from}</p>
        {/if}
        {#if window !== undefined}<p class="estimate">{window}</p>{/if}
        {#if go.then !== undefined}
          <!-- What the one press does, under the figure. -->
          <p class="estimate" data-fix-note>
            {#if session !== null}
              Resumes {lower(go.stage.label)} session <span class="figure">{session}</span> with the reason.
            {:else}
              Starts {lower(go.stage.label)} fresh with the reason, since no {lower(go.stage.label)} session is left.
            {/if}
            {go.then.label} runs again after it.
          </p>
        {/if}
        {#if go.back && sendBack !== null}
          {@const yours = sendBack.count === 1 ? 'your comment' : `your ${sendBack.count} comments`}
          <p class="estimate" data-send-back-note>
            {#if session !== null}
              Goes on in the {go.stage.label} session <span class="figure">{session}</span> with {yours} and {sendBack.count === 1 ? 'its line' : 'their lines'}.
            {:else}
              Starts {go.stage.label} fresh with {yours}, since no {go.stage.label} session is left.
            {/if}
          </p>
        {/if}
      {:else if view.move !== null}
        {@const move = view.move}
        <Button variant="primary" size="large" class="wide" data-move={move.to} aria-disabled={held ? 'true' : undefined} aria-busy={held ? 'true' : undefined} onclick={() => send(() => onmove(move.to))}>{move.label}</Button>
      {/if}

      {#if run?.kind === 'stop' && !inPeek}
        {@const runId = run.runId as number}
        <Button data-run="stop" aria-disabled={held ? 'true' : undefined} aria-busy={held ? 'true' : undefined} onclick={() => send(() => onstop(runId))}>{card.state === 'queued' ? 'Remove from queue' : 'Stop'}</Button>
      {/if}
      <!-- Run on is an action under the button or in More actions. Its line stays here, read before the
           press: a person who expected the stopped session to carry on would read it too late. -->
      {#if other !== null}<p class="note" id="{uid}-fresh">{other.fresh ?? other.note ?? ''}</p>{/if}
      <!-- Always on the page, so a reader that listens to it hears the line when it comes. -->
      <p class="note" role="status" id="{uid}-why">{held ? 'Sent. Waiting for the board to show it.' : ''}</p>
    </div>

    {#if extras.length > 0 || accepting || copied !== '' || ondelete !== null}
      <!-- One plain button for the most likely other action, then More actions for the rest.
           Each keeps its data hook, its guard and its busy state wherever it is drawn. -->
      <div class="foot">
        {#if extras[0] !== undefined}{@render extra(extras[0], false)}{/if}
        {#if extras.length > 1 || ondelete !== null}
          <MoreMenu>
            {#each extras.slice(1) as one (one.kind === 'run-on' ? one.id : one.kind)}{@render extra(one, true)}{/each}
            {#if ondelete !== null}<button type="button" role="menuitem" class="danger" data-delete-card onclick={ondelete}>Delete card</button>{/if}
          </MoreMenu>
        {/if}
        {#if view.accept !== null && accepting}
          {@const to = view.accept.to}
          <form class="accept" onsubmit={(event) => accept(event, to)}>
            <label for="{uid}-reason">Why it goes on, in one line for the trail</label>
            <input id="{uid}-reason" bind:this={reasonField} bind:value={reason} maxlength="500" autocomplete="off" data-reason aria-describedby="{uid}-reason-said" />
            <div class="row">
              <Button type="submit" size="small" data-move={to} aria-disabled={held ? 'true' : undefined} aria-busy={held ? 'true' : undefined}>{view.accept.label}</Button>
              <Button variant="ghost" size="small" onclick={() => (accepting = false)}>Cancel</Button>
            </div>
            <p class="note" role="status" id="{uid}-reason-said">{reasonSaid}</p>
          </form>
        {/if}
        {#if findings !== null}<p class="note copied" role="status">{copied}</p>{/if}
      </div>
    {/if}
  </section>
{/if}

<style>
  /* The decision panel. Its edge takes the state of the next step: amber while the button
     would start a run, violet while the agent asks. An edge is no control and carries no words. */
  .decide {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .decide[data-go='true'] {
    border-color: var(--amber-line);
  }

  .decide[data-asks='true'] {
    border-color: var(--violet);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 14px;
  }

  p,
  .sub {
    margin: 0;
  }

  .sub {
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 400;
  }

  .title {
    color: var(--ink);
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.015em;
  }

  .lead {
    color: var(--ink-2);
    font-size: var(--text-sm);
  }

  .why {
    color: var(--ink);
    font-size: var(--text-base);
    line-height: 1.5;
  }

  .body > :global(.btn.wide) {
    width: 100%;
    height: auto;
    min-height: 42px;
    padding-block: 9px;
    line-height: 1.3;
    white-space: normal;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  /* What the step runs on when there is no picker: one chip, as high as the picker's selects. */
  .command {
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

  /* The figure, in mono and a text ink. Never amber: it is a figure, not the start. */
  .figure {
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  /* A neutral box, as every warning is. The model is mono. */
  .refused {
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .link {
    color: var(--blue);
    font-size: var(--text-xs);
  }

  .link.wait {
    align-self: flex-start;
    font-size: var(--text-sm);
  }

  /* A plain muted row with no box: the plan chip is cream and never amber. */
  .phone {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .phone svg {
    flex: none;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }

  .chip {
    margin-left: auto;
    padding: 1px var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: 999px;
    background: var(--panel);
    color: var(--ink-2);
    font-size: var(--text-2xs);
  }

  .hide {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* The reason takes the foot's whole width, under Move back. */
  .accept {
    display: grid;
    flex-basis: 100%;
    gap: 6px;
  }

  input {
    box-sizing: border-box;
    width: 100%;
    min-height: 30px;
    padding: 0 var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
  }

  /* One column of full-width rows, for the quiet actions and for the two moves of a QA FAIL. */
  .foot {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    padding: 10px 14px;
    border-top: 1px solid var(--line);
    background: var(--card);
  }

  .foot > :global(button) {
    justify-content: flex-start;
  }

  .foot > .note {
    margin: 0;
  }

  /* Red words, as the danger button draws an action that deletes. The menu's own rule sets the ink, so
     this one has to name the row. */
  .foot :global([role='menuitem'].danger) {
    color: var(--red);
  }

  /* What the plain move beside Send back with comments would start. */
  .starts {
    align-self: flex-start;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  /* Words, not a command, so Geist and not mono. */
  .copy-note {
    font-family: inherit;
    font-size: var(--text-2xs);
  }

  /* A link that reads as the quiet buttons beside it, because it opens a page and starts nothing. */
  .btn-link {
    display: inline-flex;
    align-items: center;
    height: 26px;
    padding: 0 calc(var(--space-2) + 1px);
    border-radius: var(--radius-md);
    color: var(--ink);
    font-size: var(--text-xs);
    text-decoration: none;
  }

  .btn-link:hover {
    background: var(--panel);
  }
</style>
