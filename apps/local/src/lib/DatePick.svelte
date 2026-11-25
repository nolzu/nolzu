<script lang="ts">
  // One date field for one panel of the evidence screen. The field is the browser's own: it brings
  // the calendar, the keyboard map and the locale, so there is no picker here to keep working.
  //
  // The form is a GET, so the field writes its own query field into the URL and the loader reads it
  // back. A GET form drops the query it was submitted from, so the other panel's field rides along
  // as `keep` and picking a day does not throw the week away.
  //
  // `canPick` is what the account's plan allows, and it is false by default: a screen built without
  // the display document draws the field off rather than open.
  let {
    name,
    label,
    value,
    keep = null,
    canPick = false,
  }: {
    name: string;
    label: string;
    value: string;
    keep?: { name: string; value: string } | null;
    canPick?: boolean;
  } = $props();
</script>

<form class="pick" method="GET" data-pick={name}>
  <label for="pick-{name}">{label}</label>
  <input id="pick-{name}" type="date" {name} {value} disabled={!canPick} />
  {#if keep !== null}
    <input type="hidden" name={keep.name} value={keep.value} />
  {/if}
  <button type="submit" disabled={!canPick}>Show</button>
</form>
{#if !canPick}
  <p class="free" data-free={name}>History is part of Solo. This machine is on the free plan, so this field is off.</p>
{/if}

<style>
  .pick {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    margin: 9px 14px;
    font-size: var(--text-xs);
  }

  label {
    color: var(--muted);
  }

  input,
  button {
    padding: 4px 8px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  button {
    background: var(--card);
    color: var(--ink-2);
  }

  /* Off on Free, and said by the disabled attribute as well as by the ink. */
  input:disabled,
  button:disabled {
    color: var(--muted);
  }

  .free {
    margin: 0 14px 9px;
    font-size: var(--text-xs);
    color: var(--muted);
  }
</style>
