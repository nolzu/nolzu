# Nolzu

Nolzu is a local-first kanban board where dragging a card one column forward starts an AI coding
agent on your own machine. This repository holds the free client. It runs your agents in your own
checkout and keeps its data on your machine.

![A drawing of the Delivery board. The card APP-3 is held over Implement, and the drop box says what will start.](docs/board.svg)

## Install

Start Nolzu from any folder:

```bash
npx nolzu@latest
```

`npx` downloads the newest version of Nolzu each time, so the same command is also how you update.
There is nothing else to install.

If you want a fixed version instead, install it globally with `npm install -g nolzu` and start it
with `nolzu`. Update it with `npm install -g nolzu@latest`.

Nolzu runs on macOS. Linux, WSL 2 included, is not tested yet: Nolzu starts there and says so on
every start, and the Linux steps below are written from the design, not from a checked run. Native
Windows is not supported: Nolzu stops at start there. WSL 1 counts as Windows.

You need:

- Node 22.16.0 or newer (on Node 23, 23.4.0 or newer), which brings `npx` with it.
- On Linux, a keyring for the Jira token and the secrets of MCP servers: `secret-tool` from
  libsecret-tools, and a running keyring such as gnome-keyring. WSL 2 runs none by default, so
  install gnome-keyring and libsecret-tools and start a keyring in the session. Nolzu writes a
  secret to a file in one case only, see
  [When a secret touches a file](SECURITY.md#when-a-secret-touches-a-file).
- On Linux, bubblewrap (`bwrap`), the wall Nolzu puts around every engine run. Install it with
  your package manager, for example `sudo apt install bubblewrap`. Without it, or where the system
  blocks user namespaces, Claude Code and Codex still run every phase and Cursor runs Implement
  only. The [engine notes](docs/engines/README.md#walls) say how to allow user
  namespaces.
- `gh`, the GitHub CLI, signed in with `gh auth login`. Nolzu reads issues and pull requests through
  it. Without it a project still clones and pushes, with no pull
  requests.
- git. To clone a repository by its URL, git has to reach it with no prompt: an ssh key that works
  with no password question, or an https URL with no password or token in it.
- At least one coding agent on your PATH. Nolzu looks for these three:

  | Engine | Binary | Install it from |
  |---|---|---|
  | Claude Code | `claude` | https://code.claude.com/docs/en/setup |
  | Cursor | `cursor-agent` | https://cursor.com/cli |
  | Codex | `codex` | https://github.com/openai/codex |

  Nolzu is not made by or affiliated with Anthropic, OpenAI or Anysphere. Each run counts against
  your own plan or API key, under that vendor's terms. Antigravity is not an engine, because
  Google's terms do not allow third-party apps on its consumer plans.

## The four boards

Nolzu has four boards: Delivery, Epics, Research and PR reviews. Research is one board over two kinds
of card, Investigations and Questions. Any board but Delivery can be turned off in Settings, Project.

- Delivery takes a card from Inbox through Refine, Plan, Implement, QA and Review to Pull request,
  Wrap-up and Closed.
- Epics takes an epic from Inbox through Refine, Architecture, Design, Plan and Review to In
  delivery, Wrap-up and Done. An epic in In delivery counts how many of its Delivery tasks are done,
  as in "3 of 7 tasks done".
- Research takes a question or an investigation from Inbox through Research and Review to Wrap-up
  and Done. Its runs are read-only and end in an answer or a report, and Wrap-up keeps what they
  found in the knowledge files. Questions are numbered `Q-7` and investigations `INV-4`. An answer
  can become a Delivery card or take a follow-up question.
- PR reviews takes someone else's pull request from Incoming through Agent pre-review, My review,
  Awaiting author and Approved to Wrap-up and Closed. A new push sends a card waiting on its author
  back for the next round. You copy the findings to GitHub yourself, because Nolzu posts nothing there.

Dragging a card one column forward onto an agent's column starts that phase, on the engine, model
and effort set for that action. The drop box says what will start before you let go. Dragging back
starts nothing, and a queued or running card is locked. A QA PASS moves a card by itself. The one
other move Nolzu makes is off until you turn it on from Now: a card with "Go on to Implement after
Plan" ticked on its Settings tab goes on from Plan to Implement when its plan is done.

## What it does

- Each phase of a card runs on the engine, model and effort you set for it, on Claude Code, Codex
  or Cursor. The [compatibility page](https://nolzu.com/docs/compatibility)
  says what has been tested on a real project and what is built but not tested yet.
- Every run starts inside an operating-system wall that keeps it to the folders its phase may
  write and hides your keys. [SECURITY.md](SECURITY.md) lists what it holds.
- MCP servers per phase: Settings, MCP servers keeps a list in `.nolzu/mcp-servers.json`, committed
  so your team gets it, and you tick which phases get each server. A secret stays in your OS
  keychain, so each person enters their own.
- Your own skills: a workspace's skills in `.nolzu/skills` travel with git, and Nolzu copies them
  into each engine's skills folder beside its own phase skills.
- A project can add its own instructions to each phase in `.nolzu/phases/<phase>.md`, kept in the
  project repository and edited in Settings, Phase instructions. Nolzu adds them to the prompt on
  every engine.
- Knowledge starts with one file per repository and a run recipe that says how to install, test,
  build and start each one. It grows when a card reaches Wrap-up, with one git commit per change.
  Learn this project, which only you start, writes a few notes from the project's own docs and your
  answers, and holds them for your review. `/knowledge` shows the history with diffs, Revert and
  Optimize.
- A Delivery card on Pull request reads the review comments on its pull requests when you press
  "Read comments", triages them, drafts replies for you to copy and fixes one comment at a time
  without committing. Nolzu posts nothing to GitHub. [Answering review comments](docs/review-comments.md)
  has the steps.
- Add card reads a GitHub issue or pull request link through `gh`. Jira can be the project's ticket
  system, read only, with its token in your OS keychain. Every other card is a local ticket, such
  as `APP-12`.

The guides are on the website: [Quickstart](https://nolzu.com/docs/quickstart),
[Prerequisites](https://nolzu.com/docs/prerequisites), [Concepts](https://nolzu.com/docs/concepts),
[Boards](https://nolzu.com/docs/boards), [Knowledge](https://nolzu.com/docs/knowledge),
[MCP servers](https://nolzu.com/docs/mcp), [Skills](https://nolzu.com/docs/skills),
[The wall](https://nolzu.com/docs/wall), [The command](https://nolzu.com/docs/cli),
[Compatibility](https://nolzu.com/docs/compatibility), [Security](https://nolzu.com/docs/security),
[Start from an idea](https://nolzu.com/docs/idea) and the [FAQ](https://nolzu.com/docs/faq).

## Plans

Nolzu is free: this client, with no account, as many projects as you make, all four boards, all
three engines and knowledge. Paid cloud plans, Solo and Team, come later and add cloud features.
Neither is on sale yet. The [pricing page](https://nolzu.com/pricing) has the details.

## How it runs

New project asks for one engine that runs every phase of a card on this machine. Where Nolzu's wall
starts (macOS, or Linux with bubblewrap), any of the three does. Where it cannot, Claude Code or Codex
is needed, because Cursor runs Implement only there. New project lists the agent
tools it found. With none that will do on your PATH, it shows how to install one, says why a tool
it found is not enough, and moves on by itself once one is there. Nolzu reads the PATH from your
login shell once at start, so an engine your shell profile adds is found, and a tool installed into
a folder that PATH did not hold is found after a restart of Nolzu. It spawns the engine's own CLI
and uses the login you already have. It never reads or stores an engine's credentials.

Every run starts inside one operating-system wall: `sandbox-exec` on macOS, bubblewrap on Linux. A
read-only phase writes only its card folder, the wrap-up, Optimize and Learn this project also the
knowledge folder, and no run reads `~/.ssh`, `~/.aws`, `~/.gnupg`, `.env` files or the other
engines' logins. [SECURITY.md](SECURITY.md) lists what the wall holds and what stays out of its
reach.

Once the server listens, Nolzu prints the version, the agent tools it found on your PATH, the data
folder and the address, then opens a browser. `npx nolzu@latest --no-open` skips the browser, for
example over SSH. It listens on `127.0.0.1` only, so nothing else on your network can reach it. That is on
purpose, because it runs agents in your checkout. It refuses a request addressed to another name or
another port, so over SSH forward the same port number. It takes the first free port from 4319 to
4328, so a bookmarked address keeps working. Set `NOLZU_PORT` to pick a port yourself.

`npx nolzu@latest --version`, or `-v`, prints the version and starts nothing. A release prints
`nolzu 0.1.0`. A build from any other commit adds the commit, as in `nolzu 0.1.0-dev · 3f2a9c1`,
the same line the app shows beside the logo.

One Nolzu runs on a data folder. Start it again, from any folder, and it prints
`Nolzu is already running at` the address, opens that address and exits. When the running one is
another version, as after an update, it says so: stop it and start again. It finds the running one
through `running.json` in the data folder, which holds its process id, port and version, and checks
that the server on that port serves the same data folder. A file left by a crash is ignored and
replaced. A Nolzu that is still starting is opened once it answers. One that holds the data folder
and does not answer stops the new start a few seconds later, with one sentence that names its
process. A second copy needs its own `NOLZU_DATA_DIR`. It keeps its own Jira token
and MCP secrets in the keychain.

## Your responsibility

Nolzu starts AI coding agents on your machine, as your user. They can change and delete files, run
commands and push code, and each run uses your own agent plan or API key. You decide what runs, and
you check the result before you commit, push or merge it. Nolzu comes as is, with no warranty, and as
far as the law allows, the people who make it are not liable for damage or loss from using it. On
first start Nolzu shows these terms at `/accept` and asks you to accept them before any agent run
starts. Until you do, every other page leads there, the API refuses every call but its health
check, and the run loop and its timers do not start. When a new version changes the terms, Nolzu
asks again.

## The first run

The first time, after you accept the terms, you land on New project at `/new`. Type a project
name. The folder is the project's own, `~/<name>` until you type another or pick where it goes with
Browse. Then add the repositories, by a git URL or from the ones found one level down in `~/code`,
`~/projects` and `~/src`. The first Add makes the workspace in that folder: Nolzu makes it if it is not there, uses it if it is empty,
and refuses a file or a folder with anything in it. Each repository clones in the background
with its progress and a Stop. "Make the project" needs at least one repository, and then a second
screen asks for one small task, which becomes the first card. Making it runs nothing. On the board a
note on Refine explains once that dropping the card there is your approval, and the rail shows
"Getting started" until you have made a card, dragged it, read what changed and pushed a branch. A
new project starts with Research and PR reviews off. The side column of New project shows the agent
tools on this machine and whether `gh` is signed in. Pull
requests need `gh` and a GitHub remote, and a repository on another host still clones and pushes.
With `gh` signed out, run `gh auth login` in a terminal, and the page moves on by itself. A
repository found with no remote offers "Put on GitHub": Nolzu makes a private repository of your
`gh` account from a copy of it, pushes the branch you are on and clones that into the workspace.
Your own folder gets no remote and does not change, and branches never pushed stay only there.

With no code yet, "Start from an idea" on New project asks for the idea in your own words. Nolzu
makes a private repository with your `gh` login, with a first commit, clones it into a new
workspace, and puts the idea on the Epics board as the first card. Then the Epics board opens.

How QA starts each repository's app is asked when its first card enters QA, and lives in Settings,
Project at `/settings/project` under "Start the app". One of the four ways is your own commands: a
Start, and an optional Stop and Status, for example `docker compose up -d`. Nolzu puts the card key
where `{key}` is and runs them with no wall, so Docker works, in the card's copy of the repository.
They also get `PORT` (a free port), `NOLZU_CARD_KEY`, `NOLZU_PROJECT` (the project folder) and
`NOLZU_REPOS` (the card's repository paths, one per line, `.` first when the root is one; a
workspace never lists `.`). An answer for every repository runs once per card, in the card's
checkout root. When a Start that exits prints lines like `web http://localhost:8080` as its last
output, those addresses go to QA. [`docs/stack-hook/`](docs/stack-hook/README.md) has a working
example for a project of two repositories, as a plain folder or as a workspace.

## Where your data goes

Everything lives in `~/.nolzu`, with a SQLite database inside it. Set `NOLZU_DATA_DIR` to put it
somewhere else.

`NOLZU_FAKE_AGENT=1` swaps in a fake engine for demos and tests, and moves the data to
`~/.nolzu-fake` so a demo never touches your real database. It works with the development server
only. Do not set it for real use.

## Projects and repositories

New project makes every project as a workspace. Nolzu makes a new folder, starts a git repository
in it for the Nolzu files and the knowledge folder, and clones each repository you add into it. The
workspace's own repository is never changed by a card. Cards work only in the clones.

Projects made before New project keep working in their own shape: one repository, where the project
folder is the repository, or a folder that holds repositories as submodules or as ignored folders
one level down, which can be a repository itself.

Settings, Project at `/settings/project` changes the project later, and the old `/projects` address
leads there. The project's location is read only, with a button that opens it in your file manager.
"Add a repository" clones a URL into the project folder. "Remove" runs its checks first: a card's
checkout of the repository, a run that can use it, work that is not committed, a stash, commits on
no remote, and files git ignores, such as a `.env` (caches tools make again do not count). It stays
off while one of them is found. Then it lists what goes and what stays, and
deletes the repository's folder from disk once you type its folder name. Its knowledge file stays.
"Remove the checkouts of closed cards" clears
those checkouts first, and a closed card's ticket page has "Remove its checkouts" for one card. A
checkout with work that is not committed or not pushed, or with files git ignores such as a `.env`,
stays, and the branch always stays.
"Write the project files" writes the run guard, the agent rules and the phase skills into a project
made before New project wrote them, and keeps a file you changed.

A workspace lists its repositories in `.nolzu/repositories.json`, with each one's folder, URL and
base branch, and ignores each clone in its `.gitignore`. When the list names a repository the folder
has not got, its row in Settings, Project says Missing and has its own Clone. New project has no way
yet to open a workspace someone shared.

A project of one repository becomes a workspace with "Make this a workspace" in Settings, Project.
You name a new workspace folder on the same disk, and Nolzu moves the repository into it. Old
engine sessions cannot be resumed after the move. Your own commands under Start the app are free
text, so check their paths yourself afterwards.

## The phase skills

Each phase follows a skill, a Markdown file with its method, in `packages/skills/skills/`. Every run
of a phase, on every engine, reads the method from `<card folder>/<phase>/instructions.md`, which
Nolzu writes at the start of the run from the installed Nolzu, with the files the skill links to
copied in. So after you update Nolzu, the next run of each phase follows the new method, with nothing to
write or commit first.

New project also copies the skills into the project folder, for your own engine sessions: into
`.agents/skills/` for Codex and Cursor, and `.claude/skills/` for Claude Code. Each folder holds the
same copy. That copy does not change after an update until you
press "Write the project files" in Settings, Project, or Update on the line Nolzu shows above the
boards when it has newer files, which updates every file Nolzu wrote there and keeps a file you
changed. Each folder's record names the Nolzu that wrote it, and a Nolzu older than that writes none
of the project files. A skill file you changed there is also the method Nolzu's runs follow, on
every engine, in place of the shipped one, and the instructions file then names the folder under its
first line. When the folders disagree, the first one with a change wins, `.agents` before
`.claude`.

### Using a skill without Nolzu

In your own Claude Code session in the project folder, `/nolzu-<phase>`, such as `/nolzu-refine`,
starts that phase's skill from `.claude/skills`. Codex and Cursor find the same skill in
their own folder. The skill works the same, but Nolzu's prompt is not there, so give by hand what the
prompt adds:

- the card folder the phase writes to, such as `.tasks/APP-12/`
- the files of earlier phases this phase reads first, which `READ_FIRST` in
  `packages/runner/src/prompt.ts` lists per phase
- the questions asked on the card, with your answers
- the knowledge files that matter for the work, from the project's knowledge folder
  (`.nolzu/knowledge` unless the project names another one)

Nolzu keeps no record of such a run: no log, no cost, and no move on the board.

## Run from source

To build Nolzu yourself, for example to work on it, you also need pnpm through corepack. The
repository pins its pnpm version in `package.json`, and `corepack pnpm` runs that version. If your
Node has no `corepack` command, install it with `npm install --global corepack`. The exact Node
version is in `.nvmrc`, so `nvm use` picks it up. From the repository root:

```bash
corepack pnpm install
corepack pnpm build
node apps/local/bin/nolzu.js
```

The build is not optional. Without it the last command stops with
`Nolzu is not built yet. Run corepack pnpm build first.` The
last command takes the same commands and flags as `npx nolzu@latest`. `corepack pnpm dev` starts the
development server, which reloads on a change.

## What is not ready

- Linux, WSL 2 included, is not tested. Nolzu starts there with a warning.
- Read comments has not been checked against a real pull request yet.
- Scout, Evidence and the timesheet are built and wait for a later version. The app does not show
  them until then.
- The paid cloud plans, with the phone view and team boards, are not open.
- The app has no icons yet.

## Report a bug

Open an issue at [github.com/nolzu/nolzu/issues](https://github.com/nolzu/nolzu/issues). The form
asks for:

- what `npx nolzu@latest --version` prints
- your operating system
- the engine and its version, when a run was involved
- the end of the run log: the card's Log tab shows it, and the file is in `logs/` of the data folder
  (`~/.nolzu/logs/`, or under `NOLZU_DATA_DIR`)

Leave tokens, client names and private paths out of what you paste. A security problem goes by email,
as [SECURITY.md](SECURITY.md) says.

## Remove Nolzu

1. If you turned on "Start Nolzu when I log in" in Settings, Runs, turn it off there first, or
   delete the login item by hand: `~/Library/LaunchAgents/com.nolzu.client.plist` on macOS, and on
   Linux `~/.config/systemd/user/nolzu.service` with its link in
   `~/.config/systemd/user/default.target.wants/`.
2. Stop Nolzu: Ctrl+C in the terminal it runs in. One the login item started has no terminal, so
   stop the process whose id `running.json` in the data folder names, for example with
   `kill <id>`.
3. Delete the data folder, `~/.nolzu`, or the folder `NOLZU_DATA_DIR` names. It holds the database,
   the run logs and the caches.
4. Delete the keychain entries. Every entry has the service name `nolzu`: the Jira token
   (`jira-token-…`) and the MCP server secrets (`mcp-…`). On macOS open Keychain Access and search
   for `nolzu`, or run `security delete-generic-password -s nolzu` until it finds none. On Linux run
   `secret-tool clear service nolzu`.
5. In your projects, Nolzu wrote `.nolzu/` (the MCP list, knowledge and phase instructions),
   `.tasks/` with the card folders, `worktrees/` with the card checkouts, `AGENTS.md` and
   `CLAUDE.md`, the run guard in `.claude/hooks/` with its entry in `.claude/settings.json`, and its
   skills in `.agents/skills` and `.claude/skills`. It also added the lines
   `/worktrees/` and `/.tasks/` to the workspace's `.gitignore` and to each repository's
   `.git/info/exclude`. After you delete `worktrees/`, run `git worktree prune` in each repository.
   The card branches stay in the repositories until you delete them. A project made by New project
   is a folder of its own, so you can delete it whole once nothing in it is yours.
6. A global install goes with `npm uninstall -g nolzu`. `npx` keeps its copy under `~/.npm/_npx`;
   delete that folder or leave it.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) has the setup, the checks, the sign-off and the writing rules for
a pull request. Report a security problem by email and not in an issue, as [SECURITY.md](SECURITY.md)
says.
[CHANGELOG.md](CHANGELOG.md) lists what changed.

## License

FSL-1.1-ALv2, see [LICENSE](LICENSE). The Geist and Geist Mono font files in `packages/ui` are
under the SIL Open Font License 1.1, see [OFL.txt](packages/ui/src/fonts/OFL.txt). The npm package
bundles third-party code, and `dist/THIRD-PARTY-NOTICES.md` in it holds each package's license.
