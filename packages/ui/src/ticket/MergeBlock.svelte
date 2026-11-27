<script lang="ts">
  import type { CardView, StageView } from '@nolzu/protocol';
  import Button from '../Button.svelte';
  import { dropTarget, startsCommand, type Usage } from '../board/drop.ts';
  import { type Seen, settle } from './actions.ts';
  import Ago from './Ago.svelte';
  import Block from './Block.svelte';
  import { blockerLine, FIX_CI_LABEL, FIX_CI_NOTE, fixCiOf, type MergePull, RUNNING_WORDS } from './merge.ts';

  // Why the card's open pull requests cannot merge, each reason on its own line with its links, as the
  // last read stored it. A card with several pull requests, one per repository, names each one.
  // `fixCi` draws Fix CI beside the first failed checks: the card from the snapshot and its board's
  // stages, so the button holds until the board shows the card moved. The page owns the request, and
  // `onfix` answers the sentence the server refused with, or null once the run is queued.
  let {
    pulls,
    now,
    fixCi = null,
  }: {
    pulls: readonly MergePull[];
    now: Date;
    fixCi?: { card: CardView; stages: readonly StageView[]; usage?: Usage; onfix: () => Promise<string | null>; onrefuse?: (said: string | null) => void } | null;
  } = $props();
  const uid = $props.id();
  const link = (pull: MergePull) => pull.url ?? `https://github.com/${pull.repo}/pull/${pull.number}`;
  const view = $derived(fixCi === null ? null : fixCiOf(fixCi.card, fixCi.stages, pulls));
  const target = $derived(view === null || view.refusal !== null ? null : dropTarget(view.implement, true, fixCi?.usage));
  const estimate = $derived(target?.kind === 'starts' ? target.estimate : undefined);
  // The button goes beside the first failed checks, once.
  const first = $derived(pulls.find((pull) => pull.read.blockers.some((one) => one.kind === 'checks')));

  // Let go when this card's key, stage or state moves, as the decision panel does.
  const at = $derived(fixCi === null ? '' : `${fixCi.card.key} ${fixCi.card.stage} ${fixCi.card.state}`);
  let pressed = $derived.by<Seen | null>(() => {
    void at;
    return null;
  });
  const held = $derived(fixCi !== null && settle(pressed, fixCi.card) !== null);

  // The handler refuses the press, not the disabled attribute, so the button keeps the focus.
  async function press(): Promise<void> {
    if (fixCi === null || view === null || view.refusal !== null || held) return;
    const mine = { key: fixCi.card.key, stage: fixCi.card.stage, state: fixCi.card.state };
    pressed = mine;
    fixCi.onrefuse?.(null);
    const answer = await fixCi.onfix();
    if (answer === null || pressed !== mine) return;
    pressed = null;
    fixCi.onrefuse?.(answer);
  }
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
            {#if blocker.kind === 'checks' && view !== null && pull === first}
              <div class="fix" data-fix-ci={view.refusal === null ? 'go' : 'refused'}>
                <!-- Amber only while the press would start the run. A refused start keeps its words and
                     loses the amber, as the decision panel's does. -->
                <Button
                  variant={view.refusal === null ? 'go' : 'default'}
                  size="small"
                  data-run="fix-ci"
                  aria-disabled={view.refusal !== null || held ? 'true' : undefined}
                  aria-busy={held ? 'true' : undefined}
                  aria-describedby="{uid}-note {uid}-why"
                  onclick={press}>{FIX_CI_LABEL}</Button
                >
                {#if view.implement.starts !== null}<span class="command">{startsCommand(view.implement.starts)}</span>{/if}
                {#if estimate !== undefined}<span class="estimate"><span class="figure">{estimate.text}</span>, {estimate.from}</span>{/if}
                <p class="note" id="{uid}-note">{FIX_CI_NOTE}</p>
                {#if view.refusal !== null}<p class="refused">{view.refusal}</p>{/if}
                <p class="note" role="status" id="{uid}-why">{held ? 'Sent. Waiting for the board to show it.' : ''}</p>
              </div>
            {/if}
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

  /* Fix CI under the failed checks: the button, what it starts, the vendor line and a refusal. */
  .fix {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-top: 6px;
  }

  .fix p {
    flex-basis: 100%;
    margin: 0;
  }

  /* Mono, because it names an engine, a model and an effort. */
  .command {
    display: inline-flex;
    align-items: center;
    min-height: 26px;
    padding: 0 var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: 7px;
    background: var(--card);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .estimate,
  .note {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .note:empty {
    display: none;
  }

  /* The figure in mono and a text ink. Never amber: it is a figure, not the start. */
  .figure {
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  /* A neutral box, as every warning is. */
  .refused {
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  a:focus-visible {
    border-radius: var(--radius-sm);
    outline: 2px solid var(--blue);
    outline-offset: 2px;
  }
</style>
