<script lang="ts">
  import type { DiffComment } from '@nolzu/protocol';
  import { untrack } from 'svelte';
  import { ago } from '../board/peek.ts';
  import Button from '../Button.svelte';

  type Said = Promise<string | null>;

  // One comment under its diff line, or the field for a new one when
  // `comment` is null. A save or a delete is a direct write, so the wait is this comment's own. The
  // page reads the comments again after a write, and the answer is null or the sentence it refused with.
  let {
    comment = null,
    line,
    outdated = false,
    onsave = null,
    ondelete = null,
    oncancel = null,
  }: {
    comment?: DiffComment | null;
    // The line it shows under now, which an edit above may have moved from where it was made.
    line: number | null;
    // Its line is gone from the diff, so it shows at the end of its file with the line it was made on.
    outdated?: boolean;
    // Null on a page that cannot write, which then shows the comment with no buttons.
    onsave?: ((text: string) => Said) | null;
    ondelete?: (() => Said) | null;
    // Closes the field of a new comment.
    oncancel?: (() => void) | null;
  } = $props();

  // A new comment opens as a field. A saved one opens as text, and its field starts from that text.
  let editing = $state(untrack(() => comment === null));
  let text = $state(untrack(() => comment?.text ?? ''));
  let busy = $state(false);
  let refusal = $state<string | null>(null);
  let box = $state<HTMLTextAreaElement | null>(null);

  $effect(() => {
    if (editing) box?.focus();
  });

  const where = $derived(
    comment === null ? `line ${line}` : outdated || line === null ? `made on line ${comment.line}` : line === comment.line ? `line ${line}` : `line ${line}, made on line ${comment.line}`,
  );
  const sent = $derived(comment?.sentAt ?? null);

  async function save(): Promise<void> {
    if (busy || onsave === null) return;
    if (text.trim() === '') {
      refusal = 'The comment is empty. Write what should change on this line.';
      return;
    }
    busy = true;
    refusal = await onsave(text);
    busy = false;
    if (refusal !== null) return;
    if (comment === null) oncancel?.();
    else editing = false;
  }

  async function remove(): Promise<void> {
    if (busy || ondelete === null) return;
    busy = true;
    refusal = await ondelete();
    busy = false;
  }

  function cancel(): void {
    refusal = null;
    if (comment === null) oncancel?.();
    else {
      text = comment.text;
      editing = false;
    }
  }

  // Both keys stop here, so Cmd Enter saves the comment and never presses a page button, and Esc closes
  // the field and never leaves the page.
  function keys(event: KeyboardEvent): void {
    const enter = event.key === 'Enter' && (event.metaKey || event.ctrlKey);
    if (!enter && event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    if (enter) void save();
    else cancel();
  }

  // Every repository's panel stays on the page, so a line number alone could name two fields.
  const id = $props.id();
  // A date that does not parse says no time, rather than a wrong one.
  const when = (at: string, before: string): string => {
    const said = ago(at, new Date());
    return said === null ? '' : `${before}${said}`;
  };
</script>

<div class="thread" data-comment={comment?.id ?? 'new'} data-outdated={outdated ? '' : undefined} aria-label={comment === null ? `New comment on line ${line}` : `Comment on ${where}`} role="group">
  {#if comment !== null}
    <div class="who">
      <span class="av" aria-hidden="true">Y</span>
      <span><b>You</b> <span class="meta">{where}{when(comment.createdAt, ' · ')}</span></span>
    </div>
    {#if outdated}
      <!-- A neutral box, not a colour: the line changed, nothing is wrong. -->
      <p class="was"><span class="tag">Outdated</span> The line it was made on: <code>{comment.lineText.trim() === '' ? '(an empty line)' : comment.lineText.trim()}</code></p>
    {/if}
  {/if}
  {#if editing}
    <label class="hidden" for={id}>{comment === null ? `Comment on line ${line}` : 'Edit the comment'}</label>
    <textarea id={id} class="field" rows="2" bind:this={box} bind:value={text} onkeydown={keys} placeholder="What should change on this line?" disabled={busy}></textarea>
    <div class="acts">
      <Button size="small" onclick={save} disabled={busy} key="⌘↵" data-save>{comment === null ? 'Save comment' : 'Save'}</Button>
      <Button size="small" variant="ghost" onclick={cancel} disabled={busy}>Cancel</Button>
      <span class="sub">Goes with the next send back</span>
    </div>
  {:else if comment !== null}
    <p class="body">{comment.text}</p>
    <div class="acts">
      {#if onsave !== null && sent === null}
        <Button size="small" variant="ghost" onclick={() => (editing = true)} disabled={busy} data-edit>Edit</Button>
      {/if}
      {#if ondelete !== null}
        <Button size="small" variant="ghost" onclick={remove} disabled={busy} data-delete>Delete</Button>
      {/if}
      <span class="sub">{sent === null ? 'Goes with the next send back' : `Sent back${when(sent, ' ')}`}</span>
    </div>
  {/if}
  {#if refusal !== null}<p class="refusal" role="alert">{refusal}</p>{/if}
</div>

<style>
  /* The open comment: a panel under its line, past the two number columns. */
  .thread {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin: 6px var(--space-4) 10px 98px;
    padding: var(--space-3) 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-lg);
    background: var(--panel);
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    white-space: normal;
  }

  .who {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .av {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--card-2);
    color: var(--ink-2);
    font-size: var(--text-2xs);
    font-weight: 600;
  }

  b {
    font-weight: 600;
  }

  .meta {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .body,
  .was,
  .refusal {
    margin: 0;
    line-height: 1.5;
  }

  .body {
    font-size: 13.5px;
    color: var(--ink);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .was {
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  .tag {
    margin-right: 6px;
    color: var(--ink);
    font-weight: 500;
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .field {
    box-sizing: border-box;
    width: 100%;
    min-height: 56px;
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    resize: vertical;
  }

  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .sub {
    margin-left: auto;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .refusal {
    color: var(--red);
    font-size: var(--text-xs);
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* On a phone the number columns are narrower, and the comment takes the width. */
  @media (max-width: 640px) {
    .thread {
      margin-left: var(--space-2);
      margin-right: var(--space-2);
    }
  }
</style>
