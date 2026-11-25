# Codex CLI engine

What Nolzu spawns, which flags it passes, and what the binary answers. Measured against Codex CLI
0.145.0 on 2026-09-25, with a ChatGPT subscription login. Check the flags again when the engine's
major version changes. The adapter is `packages/runner/src/codex.ts`, `codex-args.ts`,
`codex-models.ts` and `codex-engine.ts`, and every flag below is one a real run passed.

## The binary and how it is found

`codex`, looked up on the login shell's PATH the way `claude` is. A binary that is not there fails
the run with a sentence that names it, and leaves the app reachable.

## The command and the flags

```
codex exec
  --json                              the event stream, one JSON object per line
  --ignore-user-config                the person's own config.toml does not outrank the card
  -m <model>                          the model
  -c model_reasoning_effort=<level>   the effort, as a config override and not a flag
  -c sandbox_mode="danger-full-access"   Codex's own sandbox off, because Nolzu's wall holds the run
  -c approval_policy="never"          no approval asked, since a headless run cannot answer one
  -C <checkout>                       the working directory
  -                                   the prompt comes on stdin
```

That is the shape today, for every phase. Codex runs inside Nolzu's wall, the same wall as the
other engines, and its own sandbox is off. There is exactly one wall per run, because a macOS
sandbox cannot start inside another one. The next section says why the wall and not Codex's sandbox.

With its own sandbox (`ownSandbox: true` on the Codex row of `ENGINE_WALLS`, not the default), the
list is the one Nolzu passed before the wall:

```
  -s read-only                        the sandbox for the pass that writes nothing
  -s workspace-write                  the sandbox for every phase that writes
  --add-dir <card folder>             the card folder, for a run that starts in the checkout
  -c sandbox_workspace_write.writable_roots=[<knowledge folder>]   the runs that write knowledge
```

The effort is separate from the model, and its levels come from the model list below rather than
from a fixed set of three.

The prompt is `-`, so it goes on stdin and never into the argument list, where a process listing
would show the ticket to anybody on the machine. Both `exec` and `exec resume` take it that way.

`--ignore-user-config` keeps a value in the person's `config.toml` from overriding the model or the
sandbox the card chose. The login is not in that file, so it still signs in: a run with the flag
worked on the subscription login.

A run with `-s workspace-write --add-dir` wrote a file in the checkout and a file in the card
folder. Without the added folder the card folder is outside the sandbox, because it sits next to
the worktrees and not inside one.

## Inside Nolzu's wall

Codex's own sandbox cannot hide secret files. Its `workspace-write` and `read-only` modes limit
writes, and both still read everything, `~/.ssh` and `.env` included. Nolzu's wall denies those
reads, makes the card folder writable (and the knowledge folder for the wrap-up, optimize and Learn
this project), and keeps `~/.codex/config.toml`, its hooks and its rules read-only. So Codex runs
inside that wall with its own sandbox off, for every phase, Implement included.

The other way is a Codex permission profile through `-c default_permissions`, which could deny the
reads inside Codex's own sandbox. It is beta and not measured. `scripts/measure-walls.mjs` measures
it, and the switch is one value: `ownSandbox` on the Codex row of `ENGINE_WALLS` in
`packages/runner/src/engine-walls.ts`.

The first line of a walled run's log says which wall holds it and what it may write. Where the
wall cannot start, such as a Linux machine with no `bwrap`, Codex falls back to its own sandbox for
every phase, as "Where a run starts" below says. A wall the check found ready that
still fails to start stops the run, and it never starts bare. WSL 2 counts as Linux here.

`--ephemeral` is not passed. Any run can be resumed later, by an answer to a blocked card or by a
retry, and an ephemeral run keeps no session to resume.

## What the process prints

The shape of a short run. An item that a tool produces is printed twice, first as `item.started`.

```json
{"type":"thread.started","thread_id":"01a0d874-d284-70d3-a9ce-a003aad9c8bd"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
{"type":"turn.completed","usage":{"input_tokens":27199,"cached_input_tokens":24576,
  "cache_write_input_tokens":0,"output_tokens":80,"reasoning_output_tokens":0}}
```

The session id is `thread_id` on `thread.started`. The result is the text of the last
`item.completed`. `turn.completed` carries token counts and no cost, and it carries no duration
either, so a Codex run reports tokens alone. Nolzu shows a missing cost as missing and never as
zero. A cost estimate needs a price per model, and no price
list ships with the binary or with Nolzu, so there is none yet.

An item arrives twice, as `item.started` and then `item.completed`, and only the completed one is
read. These item types have been seen: `agent_message`, which is the agent's text,
`command_execution`, which carries the command and its exit code, `file_change`, which carries
the paths, `mcp_tool_call`, and `error`. An `error` item is a warning in `message`, such as a
requirement this version ignores, printed at the start of a run that goes on. The Log tab shows it
as a line of text, and it is never a tool and never part of what the run said. Any other item type
is shown in the log as the tool the engine named, so a type this version has never seen still
reaches the person.

