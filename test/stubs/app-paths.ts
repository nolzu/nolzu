// What `$app/paths` gives a component under the SvelteKit vite plugin. These tests do not run that
// plugin, so without this stub a route `+page.svelte` cannot be imported at all, and its headings,
// its links and its branches are the one part of the app no test reaches.
//
// `route()` below is SvelteKit's own `resolve_route` (src/utils/routing.js), kept step for step,
// including both errors it raises. `resolve()` is what a page calls, and it answers the address the
// app really serves: SvelteKit resolves on the server (src/runtime/app/paths/server.js), and there
// every address is relative to the page being drawn, because `config.kit.paths.relative` is on by
// default and apps/local/svelte.config.js does not turn it off. So `/evidence` links to itself as
// `./evidence`, while `/t/[key]/[tab]` links to it as `../../evidence`. A stub that is close but not
// right is worse than no stub: it makes a test pass on an address no browser ever gets.
//
// What it deliberately does not do, so nobody leans on it:
// - `base` and `assets` are not exported. This app is served at the root, and an empty string
//   pretending to be a sub-path deployment would hide the one bug a sub-path causes.
// - Hash routing is not modelled.
// - Nothing is encoded. The real one splices a value in raw, so every call site in this app calls
//   `encodeURIComponent` itself, and a test reads the address a person clicks.

// SvelteKit's `basic_param_pattern`. Group 1 is the second `[` of an optional `[[name]]`, group 2
// the `...` of a rest parameter, group 3 the name, and the fourth group is a matcher name that
// `resolve_route` ignores.
const PARAM = /\[(\[)?(\.\.\.)?(\w+?)(?:=(\w+))?\]\]?/g;

// A route group like `(app)` is a folder and not a segment of the address. SvelteKit's
// `affects_path` drops it before any parameter is filled in.
const GROUP = /^\([^)]+\)$/;

// The page being drawn. On the server this comes from the request; a test has none, so it says which
// page it renders and gets the addresses that page serves.
let drawn: string | null = null;

/** Say which page is about to be rendered, by its address. */
export function drawnAt(pathname: string): void {
  drawn = pathname;
}

// One `..` per segment below the first, which is what the server puts in front of every address.
function depth(): string {
  if (drawn === null) {
    throw new Error('Call drawnAt() with the address of the page before rendering it, so every link carries the depth that page serves.');
  }
  return (
    drawn
      .split('/')
      .slice(2)
      .map(() => '..')
      .join('/') || '.'
  );
}

/** The address a link on the page being drawn carries. */
export function resolve(path: string, params: Record<string, string> = {}): string {
  const address = route(path, params);
  return depth() + address;
}

/** The address from the root, which the page's own depth then goes in front of. */
export function route(path: string, params: Record<string, string> = {}): string {
  if (!path.startsWith('/')) {
    throw new Error(
      `Cannot use \`resolve(...)\` with a non-absolute pathname or route ID (got "${path}"). ` +
        '`resolve` is only for internal pathnames and route IDs; external URLs should be used directly.',
    );
  }
  // A route id that ends in a slash keeps it. Worked out before the parameters, the way the real
  // one does, because an emptied optional segment must not grow one.
  const trailing = path !== '/' && path.endsWith('/') ? '/' : '';
  return (
    '/' +
    path
      .split('/')
      .filter((segment) => segment !== '' && !GROUP.test(segment))
      .map((segment) =>
        segment.replace(PARAM, (_whole, optional: string | undefined, rest: string | undefined, name: string) => {
          const value = params[name];
          // `!value` and not `value === undefined`, the way the real one reads it: an empty string
          // drops an optional segment and throws on a required one.
          if (!value) {
            if (optional !== undefined) return '';
            if (rest !== undefined && value !== undefined) return '';
            throw new Error(`Missing parameter '${name}' in route ${path}`);
          }
          if (value.startsWith('/') || value.endsWith('/')) {
            throw new Error(
              `Parameter '${name}' in route ${path} cannot start or end with a slash -- this would cause an invalid route like foo//bar`,
            );
          }
          return value;
        }),
      )
      // An optional segment nobody filled in is now empty, and goes with its slash.
      .filter(Boolean)
      .join('/') +
    trailing
  );
}
