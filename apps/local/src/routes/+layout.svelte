<script lang="ts">
  import '@nolzu/ui/tokens.css';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { BoardKind } from '@nolzu/protocol';
  import { type KeyActions, Keyboard, pushToast, scoped, StatePill } from '@nolzu/ui';
  import { toggleTheme } from '$lib/board-keys.ts';
  import { isNow, waitingCount } from '$lib/now.ts';
  import { nowLive } from '$lib/now-live.svelte.ts';
  import { type Heard, nowToasts } from '$lib/now-toasts.ts';
  import { browserStream, connectBoard } from '$lib/snapshot-client.ts';
  import { pageKeys } from '$lib/page-keys.svelte.ts';
  import Palette from '$lib/Palette.svelte';
  import ProjectFilesNotice from '$lib/ProjectFilesNotice.svelte';
  import Rail from '$lib/Rail.svelte';
  import { railCounts, selectorRows } from '$lib/rail.ts';
  import NotificationsPanel from '$lib/NotificationsPanel.svelte';
  import QaAskDialog from '$lib/QaAskDialog.svelte';
  import { qaAsk } from '$lib/qa-ask.svelte.ts';
  import SetupGateDialog from '$lib/SetupGateDialog.svelte';
  import SetupSteps from '$lib/SetupSteps.svelte';
  import { setupGate } from '$lib/setup-gate.svelte.ts';
  import ToastCorner from '$lib/ToastCorner.svelte';
  import { toastStack } from '$lib/toast-stack.svelte.ts';
  import FeaturePanels from '$lib/FeaturePanels.svelte';
  import { loadFeature, registerFeature } from '$lib/features.svelte.ts';
  import { type Snippet, tick, untrack } from 'svelte';
  import type { LayoutServerData } from './$types';

  let { data, children }: { data: LayoutServerData; children: Snippet } = $props();

  // The download happens in Node and the package runs here, in the browser, which is the only
  // place a feature component can draw. The two functions it needs go on a global before the
  // import, because the built app's own chunks have hashed names nothing can import by hand.
  //
  // Limit: the package brings its own Svelte and mounts its own components, so context and
  // stores do not cross and its updates flush on its own schedule. Put the app's Svelte on the
  // same global when a feature needs shared context.
  $effect(() => {
    // The terms page loads whole and leaves whole, and the server refuses the package until they are
    // accepted.
    if (untrack(() => page.route.id) === '/accept') return;
    (globalThis as { nolzu?: { registerFeature: typeof registerFeature; loadFeature: typeof loadFeature } }).nolzu = { registerFeature, loadFeature };
    // A variable and not a literal: a literal specifier is resolved while the app is built, and
    // this module exists only on the running server.
    const url = '/api/package/entry';
    import(url).catch((error: unknown) => console.error(`The installed feature package did not load: ${error instanceof Error ? error.message : String(error)}`));
  });

  // The first run has no rail.
  // The terms page has none either: nothing else answers until they are accepted.
  const railShown = $derived(!(page.route.id?.startsWith('/new') ?? false) && page.route.id !== '/accept');
  // Getting started and the start-at-login offer: live off the Now stream once it answers, and from the
  // load for the first paint.
  const firstRun = $derived(nowLive.state.snapshot?.firstRun ?? data.firstRun ?? null);
  // The rail stays open on every page, boards too: the names are worth more than the room.
  // A card page marks the board its card is on. Read only there, because other pages keep other shapes
  // in their own data.
  const cardBoard = $derived(page.route.id?.startsWith('/t/[key]') ? ((page.data as { ticket?: { board?: BoardKind } }).ticket?.board ?? null) : null);
  // The layout's own project, and not `page.data.project`, which Settings, Project replaces with a
  // shape of its own.
  const project = $derived(data.project === null ? null : { name: data.project, path: data.projectPath, repos: data.repos, listed: data.listed });
  let rail = $state<ReturnType<typeof Rail>>();
  let palette = $state<ReturnType<typeof Palette>>();
  // The offline banner's height, which a board takes off the window it fills, so its key row stays in
  // view. Zero with no banner.
  let offlineHeight = $state(0);

  // The one Now stream, opened once for every page with the rail and kept across navigation, so the
  // rail's count and slots are live. The Now page, a board and a card page read the same state and
  // open no stream of their own, so a tab holds one connection.
  //
  // What the tab has heard on it, so each run, Scout and near-limit toast is raised once. Not state:
  // the toasts are what changes. A new stream starts from nothing, because its first snapshot replays
  // the state the page loaded into.
  let heard: Heard | null = null;
  $effect(() => {
    if (!railShown) return;
    heard = null;
    const client = connectBoard(browserStream(resolve('/api/now')), (state) => (nowLive.state = state), isNow);
    return () => client.close();
  });
  // Another tab picked another project: this page shows the old one, and every write from it would
  // name the old one, so it opens Now on the new current project. Now and not a reload: a card page's
  // key can be another card in the new project, and the tab that picked hears this too while its own
  // pick still loads, where a reload would cancel the pick's way to Now.
  $effect(() => {
    if (nowLive.state.snapshot?.switched === true) location.assign(resolve('/'));
  });
  const toastHrefs = { card: (key: string) => resolve('/t/[key]', { key: encodeURIComponent(key) }), scout: resolve('/scout'), engines: resolve('/settings/[section]', { section: 'engines' }) };
  $effect(() => {
    const raised = nowToasts(heard, nowLive.state, Date.now(), toastHrefs);
    heard = raised.heard;
    if (raised.toasts.length > 0) untrack(() => (toastStack.state = { ...toastStack.state, toasts: raised.toasts.reduce(pushToast, toastStack.state.toasts) }));
  });
  const waiting = $derived(waitingCount(nowLive.state.snapshot));
  const slots = $derived(nowLive.state.snapshot?.boards[0]?.slots ?? null);
  // The selector's projects, the busiest first, with the current one counted off the same stream.
  const projects = $derived(selectorRows(data.projects, nowLive.state.snapshot?.boards ?? null));
  // The blue dot on Scout: a finding first seen since the Scout page was last opened.
  const scoutNew = $derived((nowLive.state.snapshot?.scout.fresh ?? 0) > 0);
  const reviews = $derived(nowLive.state.snapshot?.knowledgePending ?? null);
  const writing = $derived(nowLive.state.snapshot?.boards.some((one) => one.lanes.some((lane) => lane.name === 'knowledge' && lane.heldBy !== null)) ?? false);
  // The count after each board in the rail, off the same stream, so Now, Research, a board and a card
  // page show one number.
  const counts = $derived(railCounts(nowLive.state.snapshot?.boards ?? null));
  // The bell: its count and its newest few ride on the stream, and the panel reads the whole list.
  const notices = $derived(nowLive.state.snapshot?.notifications ?? null);
  let noticesOpen = $state(false);

  // The palette's "Check every Scout source now" presses the Scout page's own Check all sources, so the
  // check and its answer are that button's. With no source there is no button, and the page offers to
  // add one.
  async function checkScout(): Promise<void> {
    await goto(resolve('/scout'));
    await tick();
    document.querySelector<HTMLFormElement>('form[data-check-all]')?.requestSubmit();
  }

  // The keys that work on every page. A board that is off gets no key to go to it, because its page
  // only says that it is off. Delivery is never off.
  const globalKeys = scoped('global');
  const actions = $derived<KeyActions>({
    theme: toggleTheme,
    settings: () => void goto(resolve('/settings/project')),
    'go:now': () => void goto(resolve('/')),
    'go:delivery': () => void goto(resolve('/b/[board]', { board: 'delivery' })),
    ...(data.offBoards.includes('epics') ? {} : { 'go:epics': () => void goto(resolve('/b/[board]', { board: 'epics' })) }),
    // The two Research kinds are on or off together, so one of them answers for the list.
    ...(data.offBoards.includes('questions') ? {} : { 'go:research': () => void goto(resolve('/b/research')) }),
    ...(data.offBoards.includes('prreview') ? {} : { 'go:prreview': () => void goto(resolve('/b/[board]', { board: 'prreview' })) }),
    // Workspace is the rail's link only while a project is set.
    ...(project === null ? {} : { 'go:workspace': () => void goto(resolve('/workspace')) }),
    'go:knowledge': () => void goto(resolve('/knowledge')),
    'go:scout': () => void goto(resolve('/scout')),
    'go:evidence': () => void goto(resolve('/evidence')),
    'scout:check': () => void checkScout(),
    // G then B opens the bell's panel, wherever the rail draws the bell.
    ...(railShown ? { 'go:notifications': () => (noticesOpen = true) } : {}),
    // G then P opens the selector. No key with no selector to open.
    ...(railShown && project !== null ? { 'go:project': () => void rail?.openMenu() } : {}),
    // Cmd K opens the palette over any screen with the rail, as the rail's search button does.
    ...(railShown ? { palette: () => void palette?.show() } : {}),
  });
