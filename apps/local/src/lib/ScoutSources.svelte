<script lang="ts">
  import type { ActionResult } from '@sveltejs/kit';
  import { applyAction, deserialize } from '$app/forms';
  import { goto, invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { scoutEntrySlug } from '@nolzu/protocol';
  import { Button, Chip, Dialog } from '@nolzu/ui';
  import type { ScoutSourceRow, SourceForm } from '$lib/scout-sources.ts';

  // The Add a source dialog, and the same dialog for a source on the strip.
  // A new source picks its kind on the left, opened on `kind` when the first visit asked for one. An
  // open source keeps its kind, and adds Check now and Remove. There is no cloud schedule here:
  // Nolzu cloud checks no source yet, so the footer says a check waits for Check now.
  // `at` names the opening a draft belongs to: a source by its id, a new one by the kind it opened on.
  type Draft = { at: string; values: Record<string, string>; pasted: string };
  let {
    forms,
    row = null,
    kind = '',
    onclose,
    draft = $bindable(null),
  }: {
    forms: readonly SourceForm[];
    row?: ScoutSourceRow | null;
    kind?: string;
    onclose: () => void;
    // What was typed when the dialog last closed without a save, kept by the page so a stray click on
    // the backdrop loses nothing. The token is never kept.
    draft?: Draft | null;
  } = $props();

  const uid = $props.id();
  let shell: ReturnType<typeof Dialog>;
  let main: HTMLFormElement;
  // svelte-ignore state_referenced_locally
  const at = row === null ? `new:${kind}` : `source:${row.id}`;
  const kept = draft?.at === at ? draft : null;

  // Which form a new source is on. Empty means `kind`, or else the first one.
  let picked = $state(kept?.values.form ?? '');
  const chosen = $derived(row?.form ?? forms.find((one) => one.id === (picked || kind)) ?? forms[0]!);
  // A kept field of the form on show. The fields of another kind are not this kind's.
  const keep = (name: string): string | undefined => (kept?.values.form === chosen.id ? kept.values[name] : undefined);
  const keepOn = (name: string, stored: boolean): boolean => {
    const value = keep(name);
    return value === undefined ? stored : value === 'on';
  };

  // The project the keychain entry is named by, as typed, so the name under the token follows it.
  let typed = $state<string | null>(null);
  const project = $derived(typed ?? (chosen.entry === null ? '' : (keep(chosen.entry.field) ?? row?.values[chosen.entry.field] ?? '')));
  let pasted = $state(kept?.pasted ?? '');
  // The lock line below already says where the token goes, so the shared keychain sentences are dropped here.
  const credentialRest = $derived(chosen.credential.replace(/^The token goes into[^.]*\.\s*It never reaches[^.]*\.\s*/, ''));
  const entry = $derived(chosen.entry === null ? null : ['nolzu', chosen.entry.word, scoutEntrySlug(project)].filter((part) => part !== '').join('/'));

  let sending = $state(false);
  let problem = $state<string | null>(null);
  let testing = $state(false);
  // Check now posts the form and leaves the page, so it holds from the press until the page goes.
  let checking = $state(false);
  // Back and forward can bring the page back from the browser's cache as it was left, held. It holds
  // nothing then, so it lets go.
  $effect(() => {
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) checking = false;
    };
    window.addEventListener('pageshow', shown);
    return () => window.removeEventListener('pageshow', shown);
  });
  let tested = $state<{ readable: string; where: string; took: string } | null>(null);
  let testProblem = $state<string | null>(null);

  function pick(id: string): void {
    picked = id;
    typed = null;
    tested = null;
    testProblem = null;
    problem = null;
  }

  const UNREACHABLE = 'Nolzu could not be reached. Check that it is still running.';
  const said = (result: ActionResult | null): string =>
    result === null ? UNREACHABLE : result.type === 'failure' && typeof result.data?.message === 'string' ? result.data.message : 'Nolzu answered without a reason.';

  // Every press posts to a form action of the Scout page with fetch, so the dialog stays open on a
  // refusal and on a test, with what was typed still in it.
  async function send(action: string, body: FormData): Promise<ActionResult | null> {
    try {
      const response = await fetch(action, { method: 'POST', body, headers: { 'x-sveltekit-action': 'true' } });
      return deserialize(await response.text());
    } catch {
      return null;
    }
  }

  // Add, save or remove. A success closes the dialog, and the page reads its data again and prints the
  // answer under the strip. A refusal stays here, beside the fields.
  async function write(body: FormData): Promise<void> {
    if (sending) return;
    sending = true;
    problem = null;
    const result = await send('?/scout', body);
    sending = false;
    if (result?.type !== 'success') {
      problem = said(result);
      return;
    }
    saved = true;
    shell.close();
    // A remove takes the source's findings with it, so the finding on show may be gone and its own
    // address would answer 404. Scout's own address always loads.
    if (body.get('do') === 'remove') await goto(resolve('/scout'), { invalidateAll: true });
    else await invalidateAll();
    await applyAction(result);
  }

  // The fields as they stand, the token and the hidden ones left out, for the next open.
  let saved = false;
  function closed(): void {
    if (saved) draft = null;
    else {
      const values: Record<string, string> = { form: chosen.id };
      for (const field of main.querySelectorAll<HTMLInputElement>('input[name]')) {
        if (field.type === 'hidden' || field.type === 'password' || field.type === 'radio') continue;
        values[field.name] = field.type === 'checkbox' ? (field.checked ? 'on' : '') : field.value;
      }
      draft = { at, values, pasted };
    }
    onclose();
  }

  // A test answers for the form as it was pressed, so a changed field takes the answer away. The
  // switches are not part of the read.
  function edited(event: Event): void {
    if ((event.target as HTMLInputElement | null)?.type === 'checkbox') return;
    tested = null;
    testProblem = null;
  }

  function save(event: SubmitEvent): void {
    event.preventDefault();
    void write(new FormData(main));
  }

  function remove(): void {
    if (row === null) return;
    const body = new FormData();
    body.set('do', 'remove');
    body.set('id', String(row.id));
    void write(body);
  }

  // A read with the form as it is now. Nothing is saved, whatever it answers.
  async function test(): Promise<void> {
    testing = true;
    tested = null;
    testProblem = null;
    const result = await send('?/test', new FormData(main));
    testing = false;
    if (result?.type === 'success' && result.data !== undefined) tested = result.data as { readable: string; where: string; took: string };
    else testProblem = said(result);
  }

  // Cmd or Ctrl and Enter saves, as the cap on the main button says. On the dialog, so it works from the
  // paste box too, which belongs to Check now: there it checks the paste.
  function keys(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    const inside = (event.target as HTMLElement | null)?.closest('form');
    (inside ?? main).requestSubmit();
  }

  // What Check now reads for each kind, said once beside its button. No count: the limit lives in the
  // check, and a number copied here would drift away from it.
  const READS: Readonly<Record<string, string>> = {
    'tickets-github': 'Scout reads the newest tickets your query answers, and the failed CI runs of the default branch.',
    'tickets-gitlab': 'Scout reads the newest tickets your query answers.',
    'tickets-jira': 'Scout reads the newest tickets your query answers.',
    'tickets-linear': 'Scout reads the newest open tickets of the teams you named.',
    sentry: 'Scout reads the unresolved issues of that project, and takes the event count of each one from Sentry.',
    search: 'Scout reads the log lines your query answers: the newest ones first, then what was written since.',
  };
  const CHECK_ACTION: Readonly<Record<string, string>> = { tickets: '?/checkTickets#sources', sentry: '?/checkSentry#sources', search: '?/checkLogs#sources' };

  const LOCK = ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z', 'M8 11V8a4 4 0 0 1 8 0v3'];
  const TICK = ['m5 12 5 5 9-10'];
