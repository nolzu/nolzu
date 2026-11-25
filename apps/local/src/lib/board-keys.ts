import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { page } from '$app/state';
import { flipTheme } from '@nolzu/ui';
import { filterOn, filterQuery } from './board-page.ts';

// Waiting on me, from the board's button, the W key and Esc alike. It stays on the board the page is
// on: moving from /b/epics to /b/delivery would put the person on another board. Research has its own
// route with no board in it, so it is named apart.
export function toggleFilter(): Promise<void> {
  const here = page.route.id === '/b/research' ? resolve('/b/research') : resolve('/b/[board]', { board: page.params.board ?? 'delivery' });
  // eslint-disable-next-line svelte/no-navigation-without-resolve -- the path is resolve()d, and resolve() cannot carry a query
  return goto(`${here}${filterQuery(page.url, !filterOn(page.url))}`, { replaceState: true, keepFocus: true, noScroll: true });
}

// The theme, from the rail's button and the T key.
export function toggleTheme(): void {
  let storage: Storage | null = null;
  try {
    storage = localStorage;
  } catch {
    // Some browsers throw on the getter itself when storage is off.
  }
  flipTheme(document.documentElement, matchMedia('(prefers-color-scheme: dark)').matches, storage);
}