</script>

<!-- The one key handler, for the global keys and the keys of the screen on show. -->
<Keyboard keys={[...globalKeys, ...(pageKeys.now?.keys ?? [])]} actions={{ ...actions, ...pageKeys.now?.actions }} />
<!-- The palette gets what the key handler gets, so each key's row runs that key's own action. -->
{#if railShown}
  <Palette bind:this={palette} keys={[...globalKeys, ...(pageKeys.now?.keys ?? [])]} actions={{ ...actions, ...pageKeys.now?.actions }} offBoards={data.offBoards} />
{/if}
<div class="shell">
  {#if railShown}
    <Rail
      bind:this={rail}
      routeId={page.route.id}
      board={page.params.board}
      {cardBoard}
      offBoards={data.offBoards}
      {project}
      {projects}
      usage={data.usage}
      {waiting}
      {slots}
      {firstRun}
      {scoutNew}
      {counts}
      unread={notices?.unread ?? null}
      changed={data.workspaceChanged}
      {reviews}
      {writing}
      onbell={() => (noticesOpen = true)}
      onsearch={() => palette?.show()}
      ontheme={toggleTheme}
    />
  {/if}
  <main style:--offline-height="{offlineHeight}px">
    <!-- Always on the page, so a screen reader is listening before the banner comes, and the layout stays
         across pages, so it is read out once. It never shows on Free, and it is a neutral box with no
         amber, because nothing starts. The project files notice shares the region, so
         a board takes its height off too. -->
    <div class="offline" bind:offsetHeight={offlineHeight}>
      <div class="live" role="status">
      {#if data.offline}
        <div class="banner" data-offline>
          <StatePill state="idle" word="Offline" />
          <span><b>{data.offline.headline}</b> {data.offline.sentence}</span>
          <span class="spacer"></span>
          <!-- The space goes between the two nodes, because Svelte drops one at the start of a block. -->
          <span class="sub">{data.offline.fix} {#if data.offline.settings}<a href={resolve('/settings/[section]', { section: 'cloud' })}>Open Settings, Cloud</a>{/if}</span>
        </div>
      {/if}
      <!-- Settings, Project says the same under its own button. -->
      {#if railShown && page.route.id !== '/settings/project'}
        <ProjectFilesNotice status={data.projectFiles ?? null} project={data.project} />
      {/if}
      </div>
      <!-- Set up the project, on the boards and on Now, until each step is done or put away. Outside the
           status region, because a screen reader would read the whole list again on every change. -->
      {#if railShown && (page.route.id === '/' || (page.route.id?.startsWith('/b/') ?? false)) && nowLive.state.snapshot?.setup}
        <SetupSteps steps={nowLive.state.snapshot.setup.steps} variant="banner" />
      {/if}
    </div>
    {@render children()}
    <FeaturePanels name="app" />
  </main>
</div>
<!-- The one toast host of every screen. Each screen and the palette raise into its stack, and the layout
     stays across pages, so a toast stays too. It comes after the page, as each screen's own host did, so
     Tab from the card that was refused reaches the toast before the rail. -->
<ToastCorner />
{#if noticesOpen}
  <NotificationsPanel newest={notices?.newest ?? []} unread={notices?.unread ?? 0} onclose={() => (noticesOpen = false)} />
{/if}
<!-- The Learn dialog, which any screen opens in place of the first run while Learn your repositories is open. -->
{#if setupGate.state !== null}
  {#key setupGate.state}<SetupGateDialog gate={setupGate.state} onclose={() => (setupGate.state = null)} />{/key}
{/if}
<!-- The question at the first QA, which any screen opens in place of a move into QA. -->
{#if qaAsk.state !== null}
  {#key qaAsk.state}<QaAskDialog ask={qaAsk.state} onclose={() => (qaAsk.state = null)} />{/key}
{/if}

<style>
  /* The rail on the left and the page in the rest of the width. min-width lets a board scroll its own
     columns sideways instead of the page. */
  .shell {
    display: flex;
    min-height: 100vh;
  }

  main {
    flex: 1 1 0;
    min-width: 0;
  }

  /* Its own block, so the banner's margin counts in the height a board takes off. */
  .offline {
    display: flow-root;
  }

  /* The offline banner: the card surface with a hairline, the state pill, the words, and the fix at
     the right edge. It wraps on a narrow window. */
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: var(--space-3) var(--space-6) 0;
    padding: 10px 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-lg);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  .banner b {
    font-weight: 500;
  }

  .spacer {
    flex: 1;
  }

  .sub {
    color: var(--muted);
  }

  .sub a {
    color: var(--ink);
  }

  /* Below 760px the rail is a band above the page. */
  @media (max-width: 760px) {
    .shell {
      flex-direction: column;
    }
  }
</style>
