import { resolve } from '$app/paths';
import { refusalFromServer } from '@nolzu/ui';
import { dismissed, refusedDrop } from './board-page.ts';
import { askBeforeRetry, askFirst } from './qa-ask.svelte.ts';
import { postWrite } from './ticket.ts';
import { toastStack } from './toast-stack.svelte.ts';

/**
 * The writes the Next step block's buttons send for one card. The card page and the peek both use
 * them, so a press there takes the same route. Each answers with the sentence the server refused it
 * with, or null once it took it. The board moves the card off the stream, never off the answer.
 */
export function nextStepWrites(key: string) {
  const at = encodeURIComponent(key);
  const write = (path: '/api/board/move' | '/api/board/minimize' | '/api/board/stop', body: unknown) => postWrite(fetch, resolve(path), body);
  const retryPath = () => resolve('/api/card/[key]/retry', { key: at });
  return {
    // Moving into QA asks how QA gets the app first. The button waits on the question: Start QA sends
    // the move, and a close with no answer lets the button go. Accept anyway sends its reason with the move.
    onmove: (to: string, reason?: string) =>
      new Promise<string | null | undefined>((settle) => {
        const send = () => write('/api/board/move', { key, to, ...(reason === undefined ? {} : { reason }) }).then(settle);
        if (!askFirst(key, to, send, () => settle(undefined))) void send();
      }),
    // A retry in QA asks the same question while it has no answer, as after the scripts changed.
    onretry: () =>
      new Promise<string | null>((settle) => {
        const send = () => postWrite(fetch, retryPath(), {}).then(settle);
        if (!askBeforeRetry(key, send, () => settle(null))) void send();
      }),
    // The same route with the profile to start on. "Run on" is a fresh run of the same phase, so the
    // server has one path for both.
    onrunon: (profile: string) => postWrite(fetch, retryPath(), { engine: profile }),
    onfix: () => postWrite(fetch, resolve('/api/card/[key]/fix', { key: at }), {}),
    onsendback: () => postWrite(fetch, resolve('/api/card/[key]/send-back', { key: at }), {}),
    onstop: (runId: number | null | undefined) => write('/api/board/stop', { runId }),
    onminimize: (minimized: boolean) => write('/api/board/minimize', { key, minimized }),
    // A refused press is the card's one toast in the app's one stack, and the next press takes it down.
    onrefuse: (said: string | null) => {
      const card = { key, href: resolve('/t/[key]', { key: at }) };
      toastStack.state = said === null ? dismissed(toastStack.state, key) : refusedDrop(toastStack.state, card, refusalFromServer(said));
    },
  };
}
