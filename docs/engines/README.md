# Engine notes

One file per engine, named after the engine id, which is the name in `EngineName` in
`packages/protocol/src/engine.ts`: `claude-code.md`, `cursor.md`, `codex.md`.
Antigravity has no file, because it is not an engine: Google's terms do not allow third-party apps
on its consumer plans.
That is not the engine profile id. A profile is one login of one engine, its id is made from the
label the person typed, and the action table and `runs.engine` store that. One engine file covers
every profile of that engine.

Each engine's limit signal is written down here, and the rest of the engine contract belongs next
to it.

A file here records what the installed binary does, not what its documentation claims. Where the
two disagree, the file says so and the file wins. Every measured claim names the version it was
measured against, and the file says when it was last checked, because these CLIs change their
flags between minor releases. Check a file again when the engine's major version changes, and say
in the file when a claim was not run.

Each engine file answers the same eleven questions, in whatever order reads best.

1. Which binary Nolzu spawns, how it is found on the PATH, and what happens when it is missing.
2. The flags for the model and the effort, and whether the effort is separate or part of the
   model id.
3. What the process prints, and which line carries the session id, the result, the cost and a
   refused tool. This is what `parse(line)` turns into run events.
4. How a run is resumed: where the session id comes from, and which flag continues an earlier
   session rather than starting one.
5. The read-only mode, and whether it refuses a write. An engine that cannot refuse one gets no
   read-only phase, so this answer decides which read-only runs may use it: refine, plan, the
   phases of the other four boards, the two passes and the Scout assessment.
6. How the phase instructions reach it. Every engine gets them as a file in the card folder, so
   check that its read tool can open that folder in a read-only phase.
7. Where the model list comes from, a command or a list kept by hand, and whether it works
   offline and with a dead login.
8. How a second login is set up. For most engines that is an environment variable pointing at a
   config folder, which Nolzu sets and never opens.
9. Which variables outrank the flags and are dropped from the run's environment, so a value left
   in the person's shell cannot quietly change the model or the effort the card shows.
10. The limit signal: what the CLI reports about a usage window in its own output or from its own
    command, and the exact text a run produces when it hits a limit. Nolzu reads only what the
    unmodified binary prints or answers. It never calls a vendor usage endpoint, never reads a
    credential file and never reuses a session cookie.
11. What the isolation flags do not remove, so a person whose own hooks stayed quiet can be told
    why.

`claude-code.md` was written before this list and does not answer question 8 yet. Nobody has set
up a second Claude Code login and measured it, so the answer is written down when somebody has run
one, not before.

## The phase method

Every engine reads the method of a phase from one file, `<card folder>/<phase>/instructions.md`.
The runner writes it at the start of every run from the phase's skill in the installed Nolzu
(`phaseInstructions` in `packages/skills/src/instructions.ts`), and copies the files the skill links
to, such as `finish.md`, in at the end. The first line of the prompt names the file. So a Nolzu
update changes the method from the next run, on every engine, with nothing to commit.

Nolzu copies the skills into two folders of the project, because each engine reads its own:
`.agents/skills/` (the open Agent Skills folder, read by Codex and Cursor) and `.claude/skills/`
(Claude Code, and Cursor too). Each holds the same copy with its own `.nolzu-skills.json`. A folder
that is a link, or sits under one, is refused alone, and the other still gets its copy. The record also names the Nolzu version that wrote it, under `version`. A
Nolzu older than that writes none of the project files, in any folder, and says to update Nolzu, so it
never puts back a file a newer one replaced. A record without the key is from before it and is written over.
Keep mine in Settings, Project adds the file under `kept` with a hash of the text Nolzu shipped when you
kept it, so a sync stops counting your edit until Nolzu ships another text. The first folder's record
also keeps a project file outside the skills this way, such as `AGENTS.md` with a broken marker.

