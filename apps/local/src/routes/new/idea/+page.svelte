<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { proposePrefix } from '@nolzu/core';
  import { Button, Chip, Skeleton, StatePill } from '@nolzu/ui';
  import { copyText } from '$lib/clipboard.ts';
  import FolderBrowser from '$lib/FolderBrowser.svelte';
  import { waitForGh } from '$lib/gh-wait.ts';
  import type { GhLogin } from '$lib/new-project.ts';
  import { pageKeys } from '$lib/page-keys.svelte.ts';
  import { carried, folderOf, shownFolder } from '$lib/project-folder.ts';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // New project's idea link carries the name and a typed folder, and the way back carries them again.
  let name = $state(page.url.searchParams.get('name') ?? '');
  // The folder follows the name until it is typed in, as the repository name does.
  let folderTyped = $state<string | null>(page.url.searchParams.get('folder'));
  const typed = $derived(folderTyped ?? folderOf(name));
  let browsing = $state(false);
  const project = $derived(data.made?.name ?? name.trim());
  const folder = $derived(data.made?.path ?? shownFolder(typed));
  // The home folder itself always has files in it, so there is nothing to say yet.
  const goes = $derived(data.made === null && folder !== '' && folder !== '~');
  // Browse picks where the project goes, and the folder of the name goes inside it.
  const browsed = (path: string): void => {
    folderTyped = name.trim() === '' ? path : `${path.replace(/\/+$/, '')}/${folderOf(name).slice(2)}`;
  };
  // The repository takes the project's name until a name of its own is typed.
  let repoTyped = $state<string | null>(null);
  const repo = $derived((repoTyped ?? project).trim());

  // The person's own account first, so it is the one picked until another is.
  let owner = $state('');
  $effect(() => {
    let gone = false;
    void data.owners.then((found) => {
      if (!gone && found !== null && 'owners' in found && !found.owners.includes(owner)) owner = found.owners[0] ?? '';
    });
    return () => {
      gone = true;
    };
  });

  // gh missing or signed out: the login is read again every two seconds, and the page reads the
  // owners again once gh is signed in, so nobody has to reload.
  $effect(() => {
    let stop = (): void => undefined;
    let gone = false;
    data.gh.then(
      (first) => {
        if (gone || first.signedIn) return;
        stop = waitForGh(
          async () => (await (await fetch(resolve('/api/gh'))).json()) as GhLogin,
          (login) => {
            if (login.signedIn) void invalidateAll();
          },
        );
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

  // Whether GitHub has the name, asked once typing pauses. An answer for a name since changed is dropped.
  let checked = $state<{ slug: string; problem: string | null } | null>(null);
  $effect(() => {
    const [who, what] = [owner, repo];
    if (who === '' || what === '') return;
    const timer = setTimeout(async () => {
      const answer = await fetch(`${resolve('/api/gh/name')}?owner=${encodeURIComponent(who)}&name=${encodeURIComponent(what)}`)
        .then((response) => response.json() as Promise<{ problem: string | null }>)
        .catch(() => null);
      if (answer !== null) checked = { slug: `${who}/${what}`, problem: answer.problem };
    }, 400);
    return () => clearTimeout(timer);
  });
  const check = $derived(checked !== null && checked.slug === `${owner}/${repo}` ? checked : null);

  // ⌘↵ presses the button, from any field, through the global `make` key this screen binds too.
  let makeForm = $state<HTMLFormElement | null>(null);
  // The answer waits for the push and the clone, so the button says so meanwhile. The key presses
  // nothing then either: requestSubmit sends the form past a disabled button.
  let creating = $state(false);
  $effect(() => pageKeys.show({ keys: [], actions: { make: () => (creating ? undefined : makeForm?.requestSubmit()) } }));
</script>

<svelte:head><title>Start from an idea · Nolzu</title></svelte:head>

<div class="first">
  <header class="top">
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle class="dot" cx="5" cy="10" r="3.4"></circle>
      <rect x="10.2" y="4" width="1.7" height="12" rx="0.85"></rect>
      <rect x="13.6" y="4" width="1.7" height="12" rx="0.85"></rect>
      <rect x="17" y="4" width="1.7" height="12" rx="0.85"></rect>
    </svg>
    <span class="word">Nolzu</span>
    <!-- No verified display document means no account is signed in on this machine. -->
    {#if data.display.plan === 'free'}<span class="sub plan">Free · runs on this machine only{data.display.id === '' ? ' · no account' : ''}</span>{/if}
  </header>

  <div class="page">
    <form
      class="main"
      method="POST"
      action="?/create"
      bind:this={makeForm}
      use:enhance={() => {
        creating = true;
        return async ({ update }) => {
          await update();
          creating = false;
        };
      }}
    >
      <p class="crumb"><svg class="lock" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"></path></svg>New project <Chip>no code yet</Chip></p>
      <h1>What do you want to build?</h1>
      <p class="lede">Describe it the way you would to a friend. Nolzu turns it into a plan you can read, then into small tasks you approve one by one.</p>

      <div class="field">
        <label for="idea">Your idea</label>
        <textarea id="idea" name="idea" class="input idea" rows="5"></textarea>
      </div>

      <div class="fields">
        <div class="field name">
          <label for="name">Project name</label>
          {#if data.made}
            <input id="name" name="name" class="input mono" value={data.made.name} readonly />
          {:else}
            <input id="name" name="name" class="input mono" bind:value={name} autocomplete="off" />
          {/if}
        </div>
        <div class="field where">
          <label for="folder">Folder</label>
          <div class="with">
            {#if data.made}
              <input id="folder" name="folder" class="input mono" value={data.made.path} readonly />
            {:else}
              <input id="folder" name="folder" class="input mono" value={typed} oninput={(event) => (folderTyped = event.currentTarget.value)} autocomplete="off" aria-describedby={goes ? 'goes' : undefined} />
            {/if}
            <Button disabled={data.made !== null} aria-expanded={browsing} onclick={() => (browsing = !browsing)}>Browse</Button>
          </div>
        </div>
      </div>
      {#if data.made}
        <p class="sub">
          Nolzu made <span class="mono">{data.made.path}</span> already, so the new repository goes into it. Its other repositories are on
          <a class="link" href={resolve('/new')}>New project</a>.
        </p>
      {:else if goes}
        <p class="sub" id="goes">Goes in <span class="mono">{folder}</span>. Nolzu makes the folder if it is not there.</p>
      {/if}
      <FolderBrowser bind:open={browsing} onuse={browsed} />

      <div class="field">
        <label for="decided">Anything already decided? <span class="muted">Optional</span></label>
        <input id="decided" name="decided" class="input" placeholder="For example: SvelteKit, Postgres, must be free to host" autocomplete="off" />
      </div>

      <div class="field">
        <span class="label">Repository</span>
        {#await data.owners}
          <Skeleton shape="line" width="200px" label="Reading your GitHub account." />
        {:then owners}
          {#if owners === null}
            {#await data.gh then gh}
              {#if gh.found}
                <p class="said">gh is not signed in. Sign in with this command in a terminal.</p>
              {:else}
                <p class="said">gh is not on this machine. Get it from <a class="link" href="https://cli.github.com/" target="_blank" rel="noopener noreferrer">cli.github.com</a>, then sign in with this command in a terminal.</p>
              {/if}
            {/await}
            <div class="cmd"><code class="mono">gh auth login</code> <Button size="small" variant="ghost" aria-label="Copy gh auth login" onclick={copyLogin}>Copy</Button></div>
            {#if copied !== null}<p class="sub" role="status">{copied}</p>{/if}
            <p class="sub">This page moves on by itself once gh is signed in.</p>
          {:else if 'problem' in owners}
            <p class="refused">{owners.problem}</p>
          {:else}
            <div class="repo">
              <select class="input mono owner" name="owner" aria-label="Owner" bind:value={owner}>
                {#each owners.owners as one (one)}<option value={one}>{one}</option>{/each}
              </select>
              <span class="muted slash" aria-hidden="true">/</span>
              <input class="input mono" name="repo" aria-label="Repository name" value={repo} oninput={(event) => (repoTyped = event.currentTarget.value)} autocomplete="off" />
              {#if check !== null && check.problem === null}<StatePill state="ready" word="Available" />{/if}
              <Chip
                ><svg class="lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg
                >Private</Chip
              >
            </div>
            {#if check !== null && check.problem !== null}<p class="said" role="status">{check.problem}</p>{/if}
            <!-- A private repository of an organisation is open to the people it gives access. -->
            <p class="sub">Created on GitHub with your gh login when you press the button. {owner === owners.owners[0] ? 'Only you can see it.' : `Only people ${owner} gives access to can see it.`}</p>
          {/if}
        {/await}
      </div>

      {#if form?.message}<p class="refused" role="alert">{form.message} {#if form.waiting}<a class="link" href={resolve('/new')}>Open New project</a>{/if}</p>{/if}
      <div class="go">
        <Button type="submit" variant="primary" size="large" key="⌘↵" aria-keyshortcuts="Meta+Enter Control+Enter" disabled={creating} aria-busy={creating}
          >{creating ? 'Creating the repository and the project' : 'Create the repository and the project'}</Button
        >
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- carried() takes the resolve()d route and adds the query -->
        <a class="alt" href={carried(resolve('/new'), name, folderTyped)}>I have repositories already</a>
      </div>
    </form>

    <aside>
      <h2>What happens next</h2>
      <ol class="steps">
        <li>
          <span class="no mono" aria-hidden="true">1</span>
          <div>
            <b>A private repository</b>
            <p>
              Nolzu creates {#if owner !== '' && repo !== ''}<code class="mono">github.com/{owner}/{repo}</code>{:else}a private repository on GitHub{/if} with a first commit,
              and clones it into {#if project !== ''}<code class="mono">{folder}</code>{:else}the project folder{/if}.
            </p>
          </div>
        </li>
        <li>
          <span class="no mono" aria-hidden="true">2</span>
          <div>
            <b>Your idea becomes a card</b>
            <!-- Limit: the key from the name, which is the key on a first run. A later project whose prefix an earlier one used gets a higher number, and the board shows the real one. -->
            <p>It lands as {#if project !== ''}<span class="mono">{proposePrefix(project)}-1</span>{:else}the first card{/if} on the Epics board, the board for big things.</p>
          </div>
        </li>
        <li>
          <span class="no mono" aria-hidden="true">3</span>
          <div>
            <b>You drag it to Refine</b>
            <p>The agent asks what it needs to know and writes the idea down clearly. {#if data.refine !== null}<span class="mono">{data.refine.charAt(0).toUpperCase()}{data.refine.slice(1)}.</span>{/if}</p>
          </div>
        </li>
        <li>
          <span class="no mono" aria-hidden="true">4</span>
          <div>
            <b>A plan you can read</b>
            <p>Plan and Architecture write a short plan and the first tasks, each in plain words.</p>
          </div>
        </li>
      </ol>
      <p class="foot">
        <svg class="lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>
        No code is written until you drag a task to Implement.
      </p>
    </aside>
  </div>
</div>

<style>
  /* The frame of New project: no rail, a header, then one page of at most 1180px. Nothing here is
     amber, because nothing on this page starts an agent. */
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

  .top svg {
    flex: none;
    width: 20px;
    height: 20px;
    fill: currentColor;
  }

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
    padding: 64px 32px 48px;
  }

  .main {
    display: flex;
    flex: 999 1 560px;
    flex-direction: column;
    gap: 22px;
    min-width: 0;
  }

  .crumb {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
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

  .sub {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .said {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-sm);
  }

  .muted {
    color: var(--muted);
    font-weight: 400;
  }

  .mono {
    font-family: var(--font-mono);
  }

  .refused {
    margin: 0;
    color: var(--red);
    font-size: var(--text-sm);
  }

  .link {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 2px;
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

  .field label,
  .label {
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

  .input::placeholder {
    color: var(--muted);
  }

  .idea {
    height: auto;
    min-height: 150px;
    padding: 12px 14px;
    font-size: 17px;
    line-height: 1.5;
    resize: vertical;
  }

  .repo {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .repo .input {
    width: 220px;
    height: 34px;
  }

  .repo .owner {
    width: auto;
  }

  .slash {
    font-size: 18px;
  }

  .lock {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  code {
    font-size: var(--mono-xs);
  }

  .cmd {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .cmd code {
    padding: 3px 8px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--ink);
  }

  .go {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-2);
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

  /* The first run's side column is 400px. */
  aside {
    flex: 1 1 340px;
    min-width: 0;
    max-width: 400px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  h2 {
    margin: 0;
    padding: var(--space-4) 18px var(--space-3);
    border-bottom: 1px solid var(--line);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .steps {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .steps li {
    display: flex;
    gap: 14px;
    padding: var(--space-4) 18px;
    border-top: 1px solid var(--line);
  }

  .steps li:first-child {
    border-top: 0;
  }

  /* The ring is drawn in line-2, which is no text, and the number inside it is ink-2. */
  .no {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--line-2);
    color: var(--ink-2);
    font-size: var(--mono-xs);
  }

  .steps b {
    display: block;
    margin-bottom: 3px;
    font-size: var(--text-card-title);
    font-weight: 600;
  }

  .steps p {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-3) 18px;
    border-top: 1px solid var(--line);
    color: var(--ink-2);
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
  }
</style>
