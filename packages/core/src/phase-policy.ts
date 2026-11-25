import { ASK_PHASE, isPass, phaseLabel } from '@nolzu/protocol';

// The tool that runs a command. A read-only phase gets it only by saying `commands`. Write and Edit
// are not the line: every phase writes its own summary and its artifact, and Edit changes no file
// Write could not overwrite. The engine cannot scope a tool to a path, so the limit to
// `.tasks/<key>/` is enforced by a PreToolUse hook that onboarding writes into the project, for
// Write and Edit alike. The prompt says it too, but the hook is what holds.
export const CHANGE_TOOLS = ['Bash'] as const;

// Every name the engine's built-in set offers that any phase may ask for. The engine drops a name
// it does not know without a word, so a typo in a row would take a tool away in silence, and this
// list is what catches that. Nothing checks the list itself: it was read off Claude Code 2.1.273 by
// hand, so it has to be checked again when the engine's major version changes, the same way the
// flags in docs/engines/claude-code.md are.
export const KNOWN_TOOLS = ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash'] as const;

const READ_AND_SEARCH = ['Read', 'Grep', 'Glob'] as const;
// Edit beside Write, because a run that fixes a line of its own file calls Edit, and without it the
// call fails and the run writes the whole file again.
const READ_AND_NOTE = [...READ_AND_SEARCH, 'Write', 'Edit'] as const;

export interface PhasePolicy {
  // Names from the engine's built-in set. The argument builder refuses an empty list, because
  // empty does not mean every tool, it means the policy missed the phase.
  tools: readonly string[];
  // True when the phase may not change the project's code. It still writes its own notes. The
  // runtime contract reads this to say so in the prompt, which is where the limit to the card's
  // own folder lives.
  readOnly: boolean;
  /**
   * Whether a guarded phase may run a command.
   *
   * QA needs one: its whole job is running the project's own checks, and a phase with no `Bash`
   * cannot run a single one. It still may not edit the project's code, so the guard keeps refusing
   * a write outside the card folder.
   *
   * What this buys and what it does not. A command can write anything, so this is not a wall: it
   * is the same trust the project's own test command already has. What it stops is the agent
   * editing a source file to make a check pass, which is the failure mode QA exists to catch. A
   * phase that may write anywhere sets `readOnly` false and never needs this.
   */
  commands?: boolean;
  /**
   * Whether the phase writes the project's knowledge.
   *
   * The wrap-up, Optimize and Learn this project are the three that do. Such a run is handed the knowledge folder, the guard allows a
   * write inside it as well as inside the card folder, and the job takes the knowledge lane. Every
   * other phase leaves this unset, because a phase that could write knowledge with nobody
   * committing what it wrote would leave the folder changed and no row saying who changed it.
   */
  knowledge?: boolean;
  /**
   * Whether what this knowledge run writes always waits for a person, whatever the review setting
   * says. Learn this project writes from what people wrote and said, not from finished work, so a
   * person reads it before it reaches the folder.
   */
  alwaysHeld?: boolean;
  /**
   * Whether the run may read git: `READ_GIT_COMMANDS`, beside the project's own commands.
   *
   * QA checks a criterion such as "only this file changed" against the branch, and with no git it
   * could only end blocked and ask a person to run the diff.
   */
  readGit?: boolean;
}

// The git commands that only read, for a phase with `readGit`. A Claude Code pattern cannot stop a
// flag such as `--output`, so this is the wall's job: QA can write only its copy and the card folder.
export const READ_GIT_COMMANDS: readonly string[] = ['git diff', 'git diff *', 'git status', 'git status *', 'git log', 'git log *', 'git show *'];