A skill file a person changed in one of those folders wins over the shipped one, on every engine,
taken from the first folder with a change, `.agents` before `.claude`. A file there
that is neither what Nolzu ships nor what the last sync recorded in `.nolzu-skills.json` is the
person's. Nolzu reads it from the project folder, never from the card's checkout, and the
instructions file then names the folder under its first line. The sync still runs, for people's own
engine sessions, and keeps such a file.

A test keeps the full text of every shipped phase, the skill with its linked files, under 17,000
characters. Claude Code has been seen cutting a long skill at 20,000 characters, and the rules past
the cut were lost. A skill the person changed is not held to that limit.

## A project's own phase instructions

A project can add its own instructions to any phase, such as "plan.md must also have a Risks
section". Each phase has one Markdown file in the project folder, `.nolzu/phases/<phase>.md`, for
example `.nolzu/phases/plan.md`. It is part of the project repository, so commit it to share it.
Settings, Phase instructions edits these files, and an empty Save deletes one.

Nolzu adds the file's text to the run's prompt under "Project instructions for <phase>", so it works
the same on all three engines and the shipped skills stay the same for every project. It reads the
file from the project folder at the start of every run, never from the card's checkout, so an edit
counts from the next run. It reads the first 16 KB and tells the run when the rest was cut. The
instructions may change how a run works, the language of the text, and what goes into its
documents, with extra sections under their own `##` headings. The last line of the block tells the
run what stays as the skill writes it: the names and places of the files, the headings and field
names, the ids, the review block and the verdict line.

The file also works when someone runs an engine without Nolzu. Each shipped skill says near its top
to read `.nolzu/phases/<phase>.md` in the project folder when it is there and follow it too, with the
file winning where the two differ, except on the file names, headings, fields and ids. A Nolzu run
has the text in its prompt already, so the skill tells it there is no need to open the file. Ask has
no skill, so its file works in Nolzu only.

Plan also reads the files for Implement and QA, when they exist, and changes nothing in them. It
turns each rule it can check into a plan step or a QA check and names the file the rule came from,
so a rule such as "every change gets a changelog line" is planned and checked.

Nolzu reads some lines of what a run writes. The Overview draws the review block at the top of a
phase's main file (`## Before you approve`, and `## 1. Verdict` in the QA report), and an open
question marked `blocks: yes` holds the next move that starts a phase until the person takes its
default or answers it. Nolzu reads the acceptance checks of a brief (`AC` and a number, then
`(must)` or `(should)`), the `D` lines of an architecture and a plan, and the `Files:`, `Tests:`,
`Undo:` and `Covers:` fields of a plan step. In a project with several repositories it reads the
`Repositories:` line of a refine or a plan. It counts an Implement step as done by the number that
starts its line in `implement/progress.md`. From QA it reads the `pass`, `fail` and `not reached`
results with their `How:`, `Evidence:`, `Reason:`, `Expected:` and `Actual:` lines, and the verdict
line QA prints. The prompt tells the run to keep all of these in English, as the skill writes them,
whatever language an instruction asks for.

When a run ends, the output check reads the files the phase wrote against what its skill promises:
the headings, the ids, the review block and the size of the main file. It stores each problem as a
warning on the run, and the card still moves. When the phase had project instructions, the warning
names their file, because they are the first place to look.

## Walls

Nolzu runs on macOS. Linux, and WSL 2 (the Windows Subsystem for Linux) which counts as Linux, is
not tested yet: Nolzu starts there with a warning, and the measurements below have run on macOS
only. Native Windows and WSL 1 are not supported: Nolzu stops at start there.

