// The line a person types once to sign a tool in to one profile's folder. Its own module, because the
// add form builds it in the browser as the folder is typed. Nolzu shows it with Copy and never runs it.
export function signInLine(login: string, variable: string, folder: string): string {
  const typed = folder.trim();
  if (variable === null || typed === '') return login;
  return `${variable}=${shellWord(typed)} ${login}`;
}

// A leading ~ stays outside the quotes, where the shell still reads it as the home folder.
function shellWord(folder: string): string {
  if (/^[\w@%+=:,./~-]+$/.test(folder)) return folder;
  const home = folder.startsWith('~/') ? '~/' : '';
  return `${home}'${folder.slice(home.length).replaceAll("'", "'\\''")}'`;
}
