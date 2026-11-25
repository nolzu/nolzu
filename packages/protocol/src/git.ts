// One row of the Changes tab. Ahead and behind count against the base branch and not the
// upstream, because a project can have no remote at all. `unpushed` is null in that case,
// which is different from zero.
export interface WorktreeRow {
  repo: string;
  path: string;
  branch: string | null;
  base: string;
  ahead: number;
  behind: number;
  changed: number;
  untracked: number;
  unpushed: number | null;
  stale: boolean;
  staleReason: string | null;
}

export type DiffStatus = 'added' | 'changed' | 'deleted' | 'renamed';

export interface DiffEntry {
  path: string;
  // Set only for a rename, so the tab can show both paths and still count the file once.
  oldPath: string | null;
  status: DiffStatus;
  added: number;
  removed: number;
  binary: boolean;
}

export interface DiffStat {
  files: number;
  added: number;
  removed: number;
}

// A folder node collapses a single child chain, so a deep path reads as one row.
export interface FileTreeNode {
  name: string;
  path: string;
  children: readonly FileTreeNode[];
  entry: DiffEntry | null;
}

// One group of the card's work on the Changes tab: its totals and its files as a tree.
export interface ChangeGroup {
  stat: DiffStat;
  tree: FileTreeNode[];
}

// Everything the Changes tab reads in one server load: the card's worktree row and its work in two
// groups, what is committed on its branch and what is only in the folder. Or the reason there is none.
// The groups are null on a stale row: git can list the checkout but cannot read it, and the row
// already says why.
export type Changes =
  // `untracked` names the files git does not track yet, which a commit adds only when ticked.
  // `conflicted` names the files a merge left with conflicts, such as after a pull into the checkout.
  // Optional, so a reader built before it reads a checkout with none.
  // `branch` is the base to the folder, what a push takes once the folder is committed, for the push
  // dialog's change. Optional for the same reason.
  // `pushes` is that change from where the upstream and the branch part, what the next push adds, for the
  // same dialog. Optional for the same reason.
  // `diff` is that same change as a tree, the one diff the tab draws and a comment is made on.
  // Optional for the same reason.
  // `commits` is the branch's own commits, newest first, read only when the Not committed view has
  // nothing to show, so a repository with work in its folder costs no extra git call.
  | {
      ok: true;
      row: WorktreeRow;
      committed: ChangeGroup | null;
      uncommitted: ChangeGroup | null;
      untracked: string[];
      conflicted?: string[];
      branch?: DiffStat;
      pushes?: DiffStat;
      diff?: ChangeGroup;
      commits?: BranchCommits;
    }
  | { ok: false; reason: string };

// One commit of the card's branch since its base. `pushed` is read off the upstream, so a branch that
// tracks nothing has every commit not pushed.
export interface BranchCommit {
  sha: string;
  short: string;
  subject: string;
  pushed: boolean;
}

// The newest commits up to a cap, and how many the branch holds in all, for the "and N older" line.
// `reason` says why git could not list them, with an empty list.
export interface BranchCommits {
  list: BranchCommit[];
  total: number;
  reason?: string;
}

// The two views of the Changes tab: what a commit would take now, and the base to the folder.
export type ChangesView = 'uncommitted' | 'all';

// The view the tab opens on. The address wins, so a reload and a link keep the person's pick. In
// Review with no commit yet, the tab opens on the whole change, because that is where a person reads
// it and comments for Implement. Everywhere else it opens on what is not committed.
export function changesView(asked: string | null, stage: string, committed: boolean): ChangesView {
  if (asked === 'all' || asked === 'uncommitted') return asked;
  return stage === 'review' && !committed ? 'all' : 'uncommitted';
}

// Files a commit would take now: tracked changes against the last commit, staged or not, and untracked
// files. A stale checkout counts too, so its reason shows. The Not committed view shows these
// repositories and folds the rest.
export function hasUncommitted(changes: Changes): boolean {
  return changes.ok && (changes.row.stale || (changes.uncommitted?.stat.files ?? 0) > 0);
}

// Whether the card did anything in a repository: a change against the base, a file not committed, a
// commit ahead, or a stale checkout to look at. The Changes tab shows only these repositories and folds
// the rest into one line, and the server reads no push facts for the others.
export function hasWork(changes: Changes): boolean {
  if (!changes.ok) return false;
  const { row } = changes;
  return row.stale || (changes.diff?.stat.files ?? 0) > 0 || row.changed + row.untracked > 0 || row.ahead > 0;
}

// A person's comment on one line of a card's diff. `line` is the line's number in the file as it is in
// the card's folder, and `lineText` the line as it read then, so the line is found again after an edit
// moves it. `commit` is the commit the checkout was on then. `sentAt` stays null until the comment goes
// back to Implement with a send back.
export interface DiffComment {
  id: number;
  repo: string;
  file: string;
  line: number;
  lineText: string;
  text: string;
  commit: string;
  createdAt: string;
  sentAt: string | null;
}

// Not every remote can produce one: a project with no remote, or one on a host that is not
// GitHub, gets the reason instead, which the button shows in place of a link.
export type CompareUrl = { ok: true; url: string } | { ok: false; reason: string };

// The hosts Nolzu can build a compare URL and a pull request against. Anything else is
// reported by name rather than guessed at, because guessing an owner out of a URL shape
// that does not match sends the person to a page that does not exist.
export type GitHost = 'github' | 'gitlab';

export interface Remote {
  name: string;
  host: GitHost;
  owner: string;
  repo: string;
}

// A remote that resolved keeps the parsed parts. One on a host Nolzu does not know keeps
// its raw URL instead, so the screen can show what it found.
export type ScannedRemote = ({ supported: true } & Remote) | { supported: false; name: string; url: string };

// A detached HEAD has no branch to work from, so the scan reports the commit and the
// person picks the base themselves. `unborn` is a name with no commit behind it, which a
// repository has before its first commit and after its checked out branch was deleted:
// branching from it fails later and away from the cause, so it is said here instead.
export type BaseBranch =
  | { kind: 'branch'; name: string }
  | { kind: 'unborn'; name: string }
  | { kind: 'detached'; commit: string };

export interface ScannedRepo {
  // Relative to the scanned folder, and "." for the folder itself, so one repository and
  // one of several read the same way.
  path: string;
  base: BaseBranch;
  remotes: readonly ScannedRemote[];
}

// The name a card's branch would get. A template a person edited can be one git refuses, and the
// repositories, the base branch and the remotes are still worth reporting, so the problem travels
// with the preview rather than failing the whole scan.
export type BranchPreview = { ok: true; name: string } | { ok: false; reason: string };

// One repository or several, never nothing: a folder with no repository is the failed
// case, because there is nothing to put a card on.
export type ProjectScan =
  | { ok: true; repos: readonly ScannedRepo[]; branchPreview: BranchPreview }
  | { ok: false; reason: string };
