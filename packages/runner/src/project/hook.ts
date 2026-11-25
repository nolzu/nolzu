// The PreToolUse guard Nolzu writes into a project, as source text, because onboarding writes it
// into the project rather than shipping it from the package.
//
// It refuses with exit code 2 and a line on stderr, and never prints a decision on stdout. A
// decision there is parsed as JSON, and anything a shell profile prints would corrupt it, while
// nothing can corrupt an exit code.
//
// The card folder arrives in the environment, because it changes per run while this file does not.
export const PHASE_GUARD = `import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

// Written by Nolzu. Keeps a read-only phase inside the card's own folder, because the engine
// cannot scope a tool to a path and the run passes --permission-mode acceptEdits.
const WRITES = ['Write', 'Edit', 'NotebookEdit'];

function refuse(what, allowed) {
  const where = allowed.join(' or ') || 'the card folder';
  process.stderr.write('This phase may only write inside ' + where + '. Refused: ' + what + '\\n');
  process.exit(2);
}

// Every other run is none of this file's business.
if (process.env.NOLZU_READ_ONLY !== '1') process.exit(0);

let call;
try {
  call = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  // Nothing readable arrived, so there is nothing to judge. Refusing here would stop every run.
  process.exit(0);
}

const taskDir = process.env.NOLZU_TASK_DIR;
if (!taskDir) process.exit(0);

// The card folder always, and the knowledge folder for a phase that writes knowledge. A wrap-up
// has to write outside the card folder and must still not touch the project's source, so the two
// folders are named and everything else is refused.
const allowed = [taskDir, process.env.NOLZU_KNOWLEDGE_DIR].filter(Boolean).map((dir) => resolve(dir));

const name = call.tool_name;
// A command can write anything, so a guarded phase does not get one unless it was given one. QA
// is the phase that was: running the project's own checks is its whole job. Every other guarded
// phase edits files and runs nothing.
if (name === 'Bash' && process.env.NOLZU_ALLOW_COMMANDS !== '1') {
  refuse((call.tool_input && call.tool_input.command) || 'a command', allowed);
}
// A tool this file does not know is allowed, rather than stopping the run over a name.
if (!WRITES.includes(name)) process.exit(0);

const target = resolve((call.tool_input && call.tool_input.file_path) || '');
// The separator matters: without it a folder named APP-1-other passes as APP-1.
const inside = allowed.some((dir) => target === dir || target.startsWith(dir + sep));
if (!inside) refuse(target, allowed);
process.exit(0);
`;
