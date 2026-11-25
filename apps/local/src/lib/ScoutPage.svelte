<script lang="ts">
  import { resolve } from '$app/paths';
  import type { DisplayEntitlement } from '@nolzu/protocol';
  import { Button } from '@nolzu/ui';
  import type { ComponentProps } from 'svelte';
  import type { ScoutFindingDetail as Detail } from '$lib/scout-detail.ts';
  import type { ScoutFindingsView } from '$lib/scout-findings.ts';
  import type { ScoutSection } from '$lib/scout-sources.ts';
  import ScoutFindingDetail from '$lib/ScoutFindingDetail.svelte';
  import ScoutFindings from '$lib/ScoutFindings.svelte';
  import ScoutFirstVisit from '$lib/ScoutFirstVisit.svelte';
  import ScoutSources from '$lib/ScoutSources.svelte';

  // The Scout page: the top bar with Check all sources, the sources strip,
  // and the inbox in two panes, the findings on the left and the selected one on the right. `/scout`
  // selects the finding seen last, and `/scout/f/<id>` selects its own. With no source yet it is the
  // first visit. A source is added and changed in the Add a source dialog, which the strip opens.
  //
  // What a form answered. The source forms answer with `field` and the finding buttons with `did`.
  interface Answer {
    field?: string;
    saved?: boolean;
    message?: string | null;
    checked?: string | null;
    failed?: readonly string[];
    did?: string;
    said?: string;
    problem?: string;
  }
  let {
    data,
    form,
    detail,
  }: {
    data: { findings: ScoutFindingsView; scout: ScoutSection; display: DisplayEntitlement; githubOwner?: Promise<string | null> | string | null };
    form: Answer | null | undefined;
    detail: Detail | null;
  } = $props();

  const hasSources = $derived(data.scout.rows.length > 0);

  // The source dialog: Add source opens it on a new source, a strip entry and its Fix on that source.
  let open = $state<{ id: number } | { kind: string } | null>(null);
  // What the dialog held when it last closed without a save, so the next open of the same source shows it again.
  let sourceDraft = $state<ComponentProps<typeof ScoutSources>['draft']>(null);
  const openRow = $derived.by(() => {
    const at = open;
    return at !== null && 'id' in at ? (data.scout.rows.find((one) => one.id === at.id) ?? null) : null;
  });

  // One line per thing the person did to a source, because each leaves the screen in another state.
  const SOURCE_SAID: Record<string, string> = {
    add: 'The source is added.',
    save: 'Saved. The next check of that source uses it.',
    remove: 'The source is removed.',
    'remove-here': 'The source is removed here. Nolzu cloud could not be told, so it may keep the schedule. It checks no source yet, so that changes nothing today.',
    schedule: 'Saved, and Nolzu cloud has the schedule. It checks no source yet, so keep using Check now.',
    'schedule-here': 'Saved on this machine. Nolzu cloud does not have it yet. Keep using Check now.',
    'schedule-off-here': 'Stopped on this machine. Nolzu cloud could not be told, so it may keep the old schedule. Save Off again once the link is back. It checks no source yet, so that changes nothing today.',
  };
  // A check says how many findings are new and how many were met again, so its line is built by the
  // check and travels with the answer. Check all sources answers the same way.
  const sourceSaid = $derived.by(() => {
    if (form?.field === undefined || form.saved !== true) return '';
    if (form.field === 'check' || form.field === 'checkAll') return form.checked ?? '';
    // "Add and check now" answers with the check's line after the add's.
    return [SOURCE_SAID[form.field] ?? '', form.checked ?? ''].filter((line) => line !== '').join(' ');
  });
  // The source forms post one shape, so the page says its refusal once rather than under a field.
  const sourceProblem = $derived(form?.field === undefined ? null : (form.message ?? null));
  // The sources a press of Check all sources could not read, one line each, named by their label.
  const failed = $derived(form?.field === 'checkAll' ? (form.failed ?? []) : []);

  // What a finding button answered, which prints under the buttons of the finding it is about.
  type Pressed = 'dismiss' | 'unmute' | 'assess' | 'start';
  const said = (...from: Pressed[]) => (form?.did !== undefined && (from as string[]).includes(form.did) ? (form.said ?? '') : '');
  const problem = (...from: Pressed[]) => (form?.did !== undefined && (from as string[]).includes(form.did) ? (form.problem ?? null) : null);

  // The address of one finding's own page, which is this page with that finding selected.
  const finding = (id: number) => resolve('/scout/f/[id]', { id: String(id) });
  // The card a started finding is on, at the address the board opens a card at.
  const card = (key: string) => resolve('/t/[key]', { key: encodeURIComponent(key) });

  const ICONS = {
    lock: ['M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z', 'M8 11V8a4 4 0 0 1 8 0v3'],
    check: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 4v7h-7'],
    add: ['M12 5v14M5 12h14'],
  };
</script>

