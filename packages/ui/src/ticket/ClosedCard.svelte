<script lang="ts">
  import type { KnowledgeStatus, PullState } from '@nolzu/protocol';
  import { onMount } from 'svelte';
  import Button from '../Button.svelte';
  import Skeleton from '../Skeleton.svelte';
  import Ago from './Ago.svelte';
  import Block from './Block.svelte';
  import { patchLines } from './patch.ts';

  // What a closed card draws under the whole card's summary: the pull request state as one line, then
  // what the wrap-up taught with Revert, open, because a revert is the one action left. The checkouts
  // are the Overview's last line.
  let {
    knowledge,
    knowledgeHref,
    onpulls = null,
    onrevert,
    now = new Date(),
    diffsWaiting = false,
  }: {
    // `applied` is when the knowledge commit was made. Every time is drawn as a time ago on `now`, the
    // page's clock, as the trail draws its times.
    knowledge: readonly { id: number; path: string; status: KnowledgeStatus; summary: string | null; diff: string | null; applied?: string | null }[];
    knowledgeHref: string;
    // The page asks gh through the app. A null state is a gh that did not answer: the link stays, and
    // no state is drawn. Null on a card of a board that waits on no pull request, which shows none.
    // The merge, size and base fields come only when gh answered with them.
    onpulls?:
      | (() => Promise<{
          pulls: readonly {
            repo: string;
            branch: string;
            number: number | null;
            url: string;
            state: PullState | null;
            mergedBy?: string;
            mergedAt?: string;
            additions?: number;
            deletions?: number;
            files?: number;
            base?: string;
          }[];
          said: string | null;
        }>)
      | null;
    onrevert: (id: number) => Promise<{ ok: boolean; message: string }>;
    now?: Date;
    // True while git reads the patch of each change, which lands after the page drew.
    diffsWaiting?: boolean;
  } = $props();

  // Asked once the page has drawn, never on the server, so a slow or missing gh never holds the page.
  let read = $state<Awaited<ReturnType<NonNullable<typeof onpulls>>> | null>(null);
  onMount(() => {
    let gone = false;
    void onpulls?.().then((answer) => {
      if (!gone) read = answer;
    });
    return () => {
      gone = true;
    };
  });

  const WORD: Readonly<Record<PullState, string>> = { open: 'open', merged: 'merged', closed: 'closed without a merge' };
  type Pull = Awaited<ReturnType<NonNullable<typeof onpulls>>>['pulls'][number];
  // "#42 merged by you", then ", 2 hours ago" in the markup, each part left out when gh did not say it.
  const headline = (pull: Pull): string => {
    const merger = pull.state === 'merged' && pull.mergedBy !== undefined ? ` by ${pull.mergedBy}` : '';
    return `${pull.number === null ? 'Pull request' : `#${pull.number}`}${pull.state === null ? '' : ` ${WORD[pull.state]}`}${merger}`;
  };
  // "<repo> · <head> into <base> · +48 -6 in 3 files".
  const where = (pull: Pull): string => {
    const size =
      pull.additions === undefined || pull.deletions === undefined
        ? null
        : `+${pull.additions} -${pull.deletions}${pull.files === undefined ? '' : ` in ${pull.files === 1 ? '1 file' : `${pull.files} files`}`}`;
    return [pull.repo, pull.base === undefined ? pull.branch : `${pull.branch} into ${pull.base}`, size].filter((one) => one !== null).join(' · ');
  };
  const applied = $derived(knowledge.find((change) => change.applied != null)?.applied ?? null);

  // A revert is a commit and no run, so it holds its own button and says how it went.
  let reverting = $state<number | null>(null);
  let said = $state<Record<number, string>>({});
  async function revert(id: number): Promise<void> {
    if (reverting !== null) return;
    reverting = id;
    const answer = await onrevert(id);
    said = { ...said, [id]: answer.message };
    reverting = null;
  }

  // The lines the commit took out and put in. git's "no newline" note is about the file, not its words.
  const lines = (diff: string) => patchLines(diff).filter((line) => line.kind !== 'hunk' && !line.text.startsWith('\\'));
