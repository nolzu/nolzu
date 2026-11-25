<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button, InfoBox } from '@nolzu/ui';
  import { settingsTitle } from '$lib/settings-sections.ts';
  import type { McpEntry, McpValue } from '$lib/mcp-list.ts';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const refused = $derived(form !== null && 'message' in form ? form : null);
  // What the last Test answered, for the row or the form it was pressed in.
  const answer = $derived(form !== null && 'test' in form ? (form.test ?? null) : null);
  const rowTest = (name: string) => (answer?.from === 'row' && answer.name === name ? answer : null);
  // The Test press that waits on its answer, which takes up to 15 s: a row's name, or 'form'.
  let testing = $state<string | null>(null);
  const found = $derived(form !== null && 'found' in form ? (form.found ?? null) : null);
  const problem = (field: string) => (refused?.field === field ? refused.message : null);

  // The server open in the form: its name, '' for a new one, or null for none.
  let editing = $state<string | null>(null);
  // The form a Test was pressed in. Opening a form drops it, so one server's tools never show on another.
  let tested = $state<string | null>(null);
  const formTest = $derived(answer?.from === 'form' && tested !== null && tested === editing ? answer : null);
  // The rows of the open form, kept here so Add a variable and Remove change them in place. Each has an
  // id of its own, so removing one row never moves what was typed into another.
  // `stored` is a secret this machine may hold already, which an empty box keeps.
  type Row = McpValue & { id: number; typed: string; stored: boolean };
  let next = 0;
  const row = (one: McpValue, stored = false): Row => ({ ...one, id: (next += 1), typed: '', stored: stored && one.secret });
  let draft = $state<{ kind: 'local' | 'remote'; env: Row[]; headers: Row[] }>({ kind: 'local', env: [], headers: [] });
  // The server whose Delete waits for a second press, which says what goes.
  let deleting = $state<string | null>(null);
  let nameBox = $state<HTMLInputElement | null>(null);
  let confirmBox = $state<HTMLElement | null>(null);

  const open = (entry: McpEntry | null) => {
    editing = entry?.name ?? '';
    tested = null;
    draft = { kind: entry?.kind ?? 'local', env: entry?.env.map((one) => row(one, true)) ?? [], headers: entry?.headers.map((one) => row(one, true)) ?? [] };
  };
  // The form takes the focus when it opens, so a keyboard user lands in it.
  $effect(() => {
    if (editing !== null) nameBox?.focus();
  });
  // The second press of Delete takes the focus, so a keyboard user reads what goes before pressing.
  $effect(() => {
    if (deleting !== null) confirmBox?.querySelector<HTMLButtonElement>('button[type="submit"]')?.focus();
  });
  const current = $derived(editing === null || editing === '' ? null : (data.rows.find((row) => row.entry.name === editing)?.entry ?? null));

  // A saved form closes; a refused one stays open with what was typed. No reset either way, so a
  // refusal keeps the fields. Test posts the same form and keeps it open with its answer.
  const saving: SubmitFunction = ({ action }) => {
    const test = action.search.endsWith('/test');
    if (test) {
      testing = 'form';
      tested = editing;
    }
    return async ({ result, update }) => {
      await update({ reset: false });
      if (test) testing = null;
      else if (result.type === 'success') editing = null;
    };
  };
  const testRow =
    (name: string): SubmitFunction =>
    () => {
      testing = name;
      return async ({ update }) => {
        await update({ reset: false });
        testing = null;
      };
    };
  const keep: SubmitFunction = () => async ({ update }) => update({ reset: false });
  // A grid box ticks at once; a refused save takes the tick back, so the box never shows what is not saved.
  const cell: SubmitFunction = ({ formElement }) => async ({ result, update }) => {
    if (result.type !== 'success') {
      const box = formElement.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (box !== null) box.checked = !box.checked;
    }
    await update({ reset: false });
  };
  const submitNow = (event: Event) => (event.currentTarget as HTMLInputElement).form?.requestSubmit();
  // A server with no tool list gets all its tools, which needs no line.
  const toolsLine = (entry: McpEntry) => `Tools: ${entry.tools.join(', ')}.${data.cursor ? ' Cursor cannot limit single tools and gets them all.' : ''}`;
