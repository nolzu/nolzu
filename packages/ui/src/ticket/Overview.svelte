<script lang="ts">
  import Markdown from '../Markdown.svelte';
  import { type BoardSnapshot, phaseLabel, type Segment, type Spend, spendOf, type StripRun } from '@nolzu/protocol';
  import { type ComponentProps, type Snippet, tick, untrack } from 'svelte';
  import Banner from '../Banner.svelte';
  import Button from '../Button.svelte';
  import Chip from '../Chip.svelte';
  import StatePill from '../StatePill.svelte';
  import AnswerComposer from './AnswerComposer.svelte';
  import Block from './Block.svelte';
  import ClosedCard from './ClosedCard.svelte';
  import MergeBlock from './MergeBlock.svelte';
  import { type MergePull, mergeShown } from './merge.ts';
  import GateBlock from './GateBlock.svelte';
  import Ago from './Ago.svelte';
  import { epicProgress, epicTaskRows, landLine, type TaskRow } from './epic.ts';
  import PhaseStrip from './PhaseStrip.svelte';
  import { type EpicSeed, parsePlan, shareTasks, stepBodies } from './plan.ts';
  import QaPanels from './QaPanels.svelte';
  import ResearchAnswer from './ResearchAnswer.svelte';
  import TaskDetail from './TaskDetail.svelte';
  import type { QaView, StackAction } from './qa.ts';

  // The page does the writes, because this package never fetches. Each answers with the sentence it
  // was refused with, or null when it took the write.
  let {
    summary,
    summaryFrom = null,
    summaryAt = null,
    now = null,
    summaryPhase = null,
    built = null,
    ticketSource = null,
    refinedAt = null,
    docs = null,
    solution = null,
    docHref = null,
    plan = null,
    research = null,
    planHref = null,
    planOpen = false,
    seed = null,
    sharePlan = null,
    linkSystem = null,
    closed = null,
    merge = [],
    fixCi = null,
    checkouts,
    changesHref,
    ticket,
    extra,
    related,
    tasks = null,
    delivery = null,
    nextKey = null,
    blocked = null,
    laterHref = null,
    strip = [],
    spend = spendOf([]),
    qa = null,
    logBase = '',
    readOnlyBreak = null,
    commitWarning = null,
    gate = null,
    gateNext = null,
    onchoose = async () => null,
    ongatestart = () => {},
    onsave = async () => null,
    onunlink = async () => null,
    onanswer = async () => null,
    onaddtasks = async () => null,
    onreadticket = async () => 'Nolzu cannot read tickets here.',
    oncopy = async () => null,
  }: {
    summary: string | null;
    // Which phase wrote the summary, as the line under the lede says it, and when its run ended.
    summaryFrom?: string | null;
    summaryAt?: string | null;
    // The time the server drew the page with. Every "5 minutes ago" starts from it, so the first paint
    // says what the server said, and the clock takes over after.
    now?: string | null;
    // The phase that wrote the summary. A card ready after Plan links the plan as written, not the diff.
    summaryPhase?: string | null;
    // The newest summary of a run other than QA. A QA FAIL shows it last, because the QA run's own
    // summary only says the verdict again. Left out, the view falls back to the newest summary.
    built?: { summary: string; phase: string; at?: string | null } | null;
    // The ticket's meta beside its heading: the source word and when the newest Refine run ended.
    ticketSource?: string | null;
    refinedAt?: string | null;
    // An epic's documents, each opening the Files tab at `docHref`, and the excerpt of its
    // `architecture.md`. Null on a card of another board.
    docs?: readonly { label: string; path: string; screens: number | null }[] | null;
    solution?: string | null;
    docHref?: ((path: string) => string) | null;
    // The text of `plan/plan.md` on a card past Plan, drawn as steps with their files, and the address
    // that opens the file as written.
    plan?: string | null;
    planHref?: string | null;
    // The card sits in Plan or Implement, where the plan is what the agent works from, so it starts open.
    // It starts folded on every other stage.
    planOpen?: boolean;
    // On an epic, the criteria and decisions each task's ticket copies by the ids its step names.
    seed?: EpicSeed | null;
    // On an epic, the plan for colleagues (`share/PLAN.md`), whose task by step number is the shareable
    // description of that row, and the name of the project's ticket system a row links to, or null.
    sharePlan?: string | null;
    linkSystem?: string | null;
    // What a closed card shows under its summary, and null on an open card. `checkouts` is the page's
    // own section, the column's last line.
    closed?: Omit<ComponentProps<typeof ClosedCard>, 'checkouts'> | null;
    // The open pull requests of a Delivery card from Review to Wrap-up with why each cannot merge, as the
    // last read stored them. Empty on every other card.
    merge?: readonly MergePull[];
    // Fix CI beside the failed checks, as `MergeBlock` takes it. Null draws no button.
    fixCi?: ComponentProps<typeof MergeBlock>['fixCi'];
    checkouts?: Snippet;
    // Null on a board with no Changes tab, where the link would lead to a page that is not there.
    changesHref: string | null;
    ticket: string | null;
    extra: string | null;
    related: readonly { key: string; title: string }[];
    // The tasks of an epic, and null on a card of another board, which delivers none.
    tasks?: readonly { key: string; title: string; done: boolean; step?: string }[] | null;
    // The live Delivery board an epic's tasks read their state from, and the key its next task gets.
    delivery?: Pick<BoardSnapshot, 'stages' | 'cards'> | null;
    nextKey?: string | null;
    // The question of a blocked card and the session an answer continues, or null. The options are
    // the answers the run offered; a run that offered none leaves them out and reads as plain text.
    // The phase that asked and what it ran on name the chip and the resume line.
    blocked?: {
      runId: number;
      question: string;
      sessionId: string | null;
      options?: readonly { label: string; means?: string | null }[];
      phase?: string;
      engine?: string;
      model?: string | null;
      effort?: string | null;
      // When the card started to wait, off the Now snapshot, for "asked 15:02 · waiting 12m".
      since?: string | null;
    } | null;
    // Where Answer later goes: the card's board, where it keeps waiting.
    laterHref?: string | null;
    // One segment per phase, and the log tab's path its links add a run to.
    strip?: readonly Segment[];
    // Every run of the card, rolled up. Not the segments added together: a run whose phase is no stage
    // of this board is in no segment, and the total would drop its cost and still read as complete.
    spend?: Spend;
    // The two QA panels, with the addresses the page built for them. Null on a board that has no
    // QA phase, and on a card whose tab is not the overview. `failed` is set while the card waits in QA
    // on a FAIL: the panels then open the column, with the QA run.
    qa?: {
      view: QaView;
      fileHref: (path: string) => string;
      // The Files tab with one file open, where a screenshot thumbnail goes.
      shotHref?: (path: string) => string;
      logHref: string | null;
      onstack: (action: StackAction) => Promise<string>;
      failed?: { run: StripRun | null } | null;
      // The card sits in a QA stage, where the App line belongs even while the app is down.
      inQa?: boolean;
    } | null;
    logBase?: string;
    // The newest run that changed files while it should have read only, with its phase and engine in
    // words. `restored` is a checkout Nolzu made for the card, which it put back. Null when no run did.
    readOnlyBreak?: { phase: string; engine: string; walled?: boolean; restored: boolean; diff: string; undone: readonly string[]; left: readonly string[] } | null;
    // What the newest Implement run committed or pushed, each repository with both short shas. Null
    // when it moved nothing, and once the next Implement run starts.
    commitWarning?: string | null;
    // The review block of the phase that ran last, its questions that block the next move, and the
    // output check of that run. Null on a closed card, while a run goes, and on a card that never ran.
    // The file opens on the Files tab through `docHref`.
    gate?: ComponentProps<typeof GateBlock>['gate'] | null;
    onchoose?: (id: string, answer?: string) => Promise<string | null>;
    // The column the next move starts, such as Plan, while the card can move there. The gate offers that
    // move once every question is settled, and `ongatestart` makes it as Next step's button does.
    gateNext?: string | null;
    ongatestart?: () => void;
    onsave?: (text: string) => Promise<string | null>;
    onunlink?: (key: string) => Promise<string | null>;
    onanswer?: (text: string) => Promise<string | null>;
    // The keys go with the plan's tasks, one per title, with each task's shareable description, the plan
    // step it was made from ('' for a row the person added), the ticket key it is linked to ('' for a
    // local task) and its internal notes. A list the person wrote sends titles alone. It answers with
    // the refusal, null when it took, or the note of an add that took with something missing.
    onaddtasks?: (titles: string[], keys?: string[], descriptions?: string[], steps?: string[], refs?: string[], notes?: string[]) => Promise<string | null | { note: string }>;
    // Link on a task row: the ticket a key or a link names, or the sentence it was refused with.
    // `ref` is what the system knows the ticket by when that is not its key, such as a GitHub issue's
    // owner/repo#12, so Add reads the same one again.
    onreadticket?: (ref: string) => Promise<{ key: string; title: string; ref?: string } | string>;
    // Copy for the ticket system: null when it took, else the sentence that says it did not.
    oncopy?: (text: string) => Promise<string | null>;
    // The answer or the report of a Research card, with its links and its one write. Null on every other card.
    research?: ComponentProps<typeof ResearchAnswer> | null;
  } = $props();

  const steps = $derived(plan === null ? null : parsePlan(plan));
  const mergePulls = $derived(mergeShown(merge));
  // A QA FAIL opens the column with the red box, and its change follows under What happened.
  const failedView = $derived(qa != null && qa.failed != null);
  const change = $derived(built ?? (summary === null ? null : { summary, phase: summaryPhase, at: summaryAt }));
  // Ready after Plan, the lede's link reads the plan. After Implement it is the diff again.
  const planLink = $derived(summaryPhase === 'plan' && plan !== null && planHref !== null);
  // The App line on a card in QA or with an app that is not down, never on a closed card. The
  // verdict on any card QA ran on: a closed card keeps it folded as part of the record.
  const showStack = $derived(qa != null && closed === null && (qa.inQa === true || qa.view.stack.state !== 'off'));
  const showVerdict = $derived(qa != null && qa.view.verdict.runId !== null);
  // On an epic each step of the plan is a task, so the steps show as the task table and not as a plan.
  const planned = $derived(tasks === null ? null : (steps?.steps?.map((step) => step.text) ?? null));
  // Each step's body, the description its task gets, by the step's place in the plan, with what the
  // step names of the epic's criteria and decisions copied under it.
  const bodies = $derived(planned === null || plan === null ? [] : (stepBodies(plan, seed ?? undefined) ?? []));
  // The plain task for colleagues by step number, which gives a row its title and its description.
  const shared = $derived(shareTasks(sharePlan ?? ''));

  // The one line a folded block shows. A name in backticks loses them, as plain words read better there.
  const plain = (text: string) => text.replaceAll('`', '');
  // The ticket's first paragraph as one line. Its source wraps at about 100 characters, and the first
  // line alone stops mid sentence with no ellipsis, as the cut never reached it.
  const ticketPeek = $derived.by(() => {
    const lines = (ticket ?? '').split('\n').map((line) => line.trim());
    const prose = (line: string) => line !== '' && !line.startsWith('#');
    const start = lines.findIndex(prose);
    if (start === -1) return null;
    const end = lines.findIndex((line, at) => at > start && !prose(line));
    return lines.slice(start, end === -1 ? undefined : end).map((line) => line.replace(/^[>*\-\s]+/, '')).join(' ');
  });
  const planPeek = $derived(steps === null ? null : steps.steps === null ? plain(steps.text.split('\n').find((line) => line.trim() !== '') ?? '') : steps.steps.map((step) => plain(step.text)));
  // The ticket starts folded. Add context opens it with the field.
  let ticketOpen = $state(false);

  // The field starts from what is stored and is the person's own from then on.
  // svelte-ignore state_referenced_locally
  let draft = $state(extra ?? '');
  // Extra context is open when it holds text, and behind one button when it is empty.
  // svelte-ignore state_referenced_locally
  let writing = $state((extra ?? '') !== '');
  let field = $state<HTMLTextAreaElement | null>(null);
  async function addContext(): Promise<void> {
    writing = true;
    ticketOpen = true;
    await tick();
    field?.focus();
  }
  let status = $state('');
  let saving = $state(false);

  async function save(): Promise<void> {
    if (saving) return;
    saving = true;
    status = '';
    const refused = await onsave(draft);
    saving = false;
    status = refused ?? 'Saved. The next run reads it.';
  }

  // The clock of a running task's time, every second, and of the times ago, every half minute.
  let clock = $state(untrack(() => (now === null ? new Date() : new Date(now))));
  const rows = $derived(tasks === null ? [] : epicTaskRows({ planned: planned ?? [], linked: tasks, delivery, nextKey, now: clock }));
  const ticking = $derived(rows.some((row) => row.added && row.pill.state === 'running'));
  const progress = $derived(rows.length === 0 ? null : epicProgress(rows));
  $effect(() => {
    clock = new Date();
    const timer = setInterval(() => (clock = new Date()), ticking ? 1000 : 30_000);
    return () => clearInterval(timer);
  });
  // What the person changed in a task not added yet, by row id: `p<n>` for the plan's step n, `x<n>` for
  // a row they added. Page state until Add, so nothing is saved on the way, and a reload starts again
  // from the plan. A bigger change goes through the epic's Discussion with Plan, which rewrites the plan.
  type Linked = { key: string; title: string; ref?: string };
  let drafts = $state<Record<string, { key?: string; title?: string; description?: string; notes?: string; ref?: Linked | null }>>({});
  let dropped = $state<string[]>([]);
  let blanks = $state<string[]>([]);
  let opened = $state<string[]>([]);
  let made = 0;
  // A plan that Plan rewrote can hold other steps at those places, and a change kept by place would
  // land on the wrong step or hide it. So a new list of steps drops them, and the rows the person
  // added stay.
  const stepList = $derived((planned ?? []).join('\n'));
  let draftedFor: string | null = null;
  $effect(() => {
    const now = stepList;
    if (draftedFor !== null && now !== draftedFor) {
      drafts = Object.fromEntries(Object.entries(untrack(() => drafts)).filter(([id]) => id.startsWith('x')));
      dropped = [];
      opened = untrack(() => opened).filter((id) => id.startsWith('x'));
    }
    draftedFor = now;
  });
  type Fresh = { id: string; step: string; key: string; title: string; description: string; notes: string; ref: Linked | null };
  const draftOf = (id: string, step: string, key: string, title = step, description = '', notes = ''): Fresh => ({
    id,
    step,
    key: drafts[id]?.key ?? key,
    title: drafts[id]?.title ?? title,
    description: drafts[id]?.description ?? description,
    notes: drafts[id]?.notes ?? notes,
    ref: drafts[id]?.ref ?? null,
  });
  // The table in order: the plan's rows, added or not, then the rows the person added.
  type Entry = { row: Extract<TaskRow, { added: true }>; fresh: null } | { row: null; fresh: Fresh };
  const table = $derived<Entry[]>([
    ...rows.flatMap((row, at): Entry[] =>
      row.added
        ? [{ row, fresh: null }]
        : dropped.includes(`p${at}`)
          ? []
          : [{ row: null, fresh: draftOf(`p${at}`, row.title, row.key, shared.get(at + 1)?.title ?? row.title, shared.get(at + 1)?.description ?? '', bodies[at] ?? '') }],
    ),
    ...blanks.map((id): Entry => ({ row: null, fresh: draftOf(id, '', '') })),
  ]);
  const fresh = $derived(table.flatMap((one) => (one.fresh === null || one.fresh.title.trim() === '' ? [] : [one.fresh])));
  const edit = (id: string, field: 'key' | 'title' | 'description' | 'notes', value: string) => (drafts[id] = { ...drafts[id], [field]: value });
  // A ticket is read at once, so a row never holds a key that does not resolve, and one ticket is one task.
  async function link(id: string, ref: string, still: () => boolean = () => true): Promise<string | null> {
    // A plan rewritten while the read went puts other steps at these places, so the answer is dropped.
    const steps = stepList;
    const found = await onreadticket(ref);
    // The rewrite closed the row too, so there is no line to say it on.
    if (!still() || stepList !== steps) return null;
    if (typeof found === 'string') return found;
    if (table.some((one) => one.fresh !== null && one.fresh.id !== id && one.fresh.ref?.key === found.key)) return `${found.key} is linked on another task. Unlink it there first.`;
    drafts[id] = { ...drafts[id], ref: found };
    return null;
  }
  const toggle = (id: string) => (opened = opened.includes(id) ? opened.filter((one) => one !== id) : [...opened, id]);
  async function drop(id: string): Promise<void> {
    if (id.startsWith('x')) blanks = blanks.filter((one) => one !== id);
    else dropped = [...dropped, id];
    opened = opened.filter((one) => one !== id);
    // The pressed button is gone with its row, and focus would fall back to the top of the page.
    await tick();
    document.querySelector<HTMLElement>('[data-add-row]')?.focus();
  }
  async function blank(): Promise<void> {
    const id = `x${(made += 1)}`;
    blanks = [...blanks, id];
    await tick();
    document.getElementById(`task-title-${id}`)?.focus();
  }

  // One task per line. An empty line is not a task, so it is not counted and not sent.
  let typed = $state('');
  const wanted = $derived(typed.split('\n').map((line) => line.trim()).filter((line) => line !== ''));
  let adding = $state(false);
  let taskStatus = $state('');

  async function send(titles: string[], ...more: string[][]): Promise<boolean> {
    if (adding || titles.length === 0) return false;
    adding = true;
    const answer = await onaddtasks(titles, ...more);
    adding = false;
    const done = `${titles.length === 1 ? 'One task is' : `${titles.length} tasks are`} on the Delivery board.`;
    taskStatus = typeof answer === 'string' ? answer : answer === null ? done : `${done} ${answer.note}`;
    return typeof answer !== 'string';
  }
  async function addTasks(): Promise<void> {
    if (await send(wanted)) typed = '';
  }
  async function addPlanned(): Promise<void> {
    const sent = fresh.map((task) => ({ ...task, key: task.key.trim(), title: task.title.trim() }));
    const ok = await send(
      sent.map((task) => task.title),
      sent.map((task) => task.key),
      sent.map((task) => task.description),
      sent.map((task) => task.step),
      sent.map((task) => task.ref?.ref ?? task.ref?.key ?? ''),
      sent.map((task) => task.notes),
    );
    if (!ok) return;
    // The added rows read their link from the server now. A removed step stays removed until a reload.
    drafts = {};
    blanks = [];
    opened = [];
  }

  // One request per chip. A second click while the first runs would answer that there is no link.
  let removing = $state<string | null>(null);
  let linkStatus = $state('');
  async function remove(key: string): Promise<void> {
    if (removing !== null) return;
    removing = key;
    linkStatus = (await onunlink(key)) ?? `The link to ${key} is removed.`;
    removing = null;
  }

  // Zones of the column: what needs the person, what happened, then what to
  // read when they want it. A zone with nothing in it is not drawn. On an open epic the progress and
  // the tasks are what needs the person.
  const epicNeeds = $derived(tasks !== null && closed === null);
  // A QA FAIL leads with its own panels, so its gate is drawn only for what the output check found,
  // which the board card's Check chip links to.
  const showGate = $derived(gate != null && closed === null && (!failedView || (gate.check?.problems.length ?? 0) > 0));
  const needs = $derived(blocked !== null || failedView || readOnlyBreak !== null || commitWarning !== null || showGate || epicNeeds);
