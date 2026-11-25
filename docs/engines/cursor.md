# Cursor CLI engine

What Nolzu spawns, which flags it passes, and what the binary answers. Measured against Cursor CLI
2026.09.23-86fc751 on 2026-09-25, on a free account and a paid account. Check the
flags again when the engine's major version changes. The adapter is `packages/runner/src/cursor.ts`,
`cursor-args.ts`, `cursor-models.ts` and `cursor-engine.ts`, and `spawnCursor` in `spawn.ts`.

## The binary and how it is found

`cursor-agent`, looked up on the login shell's PATH. The installer makes it a symlink into
`~/.local/share/cursor-agent/versions/<version>/`, so the version can change under the same name.

## The command and the flags

```
cursor-agent -p
  --output-format stream-json   the event stream
  --model <id>                  the model, with the effort inside the id
  --trust                       trust this directory, or the run refuses to start
  --force                       allow shell commands, or every one of them is rejected
  --sandbox disabled            its own shell sandbox off, because Nolzu's wall holds the run
  --resume <session id>         continue an earlier session
  --list-models                 the model list
```

The prompt goes on stdin and never into the argument list, so it cannot show up in a process
listing. There is no effort flag: the effort is part of the model id, and some ids carry none.

Five flags the binary's help lists and Nolzu does not pass. `--mode plan` and `--mode ask` are the
read-only modes, and the section below says why they are not used. `--auto-review` sends each call
to a server classifier that runs the safe ones and prompts for the rest, and a headless run cannot
answer a prompt. `--workspace` and `--add-dir` name folders, and a run wrote a file two folders above
its working folder without either, so neither is a limit. `--sandbox enabled` did not hold a run to
reading in the measurement below, so Nolzu turns it off and holds the run in its own wall.

## Two refusals before a run starts

A directory the person has never trusted refuses a headless run with exit 1 and no JSON at all:

```
⚠ Workspace Trust Required
  To proceed, you can either:
    • Run 'agent' interactively to decide
    • Pass --trust, --yolo, or -f if you trust this directory
```

Every card runs in a fresh worktree, so every first run in a card meets this. `--trust` is the flag
to pass, and the adapter passes it on every run. `-f` and `--yolo` also force-allow commands, which
is not what trusting a folder means.

A free Cursor plan refuses every named model:

```
ActionRequiredError: Named models unavailable Free plans can only use Auto.
Switch to Auto or upgrade plans to continue.
```

It arrives on stderr with exit 1, after the `system.init` and `user` lines. Nolzu always passes a
concrete model id and never `auto`, because `auto` lets the vendor change the model inside a run, so
a free account cannot run Nolzu. `cursorFailure` reads that sentence off stderr and the run fails
with a sentence a person can act on, rather than with an error class and two stream lines nobody
reads.

That is still a sentence after a card has waited, so the Engines screen says it before anybody
picks a model: every Cursor profile row carries the same two ways out as the failed card. Nothing
detects the plan, because no command reports it and the only sign is a failed run, so the row says
it to everybody. `planNote` in `apps/local/src/lib/engine-profiles.ts` holds that sentence. The
failure is matched on the English words "Named models unavailable", so a reworded message falls back
to the engine's own words.

## What the process prints

```json
{"type":"system","subtype":"init","apiKeySource":"login","cwd":"…",
 "session_id":"a2e5f188-…","model":"Auto","permissionMode":"default"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]},"session_id":"…"}
{"type":"thinking","subtype":"delta","text":"…","timestamp_ms":1790338076360}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"…"}]},
 "model_call_id":"…"}
{"type":"tool_call","subtype":"started|completed","call_id":"…",
 "tool_call":{"editToolCall":{…},"hookAdditionalContexts":[],"toolCallId":"…","startedAtMs":"…"}}
{"type":"interaction_query","subtype":"request|response","query_type":"createPlanRequestQuery",…}
{"type":"result","subtype":"success","duration_ms":6680,"duration_api_ms":6680,"is_error":false,
 "result":"…","session_id":"…","request_id":"…",
 "usage":{"inputTokens":17540,"outputTokens":341,"cacheReadTokens":4480,"cacheWriteTokens":0}}
```

