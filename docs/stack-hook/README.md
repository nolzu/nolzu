# Own commands for a project of several repositories

Your own commands under Start the app are three commands that start, stop and report the app of one
card: Start, and an optional Stop and Status. This folder holds a small working example for the
recipe demo split into two repositories, `api` and `web`, set once for every repository. Read it to
see what the commands get from Nolzu and what they should print back.

## What the commands get

Nolzu puts the card key where the command says `{key}` and runs the line through a shell, with no
wall, so Docker works. QA runs Start before the run and Stop after it, and the App line on the card
page runs them from its Start, Stop and Force buttons and shows what Status prints. An answer for
every repository runs once per card in the card's checkout root, `<project>/worktrees/<key>`, and
`PWD` is set to that folder. An answer for one repository runs in the card's copy of it instead.
Start also gets `PORT`, a free port. All three get three environment variables, and none gets
Nolzu's own address or a GitHub or npm token from Nolzu's environment:

| Variable | What it holds | Example |
|---|---|---|
| `NOLZU_CARD_KEY` | The card key | `APP-1` |
| `NOLZU_PROJECT` | The project folder, where the base checkouts or the workspace's clones live | `/home/dev/recipes` |
| `NOLZU_REPOS` | The card's repositories, one per line, `.` first when the root is one | `api` |

What those hold depends on the project's shape. The four shapes are in
[the README](../../README.md#projects-and-repositories). In one repository, `NOLZU_REPOS` is `.`
and `worktrees/<key>` is a checkout of that repository. In a folder of repositories,
`worktrees/<key>` holds one checkout per listed repository, and is itself a checkout of the root
when the root is a repository. An idea starts as an empty workspace, so it follows the workspace
rules below.

In a workspace, `.` is never in `NOLZU_REPOS`, because cards never change the workspace's own
repository. So `worktrees/<key>` is a plain folder there, with one checkout per listed repository,
and the clones are at `$NOLZU_PROJECT/<repo>`.

A repository the card lists has its own checkout at `$PWD/<repo>`, on the card's branch. A
repository the card does not list has no checkout. The script takes it from
`$NOLZU_PROJECT/<repo>` instead, so the stack still runs whole. An empty `NOLZU_REPOS` means
refine and plan have not picked the repositories yet. In a workspace with no repository yet it
stays empty, and only refine and plan can run.

`stack.sh` follows that rule for `api` and `web`, and mounts each folder into its container
through `compose.yaml`. It names the compose project `nolzu-<key>` in lower case, because compose
refuses capitals. It exits 1 with a sentence when Docker is not running.

## What Start prints

After a Start that exits 0, Nolzu reads every stdout line of the form `<name> <url>`, for example
`web http://localhost:8080`, and writes those lines to `qa/addresses.md` in the card folder. QA
checks the card against those addresses. Every other line goes into the run's log and into
`qa/app-start.md`, which QA reads before its first check. So a Start can warn there, for example
that a container still runs other code than the card's, and QA then answers BLOCKED for what needs
that container instead of failing the card. A Start that keeps running instead counts as up once its `PORT` answers, never on an address it
prints, and Nolzu stops it after QA, before it runs Stop.

Nolzu keeps only the last 16000 characters of the output. So Start prints the addresses last.

A Start that exits with another code, or does not finish in fifteen minutes, fails the QA run with
its last line. Everything it printed goes into the run's log, and Nolzu runs Stop after it, so a
load that got halfway is undone. Write Stop so it is safe on a stack that is half loaded.
`stack.sh` sends the compose progress to stderr and then prints its two lines:

```
api http://localhost:8787/recipes
web http://localhost:8080
```

The ports are fixed, so one card at a time can have the example loaded.

## Set up the example

You need Docker and git. From the Nolzu folder, make a copy of the demo in one of two layouts:

```
NOLZU_FAKE_AGENT=1 HOME=<empty folder> node apps/local/scripts/demo-setup.ts --workspace <folder>
NOLZU_FAKE_AGENT=1 HOME=<empty folder> node apps/local/scripts/demo-setup.ts --split <folder>
```

With `--workspace`, Nolzu makes `<folder>` as a new workspace and adds `api` and `web` to it by URL,
the way "Add a repository" does. The clones come from local copies the script makes, because the
app clones only over https and ssh. The Changes tab shows two groups.

With `--split`, the project is a plain folder that holds the `api` and `web` repositories, with
one commit each. Until every engine is measured in such a folder, it runs on Claude Code only. A
workspace is a git repository, so this limit does not apply there. Add `--root-repo` to make the
project folder a repository too, with a `.gitignore` that lists `api/` and `web/`. Then the Changes
tab shows three groups instead of two.

Leave out `NOLZU_FAKE_AGENT=1` and set `NOLZU_DATA_DIR` to an empty folder to run on a real engine.
Keep the real `HOME`, because the engine keeps its sign-in there.

The script prints the three commands with the full path to `stack.sh` filled in. They run in the
card's checkout, where there is no copy of this folder, so a relative path does not work. At
`/settings/project`, under Start the app, Edit the row "Every repository", pick "Start it with my
own commands" and set:

```
Start:  sh '<path>/docs/stack-hook/stack.sh' load {key}
Stop:   sh '<path>/docs/stack-hook/stack.sh' unload {key}
Status: sh '<path>/docs/stack-hook/stack.sh' status {key}
```

A project of one repository has no such row: set the same commands on its own row.

Your own commands run with no wall, and an agent run can still change them through Nolzu's local
server, which has no token yet. Read them at `/settings/project` before you start a QA run or press
Start on the App line. [SECURITY.md](../../SECURITY.md) says more.

With `--split`, press "Write the project files" at `/settings/project` so refine and plan get their run
guard. A workspace has its run guard already, because making it wrote the project files and committed them.
