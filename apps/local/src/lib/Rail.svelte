<script lang="ts">
  import { resolve } from '$app/paths';
  import { type BoardChoice, type BoardKind, SCOUT_AND_EVIDENCE, type SlotMeter } from '@nolzu/protocol';
  import { Kbd } from '@nolzu/ui';
  import { tick } from 'svelte';
  import { APP_BUILD, isBeta, versionLine } from './app-version.ts';
  import GettingStarted from './GettingStarted.svelte';
  import type { FirstRun } from './getting-started.ts';
  import { slotsLine } from './now.ts';
  import { countLine } from './board-page.ts';
  import { circle, ICONS, projectLine, type ProjectChoice, railBoards, repoLine, type RailUsage } from './rail.ts';

  // The frame of every screen but the first run: the project selector and the bell, the search button,
  // Now with its count, the boards that are on, the project's screens and Settings. On a board it folds
  // to a strip of icons, so the columns get the room. It draws only what works today.
  let {
    compact = false,
    routeId,
    board = undefined,
    cardBoard = null,
    offBoards = [],
    project,
    projects = [],
    usage = null,
    waiting = null,
    slots = null,
    firstRun = null,
    scoutNew = false,
    counts = {},
    unread = null,
    changed = null,
    reviews = null,
    writing = false,
    onbell = null,
    onsearch = null,
    ontheme,
  }: {
    compact?: boolean;
    routeId: string | null;
    // The board in the address, on a board page.
    board?: string | undefined;
    // The board of the card on show, on a card page.
    cardBoard?: BoardKind | null;
    offBoards?: readonly BoardKind[];
    // `listed` is true when the project keeps a list of repositories, which is when Projects has the
    // Add a repository form. A project of one repository has to become a workspace first.
    project: { name: string; path: string | null; repos: readonly string[]; listed: boolean } | null;
    // Every project the selector lists, the busiest first, from the layout.
    projects?: readonly ProjectChoice[];
    usage?: RailUsage | null;
    // How many cards wait on the person across the boards that are on, the count of Now's first
    // section, and the agent slots. Both from the Now stream the layout keeps open, so they are live.
    // Null before its first event, which draws neither.
    waiting?: number | null;
    slots?: SlotMeter | null;
    // Getting started and the start-at-login offer of the first run, which the foot holds while it is
    // open. Null draws neither.
    firstRun?: FirstRun | null;
    // Whether a finding is new since the Scout page was last opened, from the Now stream. It draws the
    // blue dot on Scout.
    scoutNew?: boolean;
    // The cards on each board, off the Now stream (`railCounts`). A board with none listed shows no number.
    counts?: Partial<Record<BoardChoice, number>>;
    // The notifications nobody has read, off the Now stream. Null before its first event draws no badge.
    unread?: number | null;
    // The changed files of the workspace from the Workspace page's last read of git. Null before one,
    // and 0, draw no number.
    changed?: number | null;
    // How many knowledge changes wait for review, off the Now stream. Null before its first event.
    reviews?: number | null;
    // Whether a run holds the knowledge lane now, off the Now stream. It draws the amber dot on Knowledge.
    writing?: boolean;
    // Opens the notifications panel. With none there is no bell.
    onbell?: (() => void) | null;
    // Opens the command palette. With none there is no palette to open, and no button.
    onsearch?: (() => void) | null;
    ontheme: () => void;
  } = $props();

  const version = versionLine(APP_BUILD);
  const beta = isBeta(APP_BUILD.version);
  const boards = $derived(railBoards(routeId, board, cardBoard, offBoards));
  const initial = $derived(project === null ? '' : project.name.slice(0, 1).toUpperCase());
  // Every plan lists every project.
  const listed = $derived(projects);

  let open = $state(false);
  let selector = $state<HTMLElement | null>(null);
  let button = $state<HTMLButtonElement | null>(null);
  let menu = $state<HTMLElement | null>(null);

  const close = () => (open = false);

  // G then P. Focus goes to the first link or project, so the keys that follow work in the menu.
  export async function openMenu(): Promise<void> {
    if (project === null) return;
    open = true;
    await tick();
    menu?.querySelector<HTMLElement>('a, button')?.focus();
  }

  // On the selector, so Esc works from the button, a link or the panel, wherever the focus is in it.
  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !open) return;
    close();
    button?.focus();
  }

  // Safari and Firefox on a Mac do not focus a clicked button, so the click does it. Esc then works on
  // a menu opened by a click too.
  function toggle() {
    open = !open;
    button?.focus();
  }

  // Focus that moves past the selector closes the menu, so Tab past its last link does not leave it open
  // over the page. Focus that goes nowhere is a click where a Mac browser focuses nothing, and a press
  // outside already closes the menu.
  function onfocusout(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (open && next !== null && !(selector?.contains(next) ?? false)) close();
  }

  // Focus first, because Safari and Firefox on a Mac do not focus a clicked button, and the palette
  // gives focus back to what had it.
  function search(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
    event.currentTarget.focus();
    onsearch?.();
  }

  // Focus first, for the search button's reason: the panel gives focus back to what had it.
  function bell(event: MouseEvent & { currentTarget: HTMLButtonElement }) {
    event.currentTarget.focus();
    onbell?.();
  }

  function onpointerdown(event: PointerEvent) {
    if (open && !(selector?.contains(event.target as Node | null) ?? false)) close();
  }

  const boardHref = (kind: BoardChoice) => (kind === 'research' ? resolve('/b/research') : resolve('/b/[board]', { board: kind }));
  // The count is a badge only while something waits. Its word is for a screen reader and the folded
  // strip's name.
  const counted = $derived(waiting !== null && waiting > 0 ? waiting : null);
  const nowName = $derived(counted === null ? 'Now' : `Now, ${counted} waiting on you`);
  const unreadCount = $derived(unread !== null && unread > 0 ? unread : null);
  const bellName = $derived(unreadCount === null ? 'Notifications' : `Notifications, ${unreadCount} unread`);
  // "Resets 19:00 · 2 of 3 slots busy".
  const footLine = $derived(
    [usage !== null && usage.resets !== null ? `Resets ${usage.resets}` : null, slots !== null && slots.total > 0 ? slotsLine(slots) : null].filter((part) => part !== null).join(' · '),
  );
  const changedCount = $derived(changed !== null && changed > 0 ? changed : null);
  const reviewCount = $derived(reviews !== null && reviews > 0 ? reviews : null);
  const reviewWords = $derived(reviewCount === null ? '' : reviewCount === 1 ? '1 change waits for your review' : `${reviewCount} changes wait for your review`);
  const changedWords = $derived(changedCount === null ? '' : `${changedCount} changed ${changedCount === 1 ? 'file' : 'files'}`);
  // Scout and Evidence are in the rail only while they are on: a turned-off feature has no row.
  const screens = $derived<{ name: 'repos' | 'workspace' | 'knowledge' | 'scout' | 'evidence'; label: string; href: string; current: boolean }[]>([
    // With no project set there is no selector, and Settings, Project is where a project is set.
    ...(project === null
      ? [{ name: 'repos' as const, label: 'Projects', href: resolve('/settings/project'), current: routeId === '/settings/project' }]
      : [{ name: 'workspace' as const, label: 'Workspace', href: resolve('/workspace'), current: routeId === '/workspace' }]),
    { name: 'knowledge', label: 'Knowledge', href: resolve('/knowledge'), current: routeId === '/knowledge' },
    ...(SCOUT_AND_EVIDENCE
      ? [
          { name: 'scout' as const, label: 'Scout', href: resolve('/scout'), current: routeId?.startsWith('/scout') === true },
          { name: 'evidence' as const, label: 'Evidence', href: resolve('/evidence'), current: routeId === '/evidence' },
        ]
      : []),
  ]);
