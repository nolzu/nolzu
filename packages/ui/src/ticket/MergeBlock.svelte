<script lang="ts">
  import Ago from './Ago.svelte';
  import Block from './Block.svelte';
  import { blockerLine, type MergePull, RUNNING_WORDS } from './merge.ts';

  // Why the card's open pull requests cannot merge, each reason on its own line with its links, as the
  // last read stored it. A card with several pull requests, one per repository, names each one.
  let { pulls, now }: { pulls: readonly MergePull[]; now: Date } = $props();
  const link = (pull: MergePull) => pull.url ?? `https://github.com/${pull.repo}/pull/${pull.number}`;
</script>

<Block id="merge" title="Why it cannot merge" data-merge="">
  {#snippet meta()}{#if pulls.length === 1 && pulls[0] !== undefined}read <Ago at={pulls[0].at} {now} />{/if}{/snippet}
  {#each pulls as pull (`${pull.repo}#${pull.number}`)}
    <div class="pull" data-merge-pull="{pull.repo}#{pull.number}">
      {#if pulls.length > 1}
        <h3><a class="mono" href={link(pull)} target="_blank" rel="noopener noreferrer">{pull.repo}#{pull.number}</a> <span class="quiet">read <Ago at={pull.at} {now} /></span></h3>
      {/if}
      <ul>
        {#each pull.read.blockers as blocker, at (at)}
          {@const line = blockerLine(blocker)}
          <li data-blocker={blocker.kind}>
            {line.text}{#each line.links as one, place (place)}{place === 0 ? ' ' : ', '}{#if one.url === null}{one.name}{:else}<a class="link" href={one.url} target="_blank" rel="noopener noreferrer">{one.name}</a>{/if}{/each}
          </li>
        {/each}
        {#if pull.read.running}<li data-blocker="running">{RUNNING_WORDS}</li>{/if}
      </ul>
    </div>
  {/each}
</Block>

<style>
  .pull {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 500;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding-left: 18px;
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--ink-2);
  }

  .quiet {
    color: var(--muted);
  }

  .link {
    color: var(--blue);
  }

  a:focus-visible {
    border-radius: var(--radius-sm);
    outline: 2px solid var(--blue);
    outline-offset: 2px;
  }
</style>
