<script lang="ts">
  import { placePopover } from './popover.ts';

  // A "?" next to a label that opens a longer explanation. The box is a native popover: it sits in the
  // top layer, so a table or a panel never clips it, and the browser shuts it on Esc or on a click
  // outside. Help is the short hover tip; this one opens on a press and can hold an example and a link.
  let {
    label,
    text,
    example,
    href,
    linkText = 'More in the docs',
  }: {
    // The button's name, such as "What Plan does".
    label: string;
    text: string;
    example?: string;
    href?: string;
    linkText?: string;
  } = $props();

  const uid = $props.id();
  let open = $state(false);
  let button = $state<HTMLButtonElement>();
  let box = $state<HTMLElement>();
  let up = $state(false);

  // The root's client size, not innerWidth: it leaves out a fixed scrollbar, which would cover the box.
  function place(): void {
    if (!button || !box) return;
    const view = document.documentElement;
    const at = placePopover(button.getBoundingClientRect(), box.getBoundingClientRect(), { width: view.clientWidth, height: view.clientHeight });
    box.style.top = `${at.top}px`;
    box.style.left = `${at.left}px`;
    up = at.up;
  }

  function ontoggle(event: Event): void {
    open = (event as ToggleEvent).newState === 'open';
  }

  // The box is shown before this frame paints, so it is measured and moved with no jump.
  function onbeforetoggle(event: Event): void {
    if ((event as ToggleEvent).newState === 'open') requestAnimationFrame(place);
  }

  // Esc on the card page goes back to the board. While the box is open the press only shuts it, also
  // when focus has left the "?", since the browser shuts the box on any Esc. Caught first on the window,
  // so no page or dialog handler sees it.
  function holdEsc(event: KeyboardEvent): void {
    if (event.key === 'Escape') event.stopPropagation();
  }

  // The box is fixed to the screen, so it follows the "?" when the page scrolls under it.
  $effect(() => {
    if (!open) return;
    addEventListener('keydown', holdEsc, true);
    addEventListener('scroll', place, true);
    addEventListener('resize', place);
    return () => {
      removeEventListener('keydown', holdEsc, true);
      removeEventListener('scroll', place, true);
      removeEventListener('resize', place);
    };
  });
</script>

<!-- The text is the button's description too, so a screen reader reads it with the button, as Help's. -->
<span class="helptip">
  <button bind:this={button} type="button" popovertarget="{uid}-box" aria-label={label} aria-describedby="{uid}-text" aria-expanded={open} aria-controls="{uid}-box">?</button>
  <span bind:this={box} class="box" data-up={up} id="{uid}-box" popover="auto" role="dialog" aria-label={label} {ontoggle} {onbeforetoggle}>
    <span class="text" id="{uid}-text">{text}</span>
    {#if example}<span class="example"><b>Example:</b> {example}</span>{/if}
    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a docs page, not a route of this app -->
    {#if href}<a class="link" {href} target="_blank" rel="noopener noreferrer">{linkText}</a>{/if}
  </span>
</span>

<style>
  .helptip {
    display: inline-flex;
    vertical-align: middle;
  }

  button {
    display: inline-grid;
    place-items: center;
    box-sizing: border-box;
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid var(--line-2);
    border-radius: 50%;
    background: var(--card);
    color: var(--muted);
    font: inherit;
    font-size: var(--text-2xs);
    line-height: 1;
    cursor: help;
  }

  button:hover,
  button:focus-visible,
  button[aria-expanded='true'] {
    color: var(--ink);
    border-color: var(--muted);
  }

  /* The browser centres a popover on the screen; this places it at the "?" instead, from place().
     100% is the screen less a fixed scrollbar, where 100vw would run under it. */
  .box {
    position: fixed;
    inset: auto;
    box-sizing: border-box;
    width: max-content;
    max-width: min(300px, calc(100% - 16px));
    margin: 0;
    padding: 10px var(--space-3);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card-2);
    box-shadow: var(--shadow);
    color: var(--ink-2);
    font-size: var(--text-xs);
    font-weight: 400;
    line-height: 1.5;
    text-align: left;
    white-space: normal;
  }

  .box:popover-open {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .example b {
    font-weight: 600;
    color: var(--ink);
  }

  .link {
    color: var(--blue);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
</style>
