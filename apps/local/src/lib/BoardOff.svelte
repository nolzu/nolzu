<script lang="ts">
  import { resolve } from '$app/paths';
  import { type BoardChoice, choiceLabel } from '@nolzu/protocol';

  // A board, or Research, which is off when both its kinds are.
  let { kind }: { kind: BoardChoice } = $props();
  const label = $derived(choiceLabel(kind));
</script>

<svelte:head><title>{label} · Nolzu</title></svelte:head>

<div class="off">
  <h1>{label}</h1>
  <p>The {label} board is off, so the rail does not show it. Its cards stay as they are until it is on again.</p>
  <p><a href="{resolve('/settings/project')}#boards">Turn it on in Settings, Project</a></p>
</div>

<style>
  /* The board page's own title spacing, so the page does not jump when a board is turned on. */
  .off {
    padding: var(--space-4) 14px 10px;
  }

  h1 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-lg);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  p {
    max-width: 72ch;
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--ink);
  }
</style>
