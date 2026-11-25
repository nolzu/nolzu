import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitlabIssues, gitlabKey, glabListArgs, glabRefusal, glabRunner, issueFilter, readGitLabIssues, type RunGlab } from './gitlab.ts';

/**
 * HALF MEASURED, AND NOT RECORDED.
 *
 * Measured against `glab` 1.86.0, so the call shape below is measured: every flag comes
 * from `glab --help`, `glab issue list --help`, `glab api --help`, `glab auth --help` and
 * `glab auth status --help`, all read on 2026-09-28. No answer has been read from GitLab, because
 * Nolzu has not called the real GitLab API yet. So the fixtures are hand written from GitLab's
 * documented REST shape, and the refusal markers from what each HTTP status means.
 *
 * A first real call has to confirm eight things about the answer: that `glab issue list --output json`
 * prints a JSON array at the top level and not an object with the rows under a field, that a row
 * carries `iid` as the number a person reads while `id` is the instance wide one, that `title` and
 * `description` are the title and the body, that `state` is the literal word `opened` for an open
 * issue and `closed` for a closed one, that `web_url` is the address a person can open, that
 * `--opened` really holds the page to open issues, that `--search` looks in the title and the
 * description by default, and that `--label` takes several labels comma separated and ANDs them.
 *
 * It has to confirm three things about a refusal: what a `glab` with no login prints and exits with,
 * what a project the login cannot see prints (GitLab answers 404 for a project that is not there and
 * for one that is hidden, so both should read the same), and that a refusal goes to stderr with a
 * non-zero exit rather than coming back as a JSON body on stdout. The two marker lists in `gitlab.ts`
 * are where that answer lands.
 */

// One issue row, as the REST shape documents it. The extra fields are there so a test proves the
// reader takes what it needs and is not confused by the rest.
const row = (iid: number, extra: Record<string, unknown> = {}) => ({
  id: 400_000 + iid,
  iid,
  project_id: 11,
  title: `Cache drops rows ${iid}`,
  description: 'The import keeps the first page only.',
  state: 'opened',
  web_url: `https://gitlab.com/acme/app/-/issues/${iid}`,
  labels: ['bug'],
  references: { short: `#${iid}`, relative: `#${iid}`, full: `acme/app#${iid}` },
  created_at: '2026-09-26T10:04:11.000Z',
  ...extra,
});

const list = (...rows: object[]): string => JSON.stringify(rows);

const live = (): AbortSignal => AbortSignal.timeout(10_000);

// A `glab` that answers one string and records what it was asked. Nothing here spawns a process: the
// adapter takes the runner as an argument, so a test can never reach the real one.
const glab = (stdout: string, code = 0, stderr = ''): { run: RunGlab; calls: string[][] } => {
  const asked: string[][] = [];
  return {
    calls: asked,
    run: async (args) => {
      asked.push([...args]);
      return { code, stdout, stderr };
    },
  };
};

describe('the filter one typed line becomes', () => {
  it('reads a label out of the line and leaves the rest as search text', () => {
    expect(issueFilter('label:bug slow import')).toEqual({ labels: 'bug', search: 'slow import' });
  });

  it('joins several labels the way --label takes them', () => {
    expect(issueFilter('label:bug label:import')).toEqual({ labels: 'bug,import', search: '' });
  });

  it('drops a label: nobody finished, so an unfinished line does not filter on nothing', () => {
    expect(issueFilter('label: slow')).toEqual({ labels: '', search: 'slow' });
  });

  it('reads an empty line as no filter at all', () => {
    expect(issueFilter(undefined)).toEqual({ labels: '', search: '' });
  });

  // The label prefix is read whatever case it was typed in, so `Label:bug` filters and does not
  // quietly become a word to search for.
  it('reads the label prefix in any case', () => {
    expect(issueFilter('LABEL:bug')).toEqual({ labels: 'bug', search: '' });
  });

  /**
   * The GitHub form sits one row above this one and its placeholder teaches `is:open`, so a person
   * will type it here. Sent on as search text it matches nothing, GitLab answers an empty list, and
   * the check says the project is quiet. A refusal naming the word is the honest answer.
   */
  it('refuses a qualifier it does not read, and names the word', () => {
    expect(() => issueFilter('is:open label:bug')).toThrow(/does not read "is:open"/);
    expect(() => issueFilter('author:me')).toThrow(/label:name/);
  });

  // A typo lands in the same place, which is the point: `labels:bug` filtered on nothing before.
  it('refuses a label: typo rather than searching for it', () => {
    expect(() => issueFilter('labels:bug')).toThrow(/does not read "labels:bug"/);
  });

  // A colon followed by a slash is an address somebody pasted, not a qualifier.
  it('searches for a pasted address instead of refusing it', () => {
    expect(issueFilter('https://gitlab.com/acme/app/-/issues/7')).toEqual({ labels: '', search: 'https://gitlab.com/acme/app/-/issues/7' });
  });
});

