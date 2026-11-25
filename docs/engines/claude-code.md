# Claude Code engine

What Nolzu spawns, which flags it passes, and why each one is there. Measured against Claude
Code 2.1.273 on 2026-09-16. Check the flags again when the engine's major version changes.

## How Nolzu picks it

There is no engine setting. Outside fake mode, `selectEngine` in `packages/runner/src/select.ts`
returns this engine when the engine profile a run uses names the vendor `claude-code`, which is also
the default when no vendor is given. A vendor this version cannot run is refused with a sentence that
names the engines it runs. With `NOLZU_FAKE_AGENT=1` the fake engine wins over the profile, so a
stored profile never starts a real run inside a test or a demo.

The login shell's PATH is read once per process, when the board first loads. `claude` is looked up on it, and the run
gets it as its PATH, so the tools an agent runs are found as well. A `claude` that is not found does
not stop the app: the run fails with "The claude engine was not found", and the board and the
settings stay reachable.

## The flags

```
claude -p
  --output-format stream-json
  --verbose
  --strict-mcp-config
  --mcp-config <path>          the servers of the project's MCP list the phase is on for, when any:
                               a file Nolzu writes for each attempt, mode 600, removed when the
                               init message arrives
  --setting-sources project
  --tools <names>              the phase's tool list, comma separated, from the built-in set
  --permission-mode acceptEdits
  --add-dir <card folder> [<knowledge folder>]
                               every run, the absolute card folder, see "The card folder" below;
                               it also holds the phase instructions the prompt names;
                               the wrap-up, Optimize, Learn this project and Learn your
                               repositories add the knowledge folder after it
  --settings <path>            when the project has the run guard, a settings file that names it
  --allowedTools Bash(<command>) ... Read(//<project>/AGENTS.md)
                 Read(//<path>) ... mcp__<server> ...
                               Bash entries for implement and QA, one per command the project allows,
                               and for QA the read-only git commands as well;
                               the two Read entries when the run starts outside the project folder;
                               one Read entry for each other file outside the checkout the prompt
                               names (the epic's card folder for a task, the project's Implement
                               and QA instructions for Plan), and one for the knowledge folder when
                               the prompt lists it;
                               one mcp__<server> entry per server of the run, or one
                               mcp__<server>__<tool> per tool of a server with a tool list
  --model <model>
  --effort <low|medium|high>
  --session-id <uuid>          a fresh run, so the id exists before the first line arrives
  --resume <session id>        a run that continues an earlier one
```

The prompt goes to the process on stdin, never in the argument list, so it cannot show up in a
process listing and cannot hit the argument length limit.

`--verbose` is not optional. With `--output-format stream-json` and no `--verbose` the CLI
refuses to start and says so on stderr.

## Permission mode, and what it does not do

Every refusal, whichever way it came about, is listed on the final `result` line under
`permission_denials`. Each entry carries the tool name, the `tool_use_id` and the tool's own input,
so the file or the command is there.

What differs is whether the refusal also gets a line of its own. A refusal the engine decides itself
is reported as a `system` line with subtype `permission_denied`, which carries the tool name and the
same id but no input, so that line alone cannot say which file. It does say why: `message` always
holds the engine's sentence, and most kinds of refusal repeat it in `decision_reason`. For a path
outside the working folders the two differ, and `message` asks for a grant that nobody can give a
run, so the Log tab shows `decision_reason` where there is one and `message` otherwise, measured on
2.1.310. A refusal from a `PreToolUse` hook has no such line at all: it appears only as a tool
result marked as an error, and in the list on the result line. The shared id is what lets a reader
tell one refusal reported twice from two refusals.

A hook refusal leaves the run reporting `subtype: success`, which is why a denial cannot be spotted
from the exit code. A denial can also ride a result line that failed, `error_max_turns` for one, so
the list has to be read on both.

`acceptEdits` does not mean nothing is refused. A Bash command that needs approval is still denied,
with a line of its own, so a phase that holds Bash can be refused even in that mode.

Without `--permission-mode` the engine runs in default mode and refuses every write. Measured: the
refine argv without it reported `"permissionMode":"default"`, the Write came back as a
`permission_denied` line, the process exited 0 and the result line still said success, which is why a denial has to be read from the stream and cannot be spotted from the exit code. The same argv with
`--permission-mode acceptEdits` wrote the file and ended without an error. So the tool list on its
own grants nothing, and a phase cannot write even its own summary.

