import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A folder this package ships, as a path.
 *
 * Resolved through the package and not through a module's own place. A bundler inlines these
 * modules into the app and copies no folder beside them, so a path built from `import.meta.url`
 * lands next to the bundled file and nothing is there. The built client read `shared/finish.md`
 * that way, and every extraction pass in it threw before a person saw a summary.
 */
export const packageFolder = (name: 'skills' | 'shared'): string => {
  try {
    return join(dirname(createRequire(import.meta.url).resolve('@nolzu/skills/package.json')), name);
  } catch {
    // An installed client has no package to resolve. Its command names the folder the build copied.
    const copied = process.env.NOLZU_SKILLS_DIR;
    if (copied) return join(copied, name);
    // Running from the package's own source, where the folder is next to it.
    return fileURLToPath(new URL(`../${name}`, import.meta.url));
  }
};

// The skills this package ships.
export const skillsFolder = (): string => packageFolder('skills');

// The files Nolzu writes into a project. They say what the folders are for and how a run behaves, in
// the words a person reads too, because the agent reads the same file. One file, AGENTS.md, which
// Codex and Cursor read on their own and the pointer file names for Claude Code.
export const AGENTS_MD = `# This project and Nolzu

Nolzu runs an AI agent on this machine when a card moves forward on the board. Each card gets its own
git checkout, so a run never edits the files you are working on.

- \`worktrees/<card key>/\` is a card's own checkout, on its own branch. It is removed when the card is
  cleaned up.
- \`.tasks/<card key>/\` holds what a card's runs wrote: the refined ticket, the plan, and what the
  implement run left behind. It stays after the checkout is gone.

Nothing here is secret to Nolzu: both folders are ordinary files you can read, change and delete.

## Rules for a run

These rules are for an agent Nolzu started for a card. Nolzu sets NOLZU_TASK_DIR for such a
run; without it, this section is not about you.

- Work only inside this checkout. It is yours; no other card and no person is editing it.
- Write what the phase produces into the card folder the prompt names, not into the project root.
- Refine and plan runs read the project and write nothing else. Implement runs change the code.
- Commit nothing. A person reads the diff and commits.
`;

export const pointerFile = (name: string): string => `# ${name}

Read AGENTS.md for what this project is, how a card runs, and the rules a run follows here.
`;
