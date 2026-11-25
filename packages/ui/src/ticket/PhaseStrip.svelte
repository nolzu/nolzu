<script lang="ts">
  import { effortInModel, formatCost, formatDuration, formatTokens, type Segment, type Spend, type StripRun, wallLabel } from '@nolzu/protocol';
  import { engineName } from '../board/drop.ts';
  import { pipOf, runSaid as status } from '../pips.ts';
  import Ago from './Ago.svelte';

  // The trail: the audit trail in miniature.
  // `spend` is every run of the card, not the segments added up. A run whose phase is no stage of
  // this board is in no segment, so adding the segments would drop its cost and still call the total
  // complete.
  // `moves` is every move of the card, oldest first, from the card events. The newest move that started
  // a phase says who started it and when; a phase with no such move says nothing, rather than a guess.
  // A move with a reason, such as Accept anyway on a QA FAIL or the note of a send back, shows under the
  // phase it left.
  // `since` is when a blocked card started to wait. Every time is drawn as "5 minutes ago" on `now`,
  // the page's clock, with the full date and time on hover. A move without its time leaves it out.
  let {
    strip,
    spend,
    logBase,
    moves = [],
    since = null,
    now = new Date(),
  }: {
    strip: readonly Segment[];
    spend: Spend;
    logBase: string;
    moves?: readonly { said: string; at?: string; phase: string | null; reason?: string; from?: string | null; back?: boolean }[];
    since?: string | null;
    now?: Date;
  } = $props();

  const movedInto = (phase: string) => moves.findLast((move) => move.phase === phase) ?? null;
  const goneOn = (phase: string) => moves.findLast((move) => move.reason !== undefined && move.from === phase) ?? null;

  // What a phase that has not run will do, as its skill has every run of it do. Keyed by the phase, so
  // an epic's Refine, Plan and Wrap-up say it too, since they run the same skills. A phase not named
  // here says only that it has not run.
  const WILL: Readonly<Record<string, string>> = {
    refine: 'rewrites the ticket so done is clear',
    plan: 'writes the steps and what QA will check',
    implement: 'changes the code in the checkout',
    qa: 'runs the checks the plan wrote',
    wrapup: 'writes what it learned',
  };

  // The first phase still to run, right after one that ended done, waits for the person to move the
  // card. It is where an agent starts next, so it is the one amber mark of the trail.
  const next = $derived(strip.findIndex((segment, at) => segment.run === null && at > 0 && pipOf(strip[at - 1]!) === 'done'));
  const mark = (segment: Segment, at: number): string => (at === next ? 'next' : pipOf(segment));
  // Only the newest run can be the question the card waits on now. An older phase that asked and was
  // moved on from says it asked, so the trail never claims a wait that is over.
  const newest = $derived(strip.reduce((best, segment, at) => (segment.run !== null && (best < 0 || segment.run.id > (strip[best]?.run?.id ?? 0)) ? at : best), -1));
  const waits = (at: number): boolean => since !== null && at === newest;

  // Input and output only. Cache reads run to hundreds of thousands on every
  // run, so they are named in the title and not added in.
  const tokenTitle = (run: StripRun) =>
    run.tokens === null
      ? ''
      : `${formatTokens(run.tokens.input + run.tokens.output)} tok: ${formatTokens(run.tokens.input)} in · ${formatTokens(run.tokens.output)} out · ${formatTokens(run.tokens.cacheRead)} cache read · ${formatTokens(run.tokens.cacheCreation)} cache written`;
  const total = $derived(spend);

  // "no cost yet" is only true while the run may still report one. A run that ended, whether it
  // finished, failed or was stopped, will never report a cost it has not reported, so its line
  // leaves the cost out rather than promising a number that is not coming.
  const pending = (run: StripRun) => run.state === null || run.state === 'queued' || run.state === 'waiting_lane' || run.state === 'waiting_review' || run.state === 'running' || run.state === 'retrying';
  const showsCost = (run: StripRun) => run.costUsd !== null || pending(run);
  // The same for the total: a cost nobody reported is left out, and so is a time nobody reported.
  const totalCost = $derived(total.costUsd === null ? null : formatCost(total.costUsd));
  const totalTime = $derived(total.durationMs === 0 ? null : formatDuration(total.durationMs));
  // The rest of the heading's figure after the cost: the time, then the tokens. Shown only beside a
  // cost or a time, as the total always was.
  const rest = $derived([totalTime, total.tokens === null ? null : `${formatTokens(total.tokens)} tok`].filter((one) => one !== null).join(' · '));
  const heading = $derived(totalCost !== null || totalTime !== null);
  // What the cost covers, in a sentence of its own. It is about the cost and not about the time, and
  // the time above covers every run, so the two must not share a clause. Without this a card with a
  // Claude Code run and a Codex run reads as if the figure were the whole bill.
  const coverage = $derived(
    total.costUsd === null
      ? `No cost reported for ${total.runs} ${total.runs === 1 ? 'run' : 'runs'}.`
      : total.partial
        ? `The cost covers ${total.reported} of ${total.runs} runs.`
        : '',
  );
  // Why a cost is missing. An engine that reports
  // token counts and no cost will never report one, so the number is not on its way. Said only where
  // a cost was reported too, because the sentence above already carries the all-missing case.
  const tokensOnly = $derived(
    total.tokensOnly === 0 || total.costUsd === null
      ? ''
      : ` ${total.tokensOnly} of those ${total.tokensOnly === 1 ? 'runs reports' : 'runs report'} tokens only, no cost reported.`,
  );
  const note = $derived(heading ? `${coverage}${tokensOnly}`.trim() : '');

  // The run's one line: engine, model, effort, the wall that held it and time. The cost follows in the
  // markup, titled as an estimate. A row made before the wall column says no wall, and an engine that
  // reads the effort off the model id says no effort at all.
  const detail = (run: StripRun) =>
    [run.engine === undefined ? null : engineName(run.engine), run.model ?? 'no model', effortInModel(run.engine) ? null : (run.effort ?? 'no effort'), wallLabel(run.wall), run.durationMs === null ? null : formatDuration(run.durationMs)]
      .filter((one) => one !== null)
      .join(' · ');

  // "FAIL, empty list", then when the run ended in the markup. Each part is left out when the run did
  // not say it.
  const failLine = (run: StripRun) => ['FAIL', run.verdictReason ?? null].filter((one) => one !== null && one !== '').join(', ');
