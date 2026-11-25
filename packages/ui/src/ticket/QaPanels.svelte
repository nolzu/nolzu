<script lang="ts">
  import { formatCost, formatDuration, type StackState, type StripRun } from '@nolzu/protocol';
  import Chip from '../Chip.svelte';
  import Skeleton from '../Skeleton.svelte';
  import StatePill from '../StatePill.svelte';
  import { ranOn } from '../board/drop.ts';
  import { ago } from '../board/peek.ts';
  import Block from './Block.svelte';
  import { checkCount, checkOfShot, checkWord, type QaCheck, type QaView, type StackAction } from './qa.ts';

  // The page does the write and builds every address, because this package never fetches. `onstack`
  // answers with the sentence to show, whether the command worked or not.
  let {
    view,
    fileHref,
    shotHref = fileHref,
    logHref = null,
    onstack = async () => 'Nothing is wired to this button yet.',
    stack = true,
    verdict = true,
    failed = null,
    box = false,
  }: {
    view: QaView;
    fileHref: (path: string) => string;
    // Where a screenshot thumbnail goes: the Files tab with that file open. The file itself when left out.
    shotHref?: (path: string) => string;
    logHref?: string | null;
    onstack?: (action: StackAction) => Promise<string>;
    // False where the stack line has no place: a card out of QA with the stack down, or a closed card.
    stack?: boolean;
    // False where the verdict block has nothing to say: a card QA never ran on.
    verdict?: boolean;
    // Set while the card waits in QA on a FAIL, with the QA run the trail names.
    failed?: { run: StripRun | null } | null;
    // On a QA FAIL the Overview draws two parts: the red box that needs the person (`box`), first in
    // the column, and the record of every check with the stack line further down.
    box?: boolean;
  } = $props();

  // Load, Unload and Force run a command the person wrote and wait for it. They start no phase, so
  // `AGENTS.md` puts them with the commit button and not with a drop: each says it is going, takes
  // no second press, and the sentence it ends with is the command's own. The rule that a run's busy
  // state comes from the board snapshot still binds them the other way round: while the stack lane
  // holds a QA run, the snapshot is what greys all three out, and no click here can undo that.
  let going = $state<StackAction | null>(null);
  let said = $state('');

  async function press(action: StackAction): Promise<void> {
    if (going !== null) return;
    going = action;
    said = '';
    // A press nobody awaits, so an `onstack` that throws would otherwise hold all three buttons for
    // the life of the page and leave the reason in the console.
    try {
      said = await onstack(action);
    } catch (error) {
      said = `The command could not be run: ${(error as Error).message}`;
    } finally {
      going = null;
    }
  }

  // The checks that failed, for the line beside the verdict. A report that drifted counts none.
  const checklist = $derived(view.verdict.checklist);
  const rows = $derived(checklist?.rows ?? null);
  const fails = $derived(rows?.filter((row) => row.result === 'fail').length ?? 0);
  const headline = $derived(fails === 0 ? 'QA failed' : fails === 1 ? 'QA found one problem' : `QA found ${fails} problems`);
  // The run as the trail names it, with its time in the words of the other blocks. A figure nobody reported is left out, never shown as nought.
  const runLine = $derived.by(() => {
    const run = failed?.run ?? null;
    if (run === null) return null;
    const ended = run.endedAt == null ? null : ago(run.endedAt, new Date(), true);
    return [run.phase, ranOn(run.engine, run.model, run.effort) || null, run.durationMs === null ? null : formatDuration(run.durationMs), run.costUsd === null ? null : formatCost(run.costUsd), ended]
      .filter((one) => one !== null)
      .join(' · ');
  });
  const count = $derived(rows === null || rows.length === 0 ? null : checkCount(rows));
  // The red box shows the check that failed and its screenshot, so the reason and its proof sit together.
  const failedShots = $derived(view.verdict.screenshots.filter((shot) => checkOfShot(shot.name, checklist)?.result === 'fail'));
  // The one line a folded record shows: the verdict's reason on a pass, the steps on a FAIL. A pass
  // often gives no reason, so it falls back to the steps too rather than an empty line.
  const peek = $derived((failed == null ? (view.verdict.reason ?? view.verdict.note) : null) ?? rows?.map((row) => row.step) ?? null);
  const report = $derived(view.verdict.report === null ? null : { label: 'Open the QA report', href: fileHref(view.verdict.report), attrs: { 'data-qa-report': '' } });

  // The stack's pill in the colour of a card in the same state: down is idle, up is ready, a command in
  // the middle is running.
  const PILL: Record<StackState, 'idle' | 'ready' | 'running' | 'failed'> = { off: 'idle', up: 'ready', loading: 'running', unloading: 'running', failed: 'failed' };

  const GOING: Record<StackAction, string> = {
    load: 'Starting the app.',
    unload: 'Stopping the app.',
    force: 'Running the Stop commands, whatever the state says.',
  };
</script>

