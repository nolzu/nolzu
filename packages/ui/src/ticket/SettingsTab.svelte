<script lang="ts">
  import { type EngineName, type Estimate, estimateBrief, goneProblem, missingProfileText, presetTitle } from '@nolzu/protocol';
  import Button from '../Button.svelte';
  import { splitCode } from '../toasts.ts';
  import { followsSaid, fromProject, isChanged, ownValues, presetLabel, presetUses, resetSaid, switchSaid } from './card-settings.ts';
  import ModelPicker from './ModelPicker.svelte';

  // The shapes the page hands over. This package reads only the protocol, so they are spelled out here.
  interface Resolved {
    engine: string;
    model: string;
    effort: string;
    from: { model: string; effort: string };
    gone: boolean;
    missingProfile: boolean;
    // Why this row's vendor cannot run this phase, or null when it can. The sentence comes ready,
    // because the rule lives in core and this package reads only the protocol.
    refusal: string | null;
  }
  interface Row {
    action: string;
    // The step's name on the card's board, the one the board's refused drop says.
    label: string;
    // A step of the card's board. Any other action shows only while the card stores a value for it.
    step: boolean;
    own: { engine?: string; model?: string; effort?: string };
    resolved: Resolved;
    // What the row runs once Reset takes the card's own value away: the card's preset.
    follows: Resolved;
    // Only where runs measured one.
    estimate?: Estimate;
    followsEstimate?: Estimate;
    // This step over the project's own runs, for the "Per card" column.
    stepEstimate?: Estimate;
  }

  // The page does the writes, because this package never fetches. Each answers with the sentence it was
  // refused with, or null when it took the write.
  let {
    settings,
    onpick = async () => null,
    onreset = async () => null,
    onpreset = async () => null,
    modelsHref = '/settings/models',
    repos = null,
    onrepos = async () => null,
    chain = null,
    onchain = async () => null,
  }: {
    // `presets`: what a card costs on each preset, built in or saved by name, only where runs in this
    // project measured every step. `saved` is the project's saved preset the card follows instead of
    // `preset`, `savedPresets` every one the project holds, and `presetEngine` the engine the built-in
    // three run on. All optional, so a page that sends none still draws the three buttons.
    settings: {
      rows: readonly Row[];
      preset: string;
      saved?: string | null;
      savedPresets?: readonly string[];
      presetEngine?: EngineName | null;
      board: string;
      profiles: readonly { id: string; label: string; models: readonly string[]; reason?: string; effortInName?: boolean }[];
      presets?: Readonly<Partial<Record<string, Estimate>>>;
    };
    // Engine and model always go together, because a model name means nothing under another engine.
    onpick?: (action: string, choice: { engine: string; model: string } | { effort: string }) => Promise<string | null>;
    onreset?: (action: string) => Promise<string | null>;
    onpreset?: (preset: string) => Promise<string | null>;
    // Settings, Models, where the project's own rows are.
    modelsHref?: string;
    // The project's repositories and which ones this card works in. Null on a project of one repository.
    repos?: { repos: readonly { path: string; picked: boolean; fixed: boolean }[]; by: 'refine' | 'plan' | 'person' | null } | null;
    onrepos?: (repos: string[]) => Promise<string | null>;
    // The tick "Go on to Implement after Plan". Null where the card's board has no chain, or the
    // person has not turned it on for that board, and then the tab draws no tick.
    chain?: { ticked: boolean } | null;
    onchain?: (on: boolean) => Promise<string | null>;
  } = $props();

  const PRESETS = ['light', 'default', 'heavy'];
  // The built-in three, then the project's saved presets, each by the key the write sends.
  const choices = $derived([...PRESETS, ...(settings.savedPresets ?? [])]);
  const current = $derived(settings.saved ?? settings.preset);
  // "Heavy on Cursor" as Settings, Models names it, or a saved preset's own name. A saved name never
  // takes a built-in one, so the key alone says which it is.
  const title = (key: string): string => (PRESETS.includes(key) ? presetTitle(key, settings.presetEngine ?? null) : key);
  // Runs any card makes that are no column of its board: an Ask answer and the plain summary pass.
  // Every other action runs for the project, so a card shows it only while it stores a value for it.
  const CARD_RUNS = ['ask', 'extract-summary'];
  const steps = $derived(settings.rows.filter((row) => row.step));
  const others = $derived(settings.rows.filter((row) => !row.step && (CARD_RUNS.includes(row.action) || isChanged(row.own))));
  const changed = $derived([...steps, ...others].filter((row) => isChanged(row.own)));
  const values = $derived(changed.reduce((sum, row) => sum + ownValues(row.own), 0));

  // Why the step will not start, in the words the board's refused drop uses, or null when it runs.
  function problem(row: Row): string | null {
    if (row.resolved.missingProfile) return `${missingProfileText(row.resolved.engine)} ${row.label} will not start until you pick another.`;
    if (row.resolved.refusal !== null) return row.resolved.refusal;
    if (row.resolved.gone) return goneProblem(row.label, row.resolved.model, row.resolved.engine);
    return null;
  }

  // Bumped by a switch or a Reset, which redraws every picker so none still says it saved a pick.
  let drawn = $state(0);

  let status = $state('');
  let busy = $state(false);

  async function write(send: () => Promise<string | null>, done: string): Promise<void> {
    if (busy) return;
    busy = true;
    status = '';
    const refused = await send();
    status = refused ?? done;
    // A switch or a Reset changes what the rows run on, so a picker's saved note would be stale.
    if (refused === null) drawn += 1;
    busy = false;
  }

  // A switch clears every value the card set, and the line names each step. The
  // preset the card already follows changes nothing, so its button does nothing.
  function switchTo(preset: string): void {
    if (preset === current) return;
    const cleared = changed.map((row) => row.label);
    void write(() => onpreset(preset), switchSaid(title(preset), cleared));
  }

  const reset = (row: Row) => write(() => onreset(row.action), resetSaid(row.label, title(current), row.follows));

  const SET_BY = {
    refine: 'Refine picked this list. Plan may correct it. A change here makes it yours.',
    plan: 'Plan picked this list. A change here makes it yours.',
    person: 'You picked this list, so refine and plan leave it as it is.',
  };
  let reposStatus = $state('');

  // A direct save and not a run, so it shows its own pending line. The project folder is never sent:
  // every card works there anyway, and leaving it out lets clearing every tick clear the list.
  async function pick(path: string, box: HTMLInputElement): Promise<void> {
    if (busy || repos === null) return;
    const next = repos.repos.filter((repo) => !repo.fixed && (repo.path === path ? box.checked : repo.picked)).map((repo) => repo.path);
    busy = true;
    reposStatus = 'Saving.';
    const refused = await onrepos(next);
    // The box shows what is stored, so a refused tick goes back.
    if (refused !== null) box.checked = !box.checked;
    reposStatus = refused ?? (next.length === 0 ? 'Saved. The list is empty, so the next refine or plan picks it again.' : 'Saved. The next run that needs a checkout makes the missing ones.');
    busy = false;
  }

  let chainStatus = $state('');
  // A direct save, as the repositories are. The box shows what is stored, so a refused tick goes back.
  async function tickChain(box: HTMLInputElement): Promise<void> {
    if (busy) return;
    busy = true;
    chainStatus = 'Saving.';
    const refused = await onchain(box.checked);
    if (refused !== null) box.checked = !box.checked;
    chainStatus = refused ?? (box.checked ? 'Saved. Implement starts by itself when the plan is done.' : 'Saved. The card waits for you after Plan.');
    busy = false;
  }
