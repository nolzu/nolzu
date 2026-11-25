<script lang="ts">
  import { phaseLabel } from '@nolzu/protocol';
  import Button from '../Button.svelte';
  import OptionButtons from '../OptionButtons.svelte';
  import StatePill from '../StatePill.svelte';
  import Chip from '../Chip.svelte';
  import { askedLine, pickOption, questionParts } from '../board/answer.ts';
  import { startsCommand } from '../board/drop.ts';

  // The page does the write, because this package never fetches. It answers with the sentence the
  // answer was refused with, or null once the run is queued.
  let {
    question,
    sessionId,
    onanswer,
    options = [],
    phase = null,
    engine = null,
    model = null,
    effort = null,
    laterHref = null,
    since = null,
  }: {
    question: string;
    sessionId: string | null;
    onanswer: (text: string) => Promise<string | null>;
    // The answers the agent offered. A press fills the field below and sends nothing.
    options?: readonly { label: string; means?: string | null }[];
    // The phase that asked, and the engine profile, model and effort it ran on, for the chip and the
    // resume line. The answer resumes that session on that profile.
    phase?: string | null;
    engine?: string | null;
    model?: string | null;
    effort?: string | null;
    // Where Answer later goes. The card keeps waiting, on its board and on Now.
    laterHref?: string | null;
    // When the card started to wait, off the Now snapshot. Null on a board that is off, where the line
    // is left out.
    since?: string | null;
  } = $props();

  const parts = $derived(questionParts(question));
  // The waiting time counts up while the page is open, a minute at a time.
  let clock = $state(new Date());
  $effect(() => {
    if (since === null) return;
    clock = new Date();
    const timer = setInterval(() => (clock = new Date()), 30_000);
    return () => clearInterval(timer);
  });
  const asked = $derived(since === null ? null : askedLine(since, clock));

  let draft = $state('');
  // True from the press on. A send that was taken stays busy: the page drops the composer when the
  // board says the card is queued, and a button that went free earlier could send the answer twice.
  let sending = $state(false);
  let status = $state('');

  const held = $derived(sending || draft.trim() === '');
  const asker = $derived(phase === null ? 'The agent' : phaseLabel(phase));
  // Only a line that is whole. A run that reported no model or effort leaves the command out.
  const command = $derived(engine !== null && model !== null && effort !== null ? startsCommand({ engine, model, effort }) : null);

  // A press keeps what the person typed, behind the label.
  const pick = (label: string): void => void (draft = pickOption(draft, options, label));

  async function send(): Promise<void> {
    if (held) return;
    sending = true;
    status = '';
    const refused = await onanswer(draft);
    if (refused === null) {
      status = 'Sent. Waiting for the board to queue the run.';
      return;
    }
    sending = false;
    status = refused;
  }

  // Cmd Enter sends from the field, as the key cap on the button says.
  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void send();
    }
  }
</script>

<!-- The question box of a blocked card, with the answer in it. The id is where the board's
     Answer link lands. -->
<section class="ask" id="asks" aria-labelledby="asks-question">
  <div class="qh">
    <StatePill state="blocked" word="{asker} asks you" />
    {#if asked !== null}<span class="mono meta" data-asked>{asked}</span>{/if}
  </div>
  <p class="question" id="asks-question">{parts.lead}</p>
  <!-- What the run wrote under its question, and the files it named. Nothing when it wrote none. -->
  {#if parts.body.length > 0}
    <div class="ctx">
      {#each parts.body as paragraph, at (at)}
        <p>{#each paragraph.split('`') as part, index (index)}{#if index % 2 === 1}<code>{part}</code>{:else}{part}{/if}{/each}</p>
      {/each}
      {#if parts.files.length > 0}
        <div class="files">{#each parts.files as file (file)}<Chip mono>{file}</Chip>{/each}</div>
      {/if}
    </div>
  {/if}
  <!-- The answer sits in the same violet box as the question: one block that needs you. -->
  <div class="answer">
    <h2 class="title" id="asks-answer">Your answer</h2>
    <OptionButtons {options} answer={draft} onpick={pick} />
    <label class="label" for="answer">{options.length > 0 ? 'Or write your own answer' : 'Write your answer'}</label>
    <textarea id="answer" rows="3" bind:value={draft} {onkeydown} placeholder="What the agent needs to go on"></textarea>
    <div class="row">
      <!-- Go when the answer resumes the session as a new run. With no session the send only fails the
           card, so nothing starts and the button is primary. -->
      {#if sessionId === null}
        <Button variant="primary" size="large" data-send-answer aria-disabled={held ? 'true' : undefined} aria-busy={sending ? 'true' : undefined} onclick={send}>Send answer</Button>
      {:else}
        <Button variant="go" glyph="resume" size="large" key="⌘↵" data-send-answer aria-disabled={held ? 'true' : undefined} aria-busy={sending ? 'true' : undefined} onclick={send}>Send and resume</Button>
      {/if}
      {#if laterHref !== null}<a class="later" href={laterHref}>Answer later</a>{/if}
      <p class="quiet" role="status">{status}</p>
    </div>
    {#if sessionId === null}
      <p class="quiet">This run has no session, so it cannot go on. Sending fails the card with the reason, and the card can then be moved back.</p>
    {:else}
      <!-- Words in the sans face, the session and the command in mono. No estimate: a resumed run is left
           out of the measured runs, so there is none to show. -->
      <p class="quiet" data-resume>
        Resumes the {asker} session <span class="mono">{sessionId.slice(0, 8)}</span>. {#if command !== null}It runs on <span class="mono">{command}</span>.{/if}
      </p>
    {/if}
  </div>
</section>

<style>
  /* Violet is the blocked colour on the board, so the question reads as the same thing here. Its words
     are ink: muted on a tint is not readable on every surface. */
  .ask {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
    padding: 20px 24px 22px;
    border-radius: 14px;
    background: var(--violet-bg);
    /* A cold load of #asks lands with room above the box, not flush to the edge. */
    scroll-margin-top: var(--space-4);
  }

  .qh {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  /* Ink-2, not muted: muted on the violet tint is not readable on every surface. */
  .meta {
    color: var(--ink-2);
    font-size: var(--mono-2xs);
  }

  .ctx {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    max-width: 68ch;
    color: var(--ink-2);
    font-size: var(--text-base);
    line-height: 1.55;
  }

  .ctx p {
    margin: 0;
    white-space: pre-line;
  }

  .ctx code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  /* The lede size, not 26px: an agent's question is often a few sentences long. 53ch at
     18px ends where the 68ch paragraph under it ends. */
  .question {
    max-width: 53ch;
    margin: 0;
    color: var(--ink);
    font-size: var(--text-lg);
    font-weight: 600;
    line-height: 1.4;
    letter-spacing: -0.01em;
    overflow-wrap: anywhere;
  }

  /* Full width in the box, which lines its other parts up at the start. */
  .answer {
    display: flex;
    flex-direction: column;
    align-self: stretch;
    gap: var(--space-3);
  }

  .title {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .label {
    margin-top: var(--space-1);
    color: var(--ink-2);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  textarea {
    padding: var(--space-3) 14px;
    border: 1px solid var(--line-2);
    border-radius: 10px;
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-base);
    resize: vertical;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  /* Plain, as a ghost button: it leaves the card waiting and starts nothing. */
  .later {
    display: inline-flex;
    align-items: center;
    height: 30px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-md);
    color: var(--ink);
    font-size: var(--text-sm);
    text-decoration: none;
  }

  .later:hover {
    background: var(--panel);
  }

  /* Ink-2, as the meta beside the chip: these lines sit on the violet tint too. */
  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
  }
</style>
