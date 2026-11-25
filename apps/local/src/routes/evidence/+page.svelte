<script lang="ts">
  import { weekOf } from '@nolzu/protocol';
  import { Button } from '@nolzu/ui';
  import { resolve } from '$app/paths';
  import DatePick from '$lib/DatePick.svelte';
  import { EXPORT_FEATURE, HISTORY_FEATURE, shows } from '$lib/display.ts';
  import EvidenceDay from '$lib/EvidenceDay.svelte';
  import { dayLabel, dayShift, dayStats, laneStates, weekLabel } from '$lib/evidence-timeline.ts';
  import { nowLive } from '$lib/now-live.svelte.ts';
  import StandupComposer from '$lib/StandupComposer.svelte';
  import TimesheetExport from '$lib/TimesheetExport.svelte';
  import TimesheetWeek from '$lib/TimesheetWeek.svelte';
  import type { ActionData, PageData } from './$types';

  // Evidence: the top bar with the day and its arrows, the stat tiles, the timeline, then the
  // standup beside the timesheet. The shell and the card links live here, because resolve() needs the
  // running app and the parts are server rendered by their tests.
  //
  // `PageData` and not the page's own load, because the signed display document comes from the
  // layout and the fields are drawn from it.
  let { data, form = null }: { data: PageData; form?: ActionData | null } = $props();

  const cardHref = (key: string) => resolve('/t/[key]/[tab]', { key, tab: 'log' });

  // Display only. Older days are Solo, and the loader still reads whichever day the URL carries,
  // because these rows sit on this machine's own disk.
  const canPick = $derived(shows(data.display, HISTORY_FEATURE));

  // It draws the Export button and the connections. Hiding them is not the check: the two actions ask
  // the plan again on every post.
  const canExport = $derived(shows(data.display, EXPORT_FEATURE));

  const thisWeek = $derived(data.week.week === weekOf(data.today));
  // Day or Week. Week is history as well, so Free draws the day whatever the link asks for, and the
  // Week switch is locked like the arrow back.
  const weekView = $derived(canPick && data.range === 'week' && data.period !== null);
  const shown = $derived(weekView && data.period !== null ? data.period : data.day);
  const monday = $derived(weekOf(data.day.day));
  const sunday = $derived(dayShift(monday, 6));
  // No week in the link, so the timesheet follows the day the arrows go to. The Week view keeps its
  // range, and its arrows go a week at a time.
  const dayHref = (day: string, week = weekView) => `${resolve('/evidence')}?day=${day}${week ? '&range=week' : ''}`;
  const step = $derived(weekView ? 7 : 1);
  // There is nothing after today to step to.
  const onToday = $derived((weekView ? sunday : data.day.day) >= data.today);
  const stats = $derived(dayStats(shown, weekView ? 'week' : 'day'));
  // The lane dots read the board snapshot off the Now stream, never this page's load.
  const states = $derived(laneStates(nowLive.state.snapshot?.boards ?? []));

  // The week the link carries, with the day the timeline is on, so paging a week keeps the day.
  const weekHref = (monday: string) => `${resolve('/evidence')}?week=${monday}&day=${data.day.day}`;

  // A form posts to the week, the day and the tracker on screen, so the page that answers it is the
  // same page.
  const exportAction = (name: string) =>
    `?week=${data.week.week}&day=${data.day.day}${data.shown === null ? '' : `&to=${data.shown.destination}`}&/${name}#timesheet`;
  const markHref = (destination: string) => `${weekHref(data.week.week)}&to=${destination}#timesheet`;
  const exported = $derived(form?.exported ?? null);
  const connection = $derived(form?.connection ?? null);
  // A refused client or rate keeps what was typed in the boxes, so the sentence is about what is on screen.
  const billing = $derived(form?.billing ?? null);
  const billed = (field: 'client' | 'rate' | 'currency', stored: string) => billing?.typed[field] ?? stored;

  // "Bill this project?" shows on the first visit only, and the load stored that visit already, so
  // "Not now" only has to hide it here. A later answer goes in the same fields at #billing.
  let notNow = $state(false);
  const prompt = $derived(data.billingPrompt && !notNow);
  const billingSays = $derived.by(() => {
    const { clientName, hourlyRate, currency } = data.billing;
    if (clientName === null && hourlyRate === null) return 'not set';
    return `${clientName ?? 'no client'}, ${hourlyRate === null ? 'no rate' : `${hourlyRate} ${currency} an hour`}`;
  });

  // The top bar's Copy standup copies the box below, edits and all.
  let composer = $state<ReturnType<typeof StandupComposer>>();

  const ICONS = {
    left: ['m15 6-6 6 6 6'],
    right: ['m9 6 6 6-6 6'],
    copy: ['M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3', 'M8 10a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2Z'],
    tag: ['M3 12V4h8l10 10-8 8-10-10Z', 'M7.5 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3Z'],
    lock: ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z', 'M8 11V8a4 4 0 0 1 8 0v3'],
  };
