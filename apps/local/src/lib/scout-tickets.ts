import type { DatabaseSync } from 'node:sqlite';
import type { FailedRun, Ticket } from '@nolzu/protocol';
import { fetchTickets, type TicketPlan, ticketPlan } from '@nolzu/core';
import { checkTicketSource, type ScoutSource } from '@nolzu/core/node';
import { failedRuns, ghRunner, githubIssues, gitlabIssues, glabRunner, type JiraFetch, jiraCall, jiraIssues, type Keychain, type LinearFetch, linearCall, linearIssues, type RunGh, type RunGlab } from '@nolzu/runner';
import { type ScoutCheckAnswer, checkedSentence, count, scoutEntry, sourceEntry, sourceSecret } from './scout-sources.ts';

// The same read timeout the card path uses, so one product does not wait two different lengths for
// the same host. Not shared with `@nolzu/core`: the server has its own limits on how long a request
// of its own may take, and copying this number there would tie the two together for no reason.
const READ_TIMEOUT_MS = 30_000;

/**
 * The two ways out of this process, so a test drives both by hand and opens nothing.
 *
 * The same shape `create-card.ts` uses for the card path: the route hands in the real ones and a test
 * hands in a closure.
 */
export interface TicketSeams {
  run?: RunGh;
  glab?: RunGlab;
  fetcher?: JiraFetch;
  linear?: LinearFetch;
}

/**
 * The token or the key of one source, from this source's own keychain entry.
 *
 * Its own entry and not one name for the whole account, so two sources can hold two credentials.
 * `jiraFromKeychain` reads the account-wide name, which is why it is not used here.
 */
async function secret(source: ScoutSource, keychain: Keychain, word: 'token' | 'key'): Promise<string> {
  const held = await sourceSecret(keychain, source);
  if (held === null) {
    throw new Error(`There is no API ${word} for "${source.label}" in this machine's keychain under ${scoutEntry(sourceEntry(source) ?? '')}. Open the source on the Scout page, paste the ${word}, and save it.`);
  }
  return held;
}

/**
 * The plan, asked of the system it names.
 *
 * Only the calls are here. What to ask is `ticketPlan` in `@nolzu/core`, which also refuses a
 * repository, a site address or a teams field a person mistyped, so nothing below runs for one.
 */
async function ask(plan: TicketPlan, source: ScoutSource, keychain: Keychain, seams: TicketSeams, signal: AbortSignal): Promise<{ tickets: readonly Ticket[]; runs: readonly FailedRun[] }> {
  if (plan.system === 'github') {
    const run = seams.run ?? ghRunner();
    // No default owner: the repository is typed in full on the form, so nothing has to be guessed from
    // the project's own git remote.
    const adapter = githubIssues({ run, defaultOwner: null });
    const tickets = await adapter.search(plan.query, signal);
    // The CI read comes second and its failure is not swallowed, because the form promises both: the
    // GitHub source says out loud that it reads the issues and the CI runs of that repository.
    const runs = await failedRuns(run, plan.owner, plan.repo, plan.ciLimit, signal);
    return { tickets, runs };
  }
  if (plan.system === 'gitlab') {
    // No CI read beside the issues, unlike the GitHub half. GitLab pipelines are a second question of
    // the same CLI and nothing has asked for them, so this form promises the issues alone. No keychain
    // either, for the same reason the GitHub half touches none: `glab` holds the login.
    const tickets = await gitlabIssues(seams.glab ?? glabRunner(), plan.project, plan.terms, plan.limit, signal);
    return { tickets, runs: [] };
  }
  if (plan.system === 'jira') {
    const adapter = jiraIssues(jiraCall(plan.site, await secret(source, keychain, 'token'), seams.fetcher));
    return { tickets: await adapter.search(plan.query, signal), runs: [] };
  }
  /**
   * The Linear half: the open tickets of the teams the person named.
   *
   * NOT RECORDED. No call to Linear has been made from this project, so treat what a Linear source
   * reports as unverified until somebody records one real answer. `linear.test.ts` names what that
   * first call has to confirm.
   */
  if (plan.system === 'linear') {
    const adapter = linearIssues(linearCall(await secret(source, keychain, 'key'), seams.linear));
    return { tickets: await adapter.search(plan.query, signal), runs: [] };
  }

  // A fifth system in `TicketPlan` breaks the build here rather than falling into the Linear branch
  // above it, which is what the assignment is for.
  const unknown: never = plan;
  throw new Error(`A ticket source of the kind ${String(unknown)} is one this build cannot read.`);
}

/**
 * One ticket query, read and folded into items.
 *
 * Every call is made here and none of it inside the transaction the check opens next. Neither Jira nor
 * Linear has CI to report, which is why only the GitHub branch asks for runs.
 */
async function read(source: ScoutSource, keychain: Keychain, seams: TicketSeams) {
  // Before the clock and before any call, so a mistyped setting costs neither a timer nor a process.
  const plan = ticketPlan(source.config);
  const signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  const { tickets, runs } = await ask(plan, source, keychain, seams, signal);
  return fetchTickets(tickets, runs, source.cursor);
}

/**
 * How many tickets the source can read, and failed CI runs for GitHub, for "Test the connection". The
 * same calls as a check, with nothing stored.
 */
export async function ticketsReadable(source: ScoutSource, keychain: Keychain, seams: TicketSeams = {}): Promise<string> {
  const plan = ticketPlan(source.config);
  const { tickets, runs } = await ask(plan, source, keychain, seams, AbortSignal.timeout(READ_TIMEOUT_MS));
  const read = count(tickets.length, 'ticket', 'tickets');
  return plan.system === 'github' ? `${read} and ${count(runs.length, 'failed CI run', 'failed CI runs')}` : read;
}

/**
 * Check one ticket query source with what its system answers.
 *
 * Its own action and not a word on the paste check, because that one takes a database and a post and
 * nothing else: a keychain handed in there would let opening the Scout page ask for a keychain
 * password. Here a person pressed a button, so a keychain read may happen, and it happens for a Jira
 * or a Linear source only. A GitHub source stores no token at all, so nothing here touches the
 * keychain for one.
 */
export async function checkTicketQuery(db: DatabaseSync, keychain: Keychain, form: FormData, seams: TicketSeams = {}): Promise<ScoutCheckAnswer> {
  const id = Number(form.get('id')?.toString() ?? '');
  const answer = await checkTicketSource(db, id, (source) => read(source, keychain, seams));
  if (answer.error !== null) return { ok: false, checked: null, message: answer.error };
  // Nothing new means the query answered only tickets this source has already reported, which is the
  // honest common case and not a failure. "0 new" alone reads as one.
  if (answer.added === 0 && answer.met === 0 && answer.muted === 0)
    return { ok: true, checked: 'Checked. The query answered nothing this source has not reported already.', message: null };
  return { ok: true, checked: checkedSentence(answer), message: null };
}
