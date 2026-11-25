<script lang="ts">
  import { type EvidenceBlock, type EvidenceDay, formatCost, formatDuration, formatTokens, NO_CARD_GROUP, NO_EVIDENCE } from '@nolzu/protocol';
  import { type LaneState, timelineOf, weekTimelineOf } from './evidence-timeline.ts';

  // The day as a timeline, one lane per card. The lanes and every
  // position are worked out by timelineOf, so this file only places them. Nothing here posts: the
  // screen reads what already happened.
  //
  // The link to a card comes in as a function, because resolve() only works on the route. `today` says
  // the day is not over, so an empty one reads as empty yet and `now` draws its line. `phases` is the
  // word each run block prints, by the block's ref. `states` is each card's state off the board
  // snapshot, for the dot beside its key. `week` draws `day` as the seven days from its Monday, the
  // Week view, with `now` placed wherever it falls inside them.
  let {
    day,
    cardHref,
    today = false,
    now = null,
    phases = {},
    states = {},
    week = false,
  }: {
    day: EvidenceDay;
    cardHref: (key: string) => string;
    today?: boolean;
    now?: string | null;
    phases?: Record<string, string>;
    states?: Record<string, LaneState>;
    week?: boolean;
  } = $props();

  const line = $derived(week ? weekTimelineOf(day, now) : timelineOf(day, today ? now : null));
  const cards = $derived(line.lanes.filter((lane) => lane.card !== null).length);

  // The clock time of the block, in UTC, because the day it sits under is the UTC day. Sliced and
  // not formatted: Intl would print the machine's own zone.
  const clock = (start: string) => start.slice(11, 16);
  const owner = (block: EvidenceBlock) => (block.card === null ? '' : `${block.card} `);

  // What the old list printed on a run's line, read out and shown on hover: the sentence, the time,
  // the duration and the cost, the tokens, or why there is neither.
  function runSays(run: EvidenceBlock): string {
    const figures = [clock(run.start)];
    if (run.durationMs !== null) figures.push(formatDuration(run.durationMs));
    if (run.spend !== null && run.spend.costUsd !== null) figures.push(formatCost(run.spend.costUsd));
    else if (run.spend !== null && run.spend.tokens !== null) figures.push(`${formatTokens(run.spend.tokens)} tokens`);
    else figures.push(run.running ? 'no cost yet' : 'no cost reported');
    return `${owner(run)}${run.description}, ${figures.join(', ')}`;
  }

  // A ruler label this close to the now chip would sit under it.
  const clear = (at: number) => line.now === null || Math.abs(at - line.now) > 4;
</script>

