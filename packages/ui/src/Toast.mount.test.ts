import { afterEach, expect, it, vi } from 'vitest';
import { type Mounted, mounted } from '../test/mounted.svelte.ts';
import Toast from './Toast.svelte';

let toast: Mounted<Record<string, unknown>> | null = null;
let trigger: HTMLButtonElement | null = null;
afterEach(() => {
  toast?.remove();
  toast = null;
  trigger?.remove();
  trigger = null;
});

// The button the reader pressed, which is where focus sits when a refusal toast appears.
function pressed(): HTMLButtonElement {
  trigger = document.body.appendChild(document.createElement('button'));
  trigger.focus();
  return trigger;
}

it('gives focus back to what had it when the toast appeared, once the toast closes', () => {
  const button = pressed();
  const onclose = vi.fn();
  toast = mounted(Toast as never, { kind: 'error', message: 'Refused.', onclose });

  const close = toast.target.querySelector<HTMLButtonElement>('button')!;
  close.focus();
  close.click();

  expect(onclose).toHaveBeenCalledOnce();
  // Without this the close button leaves the page and focus falls to the body, so a keyboard
  // reader starts again from the top of the page.
  expect(document.activeElement).toBe(button);
});

it('leads back to where the reader was for the newest message, when one toast shows the next refusal', () => {
  pressed();
  toast = mounted(Toast as never, { kind: 'error', message: 'First refusal.', onclose: () => {} });
  // The board shows the next refusal in the same toast, so only the props change.
  const second = document.body.appendChild(document.createElement('button'));
  second.focus();
  toast.set({ message: 'Second refusal.' });

  const close = toast.target.querySelector<HTMLButtonElement>('button')!;
  close.focus();
  close.click();

  expect(document.activeElement).toBe(second);
  second.remove();
});
