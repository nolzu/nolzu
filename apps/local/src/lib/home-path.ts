// A folder as a person reads it, with the home folder as ~. On its own so the launcher can use it
// without loading the board code that rail.ts pulls in.
export function homePath(path: string, home: string): string {
  const root = home.replace(/\/+$/, '');
  if (root === '') return path;
  const plain = path.replace(/\/+$/, '');
  if (plain === root) return '~';
  return plain.startsWith(`${root}/`) ? `~${plain.slice(root.length)}` : path;
}
