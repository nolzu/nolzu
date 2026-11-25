<script lang="ts">
  import { NO_TIMESHEET, type Timesheet, type TimesheetCell } from '@nolzu/protocol';
  import type { Snippet } from 'svelte';
  import { weekLabel } from './evidence-timeline.ts';
  // A type only, so nothing that reads the database reaches the browser.
  import type { TimesheetSync } from './timesheet-export.ts';

  // The whole week is worked out by timesheetFor, so this file only draws. The link to the file and
  // the link to a card come in from the route, because resolve() only works there.
  //
  // `canExport` is what the account's plan allows, and it is false by default: a panel built without
  // the display document names no destination. It gates the words and nothing else, because a week
  // still downloads as a CSV on every plan.
  //
  // `sync` is null while no time tracker is connected, and null is not an empty list: an empty list
  // says no cell of this week went to the destination `syncTo` names. One entry is one card on one
  // UTC day, which is one cell of this grid. It holds the rows of one destination, because a cell can
  // be sent to one tracker and refused by another.
  //
  // `today` marks its column. `steps` is the route's previous and next week links, drawn in
  // the head beside the file.
  let {
    week,
    csvHref,
    canExport = false,
    sync = null,
    syncTo = null,
    today = null,
    cardHref = null,
    steps,
  }: {
    week: Timesheet;
    csvHref: string;
    canExport?: boolean;
    sync?: TimesheetSync[] | null;
    syncTo?: string | null;
    today?: string | null;
    cardHref?: ((key: string) => string) | null;
    steps?: Snippet;
  } = $props();

  // Monday first by construction, so the names are a list and not a date format. Intl would print the
  // machine's own zone and a column would then carry the name of the day beside it.
  const NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Nothing when no run touched the cell, the figure otherwise. A day with no work reads as empty, a
  // run the engine timed under half a minute reads as 0.
  const minutes = (cell: TimesheetCell) => (cell.runs === 0 ? '' : String(cell.minutes));

  // Runs the figure leaves out: one that reported no duration, and one that has not ended. Said in a
  // word and not in a colour, because the figure beside it is short of the work done.
  const short = (cell: TimesheetCell) => cell.untimed + cell.running;

  // Every cell the grid draws. A row for a card or a day that is not on screen has nothing to point
  // at, so it is dropped here once and neither the grid nor the lines under it carry it.
  const cells = $derived(new Set(week.rows.flatMap((row) => week.days.map((day) => `${row.key} ${day}`))));

  // The card and the day, which is the cell. Built once, because a week is seven columns times the
  // rows and a scan per cell would read the list again for each of them.
  //
  // Two rows for one cell means two destinations, and this panel draws one. It stops there instead of
  // keeping the last row and hiding the other, which would show a cell as sent while a second
  // destination refused it.
  const marked = $derived.by(() => {
    const pairs = (sync ?? []).map((one) => [`${one.card} ${one.day}`, one] as const).filter(([key]) => cells.has(key));
    const twice = pairs.find(([key], index) => pairs.findIndex(([other]) => other === key) !== index);
    if (twice !== undefined) throw new Error(`Two sync rows for ${twice[0]}. This panel draws one destination at a time.`);
    return new Map(pairs);
  });
  const markOf = (card: string, day: string) => marked.get(`${card} ${day}`);

  // What a mark says to a person. Each line names what happens next. `changed` is the one that costs
  // money: the hours that went out are what the client is billed from, and they are not the hours on
  // screen any more.
  const SAYS: Record<TimesheetSync['state'], string> = {
    sent: 'Sent.',
    failed: 'Not sent. A later export tries it again.',
    stuck: 'Not sent, and stuck: it failed too often. Save the connection again and the next export tries it.',
    changed: 'Sent, and the minutes have changed since. The tracker holds the figure that went, and only you can fix it there.',
    skipped: 'Not sent, because this tracker does not take it.',
  };

  // A line under the grid for every mark that is not a plain sent. A sent cell needs no sentence. Of
  // the other four, all but skipped carry something a person has to act on.
  const notes = $derived([...marked.values()].filter((one) => one.state !== 'sent'));
</script>

