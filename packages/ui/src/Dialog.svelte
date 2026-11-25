<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import type { HTMLDialogAttributes } from 'svelte/elements';
  import { closeOnBackdrop } from './backdrop.ts';
  import Button from './Button.svelte';
  import Kbd from './Kbd.svelte';

  let {
    title,
    sub = null,
    held = false,
    wide = false,
    medium = false,
    closer = null,
    onclose,
    children,
    footer,
    ...rest
  }: Omit<HTMLDialogAttributes, 'title' | 'children' | 'onclose' | 'oncancel'> & {
    title: string;
    // One quiet line under the title, such as "This cannot be undone."
    sub?: string | null;
    // Esc and a click on the backdrop wait while this is true, such as while a card is on its way, or
    // the answer would land on a dialog that is gone.
    held?: boolean;
    // As wide as the keyboard help, for a dialog of columns.
    wide?: boolean;
    // As wide as Add card, 640px, for a form with its actions in two columns.
    medium?: boolean;
    // The name of a close button at the right of the title, with the Esc cap beside it, for a dialog
    // with no footer to put Close in.
    closer?: string | null;
    onclose: () => void;
    children: Snippet;
    // The buttons. The first is the main action, and the last one sits at the right edge.
    footer?: Snippet;
  } = $props();

  const uid = $props.id();
  let dialog: HTMLDialogElement;
  // What had focus when the dialog opened. The browser gives focus back on its own, but only while the
  // element is still there, and a mount test has no browser to rely on.
  let opener: HTMLElement | null = null;

  // Open on mount, so a caller puts the dialog on the page only while it is open. Modal, so the
  // browser keeps focus inside and the page behind is inert.
  onMount(() => {
    opener = document.activeElement as HTMLElement | null;
    dialog.showModal();
    // A control that is off cannot take focus, so the first one that is on gets it.
    if (!dialog.contains(document.activeElement)) (dialog.querySelector<HTMLElement>('[autofocus]') ?? dialog.querySelector<HTMLElement>(':is(input, select, textarea, button):not(:disabled), a[href]'))?.focus();
  });

  export function close(): void {
    dialog.close();
  }

  function closed(): void {
    if (opener?.isConnected) opener.focus();
    onclose();
  }

  // The keydown is held as well as the cancel: a browser that sees a second Esc with no other key or
  // click in between closes the dialog through a cancel that cannot be prevented. It is held on the
  // window, because focus can fall to the body while the dialog is open, and that keydown never
  // reaches the dialog.
  const holdEsc = (event: KeyboardEvent) => held && event.key === 'Escape' && event.preventDefault();
</script>

<svelte:window onkeydown={holdEsc} />

<dialog bind:this={dialog} aria-labelledby="{uid}-title" {...rest} class:wide class:medium onclose={closed} oncancel={(event) => held && event.preventDefault()} {@attach closeOnBackdrop(close, () => held)}>
  <div class="head" class:row={closer !== null}>
    <h2 id="{uid}-title">{title}</h2>
    {#if sub}<p class="sub">{sub}</p>{/if}
    {#if closer !== null}
      <Kbd key="Esc" aria-hidden="true" class="esc" />
      <Button variant="ghost" size="small" aria-label={closer} disabled={held} onclick={close} data-closer
        ><svg class="x" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></Button
      >
    {/if}
  </div>
  <div class="body">{@render children()}</div>
  {#if footer}<div class="foot">{@render footer()}</div>{/if}
</dialog>

<style>
  /* Pinned near the top and centred across, so a dialog that grows
     while the person types does not jump. */
  dialog {
    box-sizing: border-box;
    width: min(32rem, calc(100vw - 32px));
    max-height: calc(100dvh - min(84px, 12vh) - var(--space-6));
    margin-top: min(84px, 12vh);
    padding: 0;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-2xl);
    background: var(--card);
    color: var(--ink);
    box-shadow: var(--shadow);
  }

  /* Add card and the keyboard help sit 64px from the top. The other 640px forms (Publish, the QA
     question) follow Add card. */
  dialog.medium {
    width: min(640px, calc(100vw - 32px));
  }

  dialog.wide {
    width: min(1080px, calc(100vw - 32px));
  }

  dialog.medium,
  dialog.wide {
    max-height: calc(100dvh - min(64px, 8vh) - var(--space-6));
    margin-top: min(64px, 8vh);
  }

  /* A click on the dialog's text gives the box itself focus. It is not a control, so it draws no ring,
     and every control inside keeps its own. */
  dialog:focus-visible {
    outline: none;
  }

  dialog::backdrop {
    background: var(--scrim);
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-4) var(--space-5) var(--space-1);
  }

  /* The keyboard help draws its title, the Esc cap and the close button on one row. */
  .head.row {
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: var(--space-4) var(--space-5) 10px;
  }

  .head.row > :global(.esc) {
    margin-left: auto;
  }

  .x {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
  }

  /* 16px is off the scale, so the title takes the nearest step. */
  h2 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .sub {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-sm);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-5) var(--space-4);
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: var(--space-3) var(--space-5);
    border-top: 1px solid var(--line);
    background: var(--panel);
  }

  .foot > :global(:last-child:not(:first-child)) {
    margin-left: auto;
  }

  /* The wide help has 24px at the sides. Last, so it wins over each part's own padding. */
  .wide .head,
  .wide .body,
  .wide .foot {
    padding-inline: var(--space-6);
  }
</style>