describe('the arguments of one read', () => {
  // Every flag here was read from `glab issue list --help` on 2026-09-28, against glab 1.86.0.
  // `--opened` is not in the FLAGS block of `glab issue list --help`, so it was measured instead:
  // `glab issue list --opened --badflag` names only `--badflag`, while `--openedx --badflag` names
  // `--openedx`, so pflag accepted `--opened` as a flag of its own.
  it('asks glab for json, for one project, for one page and for the open issues', () => {
    expect(glabListArgs('acme/app', { labels: '', search: '' }, 30)).toEqual([
      'issue',
      'list',
      '--repo',
      'acme/app',
      '--opened',
      '--output',
      'json',
      '--per-page',
      '30',
    ]);
  });

  it('passes the label and the search text on, and leaves out the one that is empty', () => {
    expect(glabListArgs('acme/app', { labels: 'bug', search: 'import' }, 5).join(' ')).toContain('--label bug --search import');
    expect(glabListArgs('acme/app', { labels: '', search: 'import' }, 5)).not.toContain('--label');
  });

  it('takes a group and a subgroup, which is the other path glab accepts', () => {
    expect(glabListArgs('acme/team/app', { labels: '', search: '' }, 30)).toContain('acme/team/app');
  });

  // GitLab answers its own maximum above 100, so a caller asking for more would read a page it did
  // not ask for and report the rest as nothing.
  it('holds the page at the hundred GitLab allows', () => {
    expect(glabListArgs('acme/app', { labels: '', search: '' }, 500).join(' ')).toContain('--per-page 100');
  });

  it('refuses a project that is not a path, and names both shapes glab takes', () => {
    expect(() => glabListArgs('app', { labels: '', search: '' }, 30)).toThrow(/namespace\/project/);
  });

  // A value starting with a dash would reach `glab` as a flag of its own.
  it('refuses a project starting with a dash', () => {
    expect(() => glabListArgs('-R/app', { labels: '', search: '' }, 30)).toThrow(/not a GitLab project path/);
  });

  // GitLab allows a path to start with an underscore, so refusing one would call a correct path wrong.
  it('takes a project whose namespace starts with an underscore', () => {
    expect(glabListArgs('_infra/app', { labels: '', search: '' }, 30)).toContain('_infra/app');
  });

  // Nothing on the form can post an empty project, but a sentence starting with a space names nothing.
  it('names the field when the project is empty', () => {
    expect(() => glabListArgs('', { labels: '', search: '' }, 30)).toThrow(/^The project is not a GitLab project path/);
  });
});

describe('the key an issue gets', () => {
  // A card key names one folder, so it is the last part of the path and the number, like a GitHub
  // issue card. The full reference is the card's source ref.
  it('is the project name and the number, with no group', () => {
    expect(gitlabKey('acme/app', 42)).toBe('app#42');
    expect(gitlabKey('acme/kitchen/app', 42)).toBe('app#42');
  });

  // A path typed by hand in one case and answered in another would be two findings for one issue.
  it('is the same key whatever case the project was written in', () => {
    expect(gitlabKey('Acme/App', 42)).toBe(gitlabKey('acme/app', 42));
  });
});

