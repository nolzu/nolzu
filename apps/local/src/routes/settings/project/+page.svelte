<script lang="ts">
  import FeaturePanels from '$lib/FeaturePanels.svelte';
  import FeatureSettings from '$lib/FeatureSettings.svelte';
  import ProjectsList from '$lib/ProjectsList.svelte';
  import { settingsTitle } from '$lib/settings-sections.ts';
  import type { ActionData, PageData } from './$types';

  // `PageData` and not `PageServerData`: the plan comes from the layout load, and this is where that
  // data is already on the page.
  let { data, form }: { data: PageData; form: ActionData } = $props();

  // The sentence is narrowed rather than defaulted: the answer only carries one when it refused,
  // and an empty alert would be a box with nothing in it.
  const refused = $derived(form !== null && 'message' in form && typeof form.message === 'string' ? { field: form.field, message: form.message, ask: 'ask' in form && form.ask === true, typed: form.typed, bill: form.bill } : null);
  const saved = $derived(form !== null && 'saved' in form ? form.field : null);
  const said = $derived(
    form !== null && 'said' in form && typeof form.said === 'string' ? { field: form.field, text: form.said, learn: 'learn' in form && typeof form.learn === 'string' ? form.learn : null } : null,
  );
</script>

<svelte:head><title>{settingsTitle('project')}</title></svelte:head>

<!-- Its own route and not a block of /settings/[section], because these are the forms of the old
     Projects page and their actions. The menu and the frame are the settings layout's. -->
<div class="stack">
  <section class="section" id="project" aria-labelledby="project-title">
    <header class="section-head"><h2 id="project-title">Project</h2></header>
    <ProjectsList row={data.project} table={data.table} found={data.found} branches={data.branches} {refused} {saved} {said} filesStatus={data.projectFiles ?? null} handEdits={data.handEdits} proposal={data.proposal} />

    <!-- The slot the paid package fills with the account's project list. It kept the name `projects`
         when the page moved here, because a package built for an older client names it so. -->
    <FeaturePanels name="projects" />
  </section>

  <!-- A feature's settings block has no page of its own, so it sits here under its anchor, where the
       settings menu and an old /settings#<id> link point. After the Project region and not in it,
       because a block is not part of Project. -->
  <FeatureSettings />
</div>

<style>
  .stack,
  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* The paid package draws this list itself and can bring no stylesheet, so the page styles it. */
  .section :global(ul.nolzu-pro-projects) {
    margin: 0;
    padding: 12px 14px;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    font-size: var(--text-sm);
    color: var(--ink);
  }
</style>
