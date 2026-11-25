<script lang="ts">
  import { tick } from 'svelte';
  import Markdown from '../Markdown.svelte';
  import Button from '../Button.svelte';
  import { ticketWord } from './epic.ts';

  // The open row of an epic's task not added yet, as a property list like the Settings rows: the ticket
  // it links to, the description colleagues read and the notes that stay inside Nolzu. Every change is
  // the Overview's page state until Add, so nothing here writes.
  let {
    id,
    title,
    description,
    notes,
    linked = null,
    system = null,
    onedit,
    onlink = async () => null,
    onunlink = () => {},
    oncopy = async () => null,
  }: {
    id: string;
    title: string;
    description: string;
    notes: string;
    // The ticket the row is linked to, with its own title, and null for a local task.
    linked?: { key: string; title: string } | null;
    // The name of the project's ticket system, such as Jira. Null on a project with local tickets,
    // which has nothing to link to.
    system?: string | null;
    onedit: (field: 'description' | 'notes', text: string) => void;
    // Each answers with the sentence it was refused with, or null when it took. `still` says whether
    // the person still wants the answer, which they do not after Cancel.
    onlink?: (ref: string, still: () => boolean) => Promise<string | null>;
    onunlink?: () => void;
    oncopy?: (text: string) => Promise<string | null>;
  } = $props();

  let editing = $state<'description' | 'notes' | null>(null);
  let text = $state('');
  async function edit(field: 'description' | 'notes'): Promise<void> {
    editing = field;
    text = field === 'description' ? description : notes;
    await tick();
    document.getElementById(`task-${field}-${id}`)?.focus();
  }
  function save(): void {
    if (editing !== null) onedit(editing, text);
    editing = null;
  }

  let linking = $state(false);
  let ref = $state('');
  let reading = $state(false);
  let linkStatus = $state('');
  // Each Link press and each Cancel moves it, so an answer that comes after a Cancel is dropped.
  let attempt = 0;
  function cancelLink(): void {
    attempt += 1;
    linking = false;
    reading = false;
    linkStatus = '';
  }
  async function startLink(): Promise<void> {
    linking = true;
    linkStatus = '';
    await tick();
    document.getElementById(`task-ref-${id}`)?.focus();
  }
  async function link(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (reading || ref.trim() === '') return;
    reading = true;
    const mine = (attempt += 1);
    const refused = await onlink(ref.trim(), () => mine === attempt);
    if (mine !== attempt) return;
    reading = false;
    linkStatus = refused ?? '';
    if (refused === null) {
      linking = false;
      ref = '';
    }
  }

  let copyStatus = $state('');
  async function copy(): Promise<void> {
    const words = description.trim();
    copyStatus = (await oncopy(words === '' ? title.trim() : `${title.trim()}\n\n${words}`)) ?? `Copied the title and the description. Paste them into ${system === null ? 'your ticket system' : `a new ${system} ${ticketWord(system)}`}.`;
  }
</script>

{#snippet field(name: 'description' | 'notes', value: string, label: string, empty: string, locked = false)}
  {#if editing === name && !locked}
    <label class="hidden" for="task-{name}-{id}">{label} of {title}</label>
    <textarea id="task-{name}-{id}" data-task-edit={name} bind:value={text}></textarea>
    <div class="row">
      <Button size="small" variant="primary" data-task-save onclick={save}>Save</Button>
      <Button size="small" data-task-cancel onclick={() => (editing = null)}>Cancel</Button>
    </div>
  {:else}
    {#if value.trim() === ''}<p class="quiet" data-task-empty={name}>{empty}</p>{:else}<div class="body" data-task-text={name}><Markdown source={value} headingsFrom={4} /></div>{/if}
    <!-- One field is edited at a time, because the two share the box's text. -->
    {#if !locked && editing === null}<div class="row"><Button size="small" data-task-edit-open={name} aria-label="Edit the {label.toLowerCase()} of {title}" onclick={() => edit(name)}>Edit</Button></div>{/if}
  {/if}
{/snippet}

<dl class="props">
  {#if system !== null}
    <div class="prop">
      <dt>{system === 'GitHub' ? 'Issue' : 'Ticket'}</dt>
      <dd>
        {#if linked !== null}
          <div class="row">
            <span class="mono" data-task-linked>{linked.key}</span>
            <span class="what">{linked.title}</span>
            <Button size="small" data-task-unlink onclick={onunlink}>Unlink</Button>
          </div>
        {:else if linking}
          <form class="row" onsubmit={link}>
            <label class="hidden" for="task-ref-{id}">{system === 'GitHub' ? 'GitHub issue' : `${system} key`} or link for {title}</label>
            <input id="task-ref-{id}" class="ref" data-task-ref bind:value={ref} placeholder={system === 'GitHub' ? 'repo#12 or a link' : 'PROJ-123 or a link'} />
            <Button type="submit" size="small" data-task-link-submit disabled={reading} aria-busy={reading}>Link</Button>
            <Button size="small" data-task-link-cancel onclick={cancelLink}>Cancel</Button>
          </form>
        {:else}
          <div class="row"><Button size="small" data-task-link onclick={startLink}>Link to {system}</Button></div>
        {/if}
        {#if linkStatus !== ''}<p class="refused" role="alert" data-task-link-status>{linkStatus}</p>{/if}
      </dd>
    </div>
  {/if}
  <div class="prop">
    <dt>Description</dt>
    <dd>
      {@render field('description', description, 'Description', 'Empty. Plan writes it with the plan for colleagues.', linked !== null)}
      {#if linked !== null}<p class="quiet" data-task-ticket-text>The card takes the {ticketWord(system)}'s own text from {system}. This text is for Copy only.</p>{/if}
    </dd>
  </div>
  <div class="prop">
    <dt>Internal notes</dt>
    <dd>
      {@render field('notes', notes, 'Internal notes', 'No notes for this task.')}
      <p class="quiet">Stays inside Nolzu. Every run of the task reads it.</p>
    </dd>
  </div>
  <!-- A row like the others, so the label column stays one column. -->
  <div class="prop">
    <dt>Share</dt>
    <dd>
      <div class="row">
        <Button size="small" data-task-copy onclick={copy}>{system === null ? 'Copy title and description' : `Copy for ${system}`}</Button>
        <p class="quiet" role="status" data-task-copy-status>{copyStatus}</p>
      </div>
    </dd>
  </div>
</dl>

<style>
  /* Setting rows, narrower: the label on the left, the value and its actions on the right. */
  .props {
    margin: 0;
  }

  .prop {
    display: grid;
    grid-template-columns: 9rem minmax(0, 1fr);
    gap: 6px 20px;
    align-items: start;
    padding: 10px 0;
    border-top: 1px solid var(--line);
  }

  /* The row above draws the line, so the first row keeps its padding and its button clears the line. */
  .prop:first-child {
    border-top: 0;
  }

  dt {
    padding-top: 3px;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
  }

  dd {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
    margin: 0;
  }

  /* The text starts on the line of its label. */
  .body :global(.markdown > :first-child) {
    margin-top: 0;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink);
  }

  .what {
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .refused {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--red);
  }

  textarea,
  .ref {
    box-sizing: border-box;
    padding: var(--space-2) 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
  }

  textarea {
    width: 100%;
    min-height: 9em;
    resize: vertical;
  }

  .ref {
    width: 24ch;
    height: 28px;
    padding: 0 var(--space-2);
  }

  .hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