// One row per phase that starts a run. A phase missing from here throws rather than running with
// nothing, because write access is granted here and nowhere else.
export const PHASE_POLICIES: Readonly<Record<string, PhasePolicy>> = {
  refine: { tools: READ_AND_NOTE, readOnly: true },
  plan: { tools: READ_AND_NOTE, readOnly: true },
  implement: { tools: [...READ_AND_NOTE, ...CHANGE_TOOLS], readOnly: false },
  // The third shape. QA runs the project's checks and writes its report into the card folder, and
  // the guard refuses every write and edit outside it: QA reports what is true, and fixing is a
  // separate run on the implement phase. Its browser, like every phase's MCP servers, comes from the
  // project's MCP list when the run starts, not from this table.
  qa: { tools: [...READ_AND_NOTE, 'Bash'], readOnly: true, commands: true, readGit: true },
  // The fourth shape. A wrap-up reads the card folder and writes knowledge, with no `Bash`: the
  // runner makes the commit, so the phase needs no command at all.
  wrapup: { tools: READ_AND_NOTE, readOnly: true, knowledge: true },
  // The same shape as the wrap-up, because the job is the same one: read the knowledge folder,
  // correct one file in it, and leave the commit to the runner. It belongs to no card, so it
  // carries the reserved key and takes the knowledge lane like every other run that writes there.
  optimize: { tools: READ_AND_NOTE, readOnly: true, knowledge: true },
  // Learn this project, the third run that writes knowledge. The wrap-up's shape: it reads the
  // project's own docs and writes a few knowledge files, with no command and no change to the code.
  // A person starts it, and what it wrote waits for their review on the Knowledge screen.
  orient: { tools: READ_AND_NOTE, readOnly: true, knowledge: true, alwaysHeld: true },
  // Learn your repositories, one run per repository: the same shape, reading that repository's README,
  // CI and stack files and writing its repository file and its run recipe section, held for review.
  'learn-repo': { tools: READ_AND_NOTE, readOnly: true, knowledge: true, alwaysHeld: true },
  // The five phases of the other four boards. Every one of them reads the project and writes its
  // own file in the card folder, which is the refine shape, so they take it: reading, searching,
  // `Write` and `Edit`, and no command. None of them changes the project, and `pr-review` pushes
  // nothing either, because a review is a file a person reads and not a comment posted anywhere.
  //
  // Each of them is named by a stage and has a row in the action table, which is where its engine
  // profile, its model and its effort come from, so a forward drop onto that stage starts it.
  //
  // `investigate` and `research` read what a person typed: the ticket text, the extra context on the
  // card, and any file the person copied into the card folder themselves. Nothing here writes that
  // file, and nothing has to. A run whose card says nothing in its title, its ticket text or its
  // extra context asks for input and stops, which is what both skills say, so neither of them
  // invents the data it was not given. The title alone is enough to run on, because that is what
  // most cards carry and the prompt always holds it.
  architecture: { tools: READ_AND_NOTE, readOnly: true },
  design: { tools: READ_AND_NOTE, readOnly: true },
  investigate: { tools: READ_AND_NOTE, readOnly: true },
  research: { tools: READ_AND_NOTE, readOnly: true },
  'pr-review': { tools: READ_AND_NOTE, readOnly: true },
  // Triage of the comments on a card's own pull request, the pr-review shape. It reads the comments
  // file the runner wrote into the card folder and the code they point at, and writes its verdicts
  // into the card folder. It posts nothing: a drafted reply is copied by the person.
  feedback: { tools: READ_AND_NOTE, readOnly: true },
  // The Scout assessment, which reads a finding and writes what it found in the card folder. The
  // refine shape again, and each of the four limits an assessment has comes from one
  // part of it. `readOnly`, so the guard refuses a write or an edit outside its folder. No
  // `commands`, so the guard refuses every `Bash` call, and a shell write and a git write are both
  // only reachable through one. No `knowledge`, so the guard allows the card folder and nothing
  // else. No MCP server from this table beside the fixed `--strict-mcp-config`, and a tool list drawn from
  // `KNOWN_TOOLS`, which names no network tool, is what leaves no external write either.
  assess: { tools: READ_AND_NOTE, readOnly: true },
};



// The pass that writes a missing plain summary. It is not a phase: it has no skill and no stage.
// Everything it needs is in its prompt, and the argument builder refuses an empty list, so it gets
// reading and nothing else.
export const EXTRACT_SUMMARY_POLICY: PhasePolicy = { tools: ['Read'], readOnly: true };

// The read-only session of an Ask message. It reads the card's code and the card
// folder and writes nothing, so it gets reading and searching and no tool that writes: Claude Code is
// handed only these, and the guard still refuses a write outside the card folder and every command.
// Its answer is its last message, so it needs no file of its own. It has no skill: the prompt holds
// the whole method (`askPrompt`), so it is not in the table the skills are checked against.
export const ASK_POLICY: PhasePolicy = { tools: READ_AND_SEARCH, readOnly: true };

// The vendors that may run when the project folder is not a git repository. Only Claude Code until
// the others are measured in such a folder. A vendor that passes that measurement is added here,
// and the job builder, the spawn, the "Run on" offer, the board drop and the Settings rows all
// follow from this one list.
const RUNS_OUTSIDE_GIT: readonly string[] = ['claude-code'];

