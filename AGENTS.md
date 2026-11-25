# AGENTS.md

Rules for every coding agent working in this repository.

Nolzu is a local-first kanban board where dragging a card forward starts an AI coding
agent on the developer's own machine. This repository holds the free client. The paid
tiers run on a hosted service.

Read `ARCHITECTURE.md` (ground rules, stack, layout, vendor terms, known pitfalls) before any
work, and `docs/design-system.md` before a change to the UI.

Then read `CODEMAP.md`. It says where each file, symbol and flow lives, so open the files and
symbols it points to, and find a symbol with `rg -n <symbol>` instead of exploring. When a change
adds, moves or removes a file or a key symbol, update its line in `CODEMAP.md` in the same change.
`codemap.test.ts` fails on a path or a key symbol the map names and the tree does not have.

## Hard rules

1. No real names. No company, customer or people names, hostnames, internal URLs or real
   ticket keys in code, tests, fixtures, docs, commits or screenshots. `PROJ-123` is the
   example key for an external ticket system and for adapter fixtures, and local tickets in
   the demo project use `APP-1` and up. The demo project is a recipe app. The licensor name
   and the copyright line in `LICENSE` are one exception. The other is a bundled font license
   kept as its authors wrote it, such as `packages/ui/src/fonts/OFL.txt`.
2. No paid logic here. Do not add plan checks, license checks or feature flags tied to
   plans. If a task seems to need them, stop and ask the maintainer.
3. No vendor credentials. Never store, read, proxy or refresh Claude, Cursor or other
   vendor tokens. Spawn the unmodified CLI and inherit the user's login.
4. Core never reads project files directly. It asks the Runner.
5. Scout is read-only. Scout runs never edit files, run write commands, push, or write to
   external systems.
6. Tests never touch the live database. The fake engine (`NOLZU_FAKE_AGENT=1`) also forces
   a separate data directory.
7. Secrets never go into the repo, into sqlite or into logs. Source credentials go to the
   OS keychain.
8. Open decisions belong to the maintainer. Ask, do not pick silently.
9. Agents never register domains or accounts, publish packages by hand, or handle legal
   steps. Nothing is published from CI, and the shared packages are private. The
   maintainer publishes to npm.

## Stack and commands

TypeScript 6 in strict mode, Node 24.21 or newer to work on it, Svelte 5, SvelteKit 2 with
adapter-node, Vite 8, Vitest 5 and a pnpm 12 workspace. sqlite runs through `node:sqlite`. The
workspace has the packages `core`, `runner`, `ui`, `protocol` and `skills`, and the app `local`.
TypeScript stays below 7, because typescript-eslint, svelte-check and SvelteKit do not
support 7 yet.

Nolzu itself runs on Node 22.16 or newer. Runtime code must work on Node 22.16: check a new `node:`
API against it. `pnpm pack:check` starts the packed app on Node 22 when one is installed.

Every package is named `@nolzu/<folder>`. Its `exports` point at `src/*.ts`, and relative
imports carry the `.ts` extension, so Node, Vite and Vitest run the source with no build
step. `@nolzu/core` is pure and uses no Node built-ins. Code that needs Node modules, such as the
sqlite layer, goes into `src/node/` and is imported as `@nolzu/core/node`.

```bash
pnpm install        # stops with an error on Node older than 24.21
pnpm dev            # apps/local on localhost
pnpm build          # every package with a build script
pnpm test           # vitest, all packages
pnpm typecheck      # tsc over the packages, then every package check script
pnpm lint           # ESLint, with the import boundaries between packages
NOLZU_FAKE_AGENT=1 pnpm smoke   # the fake engine moves cards to implement: one repository, two, and a workspace
pnpm pack:check     # after the build: pack the app as the nolzu package, install it, start it
```

`tsc` skips `.svelte` files. A package with Svelte components adds a `check` script that
runs svelte-check, as `apps/local` does, and `pnpm typecheck` picks it up.

`pnpm skills:lint` checks the skills: the frontmatter, that each folder name is its skill name,
and that no cross reference is broken. CI runs it.

## Conventions

- Pure modules (stage machine, PR review state machine, Scout status machine, dedup,
  fingerprinting) get their tests written first.
- Boards are data (`BOARDS[kind]`). Do not hard-code stage logic in components.
- UI busy state comes from the board snapshot over SSE, never from a click's promise. The rule binds
  buttons that start a run. A direct git action, such as a commit, is not a run and shows its own
  inline pending state.
- Svelte components are tested by server render with `render()` from `svelte/server`. What a
  server render cannot reach, such as a click, an effect or the focus, goes in a
  `*.mount.test.ts` file in `packages/ui`, which runs in jsdom with the browser build of Svelte.
  The rule itself still lives in a pure module with its own tests.
- Every state shown in the UI is honest: idle, queued, running, ready, blocked, failed.
- CSS uses the design tokens from `docs/design-system.md`. No new colors without a
  reason. Status is never shown by color alone.
- Check engine CLI flags against the engine's current docs before relying on them.
- Small pull requests, one concern each. Update `ARCHITECTURE.md` when a rule
  in it changes.
- Before a change that touches more than a few files, write a short plan and wait for the
  maintainer's approval.
- When a doc and the code disagree, point out the conflict and ask.

## Writing

Docs, code comments, UI text, commit messages and pull requests follow the same rules.

- Plain, short, specific English. One idea per sentence. Many readers are not native
  speakers.
- No em-dashes and no en-dashes. Use a comma, a period or parentheses.
- None of these words: delve, leverage, robust, seamless, elevate, unlock, comprehensive,
  "ensure that".
- No filler words: just, really, basically, actually, simply, "in order to".
- No bold title sentence at the start of a paragraph or list item.
- Prose by default. A list is only for real parallel items, and only when there are more
  than two of them.
- UI text names the problem. Never "Something went wrong" or "Oops".
- Code comments say why, not what.
- Commit messages use `type(scope): subject`, imperative, 72 characters or less. Add a body
  only when the diff does not show why.
- Pull request descriptions say what changed, why in one line when the title does not say
  it, and how to test it.
- No generated-by lines, no tool attribution and no co-author trailers.

## Definition of done

- Lint, typecheck, tests and the build pass. New behaviour has tests.
- The fake-engine smoke run passes.
- No real names in code, fixtures, docs or commits. Search before committing.
- Docs are updated when behaviour or setup changed.

`pnpm build` is a separate check from `pnpm typecheck` on purpose. `protocol` and `core` build
through their own `tsconfig.build.json`, with their own `lib` and `types`, so a package build can
fail on a name the root typecheck resolved. `ui` is published as its source and has no build.
