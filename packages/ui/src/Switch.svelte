<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements';

  // A switch has no words of its own, so the caller names it with aria-label or aria-labelledby.
  // The page owns the value: a click hands the new value to `onchange`, and the switch shows only the
  // `checked` the page passes back. A change the page refuses never shows as done.
  let {
    checked = false,
    onchange = null,
    ...rest
  }: Omit<HTMLButtonAttributes, 'role' | 'type' | 'onclick' | 'onchange' | 'children'> & {
    checked?: boolean;
    onchange?: ((checked: boolean) => void) | null;
  } = $props();
</script>

<button {...rest} type="button" role="switch" class="switch" aria-checked={checked ? 'true' : 'false'} onclick={() => onchange?.(!checked)}></button>

<style>
  .switch {
    position: relative;
    flex: none;
    box-sizing: border-box;
    width: 32px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: var(--line-2);
    cursor: pointer;
  }

  /* The knob is ink, not the card colour, which is 1.4:1 on the track and could not be seen. */
  .switch::after {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--ink);
    content: '';
    transition: left 0.12s;
  }

  /* On is cream and never amber: a switch changes a setting and starts no run. The knob moves too,
     so on and off are not colour alone. */
  .switch[aria-checked='true'] {
    background: var(--accent);
  }

  .switch[aria-checked='true']::after {
    left: 16px;
    background: var(--accent-ink);
  }

  .switch:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }
</style>