// Whether Nolzu's wall can start on this machine. The runner probes it once (`wallHere`), and the
// server hands the answer to every caller, so a screen offers what the spawn would start.
export type WallState = { ready: true } | { ready: false; reason: string };

// Where a run would start: the project folder may not be a git repository, and the wall may not start.
export interface RunPlace {
  outsideGit: boolean;
  wall: WallState;
}

/**
 * Why this vendor cannot run this phase here, or null when it can.
 *
 * It lives here rather than in each spawn function, because the screen that offers a phase on
 * another profile has to read the same rule the spawn enforces. An offer the spawn would refuse
 * costs the person a click and a card that fails for a reason nobody could see coming.
 *
 * Where the wall starts, every engine runs every phase. Where it cannot, Claude Code still runs
 * every phase under its guard, Codex runs every phase under its own sandbox, and Cursor runs
 * Implement only. The sentence names the check that failed.
 */
export function vendorRefusal(vendor: string, phase: string, place: RunPlace): string | null {
  // First, because no other profile setting repairs it: only a Claude Code profile does.
  if (place.outsideGit && !RUNS_OUTSIDE_GIT.includes(vendor)) {
    return 'The project folder is not a git repository, and Claude Code is the one engine known to run in a folder like that. Run this phase on a Claude Code profile.';
  }
  if (place.wall.ready) return null;
  // Codex needs no refusal here: it falls back to its own sandbox, which holds a read-only phase to
  // the card folder (`startsInCardFolder`), adds the knowledge folder for the runs that write knowledge,
  // and lets QA write its throwaway copy.
  const policy = policyFor(phase);
  const missing = place.wall.reason;
  // Measured on 2026-09-25: a Cursor run in plan mode called `switchModeToolCall` and wrote a source
  // file. Only the wall holds it to reading.
  if (vendor === 'cursor' && policy.readOnly) {
    return `The ${phaseLabel(phase)} phase may not change the project, and only Nolzu's wall holds Cursor to reading, because a run in plan mode can write. The wall cannot start here. ${missing} Until then, run this phase on a Claude Code profile.`;
  }
  return null;
}

/**
 * True when this vendor runs this phase from the card folder instead of the card's checkout.
 *
 * Only Codex under its own sandbox does. Codex has no read-only mode that leaves the card folder
 * writable: `-s read-only` refuses every write. Starting in the card folder under
 * `-s workspace-write` gives the same limit from the other side, because the sandbox makes the
 * working folder the writable area and the project lies outside it. Measured on 2026-09-26 and
 * written up in `docs/engines/codex.md`. The runs that write knowledge add the knowledge folder as a
 * writable root. QA runs the project's own checks, which write caches, so it starts in its throwaway
 * copy instead, with the card folder added.
 *
 * `ownSandbox` is `ownSandbox` in the runner: the Codex row of `ENGINE_WALLS`, or a wall that cannot
 * start on this machine. While it is false, Codex runs inside Nolzu's wall like every other engine,
 * the wall makes the card folder writable, and every phase starts in the checkout.
 *
 * The prompt and the spawn both read this, because the paths the prompt names are relative to the
 * folder the process starts in. A resume reads where its session started instead, so a run made
 * under the other setting still resumes in its own folder. The summary pass writes nothing, so it
 * keeps the read-only sandbox in the checkout.
 */
export function startsInCardFolder(vendor: string, phase: string, ownSandbox: boolean): boolean {
  if (vendor !== 'codex' || !ownSandbox) return false;
  const policy = policyFor(phase);
  if (policy.commands === true) return false;
  return policy.readOnly && policy.tools.some((tool) => tool === 'Write' || tool === 'Edit');
}

/** The policy a phase runs under. */
export function policyFor(phase: string): PhasePolicy {
  // The two passes and Ask have no skill, so they are not in the table the skills are checked
  // against. The passes read text they are handed, Ask reads the code, and none of them writes.
  if (isPass(phase)) return EXTRACT_SUMMARY_POLICY;
  if (phase === ASK_PHASE) return ASK_POLICY;
  // hasOwn, so a phase named after something on Object's prototype gets this message and not a
  // row that was never written.
  const row = Object.hasOwn(PHASE_POLICIES, phase) ? PHASE_POLICIES[phase] : undefined;
  if (row === undefined) {
    throw new Error(`The phase ${JSON.stringify(phase)} has no row in PHASE_POLICIES. Add one there, rather than letting a run inherit write access.`);
  }
  return row;
}
