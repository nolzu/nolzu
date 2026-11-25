import { type BoardToasts, NO_TOASTS } from './board-page.ts';

// The one toast stack of the app. The root layout draws it in its one corner, and every screen and the
// palette raise into it, so a toast stays on screen when the page changes and a move that works drops
// the card's refusal whichever screen raised it.
class ToastStack {
  state = $state.raw<BoardToasts>(NO_TOASTS);
}

export const toastStack = new ToastStack();
