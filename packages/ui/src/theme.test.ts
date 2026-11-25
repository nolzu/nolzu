import { expect, it } from 'vitest';
import { flipTheme, THEME_KEY } from './theme.ts';

const root = (theme?: string): { dataset: Record<string, string | undefined> } => ({ dataset: theme === undefined ? {} : { theme } });
const store = () => {
  const saved: Record<string, string> = {};
  return { saved, setItem: (key: string, value: string) => void (saved[key] = value) };
};

it('flips an explicit theme and remembers it', () => {
  const page = root('dark');
  const storage = store();

  expect(flipTheme(page, false, storage)).toBe('light');
  expect(page.dataset.theme).toBe('light');
  expect(storage.saved[THEME_KEY]).toBe('light');
});

it('flips from what the system shows when no theme was chosen yet', () => {
  expect(flipTheme(root(), true, store())).toBe('light');
  expect(flipTheme(root(), false, store())).toBe('dark');
});

// A private window can refuse storage. The theme still flips; it only is not remembered.
it('still flips when storage throws', () => {
  const page = root('light');
  const refusing = {
    setItem: () => {
      throw new Error('The quota has been exceeded.');
    },
  };

  expect(flipTheme(page, false, refusing)).toBe('dark');
  expect(page.dataset.theme).toBe('dark');
});

it('still flips with no storage at all', () => {
  expect(flipTheme(root('dark'), false, null)).toBe('light');
});