The session id is `session_id` and every line carries it. The result line holds the final text, the
durations, an `is_error` flag and token counts, and no cost, so the complete event carries a null
cost.

A tool call is one object keyed by the tool's own name, such as `editToolCall` or
`createPlanToolCall`, with the engine's own `hookAdditionalContexts`, `toolCallId` and timestamps
beside it. The parser takes the first key that ends in `ToolCall`, so a reordered object cannot
make a bookkeeping field read as the tool, and a call with no such key produces no event, because a
name guessed from a bookkeeping field would be worse than no line in the log. Only the completed call is
read: the started one carries the same object without its answer.

`interaction_query` is a type the first measurement of this engine never saw. The parser ignores a
line it does not know, which is what keeps a new type from ending a run.

`permissionMode` reads `default` even in plan mode, so it does not report the mode the run is in and
nothing reads it.

### Tool results and tokens so far

A completed `tool_call` that worked carries its answer under `result.success`: the text of a read
under `content`, and other fields for other tools. Nolzu reads its size in bytes, the text where
there is one and the answer as the engine wrote it otherwise. A refused call has its own row and no
result. The counts arrive only on the `result` line, at the end of the run, so a Cursor run shows no
tokens so far while it works.

## Resume

`--resume <session id>` continues the session and keeps the id. A resumed run proved it remembers
the earlier turn.

## Why a read-only phase on Cursor needs the wall

`--mode plan` holds in two places and then does not hold at all. The runs that measured it, all on
2026-09-25, passed `--model auto`, because the login they ran on is a free plan and Auto is the only
model a free plan runs. Nolzu itself never passes `auto`, so they prove the mode and the refusals,
not the flags a card would use.

A write to a file that is not markdown is refused, and the tool answers under `result.error`, with
an empty path and no arguments at all, so the event names the tool and no file.

```json
{"tool_call":{"editToolCall":{"result":{"error":{"path":"","error":"Cannot edit non markdown files in plan mode"}}}}}
```

The mode also allows an edit to any markdown file the process can reach. A run appended a line to a
`.md` file in its working folder and wrote a new `.md` file two levels above it, both with no flag
and no refusal.

Then the mode was left. Asked for an edit to a non-markdown file, a plan-mode run called a tool of
its own, `switchModeToolCall`, with `{"targetModeId":"agent"}`, and the engine answered
`{"success":{"fromModeId":"plan","toModeId":"agent"}}`. The edit that followed was written to disk.
The run was repeated with `--sandbox enabled` and the file was written again. So plan mode is a mode
and not a limit: the model can decide to leave it, and the only sign is a tool call in the stream.

That is why only Nolzu's wall holds a read-only phase on Cursor. Where the wall starts, every phase
runs. Where it cannot, every run but implement is refused before the process starts: refine, plan,
QA, the wrap-up, optimize, Learn this project, Learn your repositories, architecture, design, investigate, research,
pr-review, triage of a card's pull request comments, the Scout assessment, and the two passes (the plain summary and the commit message). The
sentence names the check that failed, such as installing bubblewrap, and says to run the phase on a
Claude Code profile until then. The rule is `vendorRefusal` in `packages/core/src/phase-policy.ts`.

## The wall

Every Cursor run starts inside Nolzu's wall: `sandbox-exec` on macOS, `bwrap` on Linux and inside
WSL 2. Implement
can write the checkout, its git folder and the card folder, and nothing else outside Cursor's own
session folders and files. `~/.cursor/cli-config.json` is one of them, and Nolzu stops the card when
a run changed the permissions in it. The CLI saves that file through a temp file beside it and a
rename, and on macOS the wall opens that temp name too. On Linux, where a bound file cannot be
renamed over, `~/.cursor` opens whole: what was in it stays read-only but the session folders and
files, and Nolzu stops the card when the run added any other name there or replaced an entry. Every run is denied `~/.ssh`, `~/.aws`, `~/.gnupg`, the project's `.env` files and
the logins of the other engines, and `~/.cursor/mcp.json`, `~/.cursor/hooks.json`, the rules and the
checkout's `.cursor` and `.claude` folders stay read-only, so a run cannot plant a hook for a later run. Cursor's
own sandbox is off with `--sandbox disabled`, because a macOS sandbox cannot start inside another
one. The first line of the run log says which wall holds the run. Where the wall cannot start,
implement runs without it, under Cursor's own shell sandbox, and the log says the run is not walled.

