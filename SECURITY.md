# Security

Report a security problem by email to security@nolzu.com. Do not open a public issue for it,
because everyone can read an issue before a fix exists.

## What to send

- What the problem is, and what someone could do with it.
- The steps that show it, or a small proof.
- The commit you tested, your operating system and your Node version.
- The engine and its version, when the problem needs an agent run.

## What you get back

A person reads every report and answers you. You get a first answer within 7 days. The answer
says whether the problem could be reproduced and what happens next, and it may ask you for more
detail. Please keep the problem private until a fix is out. Once the fix is merged,
[CHANGELOG.md](CHANGELOG.md) says what changed.

There is no bug bounty, so a report is not paid.

## What is in scope

Everything in this repository:

- the client in `apps/local`, which is the launcher, the local server and the pages it serves
- the packages in `packages/`: `core`, `runner`, `ui`, `protocol` and `skills`
- the skills in `packages/skills/skills/`, which the setup copies into a project's
  `.agents/skills` and `.claude/skills` folders

These are the promises the client makes, so a way around one of them is a security problem. The
local server answers on `127.0.0.1` only, it refuses a write request that another website
sends, it answers another website's background request (an image, a script, a frame) with
nothing, a page a person opens from another website's link runs none of their commands and
changes nothing, and no other website may show its pages in a frame. One exception: a style, an
image or a font under a card's files address (`/api/card/<key>/files/...`) is served to any page,
because the Files tab shows a design screen in an empty sandbox, which the browser treats as
another website. It reads that one card file and runs nothing, but a page that knows the card key
and the path can use the file as its own stylesheet or picture. Markdown shows images only
from the hosts where GitHub keeps uploaded images and repository files, never through its image
proxy, so a comment cannot learn when you read it. Secrets go to the OS keychain and never
into the database or a log, and into a file only in the one case
[When a secret touches a file](#when-a-secret-touches-a-file) names. Disconnect on
Settings, Integrations removes the Jira token from the keychain. Jira is only read: a ticket when a
card is added, and whether a Jira project has the local key prefix as its key. A git remote
URL with a password or token in it is cleaned before it is shown, logged or stored. The paid
package is written to disk only after its signature and its hash check out. Reading the comments
on a card's pull requests, and reading a pull request you attach to a card, is a GraphQL query
through your `gh` and never a write to GitHub: Nolzu reads pull request comments and posts nothing,
no reply, no resolve and no review request. The comment text stays in the local database, out of
everything the hosted service receives, and the board card carries counts of the rows only, never their text. The PRs tab draws that text through the same sanitizer as
every other Markdown on the page, and Mark done, Reopen and the unread marks are local writes that
GitHub never sees. Run triage hands that text to the engine as a file in the card folder: Nolzu reads
GitHub itself, so the run needs no GitHub access. The run is read-only under the wall and the run guard, writes only its triage file
and summary there, and posts nothing: a drafted reply reaches GitHub only when the person pastes it.
The hosted service gets the triage run's cost and state, never its summary or question, which quote the comments.
Fix hands one discussion to the card's Implement session as the run's message. It is an Implement run
under the same wall and run guard as any other, so it may write the card's checkout. Those do not stop
a `git commit` (writes inside the git folders stay open, see below) or a push (the network is open), so
"do not commit, do not push, do not reply on GitHub" is a rule in the message and in the implement
skill, not a wall. For a fix, and for every other Implement run, commit and push are checked after the fact: right before the engine
starts, Nolzu reads HEAD and the commit of the upstream tracking ref in each checkout of the card
(read-only git, no fetch), and reads them again when the run ends, well, failed or stopped. A HEAD
that moved is a commit and an upstream ref that moved is a push, and either sets the row back to new
with a sentence that names the repository and both short commits, also written to the run log. Any
other Implement run, a resumed one too, ends as it would with the same sentence in its log and as a
warning on the card's Overview until the next Implement run starts; a fix gets the row and not the
warning. A checkout that cannot be read at either end gives its own reason, never a pass. Nolzu never resets or
reverts what the run did: what to keep is the person's call. A push is on GitHub by the time it is
seen, a push that leaves the tracking ref alone is not seen (a push from a branch with no upstream is
seen only through its commit), a commit the person makes in the checkout while the run goes reads as
the run's, and a reply on GitHub is not checked. Nolzu itself commits, pushes and posts nothing for a fix. The
hosted service gets a fix run's cost and state, never its summary or question: a fix that asks shows there as
a blocked card with no question, and the answer run it starts is a fix run too. Every leg of a fix,
the one that asked and the one the answer started, gets the commit and push check. Discuss starts a read-only Ask
session with the discussion as its first message.
Fix CI reads the log of each failed check of a card's pull request through your `gh`, as `gh api` GET
calls and never a write, and only for a GitHub Actions job of that pull request's own repository: a
commit status or another app's check gets no read. It keeps the end of each log in `ci/` in the card
folder and hands it to an Implement run under the same wall, run guard and commit and push check as a
fix, with no QA after. A log holds text anyone who can open a pull request may have written, so the
run's message and `ci/failed.md` tell the engine to read it as data, never as instructions. That is a
rule in the message, not a wall. The log text goes to the engine's vendor, as the code and the comments do.

Nolzu runs on macOS. Linux, WSL 2 included, is not tested yet: the bubblewrap wall below is built
and unit tested, but no real engine run has been checked inside it. Native Windows and WSL 1 are not
supported, and Nolzu stops at start there.

Every engine run is held by one operating-system wall around the engine process: `sandbox-exec`
on macOS, bubblewrap on Linux. These are the promises it makes:

- A read-only phase, such as refine or plan, writes only its card folder, the engine's session
  folders and the temp folder. The wrap-up, Optimize, Learn this project and Learn your
  repositories may also write the knowledge folder.
- Implement may also write the card's checkout and its git folder. For a checkout that is a git
  worktree, as a card's own checkout is, that means only the `objects`, `refs`, `logs`, `lfs` and
  `rr-cache` folders of the shared git folder, its packed refs and gc's own files, and the card's own
  folder under `worktrees`. The rest of the shared git folder, such as another card's folder there,
  the exclude file and Nolzu's own lock folders, stays read-only. So a run there can commit, amend,
  stash, branch, rebase, merge, reset, fetch, pack its refs, delete a packed branch and run `git gc`
  (measured in the macOS wall), and cannot run `git worktree add`. On Linux a folder or file of that
  list that is not there before the run, such as `rr-cache`, stays closed. That holds for the lock
  files too, which bubblewrap cannot open before git makes them, so on Linux a rewrite of
  `packed-refs` inside a run (deleting or renaming a packed branch or tag, `git pack-refs`, `git gc`)
  fails there. A checkout that is the project folder itself keeps its whole git folder writable. The
  rest of the disk stays read-only.
- git writes some files in those git folders by name, through a link: `COMMIT_EDITMSG`,
  `FETCH_HEAD`, `MERGE_MSG`, `ORIG_HEAD`, the reflogs under `logs`, `packed-refs` and `gc.log` among
  them. A link a run left there would have Nolzu's next commit, fetch or pull, outside the wall,
  write the file it points to. Nolzu checks for this in three ways. On macOS the wall refuses a new
  symbolic link and a new hard link in the writable git places (all but `objects` and `lfs`), and a
  link file renamed in. After every Implement run, under any wall, Nolzu looks in the card's own git
  folder, and in the shared git folder at each entry at its top that is not a folder, and in `refs`,
  `logs`, `rr-cache`, `rebase-merge`, `rebase-apply`, `sequencer` and `worktrees`. It fails the card
  with a sentence naming the path for a link, a file with a second name, or a named pipe. A socket,
  such as the one git's fsmonitor daemon keeps there, passes. And before each git command of its own
  that writes, in any folder, Nolzu looks the same way and refuses the command with that sentence.
  One table in the runner lists every git command Nolzu runs as a read, a write or a network
  command. A test fails when a git call in the code names a command the table does not list (it reads
  the argument lists written out in the code, not ones built at run time), and a command it does not
  list counts as a write. A command counts as a read only when each of its options is one the table
  names for a read, written out in full: git also takes a shortened option, such as `--unset-a` for
  `--unset-all`, and `--output` has `diff`, `log` and `show` write a file. For `config` only the
  options before the first word count, as git reads them: `git config a.b --get` stores `--get` as a
  value, so it counts as a write. So `add`, `rm`, `submodule`, and `config`, `remote`, `branch` and
  `symbolic-ref` when they change something, are checked as well as commit, fetch, pull, merge,
  push, reset, checkout, restore, update-ref and worktree. For `init`, `clone` and `worktree add`
  the check also walks the new folder's path from the folder Nolzu owns (the project when a card's
  checkout is made, else the folder git is started in, never a `-C` folder) down to it, and refuses a
  link at any step, also one that points nowhere yet. A link above that folder is your own setup and
  passes. Such a command is refused when the new folder, a separate git folder or a `-C` folder is
  written with a `..` part, because the system follows a link before it climbs back up. A new
  repository's folder that holds a repository already has its git folders checked. The clone that
  adds a repository to a workspace starts git apart from this check: Nolzu makes its folder itself
  right before, and a name that is there already is refused. The `objects`, `lfs`, `hooks` and
  `modules` folders are not looked in, and neither are the other folders of the shared git folder,
  such as `info`. So a named pipe a run leaves under `objects` is not found, and can make Nolzu's git
  commands in that repository hang. It writes nothing elsewhere. A link of your own at
  the top of the shared git folder, such as a linked `config` or `objects`, also stops Nolzu's git
  commands that write in that repository. A linked `hooks` folder passes. A read such as `status` is
  not checked, so git's own error for a linked `packed-refs` can show a line of the file it points
  to on the card, where only you see it.
