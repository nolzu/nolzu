import type { ProjectFilesStatus } from './onboard.ts';

// The one status line for the project files, in the app and under Write the project files. A folder a
// newer Nolzu wrote has its own line, since an update would leave it alone. Null when there is nothing
// to say.
export function filesStatusLine(status: ProjectFilesStatus | null): string | null {
  if (status === null) return null;
  if (status.newer !== null) return status.newer;
  const moves = status.moves ?? 0;
  const kept = status.kept ?? 0;
  const said = [
    status.updates.length > 0 ? 'Nolzu has newer project files for this project.' : moves === 0 ? null : moves === 1 ? '1 knowledge file waits to move into the folder of its repository.' : `${moves} knowledge files wait to move into the folders of their repositories.`,
    kept === 0 ? null : `${kept === 1 ? '1 knowledge file stays at its old place' : `${kept} knowledge files stay at their old place`}, because a file is at the new place already. Merge ${kept === 1 ? 'it' : 'them'} by hand.`,
  ].filter((one) => one !== null);
  return said.length === 0 ? null : said.join(' ');
}

// Whether Update has anything to do: a project file to write or a knowledge file to move.
export const filesOffer = (status: ProjectFilesStatus | null): boolean => status !== null && status.newer === null && (status.updates.length > 0 || (status.moves ?? 0) > 0);

const files = (count: number) => (count === 1 ? '1 file' : `${count} files`);

// What an update did, in the words the notice shows after its button.
export function filesUpdatedLine(updated: number, project: string | null): string {
  if (updated === 0) return 'The project files were up to date.';
  const commit = `Commit ${updated === 1 ? 'it' : 'them'}`;
  return project === null ? `Updated ${files(updated)}. ${commit}.` : `Updated ${files(updated)}. ${commit} in ${project}.`;
}

export function handEditedLine(count: number): string | null {
  if (count === 0) return null;
  return `${files(count)} ${count === 1 ? 'was' : 'were'} changed by hand and kept your text.`;
}

// The ask before "Take the new one" writes over a file whose text git does not hold, on the page and in
// the server's refusal, which is the ask a page without JavaScript gets.
export const unsavedLine = (path: string): string => `git has not committed your changes to ${path}. Taking the new one loses them.`;
