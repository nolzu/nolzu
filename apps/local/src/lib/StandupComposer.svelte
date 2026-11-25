<script lang="ts">
  import { type Standup, standupLists, standupText, standupTextOf } from '@nolzu/protocol';
  import { copyText } from './clipboard.ts';

  // The standup: three labelled lists, Yesterday with its day, Today
  // and Blocked. The lines are worked out by standupLists, so this file only draws them, keeps what the
  // person types and hands the joined text to the clipboard. Nothing here posts and nothing here reads
  // a server: the standup it needs is the one the screen already loaded.
  let { standup }: { standup: Standup } = $props();

  type Part = 'yesterday' | 'today' | 'blocked';
  const PARTS: readonly Part[] = ['yesterday', 'today', 'blocked'];
  const lists = $derived(standupLists(standup));
  // The whole generated text, the one thing an edit is compared with.
  const generated = $derived(standupText(standup));

  // The generated lines open the boxes, and the person's text is theirs from then on.
  // svelte-ignore state_referenced_locally
  let parts = $state<Record<Part, string>>({ yesterday: lists.yesterday, today: lists.today, blocked: lists.blocked });
  let behind = $state(false);
  let note = $state('');
  const text = $derived(standupTextOf({ ...lists, ...parts }));
  const changed = $derived(PARTS.some((part) => parts[part] !== lists[part]));

  // Limit: one record under one key, so an edit survives a reload with no table and no request.
  // The ceiling is real: the text lives in this browser only, so it is in no backup and does not
  // follow the person to another machine. A stored standup would need a table of its own, and
  // Evidence stays out of tables until a query cannot work it out.
  const KEY = 'nolzu.standup';

  interface Kept {
    day: string;
    parts: Record<Part, string>;
    // The generated text as it stood when the person typed. Compared and not counted: a run that
    // ended changes its own line from "still going" to "passed" without changing how many lines
    // there are.
    generated: string;
  }

  function kept(): Kept | null {
    try {
      const said = localStorage.getItem(KEY);
      if (said === null) return null;
      const one = JSON.parse(said) as Partial<Kept>;
      if (typeof one.day !== 'string' || typeof one.generated !== 'string' || typeof one.parts !== 'object' || one.parts === null) return null;
      const got = one.parts as Partial<Record<Part, unknown>>;
      if (PARTS.some((part) => typeof got[part] !== 'string')) return null;
      return { day: one.day, parts: got as Record<Part, string>, generated: one.generated };
    } catch {
      // Storage off, or a record another version wrote. The generated text is the honest fallback.
      return null;
    }
  }

  function keep(one: Kept | null): void {
    try {
      if (one === null) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, JSON.stringify(one));
    } catch {
      // Some browsers throw on the getter itself when storage is off, and a full quota throws on the
      // write. The text is still on the screen and can still be copied.
    }
  }

  // Reads the day, never the text it writes, or it would write itself in a loop. An effect and not a
  // read at the top of the file, because the screen is server rendered first and there is no storage
  // there. A record from another day is left alone: this day gets its own text.
  $effect(() => {
    const mine = kept();
    if (mine === null || mine.day !== standup.day) return;
    parts = { ...mine.parts };
    behind = mine.generated !== generated;
  });

  // Three empty boxes are not an edit worth keeping: the generated lines come back on the next load,
  // which is the same way out as the button. Nothing a person typed is dropped, because there is
  // nothing.
  function edited(): void {
    behind = false;
    keep(PARTS.every((part) => parts[part].trim() === '') ? null : { day: standup.day, parts: { ...parts }, generated });
  }

  function regenerate(): void {
    parts = { yesterday: lists.yesterday, today: lists.today, blocked: lists.blocked };
    behind = false;
    note = '';
    keep(null);
  }

  // Exported, so the page's Copy beside the heading and Copy standup in the top bar copy these lists,
  // edits and all.
  export async function copy(): Promise<void> {
    note = (await copyText(text))
      ? 'Copied. Paste it wherever your standup goes.'
      : 'This browser did not allow the copy. Select the text in the boxes and copy it with the keyboard.';
  }

  const LABELS: Record<Part, string> = { yesterday: 'Yesterday', today: 'Today', blocked: 'Blocked' };
  const rows = (value: string) => Math.max(1, value.split('\n').length);
</script>

<div class="standup">
  {#if behind}
    <p class="warning" data-behind>
      The board or the last working day changed after you wrote this text, so the boxes are behind them. Regenerate to build them again, or keep
      your own words.
    </p>
  {/if}

  {#each PARTS as part (part)}
    <div class="f">
      <label for="standup-{part}"><span>{LABELS[part]}</span> {#if part === 'yesterday'}<span class="quiet">{lists.yesterdayLabel}</span>{/if}</label>
      <textarea id="standup-{part}" data-part={part} rows={rows(parts[part])} bind:value={parts[part]} oninput={edited}></textarea>
    </div>
  {/each}

  {#if changed}
    <p class="bar">
      <span class="quiet">Your edits stay in this browser, under this day.</span>
      <button type="button" data-regenerate onclick={regenerate}>Regenerate</button>
    </p>
  {/if}

  <p class="quiet">Nothing is posted from here.</p>
  <p class="quiet note" role="status">{note}</p>
</div>

<style>
  .standup {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 9px 0 14px;
  }

  .f {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  label {
    display: flex;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink-2);
  }

  label .quiet {
    font-weight: 400;
  }

  .bar {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
    margin: 0;
  }

  textarea {
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
    line-height: 1.55;
    /* The box grows with its lines. Browsers without it size the box by its rows. */
    field-sizing: content;
    resize: vertical;
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

  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  /* Words and not a colour, the way the timesheet marks a short cell. */
  .warning {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  .note:empty {
    display: none;
  }
</style>
