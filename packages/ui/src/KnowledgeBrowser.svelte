<script lang="ts">
  import { type Estimate, estimateFrom, estimateText, learnEstimateText, phaseLabel } from '@nolzu/protocol';
  import { elapsed } from './board/elapsed.ts';
  import { tick } from 'svelte';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import { startsCommand } from './board/drop.ts';
  import KeyCaps from './KeyCaps.svelte';
  import {
    codeSpans,
    dayMonth,
    fileMatches,
    type KnowledgeChangeView,
    type KnowledgeFileRow,
    type KnowledgeFolder,
    type KnowledgeInline,
    type KnowledgeSource,
    type KnowledgeView,
    type LineGroup,
    knowledgeTree,
    NO_KNOWLEDGE,
    PATH_WORDS,
    pendingRuns,
  } from './knowledge.ts';
  import { pickOption } from './board/answer.ts';
  import { scoped } from './keymap.ts';
  import Markdown from './Markdown.svelte';
  import OptionButtons from './OptionButtons.svelte';
  import Skeleton from './Skeleton.svelte';
  import { patchLines } from './ticket/patch.ts';

  // The whole screen is worked out by knowledgeView, so this file only draws: the files, the open file with its newest change a click away, and what is known about it. The
  // file the person picks travels in the query, which is why every file is a link and not a button.
  //
  // Apply, Return and Revert are plain form posts. All three are direct git work and not runs, so
  // they carry their own pending state here instead of waiting for the board snapshot. Optimize and
  // Learn this project start a run, so theirs comes from the Now stream through `running`: the button
  // of the run going shows it with its time, and the line in the list names it with what it does now.
  let {
    view: given,
    said = null,
    review = null,
    learn = null,
    repos = null,
    onpost = null,
    running = null,
    now = null,
  }: {
    // Null while the page load still reads the folder with git: the header and Search draw, and grey
    // shapes stand where the files, the file and the side pane land, so nothing jumps.
    view: KnowledgeView | null;
    said?: { ok: boolean; message: string } | null;
    // The review setting, drawn as the switch at the foot of the side pane. Null draws no switch.
    review?: boolean | null;
    // The question a Learn this project run waits on, with the answers it offered. Null when it waits
    // on nothing, and the section then offers to start one.
    learn?: { question: string; options: readonly { label: string; means: string }[] } | null;
    // Learn your repositories: each repository, whether its file holds only the first lines Nolzu
    // wrote, and what each run starts on, or why none would. Null draws no section.
    repos?: {
      // `waiting` is a run's result that waits in Pending review, so it is neither missing nor learned.
      // `queued` is a Learn run for it that runs or waits now.
      repos: readonly { path: string; stub: boolean; waiting?: boolean; queued?: 'running' | 'waiting' }[];
      starts: { engine: string; model: string; effort: string; severalProfiles: boolean; estimate?: Estimate; like?: Estimate };
      refusal: string | null;
    } | null;
    // Sends Apply or Return in place and lands its answer in `said`. With it the page stays where the
    // person pressed, and the answer prints under the pending list. Null posts the plain form, which
    // reloads the page at its top.
    onpost?: ((form: HTMLFormElement) => Promise<void>) | null;
    // The knowledge run going now, off the Now stream: its name as a person reads it (such as Learn this
    // project, Optimize or a card key), when it started and its last tool action. Null with none.
    running?: { name: string; since: string | null; line: string | null } | null;
    // The page's clock, for the time the run has taken.
    now?: Date | null;
  } = $props();

  const WAITING: KnowledgeView = { folder: null, problem: null, empty: false, fileCount: 0, lastReviewed: null, lastOptimize: null, place: null, busy: null, files: [], open: null, pending: [], repos: [] };
  const view = $derived(given ?? WAITING);

  // The repositories ticked to learn. A repository with only the first lines is ticked at first, and
  // one a run already filled is left for the person to tick, because learning it again costs a run.
  // One a Learn run runs or waits for is neither ticked nor offered, so a second press starts no copy.
  const toLearn = (repo: { stub: boolean; waiting?: boolean; queued?: string }) => repo.stub && repo.waiting !== true && repo.queued === undefined;
  // svelte-ignore state_referenced_locally
  let picked = $state<string[]>(repos?.repos.filter(toLearn).map((repo) => repo.path) ?? []);
  const repoName = (path: string) => (path === '.' ? 'The project folder' : path);
  const repoWord = (repo: { stub: boolean; waiting?: boolean; queued?: string }) =>
    repo.queued === 'running' ? 'learning now' : repo.queued === 'waiting' ? 'waiting to learn' : repo.waiting === true ? 'waiting for review' : repo.stub ? 'not learned yet' : 'learned';
  const learning = $derived(repos?.repos.some((repo) => repo.queued !== undefined) ?? false);

  // The reply to Learn this project. A press on an answer fills it and sends nothing.
  let draft = $state('');

  // The file that is open travels in the query, and an action written as `?/name` alone would
  // replace the whole query with it. The person would land back here with no file open and the
  // block they had in front of them gone, so every post carries the open file with it.
  const post = (action: string) => (view.open === null ? `?/${action}` : `?file=${encodeURIComponent(view.open.path)}&/${action}`);

  // The form that was posted and the sentence it shows while it is going. One answer at a time,
  // because all three act on the same knowledge folder.
  type Working = { key: string; message: string };
  let working = $state<Working | null>(null);
  const start = (key: string, message: string) => {
    working = { key, message };
  };
  // Whether the answer in `said` is one to Apply or Return sent in place, which prints under the list.
  let answeredHere = $state(false);
  let answer = $state<HTMLElement>();
  const sendHere = (event: SubmitEvent, key: string, message: string) => {
    start(key, message);
    if (onpost === null) return;
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const runs = new FormData(form).getAll('run').map(Number);
    void onpost(form).finally(async () => {
      working = null;
      answeredHere = true;
      // The answer reaches `said` through the page, so it is read once that has drawn.
      await tick();
      if (said?.ok === true) answered = [...answered, ...runs];
      await tick();
      // The heading can sit far above the change pressed when many wait, so the answer comes into view.
      answer?.scrollIntoView?.({ block: 'nearest' });
    });
  };

  const REVERT_HINT = 'Commits this file back to what it was before this change.';
  const took = $derived(running?.since == null || now === null ? '' : ` · ${elapsed(running.since, now) ?? ''}`);
  const orienting = $derived(running?.name === phaseLabel('orient'));
  const optimizing = $derived(running?.name === phaseLabel('optimize'));
  const optimizeHint = $derived(
    view.busy === null
      ? 'Rewrites this file so it stays short and true. Open the file again to see how the run ended.'
      : 'The knowledge lane is busy. Open the file again once that run has ended.',
  );
  // The change is placed in the file when its lines could be found there. Otherwise its lines are
  // in History only, so there is nothing to show in the file and no toggle.
  const placed = $derived(view.open?.parts.some((part) => part.kind === 'change') ?? false);
  // The file opens plain, because the person came to read it. Show the change draws the newest
  // change's lines in place. Held by change id, so another file or a newer change opens plain again.
  let shownChange = $state<number | null>(null);
  const showing = $derived(shownChange === view.open?.inline?.change.id);
  // A run whose Apply or Return was answered ok leaves the list at once. The fresh view lands a moment
  // later, and a second press on it meanwhile would be refused.
  let answered = $state<number[]>([]);
  const pending = $derived(pendingRuns(view.pending).filter((one) => !answered.includes(one.runId)));
  // The run open in the large view. It closes by itself once its Apply takes it out of the list.
  let opened = $state<number | null>(null);
  const openRun = $derived(pending.find((one) => one.runId === opened));

  // Search knowledge narrows the file list by name and by what a file says. Every file's text came
  // with the page, so nothing is asked of the server.
  let query = $state('');
  let searchBox = $state<HTMLInputElement | undefined>();
  const shownFiles = $derived(view.files.filter((file) => fileMatches(file, query)));
  const tree = $derived(knowledgeTree(shownFiles, view.repos));
  // A folder the person opened or closed stays that way. Until then it is open when it holds the open
  // file, or while a search runs, so every match is in sight.
  let unfolded = $state<Record<string, boolean>>({});
  const isOpen = (folder: KnowledgeFolder) => unfolded[folder.path] ?? (folder.holdsOpen || query.trim() !== '');
  const toggle = (folder: KnowledgeFolder) => (unfolded[folder.path] = !isOpen(folder));
  // The tree takes one Tab stop, as a tree role does: the row the arrows reached last, else the open
  // file, else the first row. A folder's key cannot clash with a file path, which never ends in "/".
  const dirKey = (folder: KnowledgeFolder) => `${folder.path}/`;
  let reached = $state<string | null>(null);
  const rows = $derived([
    ...tree.folders.flatMap((folder) => [dirKey(folder), ...(isOpen(folder) ? folder.files.map((file) => file.path) : [])]),
    ...tree.top.map((file) => file.path),
  ]);
  const stop = $derived(reached !== null && rows.includes(reached) ? reached : (shownFiles.find((file) => file.open && rows.includes(file.path))?.path ?? rows[0]));

  // The tree keys: up and down move, right opens a folder or steps into it, left closes it or steps
  // back to it, Enter and Space open or close a folder. Enter on a file is the link's own.
  function treeKeys(event: KeyboardEvent) {
    const items = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const item = items[at]!;
    const folder = tree.folders.find((one) => dirKey(one) === item.dataset.key);
    const move = (to: HTMLElement | null | undefined) => {
      event.preventDefault();
      if (to == null) return;
      reached = to.dataset.key ?? null;
      to.focus();
    };
    if (event.key === 'ArrowDown') move(items[at + 1]);
    else if (event.key === 'ArrowUp') move(items[at - 1]);
    else if (event.key === 'Home') move(items[0]);
    else if (event.key === 'End') move(items.at(-1));
    else if (event.key === 'ArrowRight' && folder !== undefined) {
      if (isOpen(folder)) move(items[at + 1]);
      else {
        event.preventDefault();
        toggle(folder);
      }
    } else if (event.key === 'ArrowLeft') {
      if (folder !== undefined && isOpen(folder)) {
        event.preventDefault();
        toggle(folder);
      } else if (folder === undefined) move(item.closest('[role="group"]')?.closest<HTMLElement>('[role="treeitem"]'));
    } else if ((event.key === 'Enter' || event.key === ' ') && folder !== undefined) {
      event.preventDefault();
      toggle(folder);
    }
  }
  const findKeys = scoped('knowledge').find((binding) => binding.action === 'find')?.keys ?? [];
  // The route binds "/" to this through the app's one key handler, as the cap says.
  export function focusSearch(): void {
    searchBox?.focus();
  }
