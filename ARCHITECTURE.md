# Nolzu architecture

How the client is built and the rules the code follows. `CODEMAP.md` says where each part lives in the code, and `docs/` holds the pages for users.

## Purpose

Nolzu is a local-first kanban board for developers. Dragging a card one column forward is
the approval that starts an AI coding agent on the developer's own machine. Around that
pipeline, Nolzu:

- keeps a self-learning knowledge base that the pipeline maintains itself,
- runs Scout, which watches tickets, repos, error trackers and logs for problems and turns
  them into cards with a read-only investigation,
- turns its own records into evidence: standups, timesheets and cost reports.

Nolzu serves two kinds of users with one pipeline: engineers on existing, ticket-driven
stacks, and builders who start from an idea and need a structured process.

The free client lives in this repository. The paid tiers, Solo and Team, add a hosted
server.

Product story in one line: nothing hidden, everything on the board.

## Ground rules

1. No real names anywhere. No company, customer or people names, hostnames, internal URLs
   or real ticket keys in code, tests, fixtures, docs, commit messages or screenshots.
   Example tickets use `PROJ-123`. There are two exceptions: the licensor name and the
   copyright line in `LICENSE`, and a bundled font license kept as its authors wrote it,
   such as `packages/ui/src/fonts/OFL.txt`.
2. The demo project for docs and tests is a small recipe app with two fake services and
   fake tickets in a folder. It lives in `examples/recipe-workspace` (the folder name is older
   than the workspace project shape, and it is not one), installs nothing and
   runs offline. It carries no git repository of its own, because one cannot nest inside
   this repository, so a run that needs one copies the folder to a temp directory and runs
   `git init` there.
3. Nothing in the client is written for one company's stack. Local stacks, deployments and
   time tracking are reached through generic hooks and adapters.

## Decisions that shape the code

1. Web app, not desktop. The client is a local Node server plus a browser UI. It is started with
   `npx nolzu@latest` from any folder, which downloads the newest version each time, so the same
   command updates it. A global install (`npm install -g nolzu`, then `nolzu`) keeps a fixed
   version. One Nolzu runs per
   machine: a second start opens the running one in the browser. It finds it through
   `running.json` in the data folder, which the launcher writes once the server listens (process
   id, port and version), and asks that port's `/api/health` which data folder it serves. A record
   left by a crash is ignored, and the `writer` lock in `machine.db` stays the
   last guard, whatever project each start opens.
   It runs on macOS and Linux. On `win32`, and on WSL 1 (a kernel release that says `Microsoft`
   without `microsoft-standard`), Nolzu stops before it opens a database, a port or the keychain,
   with one line that points to WSL 2 and the quickstart (`platformRefusal`). WSL 2 counts as Linux.
   Linux is not tested yet, so a Linux start prints one line that says so (`platformWarning`) and
   goes on; macOS is the tested system.
   Ctrl+C (SIGINT) or SIGTERM stops every run in the queue through the path Stop takes
   (`Loop.shutdown` from `hooks.server.ts`), first with no slot left so nothing new starts, and the
   process leaves once each run has written its stop. The launcher sets `SHUTDOWN_TIMEOUT` to 1
   unless the person set it, because adapter-node waits that many seconds (30 by default) for open
   connections, and an open page's live stream never ends. The queue is shared, so this covers the runs
   of every project. An Ask run and a commit message pass take no slot, and the same shutdown
   aborts them. Projects are made in the app, never taken from the folder the command runs in.
   A desktop shell may come later and must be able to wrap the same code.
2. Free client, paid server. This repository contains only free functionality. Paid features run on the
   hosted server and in a private package that is downloaded only for paying users. No
   paid logic and no license checks in this repository, and no plan conditions beyond the
   ones in item 3.
