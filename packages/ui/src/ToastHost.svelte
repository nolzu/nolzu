<script lang="ts">
  import Button from './Button.svelte';
  import { runLine, splitCode, TOAST_LIMIT, type ToastItem, toastLife } from './toasts.ts';

  // The app owns the one stack and changes it with pushToast and dropToast, and the host says which card
  // the person dismissed. It draws the newest three of whatever it is handed, so a caller that skips
  // pushToast still gets the limit.
  let { toasts, ondismiss }: { toasts: readonly ToastItem[]; ondismiss: (key: string) => void } = $props();

  // Where the reader was when each toast appeared. A toast never takes focus, so this is the button
  // they pressed or the card they dropped, and dismissing leads back there instead of to the body.
  const before = new WeakMap<ToastItem, HTMLElement | null>();
  $effect(() => {
    for (const toast of toasts) if (!before.has(toast)) before.set(toast, document.activeElement as HTMLElement | null);
  });

  function dismiss(toast: ToastItem): void {
    const back = before.get(toast);
    if (back?.isConnected) back.focus();
    ondismiss(toast.card.key);
  }

  // The bar's own animation is the countdown, so hover and focus pause both at once and no timer runs
  // per frame. Its end closes the toast without moving the focus, which is outside it by then.
  function expire(toast: ToastItem, event: AnimationEvent): void {
    if (event.target === event.currentTarget) ondismiss(toast.card.key);
  }
</script>

