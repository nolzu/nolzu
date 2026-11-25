<script lang="ts">
  import { type CardView, checkWords, ENGINE_LABELS, isEngineName, type RunActivity, type StageView } from '@nolzu/protocol';
  import type { Snippet } from 'svelte';
  // The same three words the Review tab shows, from one place, so the card and the tab cannot drift.
  import { DECISION_WORD } from '../ticket/review.ts';
  import { feedbackLine } from '../ticket/prs.ts';
  import Button from '../Button.svelte';
  import StatePill from '../StatePill.svelte';
  import { answerHref } from './answer.ts';
  import { lockReason } from './drag.ts';
  import { age } from './elapsed.ts';
  import { waitingOnMe } from './filter.ts';
  import { cardPill, liveOf } from './quiet.ts';

  // The clock comes from the board and has no default here. A default is memoised on first read,
  // so a card rendered on its own would show a time that never moves. Without a clock the card
  // shows no elapsed figure at all, which is wrong in a way a reader can see.
  let {
    card,
    now,
    onDragStart = () => {},
    focusable = false,
    onFocus = () => {},
    rounds = true,
    activity = null,
    quietAfterMs,
    dragging = false,
    cardAction = undefined,
    draggable = true,
    onFix = null,
    stage = null,
    tag = null,
  }: {
    card: CardView;
    // The column the card is in, so its pill names the phase it finished. Absent, it says Ready for you.
    stage?: Pick<StageView, 'id' | 'label' | 'role'> | null;
    now?: Date;
    // The last activity of the card's run, from the board stream. Absent on a board that has no
    // stream of a run's output, which then draws no line and never reads Quiet.
    activity?: RunActivity | null;
    quietAfterMs?: number;
    onDragStart?: (key: string) => void;
    // The board's one tab stop. The arrows move it, so Tab reaches the board once and not per card.
    focusable?: boolean;
    onFocus?: (key: string) => void;
    // Review rounds happen on the PR reviews board alone. A Delivery card would always read as
    // having none.
    rounds?: boolean;
    // The board's drag holds this card, so it draws as the ghost where it was.
    dragging?: boolean;
    // The page's own control for this card, drawn under the meta row. A folded card has no meta row and
    // draws none.
    cardAction?: Snippet<[CardView]>;
    // False drops the attribute and refuses every drag start, on a page that cannot move a card.
    draggable?: boolean;
    // Fix it on a QA FAIL. Null where the page cannot run it, such as the web.
    onFix?: ((key: string) => void) | null;
    // A small word beside the key, such as "Question" or "Investigation" on Research. Null draws none.
    tag?: string | null;
  } = $props();

  // A card its run owns cannot be picked up. One value feeds the flag, the disabled state and the
  // title, so what a person reads and what the board enforces cannot drift apart.
  const locked = $derived(lockReason(card));

  // The run's last tool action, and Quiet once it has printed nothing for the set time, so a stuck
  // run never looks busy. Quiet is a neutral state: the amber goes, and the run goes on.
  const live = $derived(liveOf(card, activity, now, quietAfterMs));
  const quiet = $derived(live?.quiet ?? null);

  // QA's FAIL ends its run as complete, so the card reads ready. For a person it is a failed card,
  // with the red pill and QA's reason. data-state keeps the card's own state.
  const qaFailed = $derived(card.state === 'ready' && card.verdict === 'FAIL');
  const reason = $derived(card.state === 'failed' ? card.failureReason : qaFailed ? card.verdictReason : null);
  const answer = $derived(answerHref(card));
  const asks = $derived(answer !== null);

  // The pill words. A running pill holds the run time ("0m 40s"), which keeps the meta
  // row on one line. The card page head reads the same rule, so the two agree.
  const pill = $derived(cardPill(card, live, now, stage));

  // A pull request card back on Incoming after a review round, which a new push does: the round the
  // next review writes. Only with a saved round, because before the first there is nothing to be back from.
  const back = $derived(rounds && card.stage === 'incoming' && card.pull !== null && card.pull.round !== null ? `Back for round ${card.pull.round + 1}` : null);

  // Why a queued card has not started, from the run state the snapshot sends. A snapshot with none
  // means the card gives no reason. A lane in the lane chips' words, which fit in 212px
  // where "waits for the Knowledge lane" does not.
  const waits = $derived.by<string | null>(() => {
    if (card.state !== 'queued') return null;
    if (card.runState === 'queued') return 'waits for a slot';
    if (card.runState === 'waiting_lane' && card.lane !== null) return `${card.lane.charAt(0).toUpperCase()}${card.lane.slice(1)} lane busy`;
    return null;
  });

  // What the card has spent so far, the same figure as its page. It only grows when a run ends, so it
  // shows in every state, and a running card does not read as counting up. Nought draws nothing.
  const cost = $derived(card.totalUsd !== null && Number.isFinite(card.totalUsd) && card.totalUsd > 0 ? card.totalUsd : null);

  // Two decimals turn a third of a cent into 0.00, and a run that cost something is not free.
  // The words are spelled out rather than written with a less than sign, which a reader has to
  // decode and which the markup has to escape.
  const money = (value: number): string => {
    const amount = Math.abs(value);
    if (amount > 0 && amount < 0.005) return `${value < 0 ? 'minus ' : ''}under $0.01`;
    // Rounded through the decimal text, because toFixed rounds the binary double and an exact
    // half cent such as 2.675 then goes down.
    const rounded = Number(`${Math.round(Number(`${amount}e2`))}e-2`);
    return `${value < 0 ? '-' : ''}$${rounded.toFixed(2)}`;
  };
  // The age goes with the line. Before the first tool it would be a time with nothing beside it.
  const since = $derived(live !== null && live.line !== null ? live.since : null);
  // Answer takes the end of a blocked card's row, and why a queued card waits takes the room of a
  // queued one. The model would be cut to a letter or two beside either in 212px, and the card page
  // shows it. The engine goes first, because one model name can run on two engines. An id of no known
  // vendor shows none, as on the peek.
  const vendor = $derived(card.engine?.split('#')[0] ?? '');
  const engine = $derived(isEngineName(vendor) ? ENGINE_LABELS[vendor] : null);
  // Held by a knowledge change that waits for the person, which the pill says. The link goes where it is answered.
  const review = $derived(card.state === 'queued' && card.runState === 'waiting_review');
  // The repository a Learn run reads for the card Learn and then start holds, which the pill names.
  const learns = $derived(card.afterLearn?.repo == null ? null : `learning ${card.afterLearn.repo}`);
  const run = $derived(!asks && !review && waits === null && learns === null && (card.model !== null || card.effort !== null));
  const runTitle = $derived([engine, card.model, card.effort === null ? null : `${card.effort} effort`].filter((part) => part !== null).join(', '));
  const fix = $derived(onFix !== null && qaFailed);
  const costTitle = $derived(
    cost === null ? '' : `Total ${money(cost)}${card.costUsd !== null && Number.isFinite(card.costUsd) ? ` · last run ${money(card.costUsd)}` : ''} (estimated)`,
  );
  const meta = $derived(since !== null || waits !== null || learns !== null || run || cost !== null || asks || review || fix);

  // An epic's tasks, on its In delivery card. A step of the plan not added
  // to Delivery yet counts in the total and has no chip to open, so the gap is said in words.
  const tasks = $derived(card.tasks ?? []);
  const notAdded = $derived(card.delivered === null ? 0 : Math.max(0, card.delivered.total - tasks.length));
  const share = $derived(card.delivered === null || card.delivered.total === 0 ? 0 : Math.round((card.delivered.done / card.delivered.total) * 100));
  const open = $derived(tasks.filter((task) => !task.done));
  const needs = $derived(open.filter(waitingOnMe).length);
  // Counts only, from the snapshot. The comments themselves stay on the card page.
  const feedback = $derived(feedbackLine(card.feedback));

  // What the card says about the head commit. Null draws nothing: with no clock there is nothing
  // to count from, and such a card draws no other time either.
  const HEAD_UNKNOWN = 'head time unknown';
  const head = $derived.by<string | null>(() => {
    const at = card.pull?.headCommittedAt ?? null;
    if (at === null) return card.pull === null ? null : HEAD_UNKNOWN;
    if (now === undefined) return null;
    const old = age(at, now);
    // "head 20m old", short enough to share a row with the author in 212px.
    return old === null ? HEAD_UNKNOWN : `head ${old} old`;
  });

  // A press inside the page's card action. The browser fires dragstart on the card itself, never on
  // the button the press began on, so only the press can tell the card the drag came from there.
  let pressedAction = false;

  // draggable="false" is what actually stops the drag, and three tests hold it there. This is the
  // second gate, for a drag begun some other way, such as an assistive tool that ignores the
  // attribute, and the only gate for a drag begun on the card action.
  function start(event: DragEvent): void {
    if (!draggable || locked !== null || pressedAction) {
      event.preventDefault();
      return;
    }
    onDragStart(card.key);
  }

  // The browser draws the copy under the pointer from this element once the drag starts, after the
  // board's own update. Turning into the ghost a frame later keeps that copy the whole card.
  let lifted = $state(false);
  $effect(() => {
    if (!dragging) return;
    const frame = requestAnimationFrame(() => (lifted = true));
    return () => {
      cancelAnimationFrame(frame);
      lifted = false;
    };
  });
  const ghost = $derived(dragging && lifted);
