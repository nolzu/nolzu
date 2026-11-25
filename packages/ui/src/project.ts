import type { BaseBranch, ProjectScan, ScannedRemote } from '@nolzu/protocol';

export interface ProjectRow {
  path: string;
  base: string;
  remotes: string;
}

export interface ProjectView {
  rows: ProjectRow[];
  refusal: string | null;
  // The branch name a card would get, or why git would refuse the template.
  preview: { ok: boolean; text: string } | null;
  canSave: boolean;
}

const base = (found: BaseBranch): string =>
  found.kind === 'branch' ? found.name : found.kind === 'unborn' ? `${found.name}, with no commit yet` : `a detached commit, ${found.commit}`;

const remote = (found: ScannedRemote): string =>
  found.supported ? `${found.name}: ${found.host}, ${found.owner}/${found.repo}` : `${found.name}: ${found.url}, not supported yet`;

// What the project step shows for a scan: one row per repository, or the reason there is nothing to use.
export function projectView(scan: ProjectScan): ProjectView {
  if (!scan.ok) return { rows: [], refusal: scan.reason, preview: null, canSave: false };
  return {
    rows: scan.repos.map((repo) => ({
      path: repo.path === '.' ? 'This folder' : repo.path,
      base: base(repo.base),
      remotes: repo.remotes.length === 0 ? 'no remote' : repo.remotes.map(remote).join('; '),
    })),
    refusal: null,
    preview: scan.branchPreview.ok ? { ok: true, text: scan.branchPreview.name } : { ok: false, text: scan.branchPreview.reason },
    canSave: scan.branchPreview.ok,
  };
}
