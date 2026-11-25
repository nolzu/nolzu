<script lang="ts">
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { featureSettings } from '$lib/features.svelte.ts';
  import SettingsMenu from '$lib/SettingsMenu.svelte';
  import { savesOnChange, sectionOf } from '$lib/settings-sections.ts';
  import type { Snippet } from 'svelte';
  import type { LayoutData } from './$types';

  let { data, children }: { data: LayoutData; children: Snippet } = $props();

  const href = (section: string) => resolve('/settings/[section]', { section });
  const features = $derived(featureSettings().map((block) => ({ id: block.id, title: block.title, href: `${resolve('/settings/project')}#${block.id}` })));
  // Project and Phase instructions have routes of their own, so their id is no param there.
  const current = $derived(page.params.section ?? sectionOf(page.route.id?.replace('/settings/', '') ?? '')?.id ?? null);
  const saves = $derived(savesOnChange(current));
</script>

<!-- The settings frame: the top bar, then the section list beside the open section. -->
<div class="top">
  <h1>Settings</h1>
  <span class="sp"></span>
  <!-- Models says when a change counts, since its bar still offers Save as new preset. -->
  {#if saves}<span class="sub">{current === 'models' ? 'Changes reach the next run' : 'Saved as you change it'}</span>{/if}
</div>

<div class="page" data-settings-page>
  <SettingsMenu {current} {href} {features} engines={data.enginesFound} />
  <div class="content">
    {@render children()}
  </div>
</div>

<style>
  .top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    box-sizing: border-box;
    min-height: 54px;
    padding: 0 var(--space-6);
    border-bottom: 1px solid var(--line);
  }

  h1 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .sp {
    flex: 1;
  }

  .sub {
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .page {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 32px;
    padding: 28px 32px 40px;
  }

  /* No 920px cap: a page fills the width beside the rail (width.test.ts). */
  .content {
    flex: 999 1 640px;
    min-width: 0;
  }

  /* The section title and its line, which every section page draws first. */
  .content :global(.section-head) {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .content :global(.section-head h2) {
    margin: 0;
    font-size: var(--text-xl);
    line-height: 1.15;
    font-weight: 600;
    letter-spacing: -0.025em;
  }

  .content :global(.section-head p) {
    margin: 0;
    font-size: var(--text-base);
    color: var(--muted);
  }

  /* The document is the scroller, so a jump from the menu to a box glides there. Under reduced motion
     the rule is not set, and the jump is instant. */
  @media (prefers-reduced-motion: no-preference) {
    :global(html:has([data-settings-page])) {
      scroll-behavior: smooth;
    }
  }

  @media (max-width: 760px) {
    .top {
      padding: 12px 16px;
    }

    .page {
      padding: 20px 16px;
    }
  }
</style>