Every run, on every engine, is held by one operating-system wall around the whole engine process:
`sandbox-exec` with a Seatbelt profile on macOS, `bwrap` (bubblewrap) on Linux. Never two walls
inside each other, because a macOS sandbox cannot start inside another one. A read-only phase may
write its card folder, the engine's session folders and the temp folder, and the wrap-up, Optimize,
Learn this project and Learn your repositories may also write the knowledge folder. The project stays read-only. Implement
may also write the checkout and its git folder. Every run, Implement included, is denied reads of
`~/.ssh`, `~/.aws`, `~/.gnupg`, the project's `.env` files and the logins of the other engines,
and of the other login files, shell history and browser profiles that
[SECURITY.md](../../SECURITY.md) lists, under both the run's HOME and the account's home from the
system's user record (Claude Code's Read resolves `~` from the latter). No run can connect to a Docker or Podman socket. The
running engine keeps its own login. The engines' config and hook files stay read-only, so a run
cannot plant a hook for a later run there. Nolzu's own local server has no token yet, so a run can
still call it and change your own commands under Start the app, which run with no wall; [SECURITY.md](../../SECURITY.md)
names that gap and what to do until it is fixed. An Implement run cannot rename or rewrite the git pointers of
the checkout or of a repository one folder down in it (the folder, its `.git`, the git folder and
its `commondir`), so it cannot point Nolzu's next git call at a config of its own. After the run
Nolzu compares those pointers with the state before, and fails the card on any change. The network
stays open. A wall the check found ready that still fails to start stops the run, and Nolzu never falls back to a bare run there. The first line of the
run log says which wall holds the run and lists the folders it may write. Only the engine's session
folders and files are opened, never its whole state folder: in a Seatbelt profile the last matching
rule wins, so an open state folder left every name the row did not close writable, and bubblewrap
cannot hold a path that is not there yet. On macOS the Codex row still opens its
whole state folder until its session files are known. Some session files still start something
later outside the wall: the MCP servers and hooks in `~/.claude.json`, and the permissions in Cursor's
`cli-config.json`. Nolzu compares them with the state before
every run, once every tool the run left behind is gone, and stops the card on a change. A writable
folder that holds a read-only engine path keeps its name, so a run cannot swap in a folder of its own. A hook file that an Implement run creates in the checkout there is named in the
run log after the run. A hook manager's files in the checkout, such as `.husky` or `lefthook.yml`,
stay writable, so Nolzu runs git with the repository's hooks off: its commit and push of the card's
work skip them unless the person ticks Run hooks for that press, and a pull, the knowledge commit
and every checkout always skip them. The paths per engine live in one table in
`packages/runner/src/engine-walls.ts`, so a correction is a change to one row.

Where the wall cannot start (Linux with no bubblewrap, or with user namespaces blocked), Claude Code
still runs every phase, held by its guard hook, and the run log says the secret files are not
hidden. Codex runs under its own sandbox, as it did before the wall. Cursor runs
Implement only, and a read-only phase is refused with the check that failed. Settings, Engines says
per engine which phases this machine runs and why. To get the wall, install bubblewrap, for example
with `sudo apt install bubblewrap` or `sudo dnf install bubblewrap`. If bubblewrap is installed and
still cannot start, the system blocks user namespaces (the kernel feature bubblewrap builds its wall
from). On Ubuntu, allow them with `sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0`. On
Debian, use `sudo sysctl kernel.unprivileged_userns_clone=1`. A `sysctl` setting lasts until the
next restart; put the same line in a file under `/etc/sysctl.d/` to keep it. Restart Nolzu after
either change, because it checks the wall once at start.

New project asks for one engine that runs every phase on this machine. Where the wall starts, any
of the three does. Where it cannot, Claude Code or Codex is needed.

Settings, Wall shows these fixed rules in groups, each one line with its paths folded inside, built
from the same rows as the wall. Settings, Project, Walls holds the three lists a project
can add to them. More paths to hide applies to every run, Implement included, and takes any path:
`~/secrets`, an absolute path, or a path read from the project folder. Secret exceptions names
`.env` files of the project that runs may read, such as a `.env.test` the tests need, by their path
from the project folder; never a path in the home folder or outside the project. More writable
folders opens a cache folder such as `~/.gradle` or `~/.cargo` to Implement and QA, which writes it
from its copy, and never to a phase that only reads. The screen refuses, with the reason under the
field, an exception outside the project, a writable folder that is or holds the project, its git
folder, the home folder, Nolzu's own data folder, a secret path or an engine's config or hook file, and a hidden path that
would cover the card folder, the knowledge folder, the temp folder or an engine's session folders.
Each path is compared after its links are resolved. The runner checks every entry again when a run
starts and leaves a bad one out with a line in the run log, so a hand-edited database cannot loosen
the wall. The fixed rules come after the lists in the wall, so they still win. Where the wall
cannot start, the lists do not apply.

