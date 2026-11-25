<script lang="ts">
  import type { PullDecision } from '@nolzu/protocol';
  import { ageWord, blockPlace, DECISION_WORD, diffRounds, fixedLine, type ReviewBlock, type RoundBlocks } from './review.ts';

  // The skill wraps a finding at about 100 columns. Shown as written, the lines break twice. A body with
  // a code fence keeps its breaks, because a snippet needs them.
  const flow = (body: string): string => (body.includes('```') ? body : body.replace(/([^\n])\n(?=[^\n])/g, '$1 '));

  // The shapes the page hands over. This package reads only the protocol, so they are spelled out
  // here, the same way the Discussion tab does it.
  interface Round {
    number: number;
    // Where the round file sits under the card folder, as the Files tab names it.
    file?: string;
  }
  interface Reviewer {
    decision: PullDecision | null;
    author: string | null;
    draft: boolean;
  }

  let {
    rounds,
    current,
    blocks,
    problem,
    read = [],
    reviewer,
    head = null,
    filesHref = null,
    oncopy,
  }: {
    rounds: readonly Round[];
    current: number | null;
    blocks: readonly ReviewBlock[];
    problem: string | null;
    // Every round that could be read, oldest first. The shown round is compared with the ones before
    // it, and each one's count goes in the round selector.
    read?: readonly RoundBlocks[];
    reviewer: Reviewer;
    // The head commit the shown round read, short, or null when no review saved one for it.
    head?: string | null;
    filesHref?: string | null;
    // The page puts the block on the clipboard, because this package never touches the browser. It
    // answers with the sentence the copy was refused with, or null once the text is there.
    oncopy: (text: string) => Promise<string | null>;
  } = $props();

  let said = $state('');

  const counts = $derived(new Map(read.map((one) => [one.number, one.blocks.length])));
  // Only against rounds that could be read, and only for a round that could be read itself: a refused
  // round draws no findings, and a comparison would call every earlier finding fixed.
  const earlier = $derived(current === null ? [] : read.filter((one) => one.number < current));
  const diff = $derived(current === null || problem !== null || earlier.length === 0 ? null : diffRounds([...earlier, { number: current, blocks }]));
  const file = $derived(rounds.find((one) => one.number === current)?.file ?? null);

  // The file and line or range as one string, or null on a block that named none. The head and the
  // copy button's name both read it, so the two cannot say different places.
  const where = (block: ReviewBlock): string | null => blockPlace(block);

  const copyLabel = (block: ReviewBlock): string => {
    const place = where(block);
    return `Copy the ${block.label} block${place === null ? '' : ` for ${place}`}`;
  };

  // The decoration and, from a second round on, the round that raised the finding.
  const status = (block: ReviewBlock, index: number): string => {
    const one = diff?.open[index];
    // Praise is not open or closed, so only the round that gave it is worth saying.
    const old = one !== undefined && one.since !== current && block.label === 'praise';
    return [block.decoration, one === undefined || current === null || old ? null : ageWord(one, current)].filter((part) => part !== null).join(' · ');
  };

  // The comment alone: its place is where it goes in the pull request, not part of what it says.
  async function copy(block: ReviewBlock): Promise<void> {
    said = '';
    const refused = await oncopy(block.text);
    const place = where(block);
    said = refused ?? `The ${block.label} comment is on the clipboard. Paste it into the pull request${block.subject === null || place === null ? '' : ` at ${place}`}.`;
  }
</script>

