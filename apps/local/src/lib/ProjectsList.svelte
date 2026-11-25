<script lang="ts">
  import { needsContainerDaemon } from '@nolzu/core';
  import { Button, ConfirmTyped, HelpTip, InfoBox, Skeleton, Switch } from '@nolzu/ui';
  import { onMount, type Snippet } from 'svelte';
  import { enhance } from '$app/forms';
  import { resolve } from '$app/paths';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { settingToast } from '$lib/board-page.ts';
  import HandEditedFiles from '$lib/HandEditedFiles.svelte';
  import QaAppEdit from '$lib/QaAppEdit.svelte';
  import { streamed } from '$lib/held-answer.svelte.ts';
  import type { HandEdit, ProjectFilesStatus } from '$lib/onboard.ts';
  import { filesStatusLine, handEditedLine } from '$lib/project-files-notice.ts';
  import type { ProjectRow, RemoveConfirm, RepoRow } from '$lib/projects.ts';
  import Streamed from '$lib/Streamed.svelte';
  import { toastStack } from '$lib/toast-stack.svelte.ts';

  let {
    row,
    table = [],
    refused = null,
    saved = null,
    said = null,
    found = [],
    branches = {},
    filesStatus = null,
    handEdits = [],
    proposal = [],
  }: {
    row: ProjectRow;
    // The rows of the repositories table. A promise, so the page draws before git names each remote.
    table?: Promise<readonly RepoRow[]> | readonly RepoRow[];
    // The field a value was refused on, the sentence it was refused with, and what was typed, so the
    // message prints under the box and the box still holds the value the message is about.
    refused?: { field: string; message: string; ask?: boolean; typed?: string; bill?: { client: string; rate: string; currency: string } } | null;
    saved?: string | null;
    // What the last scan of the project folder found, or what the checkout cleanup did, keyed by
    // the form that asked, so each sentence prints under its own button.
    // `learn` is the repository Add cloned, which the answer offers Learn this project for.
    said?: { field: string; text: string; learn?: string | null } | null;
    // The repositories found on this machine that Add can clone by their remote. A promise, so the page
    // draws before the scan of the home folder ends.
    found?: Promise<readonly { path: string; url: string }[]> | readonly { path: string; url: string }[];
    // The branches origin has for each base branch select, by repository path, `.` for the one field.
    // A promise, so the page draws before git answers.
    branches?: Promise<Readonly<Record<string, readonly string[]>>> | Readonly<Record<string, readonly string[]>>;
    // What Write the project files would update and which files were changed by hand, from the layout.
    filesStatus?: ProjectFilesStatus | null;
    // Those files with their diffs, each with Take the new one and Keep mine. A promise, because git
    // makes each diff.
    handEdits?: Promise<readonly HandEdit[]> | readonly HandEdit[];
    // The commands the repositories propose now that the list does not hold, under Propose again.
    proposal?: readonly string[];
  } = $props();
  // Kept across a reload, so a Save does not drop the selects back to grey while git answers again.
  // A plain map, as a test or a caller with the answer in hand passes, draws at once.
  const streamedBranches = streamed(
    () => (branches instanceof Promise ? branches : null),
    () => 'branches',
  );
  const origin = $derived(branches instanceof Promise ? streamedBranches.current : { ok: true as const, value: branches });
  // Scoped by the list, so a Remove or an Add draws grey rows until the new table lands, never the old rows.
  const streamedTable = streamed(
    () => (table instanceof Promise ? table : null),
    () => (row.repos ?? []).map((repo) => repo.path).join('\n'),
  );
  const rows = $derived(table instanceof Promise ? streamedTable.current : { ok: true as const, value: table });
  const filesLine = $derived(filesStatusLine(filesStatus));
  const handLine = $derived(handEditedLine(filesStatus?.yours.length ?? 0));

  // Each form's last refusal, kept here because the page's answer is only the newest post's: a save in
  // another form would take this one's refusal and its typed value off the screen. The form's own next
  // answer drops it.
  let kept = $state<Record<string, NonNullable<typeof refused>>>({});
  $effect(() => {
    if (refused) kept[refused.field] = refused;
  });
  const refusal = (field: string) => (refused?.field === field ? refused : (kept[field] ?? null));
  const problem = (field: string) => refusal(field)?.message ?? null;
  // The typed value stays on screen when it was refused, so the message is about what a person sees.
  const shown = (field: string, stored: string) => refusal(field)?.typed ?? stored;
  // What each base box holds now. Save shows only once it differs from the stored base, as on New
  // project, so a table of repositories keeps one short line per row.
  let picking = $state<Record<string, string>>({});
  // The Jira site as a host, for the sentences. A stored site is an https origin.
  const jiraHost = $derived(row.jira?.site?.replace(/^https:\/\//, '') ?? null);
  const onJira = $derived(row.ticketSystem === 'jira');
  // The login is the machine's, on Settings, Integrations. A project can read Jira after a Disconnect.
  const jiraConnected = $derived(jiraHost !== null && (row.jira?.email ?? null) !== null);
  // Jira has a project with this prefix as its key, from the last time it was asked.
  const clash = $derived(onJira ? (row.keyClash ?? null) : null);
  const clashLine = $derived(
    clash === null
      ? null
      : `${clash.prefix} is also a Jira project at ${jiraHost}. Jira tickets such as ${clash.prefix}-12 cannot be added while local cards use ${clash.prefix}. Pick another prefix${clash.suggestion === null ? '.' : `, such as ${clash.suggestion}.`}`,
  );
  const repoName = (path: string) => (path === '.' ? 'project folder' : path);
  // The remote without its host, so a narrow column still tells acme/api from acme/web. The title has
  // the host.
  const remotePath = (remote: string) => remote.slice(remote.indexOf('/') + 1) || remote;
  // A folder the manifest names and no list has, which has no base of its own to change yet.
  const listed = $derived(new Set((row.repos ?? []).map((repo) => repo.path)));

  // The repository whose Remove waits on its typed confirm. The confirm sends the row's own form with
  // what the person typed, which the server checks again.
  let removing = $state<string | null>(null);
  // The name typed into each repository's confirm, kept when it closes without a send, so a reopen
  // shows it again. A send takes it away.
  const typedFor = $state<Record<string, string>>({});
  let sending = $state(false);
  // The checks run as the dialog opens, so a commit made after the page loaded counts. The load
  // runs none, because ten git calls per repository kept the page blank. The dialog opens when they land.
  let fresh = $state<Record<string, RemoveConfirm>>({});
  // The repository whose checks failed to answer, so the press does not look like nothing happened.
  let unchecked = $state<string | null>(null);
  function openRemove(repo: string): void {
    removing = repo;
    unchecked = null;
    delete fresh[repo];
    fetch(`${resolve('/api/remove-check')}?repo=${encodeURIComponent(repo)}`)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json() as Promise<RemoveConfirm | null>;
      })
      .then((confirm) => {
        if (confirm !== null) fresh[repo] = confirm;
        else if (removing === repo) removing = null;
      })
      // No answer opens no dialog, so the Checking line goes, a line says so, and Remove can be pressed again.
      .catch(() => {
        if (removing !== repo) return;
        removing = null;
        unchecked = repo;
      });
  }
  const removeForms: Record<string, HTMLFormElement> = {};
  function remove(repo: string, typed: string): void {
    const form = removeForms[repo];
    if (form === undefined) return;
    sending = true;
    delete typedFor[repo];
    (form.elements.namedItem('typed') as HTMLInputElement).value = typed;
    form.requestSubmit();
  }

  // A board's switch posts its form, which holds the state the board goes to. The page owns the state:
  // the switch shows what the answer reads back, so a refused switch springs back.
  const boardForms: Record<string, HTMLFormElement> = {};
  // With JavaScript every form posts in place, so the page stays where the person was and the answer is
  // a toast. No reset: a box keeps what was typed, refused or stored. An Add box (data-clear) empties
  // once its entry is in the list, and the token box once the keychain has it. Without JavaScript each
  // form is still a full page post.
  // The Saved line at the foot is for a page without JavaScript. With it the toast says it, where the
  // person is looking, and the line would stay long after.
  let live = $state(false);
  onMount(() => (live = true));
  // A form on its way takes no second press, and its button says it is busy: Clone, Scan again, Learn
  // and Make this a workspace run git or a run, and a second press would start them twice. Set on the
  // elements themselves, because every form here shares this one function.
  const inPlace: SubmitFunction = ({ formElement, submitter, cancel }) => {
    if (formElement.dataset.pending !== undefined) {
      cancel();
      return;
    }
    formElement.dataset.pending = '';
    submitter?.setAttribute('aria-busy', 'true');
    const done = () => {
      delete formElement.dataset.pending;
      submitter?.removeAttribute('aria-busy');
    };
    return async ({ result, update }) => {
      done();
      if ((result.type === 'success' || result.type === 'failure') && typeof result.data?.field === 'string') delete kept[result.data.field];
      await update({ reset: false });
      // The confirm has done its job either way: the row is gone, or its refusal prints under it.
      removing = null;
      sending = false;
      if (result.type !== 'success' && result.type !== 'failure') return;
      if (result.type === 'success') for (const box of formElement.querySelectorAll<HTMLInputElement>('[data-clear]')) box.value = '';
      // The toast closes by itself, as every toast does, with the longer time for a refusal.
      toastStack.state = settingToast(toastStack.state, result.type === 'failure', result.data);
    };
  };

  // Test the browser starts a server and Chrome, which takes up to two minutes on the first run, so the
  // button says it is busy until the answer comes.
  let testing = $state(false);
  const testingBrowser: SubmitFunction = (input) => {
    testing = true;
    const after = inPlace(input);
    return async (done) => {
      testing = false;
      if (typeof after === 'function') await after(done);
    };
  };

  // The longer word on a label, behind its "?", so the line under the field can stay one sentence. A
  // row the docs say more about links that page.
  const DOCS = 'https://github.com/nolzu/nolzu/blob/main/docs';
  const HELP: Record<string, { text: string; example: string; href?: string }> = {
    localKeyPrefix: {
      text: 'The letters at the start of every card key in this project. A new prefix counts for new cards only. Old cards keep their keys.',
      example: 'APP gives APP-1, APP-2 and so on.',
    },
    branchTemplate: {
      text: 'The name of the branch Nolzu makes for a card. {key} is the card key and has to be in it. {type} is feature, fix or chore, and {desc} two to four words, both from Refine. {slug} is the whole title in short. A slash makes folders. A card is delivered as a pull request from this branch.',
      example: 'feature/{key}/{desc} gives feature/APP-1/search-box.',
    },
    knowledgeDir: {
      text: "The folder that holds this project's knowledge files. Agents read them before they work, and no other project reads them. Leave the box empty for the default folder.",
      example: 'docs/knowledge',
    },
    commands: {
      text: 'With Claude Code, Implement and QA run only these commands, and an empty list allows none. A * at the end allows any arguments. A variable in front needs its value written out. A listed script runs whatever package.json says, and Implement can edit package.json, so allow only what you would run yourself. Cursor runs any command. Codex uses its own sandbox and ignores this list.',
      example: 'pnpm test, npm run *, PORT=4320 npm *',
    },
    app: {
      text: "How QA gets each repository's app: a start command from its package.json, an app you started, your own commands, or the code only. The first card of a repository that enters QA asks. Your own commands run in the card's copy of the repository with no wall, so they can start Docker, and an agent run can change them through Nolzu, so read them before a QA run. An answer for every repository runs once per card, in worktrees/{key} in the project folder.",
      example: 'Own commands: docker compose up -d to start, docker compose down to stop, docker compose ps for the state.',
      href: `${DOCS}/stack-hook/README.md`,
    },
    browser: {
      text: 'QA opens pages in Google Chrome through the Playwright MCP server, to check a change the way a person would. Set up adds the server to the MCP servers of the project, on for QA, and npx downloads it on the first QA run. Claude Code, Codex and Cursor runs get it.',
      example: 'A card changes the sign-in page. QA opens it, signs in and says what it saw.',
    },
    files: {
      text: 'The run guard that holds Refine and Plan to their card folder, the agent rules and the phase skills. The skills go to .agents/skills for Codex and Cursor, and .claude/skills for Claude Code. A file you changed stays as you wrote it.',
      example: 'After a Nolzu update, write them again to get the newer skills.',
    },
    boards: {
      text: 'The boards beside Delivery, each on the rail. An off board leaves the rail. Its cards stay as they are until it is on again, and no run stops.',
      example: 'Turn on Epics to plan a bigger feature and split it into cards.',
    },
    'wall-hidden': {
      text: 'No run can read these, Implement included. A path without ~ or / is read from the project folder.',
      example: '~/secrets',
      href: `${DOCS}/engines/README.md#walls`,
    },
    'wall-exceptions': {
      text: 'The .env files of this project that a run may read, such as one your tests need. Type the path from the project folder.',
      example: '.env.test',
      href: `${DOCS}/engines/README.md#walls`,
    },
    'wall-writable': {
      text: 'Implement and QA may write here, for a build cache. Phases that only read never can.',
      example: '~/.gradle for a Gradle build',
      href: `${DOCS}/engines/README.md#walls`,
    },
  };
