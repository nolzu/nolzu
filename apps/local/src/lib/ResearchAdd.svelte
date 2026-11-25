<script lang="ts">
  import { resolve } from '$app/paths';
  import { RESEARCH_KIND_LABELS, RESEARCH_KINDS, type ResearchKind } from '@nolzu/protocol';
  import { Button } from '@nolzu/ui';
  import { cardAdded, postCard, researchCard } from './board-page.ts';
  import { toastStack } from './toast-stack.svelte.ts';

  // The add box on top of the Research board: a question or what to
  // investigate, with a kind switch, into the Inbox of its kind. It starts nothing. N and the palette's
  // Add card put the focus in the box, so the page binds `box`.
  let { box = $bindable() }: { box?: HTMLTextAreaElement } = $props();

  let text = $state('');
  let kind = $state<ResearchKind>('questions');
  let adding = $state(false);
  let said = $state('');

  async function add(): Promise<void> {
    if (adding) return;
    if (text.trim() === '') {
      said = `Write the ${RESEARCH_KIND_LABELS[kind].toLowerCase()} first.`;
      return;
    }
    adding = true;
    said = '';
    const made = await postCard(fetch, resolve('/api/cards'), researchCard(text, kind));
    adding = false;
    if (!made.ok) {
      said = made.reason;
      return;
    }
    text = '';
    toastStack.state = cardAdded(toastStack.state, { key: made.key, href: resolve('/t/[key]', { key: encodeURIComponent(made.key) }) }, 'Inbox', made.note);
  }

  function keys(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      void add();
    }
    // Escape leaves the box, so the board keys work again.
    if (event.key === 'Escape') box?.blur();
  }
</script>

<section class="compose" aria-label="New research">
  <label for="research-ask" class="hidden">Question or what to investigate</label>
  <textarea id="research-ask" bind:this={box} rows="2" placeholder="Ask a question or describe what to investigate" bind:value={text} onkeydown={keys}></textarea>
  <div class="r">
    <div class="seg" role="radiogroup" aria-label="Kind">
      {#each RESEARCH_KINDS as one (one)}
        <label><input type="radio" name="research-kind" value={one} bind:group={kind} />{RESEARCH_KIND_LABELS[one]}</label>
      {/each}
    </div>
    <span class="sub">Lands in Inbox. Nothing runs until you drag it to Research.</span>
    <span class="sp"></span>
    <Button variant="primary" key="⌘↵" disabled={adding} aria-busy={adding ? 'true' : undefined} onclick={add}>Add to Inbox</Button>
  </div>
  <p class="said" role="alert">{said}</p>
</section>

<style>
  .compose {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: var(--space-4) var(--space-6) 0;
    padding: 14px 14px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  @media (max-width: 760px) {
    .compose {
      margin: var(--space-3) var(--space-4) 0;
    }
  }

  textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 48px;
    padding: 11px 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-base);
    resize: none;
  }

  .r {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
  }

  .sub {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .sp {
    flex: 1;
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

  .seg label {
    position: relative;
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 10px;
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .seg label:has(input:checked) {
    background: var(--card-2);
    color: var(--ink);
  }

  .seg input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
  }

  .seg label:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }

  .said {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--ink);
  }

  .said:empty {
    display: none;
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
