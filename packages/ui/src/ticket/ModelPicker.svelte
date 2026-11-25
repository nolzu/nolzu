<script lang="ts">
  // The one combined picker of a step: three native selects drawn in place, engine, model and effort,
  // compact as chips, so nothing opens before a pick.
  // A model name means nothing under another engine, so an engine or a model pick always writes both:
  // a new engine keeps the model when it offers it, and takes its first model when not. The card
  // page's decision panel, its Settings tab and Settings, Models all draw this one. The two tables
  // draw it in `columns`, so each select sits under its own head.
  let {
    step,
    engine,
    model,
    effort,
    profiles,
    tone = null,
    saved = 'Saved for this card.',
    enginesHref = '/settings/engines',
    emptyHelp = true,
    presetPicks = {},
    columns = false,
    describedby,
    onpick,
  }: {
    // The step's name, such as "Refine", for each select's accessible name.
    step: string;
    engine: string;
    model: string;
    effort: string;
    // Every profile a row may name, each with the models it offers. A profile with no models carries
    // the reason, and the picker shows it closed so a person learns why it cannot be picked.
    // `effortInName` marks an engine that reads the effort off the model id, so no effort is offered.
    profiles: readonly { id: string; label: string; models: readonly string[]; reason?: string; effortInName?: boolean }[];
    // A row the card changed, or one whose model is gone, draws its selects apart. Never amber.
    tone?: 'changed' | 'gone' | null;
    // What a pick that took says. Settings, Models saves for the project, not for a card.
    saved?: string;
    // Where a profile with no models gets repaired.
    enginesHref?: string;
    // The line that names the profiles with no models. Settings, Models draws a picker per phase and
    // names them once in its engine choice, so it turns this off.
    emptyHelp?: boolean;
    // The model and effort a move to each profile takes, by profile id, so a move lands on the preset's
    // row for that engine. A profile left out keeps the model when it offers it, else takes its first.
    presetPicks?: Readonly<Record<string, { model: string; effort: string }>>;
    // The three selects take three columns of the row's grid, so a table lines them up row under row.
    // The row grid gives the widths; a narrow screen stacks them.
    columns?: boolean;
    // The id of the row's sentence about this pick, such as why its model is gone, so a screen reader
    // hears it with the model select and not only the word in its name.
    describedby?: string;
    // A direct write, not a run. Answers the sentence it was refused with, or null when it took it.
    onpick: (choice: { engine: string; model: string; effort?: string } | { effort: string }) => Promise<string | null>;
  } = $props();

  const EFFORTS = ['low', 'medium', 'high'];
  const current = $derived(profiles.find((one) => one.id === engine));
  const empty = $derived(profiles.filter((one) => one.reason !== undefined && one.models.length === 0));

  let saving = $state(false);
  let said = $state('');
  async function pick(choice: { engine: string; model: string; effort?: string } | { effort: string }, select: HTMLSelectElement, stored: string): Promise<void> {
    if (saving) return;
    saving = true;
    said = 'Saving.';
    const refused = await onpick(choice);
    // The select shows what is stored, so a refused pick goes back. Its `value` follows a change made
    // elsewhere, which a `selected` attribute stops doing once an option was picked.
    if (refused !== null) select.value = stored;
    said = refused ?? saved;
    saving = false;
  }

  function pickEngine(select: HTMLSelectElement): void {
    const models = profiles.find((one) => one.id === select.value)?.models ?? [];
    const preset = presetPicks[select.value];
    const next = preset !== undefined && models.includes(preset.model) ? preset.model : models.includes(model) ? model : models[0];
    // The select offers no profile without models, so this is only a hand-made value.
    if (next === undefined) return void (select.value = engine);
    void pick({ engine: select.value, model: next, ...(preset?.model === next ? { effort: preset.effort } : {}) }, select, engine);
  }
</script>

