<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { profileId } from '@nolzu/protocol';
  import { Button, HelpTip } from '@nolzu/ui';
  import { copyText } from './clipboard.ts';
  import type { LoginCheck, ProfilesSection } from './engine-profiles.ts';
  import FolderBrowser from './FolderBrowser.svelte';
  import { signInLine } from './sign-in.ts';

  // `checked` is a Check login answer the page got back from a post without its script. `refusedAdd`
  // says the problem is a refused Add profile, so the form it came from opens again.
  let {
    profiles,
    said = '',
    problem = null,
    checked = null,
    refusedAdd = false,
  }: { profiles: ProfilesSection; said?: string; problem?: string | null; checked?: LoginCheck | null; refusedAdd?: boolean } = $props();

  // Which vendor the add form is on. The sentence under the folder field follows it. Empty means the first one, which is what a select with no
  // option marked shows before anything is picked. Reading the list here instead would only capture
  // the list the component opened with, which Svelte warns about.
  let vendor = $state('');
  const chosen = $derived(profiles.vendors.find((one) => one.vendor === vendor) ?? profiles.vendors[0] ?? null);
  let adding = $state(false);
  $effect(() => {
    if (refusedAdd) adding = true;
  });
  let label = $state('');
  let folder = $state('');
  let browsing = $state(false);
  const newId = $derived(chosen === null || label.trim() === '' ? null : profileId(label.trim(), chosen.vendor, profiles.rows.map((row) => row.id)));
  const signIn = $derived(chosen === null || chosen.login === null ? null : signInLine(chosen.login, chosen.variable, folder));

  // Each row's last answer, for as long as the page is open. Nothing stores it, so a reload shows none.
  let answers = $state<Record<string, LoginCheck>>({});
  let refusals = $state<Record<string, string>>({});
  // Per row, because two rows may be checked at once and one answer must not end the other's wait.
  let checking = $state<Record<string, boolean>>({});
  const answerOf = (id: string): LoginCheck | null => answers[id] ?? (checked?.id === id ? checked : null);

  // A press runs the status command once. The answer goes on its row and the page is not loaded again,
  // so the version look does not run with it. The pending word is the press's own, as a commit's is.
  const check: SubmitFunction = ({ formData }) => {
    const id = String(formData.get('id'));
    checking[id] = true;
    delete refusals[id];
    return async ({ result }) => {
      delete checking[id];
      if (result.type === 'success' && result.data?.check !== undefined) answers[id] = result.data.check as LoginCheck;
      else refusals[id] = result.type === 'failure' ? String(result.data?.message ?? '') : 'The check did not answer. Press Check login again.';
    };
  };

  const WORD: Record<LoginCheck['state'], string> = { in: 'Signed in', out: 'Signed out', missing: 'Not installed', failed: 'Check failed' };
  const clock = (ms: number): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));

  const PROFILE_HELP =
    'A profile is one login of a tool. A second login of the same tool needs a config folder of its own, so the two never share one login.';

  let copied = $state<string | null>(null);
  const copy = async (line: string): Promise<void> => {
    copied = (await copyText(line)) ? 'Copied.' : 'The browser did not copy it. Select the command and copy it by hand.';
  };
</script>