<div class="week">
  <div class="hd">
    <h2 id="week-title" class="h-sec">Timesheet <span class="n">{weekLabel(week.days[0] ?? week.week, week.days[6] ?? week.week)} · minutes</span></h2>
    {@render steps?.()}
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the route resolve()s this href and hands it in -->
    <a class="csv" href={csvHref} download
      ><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"></path><path d="m7 10 5 5 5-5"></path><path d="M5 20h14"></path></svg>Export CSV</a
    >
  </div>

  {#if week.rows.length === 0}
    <p class="quiet wide">{NO_TIMESHEET}</p>
  {:else}
    <!-- Its own scroll on a narrow window: eight columns of minutes do not fit beside a phone's edge,
         and the page must not scroll sideways. -->
    <div class="scroll">
      <table>
        <caption class="sr">One row per card, one column per UTC day, minutes of run time.</caption>
        <thead>
          <tr>
            <th scope="col">Card</th>
            {#each week.days as day, index (day)}
              <th scope="col" class:now={day === today}>{NAMES[index]} {Number(day.slice(8))}</th>
            {/each}
            <th scope="col">Week</th>
          </tr>
        </thead>
        <tbody>
          {#each week.rows as row (row.key)}
            <tr data-row={row.key}>
              <th scope="row">
                <!-- A deleted card and maintenance have no card page, so no link. -->
                {#if cardHref !== null && row.source !== null}
                  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the route resolve()s this href and hands it in -->
                  <a class="cc" href={cardHref(row.key)}><span class="k">{row.key}</span><span class="t">{row.label}</span></a>
                {:else}
                  <span class="cc"><span class="k">{row.key}</span><span class="t">{row.label}</span></span>
                {/if}
              </th>
              {#each row.cells as cell, index (week.days[index])}
                {@const mark = markOf(row.key, week.days[index] ?? '')}
                <td class="number" class:now={week.days[index] === today} class:live={cell.running > 0} title={cell.running > 0 ? 'A run is still going' : undefined}
                  >{minutes(cell)}{#if short(cell) > 0}<span class="quiet mark">short</span>{/if}{#if mark !== undefined}<span
                      class="quiet mark"
                      data-sync="{row.key} {mark.day}">{mark.state}</span
                    >{/if}</td
                >
              {/each}
              <td class="number">{row.total.minutes}</td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            {#each week.perDay as cell, index (week.days[index])}
              <td class="number" class:now={week.days[index] === today}>{minutes(cell)}</td>
            {/each}
            <td class="number">{week.total.minutes}</td>
          </tr>
        </tfoot>
      </table>
    </div>

    {#if notes.length > 0}
      <ul class="notes">
        {#each notes as note (`${note.card} ${note.day}`)}
          <li class="quiet" data-note="{note.card} {note.day}">{note.card} on {note.day}. {SAYS[note.state]}{#if note.reason !== null}
              {note.reason}{/if}</li>
        {/each}
      </ul>
    {/if}

    {#if short(week.total) > 0}
      <p class="quiet wide">
        A cell marked short holds a run that reported no time, or one that is still going. Those runs are counted and their minutes
        are not, so the figure beside the mark is under the work done.
      </p>
    {/if}
  {/if}

  <!-- The Export button and the connections are drawn by the page under this panel, because they
       post to the route's own actions. The CSV above is free on every plan. -->
  {#if canExport}
    <p class="quiet wide" data-export="solo">
      Sending a week to Toggl, Harvest, Clockify or Jira is part of Solo. Export posts it from this machine, with each token in the OS
      keychain.
      {#if sync === null}No time tracker is connected, so no cell has an export status.{:else if syncTo !== null}The marks in the grid are
        for {syncTo}.{/if}
    </p>
  {:else}
    <p class="quiet wide plan" data-export="free">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>Send weeks to Toggl, Harvest or Clockify with Solo
    </p>
  {/if}
</div>

<style>
  .hd {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .h-sec {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 auto 0 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .n {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 400;
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

  .csv {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    box-sizing: border-box;
    height: 26px;
    padding: 0 9px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-xs);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
  }

  .scroll {
    margin-top: var(--space-3);
    overflow-x: auto;
  }

  /* Seven day columns and the week are fixed, so the card column keeps room for its key. */
  table {
    width: 100%;
    min-width: 520px;
    border-collapse: collapse;
    table-layout: fixed;
  }

  th,
  td {
    padding: 7px var(--space-2);
    text-align: right;
    white-space: nowrap;
  }

  thead th {
    width: 50px;
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--muted);
  }

  thead th:first-child {
    width: auto;
  }

  thead th:last-child {
    width: 56px;
  }

  th:first-child,
  td:first-child {
    padding-left: 0;
    text-align: left;
  }

  th:last-child,
  td:last-child {
    padding-right: 0;
  }

  tbody th,
  td {
    border-top: 1px solid var(--line);
    font-weight: 400;
    color: var(--ink);
  }

  .cc {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }

  .k {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--mono-card-key);
    color: var(--muted);
  }

  .t {
    overflow: hidden;
    font-size: var(--text-xs);
    color: var(--ink-2);
    text-overflow: ellipsis;
  }

  .number {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  /* A day with no run shows a quiet dot, and a screen reader hears nothing. */
  td.number:empty::after {
    color: var(--muted);
    content: '·' / '';
  }

  .now {
    background: var(--card);
    color: var(--ink);
  }

  /* A run still going: the amber of an agent at work. The short mark beside the figure says it in words. */
  .live {
    color: var(--amber);
  }

  tfoot th,
  tfoot td {
    border-top: 1px solid var(--line-2);
    font-weight: 600;
  }

  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .mark {
    margin-left: 6px;
    font-family: var(--font-sans);
  }

  .wide {
    margin: var(--space-3) 0 0;
  }

  .plan {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .plan .ico {
    width: 11px;
    height: 11px;
  }

  .notes {
    margin: var(--space-3) 0 0;
    padding-left: 16px;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
