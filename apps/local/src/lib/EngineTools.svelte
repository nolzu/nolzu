<script lang="ts">
  import { ENGINE_NAMES } from '@nolzu/protocol';
  import { Button, Skeleton } from '@nolzu/ui';
  import { copyText } from './clipboard.ts';
  import type { ToolRow } from './engine-profiles.ts';

  // Null while the look runs. `onlook` is Look again; the page owns the look, so a press loads the page
  // data again and nothing here starts a tool.
  let { rows, failed = false, lookedAt = null, onlook }: { rows: readonly ToolRow[] | null; failed?: boolean; lookedAt?: number | null; onlook: () => void } = $props();

  const found = $derived(rows?.filter((row) => row.found).length ?? 0);
  const clock = (ms: number): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

  let copied = $state<string | null>(null);
  const copy = async (command: string): Promise<void> => {
    copied = (await copyText(command)) ? 'Copied.' : 'The browser did not copy it. Select the command and copy it by hand.';
  };
</script>

<section class="tools" aria-labelledby="tools-title">
  <div class="line">
    <h3 id="tools-title">Tools{#if rows !== null}<span class="n">{found} of {rows.length} found</span>{/if}</h3>
    <span class="sp"></span>
    {#if lookedAt !== null && rows !== null}<span class="hint">Looked at <span class="mono">{clock(lookedAt)}</span></span>{/if}
    <Button variant="ghost" size="small" disabled={rows === null && !failed} onclick={onlook}>Look again</Button>
  </div>
  <div class="panel" aria-busy={rows === null && !failed}>
    {#if failed}
      <p class="tl quiet"><span class="wide">The look did not finish. Press Look again.</span></p>
    {:else if rows === null}
      <!-- One row per engine in the same grid as the real ones, so nothing jumps when the look lands. -->
      <Skeleton shape="rows" count={ENGINE_NAMES.length} label="Looking for each tool and its version." />
    {:else}
      {#each rows as row (row.engine)}
        {@const ok = row.found && row.error === null}
        <div class="tl" data-engine={row.engine}>
          <span class="check" class:off={!ok} role="img" aria-label={ok ? 'Found' : row.found ? 'Check failed' : 'Not found'}>
            {#if ok}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>{/if}
          </span>
          <div class="nm">
            <b>{row.label}</b>
            {#if !row.found}<span class="quiet">Not found</span>{:else if row.version !== null}<span class="mono quiet">{row.version}</span>{/if}
          </div>
          {#if row.found}
            <span class="mono quiet where">{row.path ?? row.binary}</span>
            {#if row.error !== null}<pre>{row.error}</pre>{/if}
          {:else if row.command !== null}
            {@const command = row.command}
            <div class="inst">
              <code>{command}</code>
              <Button size="small" variant="ghost" aria-label="Copy the {row.label} install command" onclick={() => copy(command)}
                ><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"></path></svg></Button
              >
            </div>
          {:else}
            <span class="hint">
              <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the tool maker's page, not a route of this app -->
              <a class="link" href={row.install} target="_blank" rel="noopener noreferrer" aria-label="{row.label} install page">Install page</a>
            </span>
          {/if}
          <!-- What this machine can run on the engine, from the wall here. A row built before it carries none. -->
          {#if row.phases}<p class="hint phases" data-phases>{row.phases}</p>{/if}
        </div>
      {/each}
    {/if}
  </div>
  {#if copied !== null}<p class="hint" role="status">{copied}</p>{/if}
</section>

<style>
  .tools {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: var(--space-6);
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .sp {
    flex: 1;
  }

  h3 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  h3 .n {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 400;
    color: var(--muted);
  }

  .panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  /* The row: mark, name and version, place or install line. One column on a narrow screen. */
  .tl {
    display: grid;
    grid-template-columns: 18px minmax(0, 250px) minmax(0, 1fr);
    align-items: center;
    gap: 6px 14px;
    margin: 0;
    padding: 13px 16px;
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .tl:first-child {
    border-top: 0;
  }

  /* Words alone in a row span it, or they wrap one per line in the 18px mark column. */
  .wide {
    grid-column: 1 / -1;
  }

  .check {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--green-bg);
    color: var(--green);
  }

  .check.off {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--line-2);
  }

  svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .nm {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .nm b {
    font-weight: 500;
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .where {
    overflow-wrap: anywhere;
  }

  .quiet,
  .hint {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .inst {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    padding: 0 3px 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg);
  }

  .inst code {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .phases {
    grid-column: 2 / -1;
  }

  pre {
    grid-column: 2 / -1;
    margin: 0;
    padding: var(--space-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .link {
    color: var(--blue);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  @media (max-width: 760px) {
    .tl {
      grid-template-columns: 18px minmax(0, 1fr);
    }

    .tl > :nth-child(n + 3) {
      grid-column: 2;
    }
  }
</style>
