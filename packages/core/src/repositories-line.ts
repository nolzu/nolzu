// The line may sit in a list item or in bold, so a leading marker and the emphasis around the label
// do not hide it.
const LINE = /^(?:[-+>]\s*|\*\s+)*[*_]*repositories[*_]*:[*_]*(.*)$/i;

/**
 * The repositories a refine or plan run named for its card, from the line that ends its file.
 *
 * The last `Repositories: a, b` line counts, because plan can quote refine's line and then give its
 * own. A name matches the project's path whatever its case, and comes back in the project's
 * spelling. Names the project does not list come back apart, so the caller can drop them and say
 * which. Null when there is no such line, which means the run named nothing.
 */
export function repositoriesLine(text: string, known: readonly string[]): { known: string[]; unknown: string[] } | null {
  const last = text
    .split('\n')
    .map((line) => LINE.exec(line.trim())?.[1])
    .filter((rest) => rest !== undefined)
    .at(-1);
  if (last === undefined) return null;
  // An agent may write a name in backticks or as a folder with its slash.
  const names = last
    .split(',')
    .map((name) => name.trim().replace(/^`(.*)`$/, '$1').trim())
    .map((name) => (name.length > 1 ? name.replace(/\/+$/, '') : name))
    .filter((name) => name !== '')
    .map((name) => known.find((path) => path.toLowerCase() === name.toLowerCase()) ?? name);
  const unique = [...new Set(names)];
  return { known: unique.filter((name) => known.includes(name)), unknown: unique.filter((name) => !known.includes(name)) };
}