The mode is not a path limit. `--allowedTools 'Write(.tasks/**)'` denied every write including the
one it names, and `--disallowedTools 'Write(src/**)'` blocked nothing, so a tool cannot be scoped to
a path through the flags. What does work is a `PreToolUse` hook in the project's own
`.claude/settings.json`, which `--setting-sources project` loads: a hook that exits non-zero for a
write outside the card's folder refuses that write, allows the others, and the run still ends well.
Onboarding writes that hook, because it already writes the project's files.

`bypassPermissions` is not used. It turns off the checks the hook relies on.

## The commands a run may use

`acceptEdits` refuses every shell command that needs approval, and in a background run nobody can
give it. So each project keeps a list of commands, edited at `/settings/project`, and a phase whose tools
hold `Bash` gets one `--allowedTools` entry per command, written `Bash(<command>)`. The `--help` of
2.1.286 says the flag takes a comma or space separated list and gives `Bash(git *)` as an example,
so a command with a trailing ` *` allows any arguments after it. Each entry goes in as its own
argument and the list sits before `--model`, so a command with spaces stays one entry and the list
ends at a flag.

An empty list adds no flag, and the list never holds a bare `Bash` or an entry that starts with
`*`, either of which would allow every command. The list is filled once from the files at the top
of each repository, and after that it is the person's. For Node that is install, test, lint and build
through the package manager the lockfile names, from the `package.json` scripts the project has. Every
other stack has one row in `STACKS` (`packages/core/src/allowed-commands.ts`): Python, Rust, Go, Java
and Kotlin, .NET, Ruby, PHP and the rest, Symfony, Laravel, Rails and Django on top, and a linter
only when its config file is there. A row proposes only install, test, lint or format check and
build, never a wildcard and never a database, migration, cache, deploy or publish command. Propose
again in Settings, Project shows what the repositories propose now and adds only the ticked
commands. It never takes one away.

A variable set in front of a command needs its own entry. Per the permissions page of the Claude Code
docs, an allow rule matches past only a fixed set of known safe variables, so `npm *` does not allow
`PORT=3000 npm start`, and `PORT=3000 npm *` does. Measured on 2026-10-23: a real Implement run was
refused `PORT=3000 npm start` under `npm *` and ran it under `PORT=3000 npm *`. The list refuses a
wildcard inside such a value and a variable with no command after it, because the engine's `*` spans
spaces: `PORT=* npm *` matches `PORT=1 rm -rf ~ npm`. The Log tab's refused line names the entry
that would allow a plain command with a variable in front.

Not measured yet: whether a `Bash(<command>)` entry lets a `-p` run under `acceptEdits` run that
command at all. The scoped `Write(.tasks/**)` entry above granted nothing, so the syntax from the
help is not proof. Also not measured: whether `Bash(npm test)` allows `npm test -- --run
one.test.ts`, and whether an entry with spaces stays one entry, since the flag also splits on
spaces. One real run with `Bash(npm install)` answers the first question.

A listed script runs whatever `package.json` says, and implement may edit `package.json`. So the
list limits the agent to the project's own scripts, and those scripts are only as safe as the
project.

## The card folder

A card's files live in `.tasks/<key>/` in the project, next to `worktrees/`, and not inside the
card's checkout, so they outlive the checkout when it is cleaned up. The run starts in the checkout
(implement and QA on a card with one child repository start in that repository's checkout inside
it), so the card folder is outside its working folder, and the engine refuses a write there in every
mode. Measured on 2.1.278 with a checkout at `project/worktrees/APP-1` and one Write to
`../../.tasks/APP-1/refine/summary.md`: without `--add-dir` the write came back as "Claude requested
permissions to write to" that path, no file appeared, and the result line still said success with
one entry in `permission_denials`. With `--add-dir <project>/.tasks/APP-1` the same write went
through in `acceptEdits` mode. So every run passes `--add-dir` with the absolute card folder.

The knowledge folder, `.nolzu/knowledge` in the project unless the project names another one, is
outside the checkout too. The guard and the wall let the runs that write knowledge (the wrap-up,
Optimize, Learn this project and Learn your repositories) write there, but the engine checks the folder on its own, and it
refuses a read as well as a write. Seen on 2.1.310 in a wrap-up that started in
`project/worktrees/APP-4`: its Glob and Grep of the folder came back as "Path is outside allowed
working directories", the run wrote no knowledge, and the result line still said success. So those
runs name the physical knowledge folder after the card folder, under the same `--add-dir`. Every
other phase whose prompt lists the knowledge files gets `Read(//<knowledge folder>/**)` instead,
because `--add-dir` would open the folder to writes as well.