</script>

{#snippet fileIcon()}
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5"></path></svg>
{/snippet}
{#snippet screenIcon()}
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18M9 9v11"></path></svg>
{/snippet}

<!-- The left column of the card page, in three zones: what needs you, what
     happened, then what to read when you want it. Only the block that needs an answer gets a box, and
     reference blocks fold to one line. -->
<div class="overview">
  {#snippet epicParts()}
    {#if tasks !== null && progress !== null}
      <Block id="progress" title="Progress">
        <p class="sum"><span class="mono">{progress.done}</span> of <span class="mono">{progress.total}</span> done</p>
        <div class="bar" role="img" aria-label={progress.legend.map((one) => one.text).join(', ')}>
          {#each progress.bar as tone, at (at)}<i data-tone={tone}></i>{/each}
        </div>
        <ul class="legend">
          {#each progress.legend as one (one.text)}<li><i data-tone={one.tone} aria-hidden="true"></i>{one.text}</li>{/each}
        </ul>
        <p class="quiet foot">{progress.foot}</p>
      </Block>
    {/if}

    {#if tasks !== null}
      <Block id="tasks" title="Tasks">
        {#snippet meta()}{[table.length > 0 ? String(table.length) : null, planned !== null ? 'from plan.md' : null].filter((one) => one !== null).join(' · ')}{/snippet}
        {#if rows.length === 0 && planned === null && steps !== null}
          <p class="quiet">No tasks yet. Write one per line and add them.</p>
        {:else if rows.length > 0}
          <table>
            <thead>
              <tr><th scope="col" class="key">Key</th><th scope="col">Title</th><th scope="col" class="state">On Delivery</th></tr>
            </thead>
            <tbody>
              {#each table as one (one.row !== null ? one.row.key : one.fresh.id)}
                {#if one.row !== null}
                  <tr data-task={one.row.key}>
                    <td><a class="link" href="/t/{encodeURIComponent(one.row.key)}">{one.row.key}</a></td>
                    <td class="what">{one.row.title}</td>
                    <td><StatePill state={one.row.pill.state} word={one.row.pill.word} detail={one.row.pill.detail} /></td>
                  </tr>
                {:else if one.fresh !== null}
                  {@const task = one.fresh}
                  {@const name = task.title.trim() === '' ? 'the new task' : task.title}
                  {@const open = opened.includes(task.id)}
                  <!-- Editable until the task is added, because the card takes it for good then. -->
                  <tr data-task-new={task.id}>
                    <td>
                      {#if task.ref !== null}
                        <!-- A linked task is the ticket's card, so it takes the ticket's key. -->
                        <span class="refkey" data-task-ref-key>{task.ref.key}</span>
                      {:else}
                        <label class="hidden" for="task-key-{task.id}">Key for {name}</label>
                        <input id="task-key-{task.id}" class="keyfield" data-task-key value={task.key} placeholder={task.step === '' ? 'next key' : undefined} oninput={(event) => edit(task.id, 'key', event.currentTarget.value)} />
                      {/if}
                    </td>
                    <td class="what">
                      <div class="titled">
                        <button type="button" class="expand" data-task-expand aria-expanded={open} aria-controls="task-more-{task.id}" onclick={() => toggle(task.id)}>
                          <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>
                          <span class="hidden">Description of {name}</span>
                        </button>
                        <label class="hidden" for="task-title-{task.id}">Title of {name}</label>
                        <input id="task-title-{task.id}" class="titlefield" data-task-title value={task.title} oninput={(event) => edit(task.id, 'title', event.currentTarget.value)} />
                      </div>
                    </td>
                    <td>
                      <div class="titled">
                        <span class="quiet">not added yet</span>
                        <button type="button" data-task-remove aria-label="Remove {name}" onclick={() => drop(task.id)}>Remove</button>
                      </div>
                    </td>
                  </tr>
                  {#if open}
                    <tr class="more" id="task-more-{task.id}">
                      <td colspan="3">
                        <TaskDetail
                          id={task.id}
                          title={name}
                          description={task.description}
                          notes={task.notes}
                          linked={task.ref}
                          system={linkSystem}
                          onedit={(field, text) => edit(task.id, field, text)}
                          onlink={(ref, still) => link(task.id, ref, still)}
                          onunlink={() => (drafts[task.id] = { ...drafts[task.id], ref: null })}
                          {oncopy}
                        />
                      </td>
                    </tr>
                  {/if}
                {/if}
              {/each}
            </tbody>
          </table>
        {/if}

        {#if closed !== null}
          <!-- A closed epic takes no more tasks, and its plan is not read then, so neither line fits. -->
        {:else if steps === null}
          <!-- Before Plan ran there is nothing to read the tasks from, so the box waits for it. After Plan,
               a plan with no steps in that form keeps the typed list. -->
          <p class="quiet" data-tasks-wait>Plan splits the epic into tasks. Each one you add becomes a card on Delivery.</p>
        {:else if planned === null}
          <label class="label" for="new-tasks">New tasks, one per line</label>
          <textarea id="new-tasks" bind:value={typed} placeholder="Read the plan and write one task per line"></textarea>
          <div class="row">
            <button type="button" data-add-tasks disabled={wanted.length === 0} aria-busy={adding} onclick={addTasks}>
              {wanted.length === 0 ? 'Add tasks to Delivery' : wanted.length === 1 ? 'Add 1 task to Delivery' : `Add ${wanted.length} tasks to Delivery`}
            </button>
            <p class="quiet" role="status" data-tasks-status>{taskStatus}</p>
          </div>
        {:else}
          <!-- Cream, the main safe action, and not amber: the tasks land in Inbox and no agent starts. -->
          <div class="row add">
            <Button data-add-row onclick={blank}>Add a task</Button>
            {#if fresh.length > 0}
              <Button variant="primary" data-add-planned disabled={adding} aria-busy={adding} onclick={addPlanned}>{fresh.length === 1 ? 'Add 1 task to Delivery' : `Add ${fresh.length} tasks to Delivery`}</Button>
              <span class="quiet" data-tasks-land>{landLine(fresh.map((task) => task.ref?.key ?? null), linkSystem)}</span>
            {/if}
            <p class="quiet" role="status" data-tasks-status>{taskStatus}</p>
          </div>
        {/if}
      </Block>
    {/if}
  {/snippet}

  {#if needs}
    <div class="zone">
      <p class="zone-label">Needs you</p>
      <div class="stack">
        {#if blocked !== null}
          <!-- Keyed on the run that asked, so a busy composer from the last answer never holds a new question. -->
          {#key blocked.runId}
            <AnswerComposer
              question={blocked.question}
              sessionId={blocked.sessionId}
              options={blocked.options ?? []}
              phase={blocked.phase ?? null}
              engine={blocked.engine ?? null}
              model={blocked.model ?? null}
              effort={blocked.effort ?? null}
              since={blocked.since ?? null}
              {laterHref}
              {onanswer}
            />
          {/key}
        {/if}

        {#if qa != null && qa.failed != null}
          <QaPanels view={qa.view} fileHref={qa.fileHref} shotHref={qa.shotHref} logHref={qa.logHref} failed={qa.failed} box />
        {/if}

        {#if readOnlyBreak !== null}
          <!-- A warning is a neutral box. The wall should keep this from ever showing. -->
          <section class="broke" aria-label="A read-only run changed files">
            <Banner kind="warning">
              <p>
                {readOnlyBreak.restored
                  ? `The ${readOnlyBreak.phase} run on ${readOnlyBreak.engine} changed the card's checkout. A read-only run should change nothing, so Nolzu put it back.`
                  : readOnlyBreak.walled === true
                    ? `Files changed in your project folder while the ${readOnlyBreak.phase} run on ${readOnlyBreak.engine} went. The wall kept that run from writing there, so the change came from another program or from you. Nolzu left the files as they are, so check the diff.`
                    : `Files changed in your project folder while the ${readOnlyBreak.phase} run on ${readOnlyBreak.engine} went. A read-only run should change nothing. Nolzu left the files as they are, so check the diff.`}
              </p>
              {#if readOnlyBreak.undone.length > 0}
                <ul>
                  {#each readOnlyBreak.undone as line, at (at)}<li>{line}</li>{/each}
                </ul>
              {/if}
              {#if readOnlyBreak.left.length > 0}
                <p>Nolzu could not put back everything:</p>
                <ul>
                  {#each readOnlyBreak.left as line, at (at)}<li>{line}</li>{/each}
                </ul>
              {/if}
              <details>
                <summary>Show the diff</summary>
                <pre>{readOnlyBreak.diff}</pre>
              </details>
            </Banner>
          </section>
        {/if}

        {#if commitWarning !== null}
          <!-- Nothing was reset and the card moved on as it would: this only says what to look at. -->
          <section class="broke" aria-label="The implement run made a commit or pushed" data-commit-warning>
            <Banner kind="warning"><p>{commitWarning}</p></Banner>
          </section>
        {/if}

        {#if showGate && gate != null}
          <GateBlock {gate} fileHref={docHref} {onchoose} next={gateNext} onstart={ongatestart} />
        {/if}

        {#if epicNeeds}{@render epicParts()}{/if}
      </div>
    </div>
  {/if}

  <div class="zone">
    <p class="zone-label">What happened</p>
    <div class="stack lined">
      <!-- On a QA FAIL the change is the build's summary and names its phase, not the QA run's. Ready
           after Plan, the link reads the plan; after Implement it is the diff. -->
      <Block
        id="changed"
        title={failedView ? `What ${change?.phase == null ? 'the last run' : phaseLabel(change.phase)} changed, in plain words` : 'What changed, in plain words'}
        end={planLink ? { label: 'See the plan as written', href: planHref ?? '' } : changesHref !== null ? { label: 'See the diff', href: changesHref } : null}
      >
        {#snippet meta()}{#if failedView}{#if change?.at != null}<Ago at={change.at} now={clock} />{/if}{:else if summaryFrom !== null}{summaryFrom}{#if summaryAt !== null}, <Ago at={summaryAt} now={clock} />{/if}{/if}{/snippet}
        {#if (failedView ? change?.summary : summary) == null}
          <p class="quiet">No summary yet. It appears when a run finishes.</p>
        {:else}
          <div class="big"><Markdown source={(failedView ? change?.summary : summary) ?? ''} headingsFrom={3} /></div>
        {/if}
      </Block>

      {#if research !== null}<ResearchAnswer {...research} />{/if}

      <!-- The epic overview: what the epic's phases decided, and the documents they wrote. -->
      {#if solution !== null}
        <Block id="solution" title="Solution">
          {#snippet meta()}from architecture.md{/snippet}
          <p class="excerpt">{#each solution.split('`') as part, index (index)}{#if index % 2 === 1}<code>{part}</code>{:else}{part}{/if}{/each}</p>
        </Block>
      {/if}
      {#if docs !== null && docs.length > 0 && docHref !== null}
        <div class="docs" role="group" aria-label="Documents the epic wrote">
          {#each docs as doc (doc.path)}
            <a class="doc" href={docHref(doc.path)} data-doc={doc.path}>
              {#if doc.screens === null}{@render fileIcon()}{:else}{@render screenIcon()}{/if}<span class:mono={doc.screens === null}>{doc.label}</span>
              {#if doc.screens !== null}<span class="count">{doc.screens === 1 ? '1 screen' : `${doc.screens} screens`}</span>{/if}
            </a>
          {/each}
        </div>
      {/if}

      {#if mergePulls.length > 0}
        <MergeBlock pulls={mergePulls} now={clock} {fixCi} />
      {/if}

      {#if closed !== null}
        <ClosedCard {...closed} now={clock} />
      {/if}

      {#if tasks !== null && !epicNeeds}{@render epicParts()}{/if}
    </div>
  </div>

  <div class="zone">
    <p class="zone-label">Read more</p>
    <div class="stack lined">
      {#if qa != null && (failedView || showVerdict || showStack)}
        <QaPanels view={qa.view} fileHref={qa.fileHref} shotHref={qa.shotHref} logHref={qa.logHref} onstack={qa.onstack} failed={qa.failed ?? null} stack={showStack} verdict={showVerdict} />
      {/if}

      {#if steps !== null && planned === null}
        <!-- Open while the card is in Plan or Implement, which work from it, and folded after. -->
        <Block id="plan" title="The plan" end={planHref === null ? null : { label: 'Open plan.md', href: planHref }} fold open={planOpen} peek={planPeek} data-plan="">
          {#snippet meta()}{#if steps.steps !== null}{steps.steps.length === 1 ? '1 step' : `${steps.steps.length} steps`}{/if}{/snippet}
          {#if steps.steps !== null}
            <ol class="steps">
              {#each steps.steps as step, at (at)}
                <li>
                  <span class="no" aria-hidden="true">{at + 1}</span>
                  <div>
                    <!-- A name in backticks is code, as the plan wrote it. -->
                    <p>{#each step.text.split('`') as part, index (index)}{#if index % 2 === 1}<code>{part}</code>{:else}{part}{/if}{/each}</p>
                    {#if step.files.length > 0}
                      <div class="files">{#each step.files as file (file)}<Chip mono>{file}</Chip>{/each}</div>
                    {/if}
                    {#if step.covers !== undefined}
                      <!-- The acceptance checks of the brief the step serves. -->
                      <div class="files covers" data-covers><span class="quiet">Covers</span>{#each step.covers as id (id)}<Chip mono>{id}</Chip>{/each}</div>
                    {/if}
                  </div>
                </li>
              {/each}
            </ol>
          {:else}
            <!-- The plan left the skill's form, so it shows as written. -->
            <p class="plain">{steps.text}</p>
          {/if}
        </Block>
      {/if}

      <!-- The ticket folds on every card, and a closed card or a QA FAIL keeps it as part of the record.
           Extra context stays under it. -->
      <Block
        id="ticket"
        title="Ticket"
        end={closed === null && !writing ? { label: 'Add context', onclick: addContext, attrs: { 'data-add-context': '' } } : null}
        fold
        bind:open={ticketOpen}
        peek={ticketPeek}
      >
        {#snippet meta()}{#if ticketSource !== null}<span data-ticket-meta>{ticketSource}{#if refinedAt !== null}, refined <Ago at={refinedAt} now={clock} />{/if}</span>{/if}{/snippet}
        {#if ticket === null || ticket.trim() === ''}
          <p class="quiet">The ticket has no text.</p>
        {:else}
          <div id="ticket-text" class="text"><Markdown source={ticket} headingsFrom={3} /></div>
        {/if}

        {#if writing && closed === null}
          <label class="label" for="extra">Extra context</label>
          <textarea id="extra" bind:this={field} bind:value={draft} placeholder="What the ticket does not say, for every run of this card"></textarea>
          <div class="row">
            <button type="button" data-save-context aria-busy={saving} onclick={save}>Save</button>
            <p class="quiet" role="status" data-context-status>{status}</p>
          </div>
        {:else if closed !== null && (extra ?? '') !== ''}
          <h3 class="label">Extra context</h3>
          <div class="text"><Markdown source={extra ?? ''} headingsFrom={4} /></div>
        {/if}
      </Block>

      <!-- A closed card takes no more links, so its related cards are not part of the record. -->
      {#if related.length > 0 && closed === null}
        <Block id="related" title="Related" fold open={false} peek={related.map((card) => `${card.key} ${card.title}`).join(', ')}>
          {#snippet meta()}{related.length === 1 ? '1 card' : `${related.length} cards`}{/snippet}
          <ul class="chips">
            {#each related as card (card.key)}
              <li class="chip" title={card.title}>
                {card.key}
                <button type="button" aria-label="Remove the link to {card.key}" aria-busy={removing === card.key} onclick={() => remove(card.key)}>×</button>
              </li>
            {/each}
          </ul>
          <p class="quiet" role="status" data-link-status>{linkStatus}</p>
        </Block>
      {/if}

      {#if closed !== null && checkouts !== undefined}
        {@render checkouts()}
      {/if}
    </div>
  </div>

  {#if strip.length > 0}
    <PhaseStrip {strip} {spend} {logBase} now={clock} />
  {/if}
</div>

<style>
  /* The read-only mark: words in ink, the diff in Geist Mono, folded until asked for. */
  .broke p,
  .broke ul {
    margin: 0 0 var(--space-2);
  }

  .broke ul {
    padding-left: var(--space-5);
  }

  .broke summary {
    cursor: pointer;
  }

  .broke pre {
    max-height: 320px;
    margin: var(--space-2) 0 0;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    white-space: pre;
  }

  /* The column keeps 28px between its parts, the nearest step of the scale. */
  .overview {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .zone,
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
  }

  .stack.lined {
    gap: var(--space-4);
  }

  /* A muted label over each zone, at the size of a meta line. */
  .zone-label {
    margin: 0;
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: 500;
  }

  /* One hairline between the blocks of a zone. The boxes of Needs you need none. */
  .lined > :global(* + *) {
    padding-top: 14px;
    border-top: 1px solid var(--line);
  }

  /* The lede, at the page's body size. It fills its box like any long text, up to the Markdown cap.
     Written against the rendered box, which the summary reaches through the sanitizing renderer. */
  div.big :global(div.markdown) {
    font-size: var(--text-base);
    line-height: 1.5;
  }

  /* The text sits tight under the block's header, so the first paragraph drops
     its top margin and the last its bottom one. */
  div.big :global(div.markdown > :first-child) {
    margin-top: 0;
  }

  div.big :global(div.markdown > :last-child) {
    margin-bottom: 0;
  }

  .text {
    max-width: min(100%, 120ch);
    color: var(--ink-2);
  }

  .steps {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .steps li {
    display: flex;
    gap: 14px;
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
  }

  .steps li:first-child {
    padding-top: var(--space-1);
    border-top: 0;
  }

  .steps .no {
    flex: none;
    width: 18px;
    padding-top: 2px;
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .steps p {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    line-height: 1.55;
  }

  .steps code {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
  }

  .files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 6px;
  }

  .covers {
    align-items: center;
  }

  .plain {
    margin: 0;
    color: var(--ink);
    font-size: var(--text-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* Section labels in sentence case. */
  .label {
    margin: var(--space-1) 0 0;
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--muted);
  }

  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .link {
    align-self: flex-start;
    font-size: var(--text-xs);
    color: var(--blue);
  }

  textarea {
    min-height: 64px;
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
    resize: vertical;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  button {
    padding: 5px 11px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-xs);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 2px 7px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-sm);
    background: var(--card);
    font-family: var(--font-mono);
    font-size: var(--text-2xs);
    color: var(--ink-3);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  th {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--line);
    color: var(--muted);
    font-size: var(--text-2xs);
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
  }

  th.key {
    width: 13ch;
  }

  th.state {
    width: 22ch;
  }

  td {
    padding: 10px var(--space-3);
    border-bottom: 1px solid var(--line);
    vertical-align: middle;
  }

  tr:last-child td {
    border-bottom: 0;
  }

  td .link {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  td.what {
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .keyfield {
    box-sizing: border-box;
    width: 12ch;
    height: 28px;
    padding: 0 var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .refkey {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink);
  }

  .titled {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .expand {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    cursor: pointer;
  }

  .expand .ico {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    transition: transform 0.12s;
  }

  .expand[aria-expanded='true'] .ico {
    transform: rotate(90deg);
  }

  .titlefield {
    box-sizing: border-box;
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 var(--space-2);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
  }

  .more td {
    padding-top: 0;
  }


  .add {
    flex-wrap: wrap;
    gap: var(--space-3);
    padding-top: var(--space-3);
    border-top: 1px solid var(--line);
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .excerpt {
    max-width: min(100%, 120ch);
    margin: 0;
    color: var(--ink-2);
    font-size: var(--text-sm);
    line-height: 1.6;
    white-space: pre-line;
  }

  .excerpt code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  .docs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .doc {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 var(--space-3);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--card);
    color: var(--ink);
    font-size: var(--text-sm);
    font-weight: 500;
    text-decoration: none;
  }

  .doc .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    font-weight: 400;
  }

  .doc .count {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    font-weight: 400;
  }

  .ico {
    flex: none;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* 22px, between the lede and a page title. */
  .sum {
    margin: 0;
    color: var(--ink);
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .sum .mono {
    font-family: var(--font-mono);
  }

  .bar {
    display: flex;
    gap: 3px;
  }

  .bar i,
  .legend i {
    flex: 1;
    height: 6px;
    border-radius: 2px;
    background: var(--line);
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
    margin: 0;
    padding: 0;
    list-style: none;
    color: var(--ink-2);
    font-size: var(--text-xs);
  }

  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .legend i {
    flex: none;
    width: 8px;
    height: 8px;
  }

  /* The colour says the state as the board's pills do, and the legend says it in words. */
  i[data-tone='done'] {
    background: var(--green);
  }

  i[data-tone='running'] {
    background: var(--amber);
  }

  i[data-tone='waiting'] {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px var(--line-2);
  }

  .foot {
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  .chip button {
    padding: 0;
    border: none;
    background: transparent;
    color: var(--muted);
  }
</style>
