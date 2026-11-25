<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { Button, Chip, engineRows, Skeleton } from '@nolzu/ui';
  import type { CloneJob } from '$lib/add-repo.ts';
  import { copyText } from '$lib/clipboard.ts';
  import FolderBrowser from '$lib/FolderBrowser.svelte';
  import { waitForGh } from '$lib/gh-wait.ts';
  import type { GhLogin } from '$lib/new-project.ts';
  import NoAgentTool from '$lib/NoAgentTool.svelte';
  import { pageKeys } from '$lib/page-keys.svelte.ts';
  import { carried, folderOf, shownFolder } from '$lib/project-folder.ts';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // No agent tool yet: the main column asks for one first and moves on by itself once a look finds one.
  // The load runs again then, so This machine shows what the check finds.
  let toolSeen = $state(false);
  const waiting = $derived(Boolean(data.tools) && !toolSeen);
  const toolFound = (): void => {
    toolSeen = true;
    void invalidateAll();
  };

  // Outside every form, so a post sends them as hidden fields and a reset leaves them as typed. The
  // idea page's way back carries both, so they start as typed there.
  let name = $state(page.url.searchParams.get('name') ?? '');
  // The folder follows the name until it is typed in.
  let folderTyped = $state<string | null>(page.url.searchParams.get('folder'));
  const folder = $derived(folderTyped ?? folderOf(name));
  const shown = $derived(shownFolder(folder));
  // The home folder itself always has files in it, so there is nothing to say yet.
  const goes = $derived(shown !== '' && shown !== '~');
  // Browse picks where the project goes, and the folder of the name goes inside it.
  const browsed = (path: string): void => {
    folderTyped = name.trim() === '' ? path : `${path.replace(/\/+$/, '')}/${folderOf(name).slice(2)}`;
  };

  // The clones from `/api/clones`, the whole list on every change. A clone that ended added a
  // repository, so the project is read again.
  let jobs = $state<CloneJob[]>([]);
  $effect(() => {
    const events = new EventSource(resolve('/api/clones'));
    events.onmessage = (event: MessageEvent<string>) => {
      const next = JSON.parse(event.data) as CloneJob[];
      if (next.some((job) => job.state === 'added' && !jobs.some((old) => old.id === job.id && old.state === 'added'))) void invalidateAll();
      jobs = next;
    };
    return () => events.close();
  });
  const listed = $derived(data.made?.repos ?? []);
  // A clone that waits, runs or failed. One that was added is a row of the list after the reload, and
  // its job stays in memory, so after a Remove it must not come back. A new try takes the place of
  // one that failed.
  const pending = $derived(jobs.filter((job) => job.state !== 'added' && !listed.some((repo) => repo.name.toLowerCase() === job.name.toLowerCase())));
  // A remote found on this machine that is a row already, or a clone on its way. A second Add would
  // only collide with it.
  const taken = (url: string): boolean => listed.some((repo) => repo.url === url) || pending.some((job) => job.state !== 'failed' && job.url === url);

  let browsing = $state(false);

  // The base branch each row's select shows. Save posts it, and not the change, because arrow keys
  // step a select one branch at a time and each branch only origin has gets a local one on save. Make
  // the project sends every pick not saved yet, so pressing it first loses none.
  let picked = $state<Record<string, string>>({});

  // ⌘↵ presses Make the project, from any field. The key is a global one of the registry, and this
  // screen is the one that binds it.
  let makeForm = $state<HTMLFormElement | null>(null);
  // Make writes the workspace and its first commit, so the button holds until the answer comes and a
  // second press, or Cmd Enter, sends nothing.
  let making = $state(false);
  $effect(() => pageKeys.show({ keys: [], actions: { make: () => (making ? undefined : makeForm?.requestSubmit()) } }));

  // gh missing or signed out: the page reads the login again every two seconds and moves on by itself
  // once gh is signed in, so nobody has to reload.
  let ghNow = $state<GhLogin | null>(null);
  $effect(() => {
    let stop = (): void => undefined;
    let gone = false;
    ghNow = null;
    data.gh.then(
      (first) => {
        if (!gone && !first.signedIn) stop = waitForGh(async () => (await (await fetch(resolve('/api/gh'))).json()) as GhLogin, (login) => (ghNow = login));
      },
      () => undefined,
    );
    return () => {
      gone = true;
      stop();
    };
  });
  let copied = $state<string | null>(null);
  const copyLogin = async (): Promise<void> => {
    copied = (await copyText('gh auth login')) ? 'Copied.' : 'The browser did not copy it. Select the command and copy it by hand.';
  };

  // Put on GitHub waits for the push before it answers, so its button says so meanwhile.
  let putting = $state<string | null>(null);

  const percent = (job: CloneJob): number => job.progress?.percent ?? 0;
  // What follows each tool not found: a comma, "and" before the last, and the end of the sentence.
  const joined = (at: number, count: number): string => (at === count - 1 ? ' not found.' : at === count - 2 ? ' and ' : ', ');