</script>

<!-- The label cell of a row: the name, and its "?" where the field needs more than one line. A span when
     the row has no single box to name. -->
{#snippet head(text: string, id: string | null, help: string | null = null)}
  <div class="lb">
    {#if id !== null}<label for={id}>{text}</label>{:else}<span>{text}</span>{/if}{#if help !== null && HELP[help]}<HelpTip label="About {text}" text={HELP[help].text} example={HELP[help].example} href={HELP[help].href} />{/if}
  </div>
{/snippet}

<!-- One form per setting, so a refused value does not take another one down with it. Each one works
     with a full page post, and posts in place with JavaScript. -->
{#snippet setting(name: string, label: string, stored: string, hint: Snippet, placeholder: string | null = null, warning: string | null = null)}
  <form method="POST" action="?/save" class="st" use:enhance={inPlace}>
    <input type="hidden" name="field" value={name} />
    {@render head(label, name, name)}
    <div class="c">
      <div class="line">
        <input id={name} name="value" class="mono" value={shown(name, stored)} placeholder={placeholder ?? undefined} autocomplete="off" aria-describedby="{name}-help" />
        <Button size="small" type="submit">Save</Button>
      </div>
      <p class="quiet" id="{name}-help">{@render hint()}</p>
      {#if warning !== null}<p class="warn" role="status" data-warning={name}>{warning}</p>{/if}
      {#if problem(name)}<p class="refused" role="alert">{problem(name)}</p>{/if}
    </div>
  </form>
{/snippet}

<!-- The base branch picks from what origin has. A stored base origin does not list stays first, so the
     page never shows another one as saved. With no remote branches the box stays a typed one. Save
     posts, not the pick: the page reloads on a post, and arrow keys change a select one step at a time. -->
{#snippet baseInput(name: string, stored: string, repo: string, label: string | null)}
  {@const branches = origin?.ok ? origin.value[repo] : undefined}
  {#if origin === null}
    <Skeleton shape="line" width="160px" label="Reading the branches with git." />
  {:else if branches !== undefined && branches.length > 0}
    {@const choices = branches.includes(stored) ? branches : [stored, ...branches]}
    <select id={name} name="value" class="mono base" aria-label={label ?? undefined} onchange={(event) => (picking[name] = event.currentTarget.value)}>
      {#each choices as branch (branch)}<option value={branch} selected={branch === shown(name, stored)}>{branch}</option>{/each}
    </select>
  {:else}
    <input id={name} name="value" class="mono base" value={shown(name, stored)} autocomplete="off" aria-label={label ?? undefined} oninput={(event) => (picking[name] = event.currentTarget.value)} />
  {/if}
  {#if (picking[name] ?? shown(name, stored)) !== stored}<Button size="small" type="submit">Save</Button>{/if}
{/snippet}

{#snippet baseHint()}The branch every card starts from. It has to be in the repository.{/snippet}

{#snippet prefixHint()}
  <!-- The second sentence as one string with its space: Svelte drops the line break before text in a block. -->
  The next card is <span class="mono">{row.nextKey}</span>.{onJira && clashLine === null ? ' Pick a prefix no Jira project uses, because a key with this prefix reads as a local card.' : ''}
{/snippet}

{#snippet branchHint()}
  {#if row.branchExample !== null}The next card gets <span class="mono">{row.branchExample}</span>.{:else}The name has to hold <span class="mono">{'{key}'}</span>.{/if}
{/snippet}

{#snippet knowledgeHint()}Empty uses the default folder.{/snippet}

<!-- One wall list: each entry is its own form with its remove, and Add sends one entry against the
     list as stored, the way the command chips do. A refused entry stays in the box with the reason. -->
{#snippet wallList(list: 'hidden' | 'exceptions' | 'writable', label: string, items: readonly string[], placeholder: string, help: string)}
  <div class="st" id="wall-{list}">
    {@render head(label, `addWall-${list}`, `wall-${list}`)}
    <div class="c">
      {#if items.length > 0}
        <ul class="cmds">
          {#each items as entry (entry)}
            <li>
              <form method="POST" action="?/save" class="cmd" use:enhance={inPlace}>
                <input type="hidden" name="field" value="removeWall:{list}" />
                <input type="hidden" name="value" value={entry} />
                <span>{entry}</span>
                <button type="submit" aria-label="Remove {entry}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>
              </form>
            </li>
          {/each}
        </ul>
      {/if}
      <form method="POST" action="?/save" class="line" use:enhance={inPlace}>
        <input type="hidden" name="field" value="addWall:{list}" />
        <input id="addWall-{list}" name="value" data-clear class="mono" value={shown(`addWall:${list}`, '')} {placeholder} autocomplete="off" aria-describedby="wall-{list}-help" />
        <Button size="small" type="submit">Add</Button>
      </form>
      {#if problem(`addWall:${list}`)}<p class="refused" role="alert">{problem(`addWall:${list}`)}</p>{/if}
      {#if problem(`removeWall:${list}`)}<p class="refused" role="alert">{problem(`removeWall:${list}`)}</p>{/if}
      <p class="quiet" id="wall-{list}-help">{help}</p>
    </div>
  </div>
{/snippet}

<!-- A refusal that names the git command to run, with the command set as code. -->
{#snippet withCommand(text: string)}
  {#each text.split(/(git push origin [^\s,]+)/) as part, index (index)}{#if index % 2 === 1}<code class="mono">{part}</code>{:else}{part}{/if}{/each}
{/snippet}

{#snippet tick()}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10"></path></svg>{/snippet}

<!-- Every part of the page is a box with its name on top and the rows inside, name left and value
     right. Each box has the id the settings menu lists under Project (PROJECT_BOXES). -->

<!-- The name is the folder's, and the location is read only: moving a workspace would break open
     checkouts and running agents. The file manager is the way to the folder. -->
<section class="box" id="identity" aria-labelledby="identity-title">
  <header><h3 id="identity-title">Name and folder</h3></header>
  <div class="st">
    {@render head('Name', 'project-name')}
    <div class="c"><div class="line keep"><input id="project-name" class="mono wide" value={row.name ?? 'No project set'} readonly /></div></div>
  </div>
  <form method="POST" action="?/reveal" class="st" use:enhance={inPlace}>
    {@render head('Location', 'project-path')}
    <div class="c">
      <div class="line keep">
        <input id="project-path" class="mono wide" value={row.path ?? 'not set'} readonly />
        {#if row.opener !== null && row.path !== null}<Button size="small" type="submit">{row.opener}</Button>{/if}
      </div>
      {#if said?.field === 'reveal'}<p class="quiet" role="status">{said.text}</p>{/if}
      {#if problem('reveal')}<p class="refused" role="alert">{problem('reveal')}</p>{/if}
    </div>
  </form>
</section>

<!-- The rail's Repositories link and old bookmarks of the Projects page land on the title by its old id. -->
<section class="box" id="repositories" aria-labelledby="git-title">
  <header>
    <h3 id="git-title">
      Repositories{#if row.repos !== null && rows?.ok}<span class="n">{rows.value.length}</span>{/if}
    </h3>
    <span class="sp"></span>
    {#if row.repos !== null}
      <form method="POST" action="?/rescan" use:enhance={inPlace}><Button variant="ghost" size="small" type="submit">Scan again</Button></form>
    {/if}
  </header>

  {#if row.repos === null}
    <form method="POST" action="?/save" class="st" use:enhance={inPlace}>
      <input type="hidden" name="field" value="baseBranch" />
      {@render head('Base branch', 'baseBranch')}
      <div class="c">
        <div class="line">{@render baseInput('baseBranch', row.baseBranch, '.', null)}</div>
        <p class="quiet">{@render baseHint()}</p>
        {#if problem('baseBranch')}<p class="refused" role="alert">{problem('baseBranch')}</p>{/if}
      </div>
    </form>
    {#if row.convert !== null}
      <div class="st">
        {@render head('More repositories', null)}
        <div class="c">
          <!-- The coach note on Now links here by the id. -->
          <form method="POST" action="?/convert" class="stack" id="convert" use:enhance={inPlace}>
            <p>
              This project is one repository. Adding another one needs a workspace. The button below makes a new folder with the name you type, and moves this repository into it as
              <span class="mono">{row.convert.folder}</span>. Its branches, cards and knowledge come along.
            </p>
            <label for="convert-parent">Folder the workspace goes in</label>
            <input id="convert-parent" name="parent" autocomplete="off" required />
            <label for="convert-name">Name of the workspace</label>
            <input id="convert-name" name="name" autocomplete="off" required />
            <p class="quiet">
              The engines filed their sessions under <span class="mono">{row.path}</span>, so old sessions cannot be resumed after the move. A card's next run starts a new session.
            </p>
            {#if row.convert.commands.length > 0}
              <p class="quiet">These commands under Start the app were written for <span class="mono">{row.path}</span>. Check their paths after the move:</p>
              <ul class="quiet">
                {#each row.convert.commands as command, index (index)}<li class="mono">{command}</li>{/each}
              </ul>
              <p class="quiet">
                In a workspace, an answer for every repository runs in <span class="mono">worktrees/{'{key}'}</span>, a plain folder that holds the card's checkouts. The repository's checkout is one level
                down, in <span class="mono">{row.convert.folder}</span>. A command that needs the repository's files has to change to that folder first.
              </p>
            {/if}
            <p class="quiet">The new folder has to be on the same disk. Nolzu refuses while a card has a checkout, a run is queued or running, or a knowledge change waits for review.</p>
            <div><Button type="submit">Make this a workspace</Button></div>
            {#if problem('convert')}<p class="refused" role="alert">{problem('convert')}</p>{/if}
          </form>
        </div>
      </div>
    {/if}
  {:else}
    <!-- Three short lines before the table. What Remove checks is in its dialog, where it matters. -->
    <div class="pad">
      <InfoBox>
        <p>
          Add clones a repository into the project folder{row.rootRecords ? ' and records it, so a teammate gets it too' : ''}. Scan again adds one you cloned by hand.
        </p>
        <p>Each repository's cards start from its own base branch.</p>
        <p>Remove checks for unsaved work first, and asks for the name before it deletes the folder.</p>
      </InfoBox>
    </div>
    <!-- The label left and the table right, as every row. The table needs room, so a box narrower
         than 900px puts the label on top (below). -->
    <div class="st table">
      {@render head('In this project', null)}
      <div class="c">
        {#if said?.field === 'rescan'}<p class="quiet" role="status">{said.text}</p>{/if}
        {#if problem('rescan')}<p class="refused" role="alert">{problem('rescan')}</p>{/if}
        {#if said?.field === 'convert'}<p class="quiet" role="status">{said.text}</p>{/if}
        <!-- A step that failed after the move lands here, because the project has its list by then. -->
        {#if problem('convert')}<p class="refused" role="alert">{problem('convert')}</p>{/if}
        <div class="panel">
          <!-- One form per cell, because a form cannot hold a table row. -->
          <table>
            <colgroup><col class="w-folder" /><col /><col class="w-base" /><col class="w-status" /><col class="w-acts" /></colgroup>
            <thead>
              <tr><th scope="col">Folder</th><th scope="col">Remote</th><th scope="col">Base branch</th><th scope="col">Status</th><th scope="col"><span class="sr">Actions</span></th></tr>
            </thead>
            <tbody>
              <!-- Grey rows, one per listed repository, so the table keeps its height when the rows land. -->
              {#if rows === null}
                {#each row.repos ?? [] as repo, index (repo.path)}
                  <tr><td colspan="5"><Skeleton shape="line" width="100%" label={index === 0 ? 'Reading the repositories with git.' : ''} /></td></tr>
                {/each}
              {:else if !rows.ok}
                <tr class="note"><td colspan="5"><p class="refused" role="alert">{rows.message}</p></td></tr>
              {/if}
              {#each rows?.ok ? rows.value : [] as repo (repo.path)}
                {@const name = repoName(repo.path)}
                {@const base = `repoBase:${repo.path}`}
                <tr>
                  <th scope="row" class="mono folder" title={name}>{name}</th>
                  <td class="mono remote" title={repo.remote ?? undefined}>{repo.remote === null ? 'no remote' : remotePath(repo.remote)}</td>
                  <td>
                    {#if listed.has(repo.path)}
                      <form method="POST" action="?/save" class="line" use:enhance={inPlace}>
                        <input type="hidden" name="field" value={base} />
                        {@render baseInput(base, repo.base, repo.path, `Base branch of ${name}`)}
                      </form>
                    {:else}
                      <span class="mono">{repo.base}</span>
                    {/if}
                  </td>
                  <td>
                    {#if repo.onDisk}<span class="ok">{@render tick()}Cloned</span>{:else}<span class="pill">Missing</span>{/if}
                  </td>
                  <td class="acts">
                    <div class="line">
                      <!-- A folder the manifest names and the disk has not got, as a teammate who cloned the workspace finds it. -->
                      {#if repo.clone}
                        <form method="POST" action="?/clone" use:enhance={inPlace}>
                          <input type="hidden" name="folder" value={repo.path} />
                          <Button size="small" type="submit" aria-label="Clone {name}">Clone</Button>
                        </form>
                      {/if}
                      <!-- The project folder always stays. The last repository stays too, except in a workspace.
                           The button asks first: the confirm shows what the checks found, then wants the name. -->
                      {#if repo.remove}
                        <form method="POST" action="?/remove" bind:this={removeForms[repo.path]} use:enhance={inPlace}>
                          <input type="hidden" name="repo" value={repo.path} />
                          <input type="hidden" name="typed" value="" />
                          <Button variant="ghost" size="small" aria-label="Remove {name}" aria-haspopup="dialog" data-remove={repo.path} onclick={() => openRemove(repo.path)}>Remove</Button>
                        </form>
                      {/if}
                    </div>
                  </td>
                </tr>
                <!-- A refusal of the row gets a row of its own under it, the full width: in its cell it was
                     one word per line. -->
                {#each [problem(base), problem(`remove:${repo.path}`)].filter((one) => one !== null) as text (text)}
                  <tr class="note"><td colspan="5"><p class="refused" role="alert">{@render withCommand(text)}</p></td></tr>
                {/each}
              {/each}
            </tbody>
          </table>
        </div>
        <!-- The press of Remove waits on its checks, which can take a moment on a large repository. -->
        {#if removing !== null && fresh[removing] === undefined}<p class="quiet" role="status">Checking {repoName(removing)} for work that is not saved yet.</p>{/if}
        {#if unchecked !== null}<p class="refused" role="alert">Nolzu could not check {repoName(unchecked)}. Press Remove again.</p>{/if}
        <!-- Under the table, because a removed repository's row is gone. -->
        {#if said?.field.startsWith('remove:')}<p class="quiet" role="status">{said.text}</p>{/if}
        {#if said?.field === 'clone'}<p class="quiet" role="status">{said.text}</p>{/if}
        {#if problem('clone')}<p class="refused" role="alert">{problem('clone')}</p>{/if}
        {#each row.manifestProblems as one (one)}<p class="refused">{one}</p>{/each}
      </div>
    </div>
    <div class="st">
      {@render head('Add a repository', 'add-url')}
      <div class="c">
        <form method="POST" action="?/add" class="line keep" use:enhance={inPlace}>
          <input id="add-url" name="url" data-clear class="mono wide" placeholder="Paste a git URL: https://... or git@..." autocomplete="off" />
          <Button size="small" type="submit">Add</Button>
        </form>
        <!-- Add clones a fresh copy from the found remote, the way New project adds one. -->
        {#await found}
        <div class="foot found"><Skeleton shape="line" width="220px" label="Looking for repositories on this machine." /></div>
      {:then list}
          {#if list.length > 0}
            <div class="line found">
              <span class="hint">Or pick one found on this machine</span>
              {#each list as one (one.path)}
                <form method="POST" action="?/add" class="line" use:enhance={inPlace}>
                  <input type="hidden" name="url" value={one.url} />
                  <span class="mono">{one.path}</span>
                  <Button size="small" type="submit" aria-label="Add {one.path}">Add</Button>
                </form>
              {/each}
            </div>
          {/if}
        {/await}
        {#if said?.field === 'add'}<p class="quiet" role="status">{said.text}</p>{/if}
        <!-- One click, never by itself. It starts a run, so it is the go button. -->
        {#if said?.field === 'add' && said.learn}
          <form method="POST" action="?/learn" class="learn" use:enhance={inPlace}>
            <input type="hidden" name="repo" value={said.learn} />
            <Button size="small" variant="go" type="submit">Learn {said.learn}</Button>
            <span class="hint">An agent reads its README, agent files and CI, asks you up to four questions, and writes up to three knowledge files for your review.</span>
          </form>
        {/if}
        {#if problem('add')}<p class="refused" role="alert">{problem('add')}</p>{/if}
        {#if said?.field === 'learn'}<p class="quiet" role="status">{said.text} <a class="link" href={resolve('/knowledge')}>Open Knowledge</a></p>{/if}
        {#if problem('learn')}<p class="refused" role="alert">{problem('learn')}</p>{/if}
      </div>
    </div>
    {@const confirm = removing === null ? undefined : fresh[removing]}
    {#if removing !== null && confirm !== undefined}
      <ConfirmTyped
        title={confirm.title}
        sub={confirm.sub}
        name={removing}
        lost={confirm.lost}
        checked={confirm.checked}
        gone={confirm.gone}
        blocked={confirm.gone.length > 0}
        kept={confirm.kept}
        action={confirm.action}
        held={sending}
        bind:typed={() => typedFor[removing ?? ''] ?? '', (value) => {
          if (removing !== null) typedFor[removing] = value;
        }}
        onconfirm={(typed) => removing !== null && remove(removing, typed)}
        onclose={() => (removing = null)}
      />
    {/if}
  {/if}
  <div class="st">
    {@render head('Closed cards', null)}
    <div class="c">
      <form method="POST" action="?/checkouts" class="line" use:enhance={inPlace}>
        <Button size="small" type="submit">Remove the checkouts of closed cards{row.closedCheckouts > 0 ? ` (${row.closedCheckouts})` : ''}</Button>
      </form>
      <p class="quiet">The branches stay. So does a checkout with changes not committed, work not yet pushed, or a file git ignores that no tool makes again, such as a .env.</p>
      {#if said?.field === 'checkouts'}<p class="quiet" role="status">{said.text}</p>{/if}
    </div>
  </div>
</section>

<section class="box" id="cards" aria-labelledby="cards-title">
  <header><h3 id="cards-title">Cards and branches</h3></header>
  {@render setting('localKeyPrefix', 'Card key prefix', row.localKeyPrefix, prefixHint, null, clashLine)}
  <!-- The free prefix Jira was asked about, in one press. Its own form, since the row's form holds the box. -->
  {#if clash?.suggestion}
    <form method="POST" action="?/save" class="pad use" data-use-prefix use:enhance={inPlace}>
      <input type="hidden" name="field" value="localKeyPrefix" />
      <input type="hidden" name="value" value={clash.suggestion} />
      <Button size="small" type="submit">Use {clash.suggestion}</Button>
    </form>
  {/if}
  {@render setting('branchTemplate', 'Branch name', row.branchTemplate, branchHint)}
</section>

<section class="box" id="agent" aria-labelledby="agent-title">
  <header><h3 id="agent-title">Agent</h3></header>
  <!-- Each chip is its own form, and Add sends one command, so a page loaded before another change
       never writes its old list back. -->
  <div class="st" id="commands">
    {@render head('Commands the agent may run', 'addCommand', 'commands')}
    <div class="c">
      {#if row.allowedCommands.length > 0}
        <ul class="cmds">
          {#each row.allowedCommands as command (command)}
            <li>
              <form method="POST" action="?/save" class="cmd" use:enhance={inPlace}>
                <input type="hidden" name="field" value="removeCommand" />
                <input type="hidden" name="value" value={command} />
                <span>{command}</span>
                <button type="submit" aria-label="Remove {command}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>
              </form>
            </li>
          {/each}
        </ul>
      {/if}
      <form method="POST" action="?/save" class="line" use:enhance={inPlace}>
        <input type="hidden" name="field" value="addCommand" />
        <input id="addCommand" name="value" data-clear class="mono" value={shown('addCommand', '')} placeholder="Add a command, for example pnpm e2e" autocomplete="off" aria-describedby="commands-help" />
        <Button size="small" type="submit">Add</Button>
      </form>
      {#if problem('addCommand')}<p class="refused" role="alert">{problem('addCommand')}</p>{/if}
      {#if problem('removeCommand')}<p class="refused" role="alert">{problem('removeCommand')}</p>{/if}
      <p class="quiet" id="commands-help">Implement and QA may run these.</p>
      <!-- The wall closes the container sockets on purpose, so such a command never works in a run. -->
      {#if row.allowedCommands.some(needsContainerDaemon)}
        <p class="quiet" data-docker-note>
          Runs cannot reach Docker: the wall closes its socket, because Docker can write anywhere on this machine. Start containers with your own commands under Start the app, which Nolzu runs outside the wall when a card enters QA.
        </p>
      {/if}
      <!-- Read from the repositories on every load, so a new stack file shows here. It only adds. -->
      <details open={problem('addCommands') !== null}>
        <summary>Propose again</summary>
        {#if proposal.length === 0}
          <p class="quiet">The list already holds every command your repositories propose.</p>
        {:else}
          <form method="POST" action="?/addCommands" class="picks" use:enhance={inPlace}>
            <ul>
              {#each proposal as command (command)}
                <li><label><input type="checkbox" name="command" value={command} checked /> <span class="mono">{command}</span></label></li>
              {/each}
            </ul>
            <Button size="small" type="submit">Add the ticked commands</Button>
          </form>
        {/if}
        {#if problem('addCommands')}<p class="refused" role="alert">{problem('addCommands')}</p>{/if}
      </details>
      <!-- The step of Set up the project, for a list that needs no change. Any change confirms it too. -->
      {#if row.commandsConfirmed === false}
        <form method="POST" action="?/confirmCommands" class="line" use:enhance={inPlace}>
          <Button size="small" type="submit">The list is right</Button>
          <span class="quiet">Confirms the list for Set up the project.</span>
        </form>
      {/if}
    </div>
  </div>

  <!-- How QA gets each repository's app, one short line per repository so a project of many reads at a
       glance. Edit opens the four choices of the question at the first QA under the line; a refused save
       opens it again. -->
  <div class="st" id="app">
    {@render head('Start the app', null, 'app')}
    <div class="c">
      <ul class="apps">
        {#each row.apps as app (app.repo)}
          <li data-app-row={app.repo}>
            <div class="line">
              <span class="mono">{app.repo === '*' ? 'Every repository' : repoName(app.repo)}</span>
              <span class="hint" data-app-words>{app.words}</span>
              {#if app.answer !== null}
                <form method="POST" action="?/qaClear" use:enhance={inPlace}>
                  <input type="hidden" name="repo" value={app.repo} />
                  <Button size="small" variant="ghost" type="submit" aria-label="Ask again for {app.repo === '*' ? 'every repository' : repoName(app.repo)}">Ask again</Button>
                </form>
              {/if}
            </div>
            <details open={problem(`app:${app.repo}`) !== null}>
              <summary aria-label="Edit how QA starts {app.repo === '*' ? 'every repository' : repoName(app.repo)}">Edit</summary>
              <QaAppEdit row={app} onsubmit={inPlace} />
              {#if problem(`app:${app.repo}`)}<p class="refused" role="alert">{problem(`app:${app.repo}`)}</p>{/if}
            </details>
          </li>
        {/each}
      </ul>
      {#if row.apps.some((app) => app.answer !== null)}
        <form method="POST" action="?/qa" class="line" data-qa-app use:enhance={inPlace}>
          <Button size="small" type="submit">Ask again</Button>
          <span class="quiet">Clears every answer, and the next card of each repository that enters QA asks how QA gets the app.</span>
        </form>
      {:else}
        <p class="quiet" data-qa-app>The first card that enters QA asks how QA gets the app.</p>
      {/if}
    </div>
  </div>

  <!-- QA's browser, on its own row so a person finds it. Set up adds Nolzu's own server to the MCP list
       on for QA, Test starts it the way a QA run would, and every other server is on Settings, MCP servers. -->
  <div class="st" id="browser">
    {@render head('QA browser', null, 'browser')}
    <div class="c">
      {#if row.browser.problem !== null}<p class="refused" role="note">{row.browser.problem}</p>{/if}
      {#if !row.browser.on}
        <p class="quiet">
          {#if row.browser.chrome}
            QA has no browser, so a card that changes a page ends with a question to you.
          {:else}
            Google Chrome is not installed, so QA has no browser. Install it and come back.
          {/if}
        </p>
        <form method="POST" action="?/browserSetup" class="line" use:enhance={inPlace}>
          <Button size="small" type="submit" disabled={!row.browser.chrome}>Set up a browser</Button>
        </form>
      {:else}
        <div class="line">
          <span class="mono">{row.browser.servers.length === 0 ? 'the QA browser config not moved yet' : row.browser.servers.join(', ')}</span>
          <span class="hint">on for QA</span>
        </div>
        <div class="line">
          <form method="POST" action="?/browserTest" use:enhance={testingBrowser}>
            <Button size="small" type="submit" disabled={testing} aria-busy={testing ? 'true' : undefined}>{testing ? 'Testing the browser' : 'Test the browser'}</Button>
          </form>
          <form method="POST" action="?/browserOff" use:enhance={inPlace}><Button size="small" variant="ghost" type="submit">Turn off</Button></form>
        </div>
      {/if}
      {#if said?.field === 'browser'}<p class="quiet" role="status">{said.text}</p>{/if}
      {#if problem('browser')}<p class="refused" role="alert">{problem('browser')}</p>{/if}
      <p class="quiet">Every MCP server, and which phases get it, is on <a href={resolve('/settings/mcp')}>Settings, MCP servers</a>.</p>
    </div>
  </div>

  <!-- Only the button is the form, because each file changed by hand below has forms of its own. -->
  <!-- The id is where the notice's link lands, as the hand edits sit far down the page. -->
  <div class="st" id="files">
    {@render head('Project files', null, 'files')}
    <div class="c">
      <form method="POST" action="?/files" class="line" use:enhance={inPlace}><Button size="small" type="submit">Write the project files</Button></form>
      <p class="quiet">The rules and skills the agents read in this project.</p>
      {#if said?.field === 'files'}<p class="quiet" role="status">{said.text}</p>{/if}
      <!-- A refused write of a newer project says the status sentence again, so the refusal stands alone. -->
      {#if filesLine !== null && problem('files') !== filesLine}<p class="quiet" data-files-status>{filesLine}</p>{/if}
      {#if handLine !== null}<p class="quiet" data-files-yours>{handLine}</p>{/if}
      {#if problem('files')}<p class="refused" role="alert">{problem('files')}</p>{/if}
      {#if handEdits instanceof Promise}
        <Streamed promise={handEdits} scope="hand-edits" waiting="Reading the files you changed with git." height="44px" shape="rows" count={1}>
          {#snippet children(files)}<HandEditedFiles {files} {refused} />{/snippet}
        </Streamed>
      {:else}
        <HandEditedFiles files={handEdits} {refused} />
      {/if}
    </div>
  </div>
</section>

<!-- The boards beside Delivery. The board's cards are never part of the post. -->
<section class="box" id="boards" aria-labelledby="boards-title">
  <header><h3 id="boards-title">Boards</h3></header>
  <div class="st">
    {@render head('On the rail', null, 'boards')}
    <div class="c">
      <div class="line boards">
        <span class="line"><Switch checked disabled aria-labelledby="board-delivery" /><span id="board-delivery">Delivery</span><span class="hint">always on</span></span>
        {#each row.boards as board (board.kind)}
          {@const name = `board:${board.kind}`}
          <form method="POST" action="?/save" class="line" bind:this={boardForms[board.kind]} use:enhance={inPlace}>
            <input type="hidden" name="field" value={name} />
            <input type="hidden" name="value" value={board.on ? 'off' : 'on'} />
            <Switch checked={board.on} aria-labelledby="board-{board.kind}" onchange={() => boardForms[board.kind]?.requestSubmit()} />
            <span id="board-{board.kind}">{board.label}</span>
          </form>
        {/each}
      </div>
      {#each row.boards as board (board.kind)}
        {#if problem(`board:${board.kind}`)}<p class="refused" role="alert">{problem(`board:${board.kind}`)}</p>{/if}
      {/each}
      <p class="quiet">An off board keeps its cards.</p>
    </div>
  </div>
</section>

<section class="box" id="knowledge" aria-labelledby="knowledge-title">
  <header><h3 id="knowledge-title">Knowledge</h3></header>
  {@render setting('knowledgeDir', 'Knowledge location', row.knowledgeDir ?? '', knowledgeHint, row.knowledgeFolder)}
</section>

<!-- The project's three wall lists. The fixed rules hold for every project, so they are on Settings,
     Wall. Nothing in the lists loosens a fixed rule: the runner checks each entry on save and at every run. -->
{#if row.walls}
  <section class="box" id="walls" aria-labelledby="walls-title">
    <header><h3 id="walls-title">Walls</h3></header>
    <div class="st">
      {@render head('Always hidden', null)}
      <div class="c">
        <p class="quiet">Every run is walled from your keys, logins and other secrets. Nothing below can loosen that. <a class="link" href={resolve('/settings/wall')}>See the list on Wall</a></p>
      </div>
    </div>
    {@render wallList('hidden', 'More paths to hide', row.walls.lists.hidden, 'Add a path, for example ~/secrets', 'Hidden from every run.')}
    {@render wallList('exceptions', 'Secret exceptions', row.walls.lists.exceptions, 'Add a file, for example .env.test', 'The .env files a run may read.')}
    {@render wallList('writable', 'More writable folders', row.walls.lists.writable, 'Add a folder, for example ~/.gradle', 'Implement and QA may write here.')}
  </section>
{/if}

<!-- Which ticket system this project reads, on one line. The Jira login is the machine's and lives on
     Settings, Integrations. Change folds open the one other choice, worded as what a press does. -->
<section class="box" id="tickets" aria-labelledby="tickets-title">
  <header><h3 id="tickets-title">Tickets</h3></header>
  <div class="st" data-ticket-system>
    {@render head('Ticket system', null)}
    <div class="c">
      <div class="line">
        {#if !onJira}Only local cards{:else if jiraConnected}Read from Jira at <span class="mono">{jiraHost}</span>{:else}Read from Jira, which is not connected on this machine{/if}
      </div>
      <!-- Under the line and not beside it, as the Edit of Start the app, so the line does not move. -->
      <details open={problem('tickets') !== null}>
        <summary aria-label="Change the ticket system">Change</summary>
        <div class="fold">
          {#if onJira || jiraConnected}
            <form method="POST" action="?/tickets" use:enhance={inPlace}>
              <input type="hidden" name="value" value={onJira ? 'local' : 'jira'} />
              <Button size="small" type="submit">{onJira ? 'Stop reading Jira in this project' : 'Read Jira in this project'}</Button>
            </form>
          {/if}
          {#if !jiraConnected}
            <p class="quiet">To read Jira, connect it first in <a class="link" href={resolve('/settings/integrations')}>Settings, Integrations</a>.</p>
          {/if}
        </div>
      </details>
      <p class="quiet">Local cards work either way: a key with this project's prefix is always a local card.</p>
      {#if problem('tickets')}<p class="refused" role="alert">{problem('tickets')}</p>{/if}
    </div>
  </div>
</section>

{#if saved !== null && !live}<p class="said" role="status">Saved.</p>{/if}

<style>
  /* Every part of the page, in the look the Walls and Tickets panels had. A container, so a narrow box
     puts the labels on top whatever the window is. The margin keeps a jumped-to box off the top edge. */
  .box {
    container-type: inline-size;
    margin-bottom: var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
    scroll-margin-top: 16px;
  }

  .box > header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    min-height: 44px;
    box-sizing: border-box;
    padding: 6px 14px;
    border-bottom: 1px solid var(--line);
  }

  .box > header h3 {
    font-weight: 500;
  }

  .pad {
    padding: 12px 14px 0;
  }

  /* Under the prefix row, lined up with its box: the label column and the gap. */
  .pad.use {
    padding: 0 14px 12px 242px;
  }

  @container (max-width: 600px) {
    .pad.use {
      padding-left: 14px;
    }
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .line.keep {
    flex-wrap: nowrap;
  }

  .sp {
    flex: 1;
  }

  input,
  select {
    box-sizing: border-box;
    min-width: 0;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
  }

  .c input.wide {
    flex: 1;
    width: 100%;
  }

  input[readonly] {
    background: var(--panel);
    color: var(--ink-2);
  }

  .mono,
  input.mono {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
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

  /* Scrolls and never clips, in case a row is still wider than the box. A narrow box stacks each row
     instead (below), so Remove is never behind the scroll. */
  .panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--bg);
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  /* Fixed columns, so the table is never wider than its box and Remove stays in sight with no sideways
     scroll; the remote takes what is left. A narrow box stacks the rows instead (below). */
  @container (min-width: 601px) {
    table {
      table-layout: fixed;
    }

    .w-folder {
      width: 20%;
    }

    .w-base {
      width: 160px;
    }

    .w-status {
      width: 100px;
    }

    /* Wide enough for Remove. A row with Clone as well puts it on a second line. */
    .w-acts {
      width: 100px;
    }
  }

  th,
  td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    text-align: left;
    vertical-align: middle;
    white-space: nowrap;
  }

  th:first-child,
  td:first-child {
    padding-left: 16px;
  }

  thead th {
    padding-top: 8px;
    padding-bottom: 8px;
    font-size: var(--text-2xs);
    font-weight: 500;
    color: var(--muted);
  }

  tbody th {
    font-weight: 500;
    color: var(--ink);
  }

  /* The remote gives up its width first: max-width 0 takes it out of the table's own sizing, so it
     gets what the other columns leave and ends in an ellipsis. The full remote is its title. */
  .remote {
    width: 100%;
    max-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--muted);
  }

  .base {
    width: 14ch;
    height: 28px;
  }

  /* A long folder name ends in an ellipsis rather than push Remove out of the box. Its title holds it. */
  .folder {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .found {
    font-size: var(--text-xs);
  }

  td.acts {
    padding-right: 16px;
  }

  /* A row's refusal sits under it as part of it, so the line goes under the refusal. */
  .panel tr:has(+ .note),
  .panel tr:has(+ .note) > * {
    border-bottom: 0;
  }

  .note td {
    padding-top: 0;
    white-space: normal;
  }

  td.acts .line {
    justify-content: flex-end;
  }

  .ok {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  /* Green: the clone is there. The word says it too, so it is not colour alone. */
  .ok svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: var(--green);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* A neutral pill: a missing folder is a state to act on, not an error. */
  .pill {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 8px;
    border-radius: 999px;
    box-shadow: inset 0 0 0 1px var(--line-2);
    color: var(--muted);
    font-size: var(--text-2xs);
    font-weight: 500;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .st {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 6px 28px;
    align-items: start;
    padding: 12px 14px;
  }

  .st + .st {
    border-top: 1px solid var(--line);
  }

  @container (max-width: 900px) {
    .st.table {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  /* Inline and not a flex row, so on a label of two lines the "?" follows the last word and not the
     column's right edge. Balanced, so a label that only just fits does not send the "?" down alone. */
  .lb {
    padding-top: 6px;
    text-wrap: balance;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
  }

  .lb :global(.helptip) {
    margin-left: 6px;
  }

  .c {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }

  .c input {
    width: 240px;
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .learn {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .cmds {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .picks {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .picks ul {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .picks label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--ink-2);
    font-size: var(--mono-2xs);
    overflow-wrap: anywhere;
  }

  /* The text box rules above would draw the tick box 240px wide. */
  .picks input {
    width: auto;
    height: auto;
    margin: 0;
    padding: 0;
  }

  .cmd {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    height: 24px;
    padding: 0 3px 0 8px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .cmd button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-xs);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
  }

  .cmd svg {
    width: 11px;
    height: 11px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  .link {
    color: var(--blue);
  }

  .boards {
    gap: var(--space-6);
    padding-top: 6px;
  }

  /* No side padding, so the word lines up with the column edge like the text above it. */
  summary {
    width: max-content;
    padding: 2px 0;
    border-radius: var(--radius-sm);
    color: var(--ink-2);
    font-size: var(--text-xs);
    list-style: none;
    cursor: pointer;
  }

  /* One fold marker across Settings, as on Wall: the arrow after the words, not the browser's
     triangle in front. The empty alt text keeps a screen reader from reading it out. */
  summary::-webkit-details-marker {
    display: none;
  }

  summary::after {
    content: ' ▸';
    content: ' ▸' / '';
    color: var(--muted);
  }

  details[open] > summary::after {
    content: ' ▾';
    content: ' ▾' / '';
  }

  details[open] summary {
    margin-bottom: var(--space-2);
  }

  /* Change on the Tickets line: the one other choice, and where the login is when there is none. */
  .fold {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .stack {
    display: grid;
    gap: 6px;
    padding: 12px 14px;
    font-size: var(--text-sm);
  }

  .c .stack {
    padding: 0;
  }

  /* One short line per repository, so a project of many stays easy to scan. */
  .apps {
    display: grid;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .stack input {
    width: 100%;
  }

  .stack label {
    color: var(--ink-2);
  }

  /* The muted token and not an opacity: faint text loses the contrast rule. */
  .quiet {
    grid-column: 1 / -1;
    max-width: 72ch;
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .refused,
  .warn {
    grid-column: 1 / -1;
    margin: 0;
    padding: 4px 8px;
    border-left: 2px solid var(--red);
    background: var(--card);
    font-size: var(--text-xs);
    color: var(--ink);
    white-space: normal;
  }

  .said {
    margin: var(--space-3) 0;
    font-size: var(--text-xs);
    color: var(--ink);
  }

  @container (max-width: 600px) {
    .st {
      grid-template-columns: minmax(0, 1fr);
    }

    /* On a narrow screen each repository is a stacked row: the folder and its remote, then the base
       branch, the status and Remove, with nothing behind a sideways scroll. */
    thead {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }

    .panel tbody tr {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px 12px;
      padding: 10px 16px;
      border-bottom: 1px solid var(--line);
    }

    .panel tbody :is(th, td) {
      display: block;
      padding: 0;
      border: 0;
    }

    /* Each on a line of its own, so the caps of the wide table come off. */
    .panel .folder {
      flex: 1 1 100%;
      max-width: none;
    }

    .panel .remote {
      flex: 1 1 100%;
      width: auto;
      max-width: none;
    }

    .panel td.acts {
      margin-left: auto;
    }

    .panel tr.note {
      padding-top: 0;
    }
  }
</style>
