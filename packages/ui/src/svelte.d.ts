// TypeScript cannot resolve a `.svelte` import on its own. SvelteKit writes this for the app,
// and a plain package has to say it. `svelte-check` reads the real components and keeps the
// prop types honest, so this only covers the plain `tsc` pass.
declare module '*.svelte' {
  import type { Component } from 'svelte';

  const component: Component<Record<string, unknown>>;
  export default component;
}