- The environment Nolzu builds for its git calls (`gitEnv`) leaves out `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
  `GIT_SHALLOW_FILE`, `GIT_NAMESPACE`, `GIT_EXEC_PATH` and every variable whose name starts with
  `GIT_TRACE` from the environment Nolzu starts with. So a value git exported into a hook, or one
  captured from the login shell, cannot point Nolzu's git at another repository's folders or have it
  write a trace file. `GIT_CONFIG_GLOBAL`, `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `GIT_EDITOR`
  and `GIT_PAGER` stay: they come from your own environment, as your choice.
- These checks look before git writes, not while it writes. So there is a gap: a run that is live at
  the same time in the same repository, such as another card's run, or a process a run left behind,
  can swap a folder between Nolzu's check and git's write. The macOS wall refuses a new link but not
  a folder renamed into place with a link inside, and on Linux the wall has no rule for links. Such a
  swap can still have Nolzu's git write the file a link points to.
- QA works on a throwaway copy of the checkout, so the project's checks can write their caches
  there. The real checkout stays read-only, and the copy is deleted after the run.
- No run, Implement included, can read `~/.ssh`, `~/.aws`, `~/.gnupg`, the project's `.env` files
  or the logins of the engines that are not running, where `~` is both the run's HOME and the
  account's home folder the system records, because a tool can read `~` from either. The same holds
  for the other login files the wall knows: `~/.config/gcloud`, `~/.azure`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`,
  `~/.config/gh/hosts.yml`, `~/.git-credentials`, `~/.pypirc`, `~/.cargo/credentials.toml` and `~/.gemini`, where Google's agent CLIs keep their
  logins. It
  also hides the shell and REPL history (`~/.zsh_history`, `~/.bash_history`, `~/.zsh_sessions`,
  fish's `fish_history`, `~/.python_history`, `~/.node_repl_history`) and the browser profiles:
  Chrome, Chromium, Edge, Arc, Brave, Firefox and Safari under `~/Library` on macOS, and Chrome,
  Chromium, Edge, Brave and Firefox under `~/.config` and `~/.mozilla` on Linux. `~/.npmrc` stays
  readable on purpose, so a run can install private packages with your own npm login. The home
  folder stays read-only, `~/.npm` included. Implement, QA and the app QA starts get the npm, yarn
  and pnpm caches in Nolzu's data folder instead, at `<data folder>/caches`, which the wall opens to
  them.
- No run gets `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`,
  `NPM_TOKEN` or `NODE_AUTH_TOKEN` from the environment Nolzu starts with, on any engine, so it
  cannot push or publish with them. The app QA starts does not get them either. Nolzu's own `gh`
  calls run in Nolzu's process and keep them. A run that installs from a private registry needs the
  login in `~/.npmrc`: a token that only lives in your shell no longer reaches it.
- No run can connect to a Docker or Podman daemon through its usual socket, which would let it
  write anywhere in the home folder. On macOS the profile denies a connect to, and any write of,
  a unix socket whose name starts with `docker` or `podman` and ends in `.sock`, wherever it lives:
  `/var/run/docker.sock` and the sockets of Docker Desktop, OrbStack, Colima, Rancher Desktop, Lima
  and a Podman machine. It also hides `~/.docker/run` and `~/.orbstack/run`. On Linux
  `/var/run/docker.sock`, `/run/docker.sock`, `/run/podman/podman.sock`, the rootless Docker and
  Podman sockets and the session bus under `/run/user/<uid>`, and the X server's `/tmp/.X11-unix`
  are covered when they exist. A project whose tests need Docker cannot run them inside the wall.
- No run can write an engine's config or hook files, or the checkout's git hooks and git config, so
  a run cannot plant a command there that fires later outside the wall. A repository a run makes
  inside the checkout, at any depth, has a config the run wrote, so Nolzu's own git never runs in
  one: status and diff stop at its folder, even when the run writes a `.gitmodules` that asks git
  to look inside, and `add` leaves it out. git also refuses a folder that is a repository with no
  `.git` name (`HEAD`, `objects` and `refs` in the folder itself) unless Nolzu names it, with git
  2.38 or newer. A repository a run makes in the knowledge folder is never
  used: Nolzu's git there stays on the repository the folder was in before the run, removes every
  `.git` the run made in the folder after it, and never commits a pointer to one. On macOS the wall
  stops a run making one at the top of the folder. The whole `.claude` folder
  at the root of the checkout is held, so a run cannot plant a skill, command or agent that a later
  Claude Code or Cursor run loads. On macOS a rename of it, or a new one where there was none, fails
  too; on Linux a new one is named in the run log after the run. The price: Implement cannot change
  a repository's own `.claude` files, so you change them yourself, outside a run. The `.mcp.json`
  file at the root of the checkout is held the same way, by name, because Claude Code starts the
  servers it names: a run cannot write it, delete it or rename another file onto it. A new one where
  there was none fails on macOS and is named in the run log on Linux. MCP stays on: you still
  change it outside a run, and Nolzu's own QA browser config never goes there, since Claude runs
  start with `--strict-mcp-config` and Nolzu's own config path. Your own commands under Start the app
  are not held this way: a run can change them through the local server, as the known gap below says.
- A run that may write the checkout can still write a hook manager's files in it, such as
  `.husky/pre-commit`, `lefthook.yml`, `.pre-commit-config.yaml` or a `lint-staged` entry in
  `package.json`. So Nolzu runs every git command with the repository's hooks off
  (`core.hooksPath=/dev/null`), which skips every hook manager too, because each one starts from a
  git hook. That covers the commit and the push of a card's work, Pull into the checkout, the
  knowledge commit after a run, the commit and the push on the Workspace page, and every checkout
  and ref update Nolzu makes. The commit box, the push dialog and the Workspace page say so, and
  their Run hooks tick turns the hooks on for that one press, off by
  default. The first commit of a new workspace runs your hooks, since no run has written there
  yet. A clone runs with the hooks off and the same settings as every other git command, so a
  hook a template folder in your git config copies into the new repository does not run during
  the clone. A repository that uses Git LFS needs Run hooks on the push, because LFS uploads its
  files from a pre-push hook.
- The Workspace page's routes name a folder by the id the status gave out, never by a path, and take
  only a file the folder's status lists now: a path that climbs with `..`, is absolute, or goes
  through a folder link out of the repository is refused. Its commit takes exactly the ticked files
  (`git commit --only`), so a file you staged yourself and left unticked stays staged and out of it.
  Its push sends the current branch to its upstream only, never with force, and a push the remote
  turns down is reported with nothing pulled, after the page has shown the sentence that names the
  branch, the remote and its address. Reading the page never fetches, and it reads only when opened,
  on Check again and after a commit or a push.
- Of an engine's state folder a run may write only the session folders and files that engine's row
  in `packages/runner/src/engine-walls.ts` lists, on macOS and Linux alike, Codex on macOS aside
  (see below). For Claude Code that keeps every other path in `~/.claude` read-only,
  such as a status line script, rules, output styles and the files `CLAUDE.md` imports. The
  `memory` folder of each project already under `~/.claude/projects` is read-only too. Cursor is
  held the same way. A folder a run may write that holds one of these read-only paths keeps its
  name, so a run cannot rename it away and move in a folder of its own with the file already inside.
  On macOS a session file the engine saves through a temp file and a rename, as the Cursor CLI saves
  `~/.cursor/cli-config.json`, also opens that temp name beside it (`<file>.<pid>.<id>.tmp`) and no
  other new name in the folder. Linux binds a file, and a bound file can be neither renamed over nor
  given a sibling, so on Linux `~/.cursor` opens whole. Every entry in it that is no session folder
  or file stays read-only, as it was before the run, and a run that adds any other name there (a
  `hooks.json`, a rules folder, a name nobody listed) or replaces an entry (a link removed and made
  again) is stopped after it ends, with that path as the reason. A folder Nolzu cannot read before the
  run starts no run, and one it cannot read after stops the card.
- Some session files must stay writable and still start something later outside the wall. After
  every run, under any wall, Nolzu compares them with the state before and stops the card on a
  change: the MCP servers and hooks in `~/.claude.json` (at the top and per project, and the same in
  the config folder a profile names), and the permissions in `~/.cursor/cli-config.json`. The compare waits until every process left in
  the run's process group is gone, so a tool the run left behind cannot write after it. It runs when
  Nolzu stops reading early too, such as when the run log cannot be written. A card one of these
  checks stopped is never retried on its own, because the next attempt would read what the run left
  as the state before it, and the stop names every problem it found. A stop you press during that run
  does not hide it: the card stays failed with that reason.
- A run that may write the checkout still cannot move what tells git where its repository is: the
  checkout folder, its `.git` file or folder, the git folder and the `commondir`, `gitdir` and
  `config.worktree` files in it. The same holds for each repository one folder down in the
  checkout, as a card on several repositories has them, with their git config and hooks. Writes
  inside the folders the run may write stay open, so a commit still works. Nolzu's own git calls turn
  `core.fsmonitor` off. After every run that may write the checkout, under any wall, Nolzu compares
  these pointers with the state before the run and fails the card on any change. A run the person
  stopped stays stopped, with that line as its reason. On Linux a pointer file that was not there
  before the run cannot be held, so that compare is what catches it.
- On macOS no run can start an app with `open` or send an Apple event (the profile's
  `(deny lsopen)` and `(deny appleevent-send)`). An app that `open` starts runs outside the wall,
  and so does the app an Apple event drives, such as Terminal.
- On macOS a run may open a terminal it made itself, and can neither read, write nor hang up a terminal another window opened. Writing to one could show
  a false prompt there, and some terminal apps answer certain text by typing into the shell, outside
  the wall. `revoke` hangs up a device with neither a read nor a write, so it has its own rule: a run
  may hang up its own terminal and no other device. macOS gives the run that made a terminal a right
  to it, and the profile denies a run the power to issue that right itself (`com.apple.sandbox.pty`).
- If the wall was found ready and then fails to start, the run does not start.
- QA's "Start it with `npm run dev`" runs the start command in its own wall: the card's checkout,
  the temp folder, the project's writable cache folders and Nolzu's package caches are open, the
  checkout's git hooks,
  config and pointers, those of each repository one folder down, and the engine config files in it
  stay read-only, and the secret files and
  every engine's login are hidden, as above. The network stays open, so the app can reach its own
  services. Start QA also saves a hash of the package.json `scripts` the dialog showed. Before each
  start Nolzu reads them again on the card's branch, and on a change it starts nothing, fails the QA
  run with the reason and asks the question again with the new scripts.

- Nolzu writes, reads and removes the files it keeps in a card folder, such as the prompt and the
  method of a run, the QA report's copy and the comments file, only inside that folder. A run may
  write its card folder, so it can leave a link there. A link at the file, at a folder above it or in
  place of the card folder, a file with a second name (a hard link) and a named pipe are refused:
  the write fails with a sentence, the read finds no file, the Files tab lists nothing through a
  linked card folder, and nothing outside is written, read or removed. A folder on the way swapped
  for a link between Nolzu's check and the open is caught once the file is open, before a byte is
  written; the open may leave an empty new file there. The notes a knowledge run wrote are read the
  same way for the output check.
- In the repository's git folder, a link where Nolzu keeps its lock folders or the folder a forced
  removal moves a checkout into is removed, the link only, and nothing is deleted through it. A link
  at the exclude file or its folder stops the card's start with a sentence, and Nolzu neither reads
  nor writes through it.
- A Cursor run's `.cursor/mcp.json` and the exclude line beside it are read, written, put back and
  removed with no link followed: not at the file, not at `.cursor`, and not at the git folder or its
  `info` folder. A named pipe there reads as no file at once. A link the run left there means Nolzu leaves that file alone, and nothing outside the
  checkout changes. A link an earlier run left at the exclude file stops the Cursor run's start.
- A knowledge folder that is the project folder, or holds it, is refused, also through a link. After
  a knowledge run Nolzu removes each new `.git` in the knowledge folder, and there that would take
  another card's new checkout.
- Nolzu's own git never runs a textconv or an external diff command for a diff, a `show` or a `log`
  (`--no-textconv --no-ext-diff`), even one your own config names, since a run can write the
  `.gitattributes` that picks it. Nolzu starts git by its full path, found on the absolute entries of
  the PATH only, so a relative entry such as `node_modules/.bin` cannot hand it a `git` a run wrote
  in the checkout. A push never pushes into a repository inside the checkout
  (`push.recurseSubmodules=no`). Taking a ticked folder out of the index after a refused commit runs
  no git inside that folder.

Settings, Wall lists these fixed rules in groups, built from the same rows the wall is built from.
A project can add to them in Settings, Project, Walls: more paths to hide, `.env` files inside the
project that runs may read, and cache folders that Implement and QA may write. Nothing in those
lists can loosen the fixed rules, and the runner checks every entry again when a run starts. A way
around one of these promises is a security problem.

After every read-only run Nolzu compares `HEAD`, the refs and `git status` with the state before. It
reads only repositories from its own records: the project folder, the project's repositories and the
card's checkouts that are worktrees of them, each with its own folder inside the shared git folder's
`worktrees`. A recorded folder whose `.git` is a link to a git folder is followed. It never looks around a folder for a repository, so a
repository a run left in a card folder is never read.
This is the last check behind the wall. Behind the wall a read-only run cannot write the checkout,
so a change found then is yours or another program's: Nolzu changes nothing and shows the diff on
the card, as it always does in your own project folder. After a run with no wall, in a checkout
Nolzu made for the card, it puts back what changed, except files git ignores, and logs it. When
another run of the same card is queued or running at the start of the read-only run, or at its end
is queued, running or has ended since it started, such as an Implement run beside an Ask message, Nolzu cannot tell whose change it is: it puts
nothing back, marks nothing and says so in the run log. So a read-only run beside another run of
its card is not checked. A later read-only run of the card that compares clean clears the mark.

On Linux with no bubblewrap, or with user namespaces blocked, the wall cannot start. Claude Code
still runs every phase there, held by its guard hook, and Codex runs under its own sandbox. In
both cases the run log says the secret files are not hidden. Cursor runs Implement
only, and a read-only phase is refused with the check that failed. The
[engine notes](docs/engines/README.md#walls) say how to install bubblewrap or allow user
namespaces.

Some things are out of the wall's reach, and that is how Nolzu works, not a hole. The network stays
open in every run, so a run can still cause a side effect elsewhere, such as a `curl -X POST`, a
`gh pr create` or an MCP tool that writes to a ticket system. A run can write anything inside the
folders it may write. A hook manager file a run wrote in the checkout still fires when you run git
there yourself, or when you tick Run hooks. A git filter or merge driver you set up in your own git
config runs outside the wall when Nolzu's git reads a file that `.gitattributes` sends to it, and a
run can write that file in the checkout. "Do not fix the code" in QA and "stay in the method" in
every phase are prompt rules, not walls.

One known gap is not fixed yet: a run, and the app QA starts, can call Nolzu's own local server. The
server answers on `127.0.0.1` with no token, and its check against other websites reads headers a
browser sets, which a program on the same machine, such as `curl`, can leave out or set as it likes.
So a run can do what the pages can do. It can, for example, change your own commands under Start
the app in Settings, Project, which Nolzu runs with no wall at the next QA run or press of Start on the
App line, or move and start cards. Nolzu no longer passes its own `ORIGIN`, `PORT` and `HOST` to a run or to the QA app start,
but that only stops handing over the address: a run can still find the port on `127.0.0.1`. The fix
we plan is a token Nolzu makes at each start that every request must carry and no run can read.
Until then, read the own commands under Start the app in Settings, Project before you start a QA run
or press Start or Stop on the App line.

The QA app start has gaps of its own. Where the wall cannot start, the app starts with no wall, and
the dialog and the card's App line say so. A project that answered the question in an older version
is asked again at its next QA, because it has no saved hash. Your own commands, which you type in
the QA question or under Start the app, run with no wall, because they usually start Docker, whose
socket the wall closes. They get the full environment Nolzu starts with, but no GitHub or npm
token and no `ORIGIN` or `HOST`, as the start command does. A compose file they read from the card's
branch can change what they start, and Nolzu does not ask again for that. The hash covers the `scripts` block only, so a config file a script reads, such
as `vite.config.ts`, can still change on the card's branch without a new question. That code runs
inside the app's wall.

The tool list of a phase holds Claude Code only. Codex and Cursor runs get a full
shell inside the wall in every phase, so for them the wall is the only limit on what a read-only
phase can do.

On macOS the Codex runs still get all of `~/.codex`, with only its known config, hook, rule and
skill paths closed, because Codex writes SQLite files there whose names and places are not written
down yet. A file in that folder that the engine loads
later and that the wall does not name stays writable. A run can still add a project folder with a
`memory` folder under `~/.claude/projects` for a project Claude Code has not run in yet: on macOS
through a link or a folder moved in from the temp folder, on Linux by making it, because bubblewrap
can hold only a path that is there. The files in Claude Code's session folders belong to every
session, so a run can change another session's transcript or shell snapshot, which that session
reads again when it resumes or runs its next command. On macOS a process the run starts in a session
of its own outlives the run and the compare, and can still change a compared file later. The
narrower Claude Code and Cursor lists on macOS still wait for a real run of each engine to show
nothing they need is closed.

Two more gaps are open on macOS. A run can still connect to any other unix socket, a daemon's
socket under another name included, and it can read the pasteboard (`pbpaste`). Closing every unix
socket and the pasteboard lookup needs a real run of each engine first, to show the engines still
start without them. On Linux the network is shared, so a session bus or X server that also listens
on an abstract socket stays reachable. On both, a token in the environment Nolzu starts with
reaches the run, unless it is one of the GitHub and npm tokens above.

On macOS a run can read Nolzu's own secrets from the keychain. Nolzu saves them with the `security`
command, and the login keychain lets that same command read them back with no prompt while it is
unlocked. The wall leaves the keychain open, because Claude Code keeps its own login there. So a run
can read the Jira token and every MCP secret, those of servers that are off for its phase included,
and send them anywhere, since the network is open. Closing it needs a real run of each engine with
the keychain closed, to show they still start. Until then, give the Jira token and each MCP secret
the narrowest rights the service allows.

## When a secret touches a file

Nolzu keeps a secret in the OS keychain, under the service name `nolzu` and an account name that
ends in a short hash of the data folder. On macOS a run can still read it there, as the gaps above
say. These are the places a secret goes, and the one case where
it touches a file:

- The Jira token goes to the keychain and nowhere else. Nolzu reads it for each call to Jira, and
  Disconnect removes it. A change of the Jira site asks for the token again, so it never goes to
  another address.
- The secret values of MCP servers go to the keychain. `.nolzu/mcp-servers.json` holds a secret's
  name and never its value, and a value a hand edit put in the file is named on the page and left
  out of the next save. Each secret is kept for the server's address, or its command, arguments and
  folder, and its plain values, so a pull that points a server elsewhere leaves the secret behind.
- A Claude Code run with MCP servers gets its servers in a config file, secrets included. That is
  the one case. Nolzu writes the file with mode 600 in the run's own folder under `mcp-runs/` in
  the data folder, mode 700, which the wall hides from every other run where the wall runs (on
  Linux with no bubblewrap there is no wall). Claude Code reads it as it starts, and Nolzu removes
  it when Claude Code's init message arrives, before the agent's first tool call. A file a crash left is removed at the next start of Nolzu.
- A Codex run gets its servers as command line settings with no secret in them, and each secret in
  the environment of the Codex process. No file holds it.
- A Cursor run gets its servers in `.cursor/mcp.json` with a reference such as
  `${env:NOLZU_MCP_SECRET_<tag>_<n>}` in place of each secret, and the value in the environment of
  cursor-agent. The file holds no value.

A secret in a process environment can be read by the agent's shell in the same run, inside the
wall. This table says which tool can read which secret on each engine.

| Engine | File tools | Shell tool | Another MCP server of the run | The server gets it |
|---|---|---|---|---|
| Claude Code | No | Yes for a local server's secret env; no for a remote server's headers | Yes, the same ways as the shell | Yes |
| Codex | No: no file holds it | Yes, through the Codex process's or the server's environment | Yes, the same ways | Yes |
| Cursor | No: the file holds a reference only | Yes, through cursor-agent's or the server's environment | Yes, the same ways | Yes |

## What is out of scope

The hosted service behind the paid plans is not in this repository. Report a problem in it to
the same address, security@nolzu.com.

The engines (Claude Code, Codex and Cursor) belong to their makers. Report a
problem in an engine to its maker. A problem in how Nolzu starts an engine, or in what it passes
to one, is in scope here.

[CONTRIBUTING.md](CONTRIBUTING.md) says how to send a fix, and the [README](README.md) says how to
run Nolzu.
