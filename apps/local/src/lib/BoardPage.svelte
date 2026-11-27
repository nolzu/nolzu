<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { boardFor } from '@nolzu/core';
  import { BOARD_LABELS, type BoardKind, type BoardSnapshot, type CardView, type ProfileLimit, type RunActivity } from '@nolzu/protocol';
  import {
    AddCardDialog,
    addWords,
    age,
    answerHref,
    Board,
    Button,
    CoachNote,
    enterColumn,
    focusMove,
    hintsOf,
    type KeyActions,
    KeyCaps,
    leaveColumn,
    liveKeys,
    matchesFilter,
    type Drag,
    refusalFromServer,
    scoped,
    Skeleton,
    StartConfirm,
    startDrag,
    shutColumns,
    visibleColumns,
    waitingOnMe,
    WaitingToggle,
  } from '@nolzu/ui';
  import { type ComponentProps, tick } from 'svelte';
  import { toggleFilter } from './board-keys.ts';
  import {
    type AddPayload,
    type Added,
    addedOf,
    addedToast,
    addOrHold,
    allowedFor,
    answered,
    boardCount,
    boardKind,
    confirmFix,
    confirmStage,
    contextCards,
    filterOn,
    fixLink,
    keyCopied,
    keyWrite,
    landed,
    type Made,
    myTicketsOf,
    nextKey,
    postCard,
    postJira,
    pressed,
    pullsAddress,
    readPullsSaid,
    refusedDrop,
    sendMove,
    stageBack,
    type Starting,
  } from './board-page.ts';
  import { copyText } from './clipboard.ts';
  import { follow } from './follow.svelte.ts';
  import { COACH_NOTE, coachAt, PHASE_SAYS } from './getting-started.ts';
  import { nowLive } from './now-live.svelte.ts';
  import { slotPips, slotsLine } from './now.ts';
  import { pageKeys } from './page-keys.svelte.ts';
  import PeekPanel from './PeekPanel.svelte';
  import BoardList from './BoardList.svelte';
  import { askBeforeRetry, askFirst } from './qa-ask.svelte.ts';
  import { setupGate } from './setup-gate.svelte.ts';
  import { postWrite } from './ticket.ts';
  import { toastStack } from './toast-stack.svelte.ts';
  import { rememberBoard } from './last-board.ts';
  import ResearchAdd from './ResearchAdd.svelte';
  import { boardOfCard, researchBoard, researchTags } from './research-board.ts';

  // Research is one board over the question and investigation kinds, at its own address, so the route
  // says so. Every other board comes from the address.
  let { research = false }: { research?: boolean } = $props();

  let drag = $state<Drag | null>(null);
  let adding = $state(false);
  // What Add card held when it last closed without a card, so the next open shows it again.
  let cardDraft = $state<ComponentProps<typeof AddCardDialog>['draft']>(null);
  const filtered = $derived(filterOn(page.url));
  // The board this page shows, from the address. Research draws the question board's columns.
  const kind = $derived(research ? 'questions' : (boardKind(page.params.board ?? 'delivery') ?? 'delivery'));
  const title = $derived(research ? 'Research' : BOARD_LABELS[kind]);

  // The page's only source of truth: this board out of the Now stream the root layout keeps open, which
  // carries every board that is on. An off board draws BoardOff and not this page. A stream of the
  // page's own would be a second connection in every tab, and a browser holds six to one host over
  // HTTP/1.1, counted over all its tabs. A card moves here when the stream says it moved, never when
  // the request answers, so a slow server shows the card where it is. Picked by kind, so the heading
  // and the columns never come from two boards at once.
  const boards = $derived(nowLive.state.snapshot?.boards ?? []);
  const snapshot = $derived<BoardSnapshot | null>(research ? researchBoard(boards) : (boards.find((one) => one.kind === kind) ?? null));
  // The snapshot of the board a card is on, which its writes, its confirms and its peek read, so they
  // name its own phase and model row. On every board but Research that is the page's own.
  const own = (key: string): BoardSnapshot | null => (research ? boardOfCard(boards, key) : snapshot);
  // "Question" or "Investigation" beside each card's key on Research.
  const tags = $derived(research ? researchTags(boards) : {});
  const reconnecting = $derived(nowLive.state.reconnecting);
  // The last activity of each card's run, and what each engine profile last reported about its usage
  // windows, which the drop box and the start confirm read. Only the stream's own events write them.
  const activity = $derived<Readonly<Record<string, RunActivity>>>(nowLive.state.activity);
  const limits = $derived<Readonly<Record<string, ProfileLimit>>>(nowLive.state.limits);

  // The filter box and the Board or List switch, on every board. The filter narrows the cards by key
  // or title on the client, off the snapshot it already has.
  let query = $state('');
  // Board or List is kept per board, so opening a card and coming back finds the same view. Read in the
  // first render, and again on another board, so the page does not draw Board first. Blocked storage
  // means Board.
  const viewKey = (board: string) => `nolzu.view.${board}`;
  const storedListing = (board: string) => {
    try {
      return localStorage.getItem(viewKey(board)) === 'list';
    } catch {
      return false;
    }
  };
  const viewOf = $derived(research ? 'research' : kind);
  let listing = $derived(storedListing(viewOf));
  $effect(() => {
    const value = listing ? 'list' : 'board';
    try {
      localStorage.setItem(viewKey(viewOf), value);
    } catch {
      // Storage off: the switch still works, it is only not kept.
    }
    // The attribute app.html sets before the first paint, kept in step so its CSS never contradicts the
    // switch, and gone with the page.
    if (listing) document.documentElement.dataset.boardView = 'list';
    else delete document.documentElement.dataset.boardView;
    return () => delete document.documentElement.dataset.boardView;
  });
  let filterBox = $state<HTMLInputElement | undefined>();
  const shows = (card: CardView) => (!filtered || waitingOnMe(card)) && matchesFilter(card, query);
  const emptyLine = $derived(query.trim() !== '' ? 'No card matches the filter.' : 'Nothing waiting on you.');

  // One clock for the list's run times and the read stamp. The board keeps its own.
  let now = $state(new Date());
  $effect(() => {
    const timer = setInterval(() => (now = new Date()), 1000);
    return () => clearInterval(timer);
  });

  // The cards on this board that wait on a person, off the snapshot, so the count is the board's own.
  const waiting = $derived(snapshot === null ? null : snapshot.cards.filter(waitingOnMe).length);

  // The card the keys last reached.
  let selected = $state<string | null>(null);

  const cardElement = (key: string) => document.querySelector<HTMLElement>(`[data-card="${CSS.escape(key)}"]`);

  // Encoded as the tab bar encodes it, because resolve puts the key in as it is.
  const cardHref = (key: string) => resolve('/t/[key]', { key: encodeURIComponent(key) });
  // Where a refused start is fixed: the card's settings tab when the card runs that stage on a row of
  // its own, else Settings, Models.
  const settingsHref = resolve('/settings/[section]', { section: 'models' });
  const fixOf = (key: string, stage: string | null) => {
    const of = own(key);
    return of === null ? undefined : fixLink(of, key, stage, { card: resolve('/t/[key]/[tab]', { key: encodeURIComponent(key), tab: 'settings' }), models: settingsHref });
  };

  // The card the dialog made, said once the dialog has closed: the column it is in, or why its start
  // was refused, with the link that fixes it.
  let added: Added | null = null;
  // The start Add and start held back while Learn your repositories gates the first run. The Learn
  // dialog opens once Add card has closed, as it would on the first drag.
  let heldStart: { key: string; to: string } | null = null;

  // `?add` is Add card opened away from a board, from the palette or N on Now. An effect, because
  // the page stays mounted when the address goes to another board.
  $effect(() => {
    if (page.url.searchParams.has('add')) adding = true;
  });
  // So Add card away from a board knows which board this tab was on. Research adds through its own box.
  $effect(() => {
    if (!research) rememberBoard(kind);
  });
  let researchBox = $state<HTMLTextAreaElement | undefined>();

  function addClosed(): void {
    adding = false;
    // So a reload or a step back does not open it again.
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- the page's own address, which the router resolved
    if (page.url.searchParams.has('add')) void goto(page.url.pathname, { replaceState: true, keepFocus: true, noScroll: true });
    if (added !== null) toastStack.state = addedToast(toastStack.state, { key: added.key, href: cardHref(added.key) }, added, fixOf(added.key, added.at));
    added = null;
    const held = heldStart;
    heldStart = null;
    if (held !== null) setupGate.state = { key: held.key, to: held.to, go: () => move(held.key, held.to, true) };
  }

  async function addCard(asked: AddPayload): Promise<Made> {
    // The card goes on this board, so its start and its column are read off this board at the press.
    const target = snapshot ?? undefined;
    const { payload, start, held } = addOrHold(asked, target, nowLive.state.snapshot?.setup?.gates === true);
    const made = await postCard(fetch, resolve('/api/cards'), payload);
    if (made.ok) added = addedOf(made, target, start);
    if (made.ok && held !== null) heldStart = { key: made.key, to: held };
    return made;
  }

  const contextSources = () => contextCards(fetch, resolve('/api/cards/context'));
  const nextLocalKey = (board: BoardKind) => nextKey(fetch, `${resolve('/api/cards/next')}?board=${board}`);
  const myTickets = () => myTicketsOf(fetch, resolve('/api/tickets/mine'));
  // The layout carries the system, so the next dialog opens on Jira as well.
  async function connectJira(form: { site: string; email: string; token: string }) {
    const answer = await postJira(fetch, resolve('/api/tickets/jira'), form);
    if (answer.ok) void invalidateAll();
    return answer;
  }

  // The snapshot carries the kind it was built for, so the page draws the board the server sent and
  // never the one the address said a moment ago.
  const board = $derived(snapshot === null ? null : boardFor(snapshot.kind, snapshot.flow));
  const dragged = $derived(drag === null || snapshot === null ? null : (snapshot.cards.find((card) => card.key === drag?.key) ?? null));
  const allowed = $derived(board === null ? () => false as const : allowedFor(board, dragged));

  // The PR reviews board reads its repository's open pull requests on a press, and the Delivery board
  // looks up the pull requests of its cards on PR watch. Not a run, so the button shows its own pending
  // state, and the cards change through the stream like any other change.
  const pullsAt = $derived(pullsAddress(resolve('/api/board/pulls'), kind));
  // Kept per board. The page stays when the person goes to another board, and one board's press or
  // sentence would read as the other's.
  let reading = $state<Partial<Record<BoardKind, boolean>>>({});
  let read = $state<Partial<Record<BoardKind, string>>>({});
  async function readPulls(): Promise<void> {
    const asked = kind;
    const at = pullsAt;
    if (reading[asked] === true || at === null) return;
    reading[asked] = true;
    try {
      read[asked] = await readPullsSaid(fetch, at);
    } finally {
      reading[asked] = false;
    }
    // The PR reviews read writes its time, which the layout load carries to "read 12m ago".
    if (asked === 'prreview') void invalidateAll();
  }
  const readAgo = $derived(kind !== 'prreview' || !page.data.pullsReadAt ? null : age(page.data.pullsReadAt, now));

  // The page selects the moved card again once the stream draws it in its new column, so the next key
  // reaches it with no arrow first.
  async function move(key: string, stage: string, asked = false): Promise<boolean> {
    drag = null;
    // The first move into QA asks how QA gets the app first, and Start QA sends this move again.
    if (!asked && askFirst(key, stage, () => move(key, stage, true))) return false;
    follow.state = { key, to: stage };
    // Every toast goes to the app's one stack, which the root layout draws. It is replaced whole on
    // each change, never edited in place.
    toastStack.state = pressed(toastStack.state, key);
    const mine = toastStack.state.press;
    // Awaited on its own line. Inside the call, the stack would be read before the wait, and the answer
    // would undo every toast and press that came while the move was on its way.
    const said = await sendMove(fetch, resolve('/api/board/move'), key, stage);
    toastStack.state = answered(toastStack.state, mine, { key, href: cardHref(key) }, said);
    if (said !== null && follow.state?.key === key) follow.state = null;
    return said === null;
  }

  // A write a key sends for one card, with the press and the answer of a move, so a refusal is that
  // card's one toast. The card changes through the stream, never on this answer. A move is followed
  // into its column, as `move` follows it.
  async function send(key: string, path: string, body: unknown, asked = false): Promise<boolean> {
    // A retry in QA asks how QA gets the app while it has no answer, as after the scripts changed.
    if (!asked && path === retryPath(key) && askBeforeRetry(key, () => send(key, path, body, true))) return false;
    const to = path === resolve('/api/board/move') ? ((body as { to?: unknown }).to ?? null) : null;
    if (typeof to === 'string') follow.state = { key, to };
    toastStack.state = pressed(toastStack.state, key);
    const mine = toastStack.state.press;
    const said = await postWrite(fetch, path, body);
    if (said !== null && typeof to === 'string' && follow.state?.key === key) follow.state = null;
    toastStack.state = answered(toastStack.state, mine, { key, href: cardHref(key) }, said === null ? null : refusalFromServer(said));
    return said === null;
  }

  // The card a key or the palette moved, selected again with the focus once the stream draws it in its
  // new column. Not while the person has put the focus on something else meanwhile.
  $effect(() => {
    const key = snapshot === null ? null : landed(snapshot.cards, follow.state);
    if (key === null) return;
    follow.state = null;
    const at = document.activeElement;
    if (at !== null && at !== document.body && !(at instanceof HTMLElement && at.matches('article[data-card]'))) return;
    selected = key;
    void tick().then(() => cardElement(key)?.focus());
  });

  // Peek: Space opens the sheet on the chosen card, and J and K move the choice, which the sheet
  // follows. It closes when the card leaves the screen.
  let peeking = $state(false);
  // What had the focus when Space opened the sheet, for when the chosen card is gone by the close.
  let opener: HTMLElement | null = null;
  const peekCard = $derived(peeking && selected !== null ? (snapshot?.cards.find((card) => card.key === selected) ?? null) : null);
  $effect(() => {
    if (peeking && peekCard === null) peeking = false;
  });

  // Opens the sheet on a card, or moves it there while it is open. `from` takes the focus back on Esc
  // when the card is gone by then.
  function peekAt(key: string, from: HTMLElement): void {
    selected = key;
    opener = from;
    peeking = true;
  }

  // A click anywhere on a card peeks at it, as Space does, the title too. Read off the
  // click on the page, so the board and the list need no prop for it. The title stays a link, so a
  // click with a key held, or a middle click, still opens the page in a new tab. Any other link, button
  // or field in the card keeps its own job. A browser fires no click after a drag, and the flag holds
  // that for one that does.
  let draggedSincePress = false;
  // The card the first click of a double click peeked at. The sheet can narrow the columns, so the
  // second click may land on another card or between two. The sheet stays, and that card opens.
  let pairStart: string | null = null;
  function clickPeek(event: MouseEvent): void {
    if (event.detail <= 1) pairStart = null;
    const at = event.target instanceof Element ? event.target : null;
    const card = at?.closest<HTMLElement>('article[data-card]') ?? null;
    const title = at?.closest('a.title') ?? null;
    if (title !== null && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    if (draggedSincePress || at === null || card === null) return;
    if (title === null && at.closest('a, button, input, select, textarea, summary, [data-card-action]') !== null) return;
    // The router reads this and leaves the link alone.
    if (title !== null) event.preventDefault();
    if (pairStart !== null) return;
    card.focus();
    pairStart = card.dataset['card']!;
    peekAt(pairStart, card);
  }

  // A double click on a card opens its page, as Enter does from the open sheet. Its first click has
  // peeked already. A held key, a drag, or a press on one of the card's own links or buttons is left alone.
  function dblclickOpen(event: MouseEvent): void {
    const at = event.target instanceof Element ? event.target : null;
    const key = pairStart ?? at?.closest<HTMLElement>('article[data-card]')?.dataset['card'] ?? null;
    if (draggedSincePress || at === null || key === null) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (at.closest('a:not(.title), button, input, select, textarea, summary, [data-card-action]') !== null) return;
    void goto(resolve('/t/[key]', { key: encodeURIComponent(key) }));
  }

  // The slot meter in the top bar. The rail folds on a board, so its "2 of 3 slots
  // busy" is out of sight there. Off the same Now snapshot as the rail, never a count of the page's own.
  const slotMeter = $derived(nowLive.state.snapshot?.boards[0]?.slots ?? null);
  const pips = $derived(nowLive.state.snapshot === null ? [] : slotPips(nowLive.state.snapshot));
  // A card on screen peeks, any other card of the project opens its page. One the filter hides is not on
  // screen, and the sheet would close on the next key. The focus moves to the card, because Esc, J and
  // K act only from a card.
  function openSlot(key: string | null): void {
    if (key === null) return;
    const card = cardElement(key);
    if (card === null) {
      void goto(resolve('/t/[key]', { key: encodeURIComponent(key) }));
      return;
    }
    card.focus();
    peekAt(key, card);
  }

  // Esc returns the focus to the card the sheet showed, or to what opened it.
  function closePeek(): void {
    peeking = false;
    const card = selected === null ? null : cardElement(selected);
    (card ?? (opener?.isConnected ? opener : null))?.focus();
  }

  // The sheet's own Move back, which Shift Left reaches while the sheet is open on a running card.
  let panel = $state<{ back: () => Promise<void> } | undefined>();

  const retryPath = (key: string) => resolve('/api/card/[key]/retry', { key: encodeURIComponent(key) });
  const fixPath = (key: string) => resolve('/api/card/[key]/fix', { key: encodeURIComponent(key) });

  // The cards on screen, in the order the columns draw them. A card the filter hid or the board dropped
  // is no selection any more, or Enter would open a card that is not on screen. The list is one column
  // in the board's order, so the up and down keys walk it.
  function onScreen(): string[][] {
    if (snapshot === null) return [];
    const columns = visibleColumns(snapshot.stages, snapshot.cards.filter(shows), shutColumns(snapshot.stages, closedOpen));
    if (selected !== null && !columns.flat().includes(selected)) selected = null;
    return listing ? [columns.flat()] : columns;
  }
  const listed = $derived.by(() => {
    if (snapshot === null || !listing) return [];
    const byKey = new Map(snapshot.cards.map((card) => [card.key, card]));
    return visibleColumns(snapshot.stages, snapshot.cards.filter(shows), shutColumns(snapshot.stages, closedOpen))
      .flat()
      .map((key) => byKey.get(key)!);
  });

  function chosen(): CardView | null {
    onScreen();
    return snapshot?.cards.find((card) => card.key === selected) ?? null;
  }

  // A key for one card acts only on the card with the focus ring. With focus on the page, the
  // selection is drawn nowhere, and a write would land on a card the person cannot see is chosen.
  function focused(): CardView | null {
    const card = chosen();
    return card !== null && cardElement(card.key) === document.activeElement ? card : null;
  }

  function focusTo(arrow: Parameters<typeof focusMove>[2]): boolean {
    const next = focusMove(onScreen(), selected, arrow);
    // No card to go to: the arrow keeps its own job and scrolls the page.
    if (next === null) return false;
    selected = next;
    void tick().then(() => cardElement(next)?.focus());
    return true;
  }

  // The card whose retry, or whose move one column on, waits for its confirm, and the stage it would
  // run, read off the snapshot so a model that goes while the confirm is open turns Confirm off.
  let starting = $state<Starting | null>(null);
  const startingOn = $derived(starting === null ? null : own(starting.key));
  const startStage = $derived(starting === null || startingOn === null ? null : confirmStage(startingOn, starting));
  // R on a QA FAIL: the same confirm names Fix it's two runs and posts Fix it.
  const startFix = $derived(starting === null || startingOn === null ? null : confirmFix(startingOn, starting));
  // The confirm goes when its card can no longer do it: a retry once the card stops being failed, a move
  // once the card is no longer one column before it. Left set, it would open again by itself, with focus
  // on Confirm.
  $effect(() => {
    if (startStage === null) starting = null;
  });

  // Retry and a move forward ask first, with the lines a drop shows, and a refusal is the toast a refused
  // drop raises. The other writes go at once, and so does a move forward that starts nothing.
  function write(action: 'retry' | 'forward' | 'stop' | 'promote' | 'minimize'): boolean {
    const card = focused();
    return writeOn(action, card);
  }

  // The card's own Fix it button names its card, so it needs no focus ring.
  function writeOn(action: 'retry' | 'forward' | 'stop' | 'promote' | 'minimize', card: CardView | null): boolean {
    const on = card === null ? null : own(card.key);
    const said = card === null || on === null ? null : keyWrite(on, card.key, action);
    if (card === null || said === null) return false;
    // A move into QA before the question is answered asks that question in place of the confirm,
    // because Start QA is the consent.
    const to = said.kind === 'ask' ? said.move : undefined;
    if (to !== undefined && askFirst(card.key, to, () => move(card.key, to, true))) return true;
    if (said.kind === 'ask') starting = { key: card.key, move: said.move ?? null };
    else if (said.kind === 'refused') toastStack.state = refusedDrop(toastStack.state, { key: card.key, href: cardHref(card.key) }, said.refusal, fixOf(card.key, said.at));
    else void send(card.key, said.to === 'retry' ? retryPath(card.key) : resolve(said.to), said.body);
    return true;
  }

  // What each board key does. Every one reads the page at the press, and answers false when it did
  // nothing, so the browser keeps the key.
  const actions: KeyActions = {
    next: () => focusTo('ArrowDown'),
    previous: () => focusTo('ArrowUp'),
    right: () => focusTo('ArrowRight'),
    left: () => focusTo('ArrowLeft'),
    // Peeks first, as a click does, and opens the card page from the open sheet, as its Open button does.
    open: () => {
      const card = chosen();
      if (card === null) return false;
      if (!peeking) {
        opener = document.activeElement as HTMLElement | null;
        peeking = true;
        return;
      }
      void goto(resolve('/t/[key]', { key: encodeURIComponent(card.key) }));
    },
    // The place the card's own Answer link goes, the composer on the card page. A card that asks
    // nothing has no answer, and the key does nothing there.
    answer: () => {
      const card = chosen();
      const to = card === null ? null : answerHref(card);
      if (to === null) return false;
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- the address the card's Answer link holds, so the key and the link cannot part
      void goto(to);
    },
    // One step back at a time: first the peek, then the selection, then the typed filter, then Waiting
    // on me.
    back: () => {
      if (peeking) {
        closePeek();
        return;
      }
      if (chosen() !== null) {
        selected = null;
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      if (query !== '') {
        query = '';
        return;
      }
      if (!filtered) return false;
      void toggleFilter();
    },
    filter: () => void toggleFilter(),
    find: () => filterBox?.focus(),
    view: () => void (listing = !listing),
    add: () => {
      if (research) researchBox?.focus();
      else adding = true;
    },
    // The same move a drop on the next column sends, asked first when it starts a run, as the drop box
    // shows first.
    'move-forward': () => write('forward'),
    // The same move a drop on the column before sends. Moving back never starts a run, so it asks nothing.
    // With the sheet open on a running card it is the sheet's Move back, which stops the run first, as
    // the sheet says beside the button.
    'move-back': () => {
      const card = focused();
      if (card !== null && peekCard?.key === card.key && (card.state === 'running' || card.state === 'queued') && panel !== undefined) {
        void panel.back();
        return;
      }
      const to = card === null || board === null ? null : stageBack(board, card);
      if (card === null || to === null) return false;
      void move(card.key, to);
    },
    // Opens the sheet on the chosen card, and closes it again.
    peek: () => {
      if (peeking) {
        closePeek();
        return;
      }
      const card = chosen();
      if (card === null) return false;
      opener = document.activeElement as HTMLElement | null;
      peeking = true;
    },
    retry: () => write('retry'),
    stop: () => write('stop'),
    promote: () => write('promote'),
    minimize: () => write('minimize'),
    copy: () => {
      const card = focused();
      if (card === null) return false;
      const at = { key: card.key, href: cardHref(card.key) };
      void copyText(card.key).then((copied) => (toastStack.state = keyCopied(toastStack.state, at, copied)));
    },
  };

  // The board's keys, handed to the layout's one handler while the board is on screen. Read pull
  // requests only on the boards that have the button. None while the page waits for the board.
  const ready = $derived(snapshot !== null);
  const boardKeys = $derived<KeyActions>(pullsAt === null ? actions : { ...actions, 'read-pulls': () => void readPulls() });
  $effect(() => {
    if (!ready) return;
    return pageKeys.show({ keys: scoped('board'), actions: boardKeys });
  });
  const hints = $derived(hintsOf(liveKeys(scoped('board'), boardKeys), peekCard !== null));
  // Help is the layout's, and it is there on every page, so the row always ends with it.
  const helpKeys = scoped('global').find((binding) => binding.action === 'help')?.keys ?? [];

  // The first drag's coach note, on the first agent column while a card waits in the column before it.
  // The Now stream says whether it shows, so it goes the moment a card is dragged. Got it hides it at
  // once and stores it, so a reload keeps it closed.
  let coachClosed = $state(false);
  // Closed folds over its cards until a click opens it, and closes again on another board.
  // Leaving for another page unmounts this one, which closes it too.
  let closedOpen = $state(false);
  $effect.pre(() => {
    void kind;
    closedOpen = false;
  });
  // The typed filter belongs to the board it was typed on.
  $effect.pre(() => {
    void kind;
    query = '';
  });
  const coach = $derived(coachClosed ? null : coachAt(snapshot, nowLive.state.snapshot?.firstRun?.coach ?? null, nowLive.state.snapshot?.profiles ?? []));
  const forwardKeys = scoped('board').find((binding) => binding.action === 'move-forward')?.keys ?? [];
  const findKeys = scoped('board').find((binding) => binding.action === 'find')?.keys ?? [];
  // What the add button says on each board, the same words as the dialog it opens.
  const addLabel = $derived(addWords(kind).title);
  function closeCoach(note: string): void {
    coachClosed = true;
    void postWrite(fetch, resolve('/api/notes'), { note });
  }
</script>

{#snippet firstDrag()}
  {#if coach !== null}
    <!-- Cream and never amber: the note explains a start and starts nothing. -->
    <CoachNote note={COACH_NOTE} seen={[]} title="Dropping a card here is your approval" ondismiss={closeCoach}>
      <!-- While the Learn gate holds the first run, the drop opens it before the run starts. -->
      {#if nowLive.state.snapshot?.setup?.gates === true}
        <p>An amber column runs an agent. Drop {coach.key} and Nolzu first offers to learn your repositories, then {coach.engine} starts {coach.label} on this machine.</p>
      {:else}
        <p>An amber column runs an agent. Drop {coach.key} and {coach.engine} starts {coach.label} on this machine.</p>
      {/if}
      {#if PHASE_SAYS[coach.phase] !== undefined}<p>{PHASE_SAYS[coach.phase]}</p>{/if}
      {#snippet hint()}No mouse? Select the card and press <KeyCaps combos={forwardKeys} />{/snippet}
    </CoachNote>
  {/if}
{/snippet}

<svelte:head><title>{title} · Nolzu</title></svelte:head>

<!-- The top bar, the board and the key row fill the window, so the key row sits at its foot and the
     columns run down to it. The peek sheet sits beside them. -->
<div class="split">
<!-- The click is the mouse's way to the peek, and a double click opens the card. Space is the key's way,
     on the card with the focus. -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="page" onclick={clickPeek} ondblclick={dblclickOpen} onpointerdown={() => (draggedSincePress = false)} ondragstart={() => (draggedSincePress = true)}>
<div class="title">
  <h1>{title}</h1>
  {#if snapshot !== null}<span class="sub">{boardCount(snapshot, kind)}</span>{/if}
  <span class="spacer"></span>
  {#if slotMeter !== null && pips.length > 0}
    <span class="slots" role="group" aria-label={slotsLine(slotMeter)} data-slot-meter>
      {#each pips as pip, at (at)}
        {#if pip.busy}
          <!-- A button so a keyboard reaches the words too. Another project's run has no card to open. -->
          <button
            type="button"
            class="pip"
            data-pip
            data-busy="true"
            data-tip={pip.label}
            aria-label={pip.label}
            aria-disabled={pip.key === null ? 'true' : undefined}
            onclick={() => openSlot(pip.key)}
          ></button>
        {:else}
          <span class="pip" data-pip role="img" aria-label={pip.label}></span>
        {/if}
      {/each}
    </span>
  {/if}
  {#if readAgo !== null}<span class="sub stamp" data-read-ago>read {readAgo} ago</span>{/if}
  {#if pullsAt !== null}
    <Button key="P" aria-busy={reading[kind] ? 'true' : undefined} onclick={readPulls} data-read-pulls
      ><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"></path></svg
      >{reading[kind] ? 'Reading pull requests' : 'Read pull requests'}</Button
    >
  {/if}
  <!-- Escape in the box clears it, then leaves it, so the typed text is the box's own. -->
  <label class="filter">
    <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
    <input
      type="search"
      bind:this={filterBox}
      bind:value={query}
      placeholder={kind === 'epics' ? 'Filter epics' : 'Filter cards'}
      aria-label={kind === 'epics' ? 'Filter epics by key or title' : 'Filter cards by key or title'}
      data-filter
      onkeydown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        if (query !== '') query = '';
        else filterBox?.blur();
      }}
    />
    <KeyCaps combos={findKeys} />
  </label>
  <!-- Beside the title. Not before the first snapshot, which has the count. -->
  {#if waiting !== null}<WaitingToggle on={filtered} count={waiting} onclick={() => void toggleFilter()} />{/if}
  <span class="seg" role="group" aria-label="View">
    <button type="button" aria-pressed={!listing} onclick={() => (listing = false)} data-view="board">Board</button>
    <button type="button" aria-pressed={listing} onclick={() => (listing = true)} data-view="list">List</button>
  </span>
  {#if !research}
    <Button key="N" onclick={() => (adding = true)}
      ><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>{addLabel}</Button
    >
  {/if}
</div>
{#if research}<ResearchAdd bind:box={researchBox} />{/if}
{#if pullsAt !== null}
  <!-- Always on the page on these boards, so a screen reader is listening before the answer arrives. -->
  <p class="note" role="status" data-read-said>{read[kind] ?? ''}</p>
{/if}

{#if adding && !research}
  <!-- The card goes on the board the person is looking at, so it lands where they can see it. Keyed
       on it, because Back works past an open dialog, and the dialog would otherwise keep the board it
       opened on. -->
  {#key kind}
    <AddCardDialog
      prefix={page.data.prefix ?? 'APP'}
      board={kind}
      snapshots={snapshot === null ? [] : [snapshot]}
      off={page.data.offBoards ?? []}
      sources={contextSources}
      next={nextLocalKey}
      mine={myTickets}
      tickets={page.data.tickets ?? 'local'}
      onconnect={connectJira}
      onsubmit={addCard} onclose={addClosed} bind:draft={cardDraft} />
  {/key}
{/if}

{#if reconnecting}
  <!-- Quiet on purpose. The board it had stays in view, and the stream comes back by itself. -->
  <p class="note" role="status">The board is not answering. Trying again.</p>
{/if}

{#if snapshot === null}
  {#if !reconnecting}<div class="first" aria-busy="true"><Skeleton shape="block" height="280px" label="Waiting for the board." /></div>{/if}
{:else if listing}
  <BoardList cards={listed} stages={snapshot.stages} {tags} {activity} quietAfterMs={snapshot.quietAfterMs} {now} {selected} onSelect={(key) => (selected = key)} empty={emptyLine} />
{:else}
  <Board
    {snapshot}
    {activity}
    {limits}
    {filtered}
    {query}
    {selected}
    onSelect={(key) => (selected = key)}
    {drag}
    {allowed}
    onMove={move}
    aside={coach === null ? null : { stage: coach.stage, content: firstDrag }}
    bind:archiveOpen={closedOpen}
    onFix={(key) => void writeOn('retry', snapshot?.cards.find((card) => card.key === key) ?? null)}
    {tags}
    onDragStart={(key) => (drag = startDrag(key))}
    onDragEnter={(stage) => (drag = drag === null ? null : enterColumn(drag, stage))}
    onDragLeave={(stage, gone) => (drag = drag === null ? null : leaveColumn(drag, stage, gone))}
    onDragEnd={() => (drag = null)}
    onRefuse={(said) => {
      // The column the drag is over is the one that refused it.
      if (drag !== null) toastStack.state = refusedDrop(toastStack.state, { key: drag.key, href: cardHref(drag.key) }, said, fixOf(drag.key, drag.over));
      drag = null;
    }}
  />
{/if}

<!-- The key row, drawn from the registry, so it shows only keys that work. -->
<p class="keys">
  {#each hints as hint (hint.binding.action)}
    <span><KeyCaps combos={hint.binding.keys} bare={hint.bare} />{hint.label}</span>
  {/each}
  <span class="all"><KeyCaps combos={helpKeys} />all keys</span>
</p>
</div>

{#if peekCard !== null && snapshot !== null && board !== null}
  <PeekPanel bind:this={panel} card={peekCard} snapshot={own(peekCard.key) ?? snapshot} activity={activity[peekCard.key]} onclose={closePeek} />
{/if}
</div>

{#if starting !== null && startStage !== null}
  <!-- A move sends what a drop on that column sends, through the same function. -->
  <StartConfirm
    title={startFix !== null ? `Fix ${starting.key}: ${startFix.implement.label}, then ${startFix.qa.label}` : starting.move === null ? `Retry ${starting.key} in ${startStage.label}` : `Move ${starting.key} to ${startStage.label}`}
    stage={startStage}
    then={startFix?.qa ?? null}
    {limits}
    onconfirm={() => {
      if (starting !== null && startFix !== null) void send(starting.key, fixPath(starting.key), {});
      else if (starting?.move === null) void send(starting.key, retryPath(starting.key), {});
      else if (starting !== null) void move(starting.key, starting.move);
    }}
    onclose={() => (starting = null)}
  />
{/if}

<style>
  /* The Board's own row takes the height the top bar and the key row leave, in the window less the
     offline banner when there is one. Below 760px the rail is a band above the page, and the page grows
     from its content. */
  .split {
    display: flex;
  }

  .page {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: calc(100vh - var(--offline-height, 0px));
  }

  /* The top bar: 54px, a line under it, the title and its count on the left. */
  .title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    min-height: 54px;
    box-sizing: border-box;
    padding: 0 var(--space-6);
    border-bottom: 1px solid var(--line);
  }

  @media (max-width: 760px) {
    .page {
      min-height: 0;
    }

    .title {
      padding: var(--space-3) var(--space-4);
    }
  }

  h1 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .sub {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .spacer {
    flex: 1;
  }

  .stamp {
    font-size: var(--text-xs);
  }

  /* The filter box: 30px high and 200px wide, quiet until typed in. The bar wraps at its 96px
     basis, so with the peek sheet open the box narrows before a button drops to a second line, and a
     bar too narrow for even that wraps instead of running off the page. */
  .filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 1 1 96px;
    max-width: 200px;
    height: 30px;
    box-sizing: border-box;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
    color: var(--muted);
  }

  .filter:focus-within {
    border-color: var(--ink-2);
  }

  .filter input {
    flex: 1;
    min-width: 0;
    padding: 0;
    border: 0;
    outline: none;
    background: none;
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  .filter input::placeholder {
    color: var(--muted);
    opacity: 1;
  }

  /* The Board | List switch. Pressed is said by the attribute and by the fill. */
  .seg {
    display: inline-flex;
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--panel);
  }

  .seg button {
    height: 24px;
    padding: 0 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .seg button[aria-pressed='true'] {
    background: var(--card-2);
    color: var(--ink);
  }

  /* List chosen before hydration: app.html marks the page, so the server's Board press never shows. */
  :global(html[data-board-view='list']) .seg button[data-view='board'] {
    background: none;
    color: var(--muted);
  }

  :global(html[data-board-view='list']) .seg button[data-view='list'] {
    background: var(--card-2);
    color: var(--ink);
  }

  /* One pip per slot, filled while a run holds it and hollow while free, so the state is a shape and
     not only a color. Not amber as on Now's meter: a busy pip is a button, and amber on a control
     means a press starts an agent. */
  .slots {
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  .pip {
    position: relative;
    width: 10px;
    height: 10px;
    box-sizing: border-box;
    padding: 0;
    border: 1px solid var(--faint);
    border-radius: var(--radius-xs);
    background: none;
  }

  /* The button is a 16 by 24 target around the 10px square, and the margin keeps the squares 3px apart. */
  .pip[data-busy='true'] {
    display: grid;
    place-items: center;
    width: 16px;
    height: 24px;
    margin: 0 -3px;
    border: none;
    cursor: pointer;
  }

  .pip[data-busy='true']::before {
    content: '';
    width: 10px;
    height: 10px;
    border-radius: var(--radius-xs);
    background: var(--ink-2);
  }

  .pip[aria-disabled='true'] {
    cursor: default;
  }

  /* The run in the slot, on hover and on keyboard focus, which a title attribute never shows. */
  .pip[data-tip]:hover::after,
  .pip[data-tip]:focus-visible::after {
    content: attr(data-tip);
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 5;
    padding: 4px 8px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--panel);
    color: var(--ink);
    font-size: var(--text-xs);
    white-space: nowrap;
  }

  .icon {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The grey board until the first snapshot lands, in the page's side gutter. */
  .first {
    padding: var(--space-4) var(--space-6) 0;
  }

  .note {
    margin: 0;
    padding: var(--space-2) var(--space-6) 0;
    font-size: var(--text-xs);
    color: var(--ink-3);
  }

  /* The read's status line waits empty, and takes no room until it has something to say. */
  .note:empty {
    padding: 0;
  }

  /* At the window's foot. */
  .keys {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-4);
    margin: auto 0 0;
    padding: 10px var(--space-6);
    border-top: 1px solid var(--line);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .keys > span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .keys > .all {
    margin-left: auto;
  }
</style>
