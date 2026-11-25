<script lang="ts">
  import type { Changes, DiffComment, DiffEntry, FileTreeNode } from '@nolzu/protocol';
  import { placeComments } from './comments.ts';
  import Skeleton from '../Skeleton.svelte';
  import LineComment from './LineComment.svelte';
  import { numberedLines, type NumberedLine } from './patch.ts';
  import { repoSuffix } from './repo-id.ts';

  type Group = 'committed' | 'uncommitted' | 'branch' | 'commit';
  type Patch = { ok: true; text: string } | { ok: false; reason: string };
  type Said = Promise<string | null>;

  // One repository's change: the files on the left and the open file's
  // diff on the right, with both line numbers and a comment gutter. `onopen` asks the page for one
  // file's patch, because this package never fetches. Without it the files are a plain list. The
  // comment writers answer null or the sentence the server refused with; without them a comment shows
  // with no buttons.
  let {
    changes,
    onopen = null,
    comments = [],
    oncomment = null,
    onedit = null,
    ondelete = null,
    group = 'branch',
    against = null,
  }: {
    // `changes.diff` is the diff drawn. `group` is the one each file's patch is asked from, `branch`
    // by default, the base to the folder. `against` names what the diff compares to, the base by default.
    changes: Changes;
    onopen?: ((ask: { path: string; oldPath: string | null; group: Group }) => Promise<Patch>) | null;
    // This repository's comments, every file.
    comments?: readonly DiffComment[];
    oncomment?: ((ask: { file: string; line: number; lineText: string; text: string }) => Said) | null;
    onedit?: ((id: number, text: string) => Said) | null;
    ondelete?: ((id: number) => Said) | null;
    group?: Group;
    against?: string | null;
  } = $props();

  let open = $state<DiffEntry | null>(null);
  // Null while the answer is on its way.
  let patch = $state<Patch | null>(null);
  // Counts the picks, so an answer to an earlier pick cannot replace the file picked since.
  let picks = 0;
  // The line, by its place in the open file, whose new comment field is open.
  let draft = $state<number | null>(null);

  // One file, one request, when the person opens it. A binary file has no text, so nothing is asked.
  // The open file is asked again only when its last answer was a refusal, so a failed read can be retried.
  async function pick(entry: DiffEntry): Promise<void> {
    if (onopen === null || (open?.path === entry.path && (patch === null || patch.ok))) return;
    picks += 1;
    const mine = picks;
    open = entry;
    patch = null;
    draft = null;
    if (entry.binary) return;
    // From the base to the folder by default, so a line's new number is its line in the folder, where a
    // comment points.
    const said = await onopen({ path: entry.path, oldPath: entry.oldPath, group });
    if (mine === picks) patch = said;
  }

  const entriesOf = (list: readonly FileTreeNode[]): DiffEntry[] => list.flatMap((node) => (node.entry === null ? entriesOf(node.children) : [node.entry]));
  const byFile = (list: readonly DiffComment[]): [string, DiffComment[]][] =>
    [...new Set(list.map((one) => one.file))].map((file) => [file, list.filter((one) => one.file === file)]);

  const diff = $derived(changes.ok ? (changes.diff ?? null) : null);
  // The one diff mixes committed work with work in the folder once the branch has a commit, so then
  // each file with work in the folder says so, which tells the person what Commit takes.
  const loose = $derived(
    group === 'branch' && changes.ok && (changes.committed?.stat.files ?? 0) > 0 ? new Set(entriesOf(changes.uncommitted?.tree ?? []).map((entry) => entry.path)) : new Set<string>(),
  );
  const inDiff = $derived(new Set(entriesOf(diff?.tree ?? []).map((entry) => entry.path)));
  // A comment whose file left the diff, or a repository the card reads no more, is kept: it shows under
  // its file's name as outdated.
  const gone = $derived(byFile(comments.filter((one) => !inDiff.has(one.file))));
  const readable = $derived(open !== null && !open.binary && patch !== null && patch.ok);
  const lines = $derived<NumberedLine[]>(readable && patch !== null && patch.ok ? numberedLines(patch.text) : []);
  // A file still open after it left the diff shows its comments once, in the list of files that left.
  const mine = $derived(open === null || !inDiff.has(open.path) ? [] : comments.filter((one) => one.file === open?.path));
  const placed = $derived(placeComments(lines, mine));

  const files = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;
  const said = (count: number) => `${count} ${count === 1 ? 'comment' : 'comments'}`;
  // The five squares of the stat bar, green for the added share and red for the rest.
  const squares = (added: number, removed: number): ('a' | 'd' | '')[] => {
    const green = added + removed === 0 ? 0 : Math.round((5 * added) / (added + removed));
    return Array.from({ length: 5 }, (_, at) => (added + removed === 0 ? '' : at < green ? 'a' : 'd'));
  };
