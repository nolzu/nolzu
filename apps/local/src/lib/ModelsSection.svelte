<script lang="ts">
  import { tick } from 'svelte';
  import { deserialize, enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { ENGINE_LABELS, estimateShort, PHASE_HELP, phaseLabel, presetTitle, SCOUT_AND_EVIDENCE } from '@nolzu/protocol';
  import { Button, HelpTip, ModelPicker, presetLabel } from '@nolzu/ui';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { ModelsSection, PresetCell, SavedLine } from './project-models.ts';

  // Settings, Models: one table of engines and the built-in presets, where a cell picks both, the
  // saved presets as a list under it, then every phase with its own picker, and a
  // bar while phases differ from the preset. `said` and the refusals come from the page's form answer.
  let {
    models,
    said = '',
    refused = null,
    named = null,
    renamed = null,
  }: { models: ModelsSection; said?: string; refused?: string | null; named?: string | null; renamed?: string | null } = $props();

  // Three fixed dots for cost and strength in the head of each built-in column. No figure, because only
  // runs measure one, so the dots say the order and nothing more.
  const BUILT_IN: Record<string, { dots: number }> = { light: { dots: 1 }, default: { dots: 2 }, heavy: { dots: 3 } };
  // The phases in the groups the boards run them in, in the order of `ACTIONS`.
  const GROUPS: { title: string; actions: readonly string[] }[] = [
    { title: 'Delivery', actions: ['refine', 'plan', 'implement', 'qa', 'wrapup'] },
    { title: 'Epics, Research and PR reviews', actions: ['architecture', 'design', 'investigate', 'research', 'pr-review', 'feedback'] },
    { title: 'Other runs', actions: ['optimize', 'orient', 'learn-repo', 'assess', 'ask', 'extract-summary'] },
  ];
  // Assessment reads Scout findings only, so it waits with Scout. Its row keeps running as it is set.
  const shown = $derived(SCOUT_AND_EVIDENCE ? models.rows : models.rows.filter((row) => row.action !== 'assess'));

  // "Heavy on Cursor", or the saved preset's own name.
  const title = $derived(models.chosen ?? presetTitle(models.preset, models.presetEngine));
  // On a built-in preset a changed phase is the person's own and saved at once;
  // on a saved preset it is a change the bar can still discard.
  const builtIn = $derived(models.chosen === null);
  const changedWord = $derived(builtIn ? `${models.changes} ${models.changes === 1 ? 'phase' : 'phases'} yours` : `${models.changes} changed`);

  // A cell with no measured cost says nothing, and the line under the table says it once.
  const costWords = (cell: PresetCell | SavedLine) => (cell.estimate === undefined ? '' : `, ${estimateShort(cell.estimate)} a card`);
  const anyCost = $derived(models.grid.some((row) => row.cells.some((cell) => cell.estimate !== undefined)) || models.mine.some((one) => one.estimate !== undefined));
  // The one cell the Tab key lands on: the one in use, or the first that can be picked. A saved preset
  // in use sits in its own list, so the table then stops on its first open cell.
  const stop = $derived.by(() => {
    const open = models.grid.flatMap((row) => (row.why === null ? row.cells.map((cell) => ({ key: `${row.vendor}/${cell.name}`, cell })) : []));
    return (open.find((one) => one.cell.active) ?? open[0])?.key ?? null;
  });
  // The arrows walk the table: left and right along an engine's row, up and down to the same column of
  // the next engine that has one open. Home and End go to the ends of the row.
  function move(event: KeyboardEvent): void {
    const at = (event.target as HTMLElement).closest<HTMLButtonElement>('button.cell');
    const grid = event.currentTarget as HTMLElement;
    if (at === null) return;
    const rows = [...grid.querySelectorAll('.gr[data-engine]')].map((row) => [...row.querySelectorAll<HTMLButtonElement>('button.cell')]);
    const r = rows.findIndex((row) => row.includes(at));
    const c = rows[r]?.indexOf(at) ?? 0;
    const along = (row: HTMLButtonElement[], from: number, step: number) => {
      for (let i = from; i >= 0 && i < row.length; i += step) if (!row[i]?.disabled) return row[i];
      return undefined;
    };
    let next: HTMLButtonElement | undefined;
    if (event.key === 'ArrowRight') next = along(rows[r] ?? [], c + 1, 1);
    else if (event.key === 'ArrowLeft') next = along(rows[r] ?? [], c - 1, -1);
    else if (event.key === 'Home') next = along(rows[r] ?? [], 0, 1);
    else if (event.key === 'End') next = along(rows[r] ?? [], (rows[r]?.length ?? 1) - 1, -1);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const step = event.key === 'ArrowDown' ? 1 : -1;
      for (let i = r + step; i >= 0 && i < rows.length && next === undefined; i += step) {
        const row = rows[i] ?? [];
        next = along(row, Math.min(c, row.length - 1), -1) ?? along(row, Math.min(c, row.length - 1), 1);
      }
    } else return;
    event.preventDefault();
    if (next === undefined) return;
    for (const row of rows) for (const one of row) one.tabIndex = one === next ? 0 : -1;
    next.focus();
  }

  // The saved preset whose rename form is open. A rename closes it, since the old name is gone.
  let editing = $state<string | null>(null);
  async function rename(event: MouseEvent, name: string): Promise<void> {
    (event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open');
    editing = editing === name ? null : name;
    await tick();
    document.getElementById('preset-rename')?.focus();
  }
  // The name field shows on Save as new preset, and stays open when the name was refused. It closes
  // with the bar, on a save or a Discard, so the next change offers Save as new preset again.
  let naming = $state(false);
  const showName = $derived(naming || named !== null);
  $effect(() => {
    if (models.changes === 0) naming = false;
  });
  // A refused name goes as soon as the name is edited, so an old refusal never reads as the answer to
  // the new name. The answer to the next Save shows whatever the server says then.
  let nameEdited = $state(false);
  const nameRefused = $derived(nameEdited ? null : named);
  async function nameOne(): Promise<void> {
    naming = true;
    await tick();
    document.getElementById('preset-name')?.focus();
  }

  // A pick posts to the same form action as every other write here, so one module checks them all.
  async function post(fields: Record<string, string>): Promise<string | null> {
    const body = new FormData();
    for (const [name, value] of Object.entries(fields)) body.set(name, value);
    try {
      const response = await fetch('?/models', { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
      const result = deserialize(await response.text());
      if (result.type === 'success') {
        await invalidateAll();
        return null;
      }
      const message = result.type === 'failure' ? result.data?.message : undefined;
      return typeof message === 'string' ? message : `Nolzu answered ${response.status} and gave no reason.`;
    } catch {
      return 'The board could not be reached. Check that Nolzu is still running.';
    }
  }
  const pick = (action: string, choice: { engine: string; model: string; effort?: string } | { effort: string }) =>
    post(
      'engine' in choice
        ? { action, engine: choice.engine, model: choice.model, ...(choice.effort === undefined ? {} : { effort: choice.effort }) }
        : { action, field: 'effort', value: choice.effort },
    );
  // Escape closes a saved preset's menu and puts the focus back on its button, as a native menu does.
  function closeMenu(event: KeyboardEvent): void {
    const menu = event.currentTarget as HTMLDetailsElement;
    if (event.key !== 'Escape' || !menu.open) return;
    event.preventDefault();
    menu.open = false;
    menu.querySelector('summary')?.focus();
  }
  // Remove asks first: the card and its name are gone at once, though every phase keeps running.
  function confirmRemove(event: MouseEvent, name: string): void {
    if (!confirm(`Remove the preset ${name}? Every phase keeps running what it runs now.`)) event.preventDefault();
  }
  // A reset takes its own button away, so the focus goes to what took its place and not to the page.
  const focusAfter =
    (selector: string): SubmitFunction =>
    () =>
    async ({ update }) => {
      await update();
      await tick();
      document.querySelector<HTMLElement>(selector)?.focus();
    };
  // Back to Nolzu's default drops every phase the person set on this preset, so it asks first.
  function confirmDefault(event: MouseEvent): void {
    if (!confirm(`Put every phase of ${title} back to Nolzu's default?`)) event.preventDefault();
  }
</script>

{#snippet pips(on: number)}
  <span class="pips" aria-hidden="true">{#each [1, 2, 3] as n (n)}<i class:on={n <= on}></i>{/each}</span>
{/snippet}

{#snippet face(cell: PresetCell | SavedLine)}
  {#if cell.active}<span class="pill">In use</span>{/if}
  {#if cell.estimate !== undefined}<span class="cost">{estimateShort(cell.estimate)}</span>{/if}
{/snippet}

<section id="models" aria-labelledby="models-title">
  <header class="section-head"><h2 id="models-title">Models</h2><p>Pick an engine and a preset in one click. Change a single phase below when it needs something else.</p></header>

  <section class="block" aria-labelledby="preset-title">
    <div class="lineh"><h3 id="preset-title">Engine and preset</h3></div>
    {#if models.grid.length === 0}
      <p class="quiet">No engine found on this machine yet. <a href={resolve('/settings/[section]', { section: 'engines' })}>Engines</a></p>
    {:else}
      <!-- One radio group over every engine and preset. The arrows move between cells and Space or
           Enter picks, since every pick is saved at once. Each cell is its own small form, so a built-in
           preset posts its engine with it. -->
      <div class="grid" role="radiogroup" aria-labelledby="preset-title" tabindex="-1" onkeydown={move}>
        <div class="gr head" aria-hidden="true">
          <span>Engine</span>
          {#each models.presets as name (name)}<span>{presetLabel(name)} {@render pips(BUILT_IN[name]?.dots ?? 0)}</span>{/each}
        </div>
        {#each models.grid as row (row.vendor)}
          <div class="gr" data-engine={row.vendor}>
            <span class="en">
              <b>{ENGINE_LABELS[row.vendor]}</b>
              {#if row.why !== null}<span class="why">{row.why} <a href={resolve('/settings/[section]', { section: 'engines' })}>Engines</a></span>{/if}
            </span>
            <span class="seg">
              {#each row.cells as cell (cell.name)}
                <form method="POST" action="?/models" class="cf" use:enhance>
                  <input type="hidden" name="presetEngine" value={row.vendor} />
                  <!-- Closed only on an engine that cannot take a preset yet, which the engine cell names. -->
                  <button
                    type="submit"
                    name="preset"
                    value={cell.name}
                    class="cell"
                    role="radio"
                    aria-checked={cell.active}
                    aria-label="{presetLabel(cell.name)} on {ENGINE_LABELS[row.vendor]}{cell.uses === undefined ? '' : `, Implement runs ${cell.uses}`}{costWords(cell)}"
                    disabled={row.why !== null}
                    tabindex={stop === `${row.vendor}/${cell.name}` ? 0 : -1}
                    data-preset={cell.name}
                  >
                    <span class="nm">{presetLabel(cell.name)}</span>
                    {@render face(cell)}
                    {#if cell.uses !== undefined}<span class="uses" title="Implement runs {cell.uses}">{cell.uses}</span>{/if}
                  </button>
                </form>
              {/each}
            </span>
          </div>
        {/each}
      </div>
    {/if}
    {#if models.mine.length > 0}
      <!-- A saved preset can mix engines, so it gets a line of its own under the table and never sits
           under one engine. A plain list stays readable with fifteen of them. Every line is a Tab stop,
           so no roving is needed beside the menus. -->
      <div class="own">
        <h4 id="own-title">Your presets<span class="n">{models.mine.length}</span></h4>
        <div class="list" role="radiogroup" aria-labelledby="own-title">
          {#each models.mine as one (one.name)}
            <div class="sc">
              <form method="POST" action="?/models" class="cf" use:enhance>
                <button type="submit" name="apply" value={one.name} class="cell line" role="radio" aria-checked={one.active} aria-label="{one.name}, on {one.runsOn}{costWords(one)}" data-preset={one.name}>
                  <span class="nm" title={one.name}>{one.name}</span>
                  <span class="engs">{one.runsOn}</span>
                  {@render face(one)}
                </button>
              </form>
              <!-- Rename and Remove sit in a small menu beside the line, since a button holds no button. -->
              <!-- The keys come from the summary and the two buttons inside, which are the interactive part. -->
              <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
              <details class="more" onkeydown={closeMenu}>
                <summary aria-label="Rename or remove the preset {one.name}">&middot;&middot;&middot;</summary>
                <span class="menu">
                  <Button size="small" variant="ghost" aria-expanded={editing === one.name} aria-controls="preset-edit" aria-label="Rename the preset {one.name}" onclick={(event: MouseEvent) => rename(event, one.name)}>Rename</Button>
                  <form method="POST" action="?/models" use:enhance>
                    <Button size="small" variant="ghost" type="submit" name="remove" value={one.name} aria-label="Remove the preset {one.name}" onclick={(event: MouseEvent) => confirmRemove(event, one.name)}>Remove</Button>
                  </form>
                </span>
              </details>
            </div>
          {/each}
        </div>
      </div>
    {/if}
    {#if editing !== null && models.saved.includes(editing)}
      <form
        id="preset-edit"
        method="POST"
        action="?/models"
        class="name"
        aria-label="Rename the preset {editing}"
        use:enhance={() =>
          async ({ result, update }) => {
            if (result.type === 'success') editing = null;
            await update();
          }}
      >
        <input type="hidden" name="rename" value={editing} />
        <label for="preset-rename">Name</label>
        <input id="preset-rename" name="name" maxlength="40" value={editing} />
        <Button size="small" type="submit">Rename</Button>
        {#if renamed !== null}<p class="refused" role="alert">{renamed}</p>{/if}
      </form>
    {/if}
    <!-- Under the table and the list, so the answer to a click there is in view and not at the foot of the page. -->
    <p class="quiet saved" role="status">{said}</p>
    <p class="quiet">
      Light is the cheapest, Heavy runs the strongest models, and the dots show cost and strength. {anyCost ? 'Costs are for one Delivery card, from your own runs in this project.' : 'Costs for a Delivery card show here once runs in this project measured them.'} Every phase moves at once, with that engine's own models. To make your own preset, change a phase and press Save as new preset.
    </p>
  </section>

  <section class="block" aria-labelledby="model-phases-title">
    <div class="lineh"><h3 id="model-phases-title" tabindex="-1">Phases<span class="n">{shown.length}</span></h3><span class="quiet">{models.changes === 0 ? title : `${title}, ${changedWord}`}</span></div>
    <div class="tbl">
      <div class="thead" aria-hidden="true"><span>Phase</span><span>Engine</span><span>Model</span><span>Effort</span><span></span></div>
      {#each GROUPS as group (group.title)}
        <div class="grp">
          <div class="gh">{group.title}</div>
          {#each shown.filter((row) => group.actions.includes(row.action)) as row (row.action)}
            <div class="pr" class:changed={row.changed} data-action={row.action} data-state={row.warning !== null ? 'refused' : undefined}>
              <span class="ph"><b>{phaseLabel(row.action)}</b><HelpTip text={PHASE_HELP[row.action] ?? ''} label="What {phaseLabel(row.action)} does" /></span>
              <!-- An engine with no models is named once in the engine and preset table. Offered closed in every
                   row too, its long label widened every select and pushed the rows onto two lines. -->
              <ModelPicker
                step={phaseLabel(row.action)}
                engine={row.resolved.engine}
                model={row.resolved.model}
                effort={row.resolved.effort}
                profiles={models.choices.filter((one) => one.models.length > 0 || one.id === row.resolved.engine)}
                presetPicks={row.presetPicks}
                emptyHelp={false}
                tone={row.warning !== null ? 'gone' : row.changed ? 'changed' : null}
                saved=""
                columns
                describedby={row.warning !== null ? `was-${row.action}` : undefined}
                onpick={(choice) => pick(row.action, choice)}
              />
              <!-- The right side says a phase differs from the preset, and takes it back. -->
              <span class="act">
                <!-- A phase whose own model is gone keeps Reset too: back to the preset is the quickest fix
                     there. Its red picker and sentence say the rest. -->
                {#if row.changed}
                  <span class="tag">{builtIn ? 'Yours' : 'Changed'}</span>
                  <form method="POST" action="?/models" use:enhance={focusAfter(`.pr[data-action="${row.action}"] select[data-pick="model"]`)}>
                    <input type="hidden" name="action" value={row.action} />
                    <Button size="small" variant="ghost" type="submit" name="reset" value="1" aria-label={builtIn ? `Put ${phaseLabel(row.action)} back to Nolzu's default` : `Reset ${phaseLabel(row.action)} to the preset`}>Reset</Button>
                  </form>
                {/if}
              </span>
              {#if row.warning !== null}
                <span class="was warn" id="was-{row.action}">{row.warning}</span>
              {/if}
              {#if row.changed}
                <span class="was">{builtIn ? "Nolzu's default is" : `${title} uses`} {row.baseText}</span>
              {:else if row.picked !== null && row.warning === null}
                <span class="was">{row.picked}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </section>

  {#if refused !== null}<p class="refused" role="alert">{refused}</p>{/if}

  <!-- A reminder, not a gate: a change is in use at once. -->
  {#if models.changes > 0}
    <div class="bar" role="status">
      <span class="bt">
        {#if builtIn}
          <b><i></i>{title}, {changedWord}</b>
          <span class="quiet">Saved. Runs in this project use them from the next start, and a Nolzu update keeps them.</span>
        {:else}
          <b><i></i>{models.changes} {models.changes === 1 ? 'change' : 'changes'} from {title}</b>
          <span class="quiet">Runs in this project use them from the next start. {models.chosen} itself stays as it is.</span>
        {/if}
      </span>
      <span class="bb">
        <form method="POST" action="?/models" use:enhance={focusAfter('#model-phases-title')}>
          {#if builtIn}
            <Button size="small" variant="ghost" type="submit" name="discard" value="1" onclick={confirmDefault}>Back to Nolzu's default</Button>
          {:else}
            <Button size="small" variant="ghost" type="submit" name="discard" value="1">Discard</Button>
          {/if}
        </form>
        {#if models.chosen !== null}
          <form method="POST" action="?/models" use:enhance>
            <Button size="small" type="submit" name="replace" value={models.chosen}>Update {models.chosen}</Button>
          </form>
        {/if}
        {#if showName}
          <form
            method="POST"
            action="?/models"
            class="name"
            use:enhance={() =>
              async ({ update }) => {
                // After the answer, not at the press, so the old refusal does not come back while the
                // new name is on its way.
                await update();
                nameEdited = false;
              }}
          >
            <label for="preset-name">Name</label>
            <input
              id="preset-name"
              name="save"
              maxlength="40"
              placeholder="Evenings"
              aria-invalid={nameRefused !== null}
              aria-describedby={nameRefused === null ? undefined : 'preset-name-refused'}
              oninput={() => (nameEdited = true)}
            />
            <Button size="small" variant="primary" type="submit">Save</Button>
            {#if nameRefused !== null}<p id="preset-name-refused" class="refused" role="alert">{nameRefused}</p>{/if}
          </form>
        {:else}
          <Button size="small" variant="primary" onclick={nameOne}>Save as new preset</Button>
        {/if}
      </span>
    </div>
  {/if}
</section>

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  #models {
    gap: 26px;
  }

  p {
    margin: 0;
  }

  .quiet {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .quiet a {
    color: var(--blue);
  }

  .saved:empty {
    display: none;
  }

  .lineh {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 12px;
  }

  h3 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
  }

  .n {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 400;
  }

  /* Engine and the three built-in presets, so a column reads as one preset down every engine. The
     cells keep their row on a narrow page; below 760px each engine is a block. */
  .grid {
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .gr {
    display: grid;
    grid-template-columns: 150px repeat(3, minmax(0, 1fr));
    gap: 8px 10px;
    align-items: center;
    padding: 10px 14px;
  }

  .gr + .gr {
    border-top: 1px solid var(--line);
  }

  .head {
    padding-block: 8px;
    color: var(--muted);
    font-size: var(--text-2xs);
  }

  .head > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  /* The three cells sit straight in the row's columns, under their heads. */
  .seg {
    display: contents;
  }

  .en {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    font-size: var(--text-sm);
  }

  .en b {
    font-weight: 600;
  }

  .why {
    flex-basis: 100%;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .why a {
    color: var(--blue);
  }

  .cf {
    display: flex;
    min-width: 0;
  }

  .cell {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 8px;
    min-width: 0;
    min-height: 40px;
    box-sizing: border-box;
    padding: 6px 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink-2);
    font: inherit;
    font-size: var(--text-xs);
    text-align: left;
    cursor: pointer;
  }

  .cell:not(:disabled):hover {
    background: var(--card-2);
  }

  /* The pick in use: the attribute, the word and a stronger edge. Never amber. */
  .cell[aria-checked='true'] {
    border-color: var(--ink-2);
    box-shadow: inset 0 0 0 1px var(--ink-2);
    color: var(--ink);
  }

  /* Closed only with the reason in the engine cell beside it. A dashed edge and the muted text say
     it is closed without a colour of its own, and --muted still passes AA. */
  .cell:disabled {
    border-style: dashed;
    background: transparent;
    color: var(--muted);
    cursor: default;
  }

  /* What Implement runs, on one line under the name, so twelve cells never read as blank before any
     cost is known. */
  .uses {
    overflow: hidden;
    flex: 1 1 100%;
    min-width: 0;
    color: var(--ink-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nm {
    overflow: hidden;
    max-width: 100%;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .own {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  h4 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .sc {
    position: relative;
    display: flex;
    gap: 2px;
    max-width: 100%;
  }

  .sc .cf {
    flex: 1;
    max-width: calc(100% - 34px);
  }

  /* The name keeps its line and is cut first; the engines wrap under it on a narrow page. */
  /* A line is one row of text, so fifteen presets stay shorter than one screen. */
  .cell.line {
    min-height: 32px;
    padding: 4px 10px;
  }

  .line .nm {
    flex: 0 1 auto;
    min-width: 0;
  }

  .line .engs {
    flex: 1 1 auto;
  }

  .pill {
    flex: none;
    padding: 0 7px;
    border-radius: 99px;
    box-shadow: inset 0 0 0 1px var(--line-2);
    color: var(--ink-2);
    font-size: var(--text-2xs);
    font-weight: 500;
    line-height: 18px;
    white-space: nowrap;
  }

  .pips {
    display: inline-flex;
    gap: 3px;
  }

  .pips i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px var(--muted);
  }

  .pips i.on {
    background: var(--ink-2);
    box-shadow: none;
  }

  .engs {
    color: var(--muted);
  }

  .cost {
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .more summary {
    display: grid;
    place-items: center;
    width: 32px;
    height: 100%;
    min-height: 40px;
    box-sizing: border-box;
    border-radius: var(--radius-md);
    color: var(--ink-2);
    list-style: none;
    cursor: pointer;
  }

  .more summary::-webkit-details-marker {
    display: none;
  }

  .more[open] summary {
    background: var(--card-2);
  }

  .menu {
    position: absolute;
    z-index: 2;
    top: calc(100% + 4px);
    right: 0;
    display: flex;
    flex-direction: column;
    padding: 4px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    box-shadow: var(--shadow);
  }

  .name {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  label {
    font-size: var(--text-sm);
  }

  input {
    width: 16ch;
    padding: 4px 8px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  .tbl {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .thead,
  .pr {
    display: grid;
    /* Phase, engine, model and effort at fixed widths, so each select lines up under its head row
       after row, then the Changed mark and Reset on the right. That last column keeps their width,
       so a narrow page squeezes the selects, never lays Reset over them. */
    grid-template-columns: 170px minmax(0, 8.5rem) minmax(0, 14rem) minmax(0, 7.5rem) minmax(max-content, 1fr);
    gap: 4px 14px;
    align-items: center;
    padding: 8px 16px;
  }

  .thead {
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: var(--text-2xs);
  }

  .gh {
    padding: 12px 16px 4px;
    color: var(--muted);
    font-size: var(--text-2xs);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .grp + .grp {
    border-top: 1px solid var(--line);
  }

  .pr {
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .gh + .pr {
    border-top: 0;
  }

  /* A changed phase: a tint, an edge and the word, never colour alone and never amber. */
  .pr.changed {
    background: var(--card-2);
    box-shadow: inset 2px 0 0 var(--ink-2);
  }

  /* A phase that will not start is red, the colour of a refusal, as on the card's Settings tab. */
  .pr[data-state='refused'] {
    background: var(--red-bg);
    box-shadow: inset 2px 0 0 var(--red);
  }

  .ph {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .ph b {
    font-weight: 500;
  }

  .tag {
    padding: 0 7px;
    border-radius: 99px;
    box-shadow: inset 0 0 0 1px var(--muted);
    color: var(--ink-2);
    font-size: var(--text-2xs);
    font-weight: 500;
    line-height: 18px;
  }

  .act {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    justify-self: end;
  }

  /* The line spans the columns but sizes none: its width would go to the last one, which is sized by
     its content, and squeeze the selects to nothing. */
  .was {
    grid-column: 2 / -1;
    contain: inline-size;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .was.warn {
    color: var(--ink);
  }

  /* Its own line under the name field, never one more item beside Save. */
  .name .refused {
    flex-basis: 100%;
  }

  .refused {
    padding-left: 10px;
    box-shadow: inset 2px 0 0 var(--red);
    color: var(--ink);
    font-size: var(--text-xs);
  }

  .bar {
    position: sticky;
    bottom: 12px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
    padding: 12px 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-xl);
    background: var(--card);
    box-shadow: var(--shadow);
  }

  .bt {
    display: flex;
    flex: 1 1 280px;
    flex-direction: column;
    gap: 2px;
  }

  .bt b {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;
  }

  .bt i {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ink-2);
  }

  /* On the first line of text, so a refusal under the name field does not push the other buttons
     down to the middle of the field and its refusal together. */
  .bb {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
  }

  @media (max-width: 760px) {
    /* One engine per block, its presets as a segmented control under its name. */
    .head {
      display: none;
    }

    .gr {
      grid-template-columns: minmax(0, 1fr);
    }

    .seg {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .seg .cf + .cf .cell {
      border-left: 0;
    }

    .seg .cell {
      flex-direction: column;
      align-items: flex-start;
      border-radius: 0;
    }

    .seg .cf:first-child .cell {
      border-radius: var(--radius-md) 0 0 var(--radius-md);
    }

    .seg .cf:last-child .cell {
      border-radius: 0 var(--radius-md) var(--radius-md) 0;
    }

    /* Full width, so a long model id is cut with an ellipsis rather than widening the cell. */
    .seg .uses {
      flex: none;
      align-self: stretch;
    }

    .thead {
      display: none;
    }

    .pr {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    /* The three selects stack on their own line under the phase name. */
    .pr > :global(.pick) {
      grid-row: 2;
      grid-column: 1 / -1;
    }

    .act {
      grid-row: 1;
      grid-column: 2;
    }

    .was {
      grid-column: 1 / -1;
    }
  }
</style>
