<script lang="ts">
  import Markdown from '../Markdown.svelte';
  import { KIND_WORDS, LOG_WORDS, type LogRow } from './log.ts';

  // One log row, drawn the same on the Log tab and in the peek sheet, so an event never reads two ways.
  // `compact` is the sheet's form: the time only where the log noted one, the short kind words, one
  // line per row, and a "says" row cut at two lines.
  let { row, compact = false }: { row: LogRow; compact?: boolean } = $props();
  const words = $derived(compact ? KIND_WORDS : LOG_WORDS);
</script>

<li data-kind={row.kind} class:compact class:timed={compact && row.time !== undefined}>
  {#if !compact || row.time !== undefined}<span class="t">{row.time ?? ''}</span>{/if}
  <span class="k">{words[row.kind] ?? row.kind}</span>
  {#if compact}
    <span class="x">{[row.text, row.aside].filter((one) => one !== undefined && one !== '').join(', ')}</span>
  {:else if row.detail !== undefined}
    <details class="x"
      ><summary>{row.subject === undefined ? row.text : `${row.text}  ${row.subject}`}</summary><pre>{row.detail}</pre></details
    >
  {:else if row.kind === 'text'}
    <!-- What the agent says is markdown, so it reads as the agent laid it out. -->
    <div class="x"><Markdown source={row.text} headingsFrom={4} /></div>
  {:else}
    <span class="x">{row.text}</span>
  {/if}
  {#if !compact && row.aside !== undefined}<span class="r">{row.aside}</span>{/if}
</li>

<style>
  li {
    display: grid;
    grid-template-columns: 48px 72px minmax(0, 1fr) auto;
    gap: var(--space-3);
    align-items: baseline;
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  /* A time and a size are figures, and figures are mono. */
  .t,
  .r {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .t {
    text-align: right;
  }

  .k {
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  .x {
    min-width: 0;
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  li[data-kind='text'] {
    padding-block: var(--space-2);
  }

  /* The rendered markdown keeps the row's size, and no margin above the first block or under the last. */
  li[data-kind='text'] .x {
    white-space: normal;
  }

  li[data-kind='text'] .x :global(.markdown) {
    max-width: none;
    font-size: inherit;
  }

  li[data-kind='text'] .x :global(.markdown > :first-child) {
    margin-top: 0;
  }

  li[data-kind='text'] .x :global(.markdown > :last-child) {
    margin-bottom: 0;
  }

  /* A tool, its result, the tokens, the session and a limit are names and figures, and those are mono. */
  li[data-kind='tool'] .x,
  li[data-kind='result'] .x,
  li[data-kind='usage'] .x,
  li[data-kind='session'] .x,
  li[data-kind='limit'] .x {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--muted);
  }

  li[data-kind='tool'] .x {
    color: var(--ink-2);
  }

  summary {
    cursor: pointer;
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  /* The log has a small chevron, not the browser triangle. */
  summary::before {
    content: '›';
    display: inline-block;
    width: 1.2ch;
    margin-right: var(--space-1);
    color: var(--muted);
  }

  details[open] > summary::before {
    transform: rotate(90deg);
  }

  pre {
    margin: var(--space-1) 0 0;
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    white-space: pre-wrap;
  }

  /* The edge marks a row worth a look. A retry resumes the run, so its edge is amber. A limit and a
     refused tool are warnings, and a warning is neutral. */
  li[data-kind='retry'] {
    box-shadow: inset 2px 0 0 var(--amber);
  }

  /* A wait can last minutes, so it is a box of its own and the log does not read as stuck. The box is
     neutral, as a warning is; only the edge is amber. */
  li:not(.compact)[data-kind='retry'] {
    margin-block: 6px;
    padding-block: 9px;
    border-radius: var(--radius-md);
    background: var(--card);
  }

  li[data-kind='limit'],
  li[data-kind='denied'] {
    box-shadow: inset 2px 0 0 var(--muted);
  }

  li[data-kind='failed'] {
    box-shadow: inset 2px 0 0 var(--red);
  }

  li[data-kind='question'] {
    box-shadow: inset 2px 0 0 var(--violet);
  }

  /* The peek sheet: its list sets the mono font and size, and each row keeps to one line. */
  .compact {
    grid-template-columns: 58px minmax(0, 1fr);
    gap: var(--space-2);
    padding: 5px 0;
    border-top: 1px solid var(--line);
    font-size: inherit;
    line-height: inherit;
  }

  .compact:first-child {
    border-top: 0;
  }

  /* The time of day leads where the log noted one. Rows of an older log keep the two columns. */
  .compact.timed {
    grid-template-columns: 58px 58px minmax(0, 1fr);
  }

  .compact .t {
    font-size: inherit;
    text-align: left;
  }

  .compact[data-kind='retry'],
  .compact[data-kind='limit'],
  .compact[data-kind='denied'],
  .compact[data-kind='failed'],
  .compact[data-kind='question'] {
    padding-left: var(--space-2);
  }

  .compact .k {
    font-size: inherit;
  }

  .compact[data-kind] .x {
    overflow: hidden;
    font-family: inherit;
    font-size: inherit;
    color: var(--ink-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* After the rule above, so a "says" row reads as words and keeps two lines. */
  .compact[data-kind='text'] .x {
    display: -webkit-box;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--ink);
    white-space: normal;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }

  .compact[data-kind='text'] {
    padding-block: 5px;
  }
</style>
