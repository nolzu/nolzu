<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Kbd from './Kbd.svelte';

  const GLYPHS = { start: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z', resume: 'M4 12 20 4l-6 16-3-7-7-1Z' };

  // `go` is the one amber button. It sits only where a run starts or resumes, because amber means an
  // agent is about to work and spend money (`docs/design-system.md`). `primary` is the one safe main
  // action of a screen, `danger` is an action that deletes, and default and ghost are everything else.
  let {
    variant = 'default',
    size = null,
    key = null,
    glyph = 'start',
    type = 'button',
    class: extra = null,
    children,
    ...rest
  }: HTMLButtonAttributes & {
    variant?: 'default' | 'primary' | 'go' | 'ghost' | 'danger';
    size?: 'small' | 'large' | null;
    // The shortcut, drawn as a key cap after the words.
    key?: string | null;
    // The mark before the words of a go button: a bolt for a run that
    // starts, a send arrow for a session that resumes. Other variants draw none.
    glyph?: 'start' | 'resume' | null;
    children?: Snippet;
  } = $props();
</script>

<!-- A plain button with every attribute the caller set, so aria-disabled, aria-busy, data hooks and
     form attributes reach the element. The go mark and the key cap are hidden from screen readers,
     because the label is the button's name and the key glyphs would be read out as symbols. -->
<button {...rest} {type} class={['btn', variant !== 'default' && variant, size === 'small' && 'sm', size === 'large' && 'lg', extra]}>
  {#if variant === 'go' && glyph !== null}
    <svg class="glyph" data-glyph={glyph} viewBox="0 0 24 24" aria-hidden="true"><path d={GLYPHS[glyph]}></path></svg>
  {/if}
  {@render children?.()}{#if key}<Kbd {key} aria-hidden="true" />{/if}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    box-sizing: border-box;
    height: 30px;
    padding: 0 var(--space-3);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
    /* Every button but go is set at 400, so go is the one heavy label. */
    font-weight: 400;
    white-space: nowrap;
    cursor: pointer;
  }

  .primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-ink);
  }

  .go {
    border-color: transparent;
    background: var(--amber);
    color: var(--on-status);
    font-weight: 600;
  }

  .glyph {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ghost {
    border-color: transparent;
    background: transparent;
    color: var(--ink-2);
  }

  .ghost:hover {
    background: var(--card);
    color: var(--ink);
  }

  /* A ghost toggle that is on, such as Minimize. The edge says it as well as the attribute. */
  .ghost[aria-pressed='true'] {
    border-color: var(--line-2);
    border-style: dashed;
  }

  /* Red words and a red edge on no fill. Never amber, because deleting
     starts no run, and red reaches 4.5:1 as text on every surface. The edge is red at 45%. */
  .danger {
    border-color: color-mix(in oklch, var(--red) 45%, transparent);
    background: transparent;
    color: var(--red);
  }

  /* A 7px radius is off the scale, so buttons take --radius-md. */
  .sm {
    height: 26px;
    padding: 0 9px;
    font-size: var(--text-xs);
  }

  .lg {
    height: 42px;
    padding: 0 18px;
    border-radius: var(--radius-lg);
    font-size: var(--text-base);
  }

  /* Held, after the variants so it wins over each of them. Muted and not faint, because it carries
     words. aria-disabled counts too: a held button that keeps the focus uses it instead of disabled. */
  .btn:disabled,
  .btn[aria-disabled='true'] {
    border-color: var(--line);
    background: var(--panel);
    color: var(--muted);
    cursor: not-allowed;
  }

  .ghost:disabled,
  .ghost[aria-disabled='true'] {
    border-color: transparent;
    background: transparent;
  }

  .btn[aria-busy='true'] {
    cursor: progress;
  }

  .btn > :global(kbd) {
    margin-left: var(--space-1);
  }

  /* On a filled button the cap takes the button's own ink, so it reads on cream and on amber alike. */
  .primary > :global(kbd),
  .go > :global(kbd) {
    border-color: currentColor;
    background: transparent;
    color: inherit;
  }
</style>