A turn that fails prints its reason twice and then exits 1:

```json
{"type":"error","message":"Selected model is at capacity. Please try a different model."}
{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}
```

`turn.failed` is the run's result, so the card shows that sentence and not the exit code. It carries
no status, so the retry schedule resumes a run whose sentence says the model is at capacity, the
service is overloaded or there is high demand, and never one whose sentence names a login, the credit
or a 4xx request error. The 0.157.0 binary holds the high demand sentence, "We’re currently
experiencing high demand, which may cause temporary errors.", and no run has printed it yet.

A refused tool is not in this stream. It goes to stderr as a log line, and the agent's own last
message usually says it too.

### Tool results and tokens so far

A completed `command_execution` item carries the command's output in `aggregated_output`, and that is
the one tool result this stream gives: Nolzu reads its size in bytes, and a non-zero `exit_code` as
an error result. A `file_change` names its paths and gives nothing back. The counts arrive only on
`turn.completed`, at the end of the run, so a Codex run shows no tokens so far while it works.

## Resume

`codex exec resume <thread_id> -` continues the thread and keeps the same id. A resumed run proved
it remembers the earlier turn: asked which file it had been told to write, it answered with the
name from the first turn.

A person continues the same session at a terminal with the interactive `codex resume <thread_id>`,
read off `codex resume --help`. That is the command the Discussion tab copies, started in the
folder the run started in and with `CODEX_HOME` set when the profile names one.

The subcommand does not take the flags `exec` takes. `-s` is refused with "unexpected argument '-s'
found", and there is no `-C` either, so the sandbox goes through `-c sandbox_mode=...` and the
working folder is the one the process starts in. Inside the wall that is `danger-full-access` on
both paths. A resumed run under that override was refused a
write, with the same stderr line a first run gets, so the read-only mode holds across a resume. An
adapter that builds one argument list for the first run and the resume will break on the resume.

A resumed phase that may write needs its card folder named too, and `--add-dir` is not there
either. The adapter passes `-c sandbox_workspace_write.writable_roots=[...]`, which is read in the
help and not proven by a run.

A resumed read-only phase gets neither, because its working folder is the card folder and that
folder is the writable area already. The process is started there, and no run has yet proved that
the working folder of a resume comes from the process rather than from the session's own record of
where it started. The two were the same folder in every run measured so far, so nothing has told
them apart. A real answer to a blocked refine or plan card on Codex would.

## Where a run starts

Inside the wall every phase starts in the checkout, like on the other engines, and the wall holds a
read-only phase to its card folder. The rest of this section is the shape under Codex's own sandbox,
which is how every Codex run worked before the wall.

A resume starts where its session started, because the paths the session wrote are read from that
folder. Each run row records it (`in_card_folder`). A row made before that column started where the
old rule said, so a read-only Codex run from then still resumes in its card folder.

Measured on 2026-09-26. A read-only phase runs with the card folder as its working directory and
`-s workspace-write`. The writable area is then the card folder alone, and the project lies outside
it. One run on a scratch project was asked for three things, with the file to read three folders
above the working one:

1. Read `../../../src.ts`: it read it and quoted it.
2. Append to `../../../src.ts`: refused. The agent said "the file is outside the writable
   workspace (`operation not permitted`). It remains unchanged", and the file was unchanged on disk.
3. Write `./refined.md` in the working folder: written.

That is what a read-only phase needs: it reads the project, cannot change it, and writes its own
artifact. The vendor's own sandbox holds it, so the model cannot talk its way out of it. What the
sandbox reads is the writable root and not how far up a path goes, and in the layout Nolzu builds
the checkout is two folders up, at `../../worktrees/<key>`. That depth was not measured.

The paths in the prompt are read from the folder the run starts in, so the prompt names the card
folder as `./` and names the checkout as the place to read. `startsInCardFolder` in
`phase-policy.ts` is that one rule, and it follows the `ownSandbox` switch. The job builder reads it
and puts the answer on the job, and the spawn starts the process there. The card folder is
`<project>/.tasks/<key>`, inside the project's own repository when the project folder is one.

`--skip-git-repo-check` is passed to `exec` and `exec resume` only when the project folder is not a
git repository, because both refuse to start outside one without it. Until Codex is measured in such
a folder, the job builder refuses a run there before the flag is used, with a sentence that names
Claude Code.

Refine, plan, the read-only phases of the other four boards (architecture, design, investigate,
research and pr-review), triage of a card's pull request comments and the Scout assessment run
this way. Implement starts in the checkout,
because it may change the project, and the card folder is added beside it with `--add-dir`. The two
passes, the plain summary and the commit message, write nothing, so they keep `-s read-only` in the
checkout.

