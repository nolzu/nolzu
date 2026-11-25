<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import { Skeleton } from '@nolzu/ui';
  import { streamed } from './held-answer.svelte.ts';

  let {
    promise,
    scope,
    waiting,
    height,
    shape = 'block',
    count = 3,
    wait,
    children,
  }: {
    // A part the server load returned without awaiting it, so the page drew before git answered.
    promise: Promise<T>;
    // The card key. A new one drops the answer drawn, so it never shows on another card.
    scope: unknown;
    // What a screen reader hears while the answer is on its way.
    waiting: string;
    // The room the answer takes, kept while it is on its way, so nothing below moves when it lands.
    height: string;
    // The skeleton drawn in that room. A block fills it.
    shape?: 'line' | 'block' | 'rows' | 'card' | 'pill';
    // How many rows, for the rows shape.
    count?: number;
    // The page's own grey shapes in place of the one shape, for a part as big as the whole page, so its
    // header stays put and the shapes sit where the columns land.
    wait?: Snippet;
    children: Snippet<[T]>;
  } = $props();

  const part = streamed(
    () => promise,
    () => scope,
  );
</script>

{#if part.current === null}
  <div class="wait" style:min-height={height} aria-busy="true" data-waiting>
    {#if wait}{@render wait()}{:else}<Skeleton {shape} label={waiting} {height} {count} />{/if}
  </div>
{:else if !part.current.ok}
  <p class="failed" role="alert" data-failed>{part.current.message}</p>
{:else}
  {@render children(part.current.value)}
{/if}

<style>
  .failed {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-xs);
  }
</style>
