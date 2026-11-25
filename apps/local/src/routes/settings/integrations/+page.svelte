<script lang="ts">
  import { Button, Dialog, Skeleton } from '@nolzu/ui';
  import { tick } from 'svelte';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { settingsTitle } from '$lib/settings-sections.ts';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // A stored site is an https origin, so the host is what a person recognises.
  const host = $derived(data.jira.site?.replace(/^https:\/\//, '') ?? null);
  const connected = $derived(host !== null && data.jira.email !== null);
  const refused = $derived(form?.field === 'jira' && 'message' in form ? form : null);
  const unplugged = $derived(form?.field === 'disconnect' && 'message' in form ? form.message : null);

  // The three fields open on Connect or Edit, and on a refusal, so the message sits under what was typed.
  // Cancel closes them over a refusal too, until the next one.
  let editing = $state(false);
  let cancelled = $state<unknown>(null);
  const open = $derived(editing || (refused !== null && refused !== cancelled));
  let asking = $state(false);
  let shell = $state<ReturnType<typeof Dialog>>();
  let unplug = $state<HTMLFormElement>();

  // No reset: a refused form keeps what was typed. A saved one closes, and the token box empties with it.
  const saved: SubmitFunction = () => {
    return async ({ result, update }) => {
      await update({ reset: false });
      if (result.type === 'success') {
        editing = false;
        await focusJira();
      }
    };
  };

  // The button pressed goes away on a save or a Disconnect, so the focus goes to the Jira row's first
  // button and not to the top of the page.
  async function focusJira(): Promise<void> {
    await tick();
    document.querySelector<HTMLElement>('[data-integration="jira"] .actions button')?.focus();
  }

  // The button that opened the fields goes away, so the focus moves to the first field.
  async function edit(): Promise<void> {
    editing = true;
    await tick();
    document.getElementById('jira-site')?.focus();
  }

  function disconnect(event: MouseEvent): void {
    // Without JavaScript the button posts at once. With it, the dialog asks first.
    event.preventDefault();
    asking = true;
  }
</script>

<svelte:head><title>{settingsTitle('integrations')}</title></svelte:head>

<!-- Its own route, because these logins are the machine's and not one project's. Which ticket system a
     project reads stays on its Tickets line on Settings, Project. -->
<section class="section" id="integrations" aria-labelledby="integrations-title">
  <header class="section-head">
    <h2 id="integrations-title">Integrations</h2>
    <p>The logins this machine has to outside services. Every project on this machine uses them.</p>
  </header>

  <section class="box" aria-labelledby="logins-title">
    <header><h3 id="logins-title">Logins</h3></header>

    <div class="row" data-integration="github">
      <span class="name">GitHub</span>
      <div class="value">
        {#await data.gh}
          <Skeleton shape="line" width="160px" label="Checking the gh login." />
        {:then gh}
          {#if gh.signedIn}
            <span>{gh.account === null ? 'Signed in with gh' : 'Signed in with gh as'} {#if gh.account !== null}<span class="mono">{gh.account}</span>{/if}</span>
          {:else if gh.found}
            <span>Not signed in. Run <code>gh auth login</code> in a terminal.</span>
          {:else}
            <span>gh is not installed. Install the GitHub CLI, then run <code>gh auth login</code>.</span>
          {/if}
        {/await}
        <span class="quiet">Nolzu uses the gh login to clone, push and open pull requests, and never changes it.</span>
      </div>
    </div>

    <div class="row" data-integration="jira">
      <span class="name">Jira</span>
      <div class="value">
        {#if connected}
          <span>Connected to <span class="mono">{host}</span> as <span class="mono">{data.jira.email}</span></span>
        {:else}
          <span>Not connected</span>
        {/if}
        <span class="quiet">Nolzu reads a ticket's title and text when you add its key or link, and writes nothing to Jira. Each project picks on Settings, Project whether it reads Jira.</span>
        {#if unplugged !== null}<p class="refused" role="alert">{unplugged}</p>{/if}
      </div>
      <div class="actions">
        {#if !open}
          <Button size="small" onclick={edit}>{connected ? 'Edit' : 'Connect'}</Button>
        {/if}
        {#if connected}
          <form method="POST" action="?/disconnect" bind:this={unplug} use:enhance={() => async ({ update }) => { asking = false; await update(); await focusJira(); }}>
            <Button size="small" type="submit" onclick={disconnect}>Disconnect</Button>
          </form>
        {/if}
      </div>
    </div>

    {#if open}
      <form method="POST" action="?/jira" class="fields" id="jira-fields" data-jira-form use:enhance={saved}>
        <label for="jira-site">Jira site address</label>
        <input id="jira-site" name="site" value={refused?.site ?? data.jira.site ?? ''} placeholder="https://your-site.atlassian.net" autocomplete="off" />
        <label for="jira-email">Account email</label>
        <input id="jira-email" name="email" value={refused?.email ?? data.jira.email ?? ''} placeholder="you@example.com" autocomplete="off" />
        <label for="jira-token">API token</label>
        <div>
          <input id="jira-token" name="token" type="password" autocomplete="new-password" aria-describedby="jira-token-help" />
          <p class="quiet" id="jira-token-help">
            {connected ? 'Leave it empty to keep the token you saved, for the same site. A new site needs the token again. A new one replaces it.' : 'Create one for that email in your Atlassian account.'} The token goes in this machine's keychain and never into the database.
          </p>
        </div>
        {#if refused !== null}<p class="refused span" role="alert">{refused.message}</p>{/if}
        <div class="span buttons">
          <Button type="submit" variant="primary">{connected ? 'Save' : 'Connect Jira'}</Button>
          <Button onclick={() => ((editing = false), (cancelled = refused))}>Cancel</Button>
        </div>
      </form>
    {/if}
    <!-- No time tracker row: those logins go with Evidence, which is off in this version. -->
  </section>
</section>

{#if asking}
  <Dialog bind:this={shell} title="Disconnect Jira?" sub="Projects set to read Jira cannot read it until you connect again." onclose={() => (asking = false)} data-disconnect-confirm>
    <p class="said">Nolzu removes the API token from this machine's keychain and forgets the site and the email. Cards already added from Jira stay.</p>
    <!-- The focus starts on Keep it, so a stray Enter keeps the login. -->
    {#snippet footer()}
      <Button variant="danger" onclick={() => unplug?.requestSubmit()} data-disconnect-go>Disconnect</Button>
      <Button autofocus onclick={() => shell?.close()}>Keep it</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* The box of Settings, Project, so the pages read alike. A container, so a narrow box stacks. */
  .box {
    container-type: inline-size;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .box > header {
    display: flex;
    align-items: center;
    min-height: 44px;
    box-sizing: border-box;
    padding: 6px 14px;
    border-bottom: 1px solid var(--line);
  }

  h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
  }

  .row {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr) auto;
    gap: 4px 20px;
    align-items: start;
    padding: 12px 14px;
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .box > header + .row {
    border-top: 0;
  }

  .name {
    font-weight: 500;
    color: var(--ink);
  }

  .value {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .actions {
    display: flex;
    gap: 8px;
  }

  .fields {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 10px 20px;
    align-items: baseline;
    padding: 0 14px 14px;
    font-size: var(--text-sm);
  }

  .fields label {
    color: var(--ink);
  }

  .fields input {
    box-sizing: border-box;
    width: 100%;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
  }

  .fields input:focus-visible {
    outline: 2px solid var(--blue);
    outline-offset: 1px;
  }

  .span {
    grid-column: 2;
  }

  .buttons {
    display: flex;
    gap: 8px;
  }

  /* The muted token and not an opacity: faint text loses the contrast rule. */
  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  /* As on Settings, Project: the red is the edge, and the words stay ink for the contrast rule. */
  .refused {
    margin: 0;
    padding: 4px 8px;
    border-left: 2px solid var(--red);
    background: var(--card);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  .said {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--ink-2);
  }

  .mono,
  code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink);
  }

  /* Narrow: the name, the value and the buttons stack, and so do the fields with their labels. */
  @container (max-width: 600px) {
    .row,
    .fields {
      grid-template-columns: minmax(0, 1fr);
    }

    .span {
      grid-column: 1;
    }
  }
</style>