{#snippet shots(list: typeof view.verdict.screenshots)}
  <ul class="grid">
    {#each list as shot (shot.path)}
      <!-- The check the screenshot shows, read off the number its name starts with. The word says
           how it went, so the red edge of a fail is never the only sign. A plain link, so a middle
           click opens the Files tab in a new tab. -->
      {@const check = checkOfShot(shot.name, checklist)}
      <li class="shot" data-result={check?.result}>
        <a class="frame" href={shotHref(shot.path)} data-shot={shot.path}>
          <img src={fileHref(shot.path)} alt={check === null ? `Screenshot ${shot.name}` : `Screenshot of check ${check.number}, ${check.step}`} loading="lazy" />
        </a>
        <span class="name">{shot.name}</span>
        {#if check !== null}<span class="of">Check {check.number} <span class="res" data-result={check.result}>{check.result}</span></span>{/if}
      </li>
    {/each}
  </ul>
{/snippet}

{#snippet row(one: QaCheck, number: number)}
  <!-- A short fail reason sits beside the result. A longer one, or what the run did, goes under the row. -->
  {@const word = checkWord(one)}
  <li data-result={one.result}>
    <span class="no">{number}</span>
    {#if one.ac !== undefined}<Chip mono>{one.ac}</Chip>{/if}
    <span class="step">{one.step}</span>
    <span class="res">{word.word}</span>
    {#if word.under !== null}<p class="reason">{word.under}</p>{/if}
  </li>
{/snippet}

{#snippet checks()}
  {#if rows !== null}
    <ol class="checks">
      {#each rows as one, at (at)}{@render row(one, at + 1)}{/each}
    </ol>
  {:else if checklist !== null}
    <!-- The report left the skill's rows, so section 2 shows as written. -->
    <p class="plain" data-checks-text>{checklist.text}</p>
  {/if}
{/snippet}

{#snippet shotsOrNote()}
  {#if view.verdict.screenshots.length > 0}
    {@render shots(view.verdict.screenshots)}
  {:else if view.verdict.screenshotNote !== null}
    <p class="quiet" data-shots-note>{view.verdict.screenshotNote}</p>
  {/if}
{/snippet}

<!-- The parts of the QA run and the App line on the Overview. -->
{#if box}
  {#if failed != null}
    <!-- The id is where Now's "See the QA report" lands. The only red box in the column: the person
         picks Fix it, Move back or Accept beside it. -->
    <section class="failed" id="qa-panel" aria-label="QA verdict" data-verdict-panel>
      <div class="verdict-line">
        <span class="big" data-verdict={view.verdict.verdict}>{view.verdict.verdict}</span>
        <div class="said">
          <b>{headline}</b>
          {#if runLine !== null}<span class="mono">{runLine}</span>{/if}
        </div>
      </div>
      {#if view.verdict.reason !== null}<p class="why" data-verdict-reason>{view.verdict.reason}</p>{/if}
      {#if rows !== null && fails > 0}
        <ol class="checks" data-failed-checks>
          {#each rows as one, at (at)}{#if one.result === 'fail'}{@render row(one, at + 1)}{/if}{/each}
        </ol>
      {/if}
      {#if failedShots.length > 0}{@render shots(failedShots)}{/if}
    </section>
  {/if}
{:else}
  {#if failed != null}
    <!-- Every check and screenshot, open, so the person can see what passed beside what failed. -->
    <Block id="qa-checked" title="What QA checked" end={report} fold open peek={peek} data-qa-checked="">
      {#snippet meta()}{count ?? ''}{/snippet}
      {@render shotsOrNote()}
      {@render checks()}
    </Block>
  {:else if verdict}
    <!-- The verdict word leads the header, and the checks and screenshots fold with it. -->
    <Block id="qa-panel" title="QA verdict" end={report} fold open={false} peek={peek} data-verdict-panel="">
      {#snippet meta()}{#if view.verdict.verdict !== null}<span class="word" data-verdict={view.verdict.verdict}>{view.verdict.verdict}</span>{#if count !== null}, {count}{/if}{:else}{count ?? ''}{/if}{/snippet}
      {#if view.verdict.verdict !== null}
        {#if view.verdict.reason !== null}<p data-verdict-reason>{view.verdict.reason}</p>{/if}
      {:else}
        <p class="quiet" data-verdict-note>{view.verdict.note}</p>
      {/if}
      {@render checks()}
      {@render shotsOrNote()}
      {#if logHref !== null && view.verdict.runId !== null}
        <a class="link" href={logHref} data-qa-log>See this run's log</a>
      {/if}
    </Block>
  {/if}

  {#if stack || failed != null}
    <!-- One line: the pill, the sentence, and only the buttons that fit the state. -->
    <section class="stack-line" aria-label="App" data-stack-panel>
      <span data-stack-state={view.stack.state}><StatePill state={PILL[view.stack.state]} word={view.stack.word} /></span>
      <b>App</b>
      {#if view.stack.said !== null}
        <span class="sentence">{view.stack.said.text}{#if view.stack.said.command !== null}<code>{view.stack.said.command}</code>{/if}{view.stack.said.tail}</span>
      {/if}
      <span class="row end">
        {#each view.stack.buttons.filter((button) => view.stack.fits.includes(button.action)) as button (button.action)}
          <button type="button" data-stack={button.action} disabled={button.refused !== null || going !== null} aria-busy={going === button.action ? 'true' : undefined} title={button.refused ?? button.note} onclick={() => press(button.action)}>
            {button.label}
          </button>
        {/each}
      </span>
      <!-- With several own commands, which one runs where, in the order Start runs them. -->
      {#if view.stack.apps.length > 1}
        <ul class="quiet full apps" data-stack-apps>
          {#each view.stack.apps as app (app.name)}<li>{app.name}: <code>{app.start}</code></li>{/each}
        </ul>
      {/if}
      {#if going !== null}<p class="quiet full" role="status" data-stack-going>{GOING[going]}</p>{/if}
      {#if said !== ''}<p class="quiet full" role="status" data-stack-said>{said}</p>{/if}
      {#if view.stack.pending}
        <div class="full" data-stack-pending><Skeleton shape="line" width="200px" label="The status command is running." /></div>
      {:else if view.stack.status !== null}
        <!-- The project's own words. Nolzu never knows what the stack is, so nothing here is parsed. -->
        <details class="full">
          <summary>What the Status commands say</summary>
          {#if view.stack.command !== null}<p class="quiet command">{view.stack.command}</p>{/if}
          <pre data-stack-status>{view.stack.status}</pre>
        </details>
      {/if}
    </section>
  {/if}
{/if}

<style>
  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .apps {
    padding-left: 1.2em;
  }

  .command {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  pre {
    max-height: 18em;
    margin: 0;
    padding: var(--space-2) 10px;
    overflow: auto;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink-3);
    white-space: pre-wrap;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  button {
    padding: 5px 11px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  button:disabled {
    color: var(--muted);
  }

  [data-verdict='PASS'] {
    color: var(--green);
  }

  [data-verdict='FAIL'] {
    color: var(--red);
  }

  [data-verdict='BLOCKED'] {
    color: var(--violet);
  }

  p {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.45;
    color: var(--ink);
  }

  .link {
    align-self: flex-start;
    font-size: var(--text-xs);
    color: var(--blue);
  }

  /* The red box of a QA FAIL: the verdict in large red with its word, the reason in ink. The only
     red box in the column, as the question is the only violet one. */
  .failed {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px 22px 20px;
    border-radius: 14px;
    background: var(--red-bg);
    scroll-margin-top: var(--space-4);
  }

  @media (max-width: 700px) {
    .failed {
      padding: var(--space-4);
    }
  }

  .word {
    font-family: var(--font-mono);
    font-weight: 500;
  }

  .verdict-line {
    display: flex;
    align-items: center;
    gap: 18px;
  }

  .big {
    color: var(--red);
    font-size: 46px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.03em;
  }

  .said {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .said b {
    color: var(--ink);
    font-size: var(--text-base);
    font-weight: 600;
  }

  .mono {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
  }

  .why {
    font-size: var(--text-base);
    line-height: 1.5;
  }

  /* Small thumbnails that wrap, each a link to the file on the Files tab. */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 190px));
    gap: 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .shot {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    font-size: var(--text-xs);
    color: var(--ink);
  }

  .frame {
    display: block;
    margin-bottom: 3px;
    overflow: hidden;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
  }

  .shot[data-result='fail'] .frame {
    border-color: var(--red);
    box-shadow: 0 0 0 1px var(--red);
  }

  .shot img {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    object-position: top;
  }

  .shot .name {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
  }

  .of {
    color: var(--muted);
  }

  .of .res {
    margin-left: 4px;
  }

  .no {
    flex: none;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  /* Every result carries its word, in the colour of its state. */
  .res {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--muted);
    white-space: nowrap;
  }

  [data-result='pass'] > .res,
  .res[data-result='pass'] {
    color: var(--green);
  }

  [data-result='fail'] > .res,
  .res[data-result='fail'] {
    color: var(--red);
  }

  .checks {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .checks li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
    padding: 9px 0;
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .checks li:first-child {
    border-top: 0;
  }

  .checks .no {
    width: 14px;
  }

  /* A step keeps room to read: on a narrow screen a long result word wraps under it instead. */
  .step {
    flex: 1 1 14em;
    min-width: 0;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  /* The reason a check failed, under its step, in the run's own words. */
  .reason {
    flex-basis: 100%;
    padding-left: 26px;
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  .plain {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .stack-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  details summary {
    color: var(--ink-2);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  details pre {
    margin-top: var(--space-2);
  }

  .sentence {
    color: var(--ink-2);
    font-size: var(--text-sm);
  }

  .sentence code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .stack-line b {
    color: var(--ink);
    font-weight: 600;
  }

  .end {
    margin-left: auto;
  }

  .full {
    flex-basis: 100%;
  }
</style>
