<script lang="ts">
  // Types only, so nothing that reads the database reaches the browser.
  import type { Exporter, ExporterAnswer, ExporterForm } from './timesheet-export.ts';

  // The Export button and the time tracker connections, under the timesheet grid. Drawn only on a
  // plan whose display document carries the export feature. The route's actions ask for it again.
  //
  // `action` builds a form address that keeps the week and the day on screen, because a plain post
  // renders the page again at that address. `markHref` is the address that shows another tracker's
  // marks on the grid. Both come in from the route, because resolve() only works there.
  let {
    exporters,
    forms,
    shown = null,
    current = false,
    action,
    markHref,
    exported = null,
    connection = null,
  }: {
    exporters: Exporter[];
    forms: readonly ExporterForm[];
    // The destination the grid's marks are for.
    shown?: string | null;
    // The week on screen holds today. The button says "this week" only then, and today goes with the
    // minutes it has so far.
    current?: boolean;
    action: (name: string) => string;
    markHref: (destination: string) => string;
    // What the last press of Export said, one line per tracker.
    exported?: string[] | null;
    // What the last save or remove of a connection answered.
    connection?: ExporterAnswer | null;
  } = $props();

  const saved = (destination: string) => exporters.find((one) => one.destination === destination);
  const names = $derived(exporters.map((one) => one.label).join(', '));
  const others = $derived(exporters.filter((one) => one.destination !== shown));

  // One line per thing a person did to a connection, because each leaves the panel in another state.
  const SAID: Record<string, string> = {
    save: 'Saved. The next export uses it.',
    remove: 'Removed, with its token. Entries that went before stay marked, so connecting again does not send them twice.',
  };
  const answerFor = (destination: string) => (connection?.destination === destination ? connection : null);
</script>

<div class="export">
  {#if exporters.length > 0}
    <!-- A plain post and no use:enhance: the page renders again with the lines below and the marks the
         export wrote, and the fragment brings this panel back into view. Two quick presses post once,
         because a second export to one tracker waits for the first and then finds its rows. -->
    <form method="POST" action={action('export')} class="bar">
      <button type="submit">{current ? 'Export this week' : 'Export the week'}</button>
      <span class="quiet"
        >Posts the week on screen to {names}. An entry that went before is never posted again.{#if current}
          Today goes with the minutes it has now, and minutes added to it later are not sent.{/if}</span
      >
    </form>
  {/if}

  {#if exported !== null}
    <ul class="said" role="status">
      {#each exported as line, index (index)}
        <li data-exported>{line}</li>
      {/each}
    </ul>
  {/if}

  {#if others.length > 0}
    <p class="quiet wide marks">
      {#each others as one (one.destination)}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the route resolve()s this href and hands it in -->
        <a href={markHref(one.destination)}>Show the {one.label} marks</a>
      {/each}
    </p>
  {/if}

  <details open={exporters.length === 0 || connection !== null}>
    <summary>Time tracker connections</summary>
    <p class="quiet wide">
      Each token goes into this machine's OS keychain, under the service name nolzu. It never reaches the database, a log or your hub.
    </p>
    {#each forms as one (one.destination)}
      {@const held = saved(one.destination)}
      {@const answer = answerFor(one.destination)}
      <form method="POST" action={action('exporter')} class="connection" data-exporter={one.destination}>
        <h3>{one.label} <span class="quiet">{held === undefined ? 'not connected' : 'connected'}</span></h3>
        <input type="hidden" name="destination" value={one.destination} />
        <div class="grid">
          {#each one.fields as field (field.name)}
            <label for="export-{one.destination}-{field.name}">{field.label}</label>
            <input
              id="export-{one.destination}-{field.name}"
              name={field.name}
              placeholder={field.placeholder}
              value={held?.settings[field.name] ?? ''}
              required={field.required}
            />
          {/each}
          <label for="export-{one.destination}-secret">{one.secret[0]?.toUpperCase()}{one.secret.slice(1)}</label>
          <input
            id="export-{one.destination}-secret"
            name="secret"
            type="password"
            autocomplete="off"
            required={held === undefined}
            placeholder={held === undefined ? '' : 'empty keeps the stored one'}
          />
          <p class="quiet hint">{one.where}</p>
        </div>
        {#if held?.lastError}
          <p class="failed" data-failed={one.destination}>The last export said: {held.lastError}</p>
        {/if}
        <p class="buttons">
          <button type="submit" name="do" value="save">Save</button>
          {#if held !== undefined}
            <button type="submit" name="do" value="remove" formnovalidate aria-label="Remove the {one.label} connection">Remove</button>
          {/if}
        </p>
        {#if answer !== null && !answer.ok}
          <p class="failed" role="alert">{answer.message}</p>
        {:else if answer !== null}
          <p class="quiet" role="status">{SAID[answer.did] ?? ''}</p>
        {/if}
      </form>
    {/each}
  </details>
</div>

<style>
  .export {
    border-top: 1px solid var(--line);
  }

  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    margin: 9px 14px;
  }

  .said {
    margin: 9px 14px;
    padding-left: 16px;
    font-size: var(--text-xs);
    color: var(--ink);
  }

  details {
    margin: 9px 14px;
  }

  summary {
    font-size: var(--text-xs);
    color: var(--ink-2);
    cursor: pointer;
  }

  details > .wide {
    margin: 8px 0;
  }

  .connection {
    padding: 10px 0;
    border-top: 1px solid var(--line);
  }

  h3 {
    margin: 0 0 8px;
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .grid {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    align-items: center;
    gap: var(--space-2) var(--space-3);
  }

  .hint {
    grid-column: 1 / -1;
  }

  label {
    font-size: var(--text-sm);
  }

  input {
    padding: 4px 8px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  .buttons {
    display: flex;
    gap: var(--space-2);
    margin: 8px 0 0;
  }

  button {
    padding: 4px 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink-2);
    font: inherit;
    font-size: var(--text-xs);
  }

  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--muted);
  }

  .wide {
    margin: 9px 14px;
  }

  .marks {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  /* Marked with a bar and not with red text, so it reads the same to everybody. */
  .failed {
    margin: 6px 0 0;
    padding-left: 10px;
    box-shadow: inset 2px 0 0 var(--red);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  a {
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  @media (max-width: 640px) {
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
