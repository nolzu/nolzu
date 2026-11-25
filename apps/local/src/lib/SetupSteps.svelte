<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { bannerSteps, type SetupStep } from '@nolzu/protocol';
  import { postWrite } from './ticket.ts';

  // Set up the project. `banner` is the compact line on the boards and on Now, which shows each
  // open required and recommended step until it is done or put away. `list` is every step on the
  // first task screen. A recommended or optional step can be put away one by one; the required one cannot.
  let { steps, variant }: { steps: readonly SetupStep[]; variant: 'banner' | 'list' } = $props();

  const shown = $derived(variant === 'banner' ? bannerSteps(steps) : steps);
  // Where each step is done: the route and the section on it.
  const WHERE = {
    learn: ['/knowledge', '#learn-repos'],
    commands: ['/settings/project', '#commands'],
    qa: ['/settings/project', '#browser'],
    tickets: ['/settings/project', '#tickets'],
  } as const;
  const NEED = { required: 'Required', recommended: 'Recommended', optional: 'Optional' } as const;
  let problem = $state<string | null>(null);

  // The Now stream redraws the banner; the first task screen reads its steps off its load.
  async function putAway(step: SetupStep): Promise<void> {
    problem = await postWrite(fetch, resolve('/api/setup'), { step: step.id, mark: 'dismissed' });
    if (problem === null) await invalidateAll();
  }
</script>

{#if shown.length > 0}
  <section class="setup {variant}" aria-labelledby="setup-title-{variant}" data-setup={variant}>
    <h2 id="setup-title-{variant}">Set up the project</h2>
    {#if variant === 'list'}<p class="sub">Learn your repositories comes before the first run. The others make runs better.</p>{/if}
    <ul>
      {#each shown as step (step.id)}
        <li class:done={step.state !== 'open'} data-step={step.id}>
          <span class="mark" aria-hidden="true">{#if step.state === 'done'}<svg viewBox="0 0 24 24"><path d="m5 12 5 5 9-10"></path></svg>{/if}</span>
          <span class="words">
            <span class="head">
              <!-- The list has the step's own link beside it, so its title is plain text: one Tab stop per place. -->
              {#if step.state === 'open' && variant === 'banner'}<a href="{resolve(WHERE[step.id][0])}{WHERE[step.id][1]}">{step.title}</a>{:else}<span>{step.title}</span>{/if}
              <span class="need" class:required={step.need === 'required'}>{step.state === 'done' ? 'Done' : step.state === 'dismissed' ? 'Put away' : NEED[step.need]}</span>
            </span>
            {#if variant === 'list'}<span class="says">{step.says}</span>{/if}
          </span>
          {#if step.state === 'open'}
            <span class="acts">
              {#if variant === 'list'}<a class="go" href="{resolve(WHERE[step.id][0])}{WHERE[step.id][1]}">{step.go}</a>{/if}
              {#if step.need !== 'required'}
                <button type="button" class="away" onclick={() => putAway(step)} aria-label="Put away {step.title}">{variant === 'list' ? 'Put away' : ''}{#if variant === 'banner'}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>{/if}</button>
              {/if}
            </span>
          {/if}
        </li>
      {/each}
    </ul>
    {#if problem !== null}<p class="refused" role="alert">{problem}</p>{/if}
  </section>
{/if}

<style>
  .setup {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    color: var(--ink);
    font-size: var(--text-sm);
  }

  h2 {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: 600;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: var(--space-2) var(--space-3);
  }

  .words {
    display: flex;
    flex: 1 1 240px;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
  }

  a {
    color: var(--ink);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .need,
  .says,
  .sub {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .sub {
    margin: 0;
  }

  /* Required is said in words and in weight, never by colour alone. */
  .need.required {
    color: var(--ink);
    font-weight: 600;
  }

  .mark {
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border: 1px solid var(--line-2);
    border-radius: 50%;
  }

  .done .mark {
    border-color: transparent;
    background: var(--green-bg);
    color: var(--green);
  }

  svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .away {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    /* 24px at the least, so the banner's x is easy to hit. */
    min-width: 24px;
    min-height: 24px;
    padding: 2px 6px;
    border: 0;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
  }

  .away:hover {
    color: var(--ink);
  }

  .refused {
    margin: 0;
    color: var(--red);
    font-size: var(--text-sm);
  }

  /* The banner: one quiet box under the offline banner's place, the steps in a row that wraps. */
  .banner {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2) var(--space-4);
    margin: var(--space-3) var(--space-6) 0;
    padding: 8px 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-lg);
    background: var(--card);
  }

  .banner ul {
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
  }

  .banner li {
    align-items: center;
    gap: 6px;
  }

  .banner .words {
    flex: none;
  }

  .banner .mark {
    display: none;
  }

  /* The list on the first task screen, in the frame of its two choices. */
  .list {
    padding: 20px 22px;
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
  }

  .list h2 {
    font-size: var(--text-lg);
  }

  /* The links end in one column: Put away has a track of its own, empty on the required row. */
  .list li {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto;
    padding-top: var(--space-2);
    border-top: 1px solid var(--line);
  }

  .acts {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .list .acts {
    display: grid;
    grid-template-columns: auto 5.5rem;
  }

  .list .away {
    grid-column: 2;
  }

  .go {
    font-size: var(--text-sm);
  }

  @media (max-width: 760px) {
    .banner {
      margin-inline: var(--space-4);
    }

    .list {
      padding: 16px;
    }

    /* On a phone the links go under the step's words, not under its circle. */
    .list li {
      grid-template-columns: 18px minmax(0, 1fr);
    }

    .list .acts {
      grid-column: 2;
      justify-self: start;
    }
  }
</style>