</script>

<section class="strip" aria-labelledby="trail">
  <div class="head">
    <h2 class="label" id="trail">Trail</h2>
    <!-- The cost is an estimate from the token counts, so it is titled and read out as one. -->
    {#if heading}<p class="mono total"><span class="hidden">Total so far </span>{#if totalCost !== null}<span title="Estimated value">{totalCost} <span class="hidden">estimated</span></span>{/if}{totalCost !== null && rest !== '' ? ' · ' : ''}{rest}</p>{/if}
  </div>
  <ol>
    {#each strip as segment, at (segment.phase)}
      <li data-phase={segment.phase} data-mark={mark(segment, at)} data-state={segment.run?.verdict === 'FAIL' ? 'failed' : (segment.run?.state ?? 'none')} data-asked={segment.run?.question ? 'true' : undefined}>
        <span class="dot" aria-hidden="true">
          {#if mark(segment, at) === 'done'}<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"></path></svg>
          {:else if mark(segment, at) === 'asked'}?
          {:else if mark(segment, at) === 'failed'}<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"></path></svg>{/if}
        </span>
        <!-- Each space sits before its block, because Svelte drops one at the start of an element or a
             block, and the line read "Plan· ran 2 times". -->
        <p class="phase">
          <span>{segment.label} {#if segment.count > 1}<span class="quiet">· ran {segment.count} times</span>{/if}</span>
          {#if segment.run !== null}<a href="{logBase}?run={segment.run.id}">log <span class="hidden">of the {segment.label} run</span></a>{/if}
        </p>
        {#if segment.run === null}
          {#if at === next}
            <p class="mono amber">waits for your approval</p>
          {:else}
            <p class="mono quiet">{WILL[segment.phase] ?? 'not run yet'}</p>
          {/if}
        {:else}
          {@const run = segment.run}
          <p class="mono" title={tokenTitle(run) || undefined}>
            {detail(run)} {#if showsCost(run)}· <span title="Estimated value">{formatCost(run.costUsd)} {#if run.costUsd !== null}<span class="hidden">estimated</span>{/if}</span>{/if}{#if run.costUsd === null && run.tokens !== null}{` · ${formatTokens(run.tokens.input + run.tokens.output)} tok`}{/if}
          </p>
          {#if mark(segment, at) === 'asked'}
            <p class="mono violet">{#if waits(at) && since !== null}asked you <Ago at={since} {now} />{:else}asked a question{/if}</p>
          {:else if run.verdict === 'FAIL'}
            <p class="mono red">{failLine(run)}{#if run.endedAt != null}, <Ago at={run.endedAt} {now} />{/if}</p>
          {:else if mark(segment, at) === 'done'}
            <p class="hidden">done</p>
          {:else}
            <p class="mono">{status(run)}</p>
          {/if}
          {@const moved = movedInto(segment.phase)}
          {#if moved !== null}<p class="mono quiet" data-moved>{moved.said}{#if moved.at !== undefined}, <Ago at={moved.at} {now} />{/if}</p>{/if}
          {@const accepted = goneOn(segment.phase)}
          {#if accepted !== null}
            <p class="quiet" data-reason>{accepted.back ? 'Sent back' : 'Accepted anyway'}, {accepted.said}{#if accepted.at !== undefined}, <Ago at={accepted.at} {now} />{/if}</p>
            <p class="why">{accepted.reason}</p>
          {/if}
        {/if}
      </li>
    {/each}
  </ol>
  <!-- The figure is in the heading. What it covers and why a cost is missing stay under the list. -->
  {#if note !== ''}<p class="quiet">{note}</p>{/if}
</section>

<style>
  .strip {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }

  .total {
    margin-left: auto;
    color: var(--muted);
  }

  /* The bold section heading, as the closed card's record writes it. */
  .label {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  /* One phase under the other, joined by a line. */
  ol {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 0 14px 28px;
    font-size: var(--text-xs);
    color: var(--ink-3);
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

  p {
    margin: 0;
  }

  /* The name, and the log link at the right end of its line. */
  .phase {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--ink);
  }

  [data-mark='none'] .phase,
  [data-mark='next'] .phase {
    color: var(--ink-2);
  }

  .phase a {
    margin-left: auto;
    font-weight: 400;
  }

  /* A ring for a phase still to run. Done is a check in a soft green circle, a question a violet ring
     with a "?", a failure a red ring with an x, and the step that waits for the person an amber ring.
     A mark, never the only sign: the line under the phase says the state in words. */
  .dot {
    position: absolute;
    top: 1px;
    left: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--panel);
    box-shadow: inset 0 0 0 1.5px var(--line-2);
    font-size: 11px;
    font-weight: 700;
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

  [data-mark='done'] .dot {
    background: var(--green-bg);
    box-shadow: none;
    color: var(--ink);
  }

  [data-mark='asked'] .dot {
    background: var(--violet-bg);
    box-shadow: inset 0 0 0 1.5px var(--violet);
    color: var(--violet);
  }

  [data-mark='failed'] .dot {
    background: var(--red-bg);
    box-shadow: inset 0 0 0 1.5px var(--red);
    color: var(--red);
  }

  [data-mark='next'] .dot {
    background: var(--amber-bg);
    box-shadow: inset 0 0 0 1.5px var(--amber);
  }

  [data-mark='now'] .dot {
    box-shadow: inset 0 0 0 5px var(--amber);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
  }

  .quiet {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .mono.quiet {
    font-size: var(--mono-sm);
  }

  .amber {
    color: var(--amber);
  }

  .violet {
    color: var(--violet);
  }

  .red {
    color: var(--red);
    overflow-wrap: anywhere;
  }

  /* The person's own words, in a text ink, so the reviewer reads why the card went on. */
  .why {
    color: var(--ink-2);
    overflow-wrap: anywhere;
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
