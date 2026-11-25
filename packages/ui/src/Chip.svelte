<script lang="ts">
  import type { Snippet } from 'svelte';

  // `mono` is for evidence: a path, a branch, a model. Words a person reads stay in the sans face.
  let { mono = false, children }: { mono?: boolean; children: Snippet } = $props();
</script>

<span class="chip" class:mono>{@render children()}</span>

<style>
  /* The drawn chip is 11.5px, which the scale does not have. `docs/design-system.md` sets chips at 11px. */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    box-sizing: border-box;
    height: 21px;
    padding: 0 7px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--ink-2);
    font-size: var(--text-2xs);
    white-space: nowrap;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    letter-spacing: -0.01em;
  }
</style>