</script>

{#snippet spans(line: string)}{#each codeSpans(line) as piece, index (index)}{#if piece.code}<code>{piece.text}</code>{:else}{piece.text}{/if}{/each}{/snippet}

{#snippet lines(group: LineGroup)}
  <!-- A blank line has no words to show. The +N and -N counts still include it. -->
  {#each group.removed as line, index (index)}{#if line.trim() !== ''}<del>{@render spans(line)}</del>{/if}{/each}
  {#each group.added as line, index (index)}{#if line.trim() !== ''}<ins>{@render spans(line)}</ins>{/if}{/each}
{/snippet}

<!-- Who a change came from: the card's key as a link, or words when there is no card to link. -->
{#snippet mark(source: KnowledgeSource | null)}
  {#if source === null}
    <span class="quiet">card deleted</span>
  {:else if source.kind === 'maintenance'}
    <span class="chip">maintenance</span>
  {:else}
    <a class="key" href="/t/{encodeURIComponent(source.key ?? '')}">{source.key}</a>
  {/if}
{/snippet}

{#snippet head(inline: KnowledgeInline)}
  {@const change = inline.change}
  <div class="chg-h">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>
    <span>
      {inline.whole ? 'Written by' : 'Changed by'}
      {#if change.source === null}a card that was deleted{:else if change.source.kind === 'maintenance'}a maintenance run{:else}{@render mark(change.source)} wrap-up{/if}{change.when === null
        ? ''
        : ` · ${change.when}`}
    </span>
    {#if placed}
      <Button size="small" variant="ghost" aria-pressed={showing} onclick={() => (shownChange = showing ? null : change.id)}>Show the change</Button>
    {/if}
    <!-- One click, on the change the person is reading. A commit, never a reset: the history of
         that repository is theirs. -->
    <form method="POST" action={post('revert')} onsubmit={() => start(`revert:${change.id}`, 'Making the revert commit in the knowledge folder.')}>
      <input type="hidden" name="change" value={change.id} />
      <Button type="submit" size="small" variant="ghost" disabled={working !== null} aria-busy={working?.key === `revert:${change.id}` ? 'true' : undefined} title={REVERT_HINT} aria-describedby="revert-hint">Revert</Button>
      <span id="revert-hint" class="sr">{REVERT_HINT}</span>
    </form>
  </div>
  {#if working?.key === `revert:${change.id}`}<p class="going" role="status">{working.message}</p>{/if}
{/snippet}

{#snippet history(change: KnowledgeChangeView)}
  <li>
    <div class="hr1">
      {@render mark(change.source)}
      {#if change.when !== null}<span class="muted">{change.when}</span>{/if}
      {#if change.status !== 'applied'}<span class="status">{change.statusLabel}</span>{/if}
      {#if change.lines !== null}<span class="add">+{change.lines.added}</span><span class="del">-{change.lines.removed}</span>{/if}
    </div>
    <!-- The run writes Markdown. Under the History heading (h2), its headings start at h3. -->
    {#if change.summary !== null}<div class="summary"><Markdown source={change.summary} headingsFrom={3} /></div>{/if}
    {#if change.note !== null}<p>Returned with this note: {change.note}</p>{/if}
    {#if change.diff !== null}
      <details>
        <summary>Diff{#if change.shortSha !== null}&nbsp;<span class="sha">{change.shortSha}</span>{/if}</summary>
        <pre class="patch">{#each patchLines(change.diff) as line, index (index)}<span class="line" data-line={line.kind}>{line.text}</span>
{/each}</pre>
      </details>
    {:else}
      <p class="quiet">{change.diffNote}</p>
    {/if}
  </li>
{/snippet}

<!-- A file is a link, so Enter and a click open it with no script. The focus stays on it after, so a
     keyboard user goes on from the tree and not from the top of the page. -->
{#snippet fileRow(file: KnowledgeFileRow, level: number)}
  <a
    class="kf"
    href="?file={encodeURIComponent(file.path)}"
    role="treeitem"
    aria-level={level}
    aria-selected={file.open}
    aria-current={file.open ? 'page' : undefined}
    tabindex={stop === file.path ? 0 : -1}
    data-key={file.path}
    data-sveltekit-keepfocus
    onfocus={() => (reached = file.path)}
  >
    <span class="nm">{file.name}</span>
    <span class="ts">{file.updated === null ? 'not committed yet' : `updated ${file.updated}`}</span>
    {#if file.pending}<span class="ts wait">waiting for review</span>{/if}
    {#if file.gone.length > 0}
      <span class="ts" title={file.gone.join(', ')}>{file.gone.length} {file.gone.length === 1 ? 'path' : 'paths'} {PATH_WORDS.gone}</span>
    {/if}
  </a>
{/snippet}

<div class="knowledge">
  <div class="top">
    <h1>Knowledge</h1>
    <span class="sub">What agents read before they work, learned from your repositories and your cards.</span>
    <span class="sp"></span>
    <!-- Escape in the box clears it, then leaves it, so the typed text is the box's own. -->
    <label class="srch">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
      <input
        type="search"
        bind:this={searchBox}
        bind:value={query}
        placeholder="Search knowledge"
        aria-label="Search knowledge"
        data-search
        onkeydown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          if (query !== '') query = '';
          else searchBox?.blur();
        }}
      />
      <KeyCaps combos={findKeys} />
    </label>
    <!-- The one button beside a file that starts a run, so it is the go button, and its state comes
         from the Now stream and never from the click. It rewrites the open file, so it is drawn only
         while one is. -->
    {#if view.open !== null}
      <form method="POST" action={post('optimize')}>
        <input type="hidden" name="file" value={view.open.path} />
        <Button type="submit" variant="go" disabled={view.busy !== null} aria-busy={optimizing ? 'true' : undefined} title={optimizeHint} aria-describedby="optimize-hint"
          >{#if optimizing}<span class="spin" aria-hidden="true"></span>{`Optimizing${took}`}{:else}Optimize{/if}</Button
        >
        <span id="optimize-hint" class="sr">{optimizeHint}</span>
      </form>
    {/if}
  </div>

  <div class="panes">
    <nav class="list" aria-label="Knowledge files">
      <div class="group">Project{#if given !== null}<span class="n">{view.fileCount}</span>{/if}</div>
      {#if given === null}
        <Skeleton shape="list" count={5} label="Reading the knowledge folder with git." />
      {:else}
      {#if running !== null}
        <p class="busy" role="status"><span class="dot" aria-hidden="true"></span>{`${running.name} is writing knowledge${took}.`} The folder is locked until that run ends.</p>
        {#if running.line !== null}<p class="busy act" title={running.line}>{running.line}</p>{/if}
      {:else if view.busy !== null}
        <p class="busy"><span class="dot" aria-hidden="true"></span>{view.busy} is writing knowledge. The folder is locked until that run ends.</p>
      {/if}
      <!-- Why there is no list is said once, in the middle pane, where the person is reading. -->
      {#if shownFiles.length === 0 && view.files.length > 0}<p class="quiet none" role="status">No file holds "{query.trim()}".</p>{/if}
      <ul class="tree" role="tree" aria-label="Knowledge files" onkeydown={treeKeys}>
        {#each tree.folders as folder (folder.path)}
          {@const open = isOpen(folder)}
          <!-- The label names the folder alone; drawn from its content, it would read every open file too. -->
          <li
            class="dir"
            role="treeitem"
            aria-level={1}
            aria-expanded={open}
            aria-selected={false}
            aria-label="{folder.label}, {folder.files.length} {folder.files.length === 1 ? 'file' : 'files'}{folder.pending > 0 ? `, ${folder.pending} to review` : ''}"
            tabindex={stop === dirKey(folder) ? 0 : -1}
            data-key={dirKey(folder)}
            onfocus={() => (reached = dirKey(folder))}
          >
            <!-- The keys are on the tree, so the row only takes the click. -->
            <span class="row" role="presentation" onclick={() => toggle(folder)}>
              <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>
              <span class="dn">{folder.label}</span>
              <span class="n">{folder.files.length}</span>
              {#if folder.pending > 0}<span class="wait">{folder.pending} to review</span>{/if}
            </span>
            {#if open}
              <ul role="group">
                {#each folder.files as file (file.path)}
                  <li role="none">{@render fileRow(file, 2)}</li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
        {#each tree.top as file (file.path)}
          <li role="none">{@render fileRow(file, 1)}</li>
        {/each}
      </ul>
      <div class="foot">
        <span>Last Optimize {dayMonth(view.lastOptimize) ?? 'never'}</span>
        {#if view.place !== null}<span class="path" title={view.place}>{view.place}</span>{/if}
      </div>
      {/if}
    </nav>

    <article class="doc" aria-label={view.open === null ? 'No file open' : `The file ${view.open.path}`}>
      {#if given === null}
        <Skeleton shape="line" width="40%" label="" />
        <Skeleton shape="text" count={6} label="" />
      {:else if view.open === null}
        <p class="quiet" role="status">{view.problem ?? (view.empty ? NO_KNOWLEDGE : 'Pick a file to read it.')}</p>
      {:else}
        <div class="crumb">{view.open.repoPath} · {view.open.lineCount} {view.open.lineCount === 1 ? 'line' : 'lines'}</div>
        {#if view.open.description !== null}<p class="desc">{view.open.description}</p>{/if}
        <div class="body">
          {#if view.open.inline !== null}
            <div class="change">{@render head(view.open.inline)}</div>
          {/if}
          {#if showing}
            {#each view.open.parts as part, index (index)}
              {#if part.kind === 'text'}
                <Markdown source={part.text} headingsFrom={2} />
              {:else}
                <div class="change">{@render lines(part)}</div>
              {/if}
            {/each}
          {:else}
            <Markdown source={view.open.body} headingsFrom={2} />
          {/if}
        </div>
      {/if}
    </article>

    <aside class="side" aria-label="About this file">
      <!-- Whatever the last post answered, refused or done. At the top, because Revert sits in the
           file and Apply in the pending list below. -->
      {#if said !== null && !answeredHere}
        <p class="said" class:refused={!said.ok} role={said.ok ? 'status' : 'alert'}>{said.message}</p>
      {/if}
      {#if given === null}
        <Skeleton shape="card" label="" />
        <Skeleton shape="card" label="" />
      {:else}
      {#if view.open !== null}
        <section class="sec">
          <h2>Taught by<span class="n">{view.open.taughtBy.length}</span></h2>
          {#if view.open.taughtBy.length === 0}
            <p class="quiet">No change of this file names a card that is still here.</p>
          {:else}
            <ul class="taught">
              {#each view.open.taughtBy as one, index (index)}
                <li>
                  {#if one.kind === 'maintenance'}
                    <span class="row"><span class="tk">maintenance</span></span>
                  {:else}
                    <a class="row" href="/t/{encodeURIComponent(one.key ?? '')}"><span class="tk">{one.key}</span><span class="tt">{one.title}</span></a>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- A note names the code it depends on, so a note whose code moved on says so before it
             is trusted. -->
        <section class="sec">
          <h2>Depends on<span class="n">{view.open.paths.length}</span></h2>
          {#if view.open.paths.length === 0}
            <p class="quiet">This file names no paths it depends on.</p>
          {:else}
            <ul class="deps">
              {#each view.open.paths as one (one.path)}
                <li><code>{one.path}</code><span class="ts">{PATH_WORDS[one.state]}</span></li>
              {/each}
            </ul>
          {/if}
        </section>

        <section class="sec">
          <h2>History<span class="n">{view.open.history.length}</span></h2>
          {#if view.open.history.length === 0}
            <p class="quiet">No run has changed this file yet.</p>
          {:else}
            <ul class="hist">
              {#each view.open.history as change (change.id)}{@render history(change)}{/each}
            </ul>
          {/if}
        </section>
      {/if}

      <!-- Learn this project starts a run, so its button is the go button, held while the knowledge lane
           is busy. Its questions are answered here, because the run belongs to no card. Drawn while no
           file is open, the screen's first view, so Optimize stays the one go button beside a file. -->
      {#if view.open === null}
      <section class="sec learn" id="learn" aria-labelledby="learn-title">
        {#if learn !== null}
          <h2 id="learn-title">Learn this project asks</h2>
          <p class="q">{learn.question}</p>
          <form method="POST" action={post('answer')} onsubmit={() => start('answer', 'Sending your answer.')}>
            <OptionButtons options={learn.options} answer={draft} onpick={(label) => (draft = pickOption(draft, learn?.options ?? [], label))} />
            <label class="sr" for="learn-answer">Your answer</label>
            <textarea id="learn-answer" name="answer" rows="2" bind:value={draft} placeholder="Or write your own answer"></textarea>
            <Button type="submit" variant="go" glyph="resume" disabled={working !== null || draft.trim() === ''} aria-busy={working?.key === 'answer' ? 'true' : undefined}>Send and resume</Button>
          </form>
        {:else}
          <h2 id="learn-title">Learn this project</h2>
          <p class="quiet">Reads the README, the agent files and the CI, asks you up to four questions, and writes up to three short files. They wait here for your review.</p>
          <form method="POST" action={post('learn')} onsubmit={() => start('learn', 'Starting Learn this project.')}>
            <Button type="submit" variant="go" disabled={view.busy !== null || working !== null} aria-busy={working?.key === 'learn' || orienting ? 'true' : undefined}
              >{#if orienting}<span class="spin" aria-hidden="true"></span>{`Learning this project${took}`}{:else}Learn this project{/if}</Button
            >
          </form>
        {/if}
        {#if working?.key === 'answer' || working?.key === 'learn'}<p class="going" role="status">{working.message}</p>{/if}
      </section>
      {/if}

      <!-- Learn your repositories: one run per ticked repository, which the knowledge lane runs one
           after another. The Starts line is the consent line every run shows before it starts. -->
      {#if view.open === null && repos !== null && repos.repos.length > 0}
        <section class="sec learn" id="learn-repos" aria-labelledby="learn-repos-title">
          <h2 id="learn-repos-title">Learn your repositories</h2>
          <p class="quiet">Reads each repository's README, CI files and build files such as package.json or composer.json. Writes what it is for, how to install, run, test, lint and build it, and the rules the code keeps everywhere, with where each line was read. One run per repository, one after another.</p>
          <form method="POST" action={post('learnRepos')} onsubmit={() => start('learnRepos', 'Starting Learn your repositories.')}>
            <fieldset class="repos">
              <legend class="sr">Repositories to learn</legend>
              {#each repos.repos as repo (repo.path)}
                <label class="repo">
                  <input type="checkbox" name="repo" value={repo.path} bind:group={picked} disabled={repo.queued !== undefined} />
                  <span class="rw">
                    <span class="nm">{repoName(repo.path)}</span>
                    <span class="ts">{repoWord(repo)}</span>
                  </span>
                </label>
              {/each}
            </fieldset>
            {#if repos.refusal === null}
              <p class="starts">Starts: {startsCommand(repos.starts)}</p>
              <p class="quiet">
                {#if repos.starts.estimate !== undefined}<span class="figure">{estimateText(repos.starts.estimate)}</span> per repository, {estimateFrom(repos.starts.estimate)}.{:else}{learnEstimateText(repos.starts)}{/if}
                Runs on this machine and reads only. Nothing is applied before you approve it.
              </p>
            {:else}
              <p class="said refused">{repos.refusal}</p>
            {/if}
            {#if learning}
              <p class="quiet" role="status">Learn runs are going, one after another. Open Knowledge again to see what they wrote.</p>
            {:else if picked.length === 0 && !repos.repos.some(toLearn)}
              <p class="quiet">Every repository is learned or waits for review. Tick one to learn it again.</p>
            {:else}
              <Button type="submit" variant="go" disabled={view.busy !== null || working !== null || repos.refusal !== null || picked.length === 0} aria-busy={working?.key === 'learnRepos' ? 'true' : undefined}>
                {picked.length === 1 ? 'Learn 1 repository' : `Learn ${picked.length} repositories`}
              </Button>
            {/if}
          </form>
          {#if working?.key === 'learnRepos'}<p class="going" role="status">{working.message}</p>{/if}
        </section>
      {/if}

      <section class="sec">
        <div class="pend-head">
          <h2>Pending review<span class="n">{pending.length}</span></h2>
          <!-- Exactly the runs on screen, so one that lands after the page drew still waits for a read. -->
          {#if pending.length > 1}
            <form method="POST" action={post('approveAll')} onsubmit={(event) => sendHere(event, 'approveAll', 'Applying every change, one commit each.')}>
              {#each pending as one (one.runId)}<input type="hidden" name="run" value={one.runId} />{/each}
              <Button type="submit" size="small" disabled={working !== null} aria-busy={working?.key === 'approveAll' ? 'true' : undefined} title="Applies every change below, oldest first, one commit each. Stops at the first refusal.">Apply all ({pending.length})</Button>
            </form>
          {/if}
        </div>
        {#if working?.key === 'approveAll'}<p class="going" role="status">{working.message}</p>{/if}
        <!-- The answer to Apply or Return sent in place, where the person pressed it. -->
        {#if said !== null && answeredHere}
          <p class="said" class:refused={!said.ok} role={said.ok ? 'status' : 'alert'} bind:this={answer}>{said.message}</p>
        {/if}
        {#if pending.length === 0}
          <p class="quiet">Nothing waits for a person.</p>
        {:else}
          <!-- One run is one commit, so Apply and Return act on the whole run and never on one file of it. -->
          {#each pending as one (one.runId)}
            <div class="waiting">
              <div class="hr1">
                {@render mark(one.source)}<span class="muted">{one.by}</span>
              </div>
              {#each one.changes as change (change.id)}
                <p class="pending-file">{change.path}</p>
                {#if change.summary !== null}<div class="summary"><Markdown source={change.summary} headingsFrom={3} /></div>{/if}
                {#if change.held !== null && change.held.length > 0}
                  <div class="change kept">{#each change.held as group, index (index)}{@render lines(group)}{/each}</div>
                {:else}
                  <p class="quiet">{change.diffNote}</p>
                {/if}
              {/each}
              <div class="acts">
                <Button size="small" variant="ghost" aria-haspopup="dialog" onclick={() => (opened = one.runId)}>Read in full</Button>
                <form method="POST" action={post('approve')} onsubmit={(event) => sendHere(event, `approve:${one.runId}`, 'Applying the change and committing it in the knowledge folder.')}>
                  <input type="hidden" name="run" value={one.runId} />
                  <Button type="submit" size="small" variant="primary" disabled={working !== null} aria-busy={working?.key === `approve:${one.runId}` ? 'true' : undefined} title="Writes the files and commits them.">Apply</Button>
                </form>
                <!-- A return needs a note, which the next run reads, so the note field opens under Return. -->
                <details class="ret">
                  <summary>Return</summary>
                  <form method="POST" action={post('return')} onsubmit={(event) => sendHere(event, `return:${one.runId}`, 'Sending the change back with the note.')}>
                    <input type="hidden" name="run" value={one.runId} />
                    <label for="note-{one.runId}">Why it goes back</label>
                    <textarea id="note-{one.runId}" name="note" rows="2" required></textarea>
                    <Button type="submit" size="small" disabled={working !== null} aria-busy={working?.key === `return:${one.runId}` ? 'true' : undefined}>Return</Button>
                    <span class="quiet">Drops the files. {one.source?.kind === 'maintenance' ? `The next ${one.by} run reads the note.` : one.source === null ? 'Its card was deleted, so no run reads the note.' : 'The next wrap-up of this card reads the note.'}</span>
                  </form>
                </details>
              </div>
              {#if working?.key === `approve:${one.runId}` || working?.key === `return:${one.runId}`}
                <p class="going" role="status">{working.message}</p>
              {/if}
            </div>
          {/each}
        {/if}
      </section>
      <!-- The side pane is narrow and caps each diff, so a change can be read whole in a large view. -->
      {#if openRun !== undefined}
        <Dialog wide title="{openRun.by}: {openRun.changes.length} {openRun.changes.length === 1 ? 'file' : 'files'}" sub="One run is one commit, so Apply takes every file below." closer="Close" onclose={() => (opened = null)}>
          <div class="full">
            {#each openRun.changes as change (change.id)}
              <h3 class="pending-file">{change.path}</h3>
              {#if change.summary !== null}<div class="summary"><Markdown source={change.summary} headingsFrom={4} /></div>{/if}
              {#if change.held !== null && change.held.length > 0}
                <div class="change big">{#each change.held as group, index (index)}{@render lines(group)}{/each}</div>
              {:else}
                <p class="quiet">{change.diffNote}</p>
              {/if}
            {/each}
          </div>
          {#snippet footer()}
            <form method="POST" action={post('approve')} onsubmit={(event) => sendHere(event, `approve:${openRun.runId}`, 'Applying the change and committing it in the knowledge folder.')}>
              <input type="hidden" name="run" value={openRun.runId} />
              <Button type="submit" variant="primary" disabled={working !== null} aria-busy={working?.key === `approve:${openRun.runId}` ? 'true' : undefined}>Apply</Button>
            </form>
            {#if working?.key === `approve:${openRun.runId}`}<p class="going" role="status">{working.message}</p>{/if}
            {#if said !== null && answeredHere && !said.ok}<p class="said refused" role="alert">{said.message}</p>{/if}
          {/snippet}
        </Dialog>
      {/if}

      <!-- The one knowledge setting. Settings, Runs has it too, and both write the same setting. A
           change of the switch posts its form, which needs no Save button. -->
      {#if review !== null}
        <form method="POST" action={post('review')} class="sw-row">
          <input type="hidden" name="field" value="reviewKnowledge" />
          <input
            id="knowledge-review"
            name="value"
            type="checkbox"
            role="switch"
            checked={review}
            onchange={(event) => event.currentTarget.form?.requestSubmit()}
          />
          <label for="knowledge-review">Review changes before applying</label>
        </form>
      {/if}
      {/if}
    </aside>
  </div>
</div>

<style>
  .knowledge {
    display: flex;
    flex-direction: column;
    min-height: calc(100vh - var(--offline-height, 0px));
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

  .sub {
    color: var(--muted);
    font-size: var(--text-sm);
  }

  .sp {
    flex: 1;
  }

  .panes {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  /* The files. */
  .list {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 2px;
    box-sizing: border-box;
    width: 240px;
    padding: 14px 10px;
    border-right: 1px solid var(--line);
  }

  .group {
    display: flex;
    align-items: center;
    padding: 2px 10px 6px;
    font-size: var(--text-2xs);
    font-weight: 500;
    color: var(--muted);
  }

  .group .n {
    margin-left: auto;
    font-family: var(--font-mono);
  }

  .tree,
  .tree ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* A file's name starts where the folder's label does: the row's 10px, the 14px chevron and the 6px
     gap, less the file row's own 10px. */
  .tree ul {
    margin-top: 2px;
    padding-left: 20px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: 7px;
    font-size: var(--text-sm);
    color: var(--ink-2);
    cursor: pointer;
  }

  .row:hover {
    background: var(--card);
  }

  /* The ring goes on the folder's own row, not around the files open under it. */
  .dir:focus-visible {
    outline: none;
  }

  .dir:focus-visible > .row {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
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

  .dir[aria-expanded='true'] > .row .chev {
    transform: rotate(90deg);
  }

  .dn {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row .n {
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  /* A word in ink and not amber: amber is for agent work, and the folder row is a control. */
  .row .wait {
    margin-left: auto;
    font-size: var(--text-2xs);
    color: var(--ink-2);
  }

  .kf {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 7px 10px;
    border-radius: 7px;
    text-decoration: none;
  }

  .kf .nm {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .kf .ts {
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  .kf .ts.wait {
    color: var(--ink-2);
  }

  .kf:hover,
  .kf[aria-current='page'] {
    background: var(--card);
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .kf[aria-current='page'] .nm {
    color: var(--ink);
  }

  /* The dot is decoration, amber because an agent is at work. The sentence says which card holds
     the folder. */
  .busy {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0 0 var(--space-1);
    padding: 0 10px;
    font-size: var(--text-xs);
    color: var(--ink-3);
  }

  /* What the run does now, under the line that names it, cut to one line. */
  .act {
    display: block;
    padding-left: calc(10px + 7px + var(--space-2));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Turns while the run goes, beside the words that say so. Still when the system asks for less motion. */
  .spin {
    display: inline-block;
    width: 10px;
    height: 10px;
    margin-right: 6px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }

  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--amber);
  }

  .foot {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: auto;
    padding: var(--space-3) 10px 0;
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  .path,
  .crumb,
  .pending-file,
  .key,
  .tk,
  .sha,
  .add,
  .del {
    font-family: var(--font-mono);
    letter-spacing: -0.01em;
  }

  /* One line: a long folder ends in an ellipsis, and the title holds the whole name. */
  .path {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .srch {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 220px;
    min-width: 140px;
    height: 30px;
    box-sizing: border-box;
    padding: 0 6px 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
    color: var(--muted);
  }

  .srch:focus-within {
    border-color: var(--ink-2);
  }

  .srch .ico {
    width: 14px;
    height: 14px;
  }

  .srch input {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    outline: none;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  .srch input::placeholder {
    color: var(--muted);
    opacity: 1;
  }

  .none {
    padding: 0 10px;
  }

  /* The file. */
  .doc {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
    padding: 26px 40px 40px;
  }

  .crumb {
    font-size: var(--mono-2xs);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .desc {
    margin: 0;
    font-size: var(--text-md);
    color: var(--muted);
  }

  .body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  /* The file's own # and ## arrive as h2 and h3 (headingsFrom), so the title is the file's and the
     sections are small. */
  .body :global(h2) {
    margin: 0;
    font-size: var(--text-xl);
    line-height: 1.2;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .body :global(h3) {
    margin: var(--space-3) 0 0;
    font-size: var(--text-md);
    line-height: 1.3;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .change {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 9px;
    background: var(--panel);
    font-size: var(--text-base);
    line-height: 1.6;
  }

  .chg-h {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    padding: var(--space-1) 6px var(--space-1) var(--space-3);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .chg-h form {
    margin-left: auto;
  }

  .ico {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* A sign before each line, so a line out and a line in read without colour too. */
  del,
  ins {
    position: relative;
    display: block;
    min-height: 1.6em;
    padding: var(--space-1) var(--space-3) var(--space-1) 30px;
  }

  del {
    background: var(--red-bg);
    color: var(--ink-2);
    text-decoration: line-through;
    text-decoration-color: var(--red);
  }

  ins {
    background: var(--green-bg);
    color: var(--ink);
    text-decoration: none;
  }

  del::before,
  ins::before {
    position: absolute;
    left: var(--space-3);
    font-family: var(--font-mono);
  }

  del::before {
    content: '-';
    color: var(--red);
  }

  ins::before {
    content: '+';
    color: var(--green);
  }

  .change code {
    padding: 0 var(--space-1);
    border: 1px solid var(--line);
    border-radius: var(--radius-xs);
    background: var(--card-2);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }

  /* What the person knows about the file. */
  .side {
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 26px;
    box-sizing: border-box;
    width: 300px;
    padding: var(--space-5) 18px var(--space-4);
    border-left: 1px solid var(--line);
  }

  .sec {
    display: flex;
    flex-direction: column;
    gap: 9px;
  }

  h2 {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  h2 .n {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 400;
    color: var(--muted);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .deps {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .deps li {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .deps code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  .deps .ts {
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  .taught {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  /* Scoped to the list, so the tree's folder row keeps no box at rest. */
  .taught .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    padding: 7px 10px;
    border-radius: var(--radius-md);
    background: var(--card);
    font-size: var(--text-xs);
    text-decoration: none;
  }

  .tk {
    flex: none;
    min-width: 42px;
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .tt {
    overflow: hidden;
    color: var(--ink-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hist li {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: var(--space-2) 0;
    border-top: 1px solid var(--line);
  }

  .hist li:first-child {
    padding-top: 0;
    border-top: 0;
  }

  .hr1 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    min-height: 26px;
    font-size: var(--text-xs);
  }

  .hist p,
  .summary,
  .summary :global(.markdown) {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  .summary :global(.markdown > :first-child) {
    margin-top: 0;
  }

  .summary :global(.markdown > :last-child) {
    margin-bottom: 0;
  }

  .key {
    font-size: var(--mono-2xs);
    color: var(--blue);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    height: 21px;
    padding: 0 7px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--ink-2);
    font-size: var(--text-2xs);
  }

  .status {
    padding: 1px 6px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-2xs);
    color: var(--ink-2);
  }

  .add {
    font-size: var(--mono-2xs);
    color: var(--green);
  }

  .del {
    font-size: var(--mono-2xs);
    color: var(--red);
  }

  .muted {
    color: var(--muted);
  }

  details summary {
    font-size: var(--text-2xs);
    color: var(--muted);
    cursor: pointer;
  }

  .patch {
    margin: var(--space-2) 0 0;
    padding: var(--space-2) 0;
    overflow-x: auto;
    background: var(--bg);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    line-height: 1.6;
  }

  .line {
    padding: 0 var(--space-2);
    color: var(--ink-3);
  }

  [data-line='add'] {
    color: var(--green);
  }

  [data-line='del'] {
    color: var(--red);
  }

  [data-line='hunk'] {
    color: var(--muted);
  }

  .waiting {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3) var(--space-3);
    border-radius: var(--radius-lg);
    background: var(--card);
  }

  .pend-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  /* The large view: the diff at full width and full height, the dialog itself scrolls. */
  .full {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .full h3 {
    margin: var(--space-2) 0 0;
  }

  .big {
    font-size: var(--text-sm);
    line-height: 1.5;
  }

  .big del,
  .big ins {
    flex-shrink: 0;
    padding: 6px 12px 6px 28px;
  }

  .waiting + .waiting {
    margin-top: var(--space-2);
  }

  .pending-file {
    margin: 0;
    font-size: var(--mono-xs);
    color: var(--ink-2);
    overflow-wrap: anywhere;
  }

  /* A run can write a long note. Its lines scroll here, so Apply and Return stay in reach. */
  .kept {
    max-height: 240px;
    overflow-y: auto;
    font-size: var(--text-xs);
    line-height: 1.45;
  }

  /* No shrinking: in the capped column a line that wraps would be squeezed to one line's height and
     drawn over the next one. The box scrolls instead. */
  .kept del,
  .kept ins {
    flex-shrink: 0;
    padding: 6px 10px 6px 26px;
  }

  .kept del::before,
  .kept ins::before {
    left: 10px;
  }

  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 6px;
  }

  .ret {
    flex: 1;
  }

  /* A button beside Apply. Open, it shows the note field under it. */
  .ret > summary {
    display: inline-flex;
    align-items: center;
    box-sizing: border-box;
    height: 26px;
    padding: 0 9px;
    border: 1px solid var(--line-2);
    border-radius: 7px;
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-xs);
    list-style: none;
  }

  .ret > summary::-webkit-details-marker {
    display: none;
  }

  .ret form {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .ret label {
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  .ret textarea {
    box-sizing: border-box;
    width: 100%;
    font: inherit;
    font-size: var(--text-xs);
  }

  .learn form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .repos {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .repo {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--text-sm);
  }

  /* The state wraps under the name, not under the box. */
  .rw {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px var(--space-2);
    min-width: 0;
  }

  .repo .nm {
    overflow-wrap: anywhere;
  }

  .repo .ts {
    color: var(--muted);
    font-size: var(--text-2xs);
  }

  /* The Starts line on the amber tint, as the drop box and the start confirm draw it. A line of text,
     never a control. */
  .learn .starts {
    margin: 0;
    padding: var(--space-2) 10px;
    border-radius: var(--radius-md);
    background: var(--amber-bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    line-height: 1.55;
  }

  .learn .figure {
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .learn .q {
    margin: 0;
    font-size: var(--text-sm);
  }

  .learn textarea {
    box-sizing: border-box;
    width: 100%;
    font: inherit;
    font-size: var(--text-xs);
  }

  .sw-row {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: auto 0 0;
    padding-top: 14px;
    border-top: 1px solid var(--line);
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  /* A checkbox drawn as the shared Switch, so the form posts as it is. On is cream and never amber:
     a setting starts no run. The knob moves too, so on and off are not colour alone. */
  input[role='switch'] {
    appearance: none;
    position: relative;
    flex: none;
    width: 30px;
    height: 18px;
    margin: 0;
    border-radius: 999px;
    background: var(--line-2);
    cursor: pointer;
  }

  input[role='switch']::after {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--ink);
    content: '';
  }

  input[role='switch']:checked {
    background: var(--accent);
  }

  input[role='switch']:checked::after {
    left: 14px;
    background: var(--accent-ink);
  }

  .said {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  .said.refused {
    color: var(--red);
  }

  .going,
  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .doc > .quiet {
    font-size: var(--text-sm);
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* One column on a narrow window: the files, then the file, then what is known about it. */
  @media (max-width: 760px) {
    .top {
      padding: var(--space-3) var(--space-4);
    }

    .panes {
      flex-direction: column;
    }

    .list,
    .side {
      width: auto;
      border-right: 0;
      border-left: 0;
    }

    .list {
      border-bottom: 1px solid var(--line);
    }

    .side {
      border-top: 1px solid var(--line);
    }

    .doc {
      padding: var(--space-5) var(--space-4);
    }
  }
</style>
