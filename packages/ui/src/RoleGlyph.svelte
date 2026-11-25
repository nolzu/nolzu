<script lang="ts">
  import type { StageRole } from '@nolzu/protocol';

  const LABELS: Record<StageRole, string> = {
    you: 'You',
    agent: 'Agent',
    auto: 'Auto',
    archive: 'Archive',
  };

  // `startsNothing` marks an agent column that starts no phase. It draws the bolt quiet, and the
  // words say why for a screen reader.
  let { role, startsNothing = false }: { role: StageRole; startsNothing?: boolean } = $props();
</script>

<span class="role" data-role={role} data-starts-nothing={startsNothing}>
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if role === 'you'}
      <circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>
    {:else if role === 'agent'}
      <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"></path>
    {:else if role === 'auto'}
      <circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>
    {:else}
      <rect x="3" y="4" width="18" height="5" rx="1"></rect><path d="M5 9v10h14V9M10 13h4"></path>
    {/if}
  </svg>
  <!-- The word is the glyph's name, because a shape alone is not enough. -->
  <span class="word">{LABELS[role]}{startsNothing ? ', starts nothing yet' : ''}</span>
</span>

<style>
  /* The 22px glyph box. Its line is under 3:1 on purpose: it only frames the glyph, which
     reaches 3:1 itself. It also holds the hidden word, which would otherwise widen the page from an
     off-screen column. */
  .role {
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 22px;
    height: 22px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    color: var(--muted);
  }

  /* Amber only for an agent that starts work. */
  [data-role='agent']:not([data-starts-nothing='true']) {
    border-color: var(--amber-line);
    background: var(--amber-bg);
    color: var(--amber);
  }

  .word {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
