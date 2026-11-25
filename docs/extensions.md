# Extensions

Nolzu's client can load extra features at runtime. A feature is a plain object with an id and
whatever of three parts it brings: pages, panels and one settings block. The interface knows
nothing about plans, payment or who the person is, so it could host a community plugin as well
as the paid package.

The client works fully with nothing loaded. That is the state it ships in, and every part of the
board, the card page and the settings page works without a single feature.

## Registering

This is code inside the client. A downloaded package cannot import `$lib`, so it takes the same two
functions off a global instead, see "How a package is loaded".

```ts
import { loadFeature, registerFeature } from '$lib/features.svelte.ts';
import CloudPage from './CloudPage.svelte';

loadFeature(() =>
  registerFeature({
    id: 'cloud',
    routes: [{ path: 'cloud', title: 'Cloud', component: CloudPage }],
    panels: [{ slot: 'app', component: CloudBanner }],
    settings: { id: 'cloud-sync', title: 'Cloud sync', component: CloudSettings },
  }),
);
```

`registerFeature` answers true when the feature is in, and false with a line on the console when
it is not. A refusal is not a throw, because the caller is a package the app loaded and a refusal
there must not reach the person as a crash. An object that does not match the interface, such as a
page with no `path` field at all, can still make it throw, and `loadFeature` catches that.

A feature is refused when it has no id, when another feature already has that id, when one of its
pages has an empty path or wants a path another feature answers at, or when its settings block
wants an id that is taken. Nothing is stored until every part passes, so a refused feature is never
half in.

`loadFeature` runs a package's own start code and catches whatever it throws. What the package
registered before it threw stays. Use it around any code that comes from outside the client.

## Where the three parts show

A page answers under `/f`, so `path: 'cloud'` is the page at `/f/cloud`. The path with no feature
behind it says so in one sentence rather than showing an empty page.

A panel shows in a slot the app names. This version has two slots: `app`, under the page content
on every route, and `projects`, in Settings, Project at `/settings/project`. The slot kept its name
when the Projects page moved into Settings. A panel that asks for a slot this version does not have
is not refused, because a feature built for a later client has to stay loadable. It shows nowhere
until that version lands.

A settings block shows at the foot of the Project section, `/settings/project`, under an anchor
named by its id, and its title joins the settings menu. An old `/settings#<id>` link lands on it.
The id cannot be one of the app's own sections: `project`, `engines`, `models`, `phases`, `mcp`, `runs`, `integrations`,
`wall` or `cloud`, because an old `/settings#<section>` link goes to that section's own page and never
to the block. Nor can it be one of the sections they replaced: `agents`, `knowledge`, `scout`,
`connection` or `data`, because a link to one of those goes to its new home. Pick an id the Project page does
not use already, such as `billing` or `tickets`, or the anchor lands on the Project form.

## How a package arrives

The client asks the server for its package with the access token from the OS keychain. The answer
is one JSON body: the manifest, the signature over it, and the gzipped bundle. The manifest names
the file to write, its sha256 digest and its length, and the signature covers all of that.

The client checks the signature against the public keys the build carries, then hashes the bytes
and compares them with the digest. Nothing that fails a check reaches the disk. A signature from
another key, a bundle swapped on the way, and a body from a server that is not the real one all
end the same way: no file, no pointer, and the client stays the free client.

An install writes into `packages` under the data directory. The bundle is unzipped into a file
whose name carries the process id, renamed onto the name the manifest signed, and a pointer file
called `current` is renamed last. A rename is the one step that cannot half happen, so a client
killed mid install still runs what it ran before. A refusal is always a null and never a throw,
because a package must not be able to stop the client from starting. It is all in
`apps/local/src/lib/package.ts`.

A server that refuses means Free, and Free is not an error. Nothing is shown and nothing is
logged.

## How a package is loaded

The app imports `/api/package/entry` in the browser when it starts. That route answers with the
installed file as a module, or with an empty module when nothing is installed. Just before the
import the app puts the two functions a package needs on one global, because the built app's own
chunks have hashed names that nothing can import by hand:

```js
const { loadFeature, registerFeature } = globalThis.nolzu;

loadFeature(() => registerFeature({ id: 'pro', panels: [{ slot: 'app', component: ProPanel }] }));
```

The package's start code has to be synchronous. `loadFeature` catches what its callback throws,
and a promise that rejects later is outside that try, so it would become an unhandled rejection
instead.

A package brings its own copy of Svelte, and it mounts its own components. The app does not hand
its copy over, and a component built on the other copy cannot be passed to the app to draw: Svelte
sets up its DOM helpers in `mount` alone, so the first element throws, and a `$effect` in it throws
`effect_orphan` because the effect the app is running belongs to the other copy. So a package
registers a component of its own that makes an element, puts it at the anchor the app hands it, and
calls its own `mount` on that element. Measured against Svelte 5.57.0 with a second copy of Svelte
on disk.

Two copies have a cost. Context and stores do not cross between the app and the package. The
package's updates flush on its own schedule and not in the same step as the app's. When the app
stops drawing a panel it removes the package's nodes, and the package's own effects keep running, so
a package that starts a timer stops it itself.

A feature registers when its module is imported, which is after the layout has drawn. The list of
registered features is reactive state, so the panel slots, the settings menu and a feature page all
draw the new parts when that happens, with no reload.

A feature component that throws while it draws is caught. Each of the three places wraps the
feature in `<svelte:boundary>`, puts one line in its place and writes the cause to the console.
That holds in the browser only: a server render rethrows out of the boundary. It costs nothing
here, because registration is module state set in the browser, so the server never draws a
feature component.

## What this does not do yet

A feature page renders its component and has no server load, so a page that needs data fetches it
itself. Registration is module state, so a feature registered only in the browser renders its
pages after hydration and not in the server's HTML. Both are fine for a panel and a settings
block, and a page that needs either wants a real SvelteKit route instead.

`clearFeatures()` drops everything registered. Nothing calls it yet. It is what every test starts
from.

The accounts and the hosted server are closed until the paid plans open (`CLOUD_OPEN` in
`packages/protocol/src/soon.ts`). Until then no package is installed, and `/api/package/entry`
serves the empty module even when a package an earlier sign-in left is on disk, so no paid panel
loads.
