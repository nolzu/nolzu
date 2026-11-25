<script lang="ts">
  import { CHECKS, type EngineRow } from './engines.ts';
  import Skeleton from './Skeleton.svelte';

  // Null while the check runs. The wizard and the settings screen both draw this list.
  let { rows }: { rows: readonly EngineRow[] | null } = $props();
</script>

<ul class="engines" aria-busy={rows === null}>
  {#if rows === null}
    {#each CHECKS as check (check.command)}
      <li><span class="name">{check.label}</span> <Skeleton shape="line" width="140px" label="Running {check.command}." /></li>
    {/each}
  {:else}
    {#each rows as row (row.engine)}
      <li data-engine={row.engine} data-tone={row.tone}>
        <span class="name">{row.label}</span>
        <span class="state"><span class="dot" aria-hidden="true"></span>{row.word}</span>
        {#if row.version !== null}<code>{row.version}</code>{/if}
        {#if row.word === 'not found'}<a href={row.install} target="_blank" rel="noopener noreferrer">How to install</a>{/if}
        {#if row.note !== null}<span class="quiet note">{row.note}</span>{/if}
        {#if row.error !== null}<pre>{row.error}</pre>{/if}
      </li>
    {/each}
  {/if}
</ul>

<style>
  .engines {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    list-style: none;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px var(--space-3);
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  li:last-child {
    border-bottom: none;
  }

  .name {
    min-width: 7.5rem;
    color: var(--ink);
    font-weight: 500;
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ink-3);
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--line-2);
  }

  [data-tone='ok'] .dot {
    background: var(--green);
  }

  [data-tone='bad'] .dot {
    background: var(--red);
  }

  code,
  pre {
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    color: var(--ink-3);
  }

  pre {
    flex-basis: 100%;
    margin: 0;
    padding: var(--space-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  a {
    color: var(--blue);
    font-size: var(--text-xs);
  }

  .quiet {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .note {
    flex-basis: 100%;
  }
</style>
