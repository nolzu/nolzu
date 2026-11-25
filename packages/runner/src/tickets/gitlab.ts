import { cardKeyOf, type Ticket } from '@nolzu/protocol';
import { cliRunner, type RunCli } from './cli.ts';

/**
 * The GitLab Issues adapter, through `glab`.
 *
 * The twin of the GitHub adapter and not of the Jira one: `glab` holds the login, so this adapter
 * keeps no token, nothing of GitLab goes into the keychain, and there is no site address to check.
 * Read-only, the rule for every ticket adapter in the free client.
 *
 * NOT RECORDED. Nolzu has not called the real GitLab API yet, so no answer from it has been read
 * here, and this file breaks, on purpose, the rule that an adapter starts from a recorded answer.
 *
 * What is measured is `glab` itself: version 1.86.0, whose own help was read on
 * 2026-09-28. Every flag below comes from that help, so the call shape is not a guess. What is
 * written from GitLab's documented REST shape, and therefore a guess, is the JSON
 * `glab issue list --output json` prints and the words a refused call prints. `gitlab.test.ts` names
 * field by field what a first real call has to confirm. Until somebody makes one, treat a GitLab
 * finding as unverified.
 */

export type RunGlab = RunCli;

const INSTALL = 'Install the GitLab CLI from https://gitlab.com/gitlab-org/cli, then start Nolzu again.';
// One read here is a page of a project's issues, so there is no single issue to open instead. A
// description may hold a megabyte, so a page of long ones is the way past the cap, and a narrower
// search is the only thing the person can do about it.
const CUT = 'Narrow the issue search in the source on the Scout page, so glab sends fewer issues.';

export const glabRunner = (options: { path?: () => string; maxStdout?: number } = {}): RunGlab =>
  cliRunner({ bin: 'glab', system: 'GitLab', install: INSTALL, cut: CUT, ...options });

/**
 * A project path, as `glab --repo` takes it.
 *
 * A namespace and a project, or a group, a subgroup and a project. The leading character may not be
 * a dash, so nothing a person types can reach `glab` as a flag of its own. An underscore is allowed
 * there, because GitLab allows a path to start with one. The arguments never go through a shell, so
 * nothing else has to be kept out.
 */
const PROJECT = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)+$/;

// GitLab caps a page at 100. Above it the API answers its own maximum rather than what was asked.
const MAX_PAGE = 100;

/**
 * The key a GitLab issue gets: the project's own name and the number, `project#42`, with no group.
 *
 * A key with a path in it names no folder, so its card could never run. The card keeps the reference
 * GitLab prints, `group/project#42`, as its source ref. Two groups' projects of one name share a key,
 * and Scout's Start refuses the second.
 */
export const gitlabKey = (project: string, iid: number): string => cardKeyOf(`${project}#${iid}`);

export interface IssueFilter {
  // Comma separated, which is what `--label` takes for several labels. Empty for no label filter.
  labels: string;
  // What is left for `--search`, which looks in the title and the description.
  search: string;
}

/**
 * One typed line, split into the two filters `glab issue list` has.
 *
 * The Scout form collects one field, because every field on a source form is required and a label
 * filter is not. So a word starting `label:` is read as a label and the rest as search text, which
 * is close enough to the GitHub qualifiers the sibling form asks for that one person can use both.
 *
 * A word that looks like another qualifier is refused rather than searched for. The GitHub form sits
 * one row above this one and its placeholder teaches `is:open`, so a person will type it here. Sent
 * on as search text it matches nothing, and the check would answer that the project is quiet.
 *
 * Limit: no quoting and no other qualifier. A phrase with spaces still searches, because the
 * words that are not labels are joined back together. Add a parser when somebody needs `author:`.
 */