{#snippet commandLine(line: string, name: string)}
  <div class="inst">
    <code>{line}</code>
    <Button size="small" variant="ghost" aria-label={name} onclick={() => copy(line)}
      ><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"></path></svg></Button
    >
  </div>
{/snippet}

<section class="profiles" aria-labelledby="profiles-title">
  <div class="line">
    <h3 id="profiles-title">Profiles<span class="n">{profiles.rows.length}</span></h3>
    <span class="hint">One login of a tool each.</span>
    <span class="sp"></span>
    {#if chosen !== null}
      <HelpTip label="What a profile is" text={PROFILE_HELP} />
      <Button size="small" aria-expanded={adding} aria-controls="add-profile" onclick={() => (adding = !adding)}
        ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>Add profile</Button
      >
    {/if}
  </div>

  <ul class="panel">
    {#each profiles.rows as row (row.id)}
      {@const answer = answerOf(row.id)}
      <li class="pr" data-profile={row.id}>
        <div class="id">
          <b class="mono">{row.id}</b>
          <span class="hint">{row.vendorLabel}</span>
        </div>

        <div class="facts">
          <p class="kv">
            <span class="hint">Config folder</span>
            {#if row.folder !== null}<span class="mono">{row.folder}</span>{:else}<span>The tool's default</span>{/if}
          </p>
          <p class="kv"><span class="hint">Nolzu sets</span>{#if row.folder !== null}<span class="mono">{row.variable}</span>{:else}<span>Nothing</span>{/if}</p>
          <p class="hint">{row.where}</p>
          <!-- What a free plan of this vendor can do here. Nothing reports the plan, so the sentence
               is one that holds whatever the person pays. -->
          {#if row.plan !== null}
            <p class="hint" data-plan={row.id}>{row.plan}</p>
          {/if}
        </div>

        <div class="side">
          <!-- The state is a word and never a colour, so a block at its limit reads the same to
               everyone. The attribute carries the same word, for a test and for a style. -->
          <div class="limit" data-limit={row.limit.state} aria-label="Usage limits of {row.id}">
            {#each row.limit.windows as windowLine, at (windowLine)}
              {@const share = row.limit.shares[at] ?? null}
              <p class="lr">{windowLine}</p>
              {#if share !== null}<div class="bar" aria-hidden="true"><i style:width="{Math.min(share, 100)}%"></i></div>{/if}
            {/each}
            <p class="lr">{row.limit.headline}</p>
            <p class="hint">{row.limit.note}</p>
          </div>

          <!-- A login belongs to a profile, so the check sits here. It runs only
               on this press: no load and no timer starts it. -->
          <div class="login" data-login={answer?.state ?? 'none'}>
            {#if row.status !== null}
              <form method="POST" action="?/login" use:enhance={check}>
                <input type="hidden" name="id" value={row.id} />
                <Button size="small" type="submit" aria-label="Check login of {row.id}" aria-busy={checking[row.id] === true} disabled={checking[row.id] === true}>Check login</Button>
              </form>
              {#if checking[row.id] === true}
                <p class="hint" role="status">Running <span class="mono">{row.status}</span></p>
              {:else if answer !== null}
                <p class="res" role="status"><span class="d" aria-hidden="true"></span><span><b>{WORD[answer.state]}</b>, checked <span class="mono">{clock(answer.at)}</span></span></p>
                {#if answer.said !== null}<pre>{answer.said}</pre>{/if}
                {#if answer.state === 'out' && row.signIn !== null}
                  <p class="hint">Sign in there once, in a terminal:</p>
                  {@render commandLine(row.signIn, `Copy the sign-in command of ${row.id}`)}
                {:else if answer.state === 'missing'}
                  <p class="hint">{row.vendorLabel} is not on this machine. Its install line is under Tools.</p>
                {/if}
              {:else}
                <p class="hint">Runs <span class="mono">{row.status}</span> for this folder.</p>
              {/if}
              {#if refusals[row.id] !== undefined}<p class="refused" role="alert">{refusals[row.id]}</p>{/if}
            {:else}
              <p class="hint">{row.vendorLabel} has no login command. It signs in inside its own app.</p>
            {/if}
          </div>
        </div>

        <div class="edit">
          <form method="POST" action="?/profiles" class="rename">
            <input type="hidden" name="do" value="rename" />
            <input type="hidden" name="id" value={row.id} />
            <input class="input" name="label" value={row.label} aria-label="Label of {row.id}" />
            <Button size="small" type="submit" aria-label="Rename {row.id}">Rename</Button>
          </form>
          <form method="POST" action="?/profiles">
            <input type="hidden" name="do" value="remove" />
            <input type="hidden" name="id" value={row.id} />
            <Button size="small" variant="ghost" type="submit" aria-label="Remove {row.id}">Remove</Button>
          </form>
        </div>
      </li>
    {/each}
  </ul>

  {#if chosen !== null}
    <!-- In the page from the start, so a server render and a test see the fields. Add profile shows it. -->
    <form id="add-profile" method="POST" action="?/profiles" class="add" hidden={!adding}>
      <input type="hidden" name="do" value="add" />
      <div class="head">
        <h4>Add a profile</h4>
        <p class="hint">A second login of a tool you have, for example a work account.</p>
      </div>
      <div class="fields">
        <div class="field">
          <label for="add-vendor">Tool</label>
          <select id="add-vendor" class="input" name="vendor" onchange={(event) => (vendor = event.currentTarget.value)}>
            {#each profiles.vendors as one (one.vendor)}
              <option value={one.vendor}>{one.label}</option>
            {/each}
          </select>
        </div>
        <div class="field">
          <label for="add-label">Label</label>
          <input id="add-label" class="input mono" name="label" placeholder="work" bind:value={label} />
          {#if newId !== null}<span class="hint mono">{newId}</span>{/if}
        </div>
        <div class="field grow">
          <label for="add-dir">Config folder</label>
          <div class="ln">
            <input id="add-dir" class="input mono" name="configDir" placeholder="/home/you/.config/work" bind:value={folder} />
            <Button onclick={() => (browsing = !browsing)}>Browse</Button>
          </div>
        </div>
      </div>
      <FolderBrowser bind:open={browsing} onuse={(path) => (folder = path)} />
      <p class="hint">{chosen.hint}</p>
      {#if signIn !== null}
        <p class="hint">In a terminal:</p>
        {@render commandLine(signIn, 'Copy the sign-in command')}
      {/if}
      <div class="ln">
        <Button variant="primary" type="submit">Add profile</Button>
        <Button variant="ghost" onclick={() => (adding = false)}>Cancel</Button>
      </div>
    </form>
  {/if}

  {#if copied !== null}<p class="hint" role="status">{copied}</p>{/if}
  {#if problem !== null}<p class="refused" role="alert">{problem}</p>{/if}
  <p class="hint" role="status">{said}</p>
</section>

<style>
  .profiles {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: var(--space-6);
  }

  .line,
  .ln {
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

  h4 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
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

  .panel {
    margin: 0;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
    list-style: none;
  }

  /* The row: who, where, and the limits with the login beside them. One column when narrow. */
  .pr {
    display: grid;
    grid-template-columns: minmax(0, 190px) minmax(0, 1fr) minmax(0, 290px);
    align-items: start;
    gap: var(--space-3) 24px;
    padding: 16px;
    border-top: 1px solid var(--line);
  }

  .pr:first-child {
    border-top: 0;
  }

  .id,
  .facts,
  .side,
  .limit,
  .login {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }

  .side {
    gap: var(--space-3);
  }

  .id b {
    font-weight: 500;
  }

  .kv {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    gap: 10px;
    margin: 0;
    font-size: var(--text-xs);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
  }

  .hint {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .lr {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  /* Faint and ink-2, as in the rail: a fainter track would be 1.4:1, and amber means a run. */
  .bar {
    height: 4px;
    margin-bottom: 5px;
    border-radius: 99px;
    background: var(--faint);
    overflow: hidden;
  }

  .bar i {
    display: block;
    height: 100%;
    border-radius: 99px;
    background: var(--ink-2);
  }

  .login {
    align-items: flex-start;
  }

  .res {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  .res b {
    font-weight: 500;
    color: var(--ink);
  }

  /* The word says the state, and the dot repeats it: green signed in, red a login or check that failed. */
  .d {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--line-2);
  }

  [data-login='in'] .d {
    background: var(--green);
  }

  [data-login='out'] .d,
  [data-login='failed'] .d {
    background: var(--red);
  }

  pre {
    align-self: stretch;
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

  .inst {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    align-self: stretch;
    min-width: 0;
    padding: 0 3px 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--bg);
  }

  .inst code {
    flex: 1;
    min-width: 0;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
  }

  .edit {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    grid-column: 1 / -1;
  }

  .rename {
    display: flex;
    gap: var(--space-2);
  }

  .input {
    box-sizing: border-box;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  .input.mono {
    font-family: var(--font-mono);
  }

  .add {
    display: flex;
    flex-direction: column;
    gap: 14px;
    margin-top: 4px;
    padding: var(--space-4);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-xl);
    background: var(--card);
  }

  .add[hidden] {
    display: none;
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .fields {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-3);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 160px;
  }

  .field.grow {
    flex: 1;
    min-width: 220px;
  }

  .field.grow .ln {
    flex-wrap: nowrap;
  }

  .field.grow input {
    flex: 1;
    min-width: 0;
  }

  label {
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  .refused {
    margin: 0;
    padding-left: 10px;
    box-shadow: inset 2px 0 0 var(--red);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  @media (max-width: 760px) {
    .pr {
      grid-template-columns: minmax(0, 1fr);
    }

    .field {
      width: 100%;
    }
  }
</style>