<div class="pick" class:cols={columns} data-tone={tone ?? undefined}>
  <select data-pick="engine" aria-label="{step} engine" value={engine} disabled={saving} onchange={(event) => pickEngine(event.currentTarget)}>
    {#each profiles as profile (profile.id)}
      <!-- A profile with no models is named and closed, so it does not vanish from the list with no word. -->
      {#if profile.models.length === 0}
        <option value={profile.id} disabled>{profile.label} (no models)</option>
      {:else}
        <option value={profile.id}>{profile.label}</option>
      {/if}
    {/each}
    {#if current === undefined}
      <option value={engine} disabled>{engine} (no login)</option>
    {/if}
  </select>
  <select data-pick="model" aria-label="{step} model{tone === 'gone' ? ', gone' : ''}" aria-describedby={describedby} value={model} disabled={saving} onchange={(event) => void pick({ engine, model: event.currentTarget.value }, event.currentTarget, model)}>
    {#each current?.models ?? [] as one (one)}
      <option value={one}>{one}</option>
    {/each}
    <!-- The stored model its engine no longer offers. Shown, so the person reads what the row
         names, and not offered again. -->
    {#if !(current?.models ?? []).includes(model)}
      <option value={model} disabled>{current !== undefined && current.models.length > 0 ? `${model} (gone)` : model}</option>
    {/if}
  </select>
  <!-- Cursor reads the effort off the model id, so a select there would change nothing. -->
  {#if current?.effortInName}
    <span class="inid">in model name</span>
  {:else}
    <select data-pick="effort" aria-label="{step} effort" value={effort} disabled={saving} onchange={(event) => void pick({ effort: event.currentTarget.value }, event.currentTarget, effort)}>
      {#each EFFORTS as one (one)}
        <option value={one}>{one}</option>
      {/each}
    </select>
  {/if}
  {#if emptyHelp && empty.length > 0}
    <p class="help">No models from {empty.map((one) => one.label).join(', ')}. <a href={enginesHref}>Open Settings, Engines</a>.</p>
  {/if}
  <p class="note" role="status">{said}</p>
</div>

<style>
  /* Three selects on one line while they fit; a narrow screen wraps them. */
  .pick {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  /* Quiet and 26px as the chips were, in the text font, which reads better than mono in a select.
     A select keeps the width of its words and the row wraps instead, since a squeezed
     select shows only its first letters. Only a name wider than the whole cell is cut. */
  select {
    flex: none;
    box-sizing: border-box;
    max-width: 100%;
    height: 26px;
    padding: 0 var(--space-1) 0 var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: 7px;
    background: var(--card);
    color: var(--ink-2);
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    cursor: pointer;
  }

  /* In a table the row's grid sets the three widths, so a select fills its column. */
  .cols {
    display: grid;
    grid-column: span 3;
    grid-template-columns: subgrid;
    /* `normal` takes the row's column gap, so each select starts where its head does. */
    column-gap: normal;
    row-gap: 4px;
  }

  .cols select {
    width: 100%;
  }

  .cols .help,
  .cols .note {
    grid-column: 1 / -1;
  }

  /* A phone has no room for three columns: the selects stack, full width, under the name. */
  @media (max-width: 760px) {
    .cols {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
    }
  }

  select:disabled {
    cursor: default;
  }

  /* A changed row: a stronger edge in a neutral ink. Amber means a run starts. */
  [data-tone='changed'] select {
    border-color: var(--muted);
    color: var(--ink);
  }

  /* A gone model will not start, so its selects are red, the colour of a refusal. */
  [data-tone='gone'] select {
    border-color: var(--red);
    color: var(--red);
  }

  /* One line, so a narrow Effort column does not grow every row to two. */
  .inid {
    color: var(--muted);
    white-space: nowrap;
    font-size: var(--text-xs);
  }

  .help,
  .note {
    flex-basis: 100%;
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .help a {
    color: var(--blue);
  }

  .note:empty {
    display: none;
  }
</style>
