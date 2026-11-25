<script lang="ts">
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import Button from '../Button.svelte';

  // The menu button pattern for the actions Next step keeps out of sight: the button opens a small
  // menu of `role="menuitem"` rows, the arrow keys, Home and End move between them, and Escape closes
  // it and gives the focus back. Tab or a press outside closes it too. A press on a row closes it
  // before the row's own work goes on, so a row that opens a form can move the focus there.
  //
  // The rows stay in the page while the menu is shut, hidden, so a server render still holds them.
  let { label = 'More actions', children }: { label?: string; children: Snippet } = $props();

  const uid = $props.id();
  let open = $state(false);
  let wrap = $state<HTMLElement | null>(null);
  let menu = $state<HTMLElement | null>(null);

  const rows = (): HTMLElement[] => [...(menu?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const button = (): HTMLElement | null => wrap?.querySelector<HTMLElement>(`#${uid}-button`) ?? null;

  async function show(at: 'first' | 'last'): Promise<void> {
    open = true;
    await tick();
    const all = rows();
    (at === 'first' ? all[0] : all.at(-1))?.focus();
  }

  function close(focus: boolean): void {
    open = false;
    if (focus) button()?.focus();
  }

  function onbuttonkey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    void show(event.key === 'ArrowDown' ? 'first' : 'last');
  }

  function onmenukey(event: KeyboardEvent): void {
    const all = rows();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      all[(to + all.length) % all.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(all.length - 1);
    else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') close(false);
  }

  function onmenuclick(event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('[role="menuitem"]') !== null) close(true);
  }

  $effect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrap?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  });
</script>

<div class="more" bind:this={wrap}>
  <Button
    variant="ghost"
    size="small"
    id="{uid}-button"
    data-more
    aria-haspopup="menu"
    aria-expanded={open ? 'true' : 'false'}
    aria-controls="{uid}-menu"
    onclick={() => (open ? close(false) : show('first'))}
    onkeydown={onbuttonkey}
    >{label}<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></Button
  >
  <div class="menu" id="{uid}-menu" role="menu" tabindex="-1" aria-labelledby="{uid}-button" hidden={!open} bind:this={menu} onkeydown={onmenukey} onclick={onmenuclick}>
    {@render children()}
  </div>
</div>

<style>
  .more {
    display: flex;
    flex-direction: column;
  }

  .more > :global(button) {
    justify-content: space-between;
  }

  .chev {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }

  /* In the flow under the button, not floating: the panel clips what leaves its box, and the peek
     sheet scrolls. */
  .menu {
    display: flex;
    margin-top: 4px;
    flex-direction: column;
    padding: 4px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .menu[hidden] {
    display: none;
  }

  /* One row per action: words on the left, as the quiet buttons of the foot. Never amber. */
  .menu > :global([role='menuitem']) {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 6px var(--space-2);
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
    text-align: left;
    text-decoration: none;
    cursor: pointer;
  }

  .menu > :global([role='menuitem']:hover),
  .menu > :global([role='menuitem']:focus-visible) {
    background: var(--card-2);
  }

  .menu > :global([role='menuitem'][aria-disabled='true']) {
    cursor: default;
  }
</style>