export function issueFilter(terms: string | undefined): IssueFilter {
  const labels: string[] = [];
  const words: string[] = [];
  for (const word of (terms ?? '').trim().split(/\s+/)) {
    if (word === '') continue;
    // A bare `label:` names no label. Dropping it keeps an unfinished line from filtering on nothing.
    if (word.toLowerCase().startsWith('label:')) {
      const named = word.slice('label:'.length).trim();
      if (named !== '') labels.push(named);
      continue;
    }
    // Not a URL: a colon followed by a slash is an address somebody pasted into the search.
    if (/^[A-Za-z_-]+:[^\s/]\S*$/.test(word)) {
      throw new Error(`Nolzu does not read "${word}" in a GitLab issue search. Only label:name is a filter here, and every other word is searched for in the title and the description. Remove it, or write it without the colon.`);
    }
    words.push(word);
  }
  return { labels: labels.join(','), search: words.join(' ') };
}

/**
 * The arguments for one read.
 *
 * `--output json` because the text output is drawn for a terminal. `--opened` because a page of closed
 * issues read and thrown away is a page of open ones nobody sees: the flag is not in the FLAGS block of
 * `glab issue list --help`, but its own examples use it and `glab issue list --opened --badflag` names
 * only `--badflag`, so it is a real flag on glab 1.86.0. `readGitLabIssues` drops anything that is not
 * open as well, so a flag that stops working cannot put a closed issue on the board.
 */
export function glabListArgs(project: string, filter: IssueFilter, limit: number): string[] {
  if (!PROJECT.test(project)) {
    throw new Error(`${project === '' ? 'The project' : project} is not a GitLab project path. Write it as namespace/project, such as acme/app, or group/subgroup/app.`);
  }
  const args = ['issue', 'list', '--repo', project, '--opened', '--output', 'json', '--per-page', String(Math.min(limit, MAX_PAGE))];
  if (filter.labels !== '') args.push('--label', filter.labels);
  if (filter.search !== '') args.push('--search', filter.search);
  return args;
}

/**
 * What a refused call says, or null when the call looks like an answer.
 *
 * HAND WRITTEN. `glab`'s own words for these states were not read, because reading them needs a
 * GitLab account. Both lists are the markers a first real call has to confirm or replace, and they
 * live here as one constant each so that confirming them is one edit.
 *
 * A non-zero exit is trusted here, unlike in the GitHub adapter. That one asks for twenty issues in
 * one document and exits non-zero when one of the twenty failed, so it has good rows to keep. This
 * is one project in one call: either it answered or it did not.
 */
const NO_LOGIN_SAID = ['401', 'unauthorized', 'authenticat', 'no token', 'glab auth login'];
// `404` alone, and not `not found` as well. A bare `not found` also catches `failed to read
// configuration: file not found`, which sends the person to edit a project path that is already
// right. A wrong GITLAB_HOST still lands here, because Go prints `404 page not found`; a first real
// call is what tells us whether that state deserves a marker of its own.
const NOT_MINE_SAID = ['404'];

export function glabRefusal(project: string, code: number, stderr: string): string | null {
  if (code === 0) return null;
  // The URL goes first. `glab` echoes the request it made, the markers below are bare digits, and the
  // URL carries the project path, so a project called `acme/http-401-fix` would read as no login.
  const said = stderr.toLowerCase().replace(/https?:\/\/\S+/g, ' ');
  // First, because a `glab` with no login never gets as far as a 404 about the project.
  if (NO_LOGIN_SAID.some((marker) => said.includes(marker))) {
    return 'glab has no GitLab login, so nothing was read. Run glab auth login in a terminal, then check the source again.';
  }
  if (NOT_MINE_SAID.some((marker) => said.includes(marker))) {
    return `GitLab has no project ${project} that your glab login can see. Check the project path in the source on the Scout page, and that your login may open that project.`;
  }
  // Its own words, because this version does not know what happened and a sentence that guessed
  // would send the person the wrong way. `glab` draws a box: measured against 1.86.0 on 2026-09-28, an
  // unknown flag prints a blank line, then `ERROR` alone, then the message, then a usage line. So the
  // first line that is neither blank nor that heading is the message, and the usage line stays out.
  const printed = stderr.split('\n').map((line) => line.trim()).find((line) => line !== '' && line !== 'ERROR' && line !== 'WARNING') ?? '';
  return `glab could not read the issues of ${project}${printed === '' ? '' : `. It said: ${printed}`}. Run glab issue list --repo ${project} in a terminal to see what it says.`;
}

