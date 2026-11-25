// Where the chosen theme is kept. The page reads it back before it paints, see app.html.
export const THEME_KEY = 'nolzu-theme';

// Flips the page to the other theme and tries to remember it. With no theme chosen yet, the other one
// is the opposite of what the system shows. Storage can throw in a private window; the page still flips.
export function flipTheme(
  root: { dataset: Record<string, string | undefined> },
  prefersDark: boolean,
  storage: { setItem(key: string, value: string): void } | null,
): 'light' | 'dark' {
  const shown = root.dataset.theme ?? (prefersDark ? 'dark' : 'light');
  const next = shown === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    storage?.setItem(THEME_KEY, next);
  } catch {
    // Not remembered, which only costs the choice on the next load.
  }
  return next;
}
