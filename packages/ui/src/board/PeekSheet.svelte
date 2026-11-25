<script lang="ts">
  import type { CardView } from '@nolzu/protocol';
  import type { ComponentProps } from 'svelte';
  import Button from '../Button.svelte';
  import KeyCaps from '../KeyCaps.svelte';
  import StatePill from '../StatePill.svelte';
  import Markdown from '../Markdown.svelte';
  import Skeleton from '../Skeleton.svelte';
  import DecisionPanel from '../ticket/DecisionPanel.svelte';
  import LogLine from '../ticket/LogLine.svelte';
  import { retryLine } from '../ticket/log.ts';
  import { elapsed } from './elapsed.ts';
  import { ago, peekFacts, type PeekView, trailSteps, trailTotal } from './peek.ts';
  import type { Live } from './quiet.ts';

  // The side sheet Space opens on a card. The page reads the view and the
  // card from its streams and hands them in, because this package never fetches. Busy comes from the
  // page, which reads it off the snapshot, never from the press.
  let {
    card,
    stage,
    view,
    live = null,
    clock,
    back = null,
    models = {},
    stopping = false,
    moving = false,
    decision = null,
    openHref,
    logHref,
    onstop = () => {},
    onback = () => {},
    onclose,
  }: {
    card: CardView;
    // The label of the column the card is in.
    stage: string;
    // Null until the first answer arrives.
    view: PeekView | null;
    live?: Live | null;
    clock: Date;
    // The column a move back goes to, or null when the card cannot move back.
    back?: string | null;
    // The model each phase to come would start on, read off the board's columns.
    models?: Readonly<Record<string, string>>;
    stopping?: boolean;
    moving?: boolean;
    // The card page's Next step block, built by the page with the rule the card page uses, or null.
    decision?: ComponentProps<typeof DecisionPanel> | null;
    openHref: string;
    logHref: string;
    onstop?: () => void;
    onback?: () => void;
    // Esc inside the sheet and the close button. The page gives focus back to the card.
    onclose: () => void;
  } = $props();

  const uid = $props.id();
  const running = $derived(card.state === 'running' || card.state === 'queued');
  const retrying = $derived(card.state === 'running' && card.runState === 'retrying');
  const quiet = $derived(live?.quiet ?? null);
  const facts = $derived(peekFacts(card, view?.tokens ?? null));
  const steps = $derived(view === null ? [] : trailSteps(view.trail, card, clock, models));
  const total = $derived(view === null ? null : trailTotal(view.trail));
  const pillDetail = $derived(card.state === 'running' && card.runStartedAt !== null ? `${stage} · ${elapsed(card.runStartedAt, clock) ?? ''}` : null);
  const summaryAge = $derived(view?.summary?.at == null ? null : ago(view.summary.at, clock));

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onclose();
  }
</script>