3. The server enforces, the client only displays. Plan information the client receives is
   used to show or hide UI, never as a security boundary. Three actions ask it again on a
   post: the Scout schedule, the timesheet export and the tracker connection form. That
   refuses a hand post on Free, and it is still no security boundary. Every plan line the client
   shows (the locked New project, the Solo line under older Evidence days, the Cloud page's "An
   account adds") shows or hides by the signed display document the server sends, and a client
   with no document shows the Free state. The words are fixed in the client, because the
   document carries the plan and its features and no text.
4. Free needs no Nolzu account. The client works fully without signing in. Only Solo and Team
   need a Nolzu account. A project does need the person's own git host login, which today
   is `gh` for GitHub.
5. Scout is read-only. It may create cards and run read-only investigations. It never
   changes code, never pushes and never writes to external systems.
6. Knowledge writes are visible and reversible. Every change is shown as a diff, stored as
   a git commit linked to its card, and can be reverted in one click.
7. Vendor credentials are never touched. Nolzu spawns the unmodified vendor CLI and
   inherits the user's login. The Nolzu account token is a separate concern and lives in
   its own module.
8. Not in the product: self-hosted server, hosted agent runs, self-review draft, multiple
   machines per user (for now), desktop app (for now), SSO (for now).

## Stack

- TypeScript 6 everywhere, strict mode. TypeScript 7 is out, but typescript-eslint,
  svelte-check and SvelteKit support only versions below 7.
- A user needs Node 22.16 or newer, set in `engines`: the command checks it
  before anything loads `node:sqlite` and names the version on an older one. Working on Nolzu
  needs Node 24.21 or newer, set in `devEngines.runtime`, so `pnpm install` on an older Node stops
  with an error, and the scripts run their TypeScript as it is. `.nvmrc` names 24.21.0. Node 22
  prints an experimental warning for `node:sqlite` on every start, and the command drops that one
  warning (`quietSqliteWarning`).
- Svelte 5, SvelteKit 2 with adapter-node, Vite 8, Vitest 5.
- sqlite through `node:sqlite`, which is built into Node. There is no native build step, so
  the client needs no compiler on any machine with a supported Node version.
- Markdown rendering through a sanitizing pipeline: `marked` plus DOMPurify.
- No UI framework beyond Svelte. Design tokens are CSS variables, see
  `docs/design-system.md`.
- pnpm 12 workspace, pinned in `packageManager`: `packages/core`, `packages/runner`,
  `packages/ui`, `packages/protocol`, `packages/skills`, `apps/local`. Dependency build
  scripts stay off unless `allowBuilds` in `pnpm-workspace.yaml` lists them.
- Workspace packages are named `@nolzu/<folder>` and point `exports` at `src/*.ts`.
  Relative imports carry the `.ts` extension. The tsconfig uses `nodenext` with
  `verbatimModuleSyntax` and `erasableSyntaxOnly`, so Node runs the source without a
  loader, and tests and the smoke run need no build step. `protocol` and `core` still build to
  `dist`, which the build check runs; no workspace package is published.
- `@nolzu/core` has two entry points. `@nolzu/core` is pure and uses no Node
  built-ins. `@nolzu/core/node` holds the sqlite layer and card storage,
  and only it may use Node modules.
- Import boundaries use ESLint's built-in `no-restricted-imports` and
  `no-restricted-globals`, with config blocks per package folder in `eslint.config.js`. No
  plugin is needed. `protocol` imports no workspace package. `core`, `ui` and `skills` import
  only `protocol`. `runner` imports `protocol` and `core`, because the phase policy and the
  vendor rules live in `core/src/phase-policy.ts` and the board has to resolve a row against
  the same rule the spawn enforces. Core imports nothing of the runner. Outside `packages/core/src/node/`, core imports
  no Node built-in and no file from `src/node/`, and uses no `process`, `Buffer`,
  `__dirname` or `require`. No file in core imports `child_process`. Relative imports never
  leave a package. `apps/local` may import every package, and it is the only place that
  wires core and runner.
- CI: lint, typecheck, vitest, build, a pack check (the packed app installs into an empty
  folder and starts), a dash check over `*.md`, `*.svelte` and `*.html`, a
  skills lint (frontmatter, folder name equals skill name, no broken cross references), a
  smoke run with the fake engine (`NOLZU_FAKE_AGENT=1`), and secret scanning.
- Secret scanning runs the gitleaks command line tool, version 8.30.1, over the full git
  history. CI downloads it from the GitHub release and checks its SHA-256 before it runs.
  The gitleaks GitHub Action needs a paid license for organization repositories, and the
  tool itself does not. It runs on every pull request, so a secret is caught before it
  reaches `main`.
- No shared package is published. `protocol`, `core`, `ui`, `runner` and
  `skills` are private workspace packages.

## Repository layout

```
nolzu/
├── AGENTS.md              rules for coding agents
├── ARCHITECTURE.md        this file
├── CODEMAP.md             where each part lives in the code
├── README.md              what Nolzu is, the four boards, how to install it, the first run
├── CHANGELOG.md           what a person can do, newest first
├── CONTRIBUTING.md        setup, checks, sign-off and writing rules for a pull request
├── SECURITY.md            how to report a security problem
├── LICENSE                FSL-1.1-ALv2
├── packages/
│   ├── core/              boards, rules, queue, lanes, adapters, scout, evidence
│   │   └── src/node/      sqlite layer and card storage, exported as @nolzu/core/node
│   ├── runner/            engines, git, worktrees, files, the app QA starts, qa
│   ├── ui/                Svelte components, design tokens, fonts
│   ├── protocol/          API and WebSocket message types shared with the server
│   └── skills/            pipeline skills (refine, plan, implement, qa, wrapup, ...)
├── apps/
│   └── local/             the free client: core + runner + ui in one node process
├── examples/
│   └── recipe-workspace/  two fake services, fake tickets, runnable offline
├── test/
│   └── stubs/             stand-ins for SvelteKit's `$app` modules in the tests
└── docs/
    ├── board.svg          the drawn board at the top of the README
    ├── design-system.md   tokens, fonts, sizes and shared parts
    ├── extensions.md      the public extension interface
    ├── engines/           README.md, claude-code.md, cursor.md, codex.md
    └── stack-hook/        an example of own commands for two repositories
```

Each package is named `@nolzu/<folder>`. The app is named `nolzu`, which is also its npm package. The
root holds
`pnpm-workspace.yaml`, `tsconfig.base.json` and `vitest.config.ts`, which lists every
package as a Vitest project.

## Licensing and distribution

- The repository uses the Functional Source License, version 1.1, with Apache 2.0 as
  the future license (`FSL-1.1-ALv2`). Anyone may use, change and share the code for any
  purpose except a competing product or service. Each release becomes Apache 2.0 two years
  after it is published. Péter Halász is the licensor and copyright holder named in
  `LICENSE`.
- The font files in `packages/ui/src/fonts` (Geist and Geist Mono) are not ours. They come
  under the SIL Open Font License 1.1, whose text and copyright line are in `OFL.txt` next to
  them. The packed client carries that file as `dist/fonts/OFL.txt`.
- Call the project "public source" or "source available", never "open source".
- Until the contributor license agreement is ready, every commit in an outside pull request
  carries a DCO sign-off line (`git commit -s`). The author keeps the copyright, and the lines
  come in under the repository license. Once the agreement is ready, new pull requests sign it and earlier authors are
  asked once. Code pull requests are taken only for an issue labelled `accepted`; docs and typo
  fixes come from anyone.
- Distribution: the `nolzu` npm package, started with `npx nolzu@latest` from any folder, one per
  machine (see above). Contributors run it from a clone, as the README shows. The package bundles
  every workspace package it uses, so it depends on no other package and needs no registry token.
  Projects are
  made in the app, so there is no `npm create` entry.
- Never use a vendor's name or logo in the product name, feature names or logo. "Works
  with Claude Code, Cursor and Codex" in plain text is fine.

## Terms-of-service constraints (as of September 2026)

- Vendor OAuth tokens may be used only inside the vendor's own tools. Nolzu never touches
  tokens. It spawns the unmodified CLI and inherits the user's login.
- No "sign in with Claude" in Nolzu, no vendor token storage, no proxying of requests.
- The same rules apply to Cursor CLI and Codex CLI: spawn the
  unmodified CLI, inherit the user's login, and check each vendor's terms for headless use
  before release.
- Limit state comes only from the CLI's own output or its own command. The tools that show
  more read the vendor's login token or a browser cookie and call a private endpoint, and
  vendors suspended accounts for that in 2026.
- Two profiles of one engine are for a person with two accounts, such as work and personal.
  No vendor's terms that were read allow switching accounts to get past a usage limit. So Nolzu
  never does it on its own, no text describes profiles as more capacity, and "Run on" after a
  usage limit leaves out the other logins of that vendor and offers only other vendors' logins.
- A shipped preset or feature never carries a vendor's product name. Saying in plain text that
  Nolzu runs Claude Code is allowed. Using the name as part of a feature name is not.
- Gemini CLI stopped serving Google AI Pro, Ultra and free accounts on 2026-06-18, and it is
  not an engine. Antigravity, Google's CLI for its subscriptions, is not an engine either. Its
  FAQ (read 2026-11-18) says running `agy` inside third-party coding agents or apps is not
  supported on consumer plans, and its terms call third-party software a breach that can
  suspend the account. So it was taken out before 0.1.0. A profile or a row an earlier build
  stored for it reads as a removed profile.
- Nolzu is not made by or affiliated with Anthropic, OpenAI or Anysphere. Each run counts against
  the person's own plan or API key, under that vendor's terms, and the README says so.
- Hosting agent runs for users would require the vendor's commercial terms, per-user
  authentication and an unmodified binary. Nolzu does not host agent runs in any tier.
- Headless `claude -p` currently draws from the user's subscription. A billing change to a
  separate credit was announced and paused in June 2026. Nolzu works with an API key
  too, its runner is engine-agnostic, and no claim depends on one billing model.

## Known pitfalls

Design for these from day one.

- `cwd` is not `PWD` for docker compose. Set `PWD` explicitly when spawning your own commands.
- macOS idle sleep kills long runs without any sign. Hold keep-awake for every run. Node
  timers pause during sleep, so measure wall clock separately.
- Skill frontmatter `model:` overrides `--model`. The product's model settings only work if
  skills carry no pin.
- `--output-format json` structures the envelope only. Structured verdicts need a second
  extraction pass, with one shared rule text for both passes.
- A skill with a strong output format ignores appended instructions.
- A headless run loads the project's `.mcp.json` and the user's own servers without asking,
  because it cannot show the trust prompt. `--strict-mcp-config` is what stops that, and
  `--tools ""` on its own does not, because MCP tools come from the configuration and not
  from the tool list. Interactive MCP auth is not available headless, so ticket lookups go
  through REST.
- A button that starts a run must follow the run, not the request.
- The live database must be unreachable from tests. `NOLZU_FAKE_AGENT=1` forces a separate
  data directory.
- Batch GitHub reads with one GraphQL document per 20 PRs. Parse stdout even when `gh`
  exits non-zero, because partial results are still there.
- Card locking while queued or running, and "never move a card the machine does not own",
  are the two rules that keep human and agent from colliding.
- On macOS, processes started outside a login shell may not have the user's PATH. Resolve
  the shell environment before spawning `claude`, `cursor-agent`, `codex`, `gh`, `glab`
  or `docker`.
