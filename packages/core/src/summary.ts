// The heading every phase writes above its plain summary. The skill writes it into summary.md as well
// sometimes, and the ticket page shows its own, so it comes off.
const HEADING = /^\s*#*\s*what changed, in plain words\s*$/i;

// The plain summary as the ticket page shows it: without a repeated heading, with the body's own line
// breaks, and empty when there is nothing but whitespace.
export function cleanSummary(text: string): string {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first !== -1 && HEADING.test(lines[first]!)) lines.splice(first, 1);
  return lines.join('\n').trim();
}

// A phase that wrote no summary, or only whitespace, gets the extraction pass.
export function needsExtraction(text: string | null): boolean {
  return text === null || text.trim() === '';
}
