<script lang="ts">
  import type { QaSetup } from './qa-setup.ts';

  // The four ways QA gets the app, as the question at the first QA and the Edit of Settings, Project draw
  // them. The caller owns the values and the save. `copy` names the folder the commands run in, such as
  // "APP-1's copy", and `onpick` hears every pick a person makes.
  let {
    setup,
    copy,
    choice = $bindable(),
    address = $bindable(),
    start = $bindable(),
    stop = $bindable(),
    status = $bindable(),
    ownPlace = null,
    onpick = () => {},
  }: {
    setup: Pick<QaSetup, 'dev' | 'repo' | 'scripts' | 'unwalled' | 'test'>;
    copy: string;
    choice: 'dev' | 'running' | 'own' | 'code';
    address: string;
    start: string;
    stop: string;
    status: string;
    // Where own commands run when that is not the copy of one repository, as for the answer under `*`.
    ownPlace?: string | null;
    onpick?: () => void;
  } = $props();

  const uid = $props.id();
  // A start command found one folder down says that folder too.
  const where = $derived(
    `${setup.dev === null || setup.dev.repo === '.' ? 'the repository' : setup.dev.repo}${setup.dev?.folder === undefined ? '' : `, in ${setup.dev.folder}`}`,
  );
  const ownWhere = $derived(ownPlace ?? `${copy} of ${setup.repo === null || setup.repo === '.' ? 'the repository' : setup.repo}`);

  // A click or typing in the address box picks it, never the focus: Tab out of the choices lands in the
  // box, and a focus that picked it would swap the choice under a person on the keys.
  const pickRunning = (): void => {
    onpick();
    choice = 'running';
  };
</script>

<div class="choices" role="radiogroup" aria-label="How QA gets the app" onchange={onpick}>
  {#if setup.dev !== null}
    <label class="opt" class:on={choice === 'dev'}>
      <input type="radio" name="{uid}-app" value="dev" bind:group={choice} data-choice="dev" />
      <span class="words">
        <b>Start it with <code>{setup.dev.command}</code> and stop it after</b>
        <span class="says">Runs in {copy} of {where}, on a free port{setup.unwalled === null ? ', inside the wall' : ''}</span>
        {#if setup.unwalled !== null}<span class="says" data-unwalled>Runs with no wall on this machine: {setup.unwalled}</span>{/if}
        <!-- What npm runs is the card's branch's scripts block, so the person sees it before saying yes,
             and again after it changed. -->
        {#if setup.scripts !== ''}<pre class="scripts" data-scripts>{setup.scripts}</pre>{/if}
      </span>
    </label>
  {:else}
    <p class="says" data-no-start>No package.json here or one folder down names a start script.</p>
  {/if}
  <label class="opt" class:on={choice === 'running'}>
    <input type="radio" name="{uid}-app" value="running" bind:group={choice} data-choice="running" />
    <span class="words">
      <b>It is already running at <input class="address" type="text" bind:value={address} aria-label="The address the app runs at" placeholder="localhost:5173" autocomplete="off" spellcheck="false" onclick={pickRunning} oninput={pickRunning} data-address /></b>
      <span class="says">QA uses it and leaves it alone</span>
    </span>
  </label>
  <!-- A box, not a label, because the three boxes inside have labels of their own. -->
  <div class="opt" class:on={choice === 'own'}>
    <input id="{uid}-own" type="radio" name="{uid}-app" value="own" bind:group={choice} data-choice="own" />
    <span class="words">
      <label for="{uid}-own"><b>Start it with my own commands</b></label>
      <span class="says">They run in {ownWhere} with no wall, so Docker works. {'{key}'} becomes the card key.</span>
      <!-- The boxes show once the option is picked, so the question stays short. -->
      {#if choice === 'own'}
        <span class="boxes">
          <label for="{uid}-start">Start</label>
          <input id="{uid}-start" class="command" type="text" bind:value={start} placeholder="docker compose up -d" autocomplete="off" spellcheck="false" data-own="start" />
          <label for="{uid}-stop">Stop, if it needs one</label>
          <input id="{uid}-stop" class="command" type="text" bind:value={stop} placeholder="docker compose down" autocomplete="off" spellcheck="false" data-own="stop" />
          <label for="{uid}-status">Status, if it has one</label>
          <input id="{uid}-status" class="command" type="text" bind:value={status} placeholder="docker compose ps" autocomplete="off" spellcheck="false" data-own="status" />
        </span>
      {/if}
    </span>
  </div>
  <label class="opt" class:on={choice === 'code'}>
    <input type="radio" name="{uid}-app" value="code" bind:group={choice} data-choice="code" />
    <span class="words">
      <b>Skip the app, check the code only</b>
      <span class="says">QA reads the change and runs {#if setup.test !== null}<code>{setup.test}</code>{:else}the checks it finds{/if}</span>
    </span>
  </label>
</div>

<style>
  .choices {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* The option box. The chosen one gets a stronger edge and the raised card, never amber: a
     choice starts nothing. */
  .opt {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    padding: 10px var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    cursor: pointer;
  }

  .opt.on {
    border-color: var(--ink-3);
    background: var(--card-2);
  }

  .opt > input {
    margin-top: 3px;
    accent-color: var(--ink);
  }

  .words {
    display: flex;
    min-width: 0;
    flex: 1;
    flex-direction: column;
    gap: 2px;
  }

  b {
    font-size: var(--text-sm);
    font-weight: 500;
  }

  .says {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .boxes {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 4px;
    font-size: var(--text-xs);
  }

  .boxes label {
    color: var(--muted);
  }

  .scripts {
    max-height: 7.5em;
    margin: 4px 0 0;
    padding: 6px 8px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--card);
    color: var(--muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  code,
  .address,
  .command,
  .scripts {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .address,
  .command {
    padding: 2px 6px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--card);
    color: var(--ink);
  }

  .address {
    width: 18ch;
  }

  .address::placeholder,
  .command::placeholder {
    color: var(--muted);
  }
</style>