Under its own sandbox the wrap-up, optimize, Learn this project and Learn your repositories start in the card folder too,
with the knowledge folder as one more writable root.

Where Nolzu's wall cannot start, Codex runs this way again, for every phase. QA starts in its
throwaway copy under `-s workspace-write`, so a check that writes a build cache or a coverage file
writes the copy, and the card folder is added for the report. The real checkout stays outside the
writable area. The wrap-up, optimize, Learn this project and Learn your repositories start in the card folder with the
knowledge folder added. The first line of the run log says the Codex sandbox holds the run and the
secret files are not hidden.

## The read-only mode

`-s read-only` is enforced by the sandbox. A run asked to write a file wrote nothing, stderr
carried

```
ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox;
rejected by user approval settings
```

and the process still exited 0. So a refusal is not a failed run, and the adapter reads it from
stderr. It writes one line of its own into the stream for each refusal, so the run log keeps the
engine's own words and the card gets the same refusal event a Claude run gives.

The sandbox is stricter than the Claude guard it stands in for. That guard refuses a write outside
the card's own folder, so a read-only phase can still write its artifact. The Codex sandbox refuses
every write, the card folder included, so a read-only phase under Codex cannot write its own
summary or plan. Only a run that writes nothing fits `-s read-only` here, and the two passes, the
plain summary and the commit message, are the only such runs there are.

So a read-only phase cannot run under this sandbox in the checkout. The section above is the way
round it: the run starts in the card folder, where `-s workspace-write` gives the same limit from
the other side. `-s read-only` is kept for the two passes, which write nothing.

## Two traps

The process reads stdin when stdin is open. Without it closed a run printed "Reading additional
input from stdin..." and waited, so every spawn writes the prompt and closes stdin.

stderr carries noise that is not ours. Some runs printed `ERROR codex_models_manager::cache: failed
to load models cache: missing field base_instructions`, which comes from the binary's own cache and
changes nothing. An adapter that reads any stderr `ERROR` as a failure fails every Codex run.

## The phase instructions

Codex reads the skills in `.agents/skills/`, but a card checkout holds whatever copy was committed
there, which can be older than the installed Nolzu. So it is handed the skill, as every engine is.
Nolzu builds the text from the skill that owns the phase, in `packages/skills/src/instructions.ts`,
and the runner writes it to `<card folder>/<phase>/instructions.md` when it makes the card folder. The
prompt opens by naming that file. The text is built on every run, so a change to the skill is in the next
run and there is no second copy to keep in step. A skill file a person changed in one of the project's
skills folders wins over the shipped one: a file that is neither what Nolzu ships nor what the
last sync recorded in `.nolzu-skills.json` is theirs, the rule the sync itself uses.
The files a skill only links to, such as the finish rules, are copied into it, because a relative
link means nothing to an engine that was handed one file.

The card folder is the place for it. The file belongs to that one run, the folder already holds
what the run produces, and the engine is given that folder anyway. A copy in the project would be
a file in somebody's repository that nobody asked for, and the prompt is not the place either: a
long ticket would push the method down, and a resume sends the prompt again without it. A run that
carries no method takes the file away again, so the card folder never shows a method the engine now
running was never given. The two passes get none: neither is a phase, and their prompts name no
file.

A real refine run on Codex CLI 0.145.0 read it, on 2026-09-25, on the demo recipe workspace in a
temp copy, with `gpt-5.6-sol` at low effort. Its first command was
`sed -n '1,280p' ../.tasks/APP-1/refine/instructions.md`, and it then wrote `refined.md` with the
five sections the skill asks for, in that order, wrote the same plain summary to `summary.md`, and
ended with `NOLZU: complete`. The checkout was left untouched, which `git status` in the copy
showed. The turn reported 101701 input tokens, 92928 of them cached, and 1359 output tokens.

That run used `-s workspace-write` with `--add-dir` on the card folder, started in the checkout,
which is not the shape Nolzu spawns for refine today. What it proves is that a Codex run finds this
file, follows it and produces the artifact. Refine through Nolzu now starts in the card folder
instead, which the section above measured. A run of the whole phase that way on this engine has
not been recorded here yet.

Cursor and Claude Code take the same file.

## The model list

`codex debug models --bundled` prints JSON, works offline and works with a dead login. Eight models
on this version, each with its own effort levels, and `visibility: "hide"` marks the ones the vendor
does not offer in its own picker. `gpt-5.6-sol` carries six levels: low, medium, high, xhigh, max
and ultra.

