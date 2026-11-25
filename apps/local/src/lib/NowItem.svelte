<script lang="ts">
  import { resolve } from '$app/paths';
  import type { CardView } from '@nolzu/protocol';
  import { Banner, Button, Markdown, OptionButtons, pickOption, settle, StatePill } from '@nolzu/ui';
  import { backStep, longSummary, type NowItem, startStep, whenLine } from './now.ts';

  // One card in Waiting on you, finished right here: a question answered, a result approved or sent
  // back, a failed run retried. The page does the writes, because it owns the toasts. Busy comes from
  // the snapshot: a press holds its button until the board shows the card moved, never on the answer.
  let {
    item,
    clock,
    onanswer,
    onwrite,
  }: {
    item: NowItem;
    clock: Date | undefined;
    // Answers with the sentence the answer was refused with, or null once the run is queued.
    onanswer: (key: string, text: string) => Promise<string | null>;
    // A move or a retry. False when it was refused, which the page says in a toast.
    onwrite: (key: string, path: string, body: unknown) => Promise<boolean>;
  } = $props();

  const card = $derived(item.card);
  type Seen = Pick<CardView, 'key' | 'stage' | 'state'>;
  const seen = $derived<Seen>({ key: card.key, stage: card.stage, state: card.state });
  // The card as it was at the press, until the snapshot shows it in another stage or state.
  let press = $state<Seen | null>(null);
  const busy = $derived(settle(press, seen) !== null);

  const start = $derived(startStep(item));
  const back = $derived(backStep(item));
  const options = $derived(card.questionOptions ?? []);
  const key = $derived(encodeURIComponent(card.key));

  let draft = $state('');
  // A long run summary shows its first lines until the person asks for the rest.
  let open = $state(false);
  let status = $state('');
  const held = $derived(busy || draft.trim() === '');

  const PILLS = {
    asks: { state: 'blocked', word: 'Asks you' },
    ready: { state: 'ready', word: 'Ready for you' },
    'qa-failed': { state: 'failed', word: 'QA failed' },
    failed: { state: 'failed', word: null },
    'tasks-done': { state: 'ready', word: 'Tasks done' },
    review: { state: 'queued', word: 'Waits for Knowledge' },
  } as const;
  const pill = $derived(PILLS[item.kind]);

  async function answer(): Promise<void> {
    if (held) return;
    press = seen;
    status = '';
    const refused = await onanswer(card.key, draft);
    if (refused === null) {
      status = 'Sent. Waiting for the board to queue the run.';
      return;
    }
    press = null;
    status = refused;
  }

  async function write(path: string, body: unknown): Promise<void> {
    if (busy) return;
    press = seen;
    if (!(await onwrite(card.key, path, body))) press = null;
  }
</script>

