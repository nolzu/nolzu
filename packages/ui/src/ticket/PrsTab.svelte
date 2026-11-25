<script lang="ts">
  import { type CardState, type Estimate, estimateFrom, estimateText } from '@nolzu/protocol';
  import { onMount, tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import Button from '../Button.svelte';
  import Chip from '../Chip.svelte';
  import Markdown from '../Markdown.svelte';
  import { startsCommand } from '../board/drop.ts';
  import Ago from './Ago.svelte';
  import PrLinks from './PrLinks.svelte';
  import type { Seen } from './actions.ts';
  import { discussionLink, firstLine, fixAllView, fixView, type PrDiscussion, qaFixesView, readWords, reviewerOf, splitRows, triageView, unread } from './prs.ts';

  interface CardPull {
    id: number;
    repo: string;
    number: number;
    url: string | null;
    title: string | null;
    state: 'open' | 'closed' | 'merged' | null;
    foundBy: 'branch' | 'attached';
    readAt: string | null;
  }

  // The PRs tab of a Delivery card: its pull requests, "Read comments", and one row per discussion as
  // the last read stored it. Reading is a direct gh read, not a run, so the button holds its own pending
  // state. Nothing on this tab writes to GitHub. `onread` answers the sentence to show and whether it
  // failed; `onmark` answers a refusal or null; `onopen` marks the messages seen as the tab opens, so
  // the dots drawn now are gone the next time. Run triage starts a read-only run, so its button is
  // held off the card in the snapshot (`card`), not off the press; `ontriage` answers a refusal or
  // null. `oncopy` puts a drafted reply on the clipboard and answers a refusal or null. `onfix` starts a
  // Fix on one row, a run held off the snapshot like triage, and answers a refusal or null; `ondiscuss`
  // opens the row's thread on the Discussion tab and answers a refusal or null. Without `onfix` the
  // rows offer neither. `changesHref` is where a fixed row sends the person to commit and push.
  // `onfixall` starts Fix all, one run over every row triage wants fixed; null draws no button.
  // `qaFixes` is the refs fixed since the last QA, and `onqa` starts QA the fixes over them; a null
  // `qaFixes` draws no button. Both are runs, held off the snapshot like triage.
  let {
    pulls,
    discussions,
    now,
    onread,
    onmark,
    onopen,
    onattach,
    ondetach,
    card = null,
    triage = null,
    ontriage = async () => null,
    oncopy = async () => null,
    onfix = null,
    ondiscuss = async () => null,
    changesHref = null,
    onfixall = null,
    qaFixes = null,
    onqa = async () => null,
  }: {
    pulls: readonly CardPull[];
    discussions: readonly PrDiscussion[];
    now: string;
    onread: () => Promise<{ said: string; failed: boolean }>;
    onmark: (ref: string, action: 'done' | 'reopen') => Promise<string | null>;
    onopen: () => void;
    onattach: (link: string) => Promise<string | null>;
    ondetach: (link: string) => Promise<string | null>;
    card?: (Seen & { state: CardState }) | null;
    // What the run starts on and costs, why it would be refused, and why the triage file in the card
    // folder was refused. Null where the page offers no triage.
    triage?: { starts: Parameters<typeof startsCommand>[0]; estimate: Estimate | undefined; refusal: string | null; problem: string | null } | null;
    ontriage?: () => Promise<string | null>;
    oncopy?: (text: string) => Promise<string | null>;
    onfix?: ((ref: string) => Promise<string | null>) | null;
    ondiscuss?: (ref: string) => Promise<string | null>;
    changesHref?: string | null;
    onfixall?: (() => Promise<string | null>) | null;
    qaFixes?: readonly string[] | null;
    onqa?: () => Promise<string | null>;
  } = $props();

  onMount(() => onopen());

  const uid = $props.id();
  const STATUS_WORD = { new: 'New', fixing: 'Fixing', fixed: 'Fixed', done: 'Done' } as const;
  const VERDICT_WORD = { fix: 'Fix', reject: 'Reject', clarify: 'Clarify', defer: 'Defer', none: 'None' } as const;

  let busy = $state(false);
  let said = $state('');
  let failed = $state(false);
  const opened = new SvelteSet<string>();
  let root: HTMLElement | undefined = $state();

  const clock = $derived(new Date(now));
  // The newest read of any of the card's pull requests.
  const readAt = $derived(pulls.reduce<string | null>((newest, one) => (one.readAt !== null && (newest === null || one.readAt > newest) ? one.readAt : newest), null));
  const rows = $derived(splitRows(discussions));
  const unreadCount = $derived(discussions.filter(unread).length);
  // Each pull request with how many discussions a detach would take, for its question.
  const pullRows = $derived(pulls.map((one) => ({ ...one, discussions: discussions.filter((row) => row.pull === one.id).length })));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  async function read(): Promise<void> {
    if (busy) return;
    busy = true;
    said = 'Reading the comments from GitHub.';
    failed = false;
    const done = await onread();
    busy = false;
    said = done.said;
    failed = done.failed;
  }

  async function mark(ref: string, action: 'done' | 'reopen'): Promise<void> {
    if (busy) return;
    busy = true;
    const refused = await onmark(ref, action);
    busy = false;
    said = refused ?? '';
    failed = refused !== null;
    // The row moves between the list and the footer, so the pressed button is gone and focus would
    // drop to the page. It goes to the row where it landed, or to the footer while that is folded.
    await tick();
    const toggle = root?.querySelector<HTMLElement>(`[data-ref="${ref}"] .toggle`);
    const fold = toggle?.closest('details');
    (fold && !fold.open ? fold.querySelector('summary') : toggle)?.focus();
  }

  // The sentence of the last read is about the pull requests the card had then, such as "No pull
  // request was found". Once one is attached or detached it is out of date, so it goes.
  const changing =
    (change: (link: string) => Promise<string | null>) =>
    async (link: string): Promise<string | null> => {
      const refused = await change(link);
      if (refused === null) said = '';
      return refused;
    };

  // Let go when the card's key, stage or state moves, as the Send back panel does.
  const at = $derived(card === null ? '' : `${card.key} ${card.stage} ${card.state}`);
  let pressed = $derived.by<Seen | null>(() => {
    void at;
    return null;
  });
  const view = $derived(triageView(discussions, card, triage?.refusal ?? null, pressed));
  // The Fix press, let go the same way as the triage press.
  let fixPressed = $derived.by<Seen | null>(() => {
    void at;
    return null;
  });

  // Which row's Fix was pressed, so only that button says it is busy until the board answers.
  let fixRef = $state<string | null>(null);
  async function fix(item: PrDiscussion): Promise<void> {
    if (onfix === null || card === null || fixView(discussions, item, card, fixPressed).why !== null) return;
    const mine = { key: card.key, stage: card.stage, state: card.state };
    fixPressed = mine;
    fixRef = item.ref;
    said = '';
    failed = false;
    const refused = await onfix(item.ref);
    if (refused === null || fixPressed !== mine) return;
    fixPressed = null;
    said = refused;
    failed = true;
  }

  // Fix all and QA the fixes, each let go the same way as the triage press.
  let allPressed = $derived.by<Seen | null>(() => {
    void at;
    return null;
  });
  let qaPressed = $derived.by<Seen | null>(() => {
    void at;
    return null;
  });
  const allView = $derived(fixAllView(discussions, card, allPressed));
  const qaView = $derived(qaFixesView(qaFixes ?? [], discussions, card, qaPressed));

  async function fixAll(): Promise<void> {
    if (onfixall === null || allView.why !== null || card === null) return;
    const mine = { key: card.key, stage: card.stage, state: card.state };
    allPressed = mine;
    said = '';
    failed = false;
    const refused = await onfixall();
    if (refused === null || allPressed !== mine) return;
    allPressed = null;
    said = refused;
    failed = true;
  }

  async function runQa(): Promise<void> {
    if (qaView.why !== null || card === null) return;
    const mine = { key: card.key, stage: card.stage, state: card.state };
    qaPressed = mine;
    said = '';
    failed = false;
    const refused = await onqa();
    if (refused === null || qaPressed !== mine) return;
    qaPressed = null;
    said = refused;
    failed = true;
  }

  // Discuss writes the thread and opens the Discussion tab, so a second press waits for the first.
  let discussing = $state<string | null>(null);
  async function discuss(item: PrDiscussion): Promise<void> {
    if (discussing !== null) return;
    discussing = item.ref;
    const refused = await ondiscuss(item.ref);
    discussing = null;
    if (refused === null) return;
    said = refused;
    failed = true;
  }

  async function runTriage(): Promise<void> {
    if (view.why !== null || card === null) return;
    const mine = { key: card.key, stage: card.stage, state: card.state };
    pressed = mine;
    said = '';
    failed = false;
    const refused = await ontriage();
    if (refused === null || pressed !== mine) return;
    pressed = null;
    said = refused;
    failed = true;
  }

  async function copy(item: PrDiscussion): Promise<void> {
    if (item.reply === null) return;
    const refused = await oncopy(item.reply);
    said = refused ?? `The reply to ${item.ref} is on the clipboard. Post it on GitHub yourself.`;
    failed = refused !== null;
  }

  function toggle(ref: string): void {
    if (!opened.delete(ref)) opened.add(ref);
  }
</script>

{#snippet row(item: PrDiscussion, quiet: boolean)}
  {@const open = opened.has(item.ref)}
  {@const fresh = unread(item)}
  <li class="row" data-ref={item.ref}>
    <div class="head">
      <button type="button" class="toggle" aria-expanded={open} aria-controls="{uid}-{item.ref}" onclick={() => toggle(item.ref)}>
        <span class="dot" class:on={fresh} aria-hidden="true"></span>
        {#if fresh}<span class="sr">Unread.</span>{/if}
        <span class="ref mono">{item.ref}</span>
        <span class="line">{firstLine(item.messages[0]?.body ?? '')}</span>
      </button>
      <span class="meta">
        <span>{reviewerOf(item)}</span>
        <span>{plural(item.messages.length, 'message')}</span>
        {#if item.kind === 'thread' && item.path !== null}<span class="mono path">{item.path}{item.line === null ? '' : `:${item.line}`}</span>{/if}
        {#if item.verdict !== null}<Chip>{VERDICT_WORD[item.verdict]}</Chip>{/if}
        <Chip>{STATUS_WORD[item.status]}</Chip>
        <a href={discussionLink(item, pulls)} target="_blank" rel="noreferrer" aria-label="Open {item.ref} on GitHub">GitHub</a>
        {#if quiet}
          <!-- One way back per footer row: a done row reopens, a row triage left alone needs action. -->
          {#if item.status === 'done'}
            <Button size="small" disabled={busy} data-reopen={item.ref} aria-label="Reopen {item.ref}" onclick={() => mark(item.ref, 'reopen')}>Reopen</Button>
          {:else}
            <Button size="small" disabled={busy || item.status === 'fixing'} data-needs={item.ref} aria-label="{item.ref} needs action" onclick={() => mark(item.ref, 'reopen')}>Needs action</Button>
          {/if}
        {/if}
      </span>
    </div>
    {#if onfix !== null}
      {@const fixing = fixView(discussions, item, card, fixPressed)}
      <div class="triage fix">
        {#if item.status === 'fixing' && item.fixAsks}
          <p class="note">Fix asks a question. Answer it on the Overview tab, and the fix goes on.<span class="said-fix">{item.fixAsks}</span></p>
        {:else if item.status === 'fixing'}
          <p class="note">Fixing. The Implement session is changing the code.</p>
        {:else if item.status === 'fixed'}
          <p class="note">
            {#if changesHref === null}Fixed, commit and push from Changes.{:else}Fixed, commit and push from <a href={changesHref}>Changes</a>.{/if}
            {#if item.fixNote}<span class="said-fix">{item.fixNote}</span>{/if}
          </p>
        {:else if item.status === 'new' && item.fixFailed}
          <p class="note failed">Fix failed: {item.fixFailed}</p>
        {/if}
        <div class="acts">
          {#if item.status !== 'done'}
            <Button size="small" data-fix={item.ref} disabled={fixing.why !== null} aria-busy={item.status === 'fixing' || (fixPressed !== null && fixRef === item.ref) ? 'true' : undefined} aria-label="{fixing.label} {item.ref}" aria-describedby={fixing.why === null ? undefined : `${uid}-${item.ref}-fix`} onclick={() => fix(item)}>{fixing.label}</Button>
          {/if}
          <Button size="small" data-discuss={item.ref} aria-label="Discuss {item.ref}" aria-busy={discussing === item.ref ? 'true' : undefined} aria-disabled={discussing !== null ? 'true' : undefined} onclick={() => discuss(item)}>Discuss</Button>
          {#if item.status !== 'done' && fixing.why !== null}<span class="muted why" id="{uid}-{item.ref}-fix">{fixing.why}</span>{/if}
        </div>
      </div>
    {/if}
    {#if item.summary !== null || item.reply !== null}
      <div class="triage">
        {#if item.summary !== null}<p class="summary">{item.summary}</p>{/if}
        {#if item.reply !== null}
          <div class="reply">
            <p class="draft"><span class="sr">Drafted reply:</span> {item.reply}</p>
            <Button size="small" data-copy={item.ref} aria-label="Copy the reply to {item.ref}" onclick={() => copy(item)}>Copy</Button>
          </div>
        {/if}
      </div>
    {/if}
    {#if open}
      <div class="body" id="{uid}-{item.ref}">
        {#if item.reason !== null}<p class="reason"><span class="who">Why {item.verdict === null ? 'this' : VERDICT_WORD[item.verdict].toLowerCase()}:</span> {item.reason}</p>{/if}
        <ol class="messages">
          {#each item.messages as message (message.id)}
            <li>
              <p class="by">
                <span class="who">{message.author ?? 'Deleted account'}{message.mine ? ' (you)' : ''}</span>
                <Ago at={message.createdAt} now={clock} />
                {#if message.unread}<span class="new">Unread</span>{/if}
              </p>
              <Markdown source={message.body} headingsFrom={4} />
            </li>
          {/each}
        </ol>
        {#if item.status !== 'done'}
          <div class="acts">
            <Button size="small" disabled={busy || item.status === 'fixing'} data-done={item.ref} onclick={() => mark(item.ref, 'done')}>Mark done</Button>
          </div>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

<div class="tab" bind:this={root}>
  <PrLinks pulls={pullRows} onattach={changing(onattach)} ondetach={changing(ondetach)} />

  <section class="comments" aria-labelledby="{uid}-title">
    <div class="bar">
      <h2 id="{uid}-title">Comments</h2>
      <span class="muted">
        {readWords(readAt, clock)}{#if readAt !== null}, {plural(discussions.length, 'discussion')}, {unreadCount} unread{/if}
      </span>
      <span class="end">
        <Button disabled={busy} aria-busy={busy ? 'true' : undefined} onclick={read}>Read comments</Button>
        {#if triage !== null && discussions.length > 0}
          <Button data-run="triage" disabled={busy || view.why !== null} aria-busy={pressed !== null ? 'true' : undefined} aria-describedby="{uid}-triage" onclick={runTriage}>{view.label}</Button>
        {/if}
        {#if onfixall !== null && discussions.length > 0}
          <Button data-run="fix-all" disabled={busy || allView.why !== null} aria-busy={allPressed !== null ? 'true' : undefined} aria-describedby="{uid}-fixes" onclick={fixAll}>{allView.label}</Button>
        {/if}
        {#if qaFixes !== null && discussions.length > 0}
          <Button data-run="qa-fixes" disabled={busy || qaView.why !== null} aria-busy={qaPressed !== null ? 'true' : undefined} aria-describedby="{uid}-fixes" onclick={runQa}>{qaView.label}</Button>
        {/if}
      </span>
    </div>
    {#if triage !== null && discussions.length > 0}
      <p class="muted" id="{uid}-triage">
        {#if view.why !== null}{`${view.why} `}{/if}Triage runs on <span class="figure">{startsCommand(triage.starts)}</span>. It reads the comments and the code, changes nothing and posts nothing to GitHub.
        {#if triage.estimate !== undefined}What it takes: <span class="figure">{estimateText(triage.estimate)}</span>, {estimateFrom(triage.estimate)}.{/if}
      </p>
      {#if triage.problem !== null}<p class="muted failed" role="alert">{triage.problem}</p>{/if}
    {/if}
    {#if onfix !== null && discussions.length > 0}
      <p class="muted">Fix goes on in the card's Implement session and only changes files. You commit and push from Changes, and post replies on GitHub yourself. Discuss asks a read-only session about one comment.</p>
    {/if}
    {#if (onfixall !== null || qaFixes !== null) && discussions.length > 0}
      <p class="muted" id="{uid}-fixes">
        {#if onfixall !== null}Fix all does the same for every comment triage marked fix, in one run.{#if allView.why !== null}{` Fix all: ${allView.why}`}{/if}{/if}
        {#if qaFixes !== null}QA the fixes runs QA on what was fixed since the last QA, and the card stays here. Its report keeps the rows the fixes do not touch, and the report before it stays in qa/history.{#if qaView.why !== null}{` QA the fixes: ${qaView.why}`}{/if}{/if}
      </p>
    {/if}
    <p class="muted said" class:failed role="status">{said}</p>

    {#if discussions.length === 0}
      {#if pulls.length === 0}
        <p class="muted">No comments to show until the card has a pull request.</p>
      {:else if readAt === null}
        <p class="muted">The comments have not been read yet. Read comments asks GitHub for them. Nolzu only reads them when you press it.</p>
      {:else}
        <p class="muted">No comments on the pull request yet.</p>
      {/if}
    {:else}
      {#if rows.action.length === 0}
        <p class="muted">Nothing needs action. Every comment is done or needs no answer.</p>
      {:else}
        <ul class="rows">
          {#each rows.action as item (item.ref)}{@render row(item, false)}{/each}
        </ul>
      {/if}
      {#if rows.quiet.length > 0}
        <details class="quiet">
          <summary>Nothing to action ({rows.quiet.length})</summary>
          <ul class="rows">
            {#each rows.quiet as item (item.ref)}{@render row(item, true)}{/each}
          </ul>
        </details>
      {/if}
    {/if}
  </section>
</div>

<style>
  .tab {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    min-width: 0;
  }

  .comments {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }

  h2 {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .end {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-left: auto;
  }

  .muted {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-sm);
  }

  .said:empty {
    display: none;
  }

  .failed {
    color: var(--red);
  }

  .rows {
    margin: 0;
    padding: 0;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .row + .row {
    border-top: 1px solid var(--line);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-3);
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
  }

  .toggle {
    display: flex;
    flex: 1 1 260px;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .toggle:focus-visible {
    border-radius: var(--radius-sm);
    outline: 2px solid var(--blue);
    outline-offset: 2px;
  }

  /* The dot is the quick look; the word "Unread." beside it is what a screen reader hears. */
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
  }

  .dot.on {
    background: var(--blue);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .ref {
    flex: none;
    color: var(--ink-2);
  }

  .line {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    min-width: 0;
    color: var(--muted);
  }

  .path {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  a {
    color: var(--ink);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 0 var(--space-3) var(--space-3);
  }

  .messages {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .messages > li {
    min-width: 0;
    padding-left: var(--space-3);
    border-left: 2px solid var(--line);
    overflow-wrap: anywhere;
  }

  .by {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0 0 var(--space-1);
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .who {
    color: var(--ink);
    font-weight: 600;
  }

  .new {
    color: var(--blue);
    font-weight: 600;
  }

  .figure {
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .triage {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: 0 var(--space-3) var(--space-2) calc(var(--space-3) + 7px + var(--space-2));
    font-size: var(--text-sm);
  }

  .summary,
  .reason {
    margin: 0;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .reply {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .draft {
    flex: 1 1 220px;
    min-width: 0;
    margin: 0;
    padding-left: var(--space-3);
    border-left: 2px solid var(--line);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .note {
    margin: 0;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .note.failed {
    color: var(--red);
  }

  .said-fix {
    display: block;
    color: var(--ink-2);
  }

  .why {
    font-size: var(--text-xs);
  }

  .quiet summary {
    padding: var(--space-2) 0;
    color: var(--ink-2);
    font-size: var(--text-sm);
    cursor: pointer;
  }
</style>
