import type { ProjectScan, ScannedRemote } from '@nolzu/protocol';

const HOSTS: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab' };
// Pull requests and compare links are built for GitHub only in this version.
const SUPPORTED = ['github'];

// The repository is named when it is not the project folder, so two repositories' origins can be told apart.
const host = (path: string, remote: ScannedRemote) => {
  const id = `${path}:${remote.name}`;
  const repo = path === '.' ? undefined : path;
  if (!remote.supported) return { id, repo, remote: remote.name, text: `${remote.url}: not supported yet`, supported: false };
  const name = `${HOSTS[remote.host] ?? remote.host}, ${remote.owner}/${remote.repo}`;
  const supported = SUPPORTED.includes(remote.host);
  return { id, repo, remote: remote.name, text: supported ? name : `${name}: not supported yet`, supported };
};

export function flowView(scan: ProjectScan | null): { hosts: { id: string; repo?: string; remote: string; text: string; supported: boolean }[]; noRemote: boolean; note: string | null } {
  // A folder that cannot be read says so; claiming it has no remote would hide the real reason.
  if (scan === null) return { hosts: [], noRemote: true, note: 'No project is set yet. Pull requests need a project with a remote.' };
  if (!scan.ok) return { hosts: [], noRemote: true, note: scan.reason };
  const hosts = scan.repos.flatMap((repo) => repo.remotes.map((remote) => host(repo.path, remote)));
  return {
    hosts,
    noRemote: hosts.length === 0,
    note: hosts.length === 0 ? 'This project has no remote. Pull requests need one, so add a remote before a card is done.' : null,
  };
}