describe('reading an answer', () => {
  it('maps a GitLab issue into the ticket shape the other adapters answer', () => {
    expect(readGitLabIssues('acme/app', list(row(42)))).toEqual([
      {
        key: 'app#42',
        title: 'Cache drops rows 42',
        body: 'The import keeps the first page only.',
        state: 'open',
        url: 'https://gitlab.com/acme/app/-/issues/42',
        parentKey: null,
      },
    ]);
  });

  // The belt and braces `github-ci.ts` puts on `conclusion`. The default lists open issues, and this
  // is what keeps a default that changes from putting closed issues on the board.
  it('drops a row that is not open', () => {
    expect(readGitLabIssues('acme/app', list(row(1), row(2, { state: 'closed' })))).toHaveLength(1);
  });

  it('drops a row with no iid rather than keying it by the instance wide id', () => {
    expect(readGitLabIssues('acme/app', list(row(1), row(2, { iid: undefined })))).toHaveLength(1);
  });

  // `acme/app#0` is not a reference GitLab prints, so a zero is a field that is not the iid.
  it('drops a row whose iid is not a number GitLab counts issues with', () => {
    expect(readGitLabIssues('acme/app', list(row(1), row(2, { iid: 0 })))).toHaveLength(1);
    expect(readGitLabIssues('acme/app', list(row(1), row(2, { iid: 1.5 })))).toHaveLength(1);
  });

  it('answers a ticket with an empty title and no address when the row carried neither', () => {
    expect(readGitLabIssues('acme/app', list(row(7, { title: null, web_url: '' })))).toMatchObject([{ key: 'app#7', title: '', url: null }]);
  });

  it('refuses something that is not json at all', () => {
    expect(() => readGitLabIssues('acme/app', 'glab: connection refused')).toThrow(/could not read/);
  });

  /**
   * A bug the GitHub adapter had, refused here before it can happen.
   *
   * A rate limited `gh api` prints readable JSON carrying a `message` and no items. It parsed, so an
   * empty list came back, and a repository nobody had read looked like a clear backlog. Anything that
   * is not a list of issues is a refusal here, and never an empty backlog.
   */
  it('refuses a readable body that is not a list of issues, and does not read it as an empty backlog', () => {
    expect(() => readGitLabIssues('acme/app', JSON.stringify({ message: '401 Unauthorized' }))).toThrow(/did not list the issues/);
  });

  it('reads a real empty list as an empty list', () => {
    expect(readGitLabIssues('acme/app', '[]')).toEqual([]);
  });

  /**
   * The same bug one level deeper, and the reason this guard exists.
   *
   * The field names above are the unmeasured part of the adapter. If GitLab spells the state `open`,
   * or names the per project number something else, every row is dropped, the check says the query
   * answered nothing new, and a project full of open work reads as a clear backlog. A wrong guess has
   * to land as a refusal on the first real call instead.
   */
  it('refuses an answer whose rows all failed the fields it reads', () => {
    expect(() => readGitLabIssues('acme/app', list(row(1, { state: 'open' })))).toThrow(/none of them carried the fields/);
    expect(() => readGitLabIssues('acme/app', list(row(1, { iid: '1' })))).toThrow(/none of them carried the fields/);
    expect(() => readGitLabIssues('acme/app', '[1,2]')).toThrow(/none of them carried the fields/);
  });

  // A raw TypeError would reach the source on the Scout page as the whole message.
  it('does not throw a TypeError over an element that is not an object', () => {
    expect(readGitLabIssues('acme/app', list(row(1), null as unknown as object))).toHaveLength(1);
  });
});

