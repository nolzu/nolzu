<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { goto, invalidateAll } from '$app/navigation';
  import { tick, untrack } from 'svelte';
  import { type ChangeGroup, type Changes, changesView, type ChangesView, type RunEvent } from '@nolzu/protocol';
  import { Button, ChangeGroups, DiscussionTab, FilesTab, LogTab, Overview, PrsTab, refusalFromServer, ReviewTab, SendBackPanel, sendBackOf, SettingsTab } from '@nolzu/ui';
  import { dismissed, refusedDrop } from '$lib/board-page.ts';
  import { copyText } from '$lib/clipboard.ts';
  import { readLines } from '$lib/log-stream.ts';
  import { nowLive } from '$lib/now-live.svelte.ts';
  import { readCardPulls } from '$lib/card-pulls.ts';
  import { at } from '$lib/repo-param.ts';
  import { gateMove, postWrite } from '$lib/ticket.ts';
  import { mergeById, withStatus } from '$lib/stream-merge.ts';
  import { streamed } from '$lib/held-answer.svelte.ts';
  import Streamed from '$lib/Streamed.svelte';
  import { toastStack } from '$lib/toast-stack.svelte.ts';
  import { qaView } from '@nolzu/ui/qa';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  const key = $derived(encodeURIComponent(page.params.key ?? ''));

  // The status command's answer, the knowledge patches and the discussion's tool calls land after the
  // page drew. The panels, their buttons and the rows stay the ones this load read, so only the
  // command's words, the patch lines and the tool lines wait.
  const stackStatus = streamed(
    () => data.qaStatus,
    () => page.params.key,
  );
  const qa = $derived(data.qa === null ? null : qaView(withStatus(data.qa, stackStatus.current)));
  const patches = streamed(
    () => data.knowledgePatches,
    () => page.params.key,
  );
  const knowledge = $derived(data.knowledge === null ? null : mergeById(data.knowledge, patches.current, ['diff', 'applied']));
  const tools = streamed(
    () => data.discussionTools,
    () => page.params.key,
  );
  const messages = $derived(data.discussion === null ? [] : mergeById(data.discussion.messages, tools.current, ['tools', 'run']));

  // A git write or a stack command, then the page reads the card again and waits for the parts it
  // streams too, as it did before they streamed: the tab never says "Committed" over the old diff.
  async function reread(): Promise<void> {
    await invalidateAll();
    await Promise.allSettled([data.groups, data.qaStatus]);
    await tick();
  }

  // A write, then the page reads the card again. The answer is the sentence the server refused with.
  async function write(url: string, init: RequestInit): Promise<string | null> {
    try {
      const answer = await fetch(url, init);
      if (!answer.ok) return ((await answer.json()) as { message?: string }).message ?? 'The change was refused.';
      await invalidateAll();
      return null;
    } catch {
      return 'The change could not be sent. The local app is not answering.';
    }
  }

  const saveContext = (text: string) =>
    write(resolve('/api/card/[key]/context', { key }), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  const sendAnswer = (answer: string) =>
    write(resolve('/api/card/[key]/answer', { key }), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answer }) });
  const models = (body: object) =>
    write(resolve('/api/card/[key]/models', { key }), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // Attach and detach a pull request by its link or owner/repo#N.
  const pullLink = (method: 'POST' | 'DELETE') => (link: string) =>
    write(resolve('/api/card/[key]/pr/links', { key }), { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ link }) });
  // "Read comments": a gh read, not a run, so the tab shows the answer itself. A refusal is the plain
  // sentence the server answered, such as gh not being logged in.
  async function readComments(): Promise<{ said: string; failed: boolean }> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/pr/comments', { key }), { method: 'POST' });
      const body = (await answer.json()) as { said?: string; message?: string };
      if (!answer.ok) return { said: body.message ?? 'The comments were not read.', failed: true };
      await invalidateAll();
      return { said: body.said ?? '', failed: false };
    } catch {
      return { said: 'The comments could not be read. The local app is not answering.', failed: true };
    }
  }
  const markComment = (ref: string, action: 'done' | 'reopen') =>
    write(resolve('/api/card/[key]/pr/discussions', { key }), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ref, action }) });
  // Opening the tab marks the card's messages seen. The dots drawn now go on the next load.
  // Run triage: a run, so the tab holds its button off the card in the snapshot. Copy puts a drafted
  // reply on the clipboard; the person posts it on GitHub.
  const runTriage = () => postWrite(fetch, resolve('/api/card/[key]/pr/triage', { key }), {});
  // Fix: a run, held off the snapshot too. A start that failed wrote its reason on the row, so the page
  // reads the rows again to show it.
  async function fixComment(ref: string): Promise<string | null> {
    const refused = await postWrite(fetch, resolve('/api/card/[key]/pr/fix', { key }), { ref });
    if (refused !== null) await invalidateAll();
    return refused;
  }
  // Fix all and QA the fixes: runs, held off the snapshot like triage. A Fix all that failed to start
  // wrote its reason on the rows, so the page reads them again.
  async function fixAllComments(): Promise<string | null> {
    const refused = await postWrite(fetch, resolve('/api/card/[key]/pr/fix-all', { key }), {});
    if (refused !== null) await invalidateAll();
    return refused;
  }
  const qaFixes = () => postWrite(fetch, resolve('/api/card/[key]/pr/qa', { key }), {});
  // Discuss: the thread under the ref, opened with the discussion, then the Discussion tab on it.
  async function discussComment(ref: string): Promise<string | null> {
    const refused = await postWrite(fetch, resolve('/api/card/[key]/pr/discuss', { key }), { ref });
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() makes the address, the thread is its query
    if (refused === null) await goto(`${resolve('/t/[key]/[tab]', { key, tab: 'discussion' })}?thread=${encodeURIComponent(ref)}`);
    return refused;
  }
  // Make a Delivery card from a Research card: a write that starts no run, so it says its own outcome.
  async function deliver(): Promise<string> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/research', { key }), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'deliver' }) });
      const body = (await answer.json().catch(() => ({}))) as { key?: string; message?: string };
      if (!answer.ok || body.key === undefined) return body.message ?? `No card was made. Nolzu answered ${answer.status}.`;
      await invalidateAll();
      return `Made ${body.key} in the Delivery Inbox, linked to ${key}.`;
    } catch {
      return 'No card was made. The local app is not answering.';
    }
  }
  const copyReply = async (text: string) =>
    (await copyText(text)) ? null : 'The reply was not copied. The browser refused the clipboard, so select it and copy it by hand.';
  const seenComments = () => {
    void fetch(resolve('/api/card/[key]/pr/seen', { key }), { method: 'POST' }).catch(() => {});
  };
  const tickChain = (on: boolean) =>
    write(resolve('/api/card/[key]/chain', { key }), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on }) });
  const pickRepos = (repos: string[]) =>
    write(resolve('/api/card/[key]/repos', { key }), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repos }) });
  // The epic's tasks, sent as one list, because the server writes them in one go. The plan's tasks send
  // the key each row shows, with each one's description and the step it came from.
  // An add that took can still say the notes of a task were not written, and the person reads that.
  async function addTasks(titles: string[], keys?: string[], descriptions?: string[], steps?: string[], refs?: string[], notes?: string[]): Promise<string | null | { note: string }> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/tasks', { key }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ titles, keys, descriptions, steps, refs, notes }),
      });
      const body = (await answer.json().catch(() => ({}))) as { message?: string; note?: string };
      if (!answer.ok) return body.message ?? 'The change was refused.';
      await invalidateAll();
      return typeof body.note === 'string' ? { note: body.note } : null;
    } catch {
      return 'The change could not be sent. The local app is not answering.';
    }
  }
  // Link on a task row reads the ticket at once, so the row shows its own title or the reason it was refused.
  async function readTicket(ref: string): Promise<{ key: string; title: string; ref?: string } | string> {
    try {
      const answer = await fetch(`${resolve('/api/tickets/read')}?ref=${encodeURIComponent(ref)}`);
      const body = (await answer.json()) as { key?: string; title?: string; ref?: string; message?: string };
      return answer.ok && body.key !== undefined
        ? { key: body.key, title: body.title ?? body.key, ...(body.ref === undefined ? {} : { ref: body.ref }) }
        : (body.message ?? `The ticket could not be read (${answer.status}). Try again.`);
    } catch {
      return 'The ticket could not be read. The local app is not answering.';
    }
  }
  const copyTask = async (text: string) =>
    (await copyText(text)) ? null : 'The task was not copied. The browser refused the clipboard, so open the row and copy the text by hand.';
  // An epic's tasks read their state off the Delivery board of the one Now stream. Delivery is always
  // on, so the stream always carries it.
  const delivery = $derived(nowLive.state.snapshot?.boards.find((one) => one.kind === 'delivery') ?? null);

  // An Ask run moves no card, so the layout's watch on the card's state never reads its answer. While
  // one goes, or the pass that names an Ask discussion, every new snapshot reads the page again; the
  // run's end sends one.
  let seenSnapshot: unknown = null;
  $effect(() => {
    const snapshot = nowLive.state.snapshot;
    if (snapshot === seenSnapshot) return;
    const first = seenSnapshot === null;
    seenSnapshot = snapshot;
    if (!first && untrack(() => data.discussion?.asking === true || data.discussion?.titling === true)) void invalidateAll();
  });
  // The column the gate offers once its questions are settled, read off the live board.
  const gateNext = $derived(
    gateMove(
      nowLive.state.snapshot?.boards.find((one) => one.kind === data.board),
      page.params.key ?? '',
    ),
  );
  // Presses Next step's own button, so the QA question, the hold until the board shows the move and a
  // refusal work as they do there.
  const gateStart = () => {
    if (gateNext !== null) document.querySelector<HTMLElement>(`[data-go-button][data-move="${gateNext.id}"]`)?.click();
  };
  // The choice on a question that blocks the next move: no answer takes the default.
  const choose = (id: string, answer?: string) =>
    write(resolve('/api/card/[key]/choice', { key }), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...(answer === undefined ? {} : { answer }) }) });
  const unlink = (other: string) => write(resolve('/api/card/[key]/link/[other]', { key, other: encodeURIComponent(other) }), { method: 'DELETE' });

  // The three buttons of the app line. They run commands the person wrote and wait for it, so the answer is
  // the command's own sentence. The page reloads after it, which is what refreshes the panel.
  async function stackAction(action: 'load' | 'unload' | 'force'): Promise<string> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/stack', { key }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const said = (await answer.json()) as { ok: boolean; said?: string };
      await reread();
      return said.said ?? 'The command was refused.';
    } catch {
      return 'The command could not be sent. The local app is not answering.';
    }
  }

  // One review block onto the clipboard. `packages/ui` never touches the browser, so it hands the
  // text back here and this answers with the sentence to show, or null once the text is there.
  async function copyBlock(text: string): Promise<string | null> {
    return (await copyText(text)) ? null : 'The block was not copied. The browser refused the clipboard, so select the block and copy it by hand.';
  }

  async function copyFile(text: string): Promise<string | null> {
    return (await copyText(text)) ? null : 'The file was not copied. The browser refused the clipboard, so select the text and copy it by hand.';
  }

  async function copyCommand(text: string): Promise<string | null> {
    return (await copyText(text)) ? null : 'The command was not copied. The browser refused the clipboard, so select the command below and copy it by hand.';
  }

  // The Files tab, opened on one file of the card folder.
  const filesAt = (path: string) => `${resolve('/t/[key]/[tab]', { key, tab: 'files' })}?${new URLSearchParams({ file: path })}`;

  // A file shown goes by an address shaped like its path, so a design screen's relative link to its
  // tokens.css lands on the file beside it. A download keeps the query route.
  const fileUrl = (path: string, download = false) =>
    download
      ? `${resolve('/api/card/[key]/file', { key })}?${new URLSearchParams({ path, download: '1' })}`
      : resolve('/api/card/[key]/files/[...path]', { key, path: path.split('/').map(encodeURIComponent).join('/') });

  // A text file of the card folder, read when the person opens it.
  async function readFile(path: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
    try {
      const answer = await fetch(fileUrl(path));
      return answer.ok ? { ok: true, text: await answer.text() } : { ok: false, reason: await answer.text() };
    } catch {
      return { ok: false, reason: 'The file could not be read. The local app is not answering.' };
    }
  }

  // The shown run's events, streamed as the run writes them. A new run, or leaving the tab, ends the stream.
  let events = $state<RunEvent[]>([]);
  // Derived, so a reload of the page data that keeps the same run does not start the stream again.
  const selectedRun = $derived(data.log?.selected ?? null);
  $effect(() => {
    const run = selectedRun;
    events = [];
    if (run === null) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const answer = await fetch(`${resolve('/api/card/[key]/log', { key })}?run=${run}`, { signal: controller.signal });
        if (!answer.ok || answer.body === null) return;
        // A line that was already on its way when this stream was dropped belongs to no list any more.
        await readLines(answer.body, (line) => controller.signal.aborted || events.push(JSON.parse(line) as RunEvent));
      } catch {
        // Aborted on the way out, or the app went away. The rows already shown stay.
      }
    })();
    return () => controller.abort();
  });
  const runHref = (id: number) => `${resolve('/t/[key]/[tab]', { key, tab: 'log' })}?run=${id}`;
  // The Log tab's Stop reads the card off its board in the one Now stream. A board that is off is not in
  // it, so a card there has no Stop on this tab; Cmd period still stops it from the layout.
  const logCard = $derived(nowLive.state.snapshot?.boards.find((one) => one.kind === data.board)?.cards.find((one) => one.key === page.params.key) ?? null);
  const stopRun = (runId: number) => postWrite(fetch, resolve('/api/board/stop'), { runId });

  // Rename an Ask discussion. The name is the person's from then on, and the pass never writes over it.
  const renameThread = (thread: string, subject: string) =>
    write(resolve('/api/card/[key]/thread', { key }), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ thread, subject }) });

  // The page does the write, because packages/ui never fetches. It answers with the sentence the
  // send was refused with, or null once the run is queued, which is what the composer reads.
  async function sendMessage(thread: string, text: string, model: string): Promise<string | null> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/message', { key }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ thread, text, model }),
      });
      // Every refusal carries the server's own sentence, which names the state the card is in. A
      // status number tells a person nothing they can act on.
      if (!answer.ok) {
        const said = (await answer.json().catch(() => null)) as { message?: string } | null;
        return said?.message ?? `The message was refused with ${answer.status}.`;
      }
      await invalidateAll();
      return null;
    } catch {
      return 'The message could not be sent. The local app is not answering.';
    }
  }

  // The two message buttons on the commit composer, and the push dialog. The engine of the plain summary
  // row writes it from the uncommitted change of that repository, and the answer fills the box for the
  // person to edit, with the model and the cost the pass reported.
  async function writeMessage(repo: string, short: boolean): Promise<{ ok: true; message: string; model?: string; cost?: number | null } | { ok: false; reason: string }> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/commit-message', { key }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ short, ...at(repo) }),
      });
      const said = (await answer.json()) as { ok: true; message: string; model?: string; cost?: number | null } | { ok: false; reason?: string };
      return said.ok ? said : { ok: false, reason: said.reason ?? `The message request was refused with ${answer.status}.` };
    } catch {
      return { ok: false, reason: 'The message request could not be sent. The local app is not answering.' };
    }
  }

  // hooks goes only when the person ticked Run hooks. Left out, the server skips the repository's hooks.
  // `paths` is every ticked file, and the server commits exactly those.
  async function commit(repo: string, message: string, paths: string[], hooks = false): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/commit', { key }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, only: paths, ...at(repo), ...(hooks ? { hooks: true } : {}) }),
      });
      const said = (await answer.json()) as { ok: boolean; reason?: string };
      if (!said.ok) return { ok: false, reason: said.reason ?? 'The commit was refused.' };
      await reread();
      return { ok: true };
    } catch {
      return { ok: false, reason: 'The commit could not be sent. The local app is not answering.' };
    }
  }

  // The push dialog's press is the consent, so the confirmation goes with it. A push commits nothing, so
  // the dialog sends no message; the route still commits first when one is sent.
  async function push(repo: string, commit?: { message: string; only: string[] }, hooks = false): Promise<{ ok: true } | { ok: false; reason: string; rejected?: boolean; command?: string }> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/push', { key }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmed: true, ...at(repo), ...(commit ?? {}), ...(hooks ? { hooks: true } : {}) }),
      });
      const said = (await answer.json()) as { ok: boolean; reason?: string; rejected?: boolean; command?: string };
      // A commit can go before the push is refused, and the tab then shows it.
      if (!said.ok && commit !== undefined) await reread();
      if (!said.ok) return { ok: false, reason: said.reason ?? 'The push was refused.', rejected: said.rejected === true, ...(said.command === undefined ? {} : { command: said.command }) };
      await reread();
      return { ok: true };
    } catch {
      return { ok: false, reason: 'The push could not be sent. The local app is not answering.' };
    }
  }

  // "Pull into the checkout" after a rejected push. A direct git action, so the panel shows its own
  // pending state, and the page reads the card again, so Changes shows a conflict it stopped on.
  async function pull(repo: string): Promise<{ ok: true; upToDate?: boolean } | { ok: false; reason: string; conflicts?: string[] }> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/pull', { key }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(at(repo)),
      });
      const said = (await answer.json()) as { ok: true; upToDate?: boolean } | { ok: false; reason?: string; conflicts?: string[] };
      await reread();
      return said.ok ? said : { ok: false, reason: said.reason ?? 'The pull was refused.', conflicts: said.conflicts ?? [] };
    } catch {
      return { ok: false, reason: 'The pull could not be sent. The local app is not answering.' };
    }
  }

  async function copyOutput(text: string): Promise<string | null> {
    return (await copyText(text)) ? null : 'The output was not copied. The browser refused the clipboard, so select it and copy it by hand.';
  }

  // A comment on a diff line, an edit of one and a delete. Nothing runs: a comment waits for a send
  // back. The page reads the comments again, and the answer is null or the server's sentence.
  async function commentWrite(url: string, method: string, body?: object): Promise<string | null> {
    try {
      const answer = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const said = (await answer.json()) as { ok: boolean; reason?: string };
      if (!said.ok) return said.reason ?? `The comment was refused with ${answer.status}.`;
      await invalidateAll();
      return null;
    } catch {
      return 'The comment could not be sent. The local app is not answering.';
    }
  }
  const comment = (repo: string, ask: { file: string; line: number; lineText: string; text: string }) =>
    commentWrite(resolve('/api/card/[key]/comments', { key }), 'POST', { ...ask, ...at(repo) });
  const editComment = (id: number, text: string) => commentWrite(resolve('/api/card/[key]/comments/[id]', { key, id: String(id) }), 'PATCH', { text });
  const deleteComment = (id: number) => commentWrite(resolve('/api/card/[key]/comments/[id]', { key, id: String(id) }), 'DELETE');

  // Send back with comments on the Changes tab. The card comes off the Delivery board of the one Now
  // stream, the only board with this tab, so the button holds until the board shows the card moved.
  const shownCard = $derived(delivery?.cards.find((one) => one.key === page.params.key) ?? null);
  const unsent = $derived((data.comments ?? []).filter((one) => one.sentAt === null).length);
  const sendBack = $derived(shownCard === null || delivery === null ? null : sendBackOf(shownCard, delivery.stages, unsent));
  const sendBackRun = () => postWrite(fetch, resolve('/api/card/[key]/send-back', { key }), {});
  // Fix CI under "Why it cannot merge": a run, held off the snapshot as Send back is.
  const fixCiRun = () => postWrite(fetch, resolve('/api/card/[key]/fix-ci', { key }), {});
  // A refused press is the card's one toast in the app's one stack, as on the overview.
  function refused(said: string | null): void {
    const card = { key: page.params.key ?? '', href: resolve('/t/[key]', { key }) };
    toastStack.state = said === null ? dismissed(toastStack.state, card.key) : refusedDrop(toastStack.state, card, refusalFromServer(said));
  }

  // A browser may block a page opened after the push answered, because the click was a while ago. The
  // "Create pull request" step of the panel opens it then.
  const openPr = (url: string) => void window.open(url, '_blank', 'noopener,noreferrer');

  // A direct git action, so it shows its own pending state and not the board's.
  let removing = $state(false);
  let removed = $state<string | null>(null);
  async function removeCheckouts(): Promise<void> {
    removing = true;
    try {
      const answer = await fetch(resolve('/api/card/[key]/checkouts', { key }), { method: 'POST' });
      const said = (await answer.json()) as { ok: boolean; said?: string; reason?: string };
      removed = said.said ?? said.reason ?? 'The checkouts were not removed, and no reason came back.';
    } catch {
      removed = 'The checkouts could not be removed. The local app is not answering.';
    } finally {
      removing = false;
    }
  }

  // The pull request state of a closed card. The Overview asks once it has drawn, and the app reads it
  // through gh, so the page load never waits on GitHub. The head's Changes tag shares the read.
  const readPulls = () => readCardPulls(resolve('/api/card/[key]/pr', { key }));

  // Revert on a closed card's knowledge change: a revert commit, no run. The page reads the card again
  // after it, so the change then reads reverted.
  async function revert(change: number): Promise<{ ok: boolean; message: string }> {
    try {
      const answer = await fetch(resolve('/api/card/[key]/knowledge', { key }), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ change }),
      });
      const said = (await answer.json()) as { ok: boolean; message: string };
      if (said.ok) await invalidateAll();
      return said;
    } catch {
      return { ok: false, message: 'The revert could not be sent. The local app is not answering.' };
    }
  }

  // One file's patch, asked for when the person opens it.
  async function open(repo: string, ask: { path: string; oldPath: string | null; group: 'committed' | 'uncommitted' | 'branch' | 'commit'; commit?: string }) {
    const query = new URLSearchParams({ path: ask.path, group: ask.group, ...at(repo) });
    if (ask.oldPath !== null) query.set('old', ask.oldPath);
    if (ask.commit !== undefined) query.set('commit', ask.commit);
    try {
      const answer = await fetch(`${resolve('/api/card/[key]/patch', { key })}?${query}`);
      return (await answer.json()) as { ok: true; text: string } | { ok: false; reason: string };
    } catch {
      return { ok: false as const, reason: 'The patch could not be fetched. The local app is not answering.' };
    }
  }

  // The files of one commit the Not committed view lists, when the person opens it.
  async function commitDiff(repo: string, commit: string) {
    try {
      const answer = await fetch(`${resolve('/api/card/[key]/commit-diff', { key })}?${new URLSearchParams({ commit, ...at(repo) })}`);
      return (await answer.json()) as { ok: true; diff: ChangeGroup } | { ok: false; reason: string };
    } catch {
      return { ok: false as const, reason: 'The commit could not be read. The local app is not answering.' };
    }
  }

  // The Changes view the address names, or the stage's default: Whole card in Review while no repository
  // holds a commit of the card's, Not committed everywhere else.
  const viewOf = (groups: readonly { changes: Changes }[]): ChangesView =>
    changesView(
      page.url.searchParams.get('view'),
      data.ticket.stage,
      groups.some((one) => one.changes.ok && (one.changes.committed?.stat.files ?? 0) > 0),
    );
  // The pick goes in the address, so a reload and a link keep it. The page reads the card again, because
  // only Not committed reads the commit list.
  async function pickView(view: ChangesView): Promise<void> {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() makes the address, the view is its query
    await goto(`${resolve('/t/[key]/[tab]', { key, tab: 'changes' })}?view=${view}`, { keepFocus: true, noScroll: true });
  }
