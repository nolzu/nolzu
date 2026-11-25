<script lang="ts">
  import { effortInModel, formatCost, formatDuration, type Segment, type Spend, type StripRun, wallLabel } from '@nolzu/protocol';
  import { engineName } from '../board/drop.ts';
  import Ago from './Ago.svelte';

  // The right column of a closed card: the totals, then every move
  // with who made it and when. `spend` is every run of the card, for the reason the trail gives. A move
  // that started a phase carries that phase's newest run, on the newest such move only, so a phase
  // moved into twice never shows one run twice.
  // `notes` puts a line the page read later, such as "#42 opened 3 hours ago, merged by you 2 hours ago"
  // from the pull request lookup, in place of who moved the card, on the newest move into the stage it
  // names. Each time is drawn on `now`, the page's clock, as the trail draws its times.
  type Timed = { words: string; at?: string };
  let {
    strip,
    spend,
    moves,
    logBase,
    notes = {},
    now = new Date(),
  }: {
    strip: readonly Segment[];
    spend: Spend;
    moves: readonly { label: string; said: string; at?: string; phase: string | null; reason?: string; back?: boolean }[];
    logBase: string;
    notes?: Readonly<Record<string, readonly Timed[]>>;
    now?: Date;
  } = $props();
  const noteOf = (at: number): readonly Timed[] | null => {
    const label = moves[at]?.label ?? '';
    return notes[label] !== undefined && moves.findLastIndex((move) => move.label === label) === at ? notes[label] : null;
  };

  // Who moved the card and when, "moved by you, 5 minutes ago", unless a note stands in its place.
  const partsOf = (at: number): readonly Timed[] => {
    const move = moves[at];
    if (noteOf(at) !== null || move === undefined) return noteOf(at) ?? [];
    return [move.at === undefined ? { words: move.said } : { words: `${move.said},`, at: move.at }];
  };

  const runOf = (at: number): StripRun | null => {
    const phase = moves[at]?.phase ?? null;
    if (phase === null || moves.findLastIndex((move) => move.phase === phase) !== at) return null;
    return strip.find((segment) => segment.phase === phase)?.run ?? null;
  };
  // A figure nobody reported is left out, never shown as nought.
  // What the run ran on and the wall that held it, as the trail says it.
  const ranWith = (run: StripRun) =>
    [run.engine === undefined ? null : engineName(run.engine), run.model ?? 'no model', effortInModel(run.engine) ? null : (run.effort ?? 'no effort'), wallLabel(run.wall)].filter((one) => one !== null).join(' · ');
  const figures = (run: StripRun) =>
    [run.durationMs === null ? null : formatDuration(run.durationMs), run.costUsd === null ? null : formatCost(run.costUsd)].filter((one) => one !== null).join(' · ');
</script>

<!-- A space between the figure and its words, so a screen reader hears two words and not one. -->
<section class="totals" aria-label="Totals">
  <div><b>{spend.costUsd === null ? 'none' : formatCost(spend.costUsd)}</b> <span>{spend.costUsd === null ? 'cost reported' : 'cost, estimated'}</span></div>
  <div><b>{spend.durationMs === 0 ? 'none' : formatDuration(spend.durationMs)}</b> <span>agent time</span></div>
  <div><b>{spend.runs}</b> <span>{spend.runs === 1 ? 'run' : 'runs'}</span></div>
</section>

<section class="record" aria-labelledby="record">
  <h2 class="label" id="record">Trail</h2>
  {#if moves.length === 0}
    <p class="quiet">No move of this card is recorded.</p>
  {:else}
    <ol>
      {#each moves as move, at (at)}
        {@const run = runOf(at)}
        <li data-phase={move.phase ?? undefined}>
          <span class="dot" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"></path></svg></span>
          <p class="l1">
            <b>{move.label}</b>
            {#if run !== null}
              {#if run.verdict}<span class="verdict" data-verdict={run.verdict}>{run.verdict.toLowerCase()}</span>{/if}
              {#if figures(run) !== ''}<span class="mono">{figures(run)}</span>{/if}
              <a href="{logBase}?run={run.id}">Log <span class="hidden">of the {move.label} run</span></a>
            {/if}
          </p>
          <p class="quiet">{#if run !== null}<span class="mono">{ranWith(run)}</span><span class="sep">·</span>{/if}{#each partsOf(at) as part, n (n)}{part.at === undefined ? part.words : `${part.words} `}{#if part.at !== undefined}<Ago at={part.at} {now} />{/if}{/each}</p>
          {#if move.reason !== undefined}<p class="why" data-reason>{move.back ? 'Sent back' : 'Accepted anyway'}: {move.reason}</p>{/if}
        </li>
      {/each}
    </ol>
  {/if}
  <!-- The totals above say the cost is estimated, so only a cost that covers some runs says more. -->
  {#if spend.costUsd !== null && spend.partial}
    <p class="quiet">The cost covers {spend.reported} of {spend.runs} runs.</p>
  {/if}
</section>

<style>
  .totals {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .totals div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: var(--space-3) var(--space-4);
    border-left: 1px solid var(--line);
  }

  .totals div:first-child {
    border-left: 0;
  }

  /* A cost, a time and a count are figures, so they are mono. */
  .totals b {
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: 20px;
    font-weight: 500;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }

  .totals span,
  .quiet {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  /* Svelte trims the spaces at the ends of an element, so the dot keeps its room with a margin. */
  .sep {
    margin-inline: 0.4em;
  }

  .record {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .label {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  /* One move under the other on a line, as the open card's trail draws it. */
  ol {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    position: relative;
    padding: 0 0 var(--space-3) 28px;
  }

  li::before {
    position: absolute;
    top: 20px;
    bottom: 0;
    left: 8px;
    width: 1.5px;
    background: var(--line-2);
    content: '';
  }

  li:last-child {
    padding-bottom: 0;
  }

  li:last-child::before {
    display: none;
  }

  /* Every move happened, so every mark is the done check of the open card's trail: an ink check in a
     soft green circle. The words beside it say what was done. */
  .dot {
    position: absolute;
    top: 1px;
    left: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--green-bg);
    color: var(--ink);
  }

  .dot svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 2.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  p {
    margin: 0;
  }

  /* The person's own words, in a text ink, so the reviewer reads why the card went on. */
  .why {
    margin-top: 2px;
    color: var(--ink-2);
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .l1 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  .l1 b {
    margin-right: auto;
    color: var(--ink);
    font-weight: 600;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .l1 .mono {
    color: var(--muted);
  }

  /* The word says the verdict, so the state never rests on the colour. */
  .verdict {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .verdict[data-verdict='PASS'] {
    color: var(--green);
  }

  .verdict[data-verdict='FAIL'] {
    color: var(--red);
  }

  a {
    font-size: var(--text-xs);
    color: var(--blue);
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
