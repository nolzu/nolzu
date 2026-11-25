<script lang="ts">
  // A small "?" that holds an explanation, so a panel can keep only its buttons and status lines in
  // sight. The text is the button's description, so a screen reader reads it with the button.
  // `start` opens the tip to the right, for a "?" near the left edge, where an end aligned tip would
  // run off a narrow screen.
  let { text, label = 'More about this', align = 'end' }: { text: string; label?: string; align?: 'start' | 'end' } = $props();

  const uid = $props.id();
  let open = $state(false);

  // Esc on the card page goes back to the board. While the tip is open the press only shuts it.
  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !open) return;
    open = false;
    event.stopPropagation();
  }
</script>

<!-- The hover sits on the wrapper, so the pointer can move onto the open tip without shutting it. The
     wrapper is no control: the button inside is, and it does all the same by keyboard. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="help" onmouseenter={() => (open = true)} onmouseleave={() => (open = false)}>
  <!-- A click only opens, because a mouse click focuses first and a toggle would shut it again. -->
  <button type="button" aria-label={label} aria-describedby="{uid}-tip" onfocus={() => (open = true)} onblur={() => (open = false)} onclick={() => (open = true)} {onkeydown}>?</button>
  <span class="tip" class:start={align === 'start'} role="tooltip" id="{uid}-tip" hidden={!open}>{text}</span>
</span>

<style>
  .help {
    position: relative;
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
  button:focus-visible {
    color: var(--ink);
    border-color: var(--muted);
  }

  /* Right aligned under the button by default, because most tips sit at the end of a row. */
  .tip {
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    z-index: 10;
    box-sizing: border-box;
    width: max-content;
    max-width: min(240px, calc(100vw - 32px));
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--card-2);
    box-shadow: var(--shadow);
    color: var(--ink-2);
    font-size: var(--text-2xs);
    font-weight: 400;
    line-height: 1.45;
    text-align: left;
    white-space: normal;
  }

  .tip.start {
    right: auto;
    left: 0;
  }

  .tip[hidden] {
    display: none;
  }
</style>