<!-- Focusable by script, so J reaches it. The key and the title open the card. -->
<article class="item" data-kind={item.kind} data-card={card.key} data-now-item data-now-row tabindex="-1" aria-labelledby="now-{card.key}">
  <div class="hd">
    <StatePill state={pill.state} word={pill.word} />
    <a class="key" href={resolve('/t/[key]', { key })}>{card.key}</a>
    <a class="tt" id="now-{card.key}" href={resolve('/t/[key]', { key })} title={card.title}>{card.title}</a>
    <span class="when">{whenLine(item, clock)}</span>
  </div>

  {#if item.kind === 'asks'}
    <p class="q">{card.question ?? 'The agent stopped to ask, and wrote no question.'}</p>
    <div class="acts">
      <OptionButtons {options} answer={draft} onpick={(label) => (draft = pickOption(draft, options, label))} compact />
      <label class="hidden" for="answer-{card.key}">Your answer</label>
      <textarea id="answer-{card.key}" rows="1" bind:value={draft} placeholder="Or write your own answer"></textarea>
      <!-- Go, because the answer resumes the run's session. With no session the send only fails the
           card, so nothing starts and the button is the plain primary one. -->
      {#if item.extra.resumable}
        <Button variant="go" glyph="resume" aria-disabled={held ? 'true' : undefined} aria-busy={busy ? 'true' : undefined} data-send-answer onclick={answer}>Send and resume</Button>
      {:else}
        <Button variant="primary" aria-disabled={held ? 'true' : undefined} aria-busy={busy ? 'true' : undefined} data-send-answer onclick={answer}>Send answer</Button>
      {/if}
    </div>
    <p class="status" role="status">{status}</p>
    {#if !item.extra.resumable}
      <p class="note">This run has no session, so it cannot go on. Sending fails the card with the reason, and the card can then be moved back.</p>
    {/if}
  {:else}
    {#if item.kind === 'ready' && item.extra.summary !== null}
      <!-- The run writes Markdown, and a long one is cut to three lines, because Now is a list. -->
      {@const long = longSummary(item.extra.summary)}
      <div class="summary" class:clamp={long && !open} id="summary-{card.key}"><Markdown source={item.extra.summary} headingsFrom={4} /></div>
      {#if long}
        <button type="button" class="more" aria-expanded={open} aria-controls="summary-{card.key}" onclick={() => (open = !open)}>{open ? 'Show less' : 'Show all'}</button>
      {/if}
    {:else if item.kind === 'tasks-done' && card.delivered !== null}
      <!-- Wrap-up starts an agent, so the epic waits for the person to start it. -->
      <p class="summary">All {card.delivered.total} tasks are done on Delivery. The epic stays where it is until you move it.</p>
    {/if}
    {#if item.kind === 'ready' && item.extra.chainRefused !== undefined}
      <!-- The chain the person turned on did not start the next stage, so the card waits here. A
           warning and not a failure, so a neutral box. -->
      <Banner kind="warning">{item.extra.chainRefused}</Banner>
    {:else if item.kind === 'ready' && item.extra.holds !== undefined}
      <!-- Why the run did not close the card: what it left still waits on the person. A neutral box,
           as for a chain that did not start, because nothing failed. -->
      <span data-holds><Banner kind="warning">{item.extra.holds}</Banner></span>
    {:else if item.kind === 'qa-failed'}
      <p class="why">{card.verdictReason ?? 'QA failed and gave no reason.'}</p>
    {:else if item.kind === 'failed'}
      <p class="why">{card.failureReason ?? 'The run failed and gave no reason.'}</p>
    {:else if item.kind === 'review'}
      {@const stage = item.board.stages.find((one) => one.id === card.stage)?.label ?? card.stage}
      <p class="why">{stage} writes knowledge, so it starts by itself once no change waits on Knowledge and no other knowledge run is going.</p>
    {/if}
    <!-- The main action with what it starts beside it, then the link and Send back, all 30px high. -->
    <div class="acts">
      {#if start?.kind === 'go'}
        <Button variant="go" aria-busy={busy ? 'true' : undefined} aria-disabled={busy ? 'true' : undefined} data-approve onclick={() => write(resolve('/api/board/move'), { key: card.key, to: start.to })}>{start.label}</Button>
      {:else if start?.kind === 'fix'}
        <!-- One press is the consent for both runs, so it is the go button. -->
        <Button variant="go" aria-busy={busy ? 'true' : undefined} aria-disabled={busy ? 'true' : undefined} data-fix onclick={() => write(resolve('/api/card/[key]/fix', { key }), {})}>{start.label}</Button>
      {:else if start?.kind === 'retry'}
        <Button variant="go" aria-busy={busy ? 'true' : undefined} aria-disabled={busy ? 'true' : undefined} data-retry onclick={() => write(resolve('/api/card/[key]/retry', { key }), {})}>{start.label}</Button>
      {:else if start?.kind === 'move'}
        <Button aria-busy={busy ? 'true' : undefined} aria-disabled={busy ? 'true' : undefined} data-approve onclick={() => write(resolve('/api/board/move'), { key: card.key, to: start.to })}>{start.label}</Button>
      {:else if start?.kind === 'refused' && !item.extra.chainRefused?.endsWith(start.reason)}
        <!-- Hidden when the chain's box above already says the same reason, so it shows once. -->
        <span class="refused">{start.reason}</span>
      {/if}
      {#if start !== null && 'line' in start}
        <span class="cost">{start.line}</span>
      {/if}
      {#if item.kind === 'qa-failed'}
        <a class="link" href="{resolve('/t/[key]/[tab]', { key, tab: 'overview' })}#qa-panel">See the QA report</a>
      {:else if item.kind === 'review'}
        <a class="link" href={resolve('/knowledge')}>Open Knowledge</a>
      {:else if item.kind === 'ready' && card.stage === 'plan'}
        <!-- The overview draws the plan as steps under its own heading. -->
        <a class="link" href="{resolve('/t/[key]/[tab]', { key, tab: 'overview' })}#plan">Read the plan</a>
      {:else}
        <a class="link" href={resolve('/t/[key]/[tab]', { key, tab: 'overview' })}>Open the card</a>
      {/if}
      {#if back !== null}
        <Button variant="ghost" aria-busy={busy ? 'true' : undefined} aria-disabled={busy ? 'true' : undefined} aria-label="Send {card.key} back to {back.label}" data-send-back onclick={() => write(resolve('/api/board/move'), { key: card.key, to: back.to })}
          >Send back</Button
        >
      {/if}
    </div>
  {/if}
</article>

<style>
  /* The item: a card with an edge in its state's colour, the pill and the words carry the state. */
  .item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 10px var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--card);
  }

  .item[data-kind='asks'] {
    border-color: color-mix(in oklch, var(--violet) 40%, transparent);
  }

  .item[data-kind='ready'],
  .item[data-kind='tasks-done'] {
    border-color: color-mix(in oklch, var(--green) 35%, transparent);
  }

  .item[data-kind='qa-failed'],
  .item[data-kind='failed'] {
    border-color: color-mix(in oklch, var(--red) 40%, transparent);
  }

  /* One row: a long title is cut to one line, so the time never drops onto a row of its own. */
  .hd {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .hd > :global(*) {
    flex: none;
  }

  .key {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--muted);
    text-decoration: none;
  }

  .hd > .tt {
    flex: 1 1 auto;
  }

  .tt {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--ink);
    text-decoration: none;
  }

  .key:hover,
  .tt:hover {
    text-decoration: underline;
  }

  /* On a phone the pill, the key and the time leave the title almost no room, so it takes a row of
     its own under them. */
  @media (max-width: 560px) {
    .hd {
      flex-wrap: wrap;
    }

    .hd > .tt {
      order: 1;
      flex-basis: 100%;
    }
  }

  /* 11.5px, which the scale has as the card key's mono size. */
  .when {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--mono-card-key);
    color: var(--muted);
  }

  p {
    margin: 0;
  }

  .q,
  .why {
    padding: var(--space-2) 10px;
    border-radius: var(--radius-md);
    color: var(--ink);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .q {
    background: var(--violet-bg);
    font-size: var(--text-base);
  }

  .why {
    background: var(--red-bg);
    font-size: var(--text-sm);
  }

  /* Two to five sentences by the skill's rule, filling the card up to 120ch. An
     implement run writes more, with lists and code, so a long one stops at three lines until Show all. */
  .summary {
    max-width: min(100%, 120ch);
    font-size: var(--text-base);
    line-height: 1.55;
    color: var(--ink-2);
  }

  .summary :global(.markdown) {
    color: var(--ink-2);
  }

  /* No gap above the first line or below the last, so the three lines are three lines of text. */
  .summary :global(.markdown > :first-child) {
    margin-top: 0;
  }

  .summary :global(.markdown > :last-child) {
    margin-bottom: 0;
  }

  /* The fade hides a line that a paragraph or list margin pushed half out of the box. */
  .summary.clamp {
    max-height: calc(1.55em * 3);
    overflow: hidden;
    mask-image: linear-gradient(to bottom, #000 calc(100% - 1.55em), transparent);
  }

  .more {
    align-self: flex-start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: var(--text-sm);
    text-decoration: underline;
    cursor: pointer;
  }

  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  /* A textarea and not an input, because a press puts the option and the typed text on two lines. */
  textarea {
    flex: 1 1 220px;
    box-sizing: border-box;
    min-height: 30px;
    padding: 5px 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
    line-height: 1.4;
    resize: vertical;
    field-sizing: content;
  }

  /* Where the field grows with its text, the field has no grip. */
  @supports (field-sizing: content) {
    textarea {
      resize: none;
    }
  }

  .cost,
  .refused {
    font-family: var(--font-mono);
    font-size: var(--mono-card-key);
    color: var(--muted);
  }

  .refused {
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--red);
  }

  /* The default button, as a link, because it opens a page. */
  .link {
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    height: 30px;
    padding: 0 var(--space-3);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-sm);
    text-decoration: none;
    white-space: nowrap;
  }

  .link:hover {
    background: var(--card-2);
  }

  .status,
  .note {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  /* Always in the page, so a screen reader is listening before the answer comes. Empty, it takes no
     room in the column's gap. */
  .status:empty {
    position: absolute;
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