## The shell

`--force` is passed on every run, and without it there is no shell at all.

```json
{"tool_call":{"shellToolCall":{"result":{"rejected":{"command":"ls -1 .","reason":"","isReadonly":false}}}}}
```

Measured twice on 2026-09-25, in a plain `-p` run with no mode flag: three shell calls, three
rejections, and the run still ended `result.subtype=success, is_error=false`. So this is not about
plan mode. The same prompt with `--force` ran the command and exited 0. An implement run without the
flag would read the project, run no test, no build and no git command, and report a green run, since
a refusal is evidence in the log and not a verdict.

`--force` is what the help calls "force allow commands unless explicitly denied". It is the same
trust the project's own test command already has, and it is the trust the implement phase needs.

## The phase instructions

Cursor is handed the phase instructions as a file, as every engine is,
`<card folder>/<phase>/instructions.md`, which the runner writes from the same skill at the start of
the run. The prompt names that file. `codex.md` says how the file is built.

## The model list

`--list-models` prints 241 ids in colour, one per line, as `<id> - <label>`. The adapter strips the
colours, reads the id off each line, and drops `auto`. The heading and the tip line the list ends
with carry no dash after their first word, so neither reads as a model.

`auto` is one of the 241. Of the other 240, 224 carry an effort inside them (`none`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `extra-high` or `max`, with or without a `-fast` or `-thinking`
suffix). 16 carry none at all:
`gpt-5.3-codex`, `composer-2.5`, `gemini-3.1-pro` and `kimi-k2.7-code` are four of them. So the id
goes to `--model` exactly as the list printed it, and the effort stored in the action table is not
read for this engine. Appending it would ask for `gpt-5.3-codex-medium`, which the engine does not
offer.

The list comes from the login, so it is a network call and not a bundled table, and this is the one
place where it differs from the Codex list, which the binary holds and answers in under a
millisecond. It took 1.1 seconds. A screen reads it on every board snapshot and every page load, so
it is cached, and the key is the binary together with the login folder, because two logins answer
with two lists. An empty answer is cached for thirty seconds as well: it costs the full ten second
timeout to get, and without that a line that is down would hold up every snapshot for ten seconds,
again and again.

`listModels` has no job and no profile behind it, so the screens show the list of whatever login the
app's own environment points at. With two Cursor logins on one machine, a run under the second still
checks its model against its own list, but the picker shows the first one's models.

The list was not tested offline or with a dead login: an empty answer is reported as the engine
missing, which is right for a binary that is not installed and wrong for a login that expired.

## A second login

`CURSOR_CONFIG_DIR` points at the config folder. The installed bundle reads it first, then
`XDG_CONFIG_HOME`, then its own default. Two logins were proved apart on one machine:
`cursor-agent status` under each folder names a different account. Nolzu sets the variable per
process and never opens the folder.

Check login on the Engines screen runs that same `cursor-agent status` with the profile's
`CURSOR_CONFIG_DIR`. The authentication page gives no exit code and no output format, so the words
decide: "not logged in" or "not authenticated" is signed out, and "logged in" with exit 0 is signed
in. Anything else shows as a failed check, with the words. On 2026-10-15 a login answered
"✓ Logged in as" its account with 0, and an empty home answered "Not logged in" with 0 as well, so
the exit code says nothing here. An empty `CURSOR_CONFIG_DIR` answered with the login the machine
already had, so a new folder reads as signed in, under that account, until it gets a login of its
own. The account in the answer says which one it is.

## Variables that outrank the flags

`CURSOR_API_KEY` replaces the login, and `CURSOR_API_ENDPOINT` sends the run somewhere else. Both
are in the binary's own help. A run that inherited either from the person's shell would not be the
run the card describes, so `engineEnv` drops both from the child environment, and `CURSOR_CONFIG_DIR`
is set by Nolzu rather than inherited.

## What a Cursor row still shows and nothing acts on

