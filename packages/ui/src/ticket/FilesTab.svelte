<script lang="ts">
  import { type CardFile, type CardFileGroup, phaseLabel } from '@nolzu/protocol';
  import { untrack } from 'svelte';
  import Markdown from '../Markdown.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { fileRows, foldOf } from './file-rows.ts';
  import JsonView from './JsonView.svelte';
  import { isJsonFile } from './json-tree.ts';
  import { byteSize } from './log.ts';

  type Read = { ok: true; text: string } | { ok: false; reason: string };

  // The page builds the addresses and reads the text, because this package never fetches.
  let {
    groups,
    folder,
    fileUrl,
    onread,
    start = null,
    oncopy = null,
  }: {
    groups: readonly CardFileGroup[];
    // The card folder on this machine. The empty state names it, because a log for an investigate
    // run gets there by a person copying it, and nothing else in the app says where that is. Null
    // for a key with no folder of its own.
    folder: string | null;
    fileUrl: (path: string, download?: boolean) => string;
    onread: (path: string) => Promise<Read>;
    // The file to open first, as a link from the Overview names it. Null opens the plan, or the first
    // file the viewer can show.
    start?: string | null;
    // Copy in the preview header of a text file. The page touches the clipboard, because this package
    // never does, and answers with the sentence the copy was refused with, or null once it took.
    oncopy?: ((text: string) => Promise<string | null>) | null;
  } = $props();

  let open = $state<CardFile | null>(null);
  // Null while the text is on its way, and for a file that shows no text.
  let read = $state<Read | null>(null);
  let picks = 0;
  // What the last Copy said, for the open file only.
  let copied = $state('');
  // An html file opens drawn. Source shows its text, as any other text file.
  let source = $state(false);
  // The folded folders that show open: the ones a press opened, and the one a file opened from a link
  // sits in, so a link from the Overview into a folder shows its row. A press folds either again.
  let unfolded = $state<string[]>([]);
  const toggle = (path: string) => (unfolded = unfolded.includes(path) ? unfolded.filter((one) => one !== path) : [...unfolded, path]);
  const files = (count: number) => (count === 1 ? '1 file' : `${count} files`);

  async function pick(file: CardFile): Promise<void> {
    picks += 1;
    const mine = picks;
    open = file;
    const fold = foldOf(groups, file.path);
    if (fold !== null && !unfolded.includes(fold)) unfolded = [...unfolded, fold];
    read = null;
    copied = '';
    source = false;
    // An image is shown from its address, so only text is read. An html file is read too, for Source
    // and Copy, and so a file grown past the cap since the listing shows the refusal, not a frame.
    if (file.kind !== 'markdown' && file.kind !== 'text' && file.kind !== 'html') return;
    const said = await onread(file.path);
    if (mine === picks) read = said;
  }

  // The tab opens the plan. Without one, the first file the viewer can show, so the tab never
  // opens on an empty preview. Opened in the browser only, because the server never reads a file for the page.
  $effect(() => {
    const first = untrack(() => {
      const all = groups.flatMap((group) => group.files);
      const asked = start === null ? undefined : all.find((file) => file.path === start);
      return asked ?? all.find((file) => file.path === 'plan/plan.md') ?? all.find((file) => file.kind !== 'download');
    });
    if (first !== undefined) untrack(() => void pick(first));
  });

  async function copy(text: string): Promise<void> {
    if (oncopy === null) return;
    copied = '';
    const mine = picks;
    const said = (await oncopy(text)) ?? 'Copied.';
    // A file picked while the clipboard answered keeps its own empty line.
    if (mine === picks) copied = said;
  }

  // A file outside a phase folder was put there by a person, so the header says only when it changed.
  const writer = (file: CardFile) => {
    const words = file.phase === null ? 'Changed' : `Written by ${phaseLabel(file.phase)}`;
    if (!file.when) return file.phase === null ? '' : words;
    return file.phase === null ? `${words} ${file.when}` : `${words}, ${file.when}`;
  };
</script>