Nolzu reads `slug`, `supported_reasoning_levels` and `visibility`, offers the listed models for
picking, and takes the levels from the whole list, so a hidden model a row already names still runs.
The test that the command still answers in this shape needs Codex CLI on the machine. Without it
that test is skipped, so a run of the suite on a machine with no Codex proves nothing about the
model list.
The command is run once per process and the answer kept, because the board reads the model list on
every snapshot and the binary takes about a tenth of a second. An answer it never got is not kept,
so installing the engine repairs the list without a restart.

## A second login

`CODEX_HOME` points at the config folder and the sessions folder together, so a second login is a
second folder. Nolzu sets the variable per process and never opens the folder. Sessions live under
`$CODEX_HOME/sessions`, which is why a resume belongs to the profile that started it.

Check login on the Engines screen runs `codex login status` with the profile's `CODEX_HOME`. The
command reference says it exits 0 when logged in. The rest is read off `run_login_status` in
`codex-rs/cli/src/login.rs`: "Logged in using ChatGPT" (or the API key form, with the key masked) on
stderr with 0, and "Not logged in" with 1. An error also exits 1, so only that line means signed
out. Both answers were seen on 2026-10-15, the second from an empty `CODEX_HOME`.

## Variables that outrank the flags

`CODEX_HOME` decides which login and which sessions a run sees, so it is set by Nolzu and never
inherited. `-c` overrides read from `$CODEX_HOME/config.toml`, so a value in the person's config can
still change a run. Nolzu passes `--ignore-user-config`, which stops that and leaves the login
alone.

Which environment variables outrank the flags was not measured. The Claude adapter drops
`ANTHROPIC_MODEL` and the effort variable for that reason, and no such name is known here yet.

## The limit signal, not proven

Nothing in a normal turn reports a usage window: `turn.completed` carries token counts only.
`codex app-server` may report one, and that was not tested. The text
a run produces when it hits a usage limit has not been seen here, so Nolzu cannot recognize a Codex
limit yet, and the limit block reads "unknown" until somebody records one.

## What the isolation flags do not remove

Codex loads its own config, its own `.rules` files and its own MCP servers. `--ignore-user-config`
was run and a run with it still worked. The CLI reference says it does not load
`$CODEX_HOME/config.toml` and keeps the login in `CODEX_HOME`, so the MCP servers the person put in
that file do not start. `-c mcp_servers={}` is not used for that, because Codex ignores an empty table
there (openai/codex issue 16045). Not measured: the `.rules` files of the project, a
`.codex/config.toml` a trusted project holds, a system config such as `/etc/codex/config.toml` and a
managed config an administrator set, each of which may still load servers. `--ignore-rules` and
`--strict-config` were read in the help and not run.

## MCP servers

Codex takes no MCP config file on the command line, so a run gets each server of the project's MCP
list that its phase is on for as `-c` overrides, on a fresh run and on a resume:

```
-c mcp_servers.<name>.command="npx"
-c mcp_servers.<name>.args=["@playwright/mcp@latest", "--no-sandbox", "--allow-unrestricted-file-access"]
-c mcp_servers.<name>.env={ "HOME" = "<temp folder>/nolzu-browser-home" }
-c mcp_servers.<name>.env_vars=["<secret variable>"]
-c mcp_servers.<name>.cwd="<folder>"
-c mcp_servers.<name>.enabled_tools=["<tool>"]
-c mcp_servers.<name>.startup_timeout_sec=120
-c mcp_servers.<remote>.url="https://mcp.example.com/mcp"
-c mcp_servers.<remote>.http_headers={ "<header>" = "<plain value>" }
-c mcp_servers.<remote>.env_http_headers={ "<header>" = "NOLZU_MCP_HEADER_<n>" }
-c shell_environment_policy.exclude=["<secret variable>", "NOLZU_MCP_HEADER_<n>"]
```

The keys come from the Codex configuration reference. No file holds the servers: Nolzu reads the
secrets from the keychain into memory when the run starts. A secret is never on the command line: a
secret env value is set in Codex's environment and forwarded by `env_vars`, a secret header is read
from the variable `env_http_headers` names, and both variables leave the agent's shell through
`shell_environment_policy.exclude`, because `ignore_default_excludes` is true by default and keeps a
name with KEY, SECRET or TOKEN. The reference calls `exclude` the legacy form beside `filters`; Nolzu
keeps `exclude`, which 0.145.0 reads. A command the agent runs can still read the Codex process's
environment and a local server's through the operating system. Codex speaks streamable HTTP and no SSE, so an SSE server is left out
with a line in the run log. The wait is long because the first run downloads a server with npx. No
run on Codex with a server has been run yet, so whether the tool calls need an approval under Codex's
own sandbox is not known.

Codex lists no MCP tool until one is called, and a QA run that was not told wrote that no browser
was configured. So the QA prompt names the servers Codex is handed and says to use them.
