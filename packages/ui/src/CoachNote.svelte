<script lang="ts">
  import type { Snippet } from 'svelte';
  import Button from './Button.svelte';

  // A note that explains one thing once. `seen` is the list of notes the person closed, as the
  // `seenNotes` setting stores it, so a note closed once never shows again. Got it hides the note at
  // once and hands its name to the page, which stores it, because this package never fetches.
  let {
    note,
    seen,
    title,
    ondismiss,
    hint,
    children,
  }: {
    note: string;
    seen: readonly string[];
    title: string;
    ondismiss: (note: string) => void;
    // The line beside Got it, such as the key that does the same as the mouse.
    hint?: Snippet;
    children?: Snippet;
  } = $props();

  const uid = $props.id();
  // By name, so the same note on the page draws when it is handed a note not closed yet.
  let closed = $state<string | null>(null);

  function dismiss(): void {
    closed = note;
    ondismiss(note);
  }
</script>

{#if closed !== note && !seen.includes(note)}
  <div class="coach" role="note" aria-labelledby="{uid}-title">
    <b class="title" id="{uid}-title">{title}</b>
    {@render children?.()}
    <div class="foot">
      <Button size="small" class="dismiss" data-dismiss-note={note} onclick={dismiss}>Got it</Button>
      {#if hint}<span class="hint">{@render hint()}</span>{/if}
    </div>
  </div>
{/if}

<style>
  /* Cream and never amber: the note explains a run and starts none. Every word is accent-ink, held to
     4.5:1 on accent in tokens.test.ts. No contrast test measures faded text, so the second paragraph
     is not faded. */
  .coach {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    box-sizing: border-box;
    max-width: 360px;
    padding: var(--space-4) 18px;
    border-radius: var(--radius-2xl);
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: var(--shadow);
  }

  /* A note beside a column must not stand over an open dialog, such as the Learn gate that Add and
     start can open, so it goes while any dialog is open. */
  :global(body:has(dialog[open])) .coach {
    display: none;
  }

  .title {
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .coach :global(p) {
    margin: 0;
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  /* The hint wraps in its own column beside Got it, and never drops under the button. */
  .foot {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: 2px;
  }

  /* An outline in the note's own ink. Three classes, so it wins over the button's two. */
  .coach :global(.btn.dismiss) {
    border-color: currentColor;
    background: transparent;
    color: inherit;
  }

  .hint {
    min-width: 0;
    font-size: var(--text-xs);
  }

  /* A link keeps the note's ink, the one color held to 4.5:1 on accent, and its underline. */
  .coach :global(a) {
    color: inherit;
  }

  .coach :global(kbd) {
    border-color: currentColor;
    background: transparent;
    color: inherit;
  }

  /* The page's focus ring is the accent, which is this note's own fill and would not show. */
  .coach :global(:focus-visible) {
    outline-color: var(--accent-ink);
  }
</style>
