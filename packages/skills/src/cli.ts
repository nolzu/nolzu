import path from 'node:path';
import { lintSkills } from './lint.ts';

// The package's own skills, or the folder named on the command line, such as the copy synced into a
// project, so the check CI runs can be pointed at what a project holds.
const skillsDir = process.argv[2] ?? path.join(import.meta.dirname, '..', 'skills');
const result = await lintSkills(skillsDir);

for (const issue of result.issues) {
  console.error(`${issue.skill}: ${issue.message}`);
}

console.log(`checked ${result.checked} skill${result.checked === 1 ? '' : 's'}`);

if (result.issues.length > 0) {
  process.exitCode = 1;
}
