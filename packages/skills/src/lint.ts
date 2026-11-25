import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

export interface LintIssue {
  skill: string;
  message: string;
}

export interface LintResult {
  checked: number;
  issues: LintIssue[];
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// The Agent Skills spec bounds `name` at 64 characters and refuses a hyphen at either
// end or two in a row. The regex already refuses those; the length check is separate
// because a name make of one long word has no hyphen to catch it.
export function isValidSkillName(name: string): boolean {
  return name.length >= 1 && name.length <= 64 && NAME_RE.test(name);
}

type FrontmatterResult = { ok: true; data: Record<string, unknown>; body: string } | { ok: false; error: string };

// Claude Code only reads frontmatter that starts on line one and closes with a second
// `---` line. Anything else, it silently ignores, so that shape is a hard requirement
// here, separate from YAML syntax.
export function parseFrontmatter(text: string): FrontmatterResult {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { ok: false, error: 'frontmatter must start on the first line' };
  }
  const closeIndex = lines.indexOf('---', 1);
  if (closeIndex === -1) {
    return { ok: false, error: 'frontmatter has no closing "---" line' };
  }
  let data: unknown;
  try {
    data = parse(lines.slice(1, closeIndex).join('\n'));
  } catch (error) {
    return { ok: false, error: `frontmatter does not parse: ${(error as Error).message}` };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'frontmatter must be a YAML mapping' };
  }
  return { ok: true, data: data as Record<string, unknown>, body: lines.slice(closeIndex + 1).join('\n') };
}

const LINK_RE = /\]\(([^)]+)\)/g;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

function brokenLinks(body: string, skillDir: string): string[] {
  const broken: string[] = [];
  for (const match of body.matchAll(LINK_RE)) {
    const target = match[1]?.trim();
    if (!target || SCHEME_RE.test(target) || target.startsWith('#')) continue;
    const withoutFragment = target.split('#')[0];
    if (!withoutFragment) continue;
    if (!existsSync(path.join(skillDir, withoutFragment))) broken.push(target);
  }
  return broken;
}

export async function lintSkills(skillsDir: string): Promise<LintResult> {
  const issues: LintIssue[] = [];
  let entries;
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return { checked: 0, issues: [] };
  }
  const skillDirs = entries.filter((entry) => entry.isDirectory());

  for (const entry of skillDirs) {
    const skill = entry.name;
    const skillDir = path.join(skillsDir, skill);
    let text: string;
    try {
      text = await readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
    } catch {
      issues.push({ skill, message: 'missing SKILL.md' });
      continue;
    }

    const frontmatter = parseFrontmatter(text);
    if (!frontmatter.ok) {
      issues.push({ skill, message: frontmatter.error });
      continue;
    }

    const { name, description } = frontmatter.data;
    if (typeof name !== 'string' || !isValidSkillName(name)) {
      issues.push({
        skill,
        message: 'name must be 1-64 lowercase letters, digits and hyphens, with no leading, trailing or doubled hyphen',
      });
    } else if (name !== skill) {
      issues.push({ skill, message: `name "${name}" does not match the folder name "${skill}"` });
    }

    if (typeof description !== 'string' || description.length < 1 || description.length > 1024) {
      issues.push({ skill, message: 'description must be 1-1024 characters' });
    }

    if ('model' in frontmatter.data) {
      issues.push({ skill, message: 'frontmatter must not set model, it overrides the product model settings' });
    }

    for (const target of brokenLinks(frontmatter.body, skillDir)) {
      issues.push({ skill, message: `link target does not resolve: ${target}` });
    }
  }

  return { checked: skillDirs.length, issues };
}
