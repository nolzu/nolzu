// The Folder field of New project and the idea page. Pure, so the pages run it in the browser.

// The folder follows the project name until the person types in it. A slash in a name would put the
// folder inside another, so it becomes a dash.
export const folderOf = (name: string): string => `~/${name.trim().replace(/[/\\]+/g, '-')}`;

// The typed folder as the server reads it (`resolveProjectPath`): from the home folder unless it
// starts with a slash, with . and .. read. Limit: a .. above ~ stays at ~ here, because the page
// does not know the home folder's own path; the server still reads it right.
export function shownFolder(typed: string): string {
  const value = typed.trim();
  if (value === '') return '';
  const absolute = value.startsWith('/');
  const rest = absolute ? value : value === '~' || value.startsWith('~/') ? value.slice(1) : `/${value}`;
  const parts: string[] = [];
  for (const part of rest.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '' && part !== '.') parts.push(part);
  }
  return absolute ? `/${parts.join('/')}` : ['~', ...parts].join('/');
}

// The name and a typed folder go along on the link between New project and the idea page, both
// ways, so nothing is typed twice. A folder still following the name stays out, so it goes on
// following it on the other page.
export function carried(path: string, name: string, folder: string | null): string {
  const query = new URLSearchParams();
  if (name !== '') query.set('name', name);
  if (folder !== null) query.set('folder', folder);
  const said = query.toString();
  return said === '' ? path : `${path}?${said}`;
}
