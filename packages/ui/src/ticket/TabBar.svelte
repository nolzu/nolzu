<script lang="ts">
  import Skeleton from '../Skeleton.svelte';

  interface Tab {
    id: string;
    label: string;
  }

  // `counts` is what a tab holds, by tab id, such as "3" for Files or "live" for a running Log. A tab
  // with none draws its label alone. The number keys are in the keys help, not on the row. `pending`
  // names the tabs whose count is still on its way, such as Changes while git counts the lines.
  let {
    cardKey,
    tabs,
    current,
    counts = {},
    pending = [],
  }: { cardKey: string; tabs: readonly Tab[]; current: string; counts?: Readonly<Record<string, string>>; pending?: readonly string[] } = $props();

  // Encoded, so a key holding a slash or a bracket still addresses one page, and a key holding
  // markup can never reach the document as markup.
  const base = $derived(`/t/${encodeURIComponent(cardKey)}`);

  // The Changes count is "+60 -8". Split, so the signs take the diff's colours and a screen reader
  // hears words. Any other count, such as "merged", draws as it is.
  const lines = (count: string) => /^\+(\d+) -(\d+)$/.exec(count);
</script>

<nav class="tabs" aria-label="Ticket sections">
  {#each tabs as tab (tab.id)}
    <!-- The space sits between the nodes, so a screen reader hears "Files 3" and not "Files3". -->
    <a href="{base}/{tab.id}" data-tab={tab.id} aria-current={tab.id === current ? 'page' : undefined}>{tab.label} {#if counts[tab.id]}{@const diff = lines(counts[tab.id]!)}<span class="n"
          >{#if diff}<span aria-hidden="true"><span class="plus">+{diff[1]}</span> <span class="minus">-{diff[2]}</span></span> <span class="sr"
              >{diff[1]} {diff[1] === '1' ? 'line' : 'lines'} added, {diff[2]} removed</span
            >{:else}{counts[tab.id]}{/if}</span
        >{:else if pending.includes(tab.id)}<Skeleton shape="pill" label="counting the lines" />{/if}</a>
  {/each}
</nav>

<style>
  /* The tab row. The tabs wrap on a phone, so six of them never push the page
     sideways. The row sits on the head's bottom line, which the current tab's underline covers. */
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  a {
    height: 36px;
    margin-bottom: -1px;
    padding: 0 10px;
    border-bottom: 2px solid transparent;
    box-sizing: border-box;
    color: var(--muted);
    font-size: var(--text-sm);
    line-height: 34px;
    text-decoration: none;
  }

  a[aria-current='page'] {
    color: var(--ink);
    border-bottom-color: var(--ink);
  }

  .n {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  /* The diff view's colours for added and removed lines. Both reach 4.5:1 on the page in either theme. */
  .plus {
    color: var(--green);
  }

  .minus {
    color: var(--red);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
