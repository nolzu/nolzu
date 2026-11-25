<script lang="ts">
  import { phaseLabel } from '@nolzu/protocol';
  import { tick } from 'svelte';
  import Button from '../Button.svelte';
  import Markdown from '../Markdown.svelte';
  import Block from './Block.svelte';

  // The gate of the phase that ran last: its review block, the questions marked `blocks: yes` with
  // the forced choice before the next move, and the output check of
  // that run as a badge with its list. The page does the write, because this package
  // never fetches: `onchoose` answers with the sentence it was refused with, or null.
  let {
    gate,
    fileHref = null,
    onchoose = async () => null,
    next = null,
    onstart = () => {},
  }: {
    gate: {
      phase: string;
      file: string | null;
      lines: readonly string[] | null;
      questions: readonly { id: string; question: string; answer: string | null; settled: string | null }[];
      check: { problems: readonly { file: string; problem: string }[]; note: string | null } | null;
    };
    fileHref?: ((path: string) => string) | null;
    // No answer takes the default.
    onchoose?: (id: string, answer?: string) => Promise<string | null>;
    // The column the next move starts, such as Plan, while the card can move there. The answers start
    // nothing: that column's run reads them, so once all are settled the block says so and offers it.
    next?: string | null;
    onstart?: () => void;
  } = $props();

  const problems = $derived(gate.check?.problems ?? []);
  const name = $derived(gate.file?.split('/').at(-1) ?? null);
  // Only a gate with a question still open needs the person, so only that one gets a box and stays
  // open. Once every question is settled it folds to its header, with the first review line as preview.
  const open = $derived(gate.questions.some((one) => one.settled === null));
  const peek = $derived(gate.lines?.map((line) => line.replace(/^[#>*\-\s]+/, '').trim()).find((line) => line !== '') ?? null);

  // The question whose answer field is open, its draft, the press that is out and the last refusal.
  let writing = $state<string | null>(null);
  let draft = $state('');
  let busy = $state<string | null>(null);
  let refused = $state<Record<string, string>>({});

  // Settling the last question folds the block and hides the button just pressed, so focus goes to
  // the start of the next column, or to the fold button, and not back to the top of the page.
  let box = $state<HTMLElement | null>(null);
  let pressed = false;
  $effect(() => {
    if (open || !pressed) return;
    pressed = false;
    (box?.querySelector<HTMLElement>('[data-gate-start]') ?? box?.querySelector<HTMLElement>('[aria-controls="gate-body"]'))?.focus();
  });

  // The board card's Check chip links here with #output-check. The block and the list open, so the
  // link lands on the problems and not on a folded header. Once per arrival: the hash stays for the
  // whole visit, and a reload of the gate must not open a list the person folded again.
  let unfold = $state(false);
  let checkOpen = $state(false);
  let check = $state<HTMLElement | null>(null);
  let revealed = false;
  function reveal(): void {
    if (revealed || problems.length === 0 || window.location.hash !== '#output-check') return;
    revealed = true;
    unfold = true;
    checkOpen = true;
    void tick().then(() => check?.scrollIntoView({ block: 'center' }));
  }
  // Read here so problems that arrive after the first draw still open the list once.
  $effect(() => {
    void problems.length;
    reveal();
  });
  // A chip link while the card page is already open changes only the hash.
  $effect(() => {
    const again = (): void => {
      revealed = false;
      reveal();
    };
    window.addEventListener('hashchange', again);
    return () => window.removeEventListener('hashchange', again);
  });

  function write(id: string): void {
    writing = id;
    draft = '';
  }

  async function choose(id: string, answer?: string): Promise<void> {
    if (busy !== null) return;
    busy = id;
    const said = await onchoose(id, answer);
    busy = null;
    refused = { ...refused, [id]: said ?? '' };
    pressed = said === null;
    if (said === null && writing === id) {
      writing = null;
      draft = '';
    }
  }
</script>

<div class="gate" class:panel={open} bind:this={box}>
<Block id="gate" title="Before you approve" end={gate.file !== null && fileHref !== null ? { label: `Open ${name}`, href: fileHref(gate.file) } : null} fold={!open} open={open || unfold} {peek} data-gate="">
  {#snippet meta()}from {phaseLabel(gate.phase)}{/snippet}

  {#if gate.lines !== null}
    <div class="block"><Markdown source={gate.lines.join('\n')} headingsFrom={3} /></div>
  {:else if gate.file !== null}
    <!-- No reason given: a file from before the format has none, and a new one that left it out is in
         the check below. -->
    <p class="quiet">{name} has no review block.</p>
  {/if}

  {#each gate.questions as one (one.id)}
    <div class="choice" data-choice={one.id} data-settled={one.settled === null ? undefined : 'true'}>
      <p class="ask"><code>{one.id}</code> {one.question}</p>
      {#if one.settled !== null}
        <p class="quiet">Settled, the next phase reads it: {one.settled}</p>
      {:else}
        <p class="quiet">The next move waits on this choice. Default: {one.answer ?? 'none given, so write an answer'}.</p>
        {#if writing === one.id}
          <label class="hidden" for="choice-{one.id}">Your answer to {one.id}</label>
          <textarea id="choice-{one.id}" bind:value={draft} placeholder="The answer the next phase builds on"></textarea>
          <div class="row">
            <Button variant="primary" size="small" data-send-choice aria-busy={busy === one.id ? 'true' : undefined} onclick={() => choose(one.id, draft)}>Save the answer</Button>
            <Button variant="ghost" size="small" onclick={() => (writing = null)}>Cancel</Button>
          </div>
        {:else}
          <div class="row">
            {#if one.answer !== null}
              <Button variant="primary" size="small" data-take-default aria-busy={busy === one.id ? 'true' : undefined} onclick={() => choose(one.id)}>Take the default</Button>
            {/if}
            <Button size="small" data-write-choice onclick={() => write(one.id)}>Answer it</Button>
          </div>
        {/if}
        <p class="quiet" role="status">{refused[one.id] ?? ''}</p>
      {/if}
    </div>
  {/each}

  {#if problems.length > 0}
    <details class="check" id="output-check" data-output-check bind:open={checkOpen} bind:this={check}>
      <summary>
        <span class="badge">Check</span>
        {problems.length === 1 ? '1 part' : `${problems.length} parts`} of what {phaseLabel(gate.phase)} wrote {problems.length === 1 ? 'is' : 'are'} not in the shape its skill asks for
      </summary>
      <ul>
        {#each problems as one, at (at)}<li><code>{one.file}</code> {one.problem}</li>{/each}
      </ul>
      {#if gate.check?.note != null}<p class="quiet">{gate.check.note}</p>{/if}
    </details>
  {/if}
</Block>
{#if !open && gate.questions.length > 0 && next !== null}
  <div class="onward">
    <p class="quiet">All answered. {next} gets your answers when you move the card.</p>
    <Button variant="go" size="small" data-gate-start onclick={onstart}>Start {next}</Button>
  </div>
{/if}
</div>

<style>
  /* The box of a gate that waits on an answer. */
  .panel {
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .onward {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .quiet:empty {
    display: none;
  }

  .block :global(div.markdown) {
    font-size: var(--text-sm);
  }

  /* One question per box, as the answer composer draws a question. */
  .choice {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: var(--space-2) 0 0;
    border-top: 1px solid var(--line);
  }

  .ask {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  textarea {
    min-height: 64px;
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
    resize: vertical;
  }

  /* A warning is neutral, as the read-only box is: the card moved on. */
  .check {
    padding: var(--space-2) 0 0;
    border-top: 1px solid var(--line);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  .check summary {
    cursor: pointer;
  }

  .badge {
    margin-right: 6px;
    padding: 1px 6px;
    border: 1px solid currentcolor;
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-family: var(--font-mono);
    font-weight: 500;
  }

  .check ul {
    margin: var(--space-2) 0;
    padding-left: 18px;
  }

  .check li {
    margin: 2px 0;
    overflow-wrap: anywhere;
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
