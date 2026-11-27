import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withoutAttribution } from '@nolzu/core';
import { cardPullRows } from '@nolzu/core/node';
import type { CompareUrl } from '@nolzu/protocol';
import { compareUrl, type ExpectedPlaces, gitEnv, readCardText, parseRemoteUrl, pullBranch, type BranchPullResult, pushBranch, pushConfirmation, withoutCredentials, type PushResult } from '@nolzu/runner';
import { checkoutOf } from './checkout.ts';
import { markStep } from './coach.ts';
import { cardFolder } from './files.ts';
import { overviewFor } from './overview.ts';

// Step two of the composer: where the branch would go, whether it is there already, and the prefilled
// compare page on GitHub.
export type Publish =
  | {
      ok: true;
      branch: string;
      // The URL without any credential in it: this goes to the page, and a clone made with a token
      // carries the token in its remote URL.
      remote: { name: string; url: string } | null;
      // Where the remote is, as the push confirm names it: "GitHub" and "github.com/recipes-app/web".
      // The host is null for one Nolzu has no name for, and the place for a URL it cannot read.
      host: string | null;
      place: string | null;
      // The sentence the person agrees to before the push, or null with no remote.
      confirmation: string | null;
      pushed: boolean;
      compare: CompareUrl;
      // The card's open pull request from this remote, attached on the PRs tab. A push updates it, so
      // there is none to create.
      pull: { number: number; url: string } | null;
    }
  | { ok: false; reason: string };

// A child repository has its own remote, so a sentence about a missing one names it.
const owner = (repo: string): string => (repo === '.' ? 'This project' : repo);

const HOSTS: Readonly<Record<string, string>> = { 'github.com': 'GitHub', 'gitlab.com': 'GitLab' };

// One repository's checkout: its own remote, and a compare page against its own base.
export async function publishFor(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env, repo = '.'): Promise<Publish> {
  const at = await checkoutOf(db, key, env, 'push', repo);
  if (!at.ok) return at;

  // origin when there is one, as git itself would pick, and the first remote otherwise.
  const names = (await at.run(['remote'])).stdout.split('\n').map((name) => name.trim()).filter((name) => name !== '');
  const name = names.includes('origin') ? 'origin' : (names[0] ?? null);
  const url = name === null ? null : (await at.run(['remote', 'get-url', name])).stdout.trim();
  const remote = name === null || url === null ? null : { name, url: withoutCredentials(url) };
  const where = remote === null ? null : parseRemoteUrl(remote.url);
  // card_pulls is filled from GitHub only. A row no read has seen open yet may be merged already, so it
  // leaves Create pull request in place.
  const slug = where?.host === 'github.com' ? `${where.owner}/${where.repo}`.toLowerCase() : null;
  const found = cardPullRows(db, key).find((one) => one.repo === slug && one.state === 'open');
  const pull = found === undefined || where === null ? null : { number: found.number, url: found.url ?? `https://${where.host}/${where.owner}/${where.repo}/pull/${found.number}` };

  // Pushed means the upstream holds every commit of the branch.
  const upstream = await at.run(['rev-list', '--count', '@{upstream}..HEAD']);
  const pushed = upstream.code === 0 && upstream.stdout.trim() === '0';

  const base = at.base;
  const card = db.prepare('SELECT title FROM cards WHERE key = ?').get(key) as { title: string } | undefined;
  const subject = (await at.run(['log', '-1', '--format=%s', `${base}..HEAD`])).stdout.trim();
  const words = subject === '' ? (card?.title ?? '') : subject;
  // The key as a whole word, so APP-12 in a subject does not count as APP-1.
  const hasKey = new RegExp(`(^|[^A-Za-z0-9-])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`).test(words);
  const title = hasKey ? words : `${key} ${words}`;
  const body = pullRequestBody(overviewFor(db, key)?.summary ?? '', readPr(db, key, env));

  const compare: CompareUrl =
    remote === null
      ? { ok: false, reason: `${owner(repo)} has no remote, and a pull request needs a GitHub remote.` }
      : compareUrl({ remote: remote.url, base, head: at.branch, title, body });

  return {
    ok: true,
    branch: at.branch,
    remote,
    host: where === null ? null : (HOSTS[where.host] ?? null),
    place: where === null ? null : `${where.host}/${where.owner}/${where.repo}`,
    confirmation: remote === null ? null : pushConfirmation(at.branch, remote.name, remote.url),
    pushed,
    compare,
    pull,
  };
}

