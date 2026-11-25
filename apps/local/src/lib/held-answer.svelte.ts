export type Settled<T> = { ok: true; value: T } | { ok: false; message: string };

// SvelteKit's error page says the error's message, and "Internal Error" for a throw it did not expect.
// A streamed part that fails says the same words in its own place, so the rest of the page stays.
export const failedWords = (error: unknown): string => {
  const message = typeof error === 'object' && error !== null ? (error as { message?: unknown }).message : undefined;
  return typeof message === 'string' && message !== '' ? message : 'Internal Error';
};

/**
 * The answer of a part a server load streams, null until one arrives. A reload keeps the answer drawn
 * until its own arrives, so a tab does not fall back to its placeholder on every invalidateAll. A new
 * scope (the card key) drops it, so one card's answer never shows on another. Call it while a component
 * starts, like any `$effect`.
 */
export function streamed<T>(promise: () => Promise<T> | null | undefined, scope: () => unknown): { readonly current: Settled<T> | null } {
  let held = $state<{ scope: unknown; settled: Settled<T> } | null>(null);
  $effect(() => {
    const asked = promise();
    const at = scope();
    if (asked == null) return;
    let live = true;
    asked.then(
      (value) => {
        if (live) held = { scope: at, settled: { ok: true, value } };
      },
      (error: unknown) => {
        if (live) held = { scope: at, settled: { ok: false, message: failedWords(error) } };
      },
    );
    return () => {
      live = false;
    };
  });
  return {
    get current() {
      return held !== null && held.scope === scope() ? held.settled : null;
    },
  };
}
