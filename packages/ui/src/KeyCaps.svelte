<script lang="ts">
  import Kbd from './Kbd.svelte';
  import { capsOf, type Stroke } from './keymap.ts';

  // Every way to press one key, as caps, with "or" between ways and "then" inside a chord. The caps
  // are hidden from screen readers, which hear the words instead, because ⇧ and ↵ are read as symbols.
  // `bare` draws the ways side by side with no word, as the peek row draws J K.
  let { combos, bare = false }: { combos: readonly (readonly Stroke[])[]; bare?: boolean } = $props();

  const drawn = $derived(combos.map((combo) => capsOf(combo)));
</script>

<span class="caps" aria-hidden="true">
  {#each drawn as combo, c (c)}
    {#if c > 0 && !bare}<span class="or">or</span>{/if}
    {#each combo.strokes as stroke, s (s)}
      {#if s > 0}<span class="or">then</span>{/if}
      {#each stroke as cap, k (k)}<Kbd key={cap} />{/each}
    {/each}
  {/each}
</span><span class="hidden">{drawn.map((combo) => combo.said).join(' or ')}</span>

<style>
  .caps {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }

  /* 11.5px is off the scale, so the word takes the nearest step. */
  .or {
    padding: 0 2px;
    color: var(--muted);
    font-size: var(--text-2xs);
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
