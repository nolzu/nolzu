import { isAbsolute, join, resolve } from 'node:path';
import { allowedCommandProblem } from '@nolzu/core';
import type { Job } from '@nolzu/protocol';
import { guardLeadingDash, guardName } from './args-guard.ts';

// The levels this engine takes. `Effort` is a string, because a Codex model names up to six of
// them, so each adapter holds its own list and refuses a level its engine does not know.
const EFFORTS = ['low', 'medium', 'high'];

// Pure, so every isolation and model choice is checked without starting a process. The
// prompt is not here on purpose: it goes to the engine on stdin, so it cannot show up in a
// process listing and cannot hit the argument length limit.
export function claudeArgs(job: Job): string[] {
  if (job.sessionId !== null && job.resumeFrom !== null) {
    throw new Error(
      'A job set sessionId and resumeFrom together. Set sessionId to start a fresh run, or resumeFrom to continue an earlier one, never both.',
    );
  }
  if (!EFFORTS.includes(job.effort)) {
    throw new Error(`The effort ${JSON.stringify(job.effort)} is not one of ${EFFORTS.join(', ')}.`);
  }
  if (job.tools.length === 0) {
    throw new Error(`The phase ${JSON.stringify(job.phase)} lists no tools. An empty list does not mean every tool, it means the policy missed this phase.`);
  }

  const args = [
    '-p',
    '--output-format',
    'stream-json',
    // stream-json refuses to start without it.
    '--verbose',
    // The two isolation flags. Without them a run picks up the user's own MCP servers and
    // session hooks. docs/engines/claude-code.md holds what was measured and why safe mode
    // is not among them.
    '--strict-mcp-config',
    '--setting-sources',
    'project',
    // Without a permission mode the engine runs in default mode and refuses every write, so a
    // phase cannot even write its own summary. The path limit does not come from here: the engine
    // cannot scope a tool to a path, so onboarding writes a PreToolUse hook into the project that
    // refuses a write outside the card's own folder for a read-only phase.
    '--permission-mode',
    'acceptEdits',
  ];

  // The card folder lies outside the working folder, and the engine refuses a write there in every
  // mode unless the folder is added. Absolute, because the engine resolves a relative one against
  // the working folder, which is the one place the card folder is not. An absolute path starts with
  // a slash, so it cannot be read as a flag either.
  if (!isAbsolute(job.taskDir)) {
    throw new Error(`The card folder ${JSON.stringify(job.taskDir)} is not an absolute path, so the engine cannot be pointed at it.`);
  }
  // The knowledge folder of a run that writes knowledge lies outside the working folder as well, and
  // the engine refuses even a read there without it. The runner hands one only to those phases.
  const knowledge = job.knowledgeDir ?? null;
  if (knowledge !== null && !isAbsolute(knowledge)) {
    throw new Error(`The knowledge folder ${JSON.stringify(knowledge)} is not an absolute path, so the engine cannot be pointed at it.`);
  }
  args.push('--add-dir', job.taskDir, ...(knowledge === null ? [] : [knowledge]));

  // The guard lives in the project, and the run works in the card's worktree, which does not read it.
  // Named here, it loads wherever the run works.
  if (job.settingsPath !== null) {
    if (!isAbsolute(job.settingsPath)) {
      throw new Error(`The settings file ${JSON.stringify(job.settingsPath)} is not an absolute path, so the engine would resolve it against the card checkout, where it is not.`);
    }
    args.push('--settings', job.settingsPath);
  }

  if (job.mcpConfigPath !== null) {
    // A project folder may hold a space, so only a leading dash is refused here.
    args.push('--mcp-config', guardLeadingDash(job.mcpConfigPath, 'MCP config path'));
  }

  // The project's commands, for a phase that holds Bash at all. One entry per command and never a
  // bare `Bash`, which would allow every command. Before `--model`, so the flag's list of values
  // ends at a flag. docs/engines/claude-code.md holds the pattern syntax.
  const commands = job.tools.includes('Bash') ? (job.allowedCommands ?? []) : [];
  for (const command of commands) {
    const problem = allowedCommandProblem(command);
    if (problem !== null) throw new Error(`The project's allowed commands hold one the engine cannot take. ${problem}`);
  }
  // One flag holds both lists, so the values still end at `--model`.
  // A server's tools, by server name, so they are not refused call by call. A server with a tool list
  // gets those tools by name and no other.
  const servers =
    job.mcpConfigPath === null
      ? []
      : Object.keys({ ...job.mcp?.stdio, ...job.mcp?.remote }).flatMap((name) => {
          const server = `mcp__${guardName(name, 'MCP server name')}`;
          const tools = job.mcp?.rules[name]?.tools ?? [];
          return tools.length === 0 ? [server] : tools.map((tool) => `${server}__${guardName(tool, 'MCP tool name')}`);
        });
  const allowed = [...commands.map((command) => `Bash(${command.trim()})`), ...projectFileReads(job), ...outsideFileReads(job), ...servers];
  if (allowed.length > 0) args.push('--allowedTools', ...allowed);

  args.push('--model', guardName(job.model, 'model'));
  args.push('--effort', job.effort);
  args.push('--tools', job.tools.map((tool) => guardName(tool, 'tool name')).join(','));

  if (job.resumeFrom !== null) {
    args.push('--resume', guardName(job.resumeFrom, 'session id'));
  } else if (job.sessionId !== null) {
    args.push('--session-id', guardName(job.sessionId, 'session id'));
  }

  return args;
}