{#snippet icon(paths: readonly string[])}
  <svg class="ico" viewBox="0 0 24 24" aria-hidden="true">{#each paths as d (d)}<path {d}></path>{/each}</svg>
{/snippet}

<div class="scout">
  <div class="top">
    <h1>Scout</h1>
    <span class="ro">{@render icon(ICONS.lock)}Read-only. Scout never changes code.</span>
    <span class="sp"></span>
    <!-- Reads every source that a press can read. The palette's "Check every Scout source now" presses
         this form, so both answer the same way. A check runs only on a press like this one. -->
    {#if hasSources}
      <form method="POST" action="?/checkAll#sources" data-check-all>
        <Button type="submit">{@render icon(ICONS.check)}Check all sources</Button>
      </form>
    {/if}
  </div>

  {#if !hasSources}
    <!-- Removing the last source lands here, so its answer prints here too. -->
    <div class="said"><p class="ok" role="status">{sourceSaid}</p></div>
    <ScoutFirstVisit scout={data.scout} problem={sourceProblem} owner={data.githubOwner ?? null} />
  {:else}
    <!-- Each source with its state. An old /settings/scout link lands here at #sources, and the source
         forms post back to it, so their answers print right under it. -->
    <div class="srcs" role="group" id="sources" aria-labelledby="sources-title">
      <span class="srcs-l" id="sources-title">Sources</span>
      {#each data.scout.rows as row (row.id)}
        {#if row.error !== null}
          <!-- What failed is said in full in the source's dialog. Red is the state, and the words say it too. -->
          <span class="src err"
            ><span class="sd" aria-hidden="true"></span>{row.label}<span class="t">check failed</span><button type="button" class="fix" aria-label="Fix {row.label}" onclick={() => (open = { id: row.id })}
              >Fix</button
            ></span
          >
        {:else}
          <button type="button" class="src" class:never={row.checkedAt === null} onclick={() => (open = { id: row.id })}>
            <span class="sd" aria-hidden="true"></span>{row.label}<span class="t">{row.checkedAt === null ? 'not checked yet' : `checked ${row.checkedAt}`}</span>
          </button>
        {/if}
      {/each}
      <button type="button" class="add" aria-haspopup="dialog" onclick={() => (open = { kind: '' })}>{@render icon(ICONS.add)}Add source</button>
    </div>
    <div class="said">
      {#if sourceProblem !== null}<p class="refused" role="alert">{sourceProblem}</p>{/if}
      {#each failed as line, index (index)}<p class="refused">{line}</p>{/each}
      <p class="ok" role="status">{sourceSaid}</p>
    </div>

    <div class="inbox">
      <ScoutFindings view={data.findings} selected={detail?.row.id ?? null} href={finding} />
      {#if detail !== null}
        <ScoutFindingDetail
          {detail}
          self={finding(detail.row.id)}
          cardHref={card}
          said={said('dismiss', 'unmute', 'assess', 'start')}
          problem={problem('dismiss', 'unmute', 'assess', 'start')}
        />
      {/if}
    </div>

  {/if}
</div>

{#if open !== null && ('kind' in open || openRow !== null)}
  <ScoutSources forms={data.scout.forms} row={openRow} kind={'kind' in open ? open.kind : ''} onclose={() => (open = null)} bind:draft={sourceDraft} />
{/if}

<style>
  .scout {
    display: flex;
    flex-direction: column;
    min-height: calc(100vh - var(--offline-height, 0px));
  }

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

  .ico {
    flex: none;
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* Blue is the info pill: a fact about the page, not a state of a run. */
  .ro {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 var(--space-2);
    border-radius: 99px;
    background: var(--blue-bg);
    color: var(--blue);
    font-size: var(--text-xs);
    font-weight: 500;
    white-space: nowrap;
  }

  .srcs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    padding: 10px var(--space-6);
    border-bottom: 1px solid var(--line);
  }

  .srcs-l {
    margin-right: var(--space-1);
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .src {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    box-sizing: border-box;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    background: var(--panel);
    color: var(--ink-2);
    font-size: var(--text-xs);
    text-decoration: none;
    white-space: nowrap;
  }

  .sd {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--green);
  }

  /* Not checked yet is no state to colour: a ring and the words. */
  .src.never .sd {
    box-sizing: border-box;
    border: 1.5px solid var(--line-2);
    background: transparent;
  }

  .t {
    font-family: var(--font-mono);
    font-size: var(--mono-2xs);
    color: var(--muted);
  }

  .src.err {
    border-color: oklch(from var(--red) l c h / 0.45);
  }

  .src.err .sd {
    background: var(--red);
  }

  .src.err .t {
    color: var(--red);
  }

  button.src {
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }

  button.src:hover {
    background: var(--card);
  }

  .fix {
    padding: 0;
    border: 0;
    background: none;
    color: var(--blue);
    font: inherit;
    text-decoration: underline;
    text-underline-offset: 2px;
    cursor: pointer;
  }

  .add {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 9px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--ink-2);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .add:hover {
    background: var(--panel);
  }

  .said {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 0 var(--space-6);
  }

  .said p {
    margin: var(--space-2) 0 0;
    font-size: var(--text-xs);
  }

  .ok {
    color: var(--muted);
  }

  /* Empty until a source form answers, and still in the page, so it is a live region from the start. */
  .ok:empty {
    margin: 0;
  }

  .refused {
    padding-left: 10px;
    box-shadow: inset 2px 0 0 var(--red);
    color: var(--ink);
  }

  .inbox {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  @media (max-width: 760px) {
    .top,
    .srcs,
    .said {
      padding-right: var(--space-4);
      padding-left: var(--space-4);
    }

    .top {
      padding-top: var(--space-3);
      padding-bottom: var(--space-3);
    }

    .inbox {
      flex-direction: column;
    }

  }
</style>
