<script lang="ts">
  import { type CardView, effortInModel, phaseLabel, wallLabel } from '@nolzu/protocol';
  import Button from '../Button.svelte';
  import StatePill from '../StatePill.svelte';
  import { engineName } from '../board/drop.ts';
  import { ago } from '../board/peek.ts';
  import { runView, type Seen } from './actions.ts';
  import Ago from './Ago.svelte';
  import LogLine from './LogLine.svelte';
  import { ENDED_RUN, type LogRun, logRows, runCount, runGroups, runTag, runTotals, type TimedEvent, withoutTools } from './log.ts';

  // The page streams the events of the shown run and hands them in, because this package never fetches.
  // `card` is the card as the board snapshot shows it, and Stop is read off it, never off a press.
  let {
    runs,
    selected,
    events,
    runHref,
    rawHref,
    card = null,
    onstop = async () => null,
    onrefuse = () => {},
  }: {
    runs: readonly LogRun[];
    selected: number | null;
    events: readonly TimedEvent[];
    runHref: (id: number) => string;
    rawHref: string;
    // Null where the page has no snapshot of the card's board, and then there is no Stop.
    card?: CardView | null;
    // The sentence the stop was refused with, or null once it is sent.
    onstop?: (runId: number) => Promise<string | null>;
    onrefuse?: (said: string | null) => void;
  } = $props();

  let hideTools = $state(false);
  // A live run is followed to its newest line. Off, the page stays where the person scrolled to read.
  let follow = $state(true);
  const run = $derived(runs.find((one) => one.id === selected) ?? null);
  // Newest on top, as the page hands them, so a card with many runs grows the list down and not across.
  const groups = $derived(runGroups(runs));
  // The card page reads the runs again when the card's state moves, so a stop shows here.
  const ended = $derived(ENDED_RUN.includes(run?.state ?? ''));
  const waiting = $derived.by(() => {
    const last = events.at(-1);
    return !ended && last?.type === 'api_retry' && last.until !== undefined;
  });
  // The clock ticks while the run goes, for its elapsed time and a retry wait's countdown.
  let now = $state(Date.now());
  const ticking = $derived(!ended && (run?.startedAt != null || waiting));
  $effect(() => {
    if (!ticking) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  // The time column counts from the run's start. A start that cannot be read draws no times.
  const start = $derived.by(() => {
    const at = run?.startedAt == null ? Number.NaN : Date.parse(run.startedAt);
    return Number.isFinite(at) ? at : null;
  });
  // Only a wait reads the clock, so the rows are not drawn again each second for nothing.
  const all = $derived(logRows(events, waiting ? now : 0, ended, start));
  const shown = $derived(hideTools ? withoutTools(all) : { rows: all, hidden: 0 });
  const clock = $derived(new Date(now));
  const totals = $derived(run === null ? null : runTotals(run, events, clock));
  // The narrow screen's select says in one line what a row of the list says.
  const option = (one: LogRun, attempt: number | null) =>
    [phaseLabel(one.phase), attempt === null ? null : runCount(one.phase, attempt), runTag(one), one.startedAt === null ? null : ago(one.startedAt, clock, true)].filter((part) => part !== null).join(' · ');
  const on = $derived(
    run === null
      ? ''
      : [run.engine === undefined ? null : engineName(run.engine), run.model, effortInModel(run.engine) ? null : run.effort, wallLabel(run.wall), run.started == null ? null : `started ${run.started}`].filter((one) => one != null && one !== '').join(' · '),
  );

  // The list is as tall as the window below where it starts, so a short log never makes the page scroll.
  // The grid is measured, not the list: the list is sticky, and once stuck its own top moves.
  let grid = $state<HTMLElement | null>(null);
  let list = $state<HTMLElement | null>(null);
  let top = $state(160);
  $effect(() => {
    if (grid === null) return;
    // Rounded up: a top rounded down by a fraction of a pixel lets the page scroll by that much.
    const measure = () => (top = Math.ceil(grid!.getBoundingClientRect().top + window.scrollY));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  // An older run opened from a link is brought into sight. The list's own scroll is moved by hand, as
  // scrollIntoView would scroll the page too.
  $effect(() => {
    void selected;
    void groups;
    const row = list?.querySelector('.current');
    if (list == null || row == null) return;
    const box = list.getBoundingClientRect();
    const at = row.getBoundingClientRect();
    if (at.top < box.top) list.scrollTop -= box.top - at.top;
    else if (at.bottom > box.bottom) list.scrollTop += at.bottom - box.bottom;
  });

  // The page scrolls, not the log, because the list and the totals stick to it.
  $effect(() => {
    void shown.rows.length;
    if (follow && !ended) window.scrollTo({ top: document.documentElement.scrollHeight });
  });

  // A plain string, so a press is let go only when the card's key, stage or state moves.
  const at = $derived(card === null ? '' : `${card.key} ${card.stage} ${card.state}`);
  let pressed = $derived.by<Seen | null>(() => {
    void at;
    return null;
  });
  // Stop ends the card's own run, so it shows only while that run is the one shown. An Ask run is
  // never the card's run, and nothing stops it from here.
  const stop = $derived.by(() => {
    const view = card === null ? null : runView(card, pressed);
    return view?.kind === 'stop' && view.runId === selected ? view : null;
  });

  async function stopRun(): Promise<void> {
    if (card === null || stop === null || stop.busy || stop.runId === null) return;
    const id = stop.runId;
    const mine = { key: card.key, stage: card.stage, state: card.state };
    pressed = mine;
    onrefuse(null);
    const answer = await onstop(id);
    // A refusal ends the wait, because no snapshot will.
    if (answer === null || pressed !== mine) return;
    pressed = null;
    onrefuse(answer);
  }
</script>

{#if runs.length === 0}
  <p class="quiet">No runs yet. The log fills when the card's first run starts.</p>
{:else}
  <div class="tab">
    <div class="log" bind:this={grid}>
      <!-- A narrow screen has no room for the list beside the log. A GET form keeps the ?run= address,
           and the router takes it like a link. Focus stays on the select, so arrow keys can go on picking. -->
      <form class="pick" method="get" data-sveltekit-keepfocus>
        <label class="sr" for="log-run">Run</label>
        <select id="log-run" name="run" onchange={(event) => event.currentTarget.form?.requestSubmit()}>
          {#each groups as group (group.runs[0]!.run.id)}
            {#each group.runs as { run: one, attempt } (one.id)}
              <option value={one.id} selected={one.id === selected}>{option(one, attempt)}</option>
            {/each}
          {/each}
        </select>
      </form>

      <nav class="runs" aria-label="Runs of this card" bind:this={list} style:--runs-top="{top}px">
        <ol>
          {#each groups as group (group.runs[0]!.run.id)}
            <!-- The heading is for the eye. Each link says its phase, so a screen reader hears it once. -->
            <li>
              <span class="phase" aria-hidden="true">{phaseLabel(group.phase)}</span>
              <ol>
                {#each group.runs as { run: one, attempt } (one.id)}
                  {@const tag = runTag(one)}
                  <!-- The live dot is the running colour, so it sits beside the link and not on it: amber on a
                       control means a press that starts work. -->
                  <li class="run" class:current={one.id === selected}
                    >{#if tag === 'running'}<span class="live" aria-hidden="true"></span>{/if}<a href={runHref(one.id)} aria-current={one.id === selected ? 'true' : undefined}
                      ><span class="sr">{phaseLabel(one.phase)}</span>
                      <span class="what"
                        >{#if one.state === 'complete'}<svg class="ok" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>{/if}{#if attempt !== null}<span
                            class="n">{runCount(one.phase, attempt)}</span
                          >{/if}
                        <span class="m">{tag}</span></span
                      >
                      {#if one.startedAt !== null}<span class="m"><Ago at={one.startedAt} now={clock} /></span>{/if}</a
                    ></li
                  >
                {/each}
              </ol>
            </li>
          {/each}
        </ol>
      </nav>

      <div class="shown">
        <div class="bar">
          {#if on !== ''}<span class="on">{on}</span>{/if}
          <span class="sp"></span>
          {#if !ended}<label class="hide"><input id="follow-log" type="checkbox" bind:checked={follow} /> Follow new lines</label>{/if}
          <label class="hide"><input id="hide-tools" type="checkbox" bind:checked={hideTools} /> Hide tool calls</label>
          {#if shown.hidden > 0}<span class="quiet">{shown.hidden} tool calls hidden</span>{/if}
        </div>

        {#if run?.failureReason}<p class="failed" data-run-failed>{phaseLabel(run.phase)} failed: {run.failureReason}</p>{/if}
        {#if shown.rows.length === 0}
          <p class="quiet none">{ended ? 'The run wrote no lines.' : 'No lines yet.'}</p>
        {:else}
          <ol class="stream" aria-label="{run === null ? 'Run' : phaseLabel(run.phase)} log">
            {#each shown.rows as row, index (index)}
              <LogLine {row} />
            {/each}
          </ol>
        {/if}

        <footer class="foot" aria-label="Run totals">
          {#if run?.state === 'running' || run?.state === 'retrying'}
            <StatePill state="running" word={run.state === 'retrying' ? 'Retrying' : null} />
          {:else if run?.state === 'queued' || run?.state === 'waiting_lane' || run?.state === 'waiting_review'}
            <StatePill state="queued" />
          {/if}
          {#if totals?.elapsed}<div class="st"><b>{totals.elapsed}</b> <span>elapsed</span></div>{/if}
          {#if totals?.tokens}<div class="st"><b>{totals.tokens}</b> <span>tokens</span></div>{/if}
          {#if totals?.cost}<div class="st"><b>{totals.cost}</b> <span>estimated cost</span></div>{:else if totals?.unpriced}<div class="st" data-unpriced><span>No cost reported</span></div>{/if}
          <span class="sp"></span>
          {#if stop !== null}
            <Button data-run="stop" key="⌘." aria-disabled={stop.busy ? 'true' : undefined} aria-busy={stop.busy ? 'true' : undefined} onclick={stopRun}
              >{card?.state === 'queued' ? 'Remove from queue' : 'Stop'}</Button
            >
          {/if}
          <a class="raw" href={rawHref} download
            ><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg>Download raw</a
          >
        </footer>
      </div>
    </div>
  </div>
{/if}

<style>
  /* The layout follows the tab's own width, not the window's: the app rail takes part of the window. */
  .tab {
    container-type: inline-size;
  }

  /* The run list on the left, the log in the rest of the width. */
  .log {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
  }

  .pick {
    display: none;
  }

  .pick select {
    width: 100%;
    min-height: 32px;
    padding: 0 var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  /* Stays beside the log while it scrolls, and scrolls on its own when a card has many runs. */
  .runs {
    position: sticky;
    top: calc(var(--thead-height, 0px) + var(--space-3));
    /* The page's bottom padding is --space-4. A short window still gets a list of a few rows. */
    max-height: max(160px, calc(100vh - var(--runs-top) - var(--space-4)));
    /* The height above holds the border and padding too, or they push the page 6px past the window. */
    box-sizing: border-box;
    overflow-y: auto;
    padding: 2px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .runs ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .phase {
    display: block;
    padding: var(--space-2) 10px 2px;
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  .run {
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
  }

  /* Not `.on`: that is the mono line of what the run ran on, and it would turn the row mono. */
  .run.current {
    background: var(--card-2);
  }

  .run a {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    padding: 5px 0;
    color: var(--ink-2);
    font-size: var(--text-xs);
    text-decoration: none;
  }

  .run a[aria-current='true'] {
    color: var(--ink);
  }

  /* A long tag goes to the next line whole, rather than breaking "Attempt 2" or a figure. */
  .what {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 7px;
  }

  .what > span {
    white-space: nowrap;
  }

  .shown {
    min-width: 0;
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding-bottom: var(--space-2);
  }

  /* Done is green, the state colour, and a check, so it is not colour alone. */
  .ok {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--green);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .live {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--amber);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* A time, a cost and a state word are figures beside the name, and figures are mono. */
  .m {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .on {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .sp {
    flex: 1;
  }

  .hide {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  .hide input {
    margin: 0;
    accent-color: var(--ink-2);
  }

  .stream {
    margin: 0;
    padding: var(--space-1) 0 var(--space-5);
    list-style: none;
  }

  /* Stays in sight while the log scrolls under it, so Stop is never a scroll away. */
  .foot {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 18px;
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--line);
    background: var(--panel);
  }

  .st {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .st b {
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    font-weight: 500;
    color: var(--ink);
  }

  .st span {
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  /* A ghost button, drawn here because Button is a button and a download is a link. */
  .raw {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-md);
    color: var(--ink-2);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .raw:hover {
    background: var(--card);
    color: var(--ink);
  }

  .ico {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .none {
    padding: var(--space-3) 0;
  }

  /* Why the run failed, above its lines, in the words the Next step block uses. The text stays ink on
     the tint, for contrast, as in the error box, and the border carries the red. */
  .failed {
    margin: var(--space-3) 0 0;
    padding: var(--space-2) var(--space-3);
    border-left: 3px solid var(--red);
    border-radius: var(--radius-md);
    background: var(--red-bg);
    color: var(--ink);
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  /* Under 640px of tab there is no room for a column beside the log: one select above it instead. */
  @container (max-width: 640px) {
    .log {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--space-2);
    }

    .pick {
      display: block;
    }

    .runs {
      display: none;
    }
  }
</style>
