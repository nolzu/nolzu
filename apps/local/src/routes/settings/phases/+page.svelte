<script lang="ts">
  import { enhance } from '$app/forms';
  import { Button, HelpTip, InfoBox } from '@nolzu/ui';
  import { PHASE_HELP, PHASE_INSTRUCTION_HELP } from '@nolzu/protocol';
  import { settingsTitle } from '$lib/settings-sections.ts';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const refused = $derived(form !== null && 'message' in form ? form : null);
  const saved = $derived(form !== null && 'saved' in form ? form.phase : null);
  // A full page post would jump to the top of a long list. No reset, so the box keeps what was typed.
  const keep: SubmitFunction = () => async ({ update }) => update({ reset: false });
</script>

<svelte:head><title>{settingsTitle('phases')}</title></svelte:head>

<!-- Its own route and not a block of /settings/[section], because it writes files in the project
     folder and reads no setting. One form per phase. -->
<section class="section" id="phases" aria-labelledby="phases-title">
  <header class="section-head"><h2 id="phases-title">Phase instructions</h2></header>
  <InfoBox>
    <p>Your own instructions for a phase, added to every run of it on any engine. For example "plan.md must also have a Risks section".</p>
    <p>They can change the language and add sections, but not the file names and fields the skill writes.</p>
    <p>
      Each phase is a file in <span class="mono">.nolzu/phases</span> in the project folder. The skills read it too, so it also works without Nolzu. Commit the files to share them with your team. An empty Save deletes the file.
    </p>
  </InfoBox>
  {#if !data.hasFolder}<p class="refused" role="alert">This project has no folder, so there is nowhere to keep the files.</p>{/if}

  <!-- The rows in a box, as on the other settings pages. -->
  <div class="box">
    {#each data.phases as row (row.phase)}
      {@const help = PHASE_INSTRUCTION_HELP[row.phase]}
      <form method="POST" action="?/save" class="st" use:enhance={keep}>
        <input type="hidden" name="phase" value={row.phase} />
        <!-- The "?" sits beside the label and not in it, so a press on it does not focus the box. -->
        <div class="name">
          <label class="lb" for="phase-{row.phase}">{row.label}</label>
          {#if help}<HelpTip label="About {row.label}" text="{PHASE_HELP[row.phase] ?? ''} {help.writes} {help.use}" example={help.example} href="https://github.com/nolzu/nolzu/blob/main/docs/engines/README.md#a-projects-own-phase-instructions" />{/if}
        </div>
        <div class="c">
          <textarea id="phase-{row.phase}" name="text" rows="3" aria-describedby="phase-{row.phase}-help">{refused?.phase === row.phase ? refused.text : row.text}</textarea>
          <!-- Only the path: where the files live and what Save does is said once, in the info box. -->
          <p class="quiet mono" id="phase-{row.phase}-help">{row.path}</p>
          {#if row.cut}<p class="quiet">The file is longer than 16 KB. Runs read only the first 16 KB, which is what this box shows, so a Save keeps only that part.</p>{/if}
          {#if refused?.phase === row.phase}<p class="refused" role="alert">{refused.message}</p>{/if}
          {#if saved === row.phase}<p class="quiet" role="status">Saved.</p>{/if}
          <div><Button size="small" type="submit">Save</Button></div>
        </div>
      </form>
    {/each}
  </div>
</section>

<style>
  /* The file's path, in the mono face the other settings pages use for paths. */
  .mono {
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
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
    padding: 12px 14px;
  }

  .st + .st {
    border-top: 1px solid var(--line);
  }

  .name {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .lb {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
  }

  .c {
    display: grid;
    gap: 6px;
  }

  textarea {
    box-sizing: border-box;
    width: 100%;
    min-height: 88px;
    padding: 10px var(--space-3);
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    line-height: 1.5;
    resize: vertical;
  }

  /* The muted token and not an opacity: faint text loses the contrast rule. */
  .quiet {
    max-width: 72ch;
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .refused {
    margin: 0;
    padding-left: 10px;
    box-shadow: inset 2px 0 0 var(--red);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  @media (max-width: 760px) {
    .st {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