{#snippet glyph(path: string)}
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d={path}></path></svg>
{/snippet}

{#snippet facts(file: CardFile)}
  {@render glyph('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5')}
  <span class="name">{file.name}</span>
  <span class="m">{byteSize(file.size)}</span>
  <span class="m">{file.when ?? ''}</span>
{/snippet}

{#snippet fileRow(file: CardFile)}
  <!-- Every row opens the viewer. A file it has no view for says so there, beside Download. -->
  <button type="button" class="row" data-file={file.path} aria-pressed={open?.path === file.path} onclick={() => pick(file)}>
    {@render facts(file)}
  </button>
{/snippet}

<!-- The files by the phase folder that holds them on the left, the open file on the right. -->
{#if groups.length === 0}
  <p class="quiet">
    No files yet. A run writes its notes and its summary here. {#if folder !== null}To give a run a log or another file, copy it into <code>{folder}</code>.{/if}
  </p>
{:else}
  <div class="files">
    <nav class="list" aria-label="Card files">
      {#each groups as group (group.folder)}
        <div class="group">
          <div class="folder">
            <span>{group.folder === '' ? 'card folder' : `${group.folder}/`}</span>
            <span class="badge" data-share={group.share}>{group.share ? 'share' : 'internal'}</span>
          </div>
          <ul>
            {#each fileRows(group) as row (row.kind === 'file' ? row.file.path : `fold:${row.path}`)}
              {#if row.kind === 'file'}
                <li>{@render fileRow(row.file)}</li>
              {:else}
                {@const opened = unfolded.includes(row.path)}
                <li>
                  <button type="button" class="row fold" data-fold={row.path} aria-expanded={opened} onclick={() => toggle(row.path)}>
                    {@render glyph(opened ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6')}
                    <span class="name">{row.path === '' ? 'card folder' : `${row.path}/`}</span>
                    <span class="m">{files(row.files.length)}</span>
                    <span class="m">{byteSize(row.size)}</span>
                  </button>
                  {#if opened}
                    <ul class="inner">
                      {#each row.files as file (file.path)}
                        <li>{@render fileRow(file)}</li>
                      {/each}
                    </ul>
                  {/if}
                </li>
              {/if}
            {/each}
            <!-- A cache folder is counted on the server and never listed, so its line opens nothing. -->
            {#each group.caches ?? [] as cache (cache.path)}
              <li>
                <div class="row" data-cache={cache.path}>
                  {@render glyph('M3 7h7l2 2h9v10H3z')}
                  <span class="name">{cache.path}/</span>
                  <span class="m">{files(cache.count)}, a cache, not listed</span>
                </div>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
      <p class="note">Files in share/ are meant for other people. The rest are the card's working notes.</p>
    </nav>

    <section class="viewer" data-viewer aria-label={open === null ? 'No file open' : `The file ${open.path}`}>
      {#if open === null}
        <p class="quiet">Pick a file to read it.</p>
      {:else}
        <header class="head">
          <span class="path">{open.path}</span>
          <span class="size">{byteSize(open.size)}</span>
          <span class="by">{writer(open)}</span>
          {#if oncopy !== null && read !== null && read.ok}
            {@const text = read.text}
            <button type="button" class="copy" data-copy onclick={() => copy(text)}
              >{@render glyph('M9 9h10v10H9zM5 15V5h10')}Copy</button
            >
          {/if}
          <a class="download" class:alone={!(oncopy !== null && read !== null && read.ok)} href={fileUrl(open.path, true)} download={open.name}
            >{@render glyph('M12 4v11M7 10l5 5 5-5M5 20h14')}Download</a
          >
          <span class="copied" role="status">{copied}</span>
        </header>
        <div class="body">
          {#if open.kind === 'image'}
            <img src={fileUrl(open.path)} alt={open.name} />
          {:else if open.kind === 'download'}
            <p class="quiet" role="status">
              {open.tooBig ? `This file is ${byteSize(open.size)}, too big to show here. Download it to read it.` : 'No preview for this kind of file.'}
            </p>
          {:else if read === null}
            <Skeleton shape="block" height="200px" label="Reading the file." />
          {:else if !read.ok}
            <p class="quiet" role="status">{read.reason}</p>
          {:else if open.kind === 'markdown'}
            <Markdown source={read.text} />
          {:else if open.kind === 'html'}
            <div class="html-bar">
              <span class="seg" role="group" aria-label="Show">
                <button type="button" data-mode="preview" aria-pressed={!source} onclick={() => (source = false)}>Preview</button>
                <button type="button" data-mode="source" aria-pressed={source} onclick={() => (source = true)}>Source</button>
              </span>
              <a class="tab" href={fileUrl(open.path)} target="_blank" rel="noopener noreferrer">Open in a new tab</a>
            </div>
            {#if source}
              <pre>{read.text}</pre>
            {:else}
              <!-- An empty sandbox: no script and no origin of its own. The route's policy says the same. -->
              <iframe class="frame" sandbox="" src={fileUrl(open.path)} title="Preview of {open.name}"></iframe>
            {/if}
          {:else if isJsonFile(open.name)}
            <!-- Keyed, so the next file opens on its own Tree or Raw choice. -->
            {#key open.path}<JsonView text={read.text} />{/key}
          {:else}
            <pre>{read.text}</pre>
          {/if}
        </div>
      {/if}
    </section>
  </div>
{/if}

<style>
  .files {
    display: grid;
    grid-template-columns: minmax(0, 300px) minmax(0, 1fr);
    align-items: stretch;
    /* The tab runs edge to edge under the card tabs, so it cancels the padding of the page around it. */
    margin: calc(-1 * var(--space-4)) -32px;
  }

  @media (max-width: 640px) {
    .files {
      margin-inline: calc(-1 * var(--space-4));
    }
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    padding: var(--space-5) 14px;
    border-right: 1px solid var(--line);
  }

  .folder {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-2) 6px;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .badge {
    margin-left: auto;
    padding: 1px 7px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--muted);
    font-family: var(--font-sans);
    font-size: var(--text-2xs);
  }

  .badge[data-share='true'] {
    background: var(--panel);
    color: var(--ink-2);
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    box-sizing: border-box;
    width: 100%;
    padding: 6px var(--space-2);
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
  }

  button.row {
    cursor: pointer;
  }

  button.row:hover,
  button.row[aria-pressed='true'] {
    background: var(--card);
    box-shadow: inset 0 0 0 1px var(--line);
    color: var(--ink);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .m {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    white-space: nowrap;
  }

  .ico {
    flex: none;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .row > .ico {
    color: var(--muted);
  }

  .inner {
    margin-left: var(--space-3);
  }

  .note {
    margin: 0;
    padding: 0 var(--space-2);
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .viewer {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    padding: 14px 40px;
    border-bottom: 1px solid var(--line);
  }

  .path {
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    overflow-wrap: anywhere;
  }

  .size {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .by {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .copy,
  .download {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-sizing: border-box;
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
    text-decoration: none;
  }

  .copy {
    margin-left: auto;
    border-color: transparent;
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
  }

  .copy:hover {
    color: var(--ink);
  }

  .download.alone {
    margin-left: auto;
  }

  .copied {
    flex-basis: 100%;
    color: var(--muted);
    font-size: var(--text-xs);
    text-align: right;
  }

  .copied:empty {
    display: none;
  }

  .body {
    padding: 28px 40px 48px;
  }

  /* A text file fills the box up to the 120ch the shared Markdown takes. */
  .body > pre {
    max-width: min(100%, 120ch);
  }

  /* The text of a file is a quote of the run, so a code block reads as a box and inline code as a chip. */
  .body :global(.markdown pre) {
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .body :global(.markdown :not(pre) > code) {
    padding: 1px 5px;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    background: var(--panel);
  }

  pre {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--ink-2);
  }

  .html-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .seg button {
    height: 24px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .seg button[aria-pressed='true'] {
    background: var(--card-2);
    color: var(--ink);
  }

  .tab {
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  .tab:hover {
    color: var(--ink);
  }

  /* A design screen with no background of its own draws on white, so the frame stays light in every
     theme. It fills the viewer's height and a person can drag it taller. */
  .frame {
    display: block;
    box-sizing: border-box;
    width: 100%;
    height: 70vh;
    min-height: 240px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: #fff;
    resize: vertical;
  }

  img {
    max-width: 100%;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
  }

  .quiet {
    margin: 0;
    padding: var(--space-3);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .body .quiet {
    padding: 0;
  }
</style>