The prompt names the folder relative to the working folder, such as `../../.tasks/APP-1/`, so no
machine path reaches the log. The skills name no path and say "the card folder". In both runs of
that measurement the `init` line reported the physical working folder, and the agent sent a
physical absolute `file_path`, although the checkout was reached through the `/tmp` symlink.

## The project's own files

A card checkout sits inside the project folder, so Claude Code also loads the project's `CLAUDE.md`
from the parent folder. That file says to read `AGENTS.md`, and the engine refused the read as
"Path is outside allowed working directories". So a run that starts outside the project folder gets
a `Read(//<project>/AGENTS.md)` entry under `--allowedTools`.
A leading `//` is an absolute path from the filesystem root, per the permissions page of the Claude
Code docs; a single `/` would be relative to the settings source. The rule grants reads of that
file and nothing else, where `--add-dir` on the project would let the run write there. The rule
names the physical project folder, as `--add-dir` names the physical card folder, because the agent
builds its paths from that. A run that
starts in the project folder gets no entry, and neither does a project folder whose name holds a
pattern character such as `*` or `[`. Not measured yet: one real run that reads the file.

## Models

There is no command that lists the models an account may use, and `/model` is an interactive picker.
So the list is kept by hand in `packages/runner/src/models.ts`: `haiku`, `sonnet`, `opus` and `fable`.
The `--help` of 2.1.278 names `fable`, `opus` and `sonnet` as aliases for the latest model of each
family, and `haiku` is the one the presets use for refine. `default` and `opusplan` are left out,
because both let the engine pick or switch the model inside one run. A model that vanished shows as
gone only after a run refuses it.

## A run that stays up after its result

Seen on 2026-10-23: an Implement run started the app's server in the background, printed its result
line and kept running, and the card stayed Running until the person stopped it. The cause is not
proven; the likely one is that Claude Code waits for a background command it started. `runJob` now
stops an engine that prints nothing for 10 seconds after its result, with everything in its process
group, and the run ends as the result said. A line after the result starts the 10 seconds again, in
case the engine goes on with a turn of its own. A server the agent started for a check stops with it,
as it does when the engine exits on its own.

## The environment of a run

