<script lang="ts">
  import { type DiffEntry, formatCost, subjectWarning } from '@nolzu/protocol';
  import { commitGroups, commitRows, tickedPaths } from './commit-files.ts';
  import HooksSwitch from './HooksSwitch.svelte';
  import { repoSuffix } from './repo-id.ts';

  type Answer = { ok: true } | { ok: false; reason: string };

  // Commit, one of the composer's three actions, which never leaves the machine. It is a direct git action
  // and not a run, so it keeps its own pending state instead of waiting for the board.
  let {
    files,
    oncommit,
    onwrite,
    repo = '.',
  }: {
    // Every file not committed yet, changed and new. The commit takes the ticked ones and nothing else.
    files: readonly DiffEntry[];
    // `paths` names the ticked files, both paths of a rename. hooks is the Run hooks tick, true only
    // when the person turned the repository's hooks on.
    oncommit: (message: string, paths: string[], hooks: boolean) => Promise<Answer>;
    // Asks the engine for a message from the uncommitted change, the short kind a subject alone. It
    // answers when the message is written, so the wait is this panel's own and not the board's. The
    // model and the cost come back where the pass reported them.
    onwrite: (short: boolean) => Promise<{ ok: true; message: string; model?: string; cost?: number | null } | { ok: false; reason: string }>;
    // Only for the ids, so two composers on one page never share one. The project folder keeps the
    // plain ids it always had.
    repo?: string;
  } = $props();

  const suffix = $derived(repoSuffix(repo));

  // Empty until the person types or asks. No phase drafts a message, so nothing is invented here.
  let message = $state('');
  // Every file is ticked until the person unticks it, so nothing the card made is left behind by
  // default. Kept as the unticked ones, so a file that appears later comes in ticked.
  let unticked = $state<string[]>([]);
  const count = $derived(files.filter((file) => !unticked.includes(file.path)).length);
  const groups = $derived(commitGroups(files));
  // The folded folders a press opened.
  let unfolded = $state<string[]>([]);
  let committing = $state(false);
  // Off on every commit until ticked, and off again after a commit went.
  let hooks = $state(false);
  let writing = $state<'full' | 'short' | null>(null);
  let refusal = $state<string | null>(null);
  let note = $state('');
  // What wrote the last message and what it cost, as the pass reported them. No cost reported, none said.
  let written = $state<string | null>(null);

  async function commit(): Promise<void> {
    if (committing || count === 0) return;
    refusal = null;
    if (message.trim() === '') {
      note = 'The commit message is empty. Write a subject line first, then commit.';
      return;
    }
    committing = true;
    note = 'Committing.';
    const answer = await oncommit(message, tickedPaths(files, unticked), hooks);
    committing = false;
    note = answer.ok ? 'Committed. Nothing left the machine.' : 'Git refused the commit. Its words are below.';
    refusal = answer.ok ? null : answer.reason;
    // A message that is committed is used. Pressing again would commit the same subject twice.
    if (answer.ok) {
      message = '';
      hooks = false;
    }
  }

  // The answer replaces the box, because pressing the button is asking for a new message.
  async function write(short: boolean): Promise<void> {
    if (writing !== null) return;
    writing = short ? 'short' : 'full';
    refusal = null;
    note = 'Writing a message from the uncommitted change.';
    try {
      const answer = await onwrite(short);
      if (answer.ok) {
        message = answer.message;
        const parts = [answer.model, answer.cost == null ? undefined : formatCost(answer.cost)].filter((part) => part !== undefined);
        written = parts.length === 0 ? null : parts.join(' · ');
      }
      note = answer.ok ? 'Message written. Change it as you like, then commit.' : answer.reason;
    } catch {
      // The local app did not answer. The buttons stay live so the person can press one again.
      note = 'The local app did not answer. Check that it is running, then press the button again.';
    } finally {
      writing = null;
    }
  }

  function tick(paths: readonly string[], on: boolean): void {
    unticked = on ? unticked.filter((one) => !paths.includes(one)) : [...unticked.filter((one) => !paths.includes(one)), ...paths];
  }

  const toggle = (path: string) => (unfolded = unfolded.includes(path) ? unfolded.filter((one) => one !== path) : [...unfolded, path]);
</script>

