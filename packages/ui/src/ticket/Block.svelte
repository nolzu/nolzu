<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';

  // One block of the Overview's left column, with the header every block shares: the title, a muted
  // meta and one plain link at the end. A block that folds puts a chevron in front of the title, which
  // is the button, and shows a one line preview while it is folded. The fold is page state only: each
  // visit starts from `open` as the page hands it.
  let {
    id,
    title,
    meta,
    end = null,
    fold = false,
    open = $bindable(true),
    peek = null,
    children,
    ...rest
  }: {
    id: string;
    title: string;
    meta?: Snippet;
    // A link, or a button when the end does a thing on the page. `attrs` carries the test hooks.
    end?: { label: string; href?: string; onclick?: () => void; attrs?: Record<string, string> } | null;
    fold?: boolean;
    open?: boolean;
    // A list is a set of steps, each said as a sentence: joined with commas, a step that ends in a full
    // stop read as "module., Test".
    peek?: string | readonly string[] | null;
    children: Snippet;
  } & Omit<HTMLAttributes<HTMLElement>, 'id' | 'title' | 'children'> = $props();

  const shut = $derived(fold && !open);
  const line = $derived(typeof peek === 'string' || peek === null ? peek : peek.map((one) => one.trim()).filter((one) => one !== '').map((one) => (/[.!?]$/.test(one) ? one : `${one}.`)).join(' '));
</script>

<section class="blk" aria-labelledby={id} {...rest}>
  <div class="bh">
    <h2 class="title" id={id}>
      {#if fold}
        <button type="button" class="toggle" aria-expanded={open} aria-controls="{id}-body" onclick={() => (open = !open)}>
          <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>{title}
        </button>
      {:else}
        {title}
      {/if}
    </h2>
    {#if meta}<span class="meta">{@render meta()}</span>{/if}
    {#if end !== null}
      {#if end.href !== undefined}
        <a class="plainlink end" href={end.href} {...end.attrs}>{end.label}</a>
      {:else}
        <button type="button" class="plainlink end" onclick={end.onclick} {...end.attrs}>{end.label}</button>
      {/if}
    {/if}
    {#if shut && line !== null && line !== ''}<p class="peek">{line}</p>{/if}
  </div>
  <div class="body" class:folds={fold} id="{id}-body" hidden={shut}>
    {@render children()}
  </div>
</section>

<style>
  .blk {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  .bh {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }

  .title {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .toggle {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .toggle:focus-visible {
    border-radius: var(--radius-sm);
    outline: 2px solid var(--blue);
    outline-offset: 2px;
  }

  .chev {
    flex: none;
    align-self: center;
    width: 12px;
    height: 12px;
    fill: none;
    stroke: var(--muted);
    stroke-width: 2.2;
    transition: transform 0.12s;
  }

  .toggle[aria-expanded='true'] .chev {
    transform: rotate(90deg);
  }

  .meta {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  /* A plain ink link: no colour, an underline on hover. */
  .plainlink {
    margin-left: auto;
    padding: 0;
    border: 0;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
    text-decoration: none;
    cursor: pointer;
  }

  .plainlink:hover,
  .plainlink:focus-visible {
    text-decoration: underline;
  }

  /* The preview sits on its own line under the title, cut to one line. */
  .peek {
    flex-basis: 100%;
    min-width: 0;
    margin: 0;
    padding-left: 20px;
    overflow: hidden;
    color: var(--muted);
    font-size: var(--text-xs);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }

  /* The body of a block that folds lines up with its title, past the chevron. */
  .body.folds {
    padding-left: 20px;
  }

  .body[hidden] {
    display: none;
  }
</style>
