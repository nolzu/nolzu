<script lang="ts">
  import { resolve } from '$app/paths';
  import type { NotificationItem } from '@nolzu/core/node';
  import { SCOUT_AND_EVIDENCE } from '@nolzu/protocol';
  import { ago, Dialog, Skeleton } from '@nolzu/ui';
  import { onMount } from 'svelte';

  // The bell's panel: what Nolzu kept of each toast, newest first. Opening it reads every item, and an
  // item that comes in while it is open is read too, so the bell counts only what nobody has seen.
  let { newest = [], unread = 0, onclose }: { newest?: readonly NotificationItem[]; unread?: number; onclose: () => void } = $props();

  let listed = $state<NotificationItem[] | null>(null);
  let problem = $state<string | null>(null);
  let dialog = $state<ReturnType<typeof Dialog>>();

  const read = () => fetch(resolve('/api/notifications'), { method: 'POST' }).catch(() => undefined);

  onMount(() => {
    void (async () => {
      try {
        const response = await fetch(resolve('/api/notifications'));
        if (!response.ok) throw new Error(String(response.status));
        listed = (await response.json()) as NotificationItem[];
      } catch {
        problem = 'The notifications could not be read. Close this and open it again.';
        return;
      }
      // After the list, so its New marks are the ones that were unread when it opened.
      await read();
    })();
  });

  // One that comes in while the panel is open is read too. It waits for the list, so a New mark is one
  // from before the panel opened. The count the panel opened with can send a second post just after the
  // first, which finds nothing unread and moves nothing.
  $effect(() => {
    if (unread > 0 && listed !== null) void read();
  });

  // The live few first, for one that came in after the list was read.
  const items = $derived.by(() => {
    if (listed === null) return [];
    const ids = new Set(listed.map((one) => one.id));
    return [...newest.filter((one) => !ids.has(one.id)), ...listed];
  });

  const hrefOf = (one: NotificationItem): string | null => one.href ?? (one.card === null ? null : resolve('/t/[key]', { key: encodeURIComponent(one.card) }));
  const WORD: Record<NotificationItem['kind'], string> = { success: 'Done', error: 'Failed', warning: 'Warning', info: 'Found' };
  // Moved on every half minute, so an item that came in while the panel is open does not say 0s ago
  // until it closes.
  let now = $state(new Date());
  onMount(() => {
    const tick = setInterval(() => (now = new Date()), 30_000);
    return () => clearInterval(tick);
  });
</script>

<!-- A click outside the sheet closes it, as Esc does, the bell's included: the page behind is inert. -->
<Dialog bind:this={dialog} title="Notifications" closer="Close notifications" class="side" {onclose}>
  {#if problem !== null}
    <p class="empty" role="alert">{problem}</p>
  {:else if listed === null}
    <Skeleton shape="rows" count={3} label="Reading the notifications." />
  {:else if items.length === 0}
    <p class="empty">
      {SCOUT_AND_EVIDENCE
        ? 'Nothing yet. A run that ends, a card that asks you, a usage window near its limit and a Scout find show here.'
        : 'Nothing yet. A run that ends, a card that asks you and a usage window near its limit show here.'}
    </p>
  {:else}
    <ul class="list">
      {#each items as one (one.id)}
        {@const href = hrefOf(one)}
        <li class="item" data-kind={one.kind} data-notification={one.id}>
          <span class="word">{WORD[one.kind]}{#if !one.read}&nbsp;<span class="new" data-new>· New</span>{/if}</span>
          {#if href !== null}
            <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- hrefOf resolve()s a card, and the server sends app paths -->
            <a {href} onclick={() => dialog?.close()}>{one.text}</a>
          {:else}
            <span>{one.text}</span>
          {/if}
          <span class="meta mono">{[one.card, ago(one.at, now)].filter((part) => part !== null).join(' · ')}</span>
        </li>
      {/each}
    </ul>
  {/if}
</Dialog>

<style>
  /* A sheet on the right edge over the page, the full height, in place of the centred dialog. Under
     html, so it outweighs the dialog's own scoped rule whatever order the two sheets load in. */
  :global(html dialog.side) {
    width: min(26rem, calc(100vw - 32px));
    height: 100dvh;
    max-height: 100dvh;
    margin: 0 0 0 auto;
    border-width: 0 0 0 1px;
    border-radius: 0;
  }

  .list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2) 0;
    border-bottom: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .item a {
    color: var(--ink);
  }

  /* The kind and New in words and in ink, so neither is colour alone and both pass contrast. */
  .word {
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--ink-2);
  }

  .meta {
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .empty {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-sm);
  }
</style>
