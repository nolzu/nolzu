import type { GhLogin } from './new-project.ts';

// The two seconds the start page waits between looks for an agent tool, too.
export const GH_WAIT_MS = 2000;

/**
 * A page that waits for something done in a terminal: it reads again every two seconds and hands each
 * answer on, until one is `done`. A read that fails is asked again. Returns the stop.
 */
export function waitFor<T>(read: () => Promise<T>, tell: (answer: T) => void, done: (answer: T) => boolean, every: number = GH_WAIT_MS): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const ask = async (): Promise<void> => {
    const answer = await read().then(
      (value) => ({ value }),
      () => null,
    );
    if (stopped) return;
    if (answer !== null) tell(answer.value);
    if (answer === null || !done(answer.value)) timer = setTimeout(() => void ask(), every);
  };
  timer = setTimeout(() => void ask(), every);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// New project waits for `gh auth login` in a terminal, until gh is signed in.
export const waitForGh = (read: () => Promise<GhLogin>, tell: (login: GhLogin) => void, every: number = GH_WAIT_MS): (() => void) =>
  waitFor(read, tell, (login) => login.signedIn, every);