{#snippet fileTick(file: DiffEntry, name: string)}
  <label class="file"
    ><input type="checkbox" value={file.path} checked={!unticked.includes(file.path)} onchange={(event) => tick([file.path], event.currentTarget.checked)} /><span class="p"
      >{name}</span
    ></label
  >
{/snippet}

<!-- Commit, in the Commit and push panel: the message, then Commit. -->
<section class="commit" aria-labelledby="commit-title{suffix}">
  <h2 class="hidden" id="commit-title{suffix}">Commit</h2>
  <div class="field">
    <label for="commit-message{suffix}">Commit message</label>
    <textarea id="commit-message{suffix}" rows="3" bind:value={message}></textarea>
    {#if subjectWarning(message) !== null}<p class="warn" role="status" data-subject-warning>{subjectWarning(message)}</p>{/if}
  </div>
  <div class="row">
    <button type="button" data-write="full" aria-busy={writing === 'full'} disabled={writing !== null && writing !== 'full'} onclick={() => write(false)}>Write conventional message</button>
    <button type="button" data-write="short" aria-busy={writing === 'short'} disabled={writing !== null && writing !== 'short'} onclick={() => write(true)}>Write short conventional message</button>
    {#if written !== null}<span class="written" data-written-by>{written}</span>{/if}
  </div>

  <!-- Every file not committed, ticked, in two groups, as the Workspace page lists them. -->
  {#each [{ title: 'Changed', list: groups.changed }, { title: 'New', list: groups.added }] as group (group.title)}
    {#if group.list.length > 0}
      <fieldset data-group={group.title}>
        <legend class="quiet"><span class="label">{group.title}</span> {group.list.length}</legend>
        {#each commitRows(group.list) as row (row.kind === 'file' ? row.file.path : `dir:${row.path}`)}
          {#if row.kind === 'file'}
            {@render fileTick(row.file, row.file.path)}
          {:else}
            {@const inside = row.files.map((file) => file.path)}
            {@const on = inside.filter((path) => !unticked.includes(path)).length}
            {@const shown = unfolded.includes(row.path)}
            <div class="dir" data-folder={row.path}>
              <input
                type="checkbox"
                aria-label="Commit every file in {row.path}"
                checked={on === inside.length}
                indeterminate={on > 0 && on < inside.length}
                onchange={(event) => tick(inside, event.currentTarget.checked)}
              />
              <button type="button" class="fold" aria-expanded={shown} onclick={() => toggle(row.path)}>
                <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>
                <span>{row.path}</span>
                <span class="quiet">{row.files.length}</span>
              </button>
            </div>
            {#if shown}
              <div class="in">
                {#each row.files as file (file.path)}{@render fileTick(file, file.path.slice(row.path.length + 1))}{/each}
              </div>
            {/if}
          {/if}
        {/each}
      </fieldset>
    {/if}
  {/each}

  <HooksSwitch id="commit-hooks{suffix}" bind:checked={hooks} />

  <div class="step">
    <button type="button" data-commit aria-busy={committing} disabled={count === 0} onclick={commit}>Commit {count} {count === 1 ? 'file' : 'files'}</button>
  </div>
  <p class="quiet" role="status">{note}</p>
  {#if refusal !== null}
    <pre class="refusal" data-refusal>{refusal}</pre>
  {/if}
</section>

<style>
  /* Inside the Commit and push panel, which draws the edge. */
  .commit {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .field label {
    color: var(--ink);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  textarea {
    min-height: 74px;
    padding: 10px 12px;
    border: 1px solid var(--line-2);
    border-radius: 8px;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    resize: vertical;
  }

  /* The model and the cost of the pass that wrote the message, in mono. */
  .written {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  /* The commit, across the panel: on by the ticked files alone, whatever was pushed. */
  .step {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }

  .step button {
    flex: 1;
    height: 30px;
  }

  fieldset {
    margin: 0;
    padding: 0;
    border: none;
  }

  .file {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink-3);
  }

  .file .p {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .dir {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .fold {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px;
    border: 0;
    background: transparent;
    color: var(--ink-3);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    cursor: pointer;
  }

  .chev {
    flex: none;
    width: 12px;
    height: 12px;
    fill: none;
    stroke: var(--muted);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  [aria-expanded='true'] > .chev {
    transform: rotate(90deg);
  }

  .in {
    margin-left: 22px;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  button {
    padding: 5px 11px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  button:disabled {
    color: var(--muted);
    cursor: not-allowed;
  }

  button[aria-busy='true'] {
    color: var(--muted);
    cursor: progress;
  }

  .quiet {
    margin: 0;
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  /* Git's own words, kept as git wrote them, because a hook's output is lined up for a terminal. */
  .refusal {
    margin: 0;
    padding: 9px;
    border: 1px solid var(--red);
    border-radius: var(--radius-sm);
    background: var(--bg);
    color: var(--ink-3);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    white-space: pre-wrap;
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
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
