<script lang="ts">
  import { type BranchCommit, type ChangeGroup, type Changes, type ChangesView, type CompareUrl, type DiffComment, hasUncommitted, hasWork } from '@nolzu/protocol';
  import type { Snippet } from 'svelte';
  import Chip from '../Chip.svelte';
  import ChangesTab from './ChangesTab.svelte';
  import { entriesOf } from './commit-files.ts';
  import CommitComposer from './CommitComposer.svelte';
  import PublishPanel from './PublishPanel.svelte';
  import Skeleton from '../Skeleton.svelte';
  import { repoSuffix } from './repo-id.ts';

  type Answer = { ok: true } | { ok: false; reason: string };
  type PushAnswer = { ok: true } | { ok: false; reason: string; rejected?: boolean; command?: string };
  type PullAnswer = { ok: true; upToDate?: boolean } | { ok: false; reason: string; conflicts?: string[] };
  // The fields after `compare` name where the push goes, for the push confirm. Optional, so a page that
  // hands only the sentence still works.
  type Publish =
    | {
        ok: true;
        confirmation: string | null;
        pushed: boolean;
        compare: CompareUrl;
        branch?: string;
        remote?: { name: string; url: string } | null;
        host?: string | null;
        place?: string | null;
        pull?: { number: number; url: string } | null;
      }
    | { ok: false; reason: string };
  // `commit` names the commit with the `commit` group, one commit against its parent.
  type Ask = { path: string; oldPath: string | null; group: 'committed' | 'uncommitted' | 'branch' | 'commit'; commit?: string };
  type CommitDiff = { ok: true; diff: ChangeGroup } | { ok: false; reason: string };
  type Said = Promise<string | null>;

  // One group per repository of the workspace, each acting on its own, behind the repository switcher
  // of the Changes tab. Every call names the group's repository, because the page does the fetch and
  // this package never does.
  let {
    groups,
    onopen,
    oncommit,
    onwrite,
    onpush,
    card = null,
    onpull = null,
    oncopy = null,
    onopenpr = null,
    comments = [],
    oncomment = null,
    onedit = null,
    ondelete = null,
    next = null,
    view = 'all',
    onview = null,
    oncommitdiff = null,
  }: {
    // `name` is what the page calls the repository, the root by its folder's name.
    groups: readonly { repo: string; name?: string; changes: Changes; publish: Publish }[];
    onopen: (repo: string, ask: Ask) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
    // `paths` names the ticked files, and the commit takes exactly those. hooks is true only when the
    // person ticked Run hooks for that commit or push.
    oncommit: (repo: string, message: string, paths: string[], hooks: boolean) => Promise<Answer>;
    // The model and the cost come back where the pass reported them, for the push dialog.
    onwrite: (repo: string, short: boolean) => Promise<{ ok: true; message: string; model?: string; cost?: number | null } | { ok: false; reason: string }>;
    // The push commits nothing, so `commit` is left out; the route still takes one.
    onpush: (repo: string, commit: { message: string; only: string[] } | undefined, hooks: boolean) => Promise<PushAnswer>;
    // The card's key, which the push confirm and the rejected push name.
    card?: string | null;
    // "Pull into the checkout" after a rejected push, for the group's repository.
    onpull?: ((repo: string) => Promise<PullAnswer>) | null;
    oncopy?: ((text: string) => Promise<string | null>) | null;
    onopenpr?: ((url: string) => void) | null;
    // The card's diff comments, every repository. Each group shows its own.
    comments?: readonly DiffComment[];
    oncomment?: ((repo: string, ask: { file: string; line: number; lineText: string; text: string }) => Said) | null;
    onedit?: ((id: number, text: string) => Said) | null;
    ondelete?: ((id: number) => Said) | null;
    // The page's Next step while a comment is not sent yet: Send back with comments. Drawn once, at
    // the top of the shown repository's right column.
    next?: Snippet | null;
    // Not committed (`uncommitted`) shows what a commit would take now, Whole card (`all`) the base to
    // the folder. The page keeps the pick in the address, so `onview` hands it back. Without it there
    // is no switch.
    view?: ChangesView;
    onview?: ((view: ChangesView) => void) | null;
    // One commit's files, asked when the person opens a commit of the list Nothing to commit shows.
    oncommitdiff?: ((repo: string, commit: string) => Promise<CommitDiff>) | null;
  } = $props();

  const unsent = $derived(comments.filter((one) => one.sentAt === null));

  // Only the repositories with something in the view get a tab: on Not committed work not committed or
  // a commit ahead, so a branch to push keeps its push panel; on Whole card any work. With none, the
  // first one shows, so its reason (no checkout yet) still reads. The rest fold into one line at the end,
  // as the Workspace page folds its clean folders.
  const inView = (changes: Changes): boolean =>
    view === 'all' ? hasWork(changes) : hasUncommitted(changes) || (changes.ok && changes.row.ahead > 0);
  const worked = $derived(groups.filter((one) => inView(one.changes)));
  const tabs = $derived(worked.length > 0 ? worked : groups.slice(0, 1));
  const rest = $derived(groups.filter((one) => !tabs.includes(one)));
  let showRest = $state(false);
  let picked = $state<string | null>(null);
  const shown = $derived(tabs.find((one) => one.repo === picked)?.repo ?? tabs[0]?.repo);
  // The diff the view draws: what a commit would take now, or the base to the folder.
  const drawn = (changes: Changes): ChangeGroup | null => (!changes.ok ? null : view === 'all' ? (changes.diff ?? null) : changes.uncommitted);
  // A tab's size, which is what the diff below it draws.
  const lines = (changes: Changes) => {
    const diff = drawn(changes);
    return diff === null || (view === 'uncommitted' && diff.stat.files === 0) ? '' : `+${diff.stat.added} -${diff.stat.removed}`;
  };

  // The commit opened from the list, per repository, with its files once they came back.
  let opened = $state<Record<string, { commit: BranchCommit; diff: CommitDiff | null }>>({});
  async function openCommit(repo: string, commit: BranchCommit): Promise<void> {
    // A second press while that commit's files are on their way asks git for nothing more.
    if (oncommitdiff === null || (opened[repo]?.commit.sha === commit.sha && opened[repo]?.diff === null)) return;
    opened[repo] = { commit, diff: null };
    const diff = await oncommitdiff(repo, commit.sha);
    if (opened[repo]?.commit.sha === commit.sha) opened[repo] = { commit, diff };
  }

  // What the switcher says of each repository. An untouched one says it has no changes.
  function standing(changes: Changes): string {
    if (!changes.ok) return 'no changes';
    if (changes.row.stale) return 'stale';
    const loose = changes.row.changed + changes.row.untracked;
    if (loose > 0) return `${loose} ${loose === 1 ? 'file' : 'files'} not committed`;
    return (changes.diff?.stat.files ?? 0) > 0 || changes.row.ahead > 0 ? 'all committed' : 'no changes';
  }

  const label = (repo: string) => groups.find((one) => one.repo === repo)?.name ?? (repo === '.' ? 'project folder' : repo);

  // The arrow keys move along the tabs, and Home and End go to either end, as a tab list does.
  function arrows(event: KeyboardEvent): void {
    const at = tabs.findIndex((one) => one.repo === shown);
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = tabs[(to + tabs.length) % tabs.length];
    if (next === undefined) return;
    picked = next.repo;
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[id="tab${repoSuffix(next.repo)}"]`)?.focus();
  }

  // Said after a commit, and kept, because the composer closes when nothing is left in its group.
  let committed = $state<Record<string, string>>({});

  async function commit(repo: string, message: string, paths: string[], hooks: boolean): Promise<Answer> {
    const answer = await oncommit(repo, message, paths, hooks);
    if (answer.ok) committed[repo] = 'Committed. Nothing left the machine.';
    return answer;
  }
</script>

<!-- One line over the diff: the name, the branch, what is not committed, base, ahead and behind. -->
{#snippet facts(changes: Changes, name: string)}
  <div class="head" data-facts>
    <b class="name" class:quiet={!hasWork(changes)}>{name}</b>
    {#if changes.ok && changes.row.branch !== null}<Chip mono>{changes.row.branch}</Chip>{/if}
    <span class="state" class:quiet={!hasWork(changes)}>{standing(changes)}</span>
    {#if changes.ok}<span class="m">base {changes.row.base} · {changes.row.ahead} ahead · {changes.row.behind} behind</span>{/if}
  </div>
{/snippet}

<!-- Not committed with nothing to commit: the branch's own commits, newest first. Each opens its own
     diff, the commit against its parent, read only. -->
{#snippet history(repo: string, changes: Extract<Changes, { ok: true }>)}
  {@const commits = changes.commits ?? null}
  {@const seen = opened[repo] ?? null}
  <p class="nothing" data-nothing>Nothing to commit.</p>
  {#if commits === null && changes.row.ahead > 0}
    <!-- The page reads the list when it switches to this view, so the old answer has none yet. -->
    <Skeleton shape="rows" count={3} label="Reading the commits." />
  {:else if commits?.reason !== undefined}
    <p class="note" role="status">{commits.reason}</p>
  {:else if commits !== null && commits.list.length > 0}
    <section class="history" aria-labelledby="history{repoSuffix(repo)}" data-history>
      <h3 id="history{repoSuffix(repo)}">Commits since {changes.row.base}</h3>
      <ul>
        {#each commits.list as one (one.sha)}
          {#snippet line()}
            <span class="m">{one.short}</span> <span class="subject">{one.subject}</span>
            <span class="pushed" class:quiet={one.pushed}>{one.pushed ? 'pushed' : 'not pushed'}</span>
          {/snippet}
          <li>
            {#if oncommitdiff === null}
              <span class="commit">{@render line()}</span>
            {:else}
              <button type="button" class="commit" aria-pressed={seen?.commit.sha === one.sha} aria-busy={seen?.commit.sha === one.sha && seen.diff === null ? 'true' : undefined} onclick={() => openCommit(repo, one)} data-commit={one.sha}>{@render line()}</button>
            {/if}
          </li>
        {/each}
      </ul>
      {#if commits.total > commits.list.length}<p class="m">and {commits.total - commits.list.length} older</p>{/if}
    </section>
  {/if}
  {#if seen !== null}
    {#if seen.diff === null}
      <Skeleton shape="block" height="160px" label="Reading the commit." />
    {:else if !seen.diff.ok}
      <p class="note" role="status">{seen.diff.reason}</p>
    {:else}
      {@const sha = seen.commit.sha}
      {#key sha}
        <ChangesTab
          changes={{ ...changes, conflicted: [], diff: seen.diff.diff }}
          group="commit"
          against="the parent of {seen.commit.short}"
          onopen={(ask) => onopen(repo, { ...ask, commit: sha })}
        />
      {/key}
    {/if}
  {/if}
{/snippet}

{#snippet group(repo: string, changes: Changes, publish: Publish, here: boolean)}
  {@const composer = changes.ok && changes.uncommitted !== null && changes.uncommitted.stat.files > 0}
  {@const loose = changes.ok && changes.uncommitted !== null ? entriesOf(changes.uncommitted.tree) : []}
  {@const pushes = changes.ok && publish.ok && (changes.row.ahead > 0 || loose.length > 0)}
  {@const open = unsent.filter((one) => one.repo === repo).length}
  {@const asks = here && next !== null && unsent.length > 0}
  <!-- Two columns: the diff, and on the right the next step and the
       commit and push composer. They stack when the page is too narrow for both. -->
  <div class="split">
    <div class="main">
      {#if view === 'all'}
        <ChangesTab
          {changes}
          onopen={(ask) => onopen(repo, ask)}
          comments={comments.filter((one) => one.repo === repo)}
          oncomment={oncomment === null ? null : (ask) => oncomment(repo, ask)}
          {onedit}
          {ondelete}
        />
      {:else if changes.ok && !hasUncommitted(changes)}
        {@render history(repo, changes)}
      {:else}
        <!-- A comment points at a line of the whole change and is checked against it, so this view
             takes none. -->
        <ChangesTab
          changes={changes.ok && changes.uncommitted !== null ? { ...changes, diff: changes.uncommitted } : changes}
          group="uncommitted"
          against="the last commit"
          onopen={(ask) => onopen(repo, ask)}
        />
        {#if oncomment !== null}<p class="note">Comments on the diff are made on Whole card.</p>{/if}
      {/if}
    </div>
    {#if composer || pushes || asks || committed[repo] !== undefined}
      <div class="side">
        {#if asks}{@render next?.()}{/if}
        {#if composer || pushes}
          <section class="ship" aria-labelledby="ship-title{repoSuffix(repo)}">
            <div class="ship-head"><h2 id="ship-title{repoSuffix(repo)}">Commit and push</h2><span class="sub">{label(repo)}</span></div>
            {#if changes.ok && changes.uncommitted !== null && composer}
              <CommitComposer
                {repo}
                files={loose}
                oncommit={(message, paths, hooks) => commit(repo, message, paths, hooks)}
                onwrite={(short) => onwrite(repo, short)}
              />
            {/if}
            {#if changes.ok && publish.ok && pushes}
              {@const stat = changes.pushes ?? changes.branch ?? changes.committed?.stat ?? null}
              <!-- The change is what the push adds with the folder committed: from the upstream once the branch
                   was pushed, from the base before. The commits: those not on the upstream, or every one ahead of the base before the first
                   push, which has no upstream to count against. -->
              <PublishPanel
                {repo}
                {card}
                confirmation={publish.confirmation}
                pushed={publish.pushed}
                compare={publish.compare}
                branch={publish.branch ?? null}
                remote={publish.remote ?? null}
                host={publish.host ?? null}
                place={publish.place ?? null}
                pull={publish.pull ?? null}
                change={stat === null ? null : { added: stat.added, removed: stat.removed, files: stat.files, commits: changes.row.unpushed ?? changes.row.ahead }}
                uncommitted={loose.length}
                onpush={(message, hooks) => onpush(repo, message, hooks)}
                onpull={onpull === null ? null : () => onpull(repo)}
                {oncopy}
                {onopenpr}
              />
            {/if}
            <!-- A comment not sent yet locks nothing. The person may fix the line by
                 hand and commit, so this only says it, never as a refusal. -->
            {#if open > 0}
              <p class="unsent" data-unsent>{open === 1 ? '1 comment is' : `${open} comments are`} not sent back yet. A commit does not send {open === 1 ? 'it' : 'them'}.</p>
            {/if}
          </section>
        {/if}
        <p class="committed" role="status">{committed[repo] ?? ''}</p>
      </div>
    {/if}
  </div>
{/snippet}

{#if onview !== null}
  <!-- The two views. The pick goes in the address, so a reload and a link keep it. -->
  <div class="views" role="group" aria-label="What the diff shows" data-views>
    <button type="button" aria-pressed={view === 'uncommitted'} onclick={() => onview('uncommitted')}>Not committed</button>
    <button type="button" aria-pressed={view === 'all'} onclick={() => onview('all')}>Whole card</button>
  </div>
{/if}
<!-- One markup for one repository or several, so a switch of view that changes how many show keeps
     each panel, and a typed message with it. One repository has nothing to switch to: no tab row and
     no heading, only its facts line, then the diff. -->
{#if tabs.length > 1}
  <div class="tabs" role="tablist" aria-label="Repositories" tabindex="-1" onkeydown={arrows}>
    {#each tabs as one (one.repo)}
      <button
        type="button"
        class="tab"
        role="tab"
        id="tab{repoSuffix(one.repo)}"
        aria-selected={one.repo === shown}
        aria-controls="panel{repoSuffix(one.repo)}"
        tabindex={one.repo === shown ? 0 : -1}
        onclick={() => (picked = one.repo)}><b>{label(one.repo)}</b> <span class="m">{lines(one.changes)}</span></button
      >
    {/each}
  </div>
{/if}
{#each tabs as one (one.repo)}
  {@const many = tabs.length > 1}
  <!-- Every panel stays on the page, so a typed message or a comment field waits while another
       repository is shown. -->
  <div
    class="repo-group"
    role={many ? 'tabpanel' : undefined}
    id={many ? `panel${repoSuffix(one.repo)}` : undefined}
    data-repo={many ? one.repo : undefined}
    aria-labelledby={many ? `repo${repoSuffix(one.repo)}` : undefined}
    hidden={one.repo !== shown}
  >
    <!-- The project folder is named the way the Settings tab names it. Read out, the tab shows it. -->
    {#if many}<h2 class="repo" id="repo{repoSuffix(one.repo)}">{label(one.repo)}</h2>{/if}
    {@render facts(one.changes, label(one.repo))}
    {@render group(one.repo, one.changes, one.publish, one.repo === shown)}
  </div>
{/each}
{#if rest.length > 0}
  <!-- The repositories the card did nothing in, closed until the person opens them. No git ran for a
       repository the card has no checkout in. -->
  <button type="button" class="more" aria-expanded={showRest} onclick={() => (showRest = !showRest)} data-rest-toggle>
    <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>{rest.length} without changes
  </button>
  {#if showRest}
    <ul class="rest" data-rest-list>
      {#each rest as one (one.repo)}
        <li><span>{label(one.repo)}</span> <span class="m">{standing(one.changes)}</span></li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  /* The two way switch, as the tabs below draw a picked tab. */
  .views {
    display: inline-flex;
    margin-bottom: var(--space-4);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .views button {
    padding: 4px 12px;
    border: 0;
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .views button + button {
    border-left: 1px solid var(--line);
  }

  .views button[aria-pressed='true'] {
    background: var(--card);
    color: var(--ink);
    font-weight: 600;
  }

  .nothing {
    margin: 0 0 var(--space-4);
    color: var(--ink);
    font-size: var(--text-base);
    font-weight: 600;
  }

  .note {
    margin: var(--space-3) 0 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .history {
    margin-bottom: var(--space-4);
  }

  .history h3 {
    margin: 0 0 var(--space-2);
    color: var(--ink-2);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .history ul {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 0 var(--space-2);
    padding: 0;
    list-style: none;
  }

  .commit {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2) var(--space-3);
    width: 100%;
    padding: 4px var(--space-2);
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
    text-align: left;
    overflow-wrap: anywhere;
  }

  button.commit {
    cursor: pointer;
  }

  button.commit:hover,
  button.commit[aria-pressed='true'] {
    border-color: var(--line);
    background: var(--card);
  }

  .subject {
    flex: 1 1 200px;
    min-width: 0;
  }

  .pushed {
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  .pushed.quiet {
    color: var(--muted);
  }

  .committed,
  .unsent {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .committed:empty {
    display: none;
  }

  .split {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 28px;
  }

  .main {
    flex: 999 1 640px;
    min-width: 0;
  }

  .side {
    display: flex;
    flex: 1 1 300px;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 360px;
    min-width: 0;
  }

  /* The Commit and push panel: one panel, the repository beside its title, then
     the message, the steps and what is still open. */
  .ship {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .ship-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
  }

  .ship-head h2 {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .ship-head .sub {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  /* The repository switcher: one small tab per repository the card changed, the shown one on the card
     fill. */
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: var(--space-4);
  }

  .tab {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
    padding: 4px 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
    cursor: pointer;
  }

  .tab[aria-selected='true'] {
    border-color: var(--ink-2);
    background: var(--card);
    color: var(--ink);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-3);
    margin-bottom: var(--space-4);
  }

  /* A long branch name wraps in its line, never cut, because the person may need all of it. */
  .head :global(.chip) {
    min-width: 0;
    max-width: 100%;
    height: auto;
    min-height: 21px;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  /* A long folder name wraps too, so a narrow screen never scrolls sideways. */
  .name {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: var(--text-base);
    font-weight: 600;
  }

  .name.quiet {
    color: var(--ink-2);
  }

  .state {
    font-size: var(--text-xs);
    color: var(--ink-2);
  }

  .state.quiet {
    color: var(--muted);
  }

  .m {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  /* The "N without changes" line, as the Workspace page draws its "N clean". */
  .more {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: var(--space-5);
    padding: 6px var(--space-2);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .more:hover {
    background: var(--card);
  }

  .chev {
    flex: none;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: var(--muted);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  [aria-expanded='true'] > .chev {
    transform: rotate(90deg);
  }

  .rest {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: var(--space-2) 0 0;
    padding: 0 var(--space-2) 0 28px;
    list-style: none;
    color: var(--ink-2);
    font-size: var(--text-sm);
  }

  .rest li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    overflow-wrap: anywhere;
  }

  /* Read out as the panel's heading. The tab above it shows the name. */
  .repo {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