</script>

{#snippet icon(paths: readonly string[], cls: string)}
  <svg class="ico {cls}" viewBox="0 0 24 24" aria-hidden="true">{#each paths as d (d)}<path {d}></path>{/each}</svg>
{/snippet}

<!-- 820px: the kinds take a column of their own beside the form. -->
<Dialog
  bind:this={shell}
  title={row === null ? 'Add a source' : row.label}
  sub={row === null ? 'Scout reads from it. It never writes back.' : `${row.form.label}. Scout reads from it. It never writes back.`}
  held={sending}
  onclose={closed}
  onkeydown={keys}
  style="width: min(820px, calc(100vw - 32px))"
>
  {#if row !== null}
    <!-- Check now for the open source, a plain post: the page renders again with the answer under the
         strip. Only a pasted source gets a box, because only it needs its text handed over. -->
    <!-- A plain post that leaves the page, so a second press before it answers would check twice. -->
    <form
      method="POST"
      action={row.form.kind === 'paste' ? '?/check#sources' : CHECK_ACTION[row.form.kind]}
      class="check"
      onsubmit={(event) => {
        if (checking) event.preventDefault();
        checking = true;
      }}
    >
      <input type="hidden" name="id" value={row.id} />
      {#if row.form.kind === 'paste'}
        <label for="{uid}-text">Paste the log or the errors</label>
        <textarea id="{uid}-text" name="text" rows="4" required bind:value={pasted}></textarea>
        <p class="help">Scout keeps the lines it finds, so the finding can show them later. Do not paste a log that holds a token or a password.</p>
      {:else}
        <p class="help">{READS[row.form.id] ?? ''}</p>
      {/if}
      {#if row.error !== null}<p class="refused" data-failed={row.id}>{row.error}</p>{/if}
      <Button type="submit" aria-label="Check the source {row.label} now" aria-busy={checking ? 'true' : undefined} aria-disabled={checking ? 'true' : undefined}>Check now</Button>
    </form>
  {/if}

  <form bind:this={main} id="{uid}-form" class="bd" class:one={row !== null} method="POST" action="?/scout#sources" onsubmit={save} oninput={edited}>
    <input type="hidden" name="do" value={row === null ? 'add' : 'save'} />
    {#if row === null}
      <input type="hidden" name="check" value="now" />
      <fieldset class="kinds">
        <legend>Kind</legend>
        {#each forms as one (one.id)}
          <label class="kind" class:on={one.id === chosen.id}>
            <input class="sr" type="radio" name="form" value={one.id} checked={one.id === chosen.id} onchange={() => pick(one.id)} />
            <b>{one.label}</b><span>{one.needs}</span>
          </label>
        {/each}
      </fieldset>
    {:else}
      <input type="hidden" name="id" value={row.id} />
      <input type="hidden" name="form" value={row.form.id} />
    {/if}

    <div class="form">
      <div class="field">
        <label for="{uid}-label">Label</label>
        <input id="{uid}-label" name="label" value={kept?.values.label ?? row?.label ?? ''} placeholder="The recipe app" />
      </div>
      <!-- Keyed on the form, so another kind builds new fields instead of reusing the last ones. Without
           it the token typed for one kind stays in the box and is saved as another kind's. -->
      {#key chosen.id}
        {#if chosen.fields.length > 0}
          <div class="two">
            {#each chosen.fields as field (field.name)}
              <div class="field">
                <label for="{uid}-{field.name}">{field.label}</label>
                <input
                  id="{uid}-{field.name}"
                  class="mono"
                  name={field.name}
                  placeholder={field.placeholder}
                  value={keep(field.name) ?? row?.values[field.name] ?? ''}
                  oninput={field.name === chosen.entry?.field ? (event) => (typed = event.currentTarget.value) : undefined}
                />
              </div>
            {/each}
          </div>
        {/if}
        {#if chosen.secret !== null}
          <div class="field">
            <label for="{uid}-secret">{chosen.secret}</label>
            <input id="{uid}-secret" class="mono" name="secret" type="password" autocomplete="off" />
            {#if row !== null}<p class="help">Leave the {chosen.secret} empty to keep the one in the keychain.</p>{/if}
          </div>
        {/if}
        <p class="help">{chosen.scopes}</p>
        {#if chosen.entry === null || credentialRest !== ''}<p class="help">{chosen.entry === null ? chosen.credential : credentialRest}</p>{/if}
        {#if chosen.entry !== null && entry !== null}
          <p class="help lock" data-entry>
            {@render icon(LOCK, 'sm')}<span>Kept as <code>{entry}</code>. Sent only to {chosen.entry.service}, never to Nolzu cloud.</span>
          </p>
        {/if}

        {#if chosen.kind !== 'paste'}
          <div class="test">
            <Button onclick={test} disabled={testing} aria-busy={testing ? 'true' : undefined} data-test>Test the connection</Button>
            {#if tested !== null}
              <span class="said" role="status">{@render icon(TICK, 'ok')}{tested.readable}</span>
              <span class="took">{tested.where} · {tested.took}</span>
            {/if}
          </div>
          {#if testProblem !== null}<p class="refused" role="alert">{testProblem}</p>{/if}
        {/if}

        <div class="when">
          <h3>When a check finds something</h3>
          {#if row !== null}
            <div class="swr">
              <input id="{uid}-enabled" name="enabled" type="checkbox" role="switch" value="on" checked={keepOn('enabled', row.enabled)} />
              <label for="{uid}-enabled">Let Scout check this source</label>
            </div>
          {/if}
          <div class="swr">
            <input id="{uid}-createCards" name="createCards" type="checkbox" role="switch" value="on" checked={keepOn('createCards', row?.createCards ?? false)} />
            <label for="{uid}-createCards">Create cards without asking</label>
            <Chip>not active yet</Chip>
          </div>
          <div class="swr">
            <input id="{uid}-autoAssess" name="autoAssess" type="checkbox" role="switch" value="on" checked={keepOn('autoAssess', row?.autoAssess ?? false)} />
            <label for="{uid}-autoAssess">Run a read-only assessment without asking</label>
            <Chip>not active yet</Chip>
          </div>
        </div>
      {/key}
      {#if problem !== null}<p class="refused" role="alert">{problem}</p>{/if}
    </div>
  </form>

  {#snippet footer()}
    <div class="actions">
      {#if row !== null}<Button variant="danger" size="small" onclick={remove} disabled={sending} aria-label="Remove the source {row.label}">Remove</Button>{/if}
      <span class="note">Scout checks it when you press Check now.</span>
      <span class="grow"></span>
      <Button variant="ghost" key="Esc" onclick={() => shell.close()} disabled={sending}>Cancel</Button>
      <Button variant="primary" type="submit" form="{uid}-form" key="⌘↵" aria-keyshortcuts="Meta+Enter Control+Enter" aria-busy={sending ? 'true' : undefined} data-save
        >{row !== null ? 'Save' : chosen.kind === 'paste' ? 'Add' : 'Add and check now'}</Button
      >
    </div>
  {/snippet}
</Dialog>

<style>
  .bd {
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr);
    gap: var(--space-6);
  }

  .bd.one {
    grid-template-columns: minmax(0, 1fr);
  }

  .kinds {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    margin: 0;
    padding: 0 18px 0 0;
    border: 0;
    border-right: 1px solid var(--line);
  }

  legend {
    padding: 0 0 var(--space-2);
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--ink-2);
  }

  .kind {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 7px 10px;
    border-radius: var(--radius-md);
    cursor: pointer;
  }

  .kind b {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
  }

  .kind span {
    font-size: var(--text-2xs);
    color: var(--muted);
  }

  /* Picked is a ring and the panel, not a colour: picking a kind starts nothing. */
  .kind.on {
    background: var(--panel);
    box-shadow: inset 0 0 0 1px var(--line-2);
  }

  .kind:has(input:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: 0;
    opacity: 0;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  .two {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-3);
  }

  /* An odd last field, such as a query, takes the whole row. */
  .two > .field:last-child:nth-child(odd) {
    grid-column: 1 / -1;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  label {
    font-size: var(--text-xs);
    font-weight: 500;
    color: var(--ink-2);
  }

  input:not([type='radio'], [type='checkbox']),
  textarea {
    box-sizing: border-box;
    width: 100%;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
  }

  input:not([type='radio'], [type='checkbox']) {
    height: 34px;
    padding: 0 10px;
  }

  input.mono,
  textarea {
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
  }

  textarea {
    min-height: 88px;
    padding: 10px var(--space-3);
    line-height: 1.5;
    resize: vertical;
  }

  .help {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .form > .help + .help {
    margin-top: calc(-1 * var(--space-3));
  }

  code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--ink-2);
  }

  .ico {
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .ico.sm {
    width: 13px;
    height: 13px;
    margin-top: 2px;
  }

  /* Green marks the read that worked. The words stay in ink, a pair the token tests hold. */
  .ico.ok {
    width: 14px;
    height: 14px;
    stroke: var(--green);
    stroke-width: 2;
  }

  .test {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .said {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
  }

  .took {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    color: var(--muted);
  }

  .when {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: 6px;
    border-top: 1px solid var(--line);
  }

  h3 {
    margin: 0;
    padding: 12px 0 4px;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--ink-2);
  }

  .swr {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
    padding: 10px 0;
    border-top: 1px solid var(--line);
  }

  .swr:first-of-type {
    border-top: 0;
  }

  .swr label {
    font-size: var(--text-sm);
    font-weight: 400;
    color: var(--ink);
  }

  /* A checkbox drawn as the shared Switch, so the form posts it as it is. On is cream and never amber:
     a setting starts no run. The knob moves too, so on and off are not colour alone. */
  input[role='switch'] {
    appearance: none;
    position: relative;
    flex: none;
    width: 32px;
    height: 18px;
    margin: 0;
    border-radius: 999px;
    background: var(--line-2);
    cursor: pointer;
  }

  input[role='switch']::after {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--ink);
    content: '';
    transition: left 0.12s;
  }

  input[role='switch']:checked {
    background: var(--accent);
  }

  input[role='switch']:checked::after {
    left: 16px;
    background: var(--accent-ink);
  }

  .check {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    padding-bottom: var(--space-4);
    border-bottom: 1px solid var(--line);
  }

  .refused {
    margin: 0;
    padding-left: 10px;
    box-shadow: inset 2px 0 0 var(--red);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  .actions {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
  }

  .note {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .grow {
    flex: 1;
  }

  @media (max-width: 720px) {
    .bd {
      grid-template-columns: minmax(0, 1fr);
    }

    .kinds {
      padding: 0 0 var(--space-3);
      border-right: 0;
      border-bottom: 1px solid var(--line);
    }

    .two {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
