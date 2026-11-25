import type { Binding, KeyActions } from '@nolzu/ui';

// The keys of one screen and the actions they run.
export interface ScreenKeys {
  keys: readonly Binding[];
  actions: KeyActions;
}

// What the screen on show hands the layout, whose one key handler reads it beside the global keys.
// Null on a page with no keys of its own.
class PageKeys {
  now = $state.raw<ScreenKeys | null>(null);

  // Called from a screen's effect, and returns its cleanup. The cleanup leaves the keys of a screen
  // that mounted in the meantime alone, because the old page can go after the new one arrived.
  show(screen: ScreenKeys): () => void {
    this.now = screen;
    return () => {
      if (this.now === screen) this.now = null;
    };
  }
}

export const pageKeys = new PageKeys();