// The file the project's CLAUDE.md points at. Claude Code loads that CLAUDE.md from the parent of
// a card checkout, but refuses a Read there as "outside allowed working directories". A Read allow
// rule opens one file and grants no write, where `--add-dir` on the project would open it to edits.
// Per the permissions page of the Claude Code docs, a rule path that starts with `//` is absolute from
// the filesystem root, a single `/` is relative to the settings source, and the pattern is gitignore
// syntax. Added whether or not the files exist: a rule for a missing file opens nothing.
const PROJECT_FILES = ['AGENTS.md'];

function projectFileReads(job: Job): string[] {
  const project = job.projectDir ?? null;
  if (project === null) return [];
  if (!isAbsolute(project)) {
    throw new Error(`The project folder ${JSON.stringify(project)} is not an absolute path, so no rule can name its files.`);
  }
  // A run that starts in the project folder reads it already.
  if (resolve(project) === resolve(job.cwd)) return [];
  // Limit: a folder name a gitignore pattern reads as a wildcard is skipped, not escaped. The run
  // then cannot read the file, as before. Escape it if such a folder ever shows up.
  if (/[*?[\]\\()]/.test(project)) return [];
  return PROJECT_FILES.map((name) => `Read(/${join(resolve(project), name)})`);
}

// The epic's documents a task's run reads, and the other files outside the checkout its prompt names.
// They lie outside the checkout and the card's own folder, so each one needs a Read rule, built the way
// the project files' rules are.
// The rule names the epic's whole card folder where the path shows it, because a run lists the folder
// before it reads, and a Glob of the folder matches no rule that names files. Claude Code applies Read
// rules to Glob and Grep too. The folder holds the epic's phase outputs and nothing else.
// The knowledge folder the index lists gets one folder rule the same way, and never for a run that
// writes knowledge, which has the folder through `--add-dir`.
function outsideFileReads(job: Job): string[] {
  const knowledge = job.knowledgeDir == null ? (job.knowledgeReadDir ?? null) : null;
  if (knowledge !== null && !isAbsolute(knowledge)) {
    throw new Error(`The knowledge folder ${JSON.stringify(knowledge)} is not an absolute path, so no rule can name it.`);
  }
  const rules = [...(job.epicFiles ?? []), ...(job.readFiles ?? [])].flatMap((file) => {
    if (!isAbsolute(file)) throw new Error(`The file ${JSON.stringify(file)} is not an absolute path, so no rule can name it.`);
    // Limit: skipped like a project folder with a wildcard in its name, and the run then cannot read it.
    if (/[*?[\]\\()]/.test(file)) return [];
    const folder = /^(.*\/\.tasks\/[^/]+)\//.exec(resolve(file))?.[1];
    return [folder === undefined ? `Read(/${resolve(file)})` : `Read(/${folder}/**)`];
  });
  const folder = knowledge === null || /[*?[\]\\()]/.test(knowledge) ? [] : [`Read(/${resolve(knowledge)}/**)`];
  return [...new Set([...rules, ...folder])];
}
