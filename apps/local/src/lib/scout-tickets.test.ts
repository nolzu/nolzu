import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { deleteCardRows, dismissScoutFinding, migrations, openDatabase, scoutFindings, scoutSources, startScoutFinding } from '@nolzu/core/node';
import type { JiraFetch, Keychain, LinearFetch, RunGh, RunGlab } from '@nolzu/runner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveScoutSource, scoutEntry } from './scout-sources.ts';
import { checkTicketQuery, type TicketSeams } from './scout-tickets.ts';

// Not a token of anything. It only has to be a string nothing else here writes.
const TOKEN = 'abc123notatoken';

let dir = '';
let db: DatabaseSync;
let calls: string[] = [];
let kept = new Map<string, string>();

// A keychain of this test's own, so nothing here runs the OS tool and nobody is asked for their
// keychain password. The names it was called with are recorded, because a GitHub source may call none.
const keychain: Keychain = {
  read: (name) => {
    calls.push(`read ${name}`);
    return Promise.resolve(kept.get(name) ?? null);
  },
  write: (name, secret) => {
    calls.push(`write ${name}`);
    kept.set(name, secret);
    return Promise.resolve();
  },
  remove: (name) => {
    calls.push(`remove ${name}`);
    kept.delete(name);
    return Promise.resolve();
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-scout-tickets-'));
  db = openDatabase(dir);
  calls = [];
  kept = new Map();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const post = (body: Record<string, string>) => {
  const form = new FormData();
  for (const [name, value] of Object.entries(body)) form.set(name, value);
  // Registered nowhere, so nothing here builds a schedule frame. What a remove sends is tested in
  // `scout-sources.test.ts`.
  return saveScoutSource(db, keychain, form, { projectId: null, send: () => false });
};

const id = () => scoutSources(db)[0]?.id ?? 0;

const check = (seams: TicketSeams) => {
  const form = new FormData();
  form.set('id', String(id()));
  return checkTicketQuery(db, keychain, form, seams);
};

const GITHUB = { do: 'add', form: 'tickets-github', label: 'The recipe app', repo: 'acme/app', query: 'label:bug' };
const GITLAB = { do: 'add', form: 'tickets-gitlab', label: 'The recipe app on GitLab', project: 'acme/app', query: 'label:bug import' };
const JIRA = { do: 'add', form: 'tickets-jira', label: 'The recipe board', site: 'https://example.atlassian.net', email: 'dana@example.com', jql: 'project = PROJ AND status = Open', secret: TOKEN };
const LINEAR = { do: 'add', form: 'tickets-linear', label: 'The recipe team', teams: 'proj, OPS', secret: TOKEN };

/**
 * A `gh` that answers each call in turn and records what it was asked.
 *
 * The same closure `github.test.ts` and `github-ci.test.ts` use. Nothing here spawns a process: the
 * adapters take `gh` as an argument, so a test that hands one in can never reach the real one.
 */
const gh = (...stdout: string[]): { run: RunGh; calls: string[][] } => {
  const asked: string[][] = [];
  return {
    calls: asked,
    run: async (args) => {
      const at = asked.length;
      asked.push([...args]);
      return { code: 0, stdout: stdout[Math.min(at, stdout.length - 1)] ?? '', stderr: '' };
    },
  };
};

/**
 * A `glab` that answers one string and records what it was asked.
 *
 * HAND WRITTEN, AND NOT RECORDED. Nothing about GitLab has been read from the real API in this
 * project, because Nolzu has not called it yet. `gitlab.test.ts` names field by field what a first
 * real call has to confirm.
 */
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

const gitlabIssueList = (...iids: number[]): string =>
  JSON.stringify(
    iids.map((iid) => ({
      id: 400_000 + iid,
      iid,
      title: `Cache drops rows ${iid}`,
      description: 'The import keeps the first page only.',
      state: 'opened',
      web_url: `https://gitlab.com/acme/app/-/issues/${iid}`,
    })),
  );

// Built from the shape the search API answers with, which is the one `github.ts` already reads. Two
// facts of it are not measured anywhere in this project, the same way `github.test.ts` reads it: that
// `repository_url` is an API address whose last two segments are the owner and the repository, and that
// `state` comes back lower case.
const issues = (...numbers: number[]): string =>
  JSON.stringify({
    items: numbers.map((number) => ({
      number,
      title: `Cache drops rows ${number}`,
      state: 'open',
      html_url: `https://github.com/acme/app/issues/${number}`,
      repository_url: 'https://api.github.com/repos/acme/app',
    })),
  });

const repo = JSON.stringify({ full_name: 'acme/app', default_branch: 'main' });

// HAND WRITTEN, AND NOT RECORDED, the same as in `github-ci.test.ts`: nothing about GitHub Actions has
// ever been read from the real API in this project. `github-ci.test.ts` names the facts a first real
// recording has to confirm.
const ciRuns = (...rows: { id: number; conclusion: string }[]): string =>
  JSON.stringify({
    total_count: rows.length,
    workflow_runs: rows.map((row) => ({ id: row.id, name: 'Tests', head_branch: 'main', status: 'completed', conclusion: row.conclusion })),
  });

// Built from what a real site answered on 2026-09-25: the search page carries `issues`, a
// `nextPageToken` and `isLast`, and no total and no `startAt`. The issue rows carry the same fields the
// single issue read answers with.
const jiraPage = (...keys: string[]): string =>
  JSON.stringify({
    issues: keys.map((key) => ({
      id: '10001',
      key,
      fields: {
        summary: 'Search by ingredient',
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Match ingredients too.' }] }] },
        status: { name: 'In Progress', statusCategory: { key: 'indeterminate', name: 'In Progress' } },
        parent: null,
      },
    })),
    isLast: true,
  });

const answered = (status: number, body: string, headers: Record<string, string> = {}): JiraFetch => async () => new Response(body, { status, headers });

// HAND WRITTEN, AND NOT RECORDED. No answer from Linear has been read anywhere in this project, and
// there is no account here to read one from. `linear.test.ts` names the eleven things a first real
// call has to confirm.
const linearPage = (...keys: string[]): string =>
  JSON.stringify({
    data: {
      issues: {
        nodes: keys.map((key) => ({
          identifier: key,
          title: 'Search by ingredient',
          description: 'Match ingredients too.',
          url: `https://linear.app/example/issue/${key}`,
          state: { type: 'started' },
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
  });

describe('a GitHub ticket query', () => {
  it('reads the issues and the failed CI runs, and passes the query the person typed', async () => {
    await post(GITHUB);
    const asked = gh(issues(1, 2), repo, ciRuns({ id: 9001, conclusion: 'failure' }));

    const answer = await check({ run: asked.run });

    expect(answer).toMatchObject({ ok: true, message: null });
    expect(answer.checked).toContain('3 new findings');
    // No keychain call at all: a GitHub source stores no token, so checking one can never put an OS
    // password dialog on the screen.
    expect(calls).toEqual([]);
    const search = asked.calls[0]?.join(' ') ?? '';
    expect(search).toContain('search/issues');
    expect(search).toContain('repo:acme/app');
    // What the person typed reaches the API, after the two qualifiers that keep pull requests and
    // closed issues out.
    expect(search).toContain('label:bug');
    expect(search.indexOf('is:issue')).toBeLessThan(search.indexOf('label:bug'));
  });

  /**
   * The test the plan asks for: a failed run becomes a finding and a passing one does not.
   *
   * Counted through the whole path and not in the parser alone, because the number a person reads comes
   * from the check and not from the parse.
   */
  it('makes a finding from a failed run and none from a passing one', async () => {
    await post(GITHUB);
    const asked = gh(issues(), repo, ciRuns({ id: 9001, conclusion: 'failure' }, { id: 9002, conclusion: 'success' }));

    const answer = await check({ run: asked.run });

    expect(answer.checked).toContain('1 new finding');
    const findings = scoutFindings(db, id());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.firstMessage).toBe('Tests failed on main');
    expect(findings[0]?.location).toBe('acme/app@main');
  });

  it('answers that the query found nothing new, and says so rather than printing a zero', async () => {
    await post(GITHUB);
    const asked = gh(issues(1), repo, ciRuns());
    await check({ run: asked.run });

    const again = await check({ run: gh(issues(1), repo, ciRuns()).run });

    expect(again).toMatchObject({ ok: true, message: null });
    expect(again.checked).toContain('nothing this source has not reported already');
    expect(scoutFindings(db, id())).toHaveLength(1);
    // Read once, so the count stays at one. A check that re-counted the same open ticket would make the
    // number mean nothing.
    expect(scoutFindings(db, id())[0]?.occurrences).toBe(1);
  });

  /**
   * A search that answered something unreadable is a refusal, not an empty backlog.
   *
   * A rate limited `gh api` prints readable JSON with no `items` in it. Read as nothing found, it would
   * tell a person their backlog is clear.
   */
  it('refuses an answer it cannot read, writes no finding and keeps the sentence on the source', async () => {
    await post(GITHUB);

    const answer = await check({ run: gh('gh: rate limited').run });

    expect(answer).toMatchObject({ ok: false, checked: null });
    expect(answer.message).toContain('could not read');
    expect(scoutFindings(db, id())).toEqual([]);
    expect(scoutSources(db)[0]).toMatchObject({ cursor: null, lastError: expect.stringContaining('could not read') });
  });

  // Every `gh` failure arrives as a rejected promise and not as an exit code, so a check that did not
  // catch them would answer a 500 and a blank screen.
  it('turns a machine with no gh into a sentence on the source', async () => {
    await post(GITHUB);
    const missing: RunGh = () => Promise.reject(new Error('gh is not on the PATH. Install the GitHub CLI from https://cli.github.com, then start Nolzu again.'));

    const answer = await check({ run: missing });

    expect(answer.message).toContain('cli.github.com');
    expect(scoutSources(db)[0]?.lastError).toContain('cli.github.com');
  });

  /**
   * The two numbers that bound a first check, on the wire where they matter.
   *
   * The comment above them works the cap out by hand: `gh` drops an answer over four million
   * characters whole, and thirty issue bodies fit under it. A smaller number reads a backlog in part
   * and says nothing about the rest, and a larger one loses the whole answer.
   */
  it('asks for thirty issues and twenty runs, the page sizes the cap was worked out from', async () => {
    await post(GITHUB);
    const asked = gh(issues(1), repo, ciRuns({ id: 9001, conclusion: 'failure' }));

    await check({ run: asked.run });

    expect(asked.calls[0]?.join(' ')).toContain('per_page=30');
    expect(asked.calls[2]?.join(' ')).toContain('per_page=20');
  });

  // The paste path names a mute in its own clause and this one did not. A query whose only answer is a
  // muted finding did answer, so saying it reported nothing new is wrong twice over.
  it('names the muted finding when the query met only one that is dismissed', async () => {
    await post(GITHUB);
    await check({ run: gh(issues(1), repo, ciRuns()).run });
    dismissScoutFinding(db, scoutFindings(db, id())[0]?.id ?? 0);
    // The cursor is what keeps a ticket already reported out of the next check, so it is cleared here
    // and the same ticket arrives the way a first check of it would.
    db.prepare('UPDATE scout_sources SET cursor = NULL WHERE id = ?').run(id());

    const again = await check({ run: gh(issues(1), repo, ciRuns()).run });

    expect(again.checked).toContain('1 finding left muted');
    expect(again.checked).not.toContain('nothing this source has not reported already');
  });

  // A GitHub issue is keyed app#1 now, with no owner, and the migration moves the findings and the
  // cursor of a database from before. Without that, the next check would meet every ticket again.
  it('meets no ticket twice on a database from before the issue key changed', async () => {
    const old = join(dir, 'before');
    const before = openDatabase(old, migrations.slice(0, 19));
    before.exec(`
      INSERT INTO scout_sources (id, kind, label, config_json, cursor) VALUES (1, 'tickets', 'The recipe app', '{"system":"github","repo":"acme/app","query":"label:bug"}', 'acme/app#1');
      INSERT INTO scout_findings (source_id, fingerprint, first_seen, last_seen, first_message, last_message, location, external_key, occurrences) VALUES
        (1, 'tickets:acme%2Fapp%231', '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z', 'Cache drops rows 1', 'Cache drops rows 1', 'acme/app#1', 'acme/app#1', 1);
      INSERT INTO cards (key, board, stage, title, source, source_ref) VALUES ('acme/app#9', 'delivery', 'inbox', 'Search by ingredient', 'github', 'acme/app#9');
    `);
    before.close();
    db.close();
    db = openDatabase(old);

    const answer = await check({ run: gh(issues(1, 2), repo, ciRuns()).run });

    expect(answer.checked).toContain('1 new finding');
    const findings = scoutFindings(db, id());
    expect(findings.map((one) => one.fingerprint).sort()).toEqual(['tickets:app%231', 'tickets:app%232']);
    // Not met again, so it keeps its count and its time.
    expect(findings.find((one) => one.fingerprint === 'tickets:app%231')).toMatchObject({ occurrences: 1, lastSeen: '2026-10-01T09:00:00.000Z' });
    expect(db.prepare('SELECT key, source_ref FROM cards').all()).toEqual([{ key: 'app#9', source_ref: 'acme/app#9' }]);
  });

  it('refuses a repository that is not written as owner/repo', async () => {
    await post({ ...GITHUB, repo: 'recipes' });
    const asked = gh(issues());

    const answer = await check({ run: asked.run });

    expect(answer.message).toContain('owner/repo');
    // Nothing was asked of GitHub at all, so a typo costs no call.
    expect(asked.calls).toEqual([]);
  });

  // Half a repository has the slash and is still nonsense. This screen refuses it, so the sentence says
  // where to fix it. The adapters underneath refuse it too, and their sentence names neither the source
  // nor the screen it is on.
  it('refuses a repository with an empty owner or an empty name, and says where to fix it', async () => {
    for (const half of ['acme/', '/app']) {
      await post({ ...GITHUB, repo: half });
      const asked = gh(issues());

      const answer = await check({ run: asked.run });

      expect(answer.message).toContain('owner/repo');
      expect(answer.message).toContain('Open the source on the Scout page');
      expect(asked.calls).toEqual([]);
      await post({ do: 'remove', id: String(id()) });
    }
  });
});

describe('a Jira ticket query', () => {
  it('reads its token from its own keychain entry and sends the JQL the person typed', async () => {
    await post(JIRA);
    let asked = '';
    const fetcher: JiraFetch = async (url) => {
      asked = url;
      return new Response(jiraPage('PROJ-123'), { status: 200 });
    };

    const answer = await check({ fetcher });

    expect(answer).toMatchObject({ ok: true, message: null });
    expect(answer.checked).toContain('1 new finding');
    // Its own name and not the account-wide `jira-token`, which holds another site's token.
    expect(calls).toEqual([`write jira-example-atlassian-net-${id()}`, `read jira-example-atlassian-net-${id()}`]);
    expect(new URL(asked).searchParams.get('jql')).toBe('project = PROJ AND status = Open');
    expect(scoutFindings(db, id())[0]?.fingerprint).toBe('tickets:PROJ-123');
  });

  // The 404 that means a refused token rather than a missing issue. The header is what tells the two
  // apart, and it was recorded on 2026-09-25.
  it('says the token was refused when the site answers the login header', async () => {
    await post(JIRA);
    const refused = answered(404, JSON.stringify({ errorMessages: ['Issue does not exist or you do not have permission to see it.'], errors: {} }), {
      'x-seraph-loginreason': 'AUTHENTICATED_FAILED',
    });

    const answer = await check({ fetcher: refused });

    expect(answer).toMatchObject({ ok: false, checked: null });
    expect(answer.message).toContain('token');
    expect(scoutFindings(db, id())).toEqual([]);
    expect(scoutSources(db)[0]).toMatchObject({ cursor: null, lastError: expect.stringContaining('token') });
  });

  // A source whose token was removed from the keychain by hand. It names the entry, because that is
  // where the person has to put it back.
  it('names the keychain entry when the token is not there', async () => {
    await post(JIRA);
    kept.clear();

    const answer = await check({ fetcher: answered(200, jiraPage('PROJ-123')) });

    // The full entry and the stop after it, so a bare name does not pass.
    expect(answer.message).toContain(`under ${scoutEntry(`jira-example-atlassian-net-${id()}`)}.`);
    expect(answer.message).toContain('on the Scout page');
  });

  // The site address is checked before the keychain, because that check costs nothing and a keychain
  // read can put an OS password dialog in front of the person.
  it('refuses a site address that is not https, and reads no token for it', async () => {
    await post({ ...JIRA, site: 'http://example.atlassian.net' });
    calls = [];

    const answer = await check({ fetcher: answered(200, jiraPage('PROJ-123')) });

    expect(answer.message).toContain('https');
    expect(calls).toEqual([]);
  });
});

describe('a Linear ticket query', () => {
  it('reads its key from its own keychain entry and asks for the teams the person typed', async () => {
    await post(LINEAR);
    let sent = '';
    const linear: LinearFetch = async (_url, init) => {
      sent = init.body;
      return new Response(linearPage('PROJ-123'), { status: 200 });
    };

    const answer = await check({ linear });

    expect(answer).toMatchObject({ ok: true, message: null });
    expect(answer.checked).toContain('1 new finding');
    expect(calls).toEqual([`write linear-proj-ops-${id()}`, `read linear-proj-ops-${id()}`]);
    // Upper case, and the comma the person typed is not a team key.
    expect(JSON.parse(sent)).toMatchObject({ variables: { filter: { team: { key: { in: ['PROJ', 'OPS'] } } } } });
    expect(scoutFindings(db, id())[0]?.fingerprint).toBe('tickets:PROJ-123');
  });

  /**
   * The trap this adapter was written for.
   *
   * Linear refuses a query with HTTP 200 and an `errors` array, so a check that read the status and
   * then took the rows would stamp the source as checked and report a team with no tickets.
   */
  it('reports a refusal that came back as 200, and finds nothing', async () => {
    await post(LINEAR);
    const refused: LinearFetch = async () => new Response(JSON.stringify({ data: null, errors: [{ message: 'Rate limit exceeded' }] }), { status: 200 });

    const answer = await check({ linear: refused });

    expect(answer).toMatchObject({ ok: false, checked: null });
    expect(answer.message).toContain('Rate limit exceeded');
    expect(scoutFindings(db, id())).toEqual([]);
    expect(scoutSources(db)[0]).toMatchObject({ cursor: null, lastError: expect.stringContaining('Rate limit exceeded') });
  });

  it('says the key was refused when Linear answers 401', async () => {
    await post(LINEAR);
    const refused: LinearFetch = async () => new Response('', { status: 401 });

    const answer = await check({ linear: refused });

    expect(answer.message).toContain('API key');
    expect(scoutFindings(db, id())).toEqual([]);
  });

  // The form refuses an empty field and nothing else, so a field of separators alone is stored. The
  // adapter would then ask for no team, make no call, and the check would stamp the source green.
  it('refuses a teams field that holds no key, and touches neither Linear nor the keychain', async () => {
    await post({ ...LINEAR, teams: ', ,' });
    let called = 0;
    const linear: LinearFetch = async () => {
      called += 1;
      return new Response(linearPage('PROJ-123'), { status: 200 });
    };

    const answer = await check({ linear });

    expect(answer).toMatchObject({ ok: false, checked: null });
    expect(answer.message).toContain('on the Scout page');
    expect(called).toBe(0);
    // No keychain read, so a typo cannot put an OS password dialog in front of the person.
    expect(calls).toEqual([`write linear-${id()}`]);
  });

  // A source whose key was removed from the keychain by hand. It names the entry, because that is
  // where the person has to put it back.
  it('names the keychain entry when the key is not there', async () => {
    await post(LINEAR);
    kept.clear();

    const answer = await check({ linear: async () => new Response(linearPage('PROJ-123'), { status: 200 }) });

    // The full entry and the stop after it, so a bare name does not pass.
    expect(answer.message).toContain(`under ${scoutEntry(`linear-proj-ops-${id()}`)}.`);
    expect(answer.message).toContain('on the Scout page');
  });
});

describe('a GitLab ticket query', () => {
  it('reads the open issues of the project and passes the label and the search the person typed', async () => {
    await post(GITLAB);
    const asked = glab(gitlabIssueList(1, 2));

    const answer = await check({ glab: asked.run });

    expect(answer).toMatchObject({ ok: true, message: null });
    expect(answer.checked).toContain('2 new findings');
    // No keychain call at all: `glab` holds the GitLab login, so checking one can never put an OS
    // password dialog on the screen.
    expect(calls).toEqual([]);
    expect(asked.calls[0]?.join(' ')).toBe('issue list --repo acme/app --opened --output json --per-page 30 --label bug --search import');
    // The issue key is what the finding is fingerprinted on, escaped by `fingerprint`, so a reworded
    // title keeps the finding it already has. The key is app#1, with no group, so its card can run.
    expect(scoutFindings(db, id()).map((finding) => finding.fingerprint).sort()).toEqual(['tickets:app%231', 'tickets:app%232']);
  });

  // A GitLab issue is keyed app#1 now, with no group, and the migration moves the findings, the
  // cursor and the started card of a database from before. Without that, the next check would meet
  // every ticket again.
  it('meets no ticket twice on a database from before the GitLab key changed', async () => {
    const old = join(dir, 'before');
    const before = openDatabase(old, migrations.slice(0, 20));
    before.exec(`
      INSERT INTO scout_sources (id, kind, label, config_json, cursor) VALUES (1, 'tickets', 'The recipe app on GitLab', '{"system":"gitlab","project":"acme/app","query":"label:bug import"}', 'acme/app#1');
      INSERT INTO cards (key, board, stage, title, source, source_ref) VALUES ('acme/app#1', 'delivery', 'inbox', 'Cache drops rows 1', 'external', 'acme/app#1');
      INSERT INTO scout_findings (source_id, fingerprint, first_seen, last_seen, first_message, last_message, location, external_key, card_key, status, occurrences) VALUES
        (1, 'tickets:acme%2Fapp%231', '2026-10-01T09:00:00.000Z', '2026-10-01T09:00:00.000Z', 'Cache drops rows 1', 'Cache drops rows 1', 'acme/app#1', 'acme/app#1', 'acme/app#1', 'started', 1);
    `);
    before.close();
    db.close();
    db = openDatabase(old);

    const answer = await check({ glab: glab(gitlabIssueList(1, 2)).run });

    expect(answer.checked).toContain('1 new finding');
    const findings = scoutFindings(db, id());
    expect(findings.map((one) => one.fingerprint).sort()).toEqual(['tickets:app%231', 'tickets:app%232']);
    // Not met again, so it keeps its count, its time and its card.
    expect(findings.find((one) => one.fingerprint === 'tickets:app%231')).toMatchObject({ occurrences: 1, lastSeen: '2026-10-01T09:00:00.000Z', cardKey: 'app#1' });
    expect(db.prepare('SELECT key, source_ref FROM cards').all()).toEqual([{ key: 'app#1', source_ref: 'acme/app#1' }]);
  });

  it('asks for thirty issues, the same page the other ticket sources read', async () => {
    await post(GITLAB);
    const asked = glab(gitlabIssueList(1));

    await check({ glab: asked.run });

    expect(asked.calls[0]?.join(' ')).toContain('--per-page 30');
  });

  /**
   * An answer that is not a list of issues is a refusal, not an empty backlog.
   *
   * A GitHub adapter bug: a body that parses and carries no rows read as a
   * clear backlog. Read that way here, a person would be told their GitLab project has no open work.
   */
  it('refuses an answer it cannot read, writes no finding and keeps the sentence on the source', async () => {
    await post(GITLAB);

    const answer = await check({ glab: glab(JSON.stringify({ message: '401 Unauthorized' })).run });

    expect(answer).toMatchObject({ ok: false, checked: null });
    expect(answer.message).toContain('did not list the issues');
    expect(scoutFindings(db, id())).toEqual([]);
    expect(scoutSources(db)[0]).toMatchObject({ cursor: null, lastError: expect.stringContaining('did not list the issues') });
  });

  it('sends a glab with no login to glab auth login', async () => {
    await post(GITLAB);

    const answer = await check({ glab: glab('', 1, 'GET https://gitlab.com/api/v4/projects: 401 {message: 401 Unauthorized}').run });

    expect(answer.message).toContain('glab auth login');
    expect(scoutFindings(db, id())).toEqual([]);
  });

  // A different fix from a missing login. The person is sent to the project path on this screen, and
  // never to a login they already have.
  it('sends a project the login cannot see to the project path in settings', async () => {
    await post(GITLAB);

    const answer = await check({ glab: glab('', 1, '404 Not Found').run });

    expect(answer.message).toContain('Check the project path in the source on the Scout page');
    expect(answer.message).not.toContain('glab auth login');
  });

  // Every `glab` failure arrives as a rejected promise and not as an exit code, so a check that did
  // not catch them would answer a 500 and a blank screen.
  it('turns a machine with no glab into a sentence on the source', async () => {
    await post(GITLAB);
    const missing: RunGlab = () => Promise.reject(new Error('glab is not on the PATH, so Nolzu cannot read GitLab issues. Install the GitLab CLI from https://gitlab.com/gitlab-org/cli, then start Nolzu again.'));

    const answer = await check({ glab: missing });

    expect(answer.message).toContain('gitlab.com/gitlab-org/cli');
    expect(scoutSources(db)[0]?.lastError).toContain('gitlab.com/gitlab-org/cli');
  });

  it('refuses a project that is not written as a path, and asks glab nothing', async () => {
    await post({ ...GITLAB, project: 'app' });
    const asked = glab(gitlabIssueList());

    const answer = await check({ glab: asked.run });

    expect(answer.message).toContain('namespace/project');
    expect(asked.calls).toEqual([]);
  });
});

// A stored system this version does not know, which is what a source added by a later version looks
// like after a downgrade.
it('says what to do about a ticket system it does not know', async () => {
  await post(GITHUB);
  db.prepare("UPDATE scout_sources SET config_json = '{\"repo\":\"acme/app\",\"system\":\"tracker\"}' WHERE id = ?").run(id());

  const answer = await check({ run: gh(issues()).run });

  expect(answer.message).toContain('tracker');
  expect(answer.message).toContain('on the Scout page');
  // The four systems it does know, so dropping one out of the sentence is a failing test.
  expect(answer.message).toContain('GitHub, GitLab, Jira or Linear');
});

// Delete card on a card Scout started from a ticket: the next check meets the ticket again and leaves
// the board alone. The finding keeps the old key, so its page says the card is gone and offers Start.
describe('a deleted ticket card', () => {
  const cards = () => db.prepare('SELECT key FROM cards').all();

  it('does not come back on the next check of a GitHub source', async () => {
    await post(GITHUB);
    await check({ run: gh(issues(7), repo, ciRuns()).run });
    const finding = scoutFindings(db, id())[0]?.id ?? 0;
    expect(startScoutFinding(db, finding)).toMatchObject({ ok: true, key: 'app#7' });
    expect(deleteCardRows(db, 'app#7')).toEqual({ logs: [] });

    await check({ run: gh(issues(7), repo, ciRuns()).run });

    expect(cards()).toEqual([]);
    expect(scoutFindings(db, id())).toMatchObject([{ id: finding, cardKey: 'app#7' }]);
  });

  it('does not come back on the next check of a Jira source', async () => {
    await post(JIRA);
    await check({ fetcher: answered(200, jiraPage('PROJ-123')) });
    expect(startScoutFinding(db, scoutFindings(db, id())[0]?.id ?? 0)).toMatchObject({ ok: true, key: 'PROJ-123' });
    expect(deleteCardRows(db, 'PROJ-123')).toEqual({ logs: [] });

    await check({ fetcher: answered(200, jiraPage('PROJ-123')) });

    expect(cards()).toEqual([]);
    expect(db.prepare('SELECT source_ref, source FROM deleted_tickets').all()).toEqual([{ source_ref: 'PROJ-123', source: 'jira' }]);
  });
});
