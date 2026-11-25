<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { besideCard, Button, CardRecord, cardPill, Chip, conventionalComments, DecisionPanel, Kbd, liveOf, PhaseStrip, runView, scoped, StartConfirm, StatePill, TabBar, tabKeys, visibleColumns } from '@nolzu/ui';
  import { type Snippet, untrack } from 'svelte';
  import { CARD_STATES, choiceLabel, choiceOf, CLOUD_OPEN, type BoardSnapshot, type CardState, type ProfileLimit, type RunActivity, type Segment, type Spend } from '@nolzu/protocol';
  import type { ReviewBlock } from '@nolzu/ui/review';
  import { merged, pullTrail, type PullsRead, readCardPulls, type TimedWords } from '$lib/card-pulls.ts';
  import { copyText } from '$lib/clipboard.ts';
  import { browserStream, connectBoard, type BoardState } from '$lib/snapshot-client.ts';
  import { keyWrite, nextStepOf, streamAddress } from '$lib/board-page.ts';
  import { nowLive } from '$lib/now-live.svelte.ts';
  import { pageKeys } from '$lib/page-keys.svelte.ts';
  import { streamed } from '$lib/held-answer.svelte.ts';
  import BranchFact from '$lib/BranchFact.svelte';
  import DeleteCard from '$lib/DeleteCard.svelte';
  import Streamed from '$lib/Streamed.svelte';
  import { nextStepWrites } from '$lib/next-step.ts';
  import { clusterNote, forwardMove, postWrite, retryStage, stageLabel } from '$lib/ticket.ts';
  import { whenSaid } from '$lib/when-said.ts';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  // The card's own board, so this page reads the card from the same snapshot the board does. Any other
  // board would not hold the card, and the card row would say it left the board. It comes out of the
  // Now stream the root layout keeps open, which carries every board that is on, so the tab holds one
  // connection: a browser holds six to one host over HTTP/1.1, counted over all its tabs. No Now
  // snapshot carries a board that is off, so a card there opens that board's own stream.
  const off = $derived(data.offBoards.includes(data.ticket.board));
  // The crumb names the place the rail lists: Research for a question or an investigation.
  const crumb = $derived(choiceOf(data.ticket.board));
  let own = $state.raw<BoardState | null>(null);
  $effect(() => {
    own = null;
    if (!off) return;
    const client = connectBoard(browserStream(streamAddress(resolve('/api/board'), data.ticket.board)), (state) => (own = state));
    return () => client.close();
  });
  const snapshot = $derived<BoardSnapshot | null>(off ? (own?.snapshot ?? null) : (nowLive.state.snapshot?.boards.find((one) => one.kind === data.ticket.board) ?? null));
  // True while the stream is failing. The buttons come from the snapshot, so with no snapshot and
  // no word about it the page would read as one that has no actions.
  const down = $derived(off ? (own?.reconnecting ?? false) : nowLive.state.reconnecting);
  const activity = $derived<Readonly<Record<string, RunActivity>>>(off ? (own?.activity ?? {}) : nowLive.state.activity);
  const limits = $derived<Readonly<Record<string, ProfileLimit>>>(off ? (own?.limits ?? {}) : nowLive.state.limits);

  // One read of one snapshot, so the panel, its button and the pill never show two moments.
  const forward = $derived(snapshot === null ? null : forwardMove(snapshot, data.ticket.key));
  // The page load until the first snapshot arrives, and the board from then on.
  const shown = $derived(forward?.card ?? data.ticket);
  const note = $derived(clusterNote(snapshot, down, data.ticket.key));
  const stageName = $derived(stageLabel(data.ticket.board, shown.stage));

  // The tabs read the card once, when they load. A run that asks a question, ends, or is answered
  // changes what they show, and so does a move to another column, such as the PRs tab from Pull request
  // on. So the page reads the card again whenever the board says its state or its column moved.
  // Keyed with the card, because the layout stays mounted when the page moves to another ticket.
  let seen: { key: string; state: string; stage: string } | null = null;
  $effect(() => {
    const now = { key: data.ticket.key, state: shown.state, stage: shown.stage };
    if (seen?.key === now.key && (seen.state !== now.state || seen.stage !== now.stage)) void invalidateAll();
    seen = now;
  });

  // The clock of the run time and of Quiet, every second while the card runs, and of the trail's times
  // ago, every half minute. It starts at the time the server drew the page with, so the first paint
  // says what the server said.
  let clock = $state(untrack(() => new Date(data.now)));
  $effect(() => {
    const every = shown.state === 'running' ? 1000 : 30_000;
    clock = new Date();
    const timer = setInterval(() => (clock = new Date()), every);
    return () => clearInterval(timer);
  });
  const live = $derived(forward === null ? null : liveOf(forward.card, activity[data.ticket.key], clock, snapshot?.quietAfterMs));

  const current = $derived(page.params.tab ?? 'overview');
  // The pill draws a coloured dot and reads its word from a fixed list. A state outside that list
  // would render a dot with no word, and status is never colour alone. The board card's words: Quiet,
  // "Asks you", "Plan ready" with the phase, "QA failed", and Closed with a check.
  const known = $derived((CARD_STATES as readonly string[]).includes(shown.state));
  const column = $derived(snapshot?.stages.find((one) => one.id === shown.stage) ?? null);
  const pill = $derived(forward === null ? { state: shown.state as CardState, word: null, detail: null, check: undefined } : cardPill(forward.card, live, clock, column));
  // K and J, in the order the board draws its cards.
  const around = $derived(snapshot === null ? null : besideCard(visibleColumns(snapshot.stages, snapshot.cards), data.ticket.key));
  // A closed Delivery card's Changes tag says merged once its pull request reads so. Asked after the
  // page has drawn, so the load never waits on GitHub; the Overview shares the read.
  // The record's Pull request row reads the same answer.
  let pulls = $state<{ key: string; read: PullsRead } | null>(null);
  $effect(() => {
    const key = data.ticket.key;
    if (!data.closed || !data.tabs.some((tab) => tab.id === 'changes')) return;
    void readCardPulls(resolve('/api/card/[key]/pr', { key: encodeURIComponent(key) })).then((read) => {
      pulls = { key, read };
    });
  });
  const pullRead = $derived(pulls?.key === data.ticket.key ? pulls.read : null);
  // The Changes count asks git, so it lands after the page drew. The tab shows a grey pill until then.
  const changes = streamed(
    () => data.changes,
    () => data.ticket.key,
  );
  const counts = $derived({ ...data.counts, ...(changes.current?.ok ? changes.current.value : {}), ...(pullRead !== null && merged(pullRead) ? { changes: 'merged' } : {}), ...(shown.state === 'running' ? { log: 'live' } : {}) });
  const pullNotes = $derived.by((): Record<string, TimedWords[]> => {
    const label = snapshot?.stages.find((one) => one.id === 'pr-watch')?.label;
    const lines = (pullRead?.pulls ?? []).map((pull) => pullTrail(pull)).filter((line) => line !== null);
    return label === undefined || lines.length === 0 ? {} : { [label]: lines.flatMap((line, at) => (at === 0 ? line : [{ words: '; ' }, ...line])) };
  });

  // What the decision panel needs besides the card, by the rule the peek reads too.
  const step = $derived(
    snapshot === null
      ? null
      : nextStepOf(snapshot, data.ticket.key, data.openComments, { card: resolve('/t/[key]/[tab]', { key: encodeURIComponent(data.ticket.key), tab: 'settings' }), models: resolve('/settings/[section]', { section: 'models' }) }),
  );
  const fixIt = $derived(step?.fixIt ?? null);
  // The card's own row for the phase the button starts.
  const picker = $derived.by(() => {
    const row = data.models?.rows.find((one) => one.action === step?.go?.starts?.phase);
    if (row === undefined || data.models === null) return null;
    return { action: row.action, engine: row.resolved.engine, model: row.resolved.model, effort: row.resolved.effort, profiles: data.models.profiles };
  });
  // The thread of the phase the card sits in, once that phase has run.
  const threadHref = $derived.by(() => {
    const phase = snapshot?.stages.find((one) => one.id === shown.stage)?.starts?.phase;
    if (phase === undefined || shown.state === 'idle' || !data.tabs.some((tab) => tab.id === 'discussion')) return null;
    return `${resolve('/t/[key]/[tab]', { key: encodeURIComponent(data.ticket.key), tab: 'discussion' })}?thread=${phase}`;
  });
  // When a blocked card started to wait, off the Now stream. A board that is off is not on it, so the
  // panel then leaves the time out. The trail draws it as a time ago, the panel as a clock time.
  const waitAt = $derived(shown.state === 'blocked' ? (nowLive.state.snapshot?.waiting[data.ticket.key]?.since ?? null) : null);
  const waitSince = $derived(waitAt === null ? null : whenSaid(waitAt, new Date()));
  // The trail and the facts are the overview's, read with it, and drawn here in the right column. A
  // closed card draws its record there instead: the totals and every move.
  const extra = $derived(
    page.data as {
      overview?: { strip: Segment[]; spend: Spend; moves: { label: string; said: string; at?: string; phase: string | null; reason?: string; from?: string | null }[] } | null;
      facts?: Promise<{ label: string; value: string; edit?: { locked: string | null }; file?: string; ticket?: { key: string; href: string | null } }[]> | null;
      implementSession?: string | null;
      closed?: boolean;
      review?: { current: number | null; blocks: readonly ReviewBlock[]; why: string | null } | null;
    },
  );
  // On the Review tab the panel says why another round makes sense while the next step is Agent
  // pre-review, which is a card a push sent back to Incoming, and copies the shown round for the pull
  // request. Before the first round there is no reason to give. Nolzu posts nothing to GitHub.
  const review = $derived(current === 'review' ? (extra.review ?? null) : null);
  const reason = $derived(forward?.next?.starts?.phase === 'pr-review' ? (review?.why ?? null) : null);
  const findings = $derived(review === null || review.current === null || review.blocks.length === 0 ? null : { text: conventionalComments(review.blocks), round: review.current });
  const copyFindings = async (text: string) =>
    (await copyText(text)) ? null : 'The findings were not copied. The browser refused the clipboard, so select the findings and copy them by hand.';
  const logBase = $derived(resolve('/t/[key]/[tab]', { key: encodeURIComponent(data.ticket.key), tab: 'log' }));
  // The Implement session Fix it goes on in, as the facts name it. Read off the database with the
  // overview, not off the facts git streams, so the button never waits. None, and it starts fresh.
  const session = $derived(extra.implementSession ?? null);

  // The panel's writes, which the peek sends too. Keyed with the card, because the layout stays mounted
  // when the page moves to another ticket.
  const writes = $derived(nextStepWrites(data.ticket.key));
  // A write that parks the card, not a run, so it holds nothing. The board's answer flips the label.
  async function minimize(): Promise<void> {
    writes.onrefuse(null);
    writes.onrefuse(await writes.onminimize(forward?.card.minimized !== true));
  }
  // A direct git write, not a run. The facts are read again after it, so the row shows the new name.
  const renameBranch = async (name: string): Promise<string | null> => {
    const said = await postWrite(fetch, resolve('/api/card/[key]/branch', { key: encodeURIComponent(data.ticket.key) }), { name });
    if (said === null) await invalidateAll();
    return said;
  };

  // The card's own row for one phase, a direct write and not a run. The panel shows its own pending
  // line, and the page reads the rows again after it. Engine and model go in one write.
  async function pickRow(action: string, choice: { engine: string; model: string } | { effort: string }): Promise<string | null> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/models', { key: encodeURIComponent(data.ticket.key) }), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...choice }),
      });
      if (!answer.ok) return ((await answer.json().catch(() => null)) as { message?: string } | null)?.message ?? `The change was refused with ${answer.status}.`;
      await invalidateAll();
      return null;
    } catch {
      return 'The change could not be sent. The local app is not answering.';
    }
  }

  // A key presses the same link or button the page shows, so typing 2 and clicking Files do the same
  // thing and neither can drift from the other. False when the page shows no such control, so the
  // browser keeps the key.
  function press(selector: string): boolean {
    const found = document.querySelector<HTMLElement>(selector);
    found?.click();
    return found !== null;
  }

  // The run keys press the panel's button, which holds itself until the board shows the card moved.
  // The panel is on the overview and the Review tab, so on another tab the key sends the same write
  // itself.
  function act(selector: string, send: () => Promise<string | null>): void {
    if (press(selector)) return;
    void send().then((said) => {
      if (said !== null) writes.onrefuse(said);
    });
  }

  // Retry asks first, with the Starts line a drop shows, and Confirm presses the Retry button. A refused
  // retry opens the same confirm, which shows the refusal with Confirm off, so it sends nothing, as a
  // refused drop sends nothing. It holds the card it is open for, because the layout stays mounted when
  // the page moves to another ticket, and Confirm would press that card's Retry.
  let starting = $state<string | null>(null);
  const startStage = $derived(starting !== data.ticket.key || snapshot === null ? null : retryStage(snapshot, data.ticket.key));
  // The confirm goes when its card stops being failed. Left set, it would open again by itself, with
  // focus on Confirm, the next time the card failed.
  $effect(() => {
    if (startStage === null) starting = null;
  });
  // R on a QA FAIL asks first too, naming both runs, and Confirm presses Fix it. It holds its card the
  // way the retry confirm does, and goes once the card no longer offers Fix it.
  let fixing = $state<string | null>(null);
  const fixStart = $derived(fixing !== data.ticket.key ? null : fixIt);
  $effect(() => {
    if (fixStart === null) fixing = null;
  });
  // Delete card, from More actions or under a closed card's record. It holds the card it is open for, as
  // the confirms above do, and goes back to the board once the card is gone.
  let deleting = $state<string | null>(null);
  const toBoard = () => goto(crumb === 'research' ? resolve('/b/research') : resolve('/b/[board]', { board: crumb }));

  // The run control the card has, as a word, so the keys change only when it does. A key is bound only
  // while its control exists, so the help lists no key that does nothing on this card.
  const control = $derived(forward === null ? null : (runView(forward.card, null)?.kind ?? 'none'));

  // The sticky head's height, measured. The tabs' own sticky parts stop under it, and the scroll padding
  // in the style below reads it.
  let headHeight = $state(0);
  $effect(() => {
    const root = document.documentElement;
    root.style.setProperty('--thead-height', `${headHeight}px`);
    return () => root.style.removeProperty('--thead-height');
  });

  $effect(() =>
    pageKeys.show({
      keys: [...scoped('card'), ...tabKeys(data.tabs)],
      actions: {
        ...Object.fromEntries(data.tabs.map((tab) => [`tab:${tab.id}`, () => press(`[data-tab="${tab.id}"]`)])),
        back: () => press('[data-back]'),
        // Bound only while there is a card on that side, so the help lists no key that does nothing.
        ...(around?.previous == null ? {} : { previous: () => press('[data-card="previous"]') }),
        ...(around?.next == null ? {} : { next: () => press('[data-card="next"]') }),
        ...(control === null ? {} : { minimize: () => act('[data-minimize]', () => writes.onminimize(forward?.card.minimized !== true)) }),
        ...(control === 'stop' ? { stop: () => act('[data-run="stop"]', () => writes.onstop(forward?.card.runId)) } : {}),
        ...(control === 'retry'
          ? {
              retry: () => {
                const said = snapshot === null ? null : keyWrite(snapshot, data.ticket.key, 'retry');
                if (said === null) return false;
                if (said.kind === 'send') act('[data-run="retry"]', writes.onretry);
                else starting = data.ticket.key;
              },
            }
          : fixIt !== null
            ? { retry: () => void (fixing = data.ticket.key) }
            : {}),
      },
    }),
  );