QA runs the project's own checks, and a check writes caches, so QA works on a throwaway copy of the
card's checkout, on every engine. The copy holds the working tree as it is, uncommitted work and
`node_modules` included: an APFS clone on macOS (`cp -c -R`), a reflink copy on Linux
(`cp --reflink=always -R`), and a plain `cp -R` where the disk refuses a clone. It sits in a Nolzu
folder on the checkout's volume, never in the project. Inside the wall the copy and the card folder
are writable, the real checkout is read-only, and the `.env` files of both are hidden. The run log
says how the copy was made and how long it took. The copy is deleted after the run, also when the
run fails or is stopped, and Nolzu deletes any copy a crash left when it starts.

After every read-only run Nolzu compares `HEAD`, the refs and `git status` with the state before the
run. This is the last check behind the wall. In a checkout Nolzu made for the card it puts back what
changed and says so in the run log. In your own project folder it changes nothing: the card's
Overview shows a warning with the diff.

Some things stay out of the wall's reach on every engine. The network is open, so a run can still
have a side effect elsewhere: a `curl -X POST`, a `gh pr create`, or an MCP tool that writes to a
ticket system. The prompt rules and the phase's tool list are what limit these. A run can write
anything inside the folders it may write, so a bad card folder is possible, and the git compare
does not see it. "Do not fix the code" in QA and "stay in the method" in every phase are prompt
rules, not walls.

Codex runs inside the same wall with its own sandbox off, because its sandbox modes still read
`~/.ssh` and `.env`, and one sandbox cannot start inside another. The Codex row's `ownSandbox`
switch moves it back to its own sandbox if a Codex permission profile turns out to deny those reads.
Where the wall cannot start, Codex falls back to its own sandbox on its own.

### Measuring the wall on your machine

The rows in `engine-walls.ts` come from the vendors' docs until someone measures them.
`scripts/measure-walls.mjs` does that with your own logins. From the repository root:

```sh
node scripts/measure-walls.mjs
```

It finds `claude`, `codex` and `cursor-agent` on your PATH and asks before it runs each one.
`--engines claude,codex` picks some of them, and `--yes` skips the question. Each engine gets one
small run in a fresh temp project, built with the same arguments and the same wall Nolzu uses for
a read-only phase. The prompt asks it to read `README.md`, write a note in the card folder, and
then try to change `README.md` and to show `.env` and `~/.ssh/known_hosts`. The report says yes or
no for each: the engine started and was logged in, the note was written, `README.md` did not
change, and neither secret showed up in the output. It also lists the state and config folders the
engine touched. For Codex it tries a permission profile through `-c default_permissions` with its
own sandbox.

It also reports whether the wall can start here, whether bubblewrap is installed and user
namespaces are allowed on Linux, and, inside WSL 2, whether `secret-tool` can store and read back a
throwaway entry. `--clone-repo <path>` times the copies QA would make of that repository: an APFS
clone on macOS, a reflink and a plain copy on Linux, and a detached `git worktree` everywhere. It
starts the browser the QA checks use (Google Chrome, or `--chromium <path>`) inside the same wall,
once with its own sandbox and once with `--no-sandbox`, and says whether it loaded a page.

Each run costs a little on your account. The script writes a JSON report and a text summary into
the current folder (`--out` changes that) and prints both paths. It never prints a secret: it only
says whether a marker it planted, or a piece of your `known_hosts`, showed up. Its temp folder sits
in your home folder, because the macOS wall leaves the system temp folders writable, and it is
deleted at the end. Run `node scripts/measure-walls.mjs --help` for every option.