</script>

<svelte:head><title>Evidence · Nolzu</title></svelte:head>

{#snippet icon(paths: readonly string[])}
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{#each paths as d (d)}<path {d}></path>{/each}</svg>
{/snippet}

<!-- The client, the rate and the currency, one form for the prompt and for #billing after it. Both
     post the `bill` action, which saves the three together or none of them. -->
{#snippet billForm(first: boolean)}
  <form method="POST" action="?week={data.week.week}&day={data.day.day}&/bill#billing" class="frow">
    <label class="field client">Client <input name="client" class="input" value={billed('client', data.billing.clientName ?? '')} placeholder="Client name" autocomplete="off" /></label>
    <label class="field rate"
      >Hourly rate <input
        name="rate"
        class="input mono"
        value={billed('rate', data.billing.hourlyRate === null ? '' : String(data.billing.hourlyRate))}
        placeholder="80"
        inputmode="decimal"
        autocomplete="off"
      /></label
    >
    <label class="field cur">Currency <input name="currency" class="input mono" value={billed('currency', data.billing.currency)} maxlength="3" autocomplete="off" /></label>
    <Button type="submit" variant="primary">Save</Button>
    {#if first}<Button variant="ghost" onclick={() => (notNow = true)}>Not now</Button>{/if}
  </form>
{/snippet}

<div class="evidence">
  <div class="top">
    <h1>Evidence</h1>
    <!-- Day or Week, as links, so the view is in the address. On Free, Week is locked like the arrow
         back, and the one Solo line under the stepper says why. -->
    <div class="seg" role="group" aria-label="Range">
      <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- dayHref() resolve()s the route and adds the query -->
      <a href={dayHref(data.day.day, false)} aria-current={weekView ? undefined : 'page'}>Day</a>
      {#if canPick}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- dayHref() resolve()s the route and adds the query -->
        <a href={dayHref(data.day.day, true)} aria-current={weekView ? 'page' : undefined}>Week</a>
      {:else}
        <button type="button" disabled aria-label="Week, needs Solo">Week<span class="lock">{@render icon(ICONS.lock)}</span></button>
      {/if}
    </div>
    <!-- The day and its arrows. On Free the way back is locked, and the one quiet plan line sits under
         it: older days are Solo. The signed display document decides, and no document is Free. -->
    <div class="stp">
      {#if canPick}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- dayHref() resolve()s the route and adds the query -->
        <a href={dayHref(dayShift(data.day.day, -step))} aria-label={weekView ? 'Previous week' : 'Previous day'}>{@render icon(ICONS.left)}</a>
      {:else}
        <button type="button" disabled aria-label="Previous day, needs Solo">{@render icon(ICONS.left)}<span class="lock">{@render icon(ICONS.lock)}</span></button>
      {/if}
      <span class="d">{weekView ? weekLabel(monday, sunday) : dayLabel(data.day.day)}</span>
      {#if onToday}
        <button type="button" disabled aria-label={weekView ? 'Next week' : 'Next day'}>{@render icon(ICONS.right)}</button>
      {:else}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- dayHref() resolve()s the route and adds the query -->
        <a href={dayHref(dayShift(data.day.day, step))} aria-label={weekView ? 'Next week' : 'Next day'}>{@render icon(ICONS.right)}</a>
      {/if}
      {#if !canPick}
        <p class="tip" role="note" data-free="day"><span class="lock">{@render icon(ICONS.lock)}</span>History is part of Solo</p>
      {/if}
    </div>
    {#if canPick}
      <DatePick name="day" label="Go to" value={data.day.day} {canPick} />
    {/if}
    <span class="sp"></span>
    <Button variant="primary" onclick={() => composer?.copy()}>{@render icon(ICONS.copy)}Copy standup</Button>
  </div>

  <div class="page">
    <section class="stats" aria-label={weekView ? 'The week in numbers' : 'The day in numbers'}>
      {#each stats as stat (stat.label)}
        <div class="stat" data-stat={stat.label}>
          <span class="l">{stat.label}</span>
          {#if stat.value !== null}
            <span class="v">{stat.value}</span>
            <span class="s">{#if stat.live}<i aria-hidden="true"></i>{/if}{stat.note}</span>
          {:else}
            <!-- No figure was measured, so the tile says so in place of one. -->
            <span class="none">{stat.note}</span>
          {/if}
        </div>
      {/each}
    </section>

    <section class="panel" aria-labelledby="day-title">
      <EvidenceDay day={shown} week={weekView} today={data.day.day === data.today} now={data.now} phases={data.phases} {states} {cardHref} />
    </section>

    <div class="cols">
      <!-- The standup of the day on screen. Its Yesterday is the working day before, so on a Monday it
           reads Friday and not the timeline above. -->
      <section class="panel" id="standup" aria-labelledby="standup-title">
        <div class="hd">
          <h2 id="standup-title" class="h-sec">Standup</h2>
          <Button size="small" onclick={() => composer?.copy()} data-copy>{@render icon(ICONS.copy)}Copy</Button>
        </div>
        <!-- A new box per day, so stepping to another day never keeps the last day's text. -->
        {#key data.standup.day}
          <StandupComposer bind:this={composer} standup={data.standup} />
        {/key}
      </section>

      <div class="stack">
        {#if prompt}
          <section class="bill" id="billing" aria-labelledby="bill-title">
            <div class="hd2">
              <span class="ic">{@render icon(ICONS.tag)}</span>
              <div>
                <h2 id="bill-title">Bill this project?</h2>
                <p class="muted">Add a client and an hourly rate to see value next to cost.</p>
              </div>
            </div>
            {@render billForm(true)}
          </section>
        {/if}

        <!-- The week grid, reachable at #timesheet. Its own panel and not a tab: both belong to one
             screen and a person reads the day against the week. -->
        <section class="panel" id="timesheet" aria-labelledby="week-title">
          <!-- The file follows the week on screen. The route folds any day of a week to its Monday, so
               this week downloads the same file it always did. -->
          <TimesheetWeek
            week={data.week}
            {canExport}
            sync={data.sync}
            syncTo={data.shown?.label ?? null}
            today={data.today}
            {cardHref}
            csvHref={`${resolve('/api/evidence/timesheet')}?week=${data.week.week}`}
          >
            {#snippet steps()}
              {#if canPick}
                <p class="steps">
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- weekHref() resolve()s the route and adds the query -->
                  <a href={weekHref(data.weeks.previous)}>Previous week</a>
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- weekHref() resolve()s the route and adds the query -->
                  <a href={weekHref(data.weeks.next)}>Next week</a>
                </p>
              {/if}
            {/snippet}
          </TimesheetWeek>
          {#if canExport}
            <TimesheetExport
              exporters={data.exporters}
              forms={data.forms}
              shown={data.shown?.destination ?? null}
              current={thisWeek}
              action={exportAction}
              {markHref}
              {exported}
              {connection}
            />
          {/if}
        </section>

        <!-- After the first visit the same three fields fold here, and an old #billing link lands on
             them. Open while the answer to a save is on screen. -->
        {#if !prompt}
          <details class="bill" id="billing" open={billing !== null || form?.billed === true}>
            <summary><b>Client and rate</b> <span class="muted">{billingSays}</span></summary>
            {@render billForm(false)}
            <p class="intro">Optional. Solo's cost and margin per client read them. An empty currency means USD.</p>
            {#if billing !== null}<p class="refused" role="alert">{billing.message}</p>{:else if form?.billed}<p class="intro" role="status">Saved.</p>{/if}
          </details>
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .evidence {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    min-height: 54px;
    padding: 0 var(--space-6);
    border-bottom: 1px solid var(--line);
  }

  h1 {
    margin: 0 6px 0 0;
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .sp {
    flex: 1;
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

  .lock {
    display: inline-flex;
  }

  .lock .ico {
    width: 11px;
    height: 11px;
  }

  /* The Day | Week switch. The view on show is said by aria-current and by the fill. */
  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .seg a,
  .seg button {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: var(--text-xs);
    text-decoration: none;
  }

  .seg a[aria-current='page'] {
    background: var(--card-2);
    color: var(--ink);
  }

  .seg button:disabled {
    cursor: not-allowed;
  }

  .hd {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    margin: 0 0 14px;
  }

  .hd .h-sec {
    margin: 0;
  }

  .stp {
    position: relative;
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    height: 30px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .stp a,
  .stp button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 1px;
    height: 28px;
    min-width: 30px;
    padding: 0 6px;
    border: 0;
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    cursor: pointer;
  }

  /* A way that is closed, said by the disabled attribute and its name as well as by the ink. */
  .stp button:disabled {
    color: var(--faint);
    cursor: default;
  }

  .d {
    display: flex;
    align-items: center;
    height: 100%;
    padding: 0 var(--space-3);
    border-right: 1px solid var(--line);
    border-left: 1px solid var(--line);
    font-size: var(--text-sm);
    font-weight: 500;
    white-space: nowrap;
  }

  .tip {
    position: absolute;
    top: calc(100% + 7px);
    left: -2px;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    margin: 0;
    padding: 0 9px;
    border: 1px solid var(--line-2);
    border-radius: 7px;
    background: var(--card-2);
    color: var(--muted);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .tip::before {
    position: absolute;
    top: -5px;
    left: 12px;
    width: 8px;
    height: 8px;
    border-top: 1px solid var(--line-2);
    border-left: 1px solid var(--line-2);
    background: var(--card-2);
    content: '';
    transform: rotate(45deg);
  }

  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    padding: var(--space-6) 32px 40px;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-3);
  }

  .stat {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 14px var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .l,
  .s {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .v {
    font-family: var(--font-mono);
    font-size: 24px;
    font-weight: 500;
    letter-spacing: -0.03em;
    line-height: 1.2;
  }

  .s {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* A run is going: the running dot. */
  .s i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--amber);
  }

  .none {
    font-size: var(--text-sm);
    line-height: 1.6;
    color: var(--muted);
  }

  .panel {
    padding: var(--space-4) 18px;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .h-sec {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 14px;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .cols {
    display: grid;
    grid-template-columns: minmax(0, 440px) minmax(0, 1fr);
    gap: var(--space-6);
    align-items: start;
  }

  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  .steps {
    display: flex;
    gap: var(--space-3);
    margin: 0;
    font-size: var(--text-xs);
  }

  .steps a {
    color: var(--ink-2);
  }

  .bill {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 14px var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--card);
  }

  .hd2 {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }

  .hd2 h2 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .muted {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 400;
    color: var(--muted);
  }

  /* Blue is the info mark: a question about the project, not the state of a run. */
  .ic {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 7px;
    background: var(--blue-bg);
    color: var(--blue);
  }

  summary {
    font-size: var(--text-sm);
    cursor: pointer;
  }

  summary b {
    font-weight: 600;
  }

  .frow {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    gap: 10px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--ink-2);
  }

  .client {
    flex: 1;
    min-width: 12ch;
  }

  .rate {
    width: 110px;
  }

  .cur {
    width: 90px;
  }

  .input {
    box-sizing: border-box;
    width: 100%;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: 400;
  }

  .cur .input {
    text-transform: uppercase;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .intro {
    max-width: 72ch;
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .refused {
    margin: 0;
    padding: 4px var(--space-2);
    border-left: 2px solid var(--red);
    background: var(--panel);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  /* The standup and the timesheet stack once there is no room for both side by side. */
  @media (max-width: 1180px) {
    .cols {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (max-width: 760px) {
    .top {
      padding: var(--space-3) var(--space-4);
    }

    /* The top bar wraps here, and the Solo line hangs under the stepper, so its row keeps room for it
       and the next row does not slide under it. */
    .stp:has(.tip) {
      margin-bottom: 31px;
    }

    .page {
      padding: var(--space-5) var(--space-4);
    }

    .stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