</script>

<svelte:head><title>{settingsTitle('mcp')}</title></svelte:head>

{#snippet values(prefix: 'env' | 'header', rows: Row[], label: string)}
  <fieldset class="values">
    <legend>{label}</legend>
    {#each rows as one, index (one.id)}
      <div class="value-row">
        <input name="{prefix}.name" bind:value={one.name} class="mono" placeholder="NAME" aria-label="{label}, name {index + 1}" autocomplete="off" />
        <select name="{prefix}.mode" aria-label="{label}, kind {index + 1}" value={one.secret ? 'secret' : 'plain'} onchange={(event) => (one.secret = event.currentTarget.value === 'secret')}>
          <option value="plain">Plain</option>
          <option value="secret">Secret</option>
        </select>
        {#if one.secret}
          <input name="{prefix}.value" type="password" bind:value={one.typed} class="mono" placeholder={one.stored ? 'Empty keeps the saved value' : 'Value'} aria-label="{label}, value {index + 1}" autocomplete="new-password" />
        {:else}
          <input name="{prefix}.value" bind:value={one.value} class="mono" placeholder="Value" aria-label="{label}, value {index + 1}" autocomplete="off" />
        {/if}
        <Button size="small" variant="ghost" aria-label="Remove {one.name === '' ? `row ${index + 1}` : one.name}" onclick={() => rows.splice(index, 1)}>Remove</Button>
      </div>
    {/each}
    <div><Button size="small" variant="ghost" onclick={() => rows.push(row({ name: '', secret: true, value: '' }))}>Add {prefix === 'env' ? 'a variable' : 'a header'}</Button></div>
  </fieldset>
{/snippet}

<!-- Its own route and not a block of /settings/[section], because it writes a file in the project
     folder and secrets into the keychain, and reads no setting. -->
<section class="section" id="mcp" aria-labelledby="mcp-title">
  <header class="section-head"><h2 id="mcp-title">MCP servers</h2></header>
  <p class="lead">Tools your runs can call, such as a browser, a database or a docs search. A new server is off everywhere. Turn it on for a phase in the grid below.</p>
  {#if data.cursor}<p class="warn" role="note">Cursor runs also start the servers in your own <span class="mono">~/.cursor/mcp.json</span>, because Cursor has no way to leave them out.</p>{/if}
  {#if data.codex}<p class="warn" role="note">Codex runs leave out the servers of your own <span class="mono">~/.codex/config.toml</span>. A system or managed Codex config, and a trusted project's <span class="mono">.codex/config.toml</span>, may still add servers.</p>{/if}
  {#if !data.hasFolder}<p class="refused" role="note">This project has no folder, so there is nowhere to keep the list.</p>{:else if !data.shared}<p class="warn" role="note">This project folder is not a git repository, or its git ignores {data.file}, so the list stays on this machine and your team does not get it.</p>{/if}
  {#if data.shared && data.uncommitted}
    {#if data.commitProblem !== null}<p class="refused" role="note">{data.commitProblem}</p>
    {:else}<p class="warn" role="note">{data.file} has changes that are not committed yet, so your team does not have them. The next save here or the next start of Nolzu commits them.</p>{/if}
  {/if}
  {#if data.migration !== null}<p class="refused" role="note">{data.migration}</p>{/if}
  {#each data.problems as line (line)}<p class="refused" role="note">{line}</p>{/each}
  {#if problem('server') && editing === null}<p class="refused" role="alert">{problem('server')}</p>{/if}

  <div class="box">
    {#each data.rows as row (row.entry.name)}
      <div class="st" data-mcp-server={row.entry.name}>
        <div class="name">
          <span class="lb mono">{row.entry.name}</span>
          <span class="quiet">{row.entry.kind === 'local' ? 'Local' : row.entry.transport === 'sse' ? 'Remote, SSE' : 'Remote, HTTP'}</span>
        </div>
        <div class="c">
          {#if row.entry.description !== ''}<p class="text">{row.entry.description}</p>{/if}
          <p class="quiet mono">{row.entry.kind === 'local' ? [row.entry.command, ...row.entry.args].join(' ') : row.entry.url}</p>
          {#if row.entry.tools.length > 0}<p class="quiet">{toolsLine(row.entry)}</p>{/if}
          {#if row.urlWarning !== null}<p class="warn" role="note">{row.urlWarning}</p>{/if}
          {#if data.codex && row.entry.kind === 'remote' && row.entry.transport === 'sse'}<p class="warn" role="note">Codex speaks to remote servers over streamable HTTP only, so Codex runs leave this server out.</p>{/if}
          {#if row.cursorSecret}<p class="warn" role="note">On Cursor the agent's shell can read this server's secret.</p>{/if}
          {#if row.unlimited.length > 0}
            <p class="warn" role="note">All its tools in the read-only phases {row.unlimited.join(', ')}. They may change things outside the wall.</p>
          {/if}
          {#each row.missing as key (`${key.where}:${key.name}`)}
            <form method="POST" action="?/secret" class="line" use:enhance={keep}>
              <input type="hidden" name="name" value={row.entry.name} />
              <input type="hidden" name="where" value={key.where} />
              <input type="hidden" name="key" value={key.name} />
              <label class="needs" for="secret-{row.entry.name}-{key.where}-{key.name}">Needs secret: <span class="mono">{key.name}</span></label>
              <input id="secret-{row.entry.name}-{key.where}-{key.name}" name="value" type="password" class="mono" autocomplete="off" />
              <Button size="small" type="submit" aria-label="Save {key.name}">Save</Button>
            </form>
          {/each}
          {#if row.missing.length > 0}<p class="quiet">Runs leave this server out until this machine has every secret. A secret is asked again when the server's command, arguments, folder, address or a plain value changes, such as after a teammate's edit comes in with a pull.</p>{/if}
          {#if problem(`secret:${row.entry.name}`)}<p class="refused" role="alert">{problem(`secret:${row.entry.name}`)}</p>{/if}
          {#if deleting === row.entry.name}
            <form method="POST" action="?/delete" class="line" use:enhance={keep} bind:this={confirmBox}>
              <input type="hidden" name="name" value={row.entry.name} />
              <span class="needs" id="delete-{row.entry.name}-what">Delete {row.entry.name}? Its secrets leave this machine's keychain, and your team loses it on their next pull.</span>
              <Button size="small" variant="danger" type="submit" aria-describedby="delete-{row.entry.name}-what">Delete {row.entry.name}</Button>
              <Button size="small" variant="ghost" onclick={() => (deleting = null)}>Keep it</Button>
            </form>
          {:else}
            <div class="line">
              <!-- Starts the server for a moment and asks for its tools, as a run would start it. -->
              <form method="POST" action="?/test" use:enhance={testRow(row.entry.name)}>
                <input type="hidden" name="name" value={row.entry.name} />
                <Button size="small" type="submit" aria-label="Test {row.entry.name}" aria-busy={testing === row.entry.name ? 'true' : undefined} data-mcp-test={row.entry.name}>Test</Button>
              </form>
              <Button size="small" aria-label="Edit {row.entry.name}" onclick={() => open(row.entry)}>Edit</Button>
              <Button size="small" variant="danger" aria-label="Delete {row.entry.name}" onclick={() => (deleting = row.entry.name)}>Delete</Button>
            </div>
            {@const tested = rowTest(row.entry.name)}
            <p class={tested !== null && !tested.ok ? 'warn' : 'quiet'} role="status" data-mcp-said={row.entry.name}>
              {testing === row.entry.name ? 'Starting the server and asking for its tools.' : (tested?.said ?? '')}
            </p>
          {/if}
        </div>
      </div>
    {:else}
      <p class="st quiet">No server yet.</p>
    {/each}
  </div>

  {#if editing === null}
    <div class="line">
      <Button onclick={() => open(null)} disabled={!data.hasFolder}>Add a server</Button>
      <form method="POST" action="?/find" use:enhance={keep}><Button type="submit" disabled={!data.hasFolder}>Import from my engines</Button></form>
    </div>
    {#if found !== null}
      {#if found.length === 0}
        <p class="quiet" role="status">No server found in ~/.claude.json, ~/.codex/config.toml or ~/.cursor/mcp.json.</p>
      {:else}
        <form method="POST" action="?/import" class="box editor" use:enhance={keep} aria-label="Import from my engines">
          <p class="quiet">Read from your engines' own configs, which Nolzu leaves as they are. Every value goes to this machine's keychain unless you mark it plain, and an imported server is off everywhere.</p>
          {#each found as one (one.key)}
            <fieldset class="values">
              <legend><label><input type="checkbox" name="pick" value={one.key} /> <span class="mono">{one.name}</span> from {one.source}</label></legend>
              <p class="quiet">{one.kind === 'local' ? 'Local, a command' : 'Remote, an address'}</p>
              {#each one.env as value (value.name)}
                {#if value.secret}<label class="quiet"><input type="checkbox" name="plain" value="{one.key}|env:{value.name}" /> <span class="mono">{value.name}</span> is plain, not a secret</label>
                {:else}<p class="quiet"><span class="mono">{value.name}</span> comes in plain, because an engine reads it for itself.</p>{/if}
              {/each}
              {#each one.headers as name (name)}<label class="quiet"><input type="checkbox" name="plain" value="{one.key}|header:{name}" /> Header <span class="mono">{name}</span> is plain, not a secret</label>{/each}
            </fieldset>
          {/each}
          <div><Button variant="primary" type="submit">Add the picked servers</Button></div>
        </form>
      {/if}
    {/if}
    {#if problem('import')}<p class="refused" role="alert">{problem('import')}</p>{/if}
  {:else}
    {#key editing}
      <form method="POST" action="?/save" class="box editor" use:enhance={saving} aria-label={current === null ? 'Add a server' : `Edit ${current.name}`}>
        <input type="hidden" name="original" value={current?.name ?? ''} />
        <div class="grid2">
          <label for="mcp-name">Name</label>
          <input id="mcp-name" name="name" class="mono" value={current?.name ?? ''} autocomplete="off" aria-describedby="mcp-name-help" bind:this={nameBox} />
          <p class="quiet span" id="mcp-name-help">Letters, digits, - and _. Tools show up as mcp__name__tool.</p>
          <label for="mcp-description">Description</label>
          <input id="mcp-description" name="description" value={current?.description ?? ''} autocomplete="off" />
          <span class="lb">Kind</span>
          <div class="line" role="radiogroup" aria-label="Kind">
            <label><input type="radio" name="kind" value="local" checked={draft.kind === 'local'} onchange={() => (draft.kind = 'local')} /> Local, a command</label>
            <label><input type="radio" name="kind" value="remote" checked={draft.kind === 'remote'} onchange={() => (draft.kind = 'remote')} /> Remote, an address</label>
          </div>
          {#if draft.kind === 'local'}
            <label for="mcp-command">Command</label>
            <input id="mcp-command" name="command" class="mono" value={current?.command ?? ''} placeholder="npx" autocomplete="off" />
            <label for="mcp-args">Arguments</label>
            <textarea id="mcp-args" name="args" class="mono" rows="3" placeholder="One per line">{current?.args.join('\n') ?? ''}</textarea>
            <label for="mcp-cwd">Folder</label>
            <input id="mcp-cwd" name="cwd" class="mono" value={current?.cwd ?? ''} placeholder="Optional, inside the project or a full path" autocomplete="off" />
          {:else}
            <label for="mcp-url">Address</label>
            <input id="mcp-url" name="url" class="mono" value={current?.url ?? ''} placeholder="https://mcp.example.com/mcp" autocomplete="off" />
            <label for="mcp-transport">Transport</label>
            <select id="mcp-transport" name="transport" value={current?.transport ?? 'http'}>
              <option value="http">HTTP</option>
              <option value="sse">SSE</option>
            </select>
          {/if}
          {#if formTest !== null && formTest.ok}
            <!-- What the server listed, one box each, ticked as the form had them. A tool the form allows
                 that the server no longer lists stays, ticked, with a note. -->
            <span class="lb" id="mcp-tools-label">Allowed tools</span>
            <div class="tools" role="group" aria-labelledby="mcp-tools-label" aria-describedby="mcp-tools-help" data-tool-boxes>
              {#each formTest.tools as tool (tool)}<label><input type="checkbox" name="tools" value={tool} checked={formTest.chosen.includes(tool)} /> <span class="mono">{tool}</span></label>{/each}
              {#each formTest.chosen.filter((tool) => !formTest.tools.includes(tool)) as tool (tool)}
                <label data-unlisted={tool}><input type="checkbox" name="tools" value={tool} checked /> <span class="mono">{tool}</span> <span class="quiet">the server does not list it now</span></label>
              {/each}
            </div>
          {:else}
            <label for="mcp-tools">Allowed tools</label>
            <input id="mcp-tools" name="tools" class="mono" value={formTest?.chosen.join(', ') ?? current?.tools.join(', ') ?? ''} placeholder="Empty allows every tool" autocomplete="off" aria-describedby="mcp-tools-help" />
          {/if}
          <p class="quiet span" id="mcp-tools-help">{formTest?.ok ? 'None ticked allows every tool. ' : ''}Claude Code and Codex get only these tools. Cursor cannot limit single tools and gets all tools of this server.</p>
          <div class="line span">
            <Button size="small" type="submit" formaction="?/test" aria-busy={testing === 'form' ? 'true' : undefined} data-mcp-test="form">Test</Button>
            <p class={formTest !== null && !formTest.ok ? 'warn' : 'quiet'} role="status" data-mcp-said="form">
              {testing === 'form' ? 'Starting the server and asking for its tools.' : (formTest?.said ?? 'Starts the server for a moment, as a run would, and lists its tools.')}
            </p>
          </div>
        </div>
        {@render values('env', draft.env, 'Environment variables')}
        {#if draft.kind === 'remote'}{@render values('header', draft.headers, 'Headers')}{/if}
        {#if problem('server')}<p class="refused" role="alert">{problem('server')}</p>{/if}
        <div class="line">
          <Button variant="primary" type="submit">Save</Button>
          <Button variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
        </div>
      </form>
    {/key}
  {/if}

  {#if data.rows.length > 0}
    <h3 id="grid-title">Phases</h3>
    <p class="quiet">Which phases get each server. Phases marked read-only change nothing in the project.</p>
    {#if problem('grid')}<p class="refused" role="alert">{problem('grid')}</p>{/if}
    <div class="scroll">
      <table aria-labelledby="grid-title">
        <thead>
          <tr>
            <th scope="col">Server</th>
            {#each data.phases as column (column.phase)}<th scope="col">{column.label}{#if column.readOnly}<span class="ro">read-only</span>{/if}</th>{/each}
          </tr>
        </thead>
        <tbody>
          {#each data.rows as row (row.entry.name)}
            <tr>
              <th scope="row" class="mono">{row.entry.name}</th>
              {#each data.phases as column (column.phase)}
                {@const on = row.entry.phases.includes(column.phase)}
                <td>
                  <form method="POST" action="?/phase" use:enhance={cell}>
                    <input type="hidden" name="name" value={row.entry.name} />
                    <input type="hidden" name="phase" value={column.phase} />
                    <input type="hidden" name="on" value={on ? 'false' : 'true'} />
                    <input type="checkbox" checked={on} aria-label="{row.entry.name} on for {column.label}" onchange={submitNow} />
                  </form>
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}

  <details class="notes">
    <summary>How each engine gets these servers</summary>
    <InfoBox>
      <p>
        The list lives in <span class="mono">{data.file}</span> in the project folder, and each change is committed there, so your team gets it with git. A secret stays in this machine's keychain and never goes into the file, so each teammate enters their own.
      </p>
      <p>
        Claude Code runs start only the servers here. Codex runs leave out the servers of your own <span class="mono">~/.codex/config.toml</span>; a system or managed Codex config and a trusted project's <span class="mono">.codex/config.toml</span> are not measured and may still add servers. Cursor runs also start the servers in your own <span class="mono">~/.cursor/mcp.json</span>, because Cursor has no way to leave them out. Codex speaks to remote servers over streamable HTTP only, so an SSE server is left out of its runs. Sign-in with OAuth is not offered here: give a remote server its token as a secret header.
      </p>
    </InfoBox>
  </details>
</section>

<style>
  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    overflow-wrap: anywhere;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* The box of Settings, Project, so the pages read alike. */
  .box {
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background: var(--panel);
  }

  .st {
    display: grid;
    grid-template-columns: 180px minmax(0, 1fr);
    gap: 6px 28px;
    align-items: start;
    margin: 0;
    padding: 12px 14px;
  }

  .st + .st {
    border-top: 1px solid var(--line);
  }

  .name,
  .c {
    display: grid;
    gap: 6px;
    align-content: start;
  }

  .lb {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
  }

  .text {
    margin: 0;
    font-size: var(--text-sm);
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .editor {
    display: grid;
    gap: var(--space-3);
    padding: 14px;
  }

  .grid2 {
    display: grid;
    grid-template-columns: 140px minmax(0, 1fr);
    gap: 8px 16px;
    align-items: center;
  }

  .span {
    grid-column: 2;
  }

  /* One box per tool the server listed, wrapping in rows. */
  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 14px;
  }

  .tools label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .values {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .value-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.4fr) auto;
    gap: 8px;
    align-items: center;
  }

  input:not([type]),
  input[type='password'],
  select,
  textarea {
    box-sizing: border-box;
    min-width: 0;
    padding: 6px 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font: inherit;
    font-size: var(--text-sm);
  }

  h3 {
    margin: var(--space-3) 0 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  .lead {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--ink-2);
  }

  /* The engine notes, closed until asked for: every one that applies to a server is on its row. */
  .notes summary {
    font-size: var(--text-sm);
    color: var(--ink-2);
    cursor: pointer;
  }

  .notes[open] summary {
    margin-bottom: var(--space-2);
  }

  /* The grid fits the page at 1280. Narrower, it scrolls inside its own box with the server column
     held, and a shade on the side that has more says there is more, so the page itself never scrolls. */
  .scroll {
    overflow-x: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    background:
      linear-gradient(to right, var(--panel) 30%, transparent) left / 24px 100% no-repeat local,
      linear-gradient(to left, var(--panel) 30%, transparent) right / 24px 100% no-repeat local,
      linear-gradient(to right, var(--line-2), transparent) left / 10px 100% no-repeat scroll,
      linear-gradient(to left, var(--line-2), transparent) right / 10px 100% no-repeat scroll,
      var(--panel);
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  th,
  td {
    padding: 6px 4px;
    border-bottom: 1px solid var(--line);
    text-align: center;
  }

  thead th {
    font-size: var(--text-xs);
    font-weight: 500;
    vertical-align: bottom;
    overflow-wrap: normal;
  }

  /* The server column stays in view while the grid scrolls, and a long name wraps rather than
     covering the boxes. */
  th[scope='row'],
  thead th:first-child {
    position: sticky;
    left: 0;
    z-index: 1;
    padding-left: 10px;
    background: var(--panel);
    text-align: left;
  }

  th[scope='row'] {
    max-width: 16ch;
    overflow-wrap: anywhere;
  }

  .ro {
    display: block;
    font-size: var(--text-xs);
    font-weight: 400;
    color: var(--muted);
  }

  /* The muted token and not an opacity: faint text loses the contrast rule. */
  .quiet {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .needs {
    font-size: var(--text-xs);
    color: var(--ink);
  }

  .warn,
  .refused {
    margin: 0;
    padding-left: 10px;
    font-size: var(--text-xs);
    color: var(--ink);
  }

  .warn {
    box-shadow: inset 2px 0 0 var(--amber);
  }

  .refused {
    box-shadow: inset 2px 0 0 var(--red);
  }

  @media (max-width: 760px) {
    .st,
    .grid2 {
      grid-template-columns: minmax(0, 1fr);
    }

    .span {
      grid-column: 1;
    }

    .value-row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
  }
</style>