{#snippet person()}
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path></svg>
{/snippet}

<div class="hd">
  <h2 id="day-title" class="h-sec">Timeline<span class="n">{cards} {cards === 1 ? 'card' : 'cards'}</span></h2>
  {#if line.lanes.length > 0}
    <!-- The day is the UTC day, so a clock on this screen is a UTC clock and not the machine's. -->
    <span class="utc">Hours in UTC</span>
    <div class="legend" aria-hidden="true">
      <span><i class="sw"></i>Agent run</span>
      <span><i class="mvg">{@render person()}</i>Stage move</span>
      <span><i class="cmg"></i>Commit</span>
    </div>
  {/if}
</div>

{#if day.problem !== null}
  <p class="problem">{day.problem}</p>
{/if}

{#if line.lanes.length === 0}
  <p class="empty">
    {week ? 'Nothing recorded this week. A block appears when a run starts, a card moves or a commit lands.' : today ? 'Nothing yet today. Every run and move lands here.' : NO_EVIDENCE}
  </p>
{:else}
  <!-- Its own scroll on a narrow window, so the hours keep their room and the page does not scroll
       sideways. -->
  <div class="scroll">
    <div class="tl">
      <div class="grid" aria-hidden="true">
        {#if line.now !== null}<i class="fut" style:left="{line.now}%"></i>{/if}
        {#each line.hours as hour (hour.label)}<i style:left="{hour.at}%"></i>{/each}
        {#if line.now !== null}<i class="nowl" style:left="{line.now}%"></i>{/if}
      </div>

      <div class="row ruler" aria-hidden="true">
        <span></span>
        <div class="tr">
          {#each line.hours as hour (hour.label)}{#if clear(hour.at)}<span class="hr" class:end={hour.at > 97} style:left="{hour.at}%">{hour.label}</span>{/if}{/each}
          {#if line.now !== null}<span class="now" style:left="{line.now}%">{line.nowLabel}</span>{/if}
        </div>
      </div>

      {#each line.lanes as lane (lane.card)}
        {@const state = lane.card === null ? undefined : states[lane.card]}
        <div class="row lane" data-lane={lane.card ?? 'none'}>
          {#if lane.card !== null}
            <!-- The mark sits beside the link and not in it: a running dot is amber, and amber goes on no
                 control but the go button. The word is in the link for a screen reader. -->
            <div class="lab" class:marked={state?.closed || (state !== undefined && state.state !== 'idle')}>
              {#if state?.closed}
                <svg class="ico mk" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>
              {:else if state !== undefined && state.state !== 'idle'}
                <span class="sd mk" data-state={state.state} aria-hidden="true"></span>
              {/if}
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the route resolve()s this href and hands it in -->
              <a href={cardHref(lane.card)}
                ><span class="k">{lane.card}{#if state !== undefined}<span class="sr">{state.word}</span>{/if}</span><span class="t">{lane.title}</span></a
              >
            </div>
          {:else}
            <span class="lab"><span class="k">no card</span><span class="t">{NO_CARD_GROUP}</span></span>
          {/if}
          <div class="tr">
            {#each lane.moves as mark (mark.block.ref)}
              <span class="mv" style:left="{mark.at}%" role="img" aria-label="{owner(mark.block)}{mark.block.description}, {clock(mark.block.start)}" title="{mark.block.description}, {clock(mark.block.start)}"
                ><span>{@render person()}</span></span
              >
            {/each}
            {#each lane.commits as mark (mark.block.ref)}
              <span
                class="cm"
                style:left="{mark.at}%"
                role="img"
                aria-label="{owner(mark.block)}commit {mark.block.ref}, {mark.block.description}, {clock(mark.block.start)}"
                title="{mark.block.ref} {mark.block.description}, {clock(mark.block.start)}"
              ></span>
            {/each}
            <!-- A block is the amber of agent work, so it is a mark and not a link: amber goes on no
                 control but the go button. The lane's key opens the card's log. -->
            {#each lane.runs as group (group.runs[0]?.ref)}
              <span class="blk" style:left="{group.at}%">
                {#each group.runs as run (run.ref)}
                  <span class="piece" class:live={run.running} role="img" aria-label={runSays(run)} title={runSays(run)}
                    >{#if run.running}<i></i>{/if}{phases[run.ref] ?? 'run'}</span
                  >
                {/each}
              </span>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}

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
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .n {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 400;
    color: var(--muted);
  }

  .utc {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .legend {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .legend > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .sw {
    width: 16px;
    height: 10px;
    border-radius: 3px;
    background: var(--amber-bg);
    box-shadow: inset 0 0 0 1px var(--amber-line);
  }

  .ico {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .mvg,
  .mv > span {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--card-2);
    box-shadow: inset 0 0 0 1px var(--line-2);
    color: var(--ink-2);
  }

  .cmg,
  .cm {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--panel);
    box-shadow: inset 0 0 0 1.5px var(--ink-2);
  }

  .problem,
  .empty {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .problem {
    color: var(--ink-2);
  }

  .scroll {
    overflow-x: auto;
  }

  .tl {
    position: relative;
    min-width: 560px;
    margin-top: 14px;
  }

  .row {
    display: grid;
    grid-template-columns: 176px 1fr;
    align-items: center;
  }

  .tr {
    position: relative;
    height: 100%;
  }

  .grid {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    left: 176px;
    pointer-events: none;
  }

  .grid i {
    position: absolute;
    top: 22px;
    bottom: 0;
    width: 1px;
    background: var(--line);
  }

  /* The rest of today has not happened, so it sits under a veil. */
  .grid .fut {
    top: 24px;
    right: 0;
    width: auto;
    background: oklch(from var(--bg) l c h / 0.45);
  }

  .grid .nowl {
    top: 18px;
    width: 1.5px;
    background: var(--ink-2);
    transform: translateX(-50%);
  }

  .ruler {
    height: 24px;
  }

  .hr {
    position: absolute;
    top: 3px;
    transform: translateX(-50%);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  /* The last hour sits on the right edge, so its label ends there rather than being cut. */
  .hr.end {
    transform: translateX(-100%);
  }

  .now {
    position: absolute;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    height: 20px;
    padding: 0 6px;
    transform: translateX(-50%);
    border-radius: 5px;
    background: var(--accent);
    color: var(--accent-ink);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    font-weight: 500;
  }

  .lane {
    height: 42px;
  }

  .lab {
    position: relative;
    display: flex;
    flex-direction: column;
    min-width: 0;
    padding-right: 14px;
  }

  .lab a {
    display: flex;
    flex-direction: column;
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }

  /* The key moves over for the mark, and the title keeps the edge. */
  .marked .k {
    padding-left: 13px;
  }

  .mk {
    position: absolute;
    top: 4px;
    left: 0;
  }

  svg.mk {
    top: 3px;
    width: 11px;
    height: 11px;
    color: var(--muted);
    stroke-width: 2.2;
  }

  .k {
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .t {
    overflow: hidden;
    font-size: var(--text-xs);
    color: var(--ink-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The card's state off the board, the colours the board's pills use. */
  .sd {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--muted);
  }

  .sd[data-state='running'] {
    background: var(--amber);
  }

  .sd[data-state='queued'] {
    box-sizing: border-box;
    border: 1.5px solid var(--amber);
    background: transparent;
  }

  .sd[data-state='ready'] {
    background: var(--green);
  }

  .sd[data-state='blocked'] {
    background: var(--violet);
  }

  .sd[data-state='failed'] {
    background: var(--red);
  }

  .sd[data-state='new'] {
    background: var(--blue);
  }

  .lane .tr::before {
    position: absolute;
    top: 50%;
    right: 0;
    left: 0;
    height: 1px;
    background: var(--line);
    content: '';
  }

  .mv {
    position: absolute;
    top: 9px;
    bottom: 9px;
    width: 1px;
    transform: translateX(-50%);
    background: var(--line-2);
  }

  .mv > span {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
  }

  .cm {
    position: absolute;
    top: 50%;
    transform: translate(-50%, -50%);
  }

  .blk {
    position: absolute;
    top: 50%;
    z-index: 1;
    display: flex;
    gap: 2px;
    transform: translateY(-50%);
  }

  .piece {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--amber-bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
  }

  .blk > :not(:first-child) {
    border-top-left-radius: 2px;
    border-bottom-left-radius: 2px;
  }

  .blk > :not(:last-child) {
    border-top-right-radius: 2px;
    border-bottom-right-radius: 2px;
  }

  /* A run still going: the amber of an agent at work, and its dot. */
  .piece.live {
    gap: 6px;
    color: var(--amber);
    box-shadow: inset 0 0 0 1px var(--amber-line);
  }

  .live i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--amber);
    box-shadow: 0 0 0 3px var(--amber-bg);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  @media (max-width: 760px) {
    .row {
      grid-template-columns: 110px 1fr;
    }

    .grid {
      left: 110px;
    }
  }
</style>