<!-- Complementary and not a dialog: the board stays live beside it, and J and K move the card it shows. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="sheet" aria-labelledby="{uid}-title" data-peek={card.key} {onkeydown}>
  <header>
    <div class="r">
      <span class="key">{card.key}</span>
      {#if quiet !== null}
        <StatePill state="quiet" detail={quiet} />
      {:else if retrying}
        <StatePill state="running" word="Retrying" />
      {:else if pillDetail !== null}
        <StatePill state="running" detail={pillDetail} detailOnly />
      {:else}
        <StatePill state={card.state} />
      {/if}
      <span class="sp"></span>
      <KeyCaps combos={[[{ key: ' ' }]]} />
      <Button variant="ghost" size="small" aria-label="Close peek" data-peek-close onclick={onclose}
        ><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></Button
      >
    </div>
    <h2 id="{uid}-title">{card.title}</h2>
    {#if facts.length > 0}
      <p class="facts">{#each facts as fact (fact)}<span>{fact}</span>{/each}</p>
    {/if}
  </header>

  <div class="body">
    {#if decision !== null}<DecisionPanel {...decision} />{/if}

    <!-- The press a peek most often leads to, so it spans the sheet right under Next step, where the eye
         already is. Outlined and never amber, so the start in Next step stays the one loud button. -->
    <a class="btn open" href={openHref} data-peek-open>Open card<KeyCaps combos={[[{ key: 'Enter' }]]} /></a>

    <!-- The run's own actions, right under Next step, so Stop is never a scroll away. -->
    {#if running || back !== null}
      <div class="acts" data-peek-actions>
        <div class="r">
          {#if running}
            <Button aria-busy={stopping ? 'true' : undefined} aria-disabled={stopping ? 'true' : undefined} data-peek-stop onclick={onstop}
              ><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>Stop<KeyCaps
                combos={[[{ key: '.', mod: true }]]}
              /></Button
            >
          {/if}
          {#if back !== null}
            <Button variant="ghost" aria-busy={moving ? 'true' : undefined} aria-disabled={moving ? 'true' : undefined} data-peek-back onclick={onback}
              >Move back to {back}<KeyCaps combos={[[{ key: 'ArrowLeft', shift: true }]]} /></Button
            >
          {/if}
        </div>
        {#if running}<p class="sub">Stop keeps the checkout as it is. Moving back stops the run first.</p>{/if}
      </div>
    {/if}

    <section aria-labelledby="{uid}-sum">
      <div class="hrow">
        <h3 id="{uid}-sum">So far, in plain words</h3>
        {#if summaryAge !== null}<span class="r">{summaryAge}</span>{/if}
      </div>
      {#if view === null}
        <Skeleton shape="block" height="64px" label="Reading the card." />
      {:else if view.summary !== null}
        <!-- The run writes Markdown. Under the title (h2) and this section (h3), its headings start at h4. -->
        <div class="said" data-peek-summary><Markdown source={view.summary.text} headingsFrom={4} /></div>
      {:else}
        <!-- Never a made-up line: the summary is what the run wrote, or nothing. -->
        <p class="none" data-peek-summary>
          {running ? 'No plain summary yet. The agent writes one after each file it changes.' : 'No plain summary yet. A phase writes one as it works and when it ends.'}
        </p>
      {/if}
    </section>

    {#if retrying && view?.retry != null}
      <!-- A wait ends in a run that goes on, so its mark is amber, as the log's retry row. -->
      <div class="live" role="status" data-peek-live>
        <svg class="ico amber" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg><span>{retryLine(view.retry, clock.getTime())}</span>
      </div>
    {:else if live !== null && live.line !== null}
      <!-- Amber only while the agent works. A quiet run is neutral, as its card is. -->
      <div class="live" class:still={quiet !== null} role="status" data-peek-live>
        <svg class="ico" class:amber={quiet === null} viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"></path></svg><span class="line">{live.line}</span>{#if live.since !== null}<span class="t">{live.since}</span>{/if}
      </div>
    {/if}

    <section aria-labelledby="{uid}-log">
      <div class="hrow">
        <h3 id="{uid}-log">Log {#if view?.log != null}<span class="n">last {view.log.rows.length} of {view.log.total}</span>{/if}</h3>
        <a class="r link" href={logHref}>Full log</a>
      </div>
      {#if view?.log != null && view.log.rows.length > 0}
        <ol class="log">
          {#each view.log.rows as row, index (index)}
            <!-- The Log tab's own row, so the sheet never draws an event another way. -->
            <LogLine {row} compact />
          {/each}
        </ol>
      {:else if view !== null}
        <p class="none">No log yet. It fills when the card's first run starts.</p>
      {/if}
    </section>

    <section aria-labelledby="{uid}-trail">
      <div class="hrow">
        <h3 id="{uid}-trail">Trail</h3>
        {#if total !== null}<span class="r mono">{total} so far</span>{/if}
      </div>
      <ol class="trail">
        {#each steps as step (step.phase)}
          <li data-step={step.state}>
            <i aria-hidden="true"></i>
            <b>{step.label}</b>
            {#if step.model !== null}<span>{step.model}</span>{/if}
            {#if step.time !== null}<span>{step.time}</span>{/if}
            {#if step.cost !== null}<span>{step.cost}</span>{/if}
          </li>
        {/each}
      </ol>
    </section>
  </div>

</aside>

<style>
  /* The sheet: 448px on the right, on the panel, with a line and a shadow on its left. */
  .sheet {
    box-sizing: border-box;
    display: flex;
    flex: none;
    flex-direction: column;
    width: 448px;
    height: calc(100vh - var(--offline-height, 0px));
    position: sticky;
    top: 0;
    border-left: 1px solid var(--line-2);
    background: var(--panel);
    box-shadow: -16px 0 40px oklch(0 0 0 / 0.28);
    color: var(--ink);
  }

  :global([data-theme='light']) .sheet {
    box-shadow: -16px 0 40px oklch(0.2 0.01 75 / 0.1);
  }

  /* Over the page at a phone's width, where there is no room beside the board. */
  @media (max-width: 760px) {
    .sheet {
      position: fixed;
      inset: 0;
      width: auto;
      height: auto;
      /* Over the rail, which is a band at the top here with z-index 30, so the header and Close stay
         in reach. Under the toasts at 40. */
      z-index: 35;
    }
  }

  header {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 20px 16px;
    border-bottom: 1px solid var(--line);
  }

  .r {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .sp {
    flex: 1;
  }

  .key {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--muted);
  }

  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.3;
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--mono-card-key);
    color: var(--ink-2);
  }

  .body {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 22px;
    padding: 18px 20px;
    overflow-y: auto;
  }

  /* The panel clips its corners with overflow, which would let the column squeeze it to nothing. */
  .body > :global(.decide) {
    flex: none;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .hrow {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .hrow .r {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  h3 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  h3 .n,
  .mono {
    font-family: var(--font-mono);
    font-weight: 400;
    font-size: var(--mono-xs);
    color: var(--muted);
  }

  .link {
    color: var(--blue);
  }

  .said {
    font-size: var(--text-base);
    line-height: 1.55;
  }

  .said :global(.markdown > :first-child) {
    margin-top: 0;
  }

  .said :global(.markdown > :last-child) {
    margin-bottom: 0;
  }

  .none {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  /* The live line on the amber tint, ink and muted words: both reach 4.5:1 there (tokens.test.ts). */
  .live {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 9px 12px;
    border-radius: var(--radius-lg);
    background: var(--amber-bg);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink);
  }

  .live.still {
    background: var(--card-2);
  }

  .live .line {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .live .t {
    margin-left: auto;
    flex: none;
    color: var(--muted);
  }

  .live.still .t {
    color: var(--ink-2);
  }

  .log {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
    font-family: var(--font-mono);
    font-size: var(--mono-card-key);
  }

  .trail {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
    grid-auto-flow: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .trail li {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }

  /* A bar per phase: ink for done, red for failed, amber where the agent works, and a 3:1 mark for one
     that was stopped or is still to run. */
  .trail i {
    display: block;
    height: 5px;
    margin-bottom: 5px;
    border-radius: 3px;
    background: var(--faint);
  }

  [data-step='done'] i {
    background: var(--ink-2);
  }

  [data-step='failed'] i {
    background: var(--red);
  }

  [data-step='now'] i {
    background: var(--amber);
  }

  .trail b {
    font-size: var(--text-xs);
    font-weight: 600;
  }

  [data-step='now'] b {
    color: var(--amber);
  }

  [data-step='next'] b,
  [data-step='later'] b {
    color: var(--ink-2);
    font-weight: 500;
  }

  .trail span {
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--mono-3xs);
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .acts {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: var(--space-2);
  }

  .sub {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .ico {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* svg and not .ico, because the close button holds an .ico too and amber stays off controls. */
  svg.amber {
    color: var(--amber);
  }

  /* The link drawn as Button's default, outlined, with its measures. */
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    box-sizing: border-box;
    height: 30px;
    padding: 0 var(--space-3);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 400;
    white-space: nowrap;
    text-decoration: none;
  }

  /* Across the sheet, as a block, so it cannot be missed beside the small controls of the head. */
  .open {
    display: flex;
    flex: none;
    justify-content: center;
    width: 100%;
    height: 34px;
  }
</style>
