import { afterEach, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.ts';

const clipboard = (writeText: (text: string) => Promise<void>) => {
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText } }, configurable: true });
};

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'navigator');
});

it('hands the text to the browser and says it went', async () => {
  const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
  clipboard(writeText);

  await expect(copyText('issue: src/a.ts:1\nRead the file once.')).resolves.toBe(true);
  expect(writeText).toHaveBeenCalledWith('issue: src/a.ts:1\nRead the file once.');
});

// A browser refuses a copy for reasons this app cannot fix: no permission, an insecure origin, a
// window that lost focus. The caller has to hear about it, because a copy that failed in silence
// leaves a person pasting whatever was on the clipboard before.
it('says the copy did not go when the browser refuses it', async () => {
  clipboard(async () => {
    throw new Error('Document is not focused.');
  });

  await expect(copyText('anything')).resolves.toBe(false);
});

// The path a headless test and an old browser both take: there is no clipboard at all.
it('says the copy did not go when there is no clipboard', async () => {
  Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });

  await expect(copyText('anything')).resolves.toBe(false);
});
