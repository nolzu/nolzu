// What both sides of the knowledge feature have to agree on: the status a change row carries, the
// key a run that belongs to no card uses, and how a knowledge file's frontmatter reads, which the
// Knowledge screen and the output check both read.

/**
 * The key a knowledge run that belongs to no card carries.
 *
 * Reserved. The runner writes it on the rows of a maintenance run, such
 * as Optimize, and the Knowledge screen reads it to show "maintenance" where a card's row shows a
 * link. It lives here because a second copy of the string would let the two sides drift apart.
 */
export const KB_MAINTENANCE_KEY = 'kb-maintenance';

// Learn your repositories runs once per repository, each under a key of its own, so the queue takes
// them all at once and the knowledge lane runs them one after another. The key names the repository,
// because the run, the fake engine and the review all read it back from there.
const LEARN_REPO_PREFIX = 'kb-learn-';
export const learnRepoKey = (repo: string): string => `${LEARN_REPO_PREFIX}${repo}`;

/** The repository a Learn your repositories key is about, or null when the key is not one. */
export const repoOfLearnKey = (key: string): string | null => (key.startsWith(LEARN_REPO_PREFIX) && key.length > LEARN_REPO_PREFIX.length ? key.slice(LEARN_REPO_PREFIX.length) : null);

// A knowledge run that belongs to no card: Optimize and Learn this project under the reserved key,
// and each Learn your repositories run. None of them has a card a screen could link to.
export const isMaintenanceKey = (key: string | null | undefined): boolean => key === KB_MAINTENANCE_KEY || (key != null && repoOfLearnKey(key) !== null);

// applied: the change is in the folder and committed. reverted: a revert commit took it back.
// pending: it waits for a person, and has no commit yet. returned: a person sent it back with a
// note, so it was never applied and the note is what the next run of that card reads.
export type KnowledgeStatus = 'applied' | 'reverted' | 'pending' | 'returned';

// Where the frontmatter block of a knowledge file ends, or -1 for a file with none. Only a block at the
// very top, between two `---` lines, is frontmatter. A block further down is text of the file.
export function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return -1;
  return lines.findIndex((line, index) => index > 0 && line.trim() === '---');
}
const frontmatter = (text: string): string[] | null => {
  const lines = text.split('\n');
  const end = frontmatterEnd(lines);
  return end === -1 ? null : lines.slice(1, end);
};

/**
 * The description a knowledge file carries in its frontmatter: the line the knowledge index shows a
 * run, and the Knowledge screen shows beside the file.
 *
 * Only a `description:` key of its own inside that block. Quotes around the value come off, because
 * they belong to the file format and not to the sentence.
 */
export function frontmatterDescription(text: string): string | null {
  for (const line of frontmatter(text) ?? []) {
    const found = /^description:\s*(.*)$/.exec(line);
    if (found === null) continue;
    const value = found[1]?.trim() ?? '';
    const bare = /^(['"])(.*)\1$/.exec(value);
    const said = (bare === null ? value : (bare[2] ?? '')).trim();
    return said === '' ? null : said;
  }
  return null;
}

/**
 * The paths a knowledge file says it depends on, from its `paths:` key: a comma list, a bracket list,
 * or `- ` lines under the key. The Knowledge screen checks each one against the base branch.
 *
 * Quotes, backticks, a leading `./`, a line number and a folder's last slash come off, because the
 * file is what the note depends on. Each path once, because the screen keys its list by path. Empty
 * for a file with no key, which is every file from before the entry shape.
 */
export function frontmatterPaths(text: string): string[] {
  const lines = frontmatter(text) ?? [];
  const at = lines.findIndex((line) => /^paths:/.test(line));
  if (at === -1) return [];
  const inline = (lines[at] ?? '').slice('paths:'.length).trim().replace(/^\[(.*)\]$/, '$1');
  const rest = lines.slice(at + 1);
  // YAML lets a list sit at the key's own indent, so `- ` with no indent belongs to the key too.
  const stop = rest.findIndex((line) => !/^\s*- /.test(line));
  const listed = inline !== '' ? inline.split(',') : rest.slice(0, stop === -1 ? undefined : stop).map((line) => line.replace(/^\s*- /, ''));
  const paths = listed
    .map((one) => one.trim().replace(/^(['"`])(.*)\1$/, '$2').replace(/^\.\//, '').replace(/:\d+(-\d+)?$/, '').replace(/\/+$/, ''))
    .filter((one) => one !== '' && one.toLowerCase() !== 'none');
  return [...new Set(paths)];
}
