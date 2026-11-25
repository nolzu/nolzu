<script lang="ts">
  import { Button, numberedLines } from '@nolzu/ui';
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { tick } from 'svelte';
  import type { HandEdit } from '$lib/onboard.ts';
  import { unsavedLine } from '$lib/project-files-notice.ts';

  let {
    files,
    refused = null,
  }: {
    files: readonly HandEdit[];
    // The page's last refusal. A row's own is `take:<path>`, and `ask` is the server asking once more.
    refused?: { field: string; message: string; ask?: boolean } | null;
  } = $props();

  // The file whose Take the new one waits on the ask. The press opens it for a file git does not hold,
  // and so does the server's refusal, which is how a page without JavaScript gets it.
  let asking = $state<string | null>(null);
  // The ask and the row's buttons take each other's place, so the focus would fall to the page. It goes
  // to the button that answers the ask, and back to Take the new one on Cancel.
  const focusIn = (path: string, hook: string): void => void tick().then(() => document.querySelector<HTMLElement>(`[data-hand-edit="${CSS.escape(path)}"] [${hook}]`)?.focus());
  const ask = (path: string): void => {
    asking = path;
    focusIn(path, 'data-hand-sure');
  };
  const unask = (path: string): void => {
    asking = null;
    focusIn(path, 'data-hand-take');
  };
  $effect(() => {
    if (refused?.ask === true && refused.field.startsWith('take:')) ask(refused.field.slice('take:'.length));
  });
  let pending = $state<string | null>(null);
  const problem = (path: string) => (refused?.field === `take:${path}` && refused.ask !== true ? refused.message : null);

  const answer =
    (file: HandEdit): SubmitFunction =>
    ({ formData, cancel }) => {
      if (formData.get('sure') === null && formData.get('take') !== null && file.unsaved) {
        cancel();
        ask(file.path);
        return;
      }
      pending = file.path;
      return async ({ update }) => {
        pending = null;
        asking = null;
        await update({ reset: false });
      };
    };
</script>

{#if files.length > 0}
  <p class="quiet" data-hand-hint>Your own rules belong in phase instructions (Settings, Phases). Skills you leave untouched update with Nolzu.</p>
  <ul class="hand">
    {#each files as file (file.path)}
      <li class="file" data-hand-edit={file.path}>
        <header class="fh">
          <span class="path">{file.path}</span>
          <span class="key"><span class="minus">-</span> Nolzu's text <span class="plus">+</span> yours</span>
        </header>
        {#if file.patch === null}
          <p class="quiet note">This file is a link, so Nolzu does not read it.</p>
        {:else}
          <div class="lines" aria-label="Diff of {file.path}">
            {#each numberedLines(file.patch) as line, index (index)}
              <div class="ln" data-line={line.kind}><span class="no">{line.old ?? ''}</span><span class="no">{line.new ?? ''}</span><span class="sg">{line.sign}</span><span class="c">{line.code}</span></div>
            {/each}
          </div>
        {/if}
        {#if file.gone}<p class="quiet note">Nolzu no longer ships this file. Take the new one removes it.</p>{/if}
        {#if asking === file.path}
          <form method="POST" action="?/take" class="acts ask" use:enhance={answer(file)}>
            <input type="hidden" name="path" value={file.path} />
            <input type="hidden" name="take" value="1" />
            <input type="hidden" name="sure" value="1" />
            <p class="said" role="alert" data-hand-ask>{unsavedLine(file.path)}</p>
            <Button size="small" variant="danger" type="submit" disabled={pending === file.path} data-hand-sure>Take the new one</Button>
            <Button size="small" onclick={() => unask(file.path)}>Cancel</Button>
          </form>
        {:else}
          <div class="acts">
            <form method="POST" action="?/take" use:enhance={answer(file)}>
              <input type="hidden" name="path" value={file.path} />
              <input type="hidden" name="take" value="1" />
              <Button size="small" type="submit" disabled={pending === file.path} data-hand-take>Take the new one</Button>
            </form>
            <form method="POST" action="?/keep" use:enhance={answer(file)}>
              <input type="hidden" name="path" value={file.path} />
              <Button size="small" type="submit" disabled={pending === file.path}>Keep mine</Button>
            </form>
          </div>
        {/if}
        {#if problem(file.path)}<p class="refused" role="alert">{problem(file.path)}</p>{/if}
      </li>
    {/each}
  </ul>
{/if}

<style>
  .quiet {
    max-width: 72ch;
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .hand {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  /* One file as the Changes tab draws a diff: its path on top, both line numbers, the sign, the line. */
  .file {
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
  }

  .fh {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: var(--space-2) 14px;
    border-bottom: 1px solid var(--line);
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
  }

  .key {
    color: var(--muted);
  }

  .plus {
    color: var(--green);
  }

  .minus {
    color: var(--red);
  }

  .lines {
    max-height: 360px;
    overflow-y: auto;
    padding: var(--space-1) 0;
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
  }

  /* A long line wraps, so the page never scrolls sideways. */
  .ln {
    display: grid;
    grid-template-columns: 40px 40px 18px minmax(0, 1fr);
    line-height: 21px;
  }

  .no {
    padding-right: var(--space-2);
    font-size: var(--mono-2xs);
    text-align: right;
    color: var(--muted);
  }

  .sg {
    text-align: center;
    color: var(--muted);
  }

  .c {
    color: var(--ink-2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  [data-line='add'] {
    background: var(--green-bg);
  }

  [data-line='add'] .sg {
    color: var(--green);
  }

  [data-line='del'] {
    background: var(--red-bg);
  }

  [data-line='del'] .sg {
    color: var(--red);
  }

  [data-line='add'] .c,
  [data-line='del'] .c {
    color: var(--ink);
  }

  [data-line='hunk'] {
    background: var(--blue-bg);
  }

  [data-line='hunk'] .c {
    color: var(--blue);
  }

  .note {
    padding: var(--space-2) 14px 0;
  }

  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) 14px;
    border-top: 1px solid var(--line);
  }

  .said {
    flex-basis: 100%;
    margin: 0;
    font-size: var(--text-xs);
    color: var(--ink);
  }

  .refused {
    margin: 0 14px var(--space-2);
    padding: 4px 8px;
    border-left: 2px solid var(--red);
    background: var(--card);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  @media (max-width: 760px) {
    .ln {
      grid-template-columns: 32px 32px 14px minmax(0, 1fr);
    }
  }
</style>