The card's Settings tab draws an effort for every action row, out of three fixed words, whatever
engine profile the row names. Cursor reads no effort: the id carries it, and nothing in this adapter
reads the stored effort. The engine profile and the model of each row are the row's own, from the
profile's model list.

## The limit signal

Nothing in the stream reports a usage window, so the limit block for this engine reads "not
available". That is a normal state and not a gap.

Whether a paid account that runs out of quota answers in the same `ActionRequiredError` shape as the
free-plan refusal was not run.

## What the isolation flags do not remove

The default config folder can hold `mcp.json` with its servers, and the folders `skills-cursor/`,
`plugins/`, `agents/` and `projects/`. A run under the default profile can reach
all of them. A run measured on 2026-09-25 shows one of them acting. The started call carried
`"command":"ls -1 ."` and the rejected result of the same call carried the same command with a
wrapper program in front of it, which no prompt named. So something in the default config folder
rewrites a shell command before it runs. `--approve-mcps`
exists, so a headless run can also be pointed at servers Nolzu never chose.

A profile with its own `CURSOR_CONFIG_DIR` gets none of this, because the whole folder moves with
the variable. That is the way to run a card against a known configuration, and it is not the default.

## MCP servers

Cursor takes no MCP config file on the command line. It reads `.cursor/mcp.json` at its project root:
the nearest folder at or above the one it starts in that holds a `.git` (`src/mcp/project-paths.ts` in
2026.10.22), or the start folder when none does. So a run gets the servers of the project's MCP list
that its phase is on for merged into that file, before the process starts, and `--approve-mcps`,
because a print run cannot ask to start a server. A Delivery card starts in its checkout, which is its
own root. A Research card starts in its card folder, which holds checkouts and no `.git`, so its root
is the project folder. A server of the folder's own file with the same name gives way, and
a stdio server goes in with `type: "stdio"`; Cursor's docs name no type for SSE or streamable HTTP,
which it reads from the address.

A secret goes into the merged file as a reference, `${env:NOLZU_MCP_SECRET_<tag>_<n>}`, and its value
into cursor-agent's environment under that name. The tag is random for each run, because Cursor fills
such a reference in every entry it loads, and a plain value of another file could name a fixed one.
Cursor's MCP docs list `env` and `headers` among the fields it reads `${env:NAME}` in, and its CLI MCP
docs say the CLI uses the same configuration as the editor. Neither was measured on a real run. The
shell tool inherits cursor-agent's environment and the docs name no filter, so the agent can read the
value. The run log says so for each server with a secret: "On Cursor the agent's shell can read the
secret of <name>." The first real run with a secret should check whether `--approve-mcps` stores the
filled-in config under the profile's config folder.

The merge goes through `writablePath`, and Nolzu keeps the path and the file's old bytes in the run's
folder, so the file goes back after the run, or at the next start after a crash or a kill. A `.cursor`
folder Nolzu makes gets a `.gitignore` that names `/mcp.json` and itself; in one that was there, Nolzu adds its own line to the
repository's `info/exclude` and takes only that line out, once no other run still needs it. Either way
`git add` does not take the merge. Nolzu merges only for a run that starts in QA's copy or under `worktrees/`,
only when the root lies inside the copy or the project, and never where the root's repository tracks
`.cursor/mcp.json`. Two Research cards of one project share the project folder's file, so a second
Cursor run with servers waits until the first has put the file back. Its log says so, and again every
few minutes, so the quiet timeout does not stop a run that only waits. The read-only check of another
card leaves the merged file and its `.gitignore` out, as Nolzu's own write, unless the repository
tracks them. While a run goes, an editor open on that folder sees the merged file as well. A change
made to the file during the run, by hand or through Cursor's settings, is kept: Nolzu then takes out
only its own servers and gives back one of the same name the file held before. Cursor has no setting to limit single
tools of a server. `--approve-mcps` approves every server Cursor finds: those of the person's own
`~/.cursor/mcp.json`, and, as Cursor's MCP docs say, those of a `.cursor/mcp.json` in a parent folder.
No flag or variable leaves them out, as the section above says. A run that called a merged server's tool has
not been seen yet.
