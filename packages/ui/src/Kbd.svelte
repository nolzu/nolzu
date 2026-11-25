<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  // One cap per key. KeyCaps draws a modifier such as ⇧ as a cap of its own, as the keyboard help
  // does.
  let { key, ...rest }: HTMLAttributes<HTMLElement> & { key: string } = $props();
</script>

<kbd {...rest}>{key}</kbd>

<style>
  kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-xs);
    background: var(--panel);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-3xs);
    font-weight: 500;
    line-height: 1;
  }
</style>
