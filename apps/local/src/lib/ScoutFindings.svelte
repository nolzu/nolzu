<script lang="ts">
  import { StatePill } from '@nolzu/ui';
  import ScoutMemory from '$lib/ScoutMemory.svelte';
  import type { ScoutFindingRow, ScoutFindingsView } from '$lib/scout-findings.ts';

  // The left pane of the Scout inbox: the findings seen last first, one row
  // each, then the muted ones folded into "Muted (n)". The whole list is worked out by scoutFindingsFor,
  // so this file only draws. A row is a link to the finding's own page, which is the inbox with that row
  // selected; every button is in the right pane, beside what it acts on.
  //
  // The title is the collected line, drawn as text and never put into an attribute: a pasted log is
  // text from a machine nobody vetted, and it can hold a real token.
  let { view, selected = null, href }: { view: ScoutFindingsView; selected?: number | null; href: (id: number) => string } = $props();

  // What follows the source on a row: where a started finding's card sits, or how often it was seen.
  const meta = (row: ScoutFindingRow) => (row.card !== null && row.card.here ? `in ${row.card.board}, ${row.card.stage}` : row.often);
</script>

{#snippet item(row: ScoutFindingRow)}
  <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the route resolve()s this address and hands it in -->
  <a class="frow" class:on={row.id === selected} href={href(row.id)} aria-current={row.id === selected ? 'true' : undefined}>
    <span class="ft" id="finding-{row.id}">{row.title}</span>
    <StatePill state={row.pill.state} word={row.pill.word} detail={row.pill.detail} />
    <span class="fm">{row.source === '' ? meta(row) : `${row.source} · ${meta(row)}`}</span>
    <span class="fw">{row.at}</span>
  </a>
{/snippet}

<section class="flist" id="findings" aria-labelledby="findings-title">
  <div class="fl-h">
    <h2 id="findings-title">Findings <span class="n">{view.rows.length}</span></h2>
    <span class="grow"></span>
    <span class="s">Last seen first</span>
  </div>

  {#if view.rows.length === 0 && view.memory.length > 0}
    <!-- Every finding on this machine is muted, so the line below would say there is none. -->
    <p class="empty">Nothing on the list. What Scout found is muted, and it is under Muted below.</p>
  {:else if view.rows.length === 0 && view.empty}
    <!-- One quiet line where the list would be, with what Scout last checked. -->
    <p class="empty">{view.empty}</p>
  {:else if view.rows.length === 0}
    <p class="empty">No finding yet. Add a source, then press Check now.</p>
  {/if}

  {#if view.rows.length > 0}
    <ul class="frows">
      {#each view.rows as row (row.id)}
        <li>{@render item(row)}</li>
      {/each}
    </ul>
  {/if}

  <ScoutMemory rows={view.memory} {selected} {item} {href} />
</section>

<style>
  .flist {
    display: flex;
    flex: none;
    flex-direction: column;
    box-sizing: border-box;
    width: 460px;
    padding: 14px var(--space-3);
    border-right: 1px solid var(--line);
  }

  .fl-h {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 2px var(--space-3) 10px;
  }

  h2 {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  h2 .n {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 400;
    color: var(--muted);
  }

  .grow {
    flex: 1;
  }

  .s {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  /* 13px for an empty line. */
  .empty {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .frows {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .frow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 5px var(--space-3);
    padding: 10px var(--space-3);
    border-radius: 9px;
    color: inherit;
    text-decoration: none;
  }

  .frow:hover {
    background: var(--panel);
  }

  .frow.on {
    background: var(--card);
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .frow :global(.pill) {
    justify-self: end;
  }

  /* The card key of a started finding is a key, so it is set in mono. */
  .frow :global(.detail) {
    font-family: var(--font-mono);
  }

  .ft {
    overflow: hidden;
    font-size: var(--text-card-title);
    font-weight: 500;
    letter-spacing: -0.005em;
    color: var(--ink);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .fm {
    overflow: hidden;
    font-size: var(--text-xs);
    color: var(--muted);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .fw {
    justify-self: end;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  /* Narrower windows give the right pane the room it needs. */
  @media (max-width: 1180px) {
    .flist {
      width: 40%;
    }
  }

  @media (max-width: 760px) {
    .flist {
      width: auto;
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }
  }
</style>