</script>

<svelte:window {onpointerdown} />

<!-- One project row. Another project is a button that makes it current and opens it; the open one says so. -->
{#snippet choice(one: ProjectChoice)}
  {#snippet inside()}
    <span class="pi" aria-hidden="true">{one.name.slice(0, 1).toUpperCase()}</span>
    <span class="tx"><b>{one.name}</b><span>{projectLine(one)}</span></span>
    <!-- Cream like the Now count, which is the same number for the open project. -->
    {#if one.waiting !== null && one.waiting > 0}<span class="n" data-needs-you>{one.waiting}</span> <span class="hidden">waiting on you</span>{/if}
  {/snippet}
  {#if one.current}
    <div class="pr current">{@render inside()}{@render icon(['m5 12 5 5 9-10'], 'ico sm check')}<span class="hidden">, the project open</span></div>
  {:else}
    <button type="submit" class="pr" name="project" value={one.id}>{@render inside()}</button>
  {/if}
{/snippet}

{#snippet icon(paths: readonly string[], size = 'ico')}
  <svg class={size} viewBox="0 0 24 24" aria-hidden="true">
    {#each paths as d, index (index)}<path {d}></path>{/each}
  </svg>
{/snippet}

<aside class="rail" class:compact>
  <div class="brand">
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle class="dot" cx="5" cy="10" r="3.4"></circle>
      <rect x="10.2" y="4" width="1.7" height="12" rx="0.85"></rect>
      <rect x="13.6" y="4" width="1.7" height="12" rx="0.85"></rect>
      <rect x="17" y="4" width="1.7" height="12" rx="0.85"></rect>
    </svg>
    <span class="word">Nolzu</span>
    <!-- The tip carries the build date, and a screen reader hears the full line instead of the short one. -->
    <span class="version" title={version.full}><span aria-hidden="true">{version.short}</span><span class="sr">{version.full}</span></span>
    {#if beta}<span class="beta" title="Nolzu is in beta until 1.0. Things can change between versions.">beta</span>{/if}
  </div>

  <!-- The header: the selector, and the bell beside it. -->
  <div class="top">
    {#if project !== null}
      <!-- The keys come from the button, a link or the panel inside it, so the div needs no role. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="selector" bind:this={selector} {onfocusout} {onkeydown}>
        <button type="button" class="proj" bind:this={button} aria-expanded={open} aria-controls="project-menu" aria-label="Project {project.name}, {repoLine(project.repos.length)}, project menu" onclick={toggle}>
          <span class="pi" aria-hidden="true">{initial}</span>
          <span class="pt" aria-hidden="true"><b>{project.name}</b><span>{repoLine(project.repos.length)}</span></span>
          {@render icon([open ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'], 'ico sm chevron')}
        </button>
        <!-- Not a menu with arrow keys: a panel of links in the tab order right after its button. A click
             on its text keeps it open, because the panel takes the focus. -->
        <div id="project-menu" class="menu" hidden={!open} tabindex="-1" bind:this={menu}>
          {#if listed.length > 0}
            <p class="gh keyed">Projects<span class="mono" aria-hidden="true">G P</span></p>
            <!-- A plain post, so the whole page loads again on the picked project and its Now stream. -->
            <form method="POST" action={resolve('/api/current-project')}>
              {#each listed as one (one.id)}{@render choice(one)}{/each}
            </form>
            <div class="sep"></div>
            <!-- The open project's repositories, one click away whatever the number of projects. -->
            <a class="it" href="{resolve('/settings/project')}#git-title" onclick={close}>
              {@render icon(ICONS.repos, 'ico sm')}Repositories of {project.name}{#if project.repos.length > 0}<span class="x mono">{project.repos.length}</span>{/if}
            </a>
            <a class="it" href="{resolve('/settings/project')}#{project.listed ? 'add-url' : 'git-title'}" onclick={close}>{@render icon(ICONS.add, 'ico sm')}Add a repository</a>
            <div class="sep"></div>
            <a class="it" href={resolve('/new')} onclick={close}>{@render icon(ICONS.add, 'ico sm')}New project</a>
            <a class="it" href={resolve('/settings/project')} onclick={close}>{@render icon(ICONS.settings, 'ico sm')}Settings of {project.name}</a>
          {:else}
            <p class="gh">Project</p>
            <div class="current">
              <span class="pi" aria-hidden="true">{initial}</span>
              <span class="tx"><b>{project.name}</b>{#if project.path !== null}<span class="mono">{project.path}</span>{/if}</span>
              {@render icon(['m5 12 5 5 9-10'], 'ico sm check')}<span class="hidden">, the project open</span>
            </div>
            <div class="sep"></div>
            <a class="it" href="{resolve('/settings/project')}#git-title" onclick={close}>
              {@render icon(ICONS.repos, 'ico sm')}Repositories{#if project.repos.length > 0}<span class="x mono">{project.repos.length}</span>{/if}
            </a>
            <a class="it" href="{resolve('/settings/project')}#{project.listed ? 'add-url' : 'git-title'}" onclick={close}>{@render icon(ICONS.add, 'ico sm')}Add a repository</a>
            <a class="it" href={resolve('/settings/project')} onclick={close}>{@render icon(ICONS.settings, 'ico sm')}Project settings</a>
            <a class="it" href={resolve('/new')} onclick={close}>{@render icon(ICONS.add, 'ico sm')}New project</a>
          {/if}
        </div>
      </div>
    {/if}
    <!-- What happened while the person was away, kept after its toast is gone. Not a place to work in like
         Now or a board, so it sits here and not in the list of places. The badge is cream like Now's,
         and the name says the count, so it is not colour alone. -->
    {#if onbell !== null}
      <button type="button" class="bell" aria-label={bellName} aria-haspopup="dialog" onclick={bell}>
        {@render icon(ICONS.bell)}<span class="tip" aria-hidden="true">Notifications, or press G then B</span>
        {#if unreadCount !== null}<span class="n" data-unread aria-hidden="true">{unreadCount}</span>{/if}
      </button>
    {/if}
  </div>

  {#if onsearch !== null}
    <button type="button" class="cmdk" aria-keyshortcuts="Meta+K Control+K" onclick={search}>
      {@render icon(ICONS.search, 'ico sm')}<span>Search or run a command</span>
      <Kbd key="⌘K" aria-hidden="true" />
    </button>
  {/if}

  <div class="scroll">
    <nav class="nav" aria-label="Main">
      <a href={resolve('/')} aria-current={routeId === '/' ? 'page' : undefined} aria-label={compact ? nowName : undefined}>
        {@render icon(ICONS.now)}<span class="label" aria-hidden={compact ? 'true' : undefined}>Now</span>
        <!-- Cream and not amber: a count starts no agent. The word after the
             badge sits outside it with a space between the nodes, because Svelte drops a space at the
             start of an element. -->
        {#if counted !== null}<span class="n" data-now-count aria-hidden={compact ? 'true' : undefined}>{counted}</span>
          <span class="hidden">waiting on you</span>{/if}
      </a>
    </nav>

    <p class="nav-h" aria-hidden="true">Boards</p>
    <nav class="nav" aria-label="Boards">
      {#each boards as one (one.kind)}
        {@const count = counts[one.kind]}
        <!-- On a card page the card is the page, so its board is marked as the place it sits and not as the page.
             The count is quiet: a total asks nothing of the person, so it is no cream badge like
             Now's. A screen reader hears the number with its noun, right after the name with no space. -->
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- boardHref resolve()s the address -->
        <a href={boardHref(one.kind)} aria-current={one.current ? (cardBoard === null ? 'page' : 'true') : undefined} aria-label={compact ? `${one.label} board${count === undefined ? '' : `, ${countLine(count, one.kind)}`}` : undefined}>
          {@render icon(ICONS[one.kind])}<span class="label" aria-hidden={compact ? 'true' : undefined}>{one.label}</span
          >{#if count !== undefined}<span class="count" aria-hidden="true">{count}</span><span class="hidden">, {countLine(count, one.kind)}</span>{/if}
        </a>
      {/each}
      <!-- Only while a board is off, because Settings, Project can then turn one on. -->
      {#if offBoards.length > 0}
        <a class="dim add" href="{resolve('/settings/project')}#boards" aria-label={compact ? 'Add a board' : undefined}>
          {@render icon(ICONS.add)}<span class="label" aria-hidden={compact ? 'true' : undefined}>Add a board</span>
        </a>
      {/if}
    </nav>

    <p class="nav-h" aria-hidden="true">Project</p>
    <nav class="nav" aria-label="Project">
      {#each screens as screen (screen.name)}
        {@const fresh = screen.name === 'scout' && scoutNew}
        {@const files = screen.name === 'workspace' ? changedCount : null}
        {@const waits = screen.name === 'knowledge' ? reviewCount : null}
        {@const busy = screen.name === 'knowledge' && writing}
        <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- the script resolve()s each address -->
        <a href={screen.href} aria-current={screen.current ? 'page' : undefined} aria-label={compact ? `${screen.label}${fresh ? ', new findings' : ''}${files !== null ? `, ${changedWords}` : ''}${waits !== null ? `, ${reviewWords}` : ''}${busy ? ', a run is writing knowledge' : ''}` : undefined}>
          {@render icon(ICONS[screen.name])}<span class="label" aria-hidden={compact ? 'true' : undefined}>{screen.label}</span>
          <!-- Quiet like a board's total: the count of the last read asks nothing of the person. -->
          {#if files !== null}<span class="count" data-workspace-count aria-hidden="true">{files}</span><span class="hidden">, {changedWords}</span>{/if}
          <!-- Cream like Now's count, because a change that waits for review waits on the person. -->
          {#if waits !== null}<span class="n" data-knowledge-count aria-hidden="true">{waits}</span><span class="hidden">, {reviewWords}</span>{/if}
          <!-- Blue, the colour of new: a finding nobody has looked at yet. The words are for a screen
               reader, with a space before them because Svelte drops one at the start of an element. -->
          {#if fresh}<span class="dot" data-scout-new aria-hidden="true"></span> <span class="hidden">new findings</span>{/if}
          <!-- A turning ring while a run writes the knowledge folder now. -->
          {#if busy}<span class="dot run" data-knowledge-writing aria-hidden="true"></span> <span class="hidden">a run is writing knowledge</span>{/if}
        </a>
      {/each}
    </nav>
  </div>

  <div class="foot">
    <!-- The folded strip has no room for them, and the layout keeps the rail open on a board while the
         list shows. -->
    {#if firstRun !== null && !compact}<GettingStarted {firstRun} />{/if}
    <!-- The list takes the place of the usage, as the first drag draws the foot. -->
    {#if (usage !== null || slots !== null) && (firstRun?.steps ?? null) === null}
      <!-- The last reading the engine gave, with the time it was seen, because it is not a live number.
           The slots are live, from the Now stream. -->
      <div class="eng">
        {#if usage !== null}
          <p class="r"><span>{usage.label}</span><span class="v">5h window {usage.share}%</span></p>
          <div class="bar" aria-hidden="true"><i style:width="{Math.min(usage.share, 100)}%"></i></div>
        {/if}
        {#if footLine !== ''}<p class="m" data-slots>{footLine}</p>{/if}
        {#if usage !== null}<p class="m">Seen {usage.seen}</p>{/if}
      </div>
    {/if}
    <div class="row">
      <nav class="nav" aria-label="Settings">
        <!-- Settings opens on its first section. The link names it and does not go through /settings,
             which can only move on in the browser (it has to read the hash), so there is no blank
             step first. It stays marked on every settings page. -->
        <a href={resolve('/settings/project')} aria-current={routeId?.startsWith('/settings') ? 'page' : undefined} aria-label={compact ? 'Settings' : undefined}>
          {@render icon(ICONS.settings)}<span class="label" aria-hidden={compact ? 'true' : undefined}>Settings</span>
        </a>
      </nav>
      <!-- The theme has no other place. It sits beside Settings, and T works on every page. -->
      <button type="button" class="theme" aria-label="Switch the theme" onclick={ontheme}>
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d={circle(12, 12, 8.5)}></path><path class="half" d="M12 3.5a8.5 8.5 0 0 1 0 17Z"></path></svg>
        <span class="tip" aria-hidden="true">Switch the theme, or press T</span>
      </button>
    </div>
    <!-- Help: the guides, and where a bug goes. Both leave the app, so they open in a new tab. -->
    <nav class="help" aria-label="Help">
      <a href="https://nolzu.com/docs" target="_blank" rel="noreferrer">Docs</a>
      <a href="https://github.com/nolzu/nolzu/issues/new/choose" target="_blank" rel="noreferrer">Report a bug</a>
    </nav>
  </div>
</aside>

<style>
  .rail {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    flex: none;
    flex-direction: column;
    gap: 1px;
    box-sizing: border-box;
    width: 232px;
    height: 100vh;
    padding: var(--space-3) 10px;
    border-right: 1px solid var(--line);
    background: var(--rail);
  }

  /* The word is 14.5px, which the scale has not got. */
  .brand {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: var(--space-1) var(--space-2) var(--space-3);
    font-size: var(--text-base);
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--ink);
  }

  .brand svg {
    flex: none;
    width: 20px;
    height: 20px;
    fill: currentColor;
  }

  /* Cream and not amber: amber means an agent starts or resumes work, and a logo starts none. */
  .brand .dot {
    fill: var(--accent);
  }

  /* Quiet, and it gives way first when the row is short. */
  /* Quiet, like the version beside it: a muted pill, never a color of its own. */
  .beta {
    flex: none;
    padding: 0 6px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: var(--text-2xs);
    font-weight: 500;
    color: var(--muted);
  }

  .version {
    min-width: 0;
    overflow: hidden;
    font-size: var(--text-2xs);
    font-weight: 400;
    letter-spacing: 0;
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* The menu is placed off the header and not off the selector, so it opens past the bell and not over it. */
  .top {
    position: relative;
    display: flex;
    gap: 6px;
    margin-bottom: var(--space-2);
  }

  .selector {
    flex: 1;
    min-width: 0;
  }

  /* Boxed like the selector beside it, so the two read as one header. */
  .bell {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 40px;
    min-height: 36px;
    margin-left: auto;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--panel);
    color: var(--ink-2);
    font: inherit;
    cursor: pointer;
  }

  .bell:hover {
    color: var(--ink);
  }

  /* On the icon's corner, as the folded strip draws a badge. */
  .bell .n {
    position: absolute;
    top: -6px;
    right: -6px;
    margin: 0;
    padding: 0 5px;
  }

  /* The radius is 9px, which the scale has not got. */
  .proj {
    display: flex;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    width: 100%;
    padding: var(--space-2) 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--panel);
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  /* Open is said by aria-expanded and by the edge. No amber ring: no amber on a control. */
  .proj[aria-expanded='true'] {
    border-color: var(--line-2);
    background: var(--card);
  }

  .pi {
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: var(--radius-sm);
    background: var(--card-2);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--ink);
  }

  .pt {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .pt b {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  /* The sub line is 11.5px, which the scale has not got. */
  .pt span {
    overflow: hidden;
    font-size: var(--text-2xs);
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A little below the selector's top edge, over the rail's border. */
  .menu {
    position: absolute;
    top: 7px;
    left: 100%;
    z-index: 1;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: 340px;
    padding-bottom: var(--space-1);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-2xl);
    background: var(--card);
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .menu[hidden] {
    display: none;
  }

  .menu:focus {
    outline: none;
  }

  .gh {
    margin: 0;
    padding: 10px 14px var(--space-1);
    font-size: var(--text-2xs);
    font-weight: 500;
    color: var(--muted);
  }

  .gh.keyed {
    display: flex;
  }

  .gh.keyed .mono {
    margin-left: auto;
    font-weight: 400;
  }

  .current,
  .pr {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 var(--space-1);
    padding: var(--space-2) 10px;
    border-radius: var(--radius-md);
  }

  .current {
    background: var(--panel);
  }

  .current .pi,
  .pr .pi {
    width: 28px;
    height: 28px;
    border-radius: var(--radius-md);
  }

  button.pr {
    box-sizing: border-box;
    width: calc(100% - 2 * var(--space-1));
    border: 0;
    background: none;
    color: var(--ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  button.pr:hover {
    background: var(--panel);
  }

  .menu form {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
  }

  .tx {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
  }

  .tx b {
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .tx span {
    overflow: hidden;
    font-size: var(--mono-card-key);
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-family: var(--font-mono);
    letter-spacing: -0.01em;
  }

  .sep {
    height: 1px;
    margin: 6px 0;
    background: var(--line);
  }

  .it {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    height: 34px;
    margin: 0 var(--space-1);
    padding: 0 10px;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--ink-2);
    text-decoration: none;
  }

  a.it:hover {
    background: var(--panel);
    color: var(--ink);
  }

  .x {
    flex-shrink: 1;
    min-width: 0;
    margin-left: auto;
    overflow: hidden;
    font-size: var(--mono-card-key);
    color: var(--muted);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The text is 12.5px, which the scale has not got. */
  .cmdk {
    display: flex;
    flex: none;
    align-items: center;
    gap: var(--space-2);
    box-sizing: border-box;
    width: 100%;
    height: 32px;
    margin-bottom: var(--space-2);
    padding: 0 10px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: var(--text-xs);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
  }

  .cmdk:hover {
    color: var(--ink-2);
  }

  .cmdk :global(kbd) {
    margin-left: auto;
  }

  /* The scroll keeps a few pixels round the links, so a focus ring is not cut at its edge. */
  .scroll {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 1px;
    min-height: 0;
    margin: 0 calc(-1 * var(--space-1));
    padding: 0 var(--space-1);
    overflow-y: auto;
  }

  .nav-h {
    margin: 0;
    padding: 14px 10px var(--space-1);
    font-size: var(--text-2xs);
    font-weight: 500;
    color: var(--muted);
  }

  .nav-h:first-child {
    padding-top: var(--space-1);
  }

  .nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  /* The radius is 7px, which the scale has not got. */
  .nav a {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 30px;
    padding: 0 10px;
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    color: var(--ink-2);
    text-decoration: none;
  }

  .nav a:hover {
    color: var(--ink);
  }

  /* The open page, or the board of the card on show, is said by aria-current, the box and the ink, so it
     is not colour alone. */
  .nav a[aria-current] {
    background: var(--card);
    box-shadow: inset 0 0 0 1px var(--line);
    color: var(--ink);
  }

  .nav a.dim {
    color: var(--muted);
  }

  /* A count badge is cream, the accent with its own ink, as the board's Waiting on
     me count is. */
  .n {
    margin-left: auto;
    padding: 1px 6px;
    border-radius: 99px;
    background: var(--accent);
    color: var(--accent-ink);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    font-weight: 600;
  }

  /* A board's total, plain and muted, so it does not read as something waiting. */
  .count {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  /* The new-findings dot on Scout, where a count would sit. */
  .nav a .dot {
    flex: none;
    width: 7px;
    height: 7px;
    margin-left: auto;
    border-radius: 50%;
    background: var(--blue);
  }

  /* A run writing knowledge: a turning ring in the link's own colour, because the rail draws no amber
     and the words beside it say what it means. Still when the system asks for less motion. */
  .nav a .dot.run {
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    background: none;
    animation: turn 1s linear infinite;
  }

  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .nav a .dot.run {
      animation: none;
    }
  }

  .ico {
    flex: none;
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ico.sm {
    width: 13px;
    height: 13px;
  }

  .chevron {
    color: var(--muted);
  }

  .check {
    color: var(--green);
  }

  .foot {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: auto;
    padding: var(--space-3) 6px var(--space-1);
    border-top: 1px solid var(--line);
  }

  .eng {
    display: flex;
    flex-direction: column;
    gap: 5px;
    font-size: var(--text-xs);
    color: var(--ink);
  }

  .eng p {
    margin: 0;
  }

  .r {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .v {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  /* Faint and ink-2, not a line and amber: a fainter track would be 1.4:1, and amber means a run. */
  .bar {
    height: 4px;
    border-radius: 99px;
    background: var(--faint);
    overflow: hidden;
  }

  .bar i {
    display: block;
    height: 100%;
    border-radius: 99px;
    background: var(--ink-2);
  }

  .m {
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin: 0 -6px;
  }

  .row .nav {
    flex: 1;
  }

  .theme {
    position: relative;
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 30px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    cursor: pointer;
  }

  .theme:hover {
    color: var(--ink);
  }

  .help {
    display: flex;
    gap: var(--space-3);
    padding: 0 4px;
    font-size: var(--text-xs);
  }

  .help a {
    color: var(--muted);
  }

  .help a:hover {
    color: var(--ink);
  }

  .half {
    fill: currentColor;
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* The tip beside an icon, on hover and on keyboard focus. Its text is the name the control already
     has, so it is hidden from screen readers. */
  .tip {
    position: absolute;
    top: 50%;
    left: calc(100% + 8px);
    z-index: 1;
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--card-2);
    box-shadow: var(--shadow);
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--ink);
    white-space: nowrap;
    visibility: hidden;
    transform: translateY(-50%);
    pointer-events: none;
  }

  .theme:hover .tip,
  .theme:focus-visible .tip,
  .bell:hover .tip,
  .bell:focus-visible .tip {
    visibility: visible;
  }

  /* Folded on a board: icons, with their words as tips. */
  @media (min-width: 761px) {
    .compact {
      align-items: center;
      gap: var(--space-1);
      width: 56px;
      padding: 14px 0;
    }

    .compact .brand {
      padding: 0 0 var(--space-1);
    }

    .compact .brand svg {
      width: 22px;
      height: 22px;
    }

    .compact .word,
    .compact .version,
    .compact .beta {
      display: none;
    }

    /* The header stacks: the project's initial, then the bell under it. */
    .compact .top {
      flex-direction: column;
      align-items: center;
      gap: var(--space-1);
      margin: 6px 0;
    }

    .compact .selector {
      flex: none;
    }

    .compact .bell {
      width: 36px;
      height: 34px;
      min-height: 0;
      margin: 0;
      border: 0;
      background: transparent;
    }

    .compact .bell .n {
      top: 1px;
      right: 0;
      padding: 0 4px;
      font-size: var(--mono-3xs);
    }

    /* The folded strip draws no search. Cmd K opens the palette there. */
    .compact .cmdk {
      display: none;
    }

    .compact .proj {
      width: auto;
      padding: 0;
      border: 0;
      background: transparent;
    }

    .compact .proj .pi {
      width: 30px;
      height: 30px;
      border-radius: var(--radius-md);
    }

    .compact .chevron {
      display: none;
    }

    .compact .menu {
      left: calc(100% + 8px);
    }

    /* The tips reach past the strip, so it does not scroll. */
    .compact .scroll {
      align-items: center;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      overflow: visible;
    }

    .compact .nav {
      gap: var(--space-1);
    }

    /* The section titles become separators. */
    .compact .nav-h {
      width: 24px;
      height: 1px;
      margin: 6px 0;
      padding: 0;
      overflow: hidden;
      background: var(--line);
      color: transparent;
    }

    .compact .nav a {
      justify-content: center;
      width: 36px;
      height: 34px;
      padding: 0;
    }

    /* On the icon's corner, as the badge sits. */
    .compact .nav a .dot {
      position: absolute;
      top: 5px;
      right: 6px;
    }

    /* The strip has no room for a board's total. The link's name keeps it. */
    .compact .count {
      display: none;
    }

    /* The badge on the icon's corner. Not the selector's counts, which keep their row. */
    .compact .nav .n {
      position: absolute;
      top: 1px;
      right: 0;
      padding: 0 4px;
      font-size: var(--mono-3xs);
    }

    .compact .foot {
      align-items: center;
      padding: 0;
      border-top: 0;
    }

    /* The strip has no room for the usage or the help line, so it shows neither. */
    .compact .eng,
    .compact .help {
      display: none;
    }

    .compact .row {
      flex-direction: column;
      margin: 0;
    }

    .compact .theme {
      width: 36px;
      height: 34px;
    }

    .compact .label,
    .compact .pt {
      position: absolute;
      top: 50%;
      left: calc(100% + 8px);
      z-index: 1;
      flex: none;
      padding: var(--space-1) var(--space-2);
      border: 1px solid var(--line-2);
      border-radius: var(--radius-sm);
      background: var(--card-2);
      box-shadow: var(--shadow);
      font-size: var(--text-xs);
      color: var(--ink);
      white-space: nowrap;
      visibility: hidden;
      transform: translateY(-50%);
      pointer-events: none;
    }

    .compact .pt b {
      font-size: var(--text-xs);
    }

    .compact .nav a:hover .label,
    .compact .nav a:focus-visible .label,
    .compact .proj:hover .pt,
    .compact .proj:focus-visible .pt {
      visibility: visible;
    }

    /* A tip has no room over the open menu. */
    .compact .proj[aria-expanded='true'] .pt {
      visibility: hidden;
    }
  }

  /* Below 760px the rail is a band at the top: the selector, then the links in rows that wrap. The
     usage hides, and Settings and the theme stay, because nothing else links them. */
  @media (max-width: 760px) {
    .rail {
      position: relative;
      width: auto;
      height: auto;
      padding: 10px var(--space-4);
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }

    .brand {
      padding: 0 0 var(--space-2);
    }

    .menu {
      top: calc(100% + 6px);
      left: 0;
      width: min(340px, calc(100vw - 32px));
    }

    .scroll {
      flex-flow: row wrap;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      overflow: visible;
    }

    .nav-h,
    .eng,
    .tip {
      display: none;
    }

    .nav {
      flex-flow: row wrap;
      gap: var(--space-1);
    }

    .foot {
      flex-direction: row;
      margin-top: var(--space-1);
      padding: 0;
      border-top: 0;
    }

    .row {
      margin: 0;
    }
  }
</style>
