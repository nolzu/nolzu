<script lang="ts">
  import { subjectWarning } from '@nolzu/protocol';
  import type { FilePatch, RepoState } from '@nolzu/runner';
  import { ago, Button, Dialog, numberedLines, Skeleton } from '@nolzu/ui';
  import { onMount, tick as settled } from 'svelte';
  import type { WorkspaceStatus } from './workspace.ts';
  import { allClean, changedLine, defaultMessage, defaultTicks, fileMark, folderTree, isClean, plural, syncLine } from './workspace-page.ts';

  type Answer = { ok: true; alreadyUpToDate?: boolean } | { ok: false; reason: string; rejected?: boolean };

  // The Workspace page as a git client: on the left the project folder and each repository with its
  // branch, where it stands against its upstream and its changed files, the clean ones folded into one
  // line; on the right the changed files of the one picked, by folder, its diff, Commit and Push. Git
  // status is read when the page opens, on Check again and after a commit or a push, never on a timer.
  // Nothing here pulls, discards, stashes, switches a branch or forces a push: those stay in the
  // person's editor. The page does the fetches, so this part has no address of its own.
  let {
    name,
    folder = null,
    onread,
    onpatch,
    oncommit,
    onpush,
    onchecked = () => {},
  }: {
    // The project's name and its folder as the rail shows it.
    name: string;
    folder?: string | null;
    onread: () => Promise<WorkspaceStatus>;
    onpatch: (repo: string, path: string) => Promise<FilePatch>;
    // Each answers with the status read after it, so the page shows the folder as it is now.
    // hooks is the Run hooks tick, true only when the person turned the repository's hooks on.
    oncommit: (repo: string, message: string, paths: string[], hooks: boolean) => Promise<Answer & { status?: WorkspaceStatus }>;
    onpush: (repo: string, hooks: boolean) => Promise<Answer & { status?: WorkspaceStatus }>;
    // Told after every read, so the rail's count follows it.
    onchecked?: () => void;
  } = $props();

  let status = $state<WorkspaceStatus | null>(null);
  let reading = $state(false);
  // Null until the first read picks the first folder with changes.
  let selected = $state<string | null>(null);
  // The "N clean" line, closed until the person opens it.
  let showClean = $state(false);
  // A folder of files the person opened or closed stays that way, by repository and folder. Until then it
  // is open when it holds the file whose diff shows.
  let unfolded = $state<Record<string, boolean>>({});
  // The ticked paths of each folder, by its id. Reset to Nolzu's own on every read but a push or a refused commit.
  let ticks = $state<Record<string, string[]>>({});
  let open = $state<{ repo: string; path: string; patch: FilePatch | null } | null>(null);
  // What the person typed. Null follows the default for what is ticked.
  let draft = $state<string | null>(null);
  let committing = $state(false);
  let pushing = $state(false);
  let asking = $state(false);
  // Off until ticked, and off again after each press, as on the card's commit box.
  let hooks = $state(false);
  let shell = $state<ReturnType<typeof Dialog>>();
  let note = $state('');
  let alert = $state<{ title: string; text: string } | null>(null);
  // The folder whose push was refused. Its Push stays off until the next read.
  let refused = $state<string | null>(null);

  const repos = $derived(status?.ok === true ? status.repos : []);
  const current = $derived(repos.find((repo) => repo.id === selected) ?? null);
  const here = $derived<RepoState | null>(current?.state ?? null);
  const files = $derived(here?.ok === true ? here.files : []);
  const ticked = $derived(new Set(ticks[selected ?? ''] ?? []));
  const chosen = $derived(files.filter((file) => ticked.has(file.path)));
  const ownTicked = $derived(chosen.filter((file) => file.owner === 'yours'));
  const message = $derived(draft ?? defaultMessage(files, ticked));
  const canPush = $derived(here?.ok === true && here.confirmation !== null && here.ahead > 0);
  const lines = $derived(open?.patch?.ok === true ? numberedLines(open.patch.text) : []);
  // A clock for the "Checked 1 minute ago" words only. It reads no git: status is read on open, on Check
  // again and after a commit or a push.
  let now = $state(new Date());
  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(timer);
  });
  const checked = $derived.by(() => {
    if (status?.ok !== true) return null;
    const at = new Date(status.checkedAt);
    return now.getTime() - at.getTime() < 60_000 ? 'Checked just now' : `Checked ${ago(at.toISOString(), now, true) ?? 'just now'}`;
  });

  // keep holds what the person typed and ticked, for a push or a refused commit, which leave the files as they were.
  function apply(next: WorkspaceStatus, keep = false): void {
    status = next;
    now = new Date();
    if (!keep) draft = null;
    if (!next.ok) return;
    if (!keep) ticks = Object.fromEntries(next.repos.map((repo) => [repo.id, [...defaultTicks(repo.state)]]));
    if (!next.repos.some((repo) => repo.id === selected)) selected = next.repos.find((repo) => !isClean(repo.state) && repo.state.ok)?.id ?? next.repos[0]?.id ?? '.';
    showFirst();
    onchecked();
  }

  // The diff of the first file in the list, unless the open one is still listed.
  function showFirst(): void {
    const still = open !== null && open.repo === selected && files.some((file) => file.path === open?.path);
    const first = groups.flatMap((group) => [...group.tree.top, ...group.tree.folders.flatMap((folder) => folder.files)])[0];
    if (still && open !== null) void show(open.path);
    else if (first !== undefined) void show(first.path);
    else open = null;
  }

  async function read(): Promise<void> {
    if (reading) return;
    reading = true;
    alert = null;
    refused = null;
    // A fresh read makes the last commit's or push's line old news.
    note = '';
    try {
      apply(await onread());
    } catch {
      status = { ok: false, reason: 'The local app did not answer. Check that it is running, then press Check again.' };
    } finally {
      reading = false;
    }
  }

  onMount(() => void read());

  function pick(id: string): void {
    selected = id;
    draft = null;
    showFirst();
  }

  async function show(path: string): Promise<void> {
    if (selected === null) return;
    const repo = selected;
    open = { repo, path, patch: null };
    let patch: FilePatch;
    try {
      patch = await onpatch(repo, path);
    } catch {
      patch = { ok: false, reason: 'The local app did not answer, so the diff is not shown.' };
    }
    // A later click wins: a slow answer for a file the person left draws nothing.
    if (open?.repo === repo && open.path === path) open = { repo, path, patch };
  }

  // A commit or a push swaps, hides or turns off the pressed button, which drops focus to the page. Focus
  // goes to the line that says what happened, so a keyboard user carries on from there.
  async function keepFocus(): Promise<void> {
    await settled();
    const at = document.activeElement as HTMLButtonElement | null;
    if (at !== null && at !== document.body && at.isConnected && !at.disabled) return;
    (document.querySelector<HTMLElement>('[data-alert]') ?? document.querySelector<HTMLElement>('[data-note]'))?.focus();
  }

  function tick(path: string, on: boolean): void {
    if (selected === null) return;
    const now = ticks[selected] ?? [];
    ticks[selected] = on ? [...now, path] : now.filter((one) => one !== path);
  }

  function tickAll(paths: string[], on: boolean): void {
    if (selected === null) return;
    const now = (ticks[selected] ?? []).filter((one) => !paths.includes(one));
    ticks[selected] = on ? [...now, ...paths] : now;
  }

  const foldKey = (path: string) => `${selected ?? ''}:${path}`;
  const isOpen = (folder: { path: string; files: { path: string }[] }) =>
    unfolded[foldKey(folder.path)] ?? (open?.repo === selected && folder.files.some((file) => file.path === open?.path));

  async function commit(): Promise<void> {
    if (committing || current === null || chosen.length === 0) return;
    if (message.trim() === '') {
      note = 'The commit message is empty. Write a subject line first, then commit.';
      return;
    }
    committing = true;
    alert = null;
    note = 'Committing.';
    const count = chosen.length;
    try {
      const answer = await oncommit(current.id, message, chosen.map((file) => file.path), hooks);
      hooks = false;
      if (answer.status !== undefined) apply(answer.status, !answer.ok);
      if (answer.ok) note = `Committed ${plural(count, 'file')}. Nothing left the machine.`;
      else {
        note = '';
        alert = { title: 'Git refused the commit.', text: answer.reason };
      }
    } catch {
      note = 'The local app did not answer. Check that it is running, then press Commit again.';
    } finally {
      committing = false;
      void keepFocus();
    }
  }

  async function push(): Promise<void> {
    shell?.close();
    if (pushing || current === null) return;
    const id = current.id;
    pushing = true;
    alert = null;
    note = 'Pushing.';
    try {
      const answer = await onpush(id, hooks);
      hooks = false;
      if (answer.status !== undefined) apply(answer.status, true);
      if (answer.ok) note = answer.alreadyUpToDate === true ? 'Nothing new to push. The remote has it already.' : 'Pushed.';
      else {
        note = '';
        refused = id;
        alert = { title: answer.rejected === true ? 'The remote refused the push.' : 'Git refused the push.', text: answer.reason };
      }
    } catch {
      note = 'The local app did not answer. Check that it is running, then push again.';
    } finally {
      pushing = false;
      void keepFocus();
    }
  }

  const groups = $derived(
    [
      { key: 'nolzu', title: 'Nolzu files', files: files.filter((file) => file.owner === 'nolzu') },
      { key: 'yours', title: 'Your files', files: files.filter((file) => file.owner === 'yours') },
    ].map((group) => ({ ...group, tree: folderTree(group.files) })),
  );
  const innerCount = $derived(repos.length - 1);
  // The folder first, then every folder that needs a hand, and the picked one even when clean, so it
  // never hides in the fold. The rest fold into the "N clean" line.
  const listed = $derived(repos.filter((repo) => repo.id === '.' || !isClean(repo.state) || repo.id === selected));
  const folded = $derived(repos.filter((repo) => !listed.includes(repo)));