</script>

{#if onpulls !== null}
<section class="part" aria-label="Pull request">
  {#if read === null}
    <Skeleton shape="line" width="260px" label="Reading the pull request state through gh." />
  {:else}
    {#each read.pulls as pull (pull.url)}
      <!-- One line, as every block's header: the state in bold, where in mono, the link at the end. The
           state is a heading like every other block title, so a screen reader can jump to it. -->
      <div class="pull" data-pull={pull.state ?? 'unknown'}>
        <h2>{headline(pull)}{#if pull.state === 'merged' && pull.mergedAt !== undefined}, <Ago at={pull.mergedAt} {now} />{/if}</h2>
        <span class="mono">{where(pull)}</span>
        <a class="link" href={pull.url} target="_blank" rel="noopener noreferrer">Open on GitHub</a>
      </div>
    {:else}
      {#if read.said === null}<p class="quiet">No repository of this card has a GitHub origin, so there is no pull request to read.</p>{/if}
    {/each}
    {#if read.said !== null}<p class="quiet">{read.said}</p>{/if}
  {/if}
</section>
{/if}

<Block id="learned-title" title="What Nolzu learned">
  {#snippet meta()}{#if knowledge.length > 0}wrap-up changed {knowledge.length === 1 ? '1 file' : `${knowledge.length} files`}{#if applied !== null}, applied <Ago at={applied} {now} />{/if}{/if}{/snippet}
  {#each knowledge as change (change.id)}
    <div class="change" data-change={change.id} data-status={change.status}>
      <div class="change-head">
        <span class="mono path">{change.path}</span>
        <span class="end">
          {#if change.status === 'applied'}
            <Button size="small" data-revert={change.id} disabled={reverting !== null} aria-busy={reverting === change.id ? 'true' : undefined} onclick={() => revert(change.id)}>Revert</Button>
          {:else if change.status === 'pending'}
            <span class="quiet">waits for review</span> <a class="link" href={knowledgeHref}>Review it on Knowledge</a>
          {:else}
            <span class="quiet">{change.status}</span>
          {/if}
        </span>
      </div>
      {#if change.diff !== null}
        {#each lines(change.diff) as line, at (at)}
          <p class="line" data-kind={line.kind}>{line.text.slice(1)}</p>
        {/each}
      {:else if diffsWaiting}
        <Skeleton shape="block" height="48px" label="Reading the change with git." />
      {/if}
      {#if said[change.id] !== undefined}<p class="quiet said" role="status">{said[change.id]}</p>{/if}
    </div>
  {:else}
    <p class="quiet">This card changed no knowledge file.</p>
  {/each}
</Block>

<style>
  .part {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .change-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }

  p {
    margin: 0;
  }

  .quiet {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .link {
    color: var(--blue);
    font-size: var(--text-xs);
  }

  .pull {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }

  .pull h2 {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  /* A plain link: ink, not the blue of a text link. */
  .pull .link {
    margin-left: auto;
    color: var(--ink-2);
    text-decoration: none;
  }

  .change {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .change-head {
    padding: 6px 8px 6px 14px;
  }

  .path {
    color: var(--ink-2);
  }

  .end {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-left: auto;
  }

  .line {
    position: relative;
    padding: 4px 14px 4px 32px;
    color: var(--ink);
    font-size: var(--text-sm);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .line::before {
    position: absolute;
    left: 14px;
    font-family: var(--font-mono);
  }

  /* A blank line of the patch keeps its height, so its mark does not crowd the next one. */
  .line:empty::after {
    content: '\200b';
  }

  /* Red on its own tint passes the text contrast test in both themes. */
  [data-kind='del'] {
    background: var(--red-bg);
    color: var(--red);
    text-decoration: line-through;
    text-decoration-color: var(--red);
  }

  [data-kind='del']::before {
    color: var(--red);
    content: '-';
  }

  [data-kind='add'] {
    background: var(--green-bg);
  }

  [data-kind='add']::before {
    color: var(--green);
    content: '+';
  }

  .said {
    padding: 6px 14px;
  }
</style>