The engine does not get the whole shell. `engineEnv` in `packages/runner/src/engine-env.ts` copies
the environment and drops `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_MODEL`, every
`ANTHROPIC_DEFAULT_<family>_MODEL` and `CLAUDE_CODE_EFFORT_LEVEL`. Each of them outranks `--model`
or `--effort`, so a value left in the person's shell would run the card on a model the card does
not show. The names were read off Claude Code 2.1.278. It also drops `GH_TOKEN`, `GITHUB_TOKEN`,
`GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `NPM_TOKEN` and `NODE_AUTH_TOKEN` for every
engine, so a run cannot push or publish with them. Everything else stays, the API key and the base
URL included, because the login arrives the same way.

The same step turns the hook on. For a read-only phase it sets `NOLZU_READ_ONLY=1` and
`NOLZU_TASK_DIR` to the absolute path of the card folder. For implement it
removes both, so a pair inherited from the parent cannot hold the run to another folder.

The path is the physical one, with every symlink resolved, and the folder is made before the run
so it can be resolved. The engine reports the physical working folder, and the agent builds its
paths from that. The hook compares with `path.resolve`,
which follows no symlink, so a limit kept in the spelling the person typed matched no path the
agent sent, and the hook refused every write of the run. macOS keeps its temp folder behind a
symlink, so a copy there hits this at once.

## The wall

Every run starts inside Nolzu's wall, Implement, Ask and the passes included: `sandbox-exec` on
macOS, `bwrap` on Linux and inside WSL 2. A read-only phase can write only its card folder, plus the
knowledge folder for the wrap-up, Optimize, Learn this project and Learn your repositories. Implement can write the checkout
and its git folder. Every run is denied `~/.ssh`, `~/.aws`, `~/.gnupg`, the project's `.env` files
and the logins of the other engines, and `~/.claude/settings.json`, the hooks and the whole
`.claude` folder at the root of the card's checkout stay read-only. That folder's skills, commands,
agents and rules load in a later Claude Code or Cursor run, outside the wall, and on macOS a rename
of it or a new one where there was none fails too. The price is that Implement cannot change a
repository's own `.claude` files: change them yourself, outside a run. The checkout's `.mcp.json`
is held the same way, because Claude Code starts the servers it names; Nolzu's runs read only their
own config (`--strict-mcp-config`), so QA's browser does not need that file. Claude Code keeps its
sessions under `~/.claude`, not in the project, so a run needs no write there. Of `~/.claude` only
the session folders and files in the Claude Code row of `engine-walls.ts` are writable, so a status
line script, rules, output styles and each project's `memory` folder stay read-only too. `~/.claude.json` stays writable, because Claude
Code rewrites it in every session, and Nolzu stops the card when a run changed its MCP servers or
hooks. The guard hook stays on as well: it judges `Write` and
`Edit`, and the wall also holds `Bash`. The settings file Nolzu hands a run turns Claude Code's own
sandbox off, whatever the person's own settings say, so one wall holds the run and nothing nests.
The first line of the run log says which wall holds it and lists the folders it may write. Where the
wall cannot start, such as a Linux with no bubblewrap, the run still starts. The guard hook holds
`Write` and `Edit`, and the first line of the run log says the run is not walled and the secret
files are not hidden.

## Login status

Check login on the Engines screen runs `claude auth status --text` with the environment a run of
that profile gets, so `CLAUDE_CONFIG_DIR` is the profile's folder, or what the shell set for a
profile with none. The CLI reference says it exits 0 when logged in and 1 when not, and that `--text`
prints the answer for a person instead of as JSON. Nolzu reads the exit code and shows the words.
On 2026-10-15 a login answered "Login method: ..." and the account lines with 0, and
an empty folder answered "Not logged in. Run claude auth login to authenticate." with 1.

## Why each flag is there

A headless run is not isolated by default. It cannot show the trust prompt, so it loads the
project's `.mcp.json` and the user's own servers without asking. A plain run on a machine with
many servers set up reported 141 tools and 22 MCP servers, and the user's own session hooks wrote 16
lines into the stream that had nothing to do with the phase. `--strict-mcp-config` is what stops that, and
`--tools ""` on its own does not: MCP tools come from the configuration, not from the tool list.

`--setting-sources project` keeps the user's personal hooks and settings out of the run while the
project's own settings still load. A run reads the method from a file in the card folder, not from
the project's skills, so it does not need them.

`--safe-mode` is not used. It is the strongest isolation the CLI offers, and it also blocks the
project's own skills. It has not been measured against the run guard, which loads from project
settings.

`--bare` is not used either. It reads only `ANTHROPIC_API_KEY` and never the subscription login,
which would break the rule that Nolzu spawns the unmodified CLI and inherits the user's own login.

## What was measured

One probe project with a single skill in its own skills directory, one short prompt per run.

| Flags | Project skill | Tools | MCP servers | Hook lines |
|---|---|---|---|---|
| none (control) | not tested | 141 | 22 | 16 |
| `--strict-mcp-config` | loaded | 27 | 0 | not counted |
| `--strict-mcp-config --setting-sources project` | loaded | 26 | 0 | 0 |
| `--strict-mcp-config --setting-sources user,project` | loaded | 27 | 0 | not counted |
| the same plus `--safe-mode` | not loaded | 26 | 0 | not counted |

The last row is the reason safe mode is out.

Run cost is not in the table on purpose. The figures moved between about half a cent and nine
cents across these runs, and they follow the prompt cache state of the moment, not the flags. The
one honest cost statement is the control: a run that loads 22 MCP servers and 141 tools pays for
all of it in its first request, and an isolated run does not.

## Retries

Two layers retry a failed call. Claude Code retries an API error on its own, within one run, a few
times and in under a second or so, and reports each try as a `system` line with the subtype
`api_retry`. Nolzu does not save those: they are the engine's business. When the run itself ends
on an API error, Nolzu waits 2, then 5, then 15 minutes, counted from the end of the failed attempt,
and resumes the same session with `--resume`, so the work done so far is kept. The waits are the
retry waits setting. While Nolzu waits, the run reads `retrying`, and it reads `running` again once
the resumed attempt starts.

Nolzu retries status 429, 500 and 529, and an API error with no status, which is a lost connection.
It does not retry a failed login, a request the API refused, an account out of credit, max turns or
a refused permission: they come back the same. A 429 is not retried when the run reported a full
usage window, with `utilization` at 1 or more, that resets after the whole schedule would be over.
Every run reports its windows, full or not, so only a full one counts. The card then reads
"5-hour limit, resets 19:00", in the person's own time.

## Tool results and tokens so far

The stream carries what each tool gave back, on a `user` line as a `tool_result` block, and the
counts of each model call, on its `assistant` lines under `message.usage`. Nolzu reads the size of a
result in bytes and never keeps its text in an event: the text stays in the run log. A result the
engine marks with `is_error` reads as an error result.

One model call can arrive as several `assistant` lines, one per content block, each with the same
`message.id` and the call's whole usage. Measured on Claude Code 2.1.296. So the usage event carries
the id, and the tokens so far count each id once. The figure is input and output, as the phase strip
counts them. There is no running cost: the engine names its cost on the result line alone.

When Nolzu waits out an API error, it writes a `nolzu.retry` line into the run log with the wait's
reason and the time the next try starts, because the engine prints nothing while Nolzu waits.

## The first real runs

Two refine runs of card APP-1 on a copy of the demo workspace, through Nolzu's own start path, on the
subscription login (`apiKeySource: none`), model `haiku`, effort `low`, Claude Code 2.1.278. The
worktree was made with `ensureWorktree`, and the three skills sat in the project's `.claude/skills/`.

Started inside `worktrees/APP-1`, Claude Code finds those skills by walking up the folders, although
the worktree holds no copy. The `init` line listed them among the skills and the slash commands,
together with four tools and no MCP server.

A skill that is listed is not a skill that is used. The first run passed `--tools Read,Grep,Glob,Write`,
which holds no `Skill` tool, so the model had no way to open one. It never read a `SKILL.md` and wrote
`analysis.md` where the refine skill asks for `refined.md`. It still ended well, for $0.058 in 37
seconds, which is why this cannot be seen from the result line.

The second run opened with the phase skill as a command, `/nolzu-refine` on its own first line. Print
mode expands it before the model starts, so no stream line names it. That run wrote `refined.md`
with the skill's sections in the skill's order, and `summary.md`, both into the card folder, for $0.048
in 21 seconds, and ended with `NOLZU: complete`. Both runs left the worktree clean and had nothing
refused.

A Claude Code run gets the method the way every other engine does, not through a slash command,
because a command expands the copy of the skill a checkout has committed, which can be older than the
installed Nolzu. The runner writes `<card folder>/<phase>/instructions.md` from the skill in the
installed package, linked files copied in, and the prompt's first line says to read it (`codex.md`
says how the file is built). The card
folder is already added with `--add-dir`, and the run guard checks writes only, so a read-only phase
can read it. A skill a person changed in one of the project's own skills folders still wins, read from
the project folder, and the file then says so in its second line. Onboarding still writes the skills
to `.claude/skills/` for people's own Claude Code sessions.

The run stream carries one `rate_limit_event` before the result line, with both windows. An example of its shape, with made-up values:

```json
{"status":"allowed","rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"<reason>","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.2,"resetsAt":1790000000},"seven_day":{"utilization":0.1,"resetsAt":1790400000}}}
```

## The limit signal

`status`, `rateLimitType` and `resetsAt` are the documented fields of that line, and they describe
one window: the one `rateLimitType` names. `unifiedWindows` is marked internal by the binary, and it
is the only place a per-window share is written, so Nolzu reads the documented three first and takes
the share from `unifiedWindows`. Nothing is filled in for a field the line leaves out: a missing
share and a missing reset time are kept as missing, because a zero in their place read as 0% used
and a reset in January 1970.

The recorded line above carries no top-level `resetsAt`. Reading the documented one before the
`unifiedWindows` one is what the documentation says to do, and no line recorded here has the two
disagree, so that order is taken from the documentation and not from a measurement.

The windows seen so far are `five_hour` and `seven_day`, on Claude Code 2.1.278. A window
under another name is kept under the name the engine gave it and shown with that name, because a
refusal on a window this version has not seen would otherwise be dropped and the screen would say
the account is fine.

A share above 1 is kept as it is. An account on overage goes past its window, and cutting the number
to 1 would hide it. The Engines screen shows the last reading per profile, with the time it was
seen, and that reading never leaves this machine.

Claude Code keeps each run's session under `~/.claude/projects/`, in a folder named after the
worktree's path. A resume needs it, so every card leaves one such folder there.

## What isolation does not remove

This is not a clean room, and the docs should not promise one. With the flags above the run still
loads the CLI's own built-in skills, its slash commands and its bundled agents. What goes away is
the user's MCP servers and the user's personal hooks. That is enough for Nolzu: the phase gets its
own method, and nothing the user configured for their own work can write into the stream Nolzu
parses or spend tokens the phase did not ask for.

## Telling the user

The Engines settings screen says in one line that Nolzu runs the agent without the user's personal
hooks, MCP servers and output style. Passing flags is not a modification of the CLI, but a user
whose hooks did not run deserves to know why.