</script>

{#snippet repoRow(repo: (typeof repos)[number])}
  {@const sync = syncLine(repo.state)}
  {@const branch = repo.state.ok ? (repo.state.branch ?? 'detached') : ''}
  <li>
    <button type="button" class="repo" aria-current={repo.id === selected ? 'true' : undefined} onclick={() => pick(repo.id)} data-repo={repo.id}>
      <span class="nm">
        <b>{repo.id === '.' ? 'Workspace folder' : repo.name}</b>
        <span class="sub">{#if branch !== ''}<span class="br mono">{branch}</span> ·{/if} <span data-sync>{sync}</span></span>
      </span>
      <span class="st" data-changed>
        {#if repo.state.ok}<i class="dot" class:ch={repo.state.files.length > 0} aria-hidden="true"></i>{changedLine(repo.state)}{/if}
      </span>
    </button>
  </li>
{/snippet}

{#snippet fileRow(file: (typeof files)[number], label: string)}
  {@const mark = fileMark(file)}
  <div class="file" class:on={open?.repo === selected && open.path === file.path} data-file={file.path}>
    <input type="checkbox" aria-label="Commit {file.path}" checked={ticked.has(file.path)} onchange={(event) => tick(file.path, event.currentTarget.checked)} />
    <button type="button" class="pick" aria-label="Show the diff of {file.path}, {mark.word}" onclick={() => show(file.path)}>
      <span class="k" data-k={mark.letter} aria-hidden="true">{mark.letter}</span><span class="p">{label}</span>
    </button>
  </div>
{/snippet}

<div class="workspace">
  <div class="top">
    <h1>Workspace</h1>
    <span class="sp"></span>
    {#if checked !== null}<span class="quiet" data-checked>{checked}</span>{/if}
    <Button size="small" aria-busy={reading} disabled={reading} onclick={read} data-check>Check again</Button>
  </div>

  <div class="page">
    <div class="head">
      <h2>{name}</h2>
      <p>
        {#if folder !== null}<span class="mono">{folder}</span> ·{/if} The workspace folder and its repositories. Commit and push the files here. Pull and branches stay in your editor.
      </p>
    </div>

    {#if status !== null && !status.ok}
      <div class="alert" role="alert"><b>Nolzu could not read the workspace.</b><span>{status.reason}</span></div>
    {:else}
      <div class="layout">
        <nav class="side" aria-label="Folders">
          {#if status === null}
            <!-- In the box the rows land in, so its border does not appear with the answer. -->
            <div class="repos"><Skeleton shape="list" count={4} label="Reading git status." /></div>
          {:else}
            <ul class="repos">
              {#each listed as repo (repo.id)}{@render repoRow(repo)}{/each}
            </ul>
            {#if folded.length > 0}
              <button type="button" class="more" aria-expanded={showClean} onclick={() => (showClean = !showClean)} data-clean-toggle>
                <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>{folded.length} clean
              </button>
              {#if showClean}
                <ul class="repos" data-clean-list>
                  {#each folded as repo (repo.id)}{@render repoRow(repo)}{/each}
                </ul>
              {/if}
            {/if}
          {/if}
        </nav>

        <div class="main">
          {#if alert !== null}
            <div class="alert red" role="alert" tabindex="-1" data-alert><b>{alert.title}</b><span class="pre">{alert.text}</span></div>
          {/if}

          {#if status === null}
            <!-- The same split the changes land in, so a wide screen keeps its three columns. -->
            <div class="split">
              <Skeleton shape="block" height="240px" label="Reading the changes." />
              <Skeleton shape="block" height="240px" label="Reading the diff." />
            </div>
          {:else if allClean(status)}
            <div class="box empty" data-clean>
              <b>Nothing to commit</b>
              <span class="quiet">
                {innerCount === 0 ? 'The workspace folder matches its last commit' : `The workspace folder and ${innerCount === 1 ? 'its repository' : `its ${innerCount} repositories`} match their last commit`}, and nothing waits to be
                pushed.
              </span>
            </div>
            {#if note !== ''}<p class="quiet" role="status" tabindex="-1" data-note>{note}</p>{/if}
          {:else if current !== null && here !== null}
            <div class="split" class:one={files.length === 0}>
              <section class="box" aria-label="Changes in {current.id === '.' ? 'the workspace folder' : current.name}">
                {#if !here.ok}
                  <p class="none">{here.reason}</p>
                {:else}
                  <!-- First, so the message and Commit are in sight without a scroll however long the list is.
                       A clean folder with nothing to push and nothing just done draws no empty band. -->
                  {#if files.length > 0 || canPush || note !== ''}
                    <div class="commit">
                      {#if files.length > 0}
                        <textarea aria-label="Commit message" rows="2" value={message} oninput={(event) => (draft = event.currentTarget.value)} data-message></textarea>
                        {#if subjectWarning(message) !== null}<p class="warn" role="status" data-subject-warning>{subjectWarning(message)}</p>{/if}
                      {/if}
                      <div class="row">
                        {#if files.length > 0}
                          <Button variant="primary" aria-busy={committing} disabled={committing || chosen.length === 0} onclick={commit} data-commit>Commit {plural(chosen.length, 'file')}</Button>
                        {/if}
                        {#if canPush && here.ok}
                          <Button aria-haspopup="dialog" aria-busy={pushing} disabled={pushing || refused === current.id} onclick={() => (asking = true)} data-push
                            >{refused === current.id ? 'Push refused' : `Push ${plural(here.ahead, 'commit')}`}</Button
                          >
                        {/if}
                      </div>
                      <!-- Nolzu runs git with the repository's hooks off, because an agent may have planted one.
                           A folder with nothing to commit or push has no git step for them to run in. -->
                      {#if files.length > 0 || canPush}
                        <label class="hooks"><input type="checkbox" bind:checked={hooks} data-run-hooks />Run hooks <span class="quiet">Git hooks are skipped unless you tick this.</span></label>
                      {/if}
                      {#if ownTicked.length > 0}
                        <span class="quiet" data-own
                          >{ownTicked.length === 1
                            ? `${ownTicked[0]?.path} is your own file. It goes in this commit because you ticked it.`
                            : `${ownTicked.length} of your own files go in this commit because you ticked them.`}</span
                        >
                      {/if}
                      <p class="quiet" role="status" tabindex="-1" data-note>{note}</p>
                    </div>
                  {/if}

                  {#if files.length === 0}<p class="none">No changed files here.</p>{/if}
                  <div class="list">
                    {#each groups as group (group.key)}
                      {#if group.files.length > 0}
                        {@const paths = group.files.map((file) => file.path)}
                        <div class="grp" data-group={group.key}>
                          <div class="gh">
                            <span>{group.title}</span>
                            <span class="quiet">{group.files.length}</span>
                            {#if group.key === 'nolzu'}
                              <label class="all"
                                ><input
                                  type="checkbox"
                                  checked={paths.every((path) => ticked.has(path))}
                                  onchange={(event) => tickAll(paths, event.currentTarget.checked)}
                                  data-tick-all
                                />All</label
                              >
                            {/if}
                          </div>
                          {#each group.tree.top as file (file.path)}{@render fileRow(file, file.path)}{/each}
                          {#each group.tree.folders as dir (dir.path)}
                            {@const shown = isOpen(dir)}
                            {@const inside = dir.files.map((file) => file.path)}
                            {@const on = inside.filter((path) => ticked.has(path)).length}
                            <div class="dir" data-folder={dir.path}>
                              <input
                                type="checkbox"
                                aria-label="Commit every file in {dir.path}"
                                checked={on === inside.length}
                                indeterminate={on > 0 && on < inside.length}
                                onchange={(event) => tickAll(inside, event.currentTarget.checked)}
                              />
                              <button type="button" class="fold" aria-expanded={shown} onclick={() => (unfolded[foldKey(dir.path)] = !shown)}>
                                <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>
                                <span class="p">{dir.path}</span>
                                <span class="n">{dir.files.length}</span>
                              </button>
                            </div>
                            {#if shown}
                              <div class="in">
                                {#each dir.files as file (file.path)}{@render fileRow(file, file.path.slice(dir.path.length + 1))}{/each}
                              </div>
                            {/if}
                          {/each}
                          {#if group.key === 'nolzu'}<p class="why">Files Nolzu writes: the project files, the skills and your phase instructions.</p>{/if}
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}
              </section>

              {#if files.length > 0}
                <section class="box diff" aria-label="Diff" data-diff>
                  {#if open === null}
                    <p class="none">Pick a file to see its diff.</p>
                  {:else}
                    <div class="dh">
                      <b>{open.path}</b>
                      {#if lines.length > 0}<span class="quiet"
                          ><span class="plus">+{lines.filter((line) => line.kind === 'add').length}</span>
                          <span class="minus">-{lines.filter((line) => line.kind === 'del').length}</span></span
                        >{/if}
                    </div>
                    {#if open.patch === null}
                      <div class="wait"><Skeleton shape="block" height="160px" label="Reading the diff." /></div>
                    {:else if !open.patch.ok}
                      <p class="none">{open.patch.reason}</p>
                    {:else if lines.length === 0}
                      <p class="none">git shows no line change for this file.</p>
                    {:else}
                      <div class="lines" aria-label="Diff of {open.path}">
                        {#each lines as line, index (index)}
                          <div class="ln" data-line={line.kind}><span class="no">{line.old ?? ''}</span><span class="no">{line.new ?? ''}</span><span class="sg">{line.sign}</span><span class="c">{line.code}</span></div>
                        {/each}
                      </div>
                    {/if}
                  {/if}
                </section>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

{#if asking && here?.ok === true && here.confirmation !== null}
  <!-- Cream and never amber, because a push starts no agent. The sentence names the branch, the remote
       and its address before anything leaves the machine. -->
  <Dialog bind:this={shell} title="Push {here.branch}" sub="Nothing is pulled and nothing is forced." onclose={() => (asking = false)} data-push-confirm>
    <p class="said">{here.confirmation} This leaves your machine.</p>
    {#snippet footer()}
      <Button variant="primary" aria-busy={pushing ? 'true' : undefined} aria-disabled={pushing ? 'true' : undefined} onclick={push} data-push-go>Push</Button>
      <Button onclick={() => shell?.close()}>Not yet</Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .workspace {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }

  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    min-height: 54px;
    padding: 0 var(--space-6);
    border-bottom: 1px solid var(--line);
  }

  h1 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .sp {
    flex: 1;
  }

  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .mono {
    font-family: var(--font-mono);
  }

  .page {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-6);
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  h2 {
    margin: 0;
    font-size: var(--text-xl);
    font-weight: 600;
    line-height: 1.15;
    letter-spacing: -0.025em;
    overflow-wrap: anywhere;
  }

  .head p {
    max-width: 72ch;
    margin: 0;
    font-size: var(--text-base);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  /* The folder list on the left and the picked folder's changes on the right, stacked on a phone. */
  .layout {
    display: grid;
    grid-template-columns: minmax(200px, 280px) minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
  }

  .side,
  .main {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .repos {
    margin: 0;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
    list-style: none;
  }

  .repos li + li {
    border-top: 1px solid var(--line);
  }

  .repo {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px var(--space-3);
    align-items: center;
    width: 100%;
    padding: 8px var(--space-3);
    border: 0;
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  /* Inside the row, because the list clips what hangs past its rounded edge. */
  .repo:focus-visible {
    outline-offset: -2px;
  }

  /* The picked folder: its box and the bar on its edge, so it is not colour alone. */
  .repo[aria-current] {
    background: var(--card);
    box-shadow: inset 2px 0 0 var(--ink-2);
  }

  .nm {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .nm b {
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .sub {
    font-size: var(--text-xs);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .br {
    font-size: var(--mono-xs);
  }

  .more {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px var(--space-2);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    cursor: pointer;
  }

  .more:hover {
    background: var(--card);
  }

  .chev {
    flex: none;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: var(--muted);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  [aria-expanded='true'] > .chev {
    transform: rotate(90deg);
  }

  .st {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-xs);
    color: var(--ink-2);
    white-space: nowrap;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--green);
  }

  /* Blue as the Changes tab marks a change, never amber: amber means an agent works. */
  .dot.ch {
    background: var(--blue);
  }

  .alert {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 10px 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-lg);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .alert b {
    font-weight: 600;
  }

  .alert.red {
    box-shadow: inset 3px 0 0 var(--red);
  }

  /* Git's own words, kept as git wrote them, wrapped so the page never scrolls sideways. */
  .pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .split {
    display: grid;
    grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
    gap: var(--space-4);
    align-items: start;
  }

  .split.one {
    grid-template-columns: minmax(0, 1fr);
  }

  .box {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .none {
    margin: 0;
    padding: var(--space-4) 14px;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .grp {
    padding: 10px 0 6px;
  }

  .grp + .grp {
    border-top: 1px solid var(--line);
  }

  .gh {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 14px 6px;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--ink-2);
  }

  .gh .quiet {
    font-weight: 400;
  }

  .all {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
    font-weight: 400;
    color: var(--muted);
  }

  .file {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 2px 14px;
  }

  .file.on {
    background: var(--card-2);
  }

  input[type='checkbox'] {
    flex: none;
    margin: 0;
    accent-color: var(--ink-2);
  }

  .pick {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    padding: 3px 0;
    border: 0;
    background: transparent;
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .p {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .k {
    flex: none;
    width: 14px;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    text-align: center;
    color: var(--ink-2);
  }

  .k[data-k='M'] {
    color: var(--blue);
  }

  .k[data-k='A'] {
    color: var(--green);
  }

  .k[data-k='D'],
  .k[data-k='!'] {
    color: var(--red);
  }

  /* A folder of changed files, folded, with its count, as the Knowledge tree folds one. */
  .dir {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 2px 14px;
  }

  .fold {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 3px 0;
    border: 0;
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .fold .n {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .in .file {
    padding-left: 34px;
  }

  /* The list scrolls inside its box, so the commit box above it stays in sight. */
  .list {
    max-height: 65vh;
    overflow-y: auto;
  }

  .wait {
    padding: var(--space-3) 14px;
  }

  .why {
    margin: 0;
    padding: 2px 14px var(--space-2) 36px;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .commit {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) 14px;
    border-bottom: 1px solid var(--line);
    background: var(--card);
  }

  textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 54px;
    padding: var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    resize: vertical;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .hooks {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    color: var(--ink);
    font-size: var(--text-xs);
  }

  .dh {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    font-size: var(--text-xs);
  }

  .dh b {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .plus {
    color: var(--green);
  }

  .minus {
    color: var(--red);
  }

  /* One file as the Changes tab draws a diff: both line numbers, the sign, the line. */
  .lines {
    max-height: 70vh;
    overflow-y: auto;
    padding: var(--space-1) 0;
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  /* A long line wraps, so the page never scrolls sideways. */
  .ln {
    display: grid;
    grid-template-columns: 40px 40px 18px minmax(0, 1fr);
    line-height: 21px;
  }

  .no {
    padding-right: var(--space-2);
    font-size: var(--mono-2xs);
    text-align: right;
    color: var(--muted);
  }

  .sg {
    text-align: center;
    color: var(--muted);
  }

  .c {
    color: var(--ink-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  [data-line='add'] {
    background: var(--green-bg);
  }

  [data-line='add'] .sg {
    color: var(--green);
  }

  [data-line='del'] {
    background: var(--red-bg);
  }

  [data-line='del'] .sg {
    color: var(--red);
  }

  [data-line='add'] .c,
  [data-line='del'] .c {
    color: var(--ink);
  }

  [data-line='hunk'] {
    background: var(--blue-bg);
  }

  [data-line='hunk'] .c {
    color: var(--blue);
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: center;
    padding: 36px var(--space-5);
    text-align: center;
  }

  .empty b {
    font-size: var(--text-md);
    font-weight: 600;
  }

  .said {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  @media (max-width: 1200px) {
    .split {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  @media (max-width: 760px) {
    .top {
      padding: var(--space-3) var(--space-4);
    }

    .page {
      padding: var(--space-4);
    }

    .layout {
      grid-template-columns: minmax(0, 1fr);
    }

    .ln {
      grid-template-columns: 32px 32px 14px minmax(0, 1fr);
    }
  }

  /* A long subject is allowed, so this is amber and never red. */
  .warn {
    margin: 0;
    padding: var(--space-2) 10px;
    border-radius: var(--radius-md);
    background: var(--amber-bg);
    color: var(--ink);
    font-size: var(--text-2xs);
    line-height: 1.5;
  }
</style>
