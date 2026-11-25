<script lang="ts">
  import KeyHelp from './KeyHelp.svelte';
  import { type Binding, type KeyActions, liveKeys, matchKey, NO_LEAD, readPress } from './keymap.ts';

  // The one key handler of the app. The layout mounts it once, with the global keys and the keys of the
  // screen on show, and the actions each of them runs.
  let { keys, actions }: { keys: readonly Binding[]; actions: KeyActions } = $props();

  let helping = $state(false);
  // The help belongs to the handler, so it lists the very keys the handler acts on.
  const all = $derived<KeyActions>({ ...actions, help: () => void (helping = true) });
  const live = $derived(liveKeys(keys, all));
  let lead = NO_LEAD;

  function onkeydown(event: KeyboardEvent): void {
    const found = matchKey(live, readPress(event, document), lead, event.timeStamp);
    lead = found.state;
    if (found.binding !== null && all[found.binding.action]?.() !== false) event.preventDefault();
  }
</script>

<svelte:window {onkeydown} />

{#if helping}
  <KeyHelp keys={live} onclose={() => (helping = false)} />
{/if}
