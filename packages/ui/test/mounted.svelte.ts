import { type Component, flushSync, mount, unmount } from 'svelte';

export interface Mounted<Props> {
  target: HTMLElement;
  // Changes props the way a parent would, and lets the effects run before it returns.
  set: (next: Partial<Props>) => void;
  remove: () => void;
}

// Mounts a component into a real DOM with props that can change afterwards. This file is a
// `.svelte.ts` module because `$state` is what makes a later change reach the component.
export function mounted<Props extends Record<string, unknown>>(component: Component<Props>, initial: Props): Mounted<Props> {
  const props = $state(initial);
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(component, { target, props });
  flushSync();

  return {
    target,
    set(next) {
      Object.assign(props, next);
      flushSync();
    },
    remove() {
      void unmount(instance);
      target.remove();
    },
  };
}