interface Row {
  iid?: unknown;
  title?: unknown;
  description?: unknown;
  state?: unknown;
  web_url?: unknown;
}

/**
 * The issues in one answer.
 *
 * An answer that is not a list of issues is refused and never read as an empty backlog. The GitHub
 * adapter had this bug: a rate limited `gh api` prints readable JSON carrying a
 * `message` and no items, so it parsed, and a repository nobody had read looked like a clear
 * backlog. `glab` reports a refusal on stderr rather than as a body, but a person cannot tell "no
 * open issues" from "never read" either way, so the shape is checked here too.
 *
 * `state` is asserted as well as left to the default, the way `github-ci.ts` asserts `conclusion`: a
 * row that is not open is dropped rather than shown, so a flag that stops working cannot put closed
 * issues on the board.
 */
export function readGitLabIssues(project: string, stdout: string): readonly Ticket[] {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    throw new Error(`glab answered the issues of ${project} with something Nolzu could not read. Run glab issue list --repo ${project} --output json in a terminal to see what it says.`);
  }
  if (!Array.isArray(rows)) {
    throw new Error(`glab did not list the issues of ${project}. Check the project path in the source on the Scout page, and that your glab login may read its issues.`);
  }

  const found: Ticket[] = [];
  for (const row of rows) {
    // An element that is not an object would throw a TypeError on the next line, and that sentence
    // would reach the source on the Scout page as it is.
    if (typeof row !== 'object' || row === null) continue;
    if ((row as Row).state !== 'opened') continue;
    // The number a person reads and the one in every GitLab reference. `id` is the instance wide one
    // and means nothing to anybody, so a row without an `iid` is dropped rather than keyed by it.
    const { iid, title, description, web_url: url } = row as Row;
    if (typeof iid !== 'number' || !Number.isInteger(iid) || iid < 1) continue;
    found.push({
      key: gitlabKey(project, iid),
      title: typeof title === 'string' ? title : '',
      body: typeof description === 'string' ? description : '',
      state: 'open',
      url: typeof url === 'string' && url !== '' ? url : null,
      // No parent. A GitLab issue hangs under an epic, an epic belongs to a group and not to the
      // project, and its number lives in the group's own space. A key built from it would collide
      // with an issue key, so nothing is claimed. The GitHub search path answers none either.
      parentKey: null,
    });
  }
  // Rows came back and not one of them fitted. The field names above are the unmeasured part of this
  // file, so a wrong guess has to land as a refusal here: dropping every row silently would say the
  // project has no open work, which is the lie the array check above exists to stop.
  if (rows.length > 0 && found.length === 0) {
    throw new Error(`glab listed ${rows.length} issues of ${project}, and none of them carried the fields this version reads: a state of "opened" and an "iid" number. Nothing is reported, rather than an empty backlog. Run glab issue list --repo ${project} --output json in a terminal to see the field names.`);
  }
  return found;
}

/**
 * The open issues of one project, through `glab`.
 *
 * One call. `glab` resolves the project and holds the login, so there is nothing to look up first.
 */
export async function gitlabIssues(run: RunGlab, project: string, terms: string | undefined, limit: number, signal: AbortSignal): Promise<readonly Ticket[]> {
  const args = glabListArgs(project, issueFilter(terms), limit);
  const answer = await run(args, signal);
  const refused = glabRefusal(project, answer.code, answer.stderr);
  if (refused !== null) throw new Error(refused);
  return readGitLabIssues(project, answer.stdout);
}