</script>

{#snippet counts(item: DiffEntry)}
  {#if item.binary}
    <span class="quiet">binary</span>
  {:else if item.status === 'deleted'}
    <span class="minus">-{item.removed}</span> <span class="quiet">deleted</span>
  {:else}
    <span class="plus">+{item.added}</span>
    {#if item.status === 'added'}<span class="quiet">new</span>{:else}<span class="minus">-{item.removed}</span>{/if}
  {/if}
{/snippet}

{#snippet nodes(list: readonly FileTreeNode[])}
  {#each list as node (node.path)}
    <li>
      {#if node.entry === null}
        <span class="folder">{node.name}/</span>
        <ul class="tree">{@render nodes(node.children)}</ul>
      {:else}
        {@const item = node.entry}
        {@const noted = comments.filter((one) => one.file === item.path).length}
        {#snippet row()}
          <span class="name" title={item.path}>{node.name}</span>
          {#if item.oldPath !== null}<span class="from">from {item.oldPath}</span>{/if}
          {#if noted > 0}<span class="noted">{said(noted)}</span>{/if}
          <span class="ct">{@render counts(item)}</span>
          {#if loose.has(item.path)}<span class="from">not committed</span>{/if}
        {/snippet}
        {#if onopen === null}
          <span class="file" data-status={item.status}>{@render row()}</span>
        {:else}
          <button type="button" class="file" data-status={item.status} data-open={item.path} aria-pressed={open?.path === item.path} onclick={() => pick(item)}>{@render row()}</button>
        {/if}
      {/if}
    </li>
  {/each}
{/snippet}

{#snippet saved(one: DiffComment, line: number | null, outdated: boolean)}
  <LineComment
    comment={one}
    {line}
    {outdated}
    onsave={onedit === null ? null : (text) => onedit(one.id, text)}
    ondelete={ondelete === null ? null : () => ondelete(one.id)}
  />
{/snippet}

{#snippet left(list: [string, DiffComment[]][])}
  {#each list as [file, some] (file)}
    <section class="gone" aria-label="Comments on {file}">
      <header class="fh"><span class="path">{file}</span> <span class="quiet">no longer in the diff</span></header>
      {#each some as one (one.id)}{@render saved(one, null, true)}{/each}
    </section>
  {/each}
{/snippet}

{#if !changes.ok}
  <p class="reason">{changes.reason}</p>
  {@render left(gone)}
{:else}
  {@const row = changes.row}
  {#if row.stale}
    <p class="reason">The checkout is stale, so its files cannot be read.{row.staleReason === null ? '' : ` ${row.staleReason}`}</p>
  {/if}

  {@const conflicted = changes.conflicted ?? []}
  {#if conflicted.length > 0}
    <!-- A merge that stopped, such as a pull into the checkout. No live region: the button that pulled
         already said so, and the page reloads with this box. -->
    <section class="conflict" aria-labelledby="conflict{repoSuffix(row.repo)}" data-conflict>
      <p class="head" id="conflict{repoSuffix(row.repo)}">
        <b>The checkout has a conflict in {files(conflicted.length)}.</b> The merge stopped, and nothing was pushed.
      </p>
      <ul>
        {#each conflicted as path (path)}<li class="mono">{path}</li>{/each}
      </ul>
      <p class="fix">Fix each file in <span class="mono">{row.path}</span>, mark it resolved with git add, then commit here and push again.</p>
    </section>
  {/if}

  {#if diff !== null}
    <section class="panel" aria-label="Diff against {against ?? row.base}" data-diff>
      <!-- A "0 files +0 -0" bar says nothing the empty line below does not, so an empty diff has none. -->
      {#if diff.stat.files > 0 || comments.length > 0}
        <header class="dhead">
          {#if diff.stat.files > 0}
            <span class="mono">{files(diff.stat.files)}</span>
            <span class="mono plus">+{diff.stat.added}</span> <span class="mono minus">-{diff.stat.removed}</span>
            <span class="bar" aria-hidden="true">{#each squares(diff.stat.added, diff.stat.removed) as kind, at (at)}<i class={kind}></i>{/each}</span>
          {/if}
          {#if comments.length > 0}
            <span class="chip"
              ><svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5Z"></path></svg>{said(comments.length)}</span
            >
          {/if}
        </header>
      {/if}
      {#if diff.tree.length === 0 && gone.length === 0}
        <p class="empty">No change against {against ?? row.base}{group === 'branch' ? ' yet' : ''}.</p>
      {:else}
        <div class="split">
          <nav class="files" aria-label="Changed files">
            <ul class="tree">{@render nodes(diff.tree)}</ul>
          </nav>
          <div class="code">
            {#if open === null}
              {#if diff.tree.length > 0}
                <p class="empty">Pick a file to read its diff.{oncomment === null ? '' : ' Press + beside a line to comment on it.'}</p>
              {/if}
            {:else}
              <section class="viewer" data-viewer aria-label="Diff of {open.path}" aria-busy={patch === null && !open.binary}>
                <header class="fh">
                  <span class="path">{open.path}</span>
                  {#if open.binary}
                    <span class="stat">binary</span>
                  {:else}
                    <span class="stat"><span class="plus">+{open.added}</span> <span class="minus">-{open.removed}</span></span>
                  {/if}
                </header>
                <!-- Announced, because the focus stays on the file the person picked. The grey block's
                     hidden words are what a screen reader hears while git reads the patch. -->
                <p class="empty" class:hidden={readable} aria-live="polite">
                  {#if open.binary}Binary file, no text to show.{:else if patch === null}<Skeleton shape="block" height="160px" label="Reading the patch." />{:else if !patch.ok}{patch.reason}{:else}Showing the diff of {open.path}.{/if}
                </p>
                {#if readable}
                  <div class="lines">
                    {#each lines as line, index (index)}
                      {@const here = placed.at.get(index) ?? []}
                      <div class="ln" data-line={line.kind} class:cm={here.length > 0 || draft === index}>
                        <span class="gut">
                          {#if oncomment !== null && line.new !== null}
                            <button type="button" class="add" aria-label="Comment on line {line.new}" data-gutter={line.new} onclick={() => (draft = index)}
                              ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg></button
                            >
                          {/if}
                        </span><span class="no">{line.old ?? ''}</span><span class="no">{line.new ?? ''}</span><span class="sg">{line.sign}</span><span class="c">{line.code}</span>
                      </div>
                      {#each here as one (one.id)}{@render saved(one, line.new, false)}{/each}
                      {#if draft === index && oncomment !== null && line.new !== null}
                        {@const at = line.new}
                        <LineComment
                          line={at}
                          onsave={(text) => oncomment({ file: open?.path ?? '', line: at, lineText: line.code, text })}
                          oncancel={() => (draft = null)}
                        />
                      {/if}
                    {/each}
                    <!-- Its line is gone from the diff, so it shows at the end of its file, never dropped. -->
                    {#each placed.outdated as one (one.id)}{@render saved(one, null, true)}{/each}
                  </div>
                {:else if patch !== null || open.binary}
                  <!-- No lines to pin to, so the file's comments show as a list under the reason. -->
                  {#each mine as one (one.id)}{@render saved(one, one.line, false)}{/each}
                {/if}
              </section>
            {/if}
            {@render left(gone)}
          </div>
        </div>
      {/if}
    </section>
  {/if}
{/if}

<style>
  /* The diff panel. */
  .panel {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .mono,
  .path {
    font-family: var(--font-mono);
  }

  .dhead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding: 10px 14px;
    border-bottom: 1px solid var(--line);
    font-size: var(--mono-xs);
  }

  .bar {
    display: inline-flex;
    gap: 2px;
  }

  /* Non-text marks: the numbers beside them say the same. */
  .bar i {
    width: 9px;
    height: 9px;
    border-radius: 2px;
    background: var(--line-2);
  }

  .bar i.a {
    background: var(--green);
  }

  .bar i.d {
    background: var(--red);
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 21px;
    padding: 0 7px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--ink-2);
    font-size: var(--text-2xs);
  }

  .ico {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: var(--blue);
    stroke-width: 1.8;
  }

  .split {
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .files {
    padding: var(--space-2) var(--space-2) 14px;
    border-right: 1px solid var(--line);
  }

  .tree {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .tree .tree {
    padding-left: 6px;
  }

  li {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .folder {
    display: block;
    padding: 10px var(--space-2) var(--space-1);
    font-size: var(--mono-2xs);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .file {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 6px;
    min-height: 28px;
    padding: 0 var(--space-2);
    color: var(--ink-2);
  }

  button.file {
    box-sizing: border-box;
    width: 100%;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  button.file:hover,
  button.file[aria-pressed='true'] {
    background: var(--card);
    color: var(--ink);
  }

  button.file[aria-pressed='true'] {
    box-shadow: inset 0 0 0 1px var(--line);
  }

  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ct {
    display: inline-flex;
    gap: 5px;
    margin-left: auto;
    font-size: var(--mono-3xs);
  }

  .from,
  .noted {
    flex-basis: 100%;
    font-size: var(--mono-3xs);
    color: var(--muted);
  }

  .noted {
    color: var(--blue);
  }

  .plus {
    color: var(--green);
  }

  .minus {
    color: var(--red);
  }

  .quiet {
    color: var(--muted);
  }

  .code {
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .viewer {
    position: relative;
  }

  .fh {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: var(--space-2) 14px;
    border-bottom: 1px solid var(--line);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
  }

  .stat {
    font-size: var(--mono-xs);
    color: var(--muted);
  }

  .lines {
    padding-bottom: var(--space-2);
  }

  /* The gutter, both numbers, the sign, then the line. A long line wraps, so the comments under it and
     the page never scroll sideways. */
  .ln {
    display: grid;
    grid-template-columns: 18px 40px 40px 18px minmax(0, 1fr);
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

  .ln.cm {
    box-shadow: inset 3px 0 0 var(--blue);
  }

  .gut {
    display: grid;
    place-items: center;
  }

  /* Shown on the line under the pointer or the focus, and always on a screen with no pointer to hover. */
  .add {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    border-radius: var(--radius-xs);
    background: var(--blue);
    opacity: 0;
    cursor: pointer;
  }

  .add svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: var(--on-status);
    stroke-width: 2.4;
  }

  .ln:hover .add,
  .add:focus-visible {
    opacity: 1;
  }

  @media (hover: none) {
    .add {
      opacity: 1;
    }
  }

  .gone + .gone,
  .viewer + .gone {
    border-top: 1px solid var(--line);
  }

  .gone .fh {
    color: var(--ink-2);
  }

  /* The error box's frame: red at 45% and the head on the red tint, with ink words. */
  .conflict {
    margin-bottom: var(--space-3);
    border: 1px solid color-mix(in oklch, var(--red) 45%, transparent);
    border-radius: var(--radius-lg);
    overflow: hidden;
    font-size: var(--text-sm);
  }

  .conflict .head {
    margin: 0;
    padding: 10px 14px;
    background: var(--red-bg);
    color: var(--ink);
  }

  .conflict .head b {
    font-weight: 500;
  }

  .conflict ul {
    margin: 0;
    padding: var(--space-3) 14px 0 calc(14px + 1.2em);
    list-style: disc;
  }

  .conflict .fix {
    margin: 0;
    padding: var(--space-3) 14px;
  }

  /* Read out, not shown, once the diff itself is on the screen. */
  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .empty,
  .reason {
    margin: 0;
    padding: var(--space-3) 14px;
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .reason {
    padding: 0 0 var(--space-3);
    font-size: var(--text-sm);
  }

  /* On a phone the file list goes above the diff. */
  @media (max-width: 640px) {
    .split {
      grid-template-columns: minmax(0, 1fr);
    }

    .files {
      border-right: none;
      border-bottom: 1px solid var(--line);
    }

    .ln {
      grid-template-columns: 18px 32px 32px 14px minmax(0, 1fr);
    }
  }
</style>
