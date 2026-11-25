<script lang="ts">
  export type ToastKind = 'info' | 'success' | 'warning' | 'error';

  let {
    kind = 'info',
    card = null,
    message,
    fix = null,
    onclose = null,
  }: {
    kind?: ToastKind;
    // The card the toast is about. Its key leads the first line and links to it, as in
    // "PROJ-401 advanced to review".
    card?: { key: string; href: string } | null;
    message: string;
    // What the reader can do about it, such as the setting that fixes a gone model. A toast
    // that only names a problem leaves the reader stuck.
    fix?: string | null;
    onclose?: (() => void) | null;
  } = $props();

  // Where the reader was when the message appeared. A toast never takes focus, so this is the button
  // they pressed or the card they dropped, and closing the toast leads back there instead of to the body.
  // Read again for each message, because the board shows its next refusal in the toast already open.
  let before: HTMLElement | null = null;
  $effect(() => {
    void message;
    before = document.activeElement as HTMLElement | null;
  });

  function close() {
    before?.focus();
    onclose?.();
  }
</script>

<div class="toast" data-kind={kind} role={kind === 'error' ? 'alert' : 'status'}>
  <div class="text">
    <p class="message">{#if card}<a href={card.href}>{card.key}</a>:{/if} {message}</p>
    {#if fix}<p class="fix">{fix}</p>{/if}
  </div>
  {#if onclose}
    <button type="button" aria-label="Close" onclick={close}>×</button>
  {/if}
</div>

<style>
  /* The feedback surface. It places itself, so every page shows toasts in
     the same spot. Pages show one at a time today; a second would sit on top of the first, and a
     stack is the change for the day they do not. */
  .toast {
    position: fixed;
    right: var(--space-3);
    bottom: var(--space-3);
    z-index: 40;
    display: flex;
    align-items: flex-start;
    gap: 9px;
    max-width: 28rem;
    padding: 10px var(--space-3);
    border: 1px solid var(--line);
    border-left: 2px solid;
    border-radius: var(--radius-md);
    background: var(--panel);
    box-shadow: var(--shadow);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  [data-kind='success'] {
    border-left-color: var(--green);
  }

  /* Amber means a run starts, so a warning is neutral. */
  [data-kind='warning'] {
    border-left-color: var(--muted);
  }

  [data-kind='error'] {
    border-left-color: var(--red);
  }

  [data-kind='info'] {
    border-left-color: var(--blue);
  }

  .text {
    flex: 1;
  }

  .message {
    margin: 0;
  }

  a {
    color: var(--ink);
    font-family: var(--font-mono);
  }

  .fix {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  button {
    padding: 0 var(--space-1);
    border: none;
    background: transparent;
    color: var(--muted);
    font: inherit;
    cursor: pointer;
  }

  button:hover {
    color: var(--ink);
  }
</style>