// The plain summary first, then the implement run's pull request text without its title line, which the
// commit subject already gives. compareUrl cuts from the end, so the
// summary is the part that stays. A line that names a tool as the writer never reaches the page, even
// from a pr.md written after the last run.
export function pullRequestBody(summary: string, pr: string | null): string {
  const rest = (pr ?? '').trim().split('\n').slice(1).join('\n').trim();
  return withoutAttribution([summary.trim(), rest].filter((part) => part !== '').join('\n\n'));
}

function readPr(db: DatabaseSync, key: string, env: Record<string, string | undefined>): string | null {
  const folder = cardFolder(db, key, env);
  // Never through a link a run left there: the text goes to GitHub.
  return folder === null ? null : readCardText(folder, join('implement', 'pr.md'));
}

// A push that has not answered in this long is waiting on something nobody can see.
const PUSH_TIMEOUT_MS = 120_000;

// The push, only with the confirmation, because it sends the branch to the git host.
export async function pushFor(
  db: DatabaseSync,
  key: string,
  confirmed: boolean,
  env: Record<string, string | undefined> = process.env,
  signal?: AbortSignal,
  repo = '.',
  // A pre-push hook runs only when the person ticked Run hooks for this push.
  hooks = false,
): Promise<PushResult> {
  if (!confirmed) return { ok: false, reason: 'A push needs the confirmation first. Nothing was sent.' };
  const ready = await remoteFor(db, key, env, 'push', repo);
  if (!ready.ok) return ready;
  const pushed = await pushBranch({ worktreePath: ready.path, repo: ready.place, branch: ready.branch, remote: ready.remote, hooks, env: ready.env, signal: stopAfter(signal) });
  // A push that went is the last step of Getting started.
  if (pushed.ok) markStep(db, 'push');
  return pushed;
}

export const stopAfter = (signal: AbortSignal | undefined): AbortSignal => AbortSignal.any([AbortSignal.timeout(PUSH_TIMEOUT_MS), ...(signal === undefined ? [] : [signal])]);

// What a push and a pull both need before git talks to the remote: a card with no run writing into its
// checkout, the checkout on its branch, a remote, and an ssh that cannot wait on a question.
async function remoteFor(
  db: DatabaseSync,
  key: string,
  env: Record<string, string | undefined>,
  what: 'push' | 'pull',
  repo: string,
): Promise<{ ok: true; path: string; branch: string; remote: string; env: Record<string, string>; place: ExpectedPlaces } | { ok: false; reason: string }> {
  const state = (db.prepare('SELECT state FROM cards WHERE key = ?').get(key) as { state: string } | undefined)?.state;
  if (state === 'queued' || state === 'running') return { ok: false, reason: `${key} is ${state}, and its run writes into this checkout. ${what === 'push' ? 'Push' : 'Pull'} once the run ends.` };
  const at = await checkoutOf(db, key, env, what, repo);
  if (!at.ok) return at;
  const found = await publishFor(db, key, env, repo);
  if (!found.ok || found.remote === null) {
    return { ok: false, reason: `${owner(repo)} has no remote, so there is nowhere to ${what === 'push' ? 'push' : 'pull from'}. Add one with git remote add, then try again.` };
  }
  return { ok: true, path: at.path, branch: at.branch, remote: found.remote.name, env: await remoteEnv(env, at.run), place: at.place };
}

// ssh asks its questions on the terminal the app was started from, where nobody looks: a new host key
// or a key with a passphrase would hold the push for good. Batch mode makes it answer no instead,
// unless the person set their own ssh command. The Workspace page's push uses it too.
export async function remoteEnv(env: Record<string, string | undefined>, run: (args: readonly string[]) => Promise<{ stdout: string }>): Promise<Record<string, string>> {
  const own = env.GIT_SSH_COMMAND ?? env.GIT_SSH ?? (await run(['config', 'core.sshCommand'])).stdout.trim();
  return own === '' ? { ...gitEnv(env), GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' } : gitEnv(env);
}

/**
 * Pulls what someone else pushed to the card's branch into the card's checkout of one repository, after
 * a push the remote turned down. Only that checkout changes, and a conflict stops with the merge left
 * open, so the Changes tab can say which files to fix. Nothing is pushed, forced or reset.
 */
export async function pullFor(db: DatabaseSync, key: string, env: Record<string, string | undefined> = process.env, signal?: AbortSignal, repo = '.'): Promise<BranchPullResult> {
  const ready = await remoteFor(db, key, env, 'pull', repo);
  if (!ready.ok) return { ok: false, reason: ready.reason, conflicts: [] };
  return pullBranch({ worktreePath: ready.path, repo: ready.place, branch: ready.branch, remote: ready.remote, env: ready.env, signal: stopAfter(signal) });
}