<section class="review">
  <div class="rh">
    <!-- One round needs no selector, the way the tab bar keeps its hint for two tabs and up. -->
    {#if rounds.length > 1}
      <nav class="seg" data-round aria-label="Review rounds">
        {#each rounds as round (round.number)}
          {@const count = counts.get(round.number)}
          <!-- The name says what the figure is. Read as text, "Round 1" and its 4 run together as "Round 14". -->
          <a
            class:on={round.number === current}
            aria-current={round.number === current ? 'page' : undefined}
            aria-label={count === undefined ? undefined : `Round ${round.number}, ${count === 1 ? '1 finding' : `${count} findings`}`}
            href="?round={round.number}">Round {round.number}{#if count !== undefined}<span class="n">{count}</span>{/if}</a
          >
        {/each}
      </nav>
    {/if}
    <p class="state" data-review-state>
      <span class="decision" data-decision={reviewer.decision}>
        {reviewer.decision === null ? 'Review decision unknown' : DECISION_WORD[reviewer.decision]}
      </span>
      {#if reviewer.draft}<span>Draft</span>{/if}
      <span>{reviewer.author === null ? 'Author unknown' : `By ${reviewer.author}`}</span>
      {#if rounds.length > 0}<span>{rounds.length === 1 ? '1 round' : `${rounds.length} rounds`}</span>{/if}
      {#if head !== null}<span class="mono" data-head>head {head}</span>{/if}
    </p>
  </div>

  {#if rounds.length === 0}
    <p class="quiet">No review round yet. A review writes one block per finding into the card folder, and the block is the text you paste into the pull request.</p>
  {:else if problem !== null}
    <!-- The whole round, refused. Half a round would show one finding cut in two as one finding. -->
    <p class="problem" data-problem>{problem}</p>
    <p class="quiet">The file itself is under pr-review on the Files tab, as the review wrote it.</p>
  {:else}
    <section class="panel" aria-label="Round {current} findings">
      {#each blocks as block, index (index)}
        {@const one = diff?.open[index]}
        <article class="fd" data-finding={index}>
          <!-- The label is a word, never a colour alone. -->
          <span class="lb" data-label={block.label}>{block.label}</span>
          <div class="fb">
            <p class="fl">
              <span class="at">{where(block) ?? 'No file named'}</span>
              {#if status(block, index) !== ''}<span class="st" data-change={one === undefined ? undefined : one.since === current ? 'new' : 'open'}>{status(block, index)}</span>{/if}
            </p>
            <!-- Plain text, not markup, so the screen says what the copy button copies. -->
            {#if block.subject !== null}<p class="sj" data-subject>{block.subject}</p>{/if}
            {#if block.body !== ''}<p class="body">{flow(block.body)}</p>{/if}
          </div>
          <!-- The name says which block, because a screen reader reads the buttons as a list and six of
               them called Copy name nothing. -->
          <button type="button" class="copy" data-copy={index} aria-label={copyLabel(block)} onclick={() => copy(block)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"></path></svg>
          </button>
        </article>
      {/each}
      {#if diff !== null && diff.fixed.length > 0}
        <!-- What the author fixed, folded into one line and named on opening. A finding that vanished
             without a word reads as one the review forgot. -->
        <details class="fixed" data-gone>
          <summary>
            <svg class="check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>
            {fixedLine(diff.fixed)}
            <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
          </summary>
          <ol>
            {#each diff.fixed as gone, index (index)}
              <li class="fd" data-gone-finding={index}>
                <span class="lb" data-label={gone.block.label}>{gone.block.label}</span>
                <div class="fb">
                  <p class="fl">
                    <span class="at">{where(gone.block) ?? 'No file named'}</span>
                    <span class="st">fixed in round {gone.fixedIn}</span>
                  </p>
                  <p class="body">{flow(gone.block.body)}</p>
                </div>
              </li>
            {/each}
          </ol>
        </details>
      {/if}
    </section>
    {#if file !== null}
      <p class="quiet">
        Round file <span class="mono">{file}</span>, also on the {#if filesHref !== null}<a class="link" href={filesHref}>Files tab</a>{:else}Files tab{/if}.
      </p>
    {/if}
  {/if}
  <p class="quiet" role="status">{said}</p>
</section>

<style>
  .review {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  p {
    margin: 0;
  }

  .rh {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
  }

  .seg {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .seg a {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-size: var(--text-xs);
    text-decoration: none;
  }

  .seg a.on {
    background: var(--card-2);
    color: var(--ink);
  }

  /* A count is a figure, so mono. */
  .n {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .state {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  /* The word says the decision. The colour repeats it and is never the only signal. */
  .decision {
    font-weight: 500;
    color: var(--ink);
  }

  .decision[data-decision='APPROVED'] {
    color: var(--green);
  }

  .decision[data-decision='CHANGES_REQUESTED'] {
    color: var(--red);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .panel {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .fd {
    display: grid;
    grid-template-columns: 104px minmax(0, 1fr) auto;
    align-items: start;
    gap: 14px;
    padding: var(--space-4) 18px;
    border-top: 1px solid var(--line);
  }

  .fd:first-child {
    border-top: 0;
  }

  /* One neutral chip for every label: the word is the label, and colour here would mean a state. */
  .lb {
    display: inline-flex;
    align-items: center;
    justify-self: start;
    height: 22px;
    padding: 0 var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--card-2);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    font-weight: 500;
  }

  .fb {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .fl {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .at {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .st {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .sj {
    max-width: 72ch;
    font-weight: 600;
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .body {
    max-width: 72ch;
    font-size: var(--text-base);
    line-height: 1.55;
    color: var(--ink);
    white-space: pre-wrap;
    /* A stack trace or a URL a review pasted has no space to break at, and a card that grows wider
       than the screen takes the whole page with it. */
    overflow-wrap: anywhere;
  }

  .copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--ink-2);
  }

  .copy:hover {
    background: var(--card-2);
  }

  svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }

  .fixed {
    border-top: 1px solid var(--line);
  }

  summary {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: var(--space-3) 18px;
    color: var(--ink-2);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  /* The line is a button in effect, so it says it opens. */
  .chev {
    width: 14px;
    height: 14px;
    margin-left: auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }

  .fixed[open] .chev {
    transform: rotate(180deg);
  }

  /* Green means done. The words say it too. */
  .check {
    color: var(--green);
  }

  ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .problem {
    padding: 10px 12px;
    border: 1px solid var(--red);
    border-radius: var(--radius-lg);
    font-size: var(--text-sm);
    color: var(--ink);
  }

  .quiet {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .link {
    color: var(--blue);
  }

  @media (max-width: 640px) {
    .fd {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .fb {
      grid-column: 1 / -1;
      grid-row: 2;
    }
  }
</style>