{#snippet said(text: string, code: string | null | undefined)}
  {@const parts = splitCode(text, code)}
  {#if parts === null}{text}{:else}{parts[0]}<code>{parts[1]}</code>{parts[2]}{/if}
{/snippet}

<!-- One fixed corner for every page, newest at the bottom. The corner is the live region and is always
     on the page, because a region added together with its text is often not read out. An error is an
     alert of its own, which is read out as it appears. -->
<div class="toasts" role="status">
  <!-- Keyed by the toast itself, so a new toast for the same card starts its countdown over. -->
  {#each toasts.slice(-TOAST_LIMIT) as toast (toast)}
    {@const line = runLine(toast.run) ?? toast.note ?? null}
    <!-- Centred, except a toast with more than one line, which lines up at the top. -->
    <div class="toast" class:top={!!toast.fix || (!!toast.headline && !!toast.message) || !!toast.link} data-kind={toast.kind} data-refused={toast.refused ? '' : undefined} role={toast.kind === 'error' ? 'alert' : undefined} style:--life="{toastLife(toast)}ms">
      <!-- Each kind has its own icon, so the kind is not told by the tint alone. -->
      <span class="icon">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {#if toast.kind === 'info'}
            <circle cx="12" cy="12" r="9"></circle><path d="M12 8h.01M11 12h1v5h1"></path>
          {:else if toast.kind === 'success'}
            <path d="m5 12 5 5 9-10"></path>
          {:else if toast.kind === 'warning'}
            <path d="M12 3 2 20h20L12 3Z"></path><path d="M12 10v4M12 17h.01"></path>
          {:else if toast.refused}
            <!-- The ban sign: nothing ran, the move was turned down. -->
            <circle cx="12" cy="12" r="9"></circle><path d="M6 6l12 12"></path>
          {:else}
            <path d="M6 6l12 12M18 6 6 18"></path>
          {/if}
        </svg>
      </span>
      <div class="text">
        <!-- The key names the card and Open is the one link to it. A headline says what
             happened to the card, and the one line under it says why and what fixes it, so a
             refused drop has two lines. The space before the fix is inside the
             expression, because Svelte drops a space at the start of a block. -->
        {#if toast.title}
          <p class="message">{toast.title}</p>
        {:else if toast.headline}
          <p class="message"><span class="key">{toast.card.key}</span> {toast.headline}</p>
          {#if toast.message || toast.fix}<p class="said">{@render said(toast.message, toast.code)}{#if toast.fix}{` ${toast.fix}`}{/if}</p>{/if}
        {:else}
          <p class="message"><span class="key">{toast.card.key}</span>: {@render said(toast.message, toast.code)}</p>
        {/if}
        {#if line}<p class="run">{line}</p>{/if}
        {#if toast.fix && !toast.headline}<p class="fix">{toast.fix}</p>{/if}
        <!-- The screen that fixes it. -->
        {#if toast.link}<p class="go"><a class="open" href={toast.link.href} data-toast-link>{toast.link.label}</a></p>{/if}
      </div>
      <!-- A toast with a fix link has no Open: the person was holding the
           card, and the link is what to do next. Open would also squeeze the reason onto a third line.
           A card with no href has nowhere to open. -->
      {#if !toast.link && toast.card.href}<a class="open" href={toast.card.href} aria-label="Open {toast.card.key}">Open</a>{/if}
      <Button variant="ghost" size="small" aria-label="Dismiss {toast.card.key}" onclick={() => dismiss(toast)}>
        <svg class="x" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>
      </Button>
      <span class="life" aria-hidden="true" onanimationend={(event) => expire(toast, event)}></span>
    </div>
  {/each}
</div>

<style>
  /* The empty corner lets clicks through to the board under it. */
  .toasts {
    position: fixed;
    right: var(--space-3);
    bottom: var(--space-3);
    z-index: 40;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: min(32rem, calc(100vw - 2 * var(--space-3)));
    pointer-events: none;
  }

  .toast {
    position: relative;
    overflow: hidden;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-lg);
    background: var(--card-2);
    box-shadow: var(--shadow);
    color: var(--ink);
    font-size: var(--text-sm);
    pointer-events: auto;
  }

  /* The time left, shrinking from full to empty along the bottom edge. Muted, because it is no state. */
  .life {
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 2px;
    background: var(--muted);
    transform-origin: left;
    animation: life var(--life) linear forwards;
  }

  /* WCAG 2.2.1: the person gets the time they need. Pointing at the toast or a key focus in it holds it. */
  .toast:hover .life,
  .toast:focus-within .life {
    animation-play-state: paused;
  }

  @keyframes life {
    from {
      transform: scaleX(1);
    }

    to {
      transform: scaleX(0);
    }
  }

  /* No moving bar, but the same countdown runs on the hidden one, so the toast still closes on time.
     tokens.css cuts every animation to 0.01ms here, which would close the toast at once, so the
     duration is set back with the same weight. */
  @media (prefers-reduced-motion: reduce) {
    .life {
      visibility: hidden;
      animation-duration: var(--life) !important;
    }
  }

  .icon {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 50%;
  }

  .icon svg,
  .x {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  [data-kind='info'] .icon {
    background: var(--blue-bg);
    color: var(--blue);
  }

  [data-kind='success'] .icon {
    background: var(--green-bg);
    color: var(--green);
  }

  [data-kind='error'] .icon {
    background: var(--red-bg);
    color: var(--red);
  }

  /* Amber means a run starts, so a warning is neutral (`docs/design-system.md`). */
  [data-kind='warning'] .icon {
    background: var(--card);
    color: var(--muted);
  }

  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .message {
    margin: 0;
    font-weight: 500;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .top {
    align-items: flex-start;
  }

  .key {
    font-family: var(--font-mono);
  }

  .run {
    margin: 0;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .fix,
  .said {
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-xs);
    line-height: 1.45;
  }

  /* A model inside the sentence: mono on a hairline box. */
  code {
    padding: 0 4px;
    border: 1px solid var(--line);
    border-radius: var(--radius-xs);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }

  .go {
    margin: 0;
    padding-top: var(--space-1);
  }

  .open {
    display: inline-flex;
    flex: none;
    align-items: center;
    box-sizing: border-box;
    height: 26px;
    padding: 0 9px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-xs);
    text-decoration: none;
  }
</style>