</script>

<svelte:head><title>New project · Nolzu</title></svelte:head>

<div class="first">
  <header class="top">
    {#snippet logo()}
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle class="dot" cx="5" cy="10" r="3.4"></circle>
        <rect x="10.2" y="4" width="1.7" height="12" rx="0.85"></rect>
        <rect x="13.6" y="4" width="1.7" height="12" rx="0.85"></rect>
        <rect x="17" y="4" width="1.7" height="12" rx="0.85"></rect>
      </svg>
      <span class="word">Nolzu</span>
    {/snippet}
    <!-- A later project, before its first Add: the screen has no rail, so the logo is the way back. -->
    {#if !data.first && data.made === null}
      <a class="home" href={resolve('/')} aria-label="Back to Now">{@render logo()}</a>
    {:else}
      {@render logo()}
    {/if}
    <!-- No verified display document means no account is signed in on this machine. -->
    {#if data.display.plan === 'free'}<span class="sub plan">Free · runs on this machine only{data.display.id === '' ? ' · no account' : ''}</span>{/if}
  </header>

  <div class="page">
    <section class="main">
      {#if waiting && data.tools}
        <NoAgentTool tools={data.tools} here={data.everyPhase} found={data.found} onfound={toolFound} />
      {:else}
      <p class="sub">1 of 2 · then the first task</p>
      <h1>{data.first ? 'Make your first project' : 'New project'}</h1>
      <p class="lede">
        A project is a workspace: one folder that holds your repositories. Agents work in their own copies inside it, never
        in a checkout you use.
      </p>

      <div class="fields">
        <div class="field name">
          <label for="name">Project name</label>
          {#if data.made}
            <input id="name" class="input" value={data.made.name} readonly />
          {:else}
            <input id="name" class="input" bind:value={name} autocomplete="off" />
          {/if}
        </div>
        <div class="field where">
          <label for="folder">Folder</label>
          <div class="with">
            {#if data.made}
              <input id="folder" class="input mono" value={data.made.path} readonly />
            {:else}
              <input id="folder" class="input mono" value={folder} oninput={(event) => (folderTyped = event.currentTarget.value)} autocomplete="off" aria-describedby={goes ? 'goes' : undefined} />
            {/if}
            <Button disabled={data.made !== null} aria-expanded={browsing} onclick={() => (browsing = !browsing)}>Browse</Button>
          </div>
        </div>
      </div>
      {#if data.made}
        <p class="sub" id="made">Nolzu made <span class="mono">{data.made.path}</span>.</p>
      {:else if goes}
        <p class="sub" id="goes">Goes in <span class="mono">{shown}</span>. Nolzu makes the folder if it is not there.</p>
      {/if}
      <FolderBrowser bind:open={browsing} onuse={browsed} />

      <div class="repos">
        <div class="head">
          <h2>Repositories <span class="n mono">{listed.length + pending.filter((job) => job.state !== 'failed').length}</span></h2>
          <span class="sub">Cloned into the workspace. Add or remove them later.</span>
        </div>
        <div class="panel">
          {#each listed as repo (repo.name)}
            <div class="rp">
              <span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"></path></svg></span>
              <b class="mono" title={repo.name}>{repo.name}</b>
              <span class="u mono">{repo.url ?? 'no remote in the list'}</span>
              {#if repo.branches.length > 0}
                {@const choices = repo.branches.includes(repo.base) ? repo.branches : [repo.base, ...repo.branches]}
                {@const pick = picked[repo.name] ?? repo.base}
                <!-- No reset: a reset puts the select back on its first branch while the row stores the pick. -->
                <form class="base" method="POST" action="?/base" use:enhance={() => async ({ update }) => update({ reset: false })}>
                  <input type="hidden" name="repo" value={repo.name} />
                  <select name="base" class="input mono" aria-label="Base branch of {repo.name}" onchange={(event) => (picked[repo.name] = event.currentTarget.value)}>
                    {#each choices as branch (branch)}<option value={branch} selected={branch === pick}>{branch}</option>{/each}
                  </select>
                  {#if pick !== repo.base}<Button type="submit" size="small">Save</Button>{/if}
                </form>
              {:else}
                <Chip mono>{repo.base}</Chip>
              {/if}
              <form method="POST" action="?/remove" use:enhance>
                <input type="hidden" name="repo" value={repo.name} />
                <Button type="submit" variant="ghost" size="small" aria-label="Remove {repo.name}">Remove</Button>
              </form>
            </div>
          {/each}
          {#each pending as job (job.id)}
            <div class="rp" data-state={job.state}>
              {#if job.state === 'failed'}
                <span class="mark bad" aria-hidden="true">!</span>
              {:else}
                <span class="mark" aria-hidden="true"></span>
              {/if}
              <b class="mono" title={job.name}>{job.name}</b>
              <span class="grow">
                <span class="u mono">{job.url}</span>
                {#if job.state === 'cloning'}<span class="bar" aria-hidden="true"><i style:width="{percent(job)}%"></i></span>{/if}
                {#if job.state === 'failed' && job.said !== null}<span class="said">{job.said}</span>{/if}
              </span>
              <span class="mono state">{job.state === 'cloning' ? `cloning ${percent(job)}%` : job.state}</span>
              {#if job.state === 'waiting' || job.state === 'cloning'}
                <form method="POST" action="?/stop" use:enhance>
                  <input type="hidden" name="id" value={job.id} />
                  <Button type="submit" variant="ghost" size="small" aria-label="Stop cloning {job.name}">Stop</Button>
                </form>
              {:else}
                <span></span>
              {/if}
            </div>
          {/each}
          <form class="add" method="POST" action="?/add" use:enhance>
            <input type="hidden" name="name" value={name} />
            <input type="hidden" name="folder" value={folder} />
            <label for="url" class="hidden">Git URL</label>
            <input id="url" name="url" class="input mono" placeholder="Paste a git URL: https://... or git@..." autocomplete="off" />
            <Button type="submit">Add</Button>
          </form>
        </div>

        {#snippet machineHead()}
          <div class="mh">
            <h3>On this machine</h3>
            <span class="sub">git repositories found in ~/code, ~/projects and ~/src</span>
          </div>
        {/snippet}
        <!-- Drawn only when the look finds a repository: an empty box only says there is nothing to add. -->
        {#await data.machine}
          <div class="panel machine">
            {@render machineHead()}
            <Skeleton shape="rows" count={2} label="Looking for repositories." />
          </div>
        {:then found}
          <!-- The workspace being made sits in ~/code too when that is its location. -->
          {@const repos = found.filter((repo) => repo.path !== data.made?.path)}
          {#if repos.length > 0}
          <div class="panel machine">
            {@render machineHead()}
            {#each repos as repo, at (repo.path)}
              <div class="sg">
                <span class="mono rn" title={repo.path}>{repo.path}</span>
                {#if repo.url === null}
                  {@const said = `branches-${at}`}
                  <span class="grow">
                    <span class="muted">no remote yet</span>
                    <span class="sub" id={said}>Pushes the branch you are on. Branches never pushed stay only in your folder.</span>
                  </span>
                  <form
                    method="POST"
                    action="?/github"
                    use:enhance={() => {
                      putting = repo.path;
                      return async ({ update }) => {
                        await update();
                        putting = null;
                      };
                    }}
                  >
                    <input type="hidden" name="name" value={name} />
                    <input type="hidden" name="folder" value={folder} />
                    <input type="hidden" name="path" value={repo.path} />
                    <Button type="submit" size="small" disabled={putting !== null} aria-busy={putting === repo.path} aria-label="Put {repo.path} on GitHub" aria-describedby={said}
                      >{putting === repo.path ? 'Putting on GitHub' : 'Put on GitHub'}</Button
                    >
                  </form>
                {:else if taken(repo.url)}
                  <span class="mono muted u" title={repo.url}>{repo.url}</span>
                  <span class="mono state">added</span>
                {:else}
                  <span class="mono muted u" title={repo.url}>{repo.url}</span>
                  <form method="POST" action="?/add" use:enhance>
                    <input type="hidden" name="name" value={name} />
                    <input type="hidden" name="folder" value={folder} />
                    <input type="hidden" name="url" value={repo.url} />
                    <Button type="submit" size="small" aria-label="Add {repo.path}">Add</Button>
                  </form>
                {/if}
              </div>
            {/each}
            <p class="sub pad foot">Add makes a fresh clone from the remote. A repository with no remote first goes to a new private GitHub repository. Your own folder stays as it is.</p>
          </div>
          {/if}
        {/await}
        {#if form?.message}<p class="refused" role="alert">{form.message}</p>{/if}
        {#if form && 'removed' in form && typeof form.removed === 'string'}<p class="sub" role="status">{form.removed}</p>{/if}
        {#if form && 'based' in form && typeof form.based === 'string'}<p class="sub" role="status">Saved the base branch of {form.based}.</p>{/if}
      </div>

      <form
        class="go"
        method="POST"
        action="?/make"
        use:enhance={() => {
          making = true;
          return async ({ update }) => {
            await update();
            making = false;
          };
        }}
        bind:this={makeForm}
      >
        {#each listed as repo (repo.name)}
          {#if picked[repo.name] !== undefined && picked[repo.name] !== repo.base}<input type="hidden" name="base:{repo.name}" value={picked[repo.name]} />{/if}
        {/each}
        <Button type="submit" variant="primary" size="large" key="⌘↵" aria-keyshortcuts="Meta+Enter Control+Enter" disabled={making} aria-busy={making}>Make the project</Button>
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- carried() takes the resolve()d route and adds the query -->
        <a class="alt" href={carried(resolve('/new/idea'), name, folderTyped)}>No code yet? Start from an idea</a>
        {#if listed.length === 0}<span class="sub">A project needs at least one repository.</span>{/if}
      </form>
      {/if}
    </section>

    <aside>
      <div class="panel">
        <h2 class="mt">This machine</h2>
        <div class="fr">
          {#await data.engines}
            <span class="check off" aria-hidden="true"></span>
            <div><div class="k">Agent tools</div><div class="x"><Skeleton shape="line" width="160px" label="Checking the agent tools on this machine." /></div></div>
          {:then found}
            {@const rows = engineRows(found)}
            {@const there = rows.filter((row) => row.word !== 'not found')}
            {@const missing = rows.filter((row) => row.word === 'not found')}
            <span class={['check', there.length === 0 && 'off']} aria-hidden="true">{#if there.length > 0}<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"></path></svg>{/if}</span>
            <div class="grow">
              <div class="k">Agent tools</div>
              {#each there as row (row.engine)}
                <div class="v">{row.label} {#if row.version !== null}<span class="mono muted small">{row.version}</span>{/if} {#if row.word === 'check failed'}<span class="bad small">check failed</span>{/if}</div>
              {:else}
                <div class="v">No agent tool found yet.</div>
              {/each}
              {#if missing.length > 0}
                <div class="x">
                  {#each missing as row, at (row.engine)}
                    <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the tool maker's page, not a route of this app -->
                    <a class="link" href={row.install} target="_blank" rel="noopener noreferrer" aria-label="How to add {row.label}">{row.label}</a>{joined(at, missing.length)}
                  {/each}
                </div>
              {/if}
            </div>
          {:catch}
            <span class="check off" aria-hidden="true"></span>
            <div><div class="k">Agent tools</div><div class="x">The check did not finish. Reload the page to run it again.</div></div>
          {/await}
        </div>
        <div class="fr">
          {#await data.gh}
            <span class="check off" aria-hidden="true"></span>
            <div><div class="k">GitHub</div><div class="x"><Skeleton shape="line" width="120px" label="Checking the gh login." /></div></div>
          {:then loaded}
            {@const gh = ghNow ?? loaded}
            <span class={['check', !gh.signedIn && 'off']} aria-hidden="true">{#if gh.signedIn}<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"></path></svg>{/if}</span>
            <div class="grow">
              <div class="k">GitHub</div>
              {#if gh.signedIn}
                <div class="v">{gh.account === null ? 'gh signed in' : 'gh signed in as'} {#if gh.account !== null}<span class="mono">{gh.account}</span>{/if}</div>
              {:else}
                {#if gh.found}
                  <div class="v">gh is not signed in. Sign in with this command in a terminal.</div>
                {:else}
                  <div class="v">gh is not on this machine. Get it from <a class="link" href="https://cli.github.com/" target="_blank" rel="noopener noreferrer">cli.github.com</a>, then sign in with this command in a terminal.</div>
                {/if}
                <div class="cmd"><code class="mono">gh auth login</code> <Button size="small" variant="ghost" aria-label="Copy gh auth login" onclick={copyLogin}>Copy</Button></div>
                {#if copied !== null}<div class="x" role="status">{copied}</div>{/if}
                <div class="x">This page moves on by itself once gh is signed in.</div>
              {/if}
              <div class="x">Used to open pull requests, which need a GitHub remote. A repository on another host still clones and pushes.</div>
            </div>
          {:catch}
            <span class="check off" aria-hidden="true"></span>
            <div><div class="k">GitHub</div><div class="x">The gh check did not finish. Reload the page to run it again.</div></div>
          {/await}
        </div>
        <p class="stays muted">Code, logins and transcripts stay on this machine.</p>
      </div>
    </aside>
  </div>
</div>

<style>
  /* No rail on the first run: a header, then one page of at most 1180px, centred by its wrapper. */
  .first {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
    background: var(--bg);
  }

  .top {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px 32px;
    border-bottom: 1px solid var(--line);
  }

  .home {
    display: flex;
    align-items: center;
    gap: 10px;
    border-radius: var(--radius-sm);
    color: inherit;
    text-decoration: none;
  }

  .top svg {
    flex: none;
    width: 20px;
    height: 20px;
    fill: currentColor;
  }

  /* Cream and not amber: amber means an agent starts or resumes work, and a logo starts none. */
  .top .dot {
    fill: var(--accent);
  }

  .word {
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.015em;
  }

  .top .plan {
    margin-left: auto;
  }

  .page {
    display: flex;
    align-self: center;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 56px;
    box-sizing: border-box;
    width: 100%;
    max-width: 1180px;
    padding: 56px 32px 48px;
  }

  .main {
    display: flex;
    flex: 999 1 600px;
    flex-direction: column;
    gap: 22px;
    min-width: 0;
  }

  aside {
    display: flex;
    flex: 1 1 340px;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
    max-width: 400px;
  }

  h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: 600;
    line-height: 1.08;
    letter-spacing: -0.035em;
  }

  .lede {
    max-width: 68ch;
    margin: 0;
    color: var(--ink-2);
    font-size: 16px;
    line-height: 1.55;
  }

  h2,
  h3 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .sub {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .muted {
    color: var(--muted);
  }

  .mono {
    font-family: var(--font-mono);
  }

  .small {
    font-size: var(--mono-2xs);
  }

  .bad {
    color: var(--red);
  }

  .refused {
    margin: 0;
    color: var(--red);
    font-size: var(--text-sm);
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .field.name {
    flex: 1 1 200px;
  }

  .field.where {
    flex: 2 1 320px;
  }

  .field label {
    color: var(--ink-2);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  .with {
    display: flex;
    gap: var(--space-2);
  }

  .input {
    box-sizing: border-box;
    width: 100%;
    height: 38px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-base);
  }

  .input.mono {
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
  }

  .input[readonly] {
    color: var(--ink-2);
    background: var(--panel);
  }

  .panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .repos {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 10px;
  }

  .n {
    margin-left: 6px;
    color: var(--muted);
    font-size: var(--mono-xs);
    font-weight: 400;
  }

  /* The name keeps one line and the URL gives up its width first, as in the rows found on this machine. */
  .rp {
    display: grid;
    grid-template-columns: 22px minmax(0, max-content) minmax(8ch, 1fr) auto auto;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .rp b {
    overflow: hidden;
    font-weight: 500;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .base {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  /* One width on every row, so the selects and Remove line up. A long branch name is cut, and the
     open list still shows it whole. */
  .base select {
    width: 140px;
    overflow: hidden;
    text-overflow: ellipsis;
    height: 28px;
    padding: 0 6px;
  }

  .u {
    overflow: hidden;
    color: var(--muted);
    font-size: var(--mono-xs);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .grow {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }

  .said {
    color: var(--red);
    font-size: var(--text-xs);
  }

  .state {
    color: var(--ink-2);
    font-size: var(--mono-2xs);
  }

  [data-state='failed'] .state {
    color: var(--red);
  }

  /* Ink and not amber: a clone is no agent at work. */
  .bar {
    display: block;
    height: 4px;
    overflow: hidden;
    border-radius: 99px;
    background: var(--line-2);
  }

  .bar i {
    display: block;
    height: 100%;
    border-radius: 99px;
    background: var(--ink-3);
  }

  .mark {
    width: 10px;
    height: 10px;
    margin-left: 4px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--ink-3);
  }

  .mark.bad {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin: 0;
    color: var(--red);
    font-size: var(--text-2xs);
    font-weight: 700;
    box-shadow: inset 0 0 0 1.5px var(--red);
  }

  .check {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--green-bg);
    color: var(--green);
  }

  .check svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .check.off {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--line-2);
  }

  .add {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
  }

  .add .input {
    height: 34px;
  }

  .machine {
    background: transparent;
  }

  .mh {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    padding: 10px 14px 6px;
    border-bottom: 1px solid var(--line);
  }

  /* The name takes the width it needs first and the URL gives up its own, so a name breaks at no
     hyphen. The URL keeps a few characters so a narrow screen still shows where it points. */
  .sg {
    display: grid;
    grid-template-columns: minmax(0, max-content) minmax(8ch, 1fr) auto;
    gap: var(--space-3);
    align-items: center;
    padding: 9px 14px;
    border-bottom: 1px solid var(--line);
    font-size: var(--text-xs);
  }

  .pad {
    padding: 8px 14px 10px;
  }

  /* One line, cut with an ellipsis. The title and the text itself still give the full name. */
  .rn {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .go {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-1);
  }

  /* A link drawn as the large ghost button, because it opens a page and posts nothing. */
  .alt {
    display: inline-flex;
    align-items: center;
    height: 42px;
    padding: 0 18px;
    border-radius: var(--radius-lg);
    color: var(--ink-2);
    font-size: var(--text-base);
    text-decoration: none;
  }

  .alt:hover {
    background: var(--card);
    color: var(--ink);
  }

  .mt {
    padding: var(--space-4) 18px var(--space-3);
    border-bottom: 1px solid var(--line);
  }

  .fr {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    padding: 14px 18px;
    border-bottom: 1px solid var(--line);
  }

  .k {
    margin-bottom: 2px;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .v {
    color: var(--ink);
    font-size: var(--text-card-title);
  }

  .v + .v {
    margin-top: 4px;
  }

  .x {
    margin-top: 3px;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  code {
    font-size: var(--mono-xs);
  }

  .cmd {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-top: 6px;
  }

  .cmd code {
    padding: 3px 8px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--ink);
  }

  .link {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .stays {
    margin: 0;
    padding: var(--space-3) 18px;
    font-size: var(--text-xs);
  }

  @media (max-width: 760px) {
    .top {
      padding: 14px 16px;
    }

    .page {
      gap: 32px;
      padding: 28px 16px;
    }

    h1 {
      font-size: 30px;
    }

    .rp {
      display: flex;
      flex-wrap: wrap;
    }

    /* A phone has no room for the name and the URL side by side: the name takes its own line. */
    .sg {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .rn {
      grid-column: 1 / -1;
    }
  }
</style>