</script>

<div class="tab">
  <section class="head" aria-label="Preset">
    <div class="follows">
      <h2 class="title">This card follows {title(current)}</h2>
      <p class="sub">{followsSaid(title(current), values)}</p>
    </div>
    <!-- Short words on the buttons, as the preset cards on Settings, Models; the heading and the
         accessible name carry the engine. -->
    <div class="presets" role="group" aria-label="Preset for this card">
      {#each choices as preset (preset)}
        {@const cost = settings.presets?.[preset]}
        <button type="button" aria-label={cost === undefined ? title(preset) : `${title(preset)}, ${estimateBrief(cost)}`} aria-pressed={preset === current} aria-busy={busy} onclick={() => switchTo(preset)}
          >{presetLabel(preset)}{#if cost !== undefined}<span class="cost">{estimateBrief(cost)}</span>{/if}</button
        >
      {/each}
    </div>
  </section>
  <p class="said" role="status">{status}</p>

  {#snippet line(row: Row)}
    {@const said = problem(row)}
    {@const own = isChanged(row.own)}
    {@const parts = row.resolved.gone && !row.resolved.missingProfile && row.resolved.refusal === null && said !== null ? splitCode(said, row.resolved.model) : null}
    <div class="row" data-action={row.action} data-state={said !== null ? 'refused' : own ? 'changed' : undefined}>
      <b>{row.label}</b>
      {#key drawn}
        <ModelPicker
          step={row.label}
          engine={row.resolved.engine}
          model={row.resolved.model}
          effort={row.resolved.effort}
          profiles={settings.profiles}
          tone={said !== null ? 'gone' : own ? 'changed' : null}
          columns
          describedby={said !== null ? `why-${row.action}` : undefined}
          onpick={(choice) => onpick(row.action, choice)}
        />
      {/key}
      <span class="note">
        {#if said !== null}
          <span class="refused" id="why-{row.action}">{#if parts !== null}<span class="gone"><i></i>Model gone</span><span>{parts[0]}<code>{parts[1]}</code>{parts[2]}</span>{:else}{said}{/if}</span>
        {:else if own}
          <span class="mine">Changed on this card.</span>
          <span class="sub">{presetUses(title(current), row.follows, row.resolved.engine, row.followsEstimate, settings.profiles.find((one) => one.id === row.follows.engine)?.effortInName === true)}</span>
        {:else}
          <span class="sub">{fromProject(row.resolved.from) ? 'Set in Settings, Models' : 'From the preset'}</span>
        {/if}
      </span>
      <!-- A step that will not start has no figure, and its red sentence says why. A bare "none" here
           had no label on a phone, where the column heads are hidden. -->
      <span class="estimate">{said === null && row.stepEstimate !== undefined ? estimateBrief(row.stepEstimate) : ''}</span>
      <span class="act">
        <!-- A step that will not start has no button: its red picker and sentence say what to do, and
             a pick there is the fix. -->
        {#if said === null && own}
          <Button size="small" data-reset={row.action} aria-busy={busy} onclick={() => reset(row)}>Reset</Button>
        {/if}
      </span>
    </div>
  {/snippet}

  <section class="steps" aria-labelledby="steps-title">
    <h2 class="label" id="steps-title">{settings.board} steps <span class="n">{steps.length}</span></h2>
    <div class="panel">
      <!-- The heads of the columns, as on Settings, Models. The rows of Other runs share them. -->
      <div class="row thead" aria-hidden="true"><span>Step</span><span>Engine</span><span>Model</span><span>Effort</span><span>Source</span><span class="estimate">Per card</span><span></span></div>
      {#each steps as row (row.action)}{@render line(row)}{/each}
    </div>
  </section>

  {#if others.length > 0}
    <section class="steps" aria-labelledby="others-title">
      <h2 class="label" id="others-title">Other runs on this card</h2>
      <div class="panel">
        {#each others as row (row.action)}{@render line(row)}{/each}
      </div>
    </section>
  {/if}
  <p class="sub">Changes here apply to this card only. The project default is in <a class="link" href={modelsHref}>Settings, Models</a>.</p>

  {#if chain !== null}
    <section class="steps" aria-labelledby="chain-title">
      <h2 class="label" id="chain-title">After Plan</h2>
      <label class="tick" data-chain-tick>
        <input type="checkbox" checked={chain.ticked} disabled={busy} onchange={(event) => tickChain(event.currentTarget)} />
        Go on to Implement after Plan
      </label>
      <p class="sub">When the plan is done, Implement starts without waiting for you.</p>
      <p class="sub" role="status">{chainStatus}</p>
    </section>
  {/if}

  {#if repos !== null}
    <section class="steps" aria-labelledby="repos-title">
      <h2 class="label" id="repos-title">Repositories for this card</h2>
      <ul class="repos">
        {#each repos.repos as repo (repo.path)}
          <li>
            <label>
              <input type="checkbox" checked={repo.picked} disabled={busy || repo.fixed} onchange={(event) => pick(repo.path, event.currentTarget)} />
              <span class="mono">{repo.fixed ? 'project folder' : repo.path}</span>
              {#if repo.fixed}<span class="sub">every card works here</span>{/if}
            </label>
          </li>
        {/each}
      </ul>
      <p class="sub">
        {repos.by === null ? 'Nobody has picked the repositories yet. Refine picks a first list, and plan corrects it.' : SET_BY[repos.by]}
      </p>
      <p class="sub" role="status">{reposStatus}</p>
    </section>
  {/if}
</div>

<style>
  /* Full width beside the rail, as every tab is. */
  .tab {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  p,
  h2 {
    margin: 0;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-6);
  }

  .follows {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 260px;
  }

  .title {
    color: var(--ink);
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .sub {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  /* Saved presets add buttons, so a narrow tab wraps them rather than scroll sideways. */
  .presets {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 3px;
    padding: 3px;
    border: 1px solid var(--line-2);
    border-radius: 9px;
    background: var(--panel);
  }

  .presets button {
    height: 34px;
    padding: 0 14px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: var(--text-sm);
  }

  .cost {
    margin-left: 6px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .presets button[aria-pressed='true'] {
    background: var(--card-2);
    color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--line-2);
  }

  .said {
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  .said:empty {
    display: none;
  }

  .steps {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .label {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .n {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 400;
  }

  .panel {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .row {
    display: grid;
    /* Step, engine, model and effort at fixed widths, so each select lines up under its head row after
       row, then the note, the figure and Reset. */
    grid-template-columns: 96px minmax(0, 8.5rem) minmax(0, 14rem) minmax(0, 7.5rem) minmax(0, 1fr) minmax(0, 7rem) 104px;
    gap: var(--space-4);
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .row:first-child {
    border-top: 0;
  }

  .thead {
    padding-block: var(--space-2);
    color: var(--muted);
    font-size: var(--text-2xs);
  }

  .thead .estimate {
    font-family: inherit;
    font-size: inherit;
  }

  .row b {
    color: var(--ink);
    font-weight: 500;
  }

  /* A changed row is tinted in a neutral fill. Amber means a run starts. */
  .row[data-state='changed'] {
    background: var(--card-2);
  }

  /* A step that will not start is red, the colour of a refusal, with a word that says why. */
  .row[data-state='refused'] {
    background: var(--red-bg);
    box-shadow: inset 2px 0 0 var(--red);
  }

  .note {
    display: flex;
    flex-wrap: wrap;
    gap: 0 var(--space-1);
    font-size: var(--text-xs);
  }

  .mine,
  .refused {
    color: var(--ink);
  }

  /* The red pill: a state, so it keeps the red of a refusal. */
  .refused {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }

  .gone {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 20px;
    padding: 0 8px;
    border-radius: 99px;
    background: var(--red-bg);
    color: var(--red);
    font-size: var(--text-2xs);
    font-weight: 500;
    white-space: nowrap;
  }

  .gone i {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
  }

  .mine {
    font-weight: 500;
  }

  code,
  .estimate,
  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .estimate {
    color: var(--muted);
    text-align: right;
  }

  .row[data-state='changed'] .estimate {
    color: var(--ink);
  }

  .act {
    justify-self: end;
  }

  .link {
    color: var(--blue);
  }

  .repos {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: var(--text-sm);
  }

  .repos label,
  .tick {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--ink);
  }

  /* A phone has no room for the columns: the step's name, then its three selects stacked, then the
     note, and the estimate beside the button last. */
  @media (max-width: 760px) {
    .thead {
      display: none;
    }

    .thead + .row {
      border-top: 0;
    }

    .row {
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-2) var(--space-3);
    }

    .row > :global(:not(.estimate, .act)) {
      grid-column: 1 / -1;
    }

    .estimate {
      text-align: left;
    }

    .act {
      grid-column: 2;
    }

    /* A row with no figure and no button ends at its note, with no empty line under it. */
    .estimate:empty,
    .act:empty {
      display: none;
    }
  }
</style>