</script>

{#if card.minimized}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- The board's one focus stop, moved by the arrow keys and peeked at with Enter on the board page. A grid role would say that to a screen reader too; it is a larger change and is named in the task notes. -->
  <article
    class="one-line"
    data-card={card.key}
    data-state={card.state}
    data-minimized="true"
    data-ghost={ghost ? 'true' : undefined}
    role="group"
    aria-label={ghost ? `${card.key} is being moved` : card.key}
    draggable={!draggable ? undefined : locked === null ? 'true' : 'false'}
    aria-disabled={locked === null ? undefined : 'true'}
    data-locked={locked === null ? undefined : 'true'}
    title={locked}
    tabindex={focusable ? 0 : -1}
    onfocus={() => onFocus(card.key)}
    ondragstart={(event) => start(event)}
  >
    <!-- One line still says the state. The dot shows it, and the word is there for a screen reader. -->
    <StatePill state={pill.state} word={pill.word} check={pill.check} hideWord />
    <span class="key">{card.key}</span>
    <a class="title" href="/t/{encodeURIComponent(card.key)}" tabindex="-1" draggable="false">{card.title}</a>
  </article>
{:else}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <!-- The board's one focus stop, moved by the arrow keys and peeked at with Enter on the board page. A grid role would say that to a screen reader too; it is a larger change and is named in the task notes. -->
  <article
    class="card"
    data-card={card.key}
    data-state={card.state}
    data-quiet={quiet === null ? undefined : 'true'}
    data-qa-failed={qaFailed ? 'true' : undefined}
    data-finished={card.finished === true ? 'true' : undefined}
    data-ghost={ghost ? 'true' : undefined}
    role="group"
    aria-label={ghost ? `${card.key} is being moved` : card.key}
    draggable={!draggable ? undefined : locked === null ? 'true' : 'false'}
    aria-disabled={locked === null ? undefined : 'true'}
    data-locked={locked === null ? undefined : 'true'}
    title={locked}
    tabindex={focusable ? 0 : -1}
    onfocus={() => onFocus(card.key)}
    onpointerdown={(event) => (pressedAction = event.target instanceof Element && event.target.closest('[data-card-action]') !== null)}
    ondragstart={(event) => start(event)}
  >
    {#if ghost}
      <!-- Where the card was: the key and the title, and nothing that claims a state. -->
      <header><span class="key">{card.key}</span></header>
      <a class="title" href="/t/{encodeURIComponent(card.key)}" tabindex="-1" draggable="false">{card.title}</a>
    {:else}
      <header>
        <span class="lead"><span class="key">{card.key}</span>{#if tag !== null}<span class="tag" data-card-tag>{tag}</span>{/if}{#if back !== null}<span class="tag" data-back-round>{back}</span>{/if}</span>
        <StatePill state={pill.state} word={pill.word} detail={pill.detail} check={pill.check} detailOnly={pill.state === 'running'} />
      </header>

      <a class="title" href="/t/{encodeURIComponent(card.key)}" tabindex="-1" draggable="false">{card.title}</a>

      <!-- One line, cut at the end where the card is too narrow. The whole line is in the title. -->
      {#if live !== null && live.line !== null}
        <p class="act" data-activity={card.key} title={live.line}>
          <svg class="bolt" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"></path></svg>
          <span>{live.line}</span>
        </p>
      {/if}

      {#if asks}
        <blockquote class="question">{card.question}</blockquote>
      {/if}

      {#if reason !== null}
        <!-- The box wraps and stops after three lines. The whole reason stays in the title. -->
        <p class="reason" title={reason} data-verdict={qaFailed ? 'FAIL' : undefined}><span>{reason}</span></p>
      {/if}

      <!-- The card's pull request, on the PR reviews board or found by PR watch, in two rows: who
           opened it and how old its head is, then the decision and the
           round. Every item says what it is in words, and a field the answer did not carry says that
           rather than drawing nothing. -->
      {#if card.pull !== null}
        <div class="pull" data-pull={card.key}>
          <p class="who">
            <!-- First, because a closed pull request needs no review whatever the rest of the card says.
                 The card stays, so the review written on it can still be read. -->
            {#if card.pull.ended !== undefined}<span class="ended" data-ended={card.pull.ended}>{card.pull.ended === 'merged' ? 'Merged' : 'Closed'}</span>{/if}
            {#if card.pull.draft}<span>Draft</span>{/if}
            <span>{card.pull.author === null ? 'Author unknown' : `By ${card.pull.author}`}</span>
            <!-- Mono for the figure only. The words that say none is known stay in Geist. -->
            {#if head !== null}<span class="r" class:mono={head !== HEAD_UNKNOWN}>{head}</span>{/if}
          </p>
          <p class="review">
            <!-- The dot carries the colour and the word the decision, so neither stands alone. -->
            <span class="decision" data-decision={card.pull.decision}><i aria-hidden="true"></i>{DECISION_WORD[card.pull.decision]}</span>
            <!-- The last round a review run wrote. Before the first, printing 1 would claim a review
                 that never happened. A push since the round is said in the pill. -->
            {#if rounds}<span class="r" class:mono={card.pull.round !== null}>{card.pull.round === null ? 'No review round yet' : `Round ${card.pull.round}`}</span>{/if}
          </p>
        </div>
      {/if}

      {#if meta}
        <p class="meta">
          <!-- First in the row. It counts up on the board's clock until the pill says Quiet. The column
               already names the phase, so the card draws no phase pips. -->
          {#if since !== null}<span class="mono" data-since={card.key}><span class="hidden">last output</span> {since}</span>{/if}
          {#if waits !== null}<span class="cut" title={waits}>{waits}</span>{/if}
          {#if learns !== null}<span class="cut" title={learns}>{learns}</span>{/if}
          <!-- One group, so a narrow card drops the effort whole before it cuts the model. The hidden
               word tells a screen reader what "high" is. Its space sits between the nodes, because
               Svelte trims one at the edge of an element and the reader then hears "higheffort". -->
          {#if run}<span class="run" title={runTitle}
              >{#if engine !== null}<span>{engine}</span>{/if}{#if card.model !== null}<span class="mono">{card.model}</span>{/if}{#if card.effort !== null}<span>{card.effort} <span class="hidden">effort</span></span>{/if}</span
            >{/if}
          <!-- Beside Answer the cost is the one figure that can give way, so the title holds it whole. -->
          {#if cost !== null}<span class="r mono" class:cut={asks} title={costTitle}>{money(cost)}</span>{/if}
          <!-- The answer is written where the composer is, on the card page. A on the selected card goes
               to the same place. The link stays a tab stop, as a button is, because a board
               with no keys of its own has no other way to it. -->
          {#if answer !== null}<a class="answer" href={answer} data-answer={card.key}>Answer</a>{/if}
          {#if review}<a class="answer" href="/knowledge" data-review={card.key}>Review on Knowledge</a>{/if}
          <!-- Amber, because it starts Implement. It asks first through the same confirm as R. Marked as
               the card's action, so a drag begun on it is refused. -->
          {#if fix && onFix !== null}<Button variant="go" size="small" class="fix" data-card-action={card.key} data-fix={card.key} onclick={(event) => {
              event.stopPropagation();
              onFix(card.key);
            }}>Fix it</Button>{/if}
        </p>
      {/if}

      {#if cardAction !== undefined}
        <!-- The page's control, not a second handle: a click in it stays here, so the page never reads it
             as a click on the card, and a drag begun on it is refused. -->
        <!-- The click goes through Svelte's own delegation, so a button's onclick in the snippet runs
             first and only the card and the page above miss it. -->
        <div
          class="action"
          data-card-action={card.key}
          role="presentation"
          onclick={(event) => event.stopPropagation()}
          ondragstart={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {@render cardAction(card)}
        </div>
      {/if}

      <!-- The tasks an epic delivers, on its In delivery card. The words say
           the count, so the green of a finished epic adds to them and never carries the fact alone. -->
      {#if card.delivered !== null}
        {@const { done, total } = card.delivered}
        <div class="progress" class:done={done === total} data-tasks={card.key}>
          <p class="count"><span>{done === total ? `${total} of ${total} done` : `${done} of ${total} tasks done`}</span><span class="mono">{share}%</span></p>
          <div class="bar" role="progressbar" aria-label="Tasks done" aria-valuemin="0" aria-valuemax={total} aria-valuenow={done}><i style:width="{share}%"></i></div>
        </div>
        {#if tasks.length > 0 || notAdded > 0}
          <!-- Each key opens its Delivery card. Out of the tab order like the title: the board is one
               tab stop, and the epic's own page links every task as well. -->
          <ul class="chips" aria-label="Tasks">
            {#each tasks as task (task.key)}
              <li>
                <a class="chip" href="/t/{encodeURIComponent(task.key)}" title="{task.key} {task.title}" tabindex="-1" draggable="false" data-task={task.key} data-done={task.done ? 'true' : undefined}
                  >{#if task.done}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>{/if}{task.key}{#if task.done}<span class="hidden">, done</span>{/if}</a
                >
              </li>
            {/each}
            {#if notAdded > 0}<li><span class="chip words" data-not-added>{notAdded} not added yet</span></li>{/if}
          </ul>
        {/if}
        {#if open.length > 0}
          <p class="open">{open.length} open on Delivery, {needs === 0 ? 'none needs you' : `${needs} ${needs === 1 ? 'needs' : 'need'} you`}</p>
        {/if}
      {/if}

      <!-- The QA verdict of the newest run, among the card's chips. The
           word carries the state, because colour alone says nothing to a reader who cannot tell the
           chips apart. A FAIL is the failed card above, and a BLOCKED question is in its box already. -->
      {#if card.verdict !== null && !qaFailed && !asks}
        <p class="verdict" data-verdict={card.verdict}>
          <span class="word">{card.verdict}</span>
          {#if card.verdictReason !== null}<span class="why" title={card.verdictReason}>{card.verdictReason}</span>{/if}
        </p>
      {/if}
      <!-- The output check of the newest run: a neutral badge, because the card moved on and only the
           files miss a part. It says what is wrong in a few words, the
           whole sentences on hover and to a screen reader, and opens the list on the card page. Out of
           the tab order like the task chips: the board is one tab stop. -->
      {#if card.outputProblems !== undefined && card.outputProblems.length > 0}
        {@const words = checkWords(card.outputProblems)}
        <p class="verdict" data-output-check>
          <a href="/t/{encodeURIComponent(card.key)}/overview#output-check" title={words.full} tabindex="-1" draggable="false"
            ><span class="word">Check</span> <span class="why" aria-hidden="true">{words.short}</span><span class="hidden">{words.full}</span></a
          >
        </p>
      {/if}
      <!-- The review comments on the card's pull requests, in the muted words of the epic's open line. The
           dot is drawn for the eye, and a reader hears the label with a comma in its place. -->
      {#if feedback !== null}
        <p class="open" data-feedback={card.key}><span aria-hidden="true">{feedback.text}</span><span class="hidden">{feedback.label}</span></p>
      {/if}
    {/if}
  </article>
{/if}

<style>
  /* Sizes follow the card states. */
  .card {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 10px 12px 11px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--card);
  }

  /* The four states that ask for a look get a ring in their colour. */
  .card[data-state='running'] {
    border-color: var(--amber);
  }

  .card[data-state='blocked'] {
    border-color: var(--violet);
  }

  .card[data-state='ready'] {
    border-color: var(--green);
  }

  .card[data-state='failed'] {
    border-color: var(--red);
  }

  /* QA failed. The card reads ready, and the ring says what the pill says. */
  .card[data-qa-failed='true'] {
    border-color: var(--red);
  }

  /* An epic with every task done is idle and waits on the person, so it takes the ring of a card ready
     for them. */
  .card[data-finished='true'] {
    border-color: var(--green);
  }

  /* A quiet run keeps going, but nothing says it is working, so the ring goes neutral. */
  .card[data-quiet='true'] {
    border-color: var(--line-2);
  }

  /* Where the card was while the board drags it, after the state rings so it wins over them. Dashed in
     faint, the 3:1 of a mark. Fading it to 0.35 would take the words under 4.5:1, so the
     title goes muted instead. */
  .card[data-ghost='true'],
  .one-line[data-ghost='true'] {
    border-style: dashed;
    border-color: var(--faint);
  }

  [data-ghost='true'] .title {
    color: var(--muted);
  }

  /* A locked card is not faded, because 0.6 would take its text below 4.5:1. The cursor and
     the title say it instead. */
  [data-locked='true'] {
    cursor: not-allowed;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  /* The key and its tag share the left of the header, and the key is cut before the tag is. */
  .lead {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .tag {
    flex: none;
    padding: 0 6px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-2xs);
    line-height: 16px;
    color: var(--ink-2);
  }

  /* A long key, such as a repository and a pull request number, is cut before the pill is. */
  .key {
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--mono-card-key);
    color: var(--muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .title {
    text-decoration: none;
    font-size: var(--text-card-title);
    font-weight: 500;
    line-height: 1.35;
    letter-spacing: -0.005em;
    color: var(--ink);
    /* Two lines, then an ellipsis. A long title must not push the meta row out of sight. */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }

  /* The last tool action. The text is ink-2, which reaches 4.5:1 on the card. */
  .act {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
  }

  .act span {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Amber, because an agent works here. A quiet run shows the same mark in muted. */
  .bolt {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--amber);
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  [data-quiet='true'] .bolt {
    stroke: var(--muted);
  }

  /* One line, in Geist with the figures in mono. Relative, because it holds the hidden words,
     which would otherwise widen the page from an off-screen column. */
  .meta {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--muted);
    white-space: nowrap;
  }

  .meta > * {
    flex: none;
  }

  /* The engine, model and effort give way first, with all three in the title. What does not fit wraps
     onto a second line that the fixed height hides, so a narrow card never reads "sonnet me…". */
  .meta > .run {
    display: flex;
    flex: 0 1 auto;
    flex-wrap: wrap;
    column-gap: 0.35em;
    min-width: 0;
    height: 1lh;
    overflow: hidden;
  }

  .run > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Why a queued card waits, and the cost beside Answer, are cut at the end on a card too narrow for
     them, with the whole text in the title. Neither shares a row with the model. */
  .meta > .cut {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  /* The cost and Answer sit at the end of the row. */
  .r,
  .answer {
    margin-left: auto;
  }

  .r + .answer {
    margin-left: 0;
  }

  .meta > :global(.fix) {
    margin-left: auto;
  }

  /* The count over a 4px bar. The words are ink-2 and the share muted mono; both turn green
     once every task is closed, on top of the words. */
  .progress {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .count {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  .count .mono {
    color: var(--muted);
  }

  .progress.done .count,
  .progress.done .count .mono {
    color: var(--green);
  }

  /* The track is line-2, a mark and not text. The fill is green, the colour of work done. */
  .bar {
    height: 4px;
    border-radius: 999px;
    background: var(--line-2);
    overflow: hidden;
  }

  .bar i {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--green);
  }

  /* Relative, because a done chip holds a hidden word. */
  .chips {
    position: relative;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* An open task is a muted key in a ring, a done one green on its tint with a check. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    box-sizing: border-box;
    height: 18px;
    padding: 0 5px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
    text-decoration: none;
    white-space: nowrap;
  }

  a.chip:hover {
    text-decoration: underline;
  }

  .chip[data-done='true'] {
    border-color: transparent;
    background: var(--green-bg);
    color: var(--green);
  }

  .chip svg {
    width: 10px;
    height: 10px;
    fill: none;
    stroke: currentcolor;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* How many steps are not on Delivery yet is words, so Geist. */
  .chip.words {
    font-family: inherit;
    font-size: var(--text-2xs);
  }

  /* Relative for the hidden label of the review comments line, as on the meta row. */
  .open {
    position: relative;
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  /* Two rows: the author in ink-2, the decision chip on the panel,
     and the head age and the round in mono at the end. A row wraps rather than cuts, because the round
     with no number yet is a long sentence. */
  .pull {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  .who,
  .review {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px var(--space-2);
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  .review {
    font-size: var(--text-2xs);
  }

  .pull .r {
    color: var(--muted);
  }

  .pull .ended {
    font-weight: 500;
    color: var(--ink);
  }

  .decision {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    box-sizing: border-box;
    height: 20px;
    padding: 0 7px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--panel);
    white-space: nowrap;
  }

  /* The dot is a mark, so a decision nobody made yet takes faint, the 3:1 of a mark. */
  .decision i {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--faint);
  }

  [data-decision='APPROVED'] i {
    background: var(--green);
  }

  /* Red. Amber is for an agent at work, not for a person's review. */
  [data-decision='CHANGES_REQUESTED'] i {
    background: var(--red);
  }

  /* The agent's question and the reason a run failed, each in a box on its state's tint. The words
     are ink, which tokens.test.ts holds to 4.5:1 on every tint. 12.5px is off the scale. */
  .question,
  .reason {
    margin: 0;
    padding: var(--space-2) 10px;
    border-radius: var(--radius-md);
    font-size: var(--text-xs);
    line-height: 1.4;
    color: var(--ink);
  }

  .question {
    background: var(--violet-bg);
  }

  .reason {
    background: var(--red-bg);
    overflow-wrap: anywhere;
  }

  /* Clamped on the words and not the box, or the fourth line shows in the box's padding. */
  .reason span {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
  }

  /* The default small button, as a link, because the answer is written on the card
     page. Not violet: the box above says whose question it is, and a filled button would outweigh it. */
  .answer {
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    height: 26px;
    padding: 0 9px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-xs);
    font-weight: 400;
    text-decoration: none;
  }

  .answer:hover {
    background: var(--card-2);
  }

  /* One line, with the whole reason in the title. */
  .verdict {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 2px 0 0;
    font-size: var(--text-2xs);
    color: var(--muted);
    overflow: hidden;
  }

  .verdict .word {
    flex: none;
    padding: 1px 6px;
    border: 1px solid currentcolor;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-weight: 500;
  }

  .verdict a {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    color: inherit;
    text-decoration: none;
  }

  .verdict a:hover .why {
    text-decoration: underline;
  }

  .verdict .why {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--muted);
  }

  /* The chip only. The reason box of a QA FAIL carries the verdict too, and keeps its ink. */
  .verdict[data-verdict='PASS'] {
    color: var(--green);
  }

  .verdict[data-verdict='FAIL'] {
    color: var(--red);
  }

  .verdict[data-verdict='BLOCKED'] {
    color: var(--violet);
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .one-line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--panel);
    white-space: nowrap;
    overflow: hidden;
  }

  .one-line .key {
    flex: none;
    color: var(--muted);
  }

  .one-line .title {
    display: block;
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* The card the arrows reached. Drawn outside the border, so it never reads as a state ring. */
  article:focus-visible {
    outline: 2px solid var(--ink);
    outline-offset: 2px;
  }
</style>