</script>

<svelte:head><title>{data.ticket.key} {data.ticket.title} · Nolzu</title></svelte:head>

<!-- The card page head: the breadcrumb with K and J, the title with its pills, then the tabs.
     It stays at the top while the page scrolls. Its height goes to the page as scroll padding, so
     a link to a place on the page, such as the question, lands below it and not under it. -->
<header class="thead" bind:offsetHeight={headHeight}>
  <div class="r">
    <a class="crumb" href={crumb === 'research' ? resolve('/b/research') : resolve('/b/[board]', { board: crumb })} data-back><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"></path></svg>{choiceLabel(crumb)}</a>
    <span class="sub" aria-hidden="true">/</span>
    <span class="key">{data.ticket.key}</span>
    {#if around !== null}
      <span class="beside">
        <span class="sub">Previous and next card</span>
        {#if around.previous !== null}
          <a href={resolve('/t/[key]/[tab]', { key: encodeURIComponent(around.previous), tab: current })} data-card="previous" aria-label="Previous card, {around.previous}"><Kbd key="K" /></a>
        {:else}
          <Kbd key="K" aria-hidden="true" />
        {/if}
        {#if around.next !== null}
          <a href={resolve('/t/[key]/[tab]', { key: encodeURIComponent(around.next), tab: current })} data-card="next" aria-label="Next card, {around.next}"><Kbd key="J" /></a>
        {:else}
          <Kbd key="J" aria-hidden="true" />
        {/if}
      </span>
    {/if}
  </div>
  <div class="r">
    <h1>{data.ticket.title}</h1>
    {#if known}
      <StatePill state={pill.state} word={pill.word} detail={pill.detail} check={pill.check} />
    {:else}
      <span class="round" data-state="unknown">{shown.state}</span>
    {/if}
    <Chip>in {stageName}</Chip>
    {#if data.ticket.size}<Chip>{data.ticket.size}</Chip>{/if}
    <!-- Minimize parks the card and starts nothing, so it sits by the title on every tab and not in Next
         step. It reads Restore once pressed, so the label says what the next press does. M
         presses it. A closed card has no column to fold into. -->
    {#if forward !== null && forward.next !== null}
      {@const folded = forward.card.minimized}
      <Button variant="ghost" size="small" class="fold" key="M" aria-keyshortcuts="m" data-minimize={data.ticket.key} aria-pressed={folded ? 'true' : 'false'} title={folded ? 'Show the card in full on the board' : 'Fold the card to one line at the foot of its column'} onclick={minimize}
        >{folded ? 'Restore' : 'Minimize'}</Button
      >
    {/if}
  </div>
  <TabBar cardKey={data.ticket.key} tabs={data.tabs} {current} {counts} pending={data.changes && changes.current === null ? ['changes'] : []} />
</header>

{#if current === 'overview' || current === 'review'}
  <!-- Two columns: what to read on the left, what to decide on the right. They stack when the page is
       too narrow for both. The trail and the facts are the overview's, so the Review tab has the panel
       alone there. -->
  <div class="cols">
    <div class="read">{@render children()}</div>
    <aside class="side" aria-label={current === 'review' ? 'Next step' : 'Next step, trail and facts'}>
      {#if forward !== null}
        <DecisionPanel
          card={forward.card}
          stage={stageName}
          next={forward.next}
          retry={step?.retry ?? null}
          back={step?.back ?? null}
          {live}
          usage={{ limits, now: Date.now() }}
          runOn={data.runOn}
          {picker}
          fix={step?.fix ?? null}
          {fixIt}
          sendBack={step?.sendBack ?? null}
          {session}
          since={waitSince}
          phone={CLOUD_OPEN ? (data.display.plan === 'free' ? 'free' : 'paid') : null}
          {threadHref}
          {...writes}
          onpick={pickRow}
          why={reason}
          {findings}
          oncopy={copyFindings}
          ondelete={() => (deleting = data.ticket.key)}
        />
      {:else if note !== null}
        <p class="note" role="status">{note}</p>
      {/if}
      {#if extra.closed === true && extra.overview}
        <CardRecord strip={extra.overview.strip} spend={extra.overview.spend} moves={extra.overview.moves ?? []} {logBase} notes={pullNotes} now={clock} />
        <!-- A closed card has no Next step, so its delete stands under the record. -->
        <Button variant="danger" size="small" class="delete" data-delete-card onclick={() => (deleting = data.ticket.key)}>Delete card</Button>
      {:else if (extra.overview?.strip.length ?? 0) > 0}
        <PhaseStrip strip={extra.overview!.strip} spend={extra.overview!.spend} moves={extra.overview!.moves ?? []} {logBase} since={waitAt} now={clock} />
      {/if}
      <!-- The branch is one git call, so the facts land after the page drew. -->
      {#if extra.facts}
        <Streamed promise={extra.facts} scope={data.ticket.key} waiting="Reading the branch with git." height="150px" shape="rows" count={3}>
          {#snippet children(facts)}
            {#if facts.length > 0}
              <section class="facts" aria-label="Facts">
                {#each facts as fact (fact.label)}
                  <div class="fact">
                    <span>{fact.label}</span>
                    {#if fact.edit}
                      <BranchFact value={fact.value} locked={fact.edit.locked ?? (shown.state === 'running' || shown.state === 'queued' ? `A run is ${shown.state} on this branch. Rename it once the run ends.` : null)} onsave={renameBranch} />
                    {:else if fact.file}
                      <!-- The discoveries count opens the file on the Files tab. A bare "3" says nothing to a
                           screen reader, so its name says what the number counts and where it goes. -->
                      <a class="value" href="{resolve('/t/[key]/[tab]', { key: encodeURIComponent(data.ticket.key), tab: 'files' })}?{new URLSearchParams({ file: fact.file })}" aria-label="{fact.label} {fact.value}, open {fact.file}" data-fact-file={fact.file}>{fact.value}</a>
                    {:else if fact.ticket}
                      <!-- The ticket's own page opens in a new tab, so the card stays where it is. -->
                      <span class="value" data-fact-ticket={fact.ticket.key}
                        >{fact.value} ({#if fact.ticket.href}
                          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- a page in the ticket system, not a route of this app -->
                          <a href={fact.ticket.href} target="_blank" rel="noopener noreferrer" aria-label="{fact.ticket.key} in {fact.value}, opens in a new tab">{fact.ticket.key}</a>
                        {:else}{fact.ticket.key}{/if})</span
                      >
                    {:else}
                      <span class="value">{fact.value}</span>
                    {/if}
                  </div>
                {/each}
              </section>
            {/if}
          {/snippet}
        </Streamed>
      {/if}
    </aside>
  </div>
{:else}
  {#if forward === null && note !== null}<p class="note page-note" role="status">{note}</p>{/if}
  <div class="page">
    {@render children()}
  </div>
{/if}

{#if startStage !== null}
  <StartConfirm title={forward?.card.state === 'failed' ? `Retry ${data.ticket.key} in ${startStage.label}` : `Start ${startStage.label} again on ${data.ticket.key}`} stage={startStage} {limits} onconfirm={() => act('[data-run="retry"]', writes.onretry)} onclose={() => (starting = null)} />
{/if}
{#if deleting === data.ticket.key}
  <DeleteCard cardKey={data.ticket.key} onclose={() => (deleting = null)} ondeleted={() => void toBoard()} />
{/if}
{#if fixStart !== null}
  <StartConfirm title="Fix {data.ticket.key}: {fixStart.implement.label}, then {fixStart.qa.label}" stage={fixStart.implement} then={fixStart.qa} {limits} onconfirm={() => act('[data-run="fix"]', writes.onfix)} onclose={() => (fixing = null)} />
{/if}

<style>
  /* A link to a place on the page, such as the question, lands below the sticky head. The padding is
     in the style the server sends, because a cold load jumps to the link before the page hydrates and
     measures the head: the fallback is a little over the head's height with a one-line title. */
  @media (min-width: 641px) {
    :global(html:has(header.thead)) {
      scroll-padding-top: var(--thead-height, 160px);
    }
  }

  /* The page's own background, so the tab content scrolls under it unseen. Above the menus a tab
     opens, which scroll under it too. */
  .thead {
    position: sticky;
    top: 0;
    z-index: 5;
    background: var(--bg);
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 18px 32px 0;
    border-bottom: 1px solid var(--line);
  }

  .r {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .crumb {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    color: var(--ink);
    font-size: var(--text-xs);
    text-decoration: none;
  }

  .crumb svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
  }

  .sub {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .key {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--muted);
  }

  .beside {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }

  .beside a {
    text-decoration: none;
  }

  /* At the end of the title row, away from the pills. */
  .r :global(.fold) {
    margin-left: auto;
  }

  h1 {
    min-width: 0;
    margin: 0;
    color: var(--ink);
    font-size: 24px;
    font-weight: 600;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }

  /* A state this version does not know still reads as a state, in a round box with a muted dot. */
  .round {
    flex: none;
    padding: 3px var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: 12px;
    background: var(--card);
    font-size: var(--text-2xs);
    color: var(--ink-3);
  }

  .round[data-state='unknown']::before {
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 5px;
    border-radius: 50%;
    background: var(--muted);
    content: '';
  }

  .cols {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 32px;
    padding: var(--space-6) 32px;
  }

  .read {
    flex: 1 1 560px;
    min-width: 0;
  }

  /* 360px, the width of the decision panel. It does not grow, also when it wraps under the
     left column. */
  .side {
    display: flex;
    flex: 0 1 360px;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  .side > :global(.delete) {
    align-self: flex-start;
  }

  .facts {
    padding: 6px 14px;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .fact {
    display: flex;
    justify-content: space-between;
    gap: var(--space-3);
    padding: 7px 0;
    border-top: 1px solid var(--line);
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .fact:first-child {
    border-top: 0;
  }

  /* A branch, a path and a session are evidence, so they are mono. */
  .fact .value {
    min-width: 0;
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    overflow-wrap: anywhere;
    text-align: right;
  }

  a.value,
  .value a {
    color: inherit;
    text-decoration: underline;
  }

  .note {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink-3);
  }

  .page-note {
    padding: var(--space-2) 32px 0;
  }

  .page {
    padding: var(--space-4) 32px;
  }

  /* On a narrow screen the head wraps to a quarter of the window, so it scrolls with the page there. */
  @media (max-width: 640px) {
    .thead {
      position: static;
      padding-inline: var(--space-4);
    }

    .cols,
    .page,
    .page-note {
      padding-inline: var(--space-4);
    }
  }
</style>
