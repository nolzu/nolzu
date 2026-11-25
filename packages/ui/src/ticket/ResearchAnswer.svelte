<script lang="ts">
  import Button from '../Button.svelte';
  import Markdown from '../Markdown.svelte';
  import Block from './Block.svelte';

  // The answer of a question or the report of an investigation on the card page, on a done row: the
  // file rendered, its first paragraph at the lede size, and the sources as chips.
  // Make a Delivery card is a direct write and starts no run, so it holds its own pending state. A
  // follow-up goes on in the session that answered, which is the phase's thread on the Discussion tab.
  let {
    research,
    fileHref,
    followHref,
    ondeliver,
  }: {
    research: { title: string; file: string; body: string; sources: readonly { at: string; note: string | null }[] };
    fileHref: string;
    followHref: string;
    // Answers with the sentence to show: the card it made, or why it made none.
    ondeliver: () => Promise<string>;
  } = $props();

  let making = $state(false);
  let said = $state('');

  async function deliver(): Promise<void> {
    if (making) return;
    making = true;
    try {
      said = await ondeliver();
    } finally {
      making = false;
    }
  }
</script>

<Block id="answer" title={research.title} end={{ label: `Open ${research.file.split('/').at(-1)}`, href: fileHref }} data-research-answer="">
  <div class="report"><Markdown source={research.body} headingsFrom={3} /></div>
  {#if research.sources.length > 0}
    <div class="src">
      <span>Sources</span>
      {#each research.sources as source, index (index)}<span class="source"><code>{source.at}</code>{#if source.note !== null}<span class="note">{source.note}</span>{/if}</span>{/each}
    </div>
  {/if}
  <div class="acts">
    <Button disabled={making} aria-busy={making ? 'true' : undefined} onclick={deliver}>Make a Delivery card</Button>
    <a class="btn" href={followHref}>Ask a follow-up</a>
  </div>
  <p class="said" role="status">{said}</p>
</Block>

<style>
  /* Markdown sets its own width cap. */
  .report {
    font-size: var(--text-base);
    line-height: 1.6;
    color: var(--ink);
  }

  /* The answer's first paragraph at the lede size, also when a heading comes before it. */
  .report :global(div.markdown > p:first-of-type) {
    font-size: 17px;
    line-height: 1.55;
    letter-spacing: -0.005em;
  }

  .src {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: 12px;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .source {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    padding: 2px 8px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .source code {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .source .note {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 14px;
  }

  /* A link that looks like the plain button beside it. */
  a.btn {
    display: inline-flex;
    align-items: center;
    height: 30px;
    padding: 0 12px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .said {
    margin: 8px 0 0;
    font-size: var(--text-sm);
    color: var(--ink-2);
  }

  .said:empty {
    display: none;
  }
</style>