describe('what a refused call says', () => {
  it('says nothing about a call that exited zero', () => {
    expect(glabRefusal('acme/app', 0, '')).toBeNull();
  });

  it('sends a machine with no login to glab auth login', () => {
    expect(glabRefusal('acme/app', 1, 'GET https://gitlab.com/api/v4/projects: 401 {message: 401 Unauthorized}')).toContain('glab auth login');
  });

  /**
   * `glab` echoes the request it made, and the URL carries the project path, so a bare `401` in the
   * markers would read a project called `acme/http-401-fix` as a machine with no login. The person
   * would go and redo a login that is fine.
   */
  it('never reads the project path as the status glab printed', () => {
    const said = glabRefusal('acme/http-401-fix', 1, 'GET https://gitlab.com/api/v4/projects/acme%2Fhttp-401-fix/issues: 404 {message: 404 Project Not Found}') ?? '';
    expect(said).toContain('Check the project path in the source on the Scout page');
    expect(said).not.toContain('glab auth login');
  });

  // A config error names no project, so sending the person to edit a correct project path is wrong.
  it('hands on a configuration failure instead of blaming the project path', () => {
    const said = glabRefusal('acme/app', 1, 'failed to read configuration: file not found') ?? '';
    expect(said).toContain('failed to read configuration');
    expect(said).not.toContain('Check the project path in the source on the Scout page');
  });

  it('sends a project the login cannot see to the project path, and never to a login', () => {
    const said = glabRefusal('acme/app', 1, '404 Not Found') ?? '';
    expect(said).toContain('Check the project path in the source on the Scout page');
    expect(said).not.toContain('glab auth login');
  });

  // What this version does not know it does not name. A sentence that guessed would send the person
  // the wrong way, so glab's own first line goes through with the command to run again by hand.
  it('hands on what glab said when the failure is one this version does not know', () => {
    const said = glabRefusal('acme/app', 1, 'error: certificate has expired\nusage: glab issue list\n') ?? '';
    expect(said).toContain('certificate has expired');
    expect(said).toContain('glab issue list --repo acme/app');
    expect(said).not.toContain('usage');
  });

  /**
   * glab draws a box around its errors. Measured against glab 1.86.0 on 2026-09-28:
   * `glab issue list --repo acme/app --output json --badflag` writes a blank line, then `ERROR` on its
   * own, then the message, then a usage line. The first line is the heading, so handing that on would
   * tell the person their tool said "ERROR" and nothing else.
   */
  it('skips the ERROR heading glab prints and hands on the line under it', () => {
    const banner = '          \n   ERROR  \n          \n  Unknown flag: --badflag.        \n\n  Try --help for usage.\n\n';
    const said = glabRefusal('acme/app', 1, banner) ?? '';
    expect(said).toContain('Unknown flag: --badflag.');
    expect(said).not.toContain('It said: ERROR');
  });
});

describe('one read through glab', () => {
  it('asks for the project and the filter the person typed, and answers tickets', async () => {
    const asked = glab(list(row(1), row(2)));

    const tickets = await gitlabIssues(asked.run, 'acme/app', 'label:bug import', 30, live());

    expect(tickets.map((ticket) => ticket.key)).toEqual(['app#1', 'app#2']);
    expect(asked.calls[0]?.join(' ')).toBe('issue list --repo acme/app --opened --output json --per-page 30 --label bug --search import');
  });

  it('refuses the read when glab exited non-zero, whatever it printed on stdout', async () => {
    const asked = glab('[]', 1, '404 Not Found');

    await expect(gitlabIssues(asked.run, 'acme/app', undefined, 30, live())).rejects.toThrow(/Check the project path/);
  });

  it('asks glab nothing at all when the project is not a path', async () => {
    const asked = glab('[]');

    await expect(gitlabIssues(asked.run, 'app', undefined, 30, live())).rejects.toThrow(/namespace\/project/);
    expect(asked.calls).toEqual([]);
  });
});

// The install sentence is glab's own. The spawn under it is `cli.ts`, shared with `gh`, and
// `gh.test.ts` covers the arguments, the cap, the deadline and a non-zero exit against a fake tool.
it('says where to install glab when there is none on the PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-glab-'));
  try {
    await expect(glabRunner({ path: () => dir })(['issue', 'list'], live())).rejects.toThrow(/Install the GitLab CLI from https:\/\/gitlab\.com\/gitlab-org\/cli/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/**
 * The way out of an answer over the cap, and it is not the one `gh` gets.
 *
 * One read here is a page of thirty issues, so there is no single issue to open, and "Try again"
 * would be a loop: the same read sends the same bytes every time. A GitLab description may hold a
 * megabyte, so thirty long ones are a real way past the cap, and narrowing the search is the only
 * thing the person can do about it.
 */
it('tells the person to narrow the search when glab sends more than the cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nolzu-glab-'));
  try {
    const file = join(dir, 'glab');
    writeFileSync(file, `#!/bin/sh\n${process.execPath} -e 'process.stdout.write("x".repeat(3000000))'\n`);
    chmodSync(file, 0o755);

    await expect(glabRunner({ path: () => dir, maxStdout: 1000 })(['issue', 'list'], live())).rejects.toThrow(/Narrow the issue search in the source on the Scout page/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