</script>

{#if data.overview !== null}
  <!-- The left column of the overview. The trail and the facts are the layout's right column. Keyed, so
       a draft typed on one card never follows the page to another card. -->
  {#key page.params.key}
  <Overview
    summary={data.overview.summary}
    summaryFrom={data.overview.summaryFrom}
    summaryAt={data.overview.summaryAt}
    now={data.now}
    summaryPhase={data.overview.summaryPhase}
    built={data.overview.built}
    ticketSource={data.overview.ticketSource}
    refinedAt={data.overview.refinedAt}
    docs={data.overview.docs}
    solution={data.overview.solution}
    docHref={filesAt}
    plan={data.overview.plan}
    research={data.overview.research === undefined
      ? null
      : {
          research: data.overview.research,
          fileHref: filesAt(data.overview.research.file),
          // The file sits in the folder of the phase that wrote it, and that phase names its thread.
          followHref: `${resolve('/t/[key]/[tab]', { key, tab: 'discussion' })}?thread=${data.overview.research.file.split('/')[0]}`,
          ondeliver: deliver,
        }}
    seed={data.overview.seed ?? null}
    sharePlan={data.overview.sharePlan ?? null}
    linkSystem={data.overview.linkSystem ?? null}
    planHref={filesAt('plan/plan.md')}
    planOpen={data.overview.planOpen}
    merge={data.merge}
    fixCi={shownCard === null || delivery === null ? null : { card: shownCard, stages: delivery.stages, usage: { limits: nowLive.state.limits, now: Date.now() }, onfix: fixCiRun, onrefuse: refused }}
    closed={knowledge === null ? null : { knowledge, knowledgeHref: resolve('/knowledge'), onpulls: data.pulls ? readPulls : null, onrevert: revert, diffsWaiting: patches.current === null }}
    changesHref={data.hasChanges ? resolve('/t/[key]/[tab]', { key, tab: 'changes' }) : null}
    ticket={data.overview.ticket}
    extra={data.overview.extra}
    related={data.overview.related}
    tasks={data.overview.tasks}
    {delivery}
    nextKey={data.overview.nextKey ?? null}
    blocked={data.overview.blocked === null ? null : { ...data.overview.blocked, since: nowLive.state.snapshot?.waiting[page.params.key ?? '']?.since ?? null }}
    laterHref={resolve('/b/[board]', { board: data.board })}
    qa={qa === null
      ? null
      : {
          view: qa,
          fileHref: (path: string) => fileUrl(path),
          shotHref: filesAt,
          logHref: qa.verdict.runId === null ? null : `${resolve('/t/[key]/[tab]', { key, tab: 'log' })}?run=${qa.verdict.runId}`,
          onstack: stackAction,
          // The QA run's line beside the verdict, off the trail the overview read.
          failed: data.qaFailed ? { run: data.overview.strip.find((segment) => segment.phase === 'qa')?.run ?? null } : null,
          inQa: data.qaStage,
        }}
    logBase={resolve('/t/[key]/[tab]', { key, tab: 'log' })}
    readOnlyBreak={data.overview.readOnlyBreak ?? null}
    commitWarning={data.overview.commitWarning ?? null}
    gate={data.overview.gate ?? null}
    gateNext={gateNext?.label ?? null}
    onchoose={choose}
    ongatestart={gateStart}
    onsave={saveContext}
    onanswer={sendAnswer}
    onunlink={unlink}
    onaddtasks={addTasks}
    onreadticket={readTicket}
    oncopy={copyTask}
  >
    <!-- The Overview's last line on a closed card. A direct git action, so it holds its own button and
         starts no run. -->
    {#snippet checkouts()}
      {#if data.closed}
        <section class="checkouts" aria-labelledby="checkouts-title">
          <h2 id="checkouts-title">Checkouts</h2>
          <p class="placeholder" role="status">{removing ? 'Removing the checkouts.' : (removed ?? '')}</p>
          <span class="end"><Button onclick={removeCheckouts} disabled={removing} aria-busy={removing ? 'true' : undefined}>Remove its checkouts</Button></span>
        </section>
      {/if}
    {/snippet}
  </Overview>
  {/key}
{:else if data.files !== null}
  {#key page.params.key}
    <FilesTab groups={data.files} folder={data.filesFolder} {fileUrl} onread={readFile} start={page.url.searchParams.get('file')} oncopy={copyFile} />
  {/key}
{:else if data.groups !== null}
  <!-- Streamed, because git answers after the page drew. Keyed, so a typed message or a commit note
       never follows the page to another card. -->
  <Streamed promise={data.groups} scope={page.params.key} waiting="Reading the changes with git." height="240px" shape="rows" count={4}>
    {#snippet children(groups)}
      {#key page.params.key}
        <ChangeGroups {groups} view={viewOf(groups)} onview={pickView} oncommitdiff={commitDiff} card={page.params.key ?? null} onopen={open} oncommit={commit} onwrite={writeMessage} onpush={push} onpull={pull} oncopy={copyOutput} onopenpr={openPr} comments={data.comments ?? []} oncomment={comment} onedit={editComment} ondelete={deleteComment}>
          {#snippet next()}
            {#if shownCard !== null}
              <SendBackPanel card={shownCard} {sendBack} open={unsent} session={data.implementSession} usage={{ limits: nowLive.state.limits, now: Date.now() }} onsend={sendBackRun} onrefuse={refused} />
            {/if}
          {/snippet}
        </ChangeGroups>
      {/key}
    {/snippet}
  </Streamed>
{:else if data.discussion !== null}
  <!-- Keyed on the thread, so a draft or a copy note never follows the page to another thread. -->
  {#key `${page.params.key} ${data.discussion.current}`}
    <DiscussionTab
      threads={data.discussion.threads}
      later={data.discussion.later}
      order={data.discussion.order}
      current={data.discussion.current}
      {messages}
      models={data.discussion.models}
      phaseModel={data.discussion.phaseModel}
      phaseEffort={data.discussion.phaseEffort}
      estimates={data.discussion.estimates}
      resume={data.discussion.resume}
      next={data.discussion.next}
      asking={data.discussion.asking}
      toolsWaiting={tools.current === null}
      onsend={sendMessage}
      oncopy={copyCommand}
      onrename={renameThread}
    />
  {/key}
{:else if data.log !== null}
  <LogTab
    runs={data.log.runs}
    selected={data.log.selected}
    {events}
    {runHref}
    rawHref={`${resolve('/api/card/[key]/log/raw', { key })}?run=${data.log.selected}`}
    card={logCard}
    onstop={stopRun}
    onrefuse={refused}
  />
{:else if data.review !== null}
  <ReviewTab
    rounds={data.review.rounds}
    current={data.review.current}
    blocks={data.review.blocks}
    problem={data.review.problem}
    read={data.review.read}
    reviewer={data.review.reviewer}
    head={data.review.head}
    filesHref={resolve('/t/[key]/[tab]', { key, tab: 'files' })}
    oncopy={copyBlock}
  />
{:else if data.settings !== null}
  <SettingsTab
    settings={data.settings}
    onpick={(action, choice) => models({ action, ...choice })}
    onreset={(action) => models({ action, reset: true })}
    onpreset={(preset) => models({ preset })}
    modelsHref={resolve('/settings/[section]', { section: 'models' })}
    repos={data.repos}
    onrepos={pickRepos}
    chain={data.chain}
    onchain={tickChain}
  />
{:else if data.prs !== null}
  {#key page.params.key}
    <PrsTab
      pulls={data.prs}
      discussions={data.prDiscussions ?? []}
      now={data.now}
      onread={readComments}
      onmark={markComment}
      onopen={seenComments}
      onattach={pullLink('POST')}
      ondetach={pullLink('DELETE')}
      card={shownCard}
      triage={data.prTriage}
      ontriage={runTriage}
      oncopy={copyReply}
      onfix={fixComment}
      onfixall={fixAllComments}
      qaFixes={data.prQaFixes}
      onqa={qaFixes}
      ondiscuss={discussComment}
      changesHref={resolve('/t/[key]/[tab]', { key, tab: 'changes' })}
    />
  {/key}
{:else}
  <!-- A tab the route knows and this page draws nothing for. The shell and the URL stay, so the
       address still works. -->
  <p class="placeholder">The {data.current} tab is not built yet.</p>
{/if}

<style>
  /* One line, as the closed card draws it: the title, what the last press said, the button at the end. */
  .checkouts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  .end {
    margin-left: auto;
  }

  .checkouts h2 {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .placeholder {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--muted);
  }
</style>
