<script lang="ts">
  import { enhance } from '$app/forms';
  import { invalidateAll } from '$app/navigation';
  import { resolve } from '$app/paths';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { AGENT_SLOTS } from '@nolzu/core';
  import { SCOUT_AND_EVIDENCE } from '@nolzu/protocol';
  import { Button, SlotsMeter } from '@nolzu/ui';
  import { copyText } from '$lib/clipboard.ts';
  import type { ToolRow } from '$lib/engine-profiles.ts';
  import EngineProfiles from '$lib/EngineProfiles.svelte';
  import EngineTools from '$lib/EngineTools.svelte';
  import ModelsSection from '$lib/ModelsSection.svelte';
  import CloudLinks from '$lib/CloudLinks.svelte';
  import CloudStatus from '$lib/CloudStatus.svelte';
  import DataSync from '$lib/DataSync.svelte';
  import { accountHref, shows, webTeamHref } from '$lib/display.ts';
  import { nowLive } from '$lib/now-live.svelte.ts';
  import { settingsTitle } from '$lib/settings-sections.ts';
  import { postWrite } from '$lib/ticket.ts';
  import type { ActionData, PageData } from './$types';

  // `PageData` and not the page's own load, because the signed display document comes from the layout
  // and this screen may not ask the server for a second one.
  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Whether this plan includes the cloud board. The hub decides whether a socket is served, not this:
  // `startHubLink` dials on the device token alone and the hub closes with `PLAN_REFUSED` for a plan
  // it will not serve. So What goes to a hub says what the plan bought, and Cloud draws Free or
  // Solo from it, with what the socket is doing in either.
  const canSync = $derived(shows(data.display, 'cloud-board'));

  // The account and the Team page, which the rail does not draw. Each from the signed
  // document, through the one module that reads it.
  const account = $derived(accountHref(data.display, data.cloud));
  const team = $derived(webTeamHref(data.display, data.cloud) === null ? null : resolve('/team'));

  // The rule a value was refused with, under the row it belongs to. The section is part of it, so a
  // refusal from one section never prints under a row of another that happens to share a field name.
  const problem = (section: string, field: string) =>
    form?.section === section && form.field === field && 'message' in form ? form.message : null;
  const savedField = $derived(form !== null && 'saved' in form ? form.field : null);
  // Each section says its own word, and the answer names the section it comes from, so a line under
  // Runs is never about a row in Models and no list of field names can go stale here.
  const savedIn = $derived(form !== null && 'saved' in form ? form.section : null);
  const MODELS_SAID: Record<string, string> = {
    models: 'Saved. Runs in this project use it from the next start.',
    named: 'Saved as a new preset, now in use. Nothing on the board changed.',
    removed: 'The preset is gone. Every phase still runs what it ran.',
    renamed: 'The preset is renamed. Nothing on the board changed.',
    replaced: 'The preset now holds every phase as it runs. Nothing on the board changed.',
  };
  const modelsSaid = $derived(savedIn !== 'models' || savedField === null ? '' : (MODELS_SAID[savedField] ?? ''));
  // The quiet time is read by the board, not by a run, and an open board takes it at once.
  const runsSaid = $derived(savedIn !== 'runs' ? '' : savedField === 'quiet' ? 'Saved. Open boards use it now.' : 'Saved. The next run uses it.');
  // One line per thing the person did to a profile, because the three leave the screen in three
  // states. The add line names the id, because a row that names that id runs on this profile, and a
  // label used before makes the id it made before.
  const savedProfile = $derived(form !== null && 'id' in form ? form.id : null);
  const profileLine = (did: string): string => {
    if (did === 'add') return `The profile is added as ${savedProfile}. A row that names this id runs on it.`;
    if (did === 'rename') return 'The label is changed. Every stored choice still points at this profile.';
    if (did === 'remove') return 'The profile is removed. Every row that pointed at it now says it has no login on this machine.';
    return '';
  };
  const profilesSaid = $derived(savedIn !== 'engines' || savedField === null ? '' : profileLine(savedField));
  // The profile forms post one shape, so the section says its refusal once rather than under a field.
  const profilesProblem = $derived(form !== null && 'message' in form && form.section === 'engines' ? form.message : null);
  const knowledgeSaid = $derived(savedIn === 'knowledge' ? 'Saved. The next knowledge run follows it.' : '');
  // How many slots are busy, off the Now stream the layout keeps open, so the meter beside the stepper
  // counts what the scheduler runs and never a guess.
  const slotsNow = $derived(nowLive.state.snapshot?.boards[0]?.slots ?? null);
  const waits = $derived(data.agents?.waits ?? []);
  const RETRY_BOXES = ['First retry, minutes', 'Second retry, minutes', 'Third retry, minutes'];
  // A refused row keeps the value the message is about, not the stored one it says nothing about.
  const shown = (field: string, stored: number) => (form?.field === field && 'typed' in form ? form.typed : String(stored));

  // Enter in a text row fires change, which submits, and then the browser submits the form itself. The
  // second post is dropped, so one keystroke is one save.
  const going = new WeakSet<HTMLFormElement>();
  // No reset: the number the person typed stays on screen, refused or stored.
  const write: SubmitFunction = ({ formElement, cancel }) => {
    if (going.has(formElement)) return cancel();
    going.add(formElement);
    return async ({ update }) => {
      await update({ reset: false });
      going.delete(formElement);
    };
  };
  const submit = (event: Event) => (event.currentTarget as HTMLElement).closest('form')?.requestSubmit();

  // Start Nolzu when I log in. The switch shows what the load read off the disk, read again after each
  // press, so a refused press springs back and never claims an item that is not there.
  let loginGoing = $state(false);
  let loginRefused = $state<string | null>(null);
  async function startAtLogin(event: Event): Promise<void> {
    const box = event.currentTarget as HTMLInputElement;
    loginGoing = true;
    loginRefused = await postWrite(fetch, resolve('/api/login-item'), { on: box.checked });
    await invalidateAll();
    loginGoing = false;
    box.checked = data.login?.on ?? false;
  }
  // Held with aria-disabled and not disabled while a press goes, so the switch keeps the keyboard focus.
  const loginHeld = (event: Event): void => {
    if (loginGoing) event.preventDefault();
  };

  // The look at the tools: the load starts it, and Look again loads the page data again, which starts
  // a new one. The time is when this page got the answer.
  let tools = $state<ToolRow[] | null>(null);
  let lookFailed = $state(false);
  let lookedAt = $state<number | null>(null);
  $effect(() => {
    const look = data.engines;
    if (look === null || look === undefined) return;
    tools = null;
    lookFailed = false;
    look.then(
      (found) => {
        tools = found;
        lookedAt = Date.now();
      },
      () => (lookFailed = true),
    );
  });
  // A Check login answer posted without the page's script, for the row it is about.
  const checked = $derived(form !== null && 'check' in form ? form.check : null);

  // The Solo panel of Cloud. The plan comes from the signed document, which decides what is drawn and
  // nothing else (AGENTS.md rule 2).
  const seats = (count: number) => `${count} ${count === 1 ? 'seat' : 'seats'}`;
  const planWord = $derived(data.display.plan === 'team' ? `Team, ${seats(data.display.seats)}` : data.display.plan === 'solo' ? 'Solo' : 'Free');
  const clockOf = (ms: number): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(ms));
  // A press that changed nothing: the link was dialling or reading its sign-in, or was no longer Offline
  // by the time the press arrived.
  const notDialled = $derived(form !== null && 'dialled' in form && !form.dialled);
  let copied = $state('');
  const copy = async (command: string): Promise<void> => {
    copied = (await copyText(command)) ? 'Copied.' : 'The browser did not copy it. Select the command and copy it by hand.';
  };
</script>

{#snippet terminal(command: string)}
  <div class="cmd">
    <span class="prompt" aria-hidden="true">$</span><code>{command}</code>
    <Button size="small" variant="ghost" aria-label="Copy {command}" onclick={() => copy(command)}
      ><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"></path></svg>Copy</Button
    >
  </div>
{/snippet}

<svelte:head><title>{settingsTitle(data.section)}</title></svelte:head>

<!-- One section per page. The menu and the container around it are the settings layout's. -->
<div class="sections">
  {#if data.agents !== null}
    <!-- Runs. Each control saves on change and writes the setting it wrote before. -->
    <section id="runs" aria-labelledby="runs-title">
      <header class="section-head"><h2 id="runs-title">Runs</h2></header>
      <div class="rows">
        <form method="POST" action="?/runs" class="st" use:enhance={write}>
          <input type="hidden" name="field" value="slots" />
          <span class="lb" id="slots-label">Agent slots</span>
          <div class="c">
            <div class="line wide">
              <!-- Each button posts the count it leads to, so a press is one save with no script too. -->
              <div class="step" role="group" aria-labelledby="slots-label">
                <button type="submit" name="value" value={data.agents.slots - 1} disabled={data.agents.slots <= AGENT_SLOTS.min} aria-label="One slot fewer">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
                </button>
                <output aria-live="polite">{data.agents.slots}</output>
                <button type="submit" name="value" value={data.agents.slots + 1} disabled={data.agents.slots >= AGENT_SLOTS.max} aria-label="One slot more">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
                </button>
              </div>
              {#if slotsNow !== null}<SlotsMeter slots={slotsNow} />{/if}
            </div>
            <p class="hint">Runs that go at once on this machine, {AGENT_SLOTS.min} to {AGENT_SLOTS.max}. Each run is a whole CLI process.</p>
            {#if problem('runs', 'slots')}<p class="refused" role="alert">{problem('runs', 'slots')}</p>{/if}
          </div>
        </form>

        <form method="POST" action="?/runs" class="st" use:enhance={write}>
          <input type="hidden" name="field" value="timeout" />
          <label class="lb" for="timeout">Run timeout</label>
          <div class="c">
            <div class="line"><input id="timeout" name="value" class="num" inputmode="numeric" value={shown('timeout', data.agents.timeoutMinutes)} onchange={submit} /><span class="ink2">minutes</span></div>
            <!-- No wall-clock limit exists, so the line names the silence the timer counts. -->
            <p class="hint">A run that prints nothing this long stops, and its card fails.</p>
            {#if problem('runs', 'timeout')}<p class="refused" role="alert">{problem('runs', 'timeout')}</p>{/if}
          </div>
        </form>

        <div class="st">
          <label class="lb" for="retry">Retry on API errors</label>
          <div class="c">
            <!-- The switch writes the default waits or none. Each box is its own form and writes its
                 place in the same wait list, so one change is one save. -->
            <div class="line tall">
              <form method="POST" action="?/runs" class="wait" use:enhance={write}>
                <input type="hidden" name="field" value="retry" />
                <input id="retry" name="value" type="checkbox" role="switch" value="default" checked={waits.length > 0} onchange={submit} />
              </form>
              {#if waits.length > 0}
                <span class="ink2">after</span>
                {#each data.agents.boxes as wait, at (at)}
                  <form method="POST" action="?/runs" class="wait" use:enhance={write}>
                    <input type="hidden" name="field" value="wait{at + 1}" />
                    <label class="sr" for="wait{at + 1}">{RETRY_BOXES[at]}</label>
                    <input id="wait{at + 1}" name="value" class="num" inputmode="numeric" value={shown(`wait${at + 1}`, wait)} onchange={submit} />
                  </form>
                  {#if at < 2}<span class="ink2" class:comma={at === 0}>{at === 0 ? ',' : 'and'}</span>{/if}
                {/each}
                <span class="ink2">minutes</span>
              {/if}
            </div>
            <p class="hint">
              {waits.length > 0 ? 'Each retry resumes the same session. After the third, the card fails with the raw error.' : 'Off, the first API error fails the card.'}
            </p>
            {#each ['retry', 'wait1', 'wait2', 'wait3'] as field (field)}
              {#if problem('runs', field)}<p class="refused" role="alert">{problem('runs', field)}</p>{/if}
            {/each}
          </div>
        </div>

        <form method="POST" action="?/runs" class="st" use:enhance={write}>
          <input type="hidden" name="field" value="quiet" />
          <label class="lb" for="quiet">Call a run quiet</label>
          <div class="c">
            <div class="line"><span class="ink2">after</span><input id="quiet" name="value" class="num" inputmode="numeric" value={shown('quiet', data.agents.quietMinutes)} onchange={submit} /><span class="ink2">minutes with no output</span></div>
            <p class="hint">The card shows Quiet and how long, such as <span class="mono">Quiet {data.agents.quietMinutes}m</span>. The run keeps going.</p>
            {#if problem('runs', 'quiet')}<p class="refused" role="alert">{problem('runs', 'quiet')}</p>{/if}
          </div>
        </form>

        <form method="POST" action="?/runs" class="st" use:enhance={write}>
          <input type="hidden" name="field" value="keepAwake" />
          <label class="lb" for="keepAwake">Keep the machine awake while a run is going</label>
          <div class="c sw">
            <div class="line">
              <input id="keepAwake" name="value" type="checkbox" role="switch" checked={data.agents.keepAwake} onchange={submit} />
              <span class="hint">The screen can still turn off.</span>
            </div>
            {#if data.awake === false}<p class="hint">This system has no tool to keep it awake. Keep awake works on macOS, and on Linux with systemd-inhibit.</p>{/if}
            {#if problem('runs', 'keepAwake')}<p class="refused" role="alert">{problem('runs', 'keepAwake')}</p>{/if}
          </div>
        </form>

        {#if data.login !== null}
          <!-- Off by default and never turned on by itself. Not amber: nothing here
               starts an agent. -->
          <div class="st">
            <label class="lb" for="startAtLogin">Start Nolzu when I log in</label>
            <div class="c sw">
              <div class="line">
                <input id="startAtLogin" type="checkbox" role="switch" checked={data.login.on} disabled={!data.login.on && !data.login.canTurnOn} aria-disabled={loginGoing ? 'true' : undefined} aria-busy={loginGoing ? 'true' : undefined} onclick={loginHeld} onchange={startAtLogin} />
                {#if data.login.path === null}
                  <span class="hint">Nolzu has no login item on this system.</span>
                {:else if !data.login.on && !data.login.canTurnOn}
                  <span class="hint">Works only for a Nolzu the <code>nolzu</code> command started.</span>
                {:else if data.login.on}
                  <span class="hint">Nolzu starts when you log in. Off removes <code>{data.login.path}</code>.</span>
                {:else}
                  <span class="hint">Never turned on by itself.</span>
                {/if}
              </div>
              {#if loginRefused !== null}<p class="refused" role="alert">{loginRefused}</p>{/if}
            </div>
          </div>
        {/if}

        <p class="hint saved" class:said={runsSaid !== ''} role="status">{runsSaid}</p>
      </div>

      {#if data.knowledge !== null}
        <!-- The one Knowledge setting, at the foot of Runs. Its own action, so an
             old /settings/knowledge link lands here at #knowledge and the saved line prints under it. -->
        <section class="knowledge" id="knowledge" aria-labelledby="knowledge-title">
          <h3 id="knowledge-title">Knowledge</h3>

          <form method="POST" action="?/knowledge" class="st" use:enhance={write}>
            <input type="hidden" name="field" value="reviewKnowledge" />
            <label class="lb" for="reviewKnowledge">Review knowledge changes before they apply</label>
            <div class="c sw">
              <div class="line">
                <input id="reviewKnowledge" name="value" type="checkbox" role="switch" checked={data.knowledge.review} onchange={submit} />
                <span class="hint">
                  A change waits on the <a href={resolve('/knowledge')}>Knowledge screen</a>, with its diff and its card, until you approve it. Off, a
                  wrap-up commits what it wrote.
                </span>
              </div>
              {#if problem('knowledge', 'reviewKnowledge')}<p class="refused" role="alert">{problem('knowledge', 'reviewKnowledge')}</p>{/if}
            </div>
          </form>

          <p class="hint saved" class:said={knowledgeSaid !== ''} role="status">{knowledgeSaid}</p>
        </section>
      {/if}
    </section>
  {/if}

  {#if data.models !== null}
    <ModelsSection models={data.models} said={modelsSaid} refused={problem('models', 'models')} named={problem('models', 'named')} renamed={problem('models', 'renamed')} />
  {/if}

  {#if data.profiles !== null}
    <section id="engines" aria-labelledby="engines-title">
      <header class="section-head">
        <h2 id="engines-title">Engines</h2>
        <p>Runs use your own npm, git and shell setup from where Nolzu started.</p>
        {#if data.wall}<p>{data.wall}</p>{/if}
      </header>
      <EngineTools rows={tools} failed={lookFailed} {lookedAt} onlook={() => void invalidateAll()} />
      <EngineProfiles profiles={data.profiles} said={profilesSaid} problem={profilesProblem} {checked} refusedAdd={problem('engines', 'add') !== null} />
    </section>
  {/if}

  {#if data.hub !== null}
    <!-- Cloud: Free or Solo, from the signed document. -->
    <section id="cloud" aria-labelledby="cloud-title">
      <header class="section-head"><h2 id="cloud-title">Cloud</h2></header>
      {#if !canSync}
        <div class="plan-row"><h3>Free</h3><span class="hint">no account on this machine</span></div>
        <CloudStatus status={data.hub} free />

        <div class="two">
          <!-- Kept on Free: it shows only on this page, which a person opens on purpose. -->
          <div class="block" data-free="cloud">
            <!-- Solo and Team are not on sale yet, so the list says what comes and offers nothing to buy. -->
            <h3>Coming soon with Solo and Team</h3>
            <ul class="adds">
              <li><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"></rect><path d="M11 18h2"></path></svg><b>The phone</b><span>Open the board and answer a blocked agent.</span></li>
              <!-- Both read Evidence, which waits for a later version too. -->
              {#if SCOUT_AND_EVIDENCE}
                <li><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg><b>History</b><span>Evidence for every day, not only today.</span></li>
                <li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16M7 16v-5M12 16V6M17 16v-8"></path></svg><b>Reports</b><span>A weekly report, and cost per client.</span></li>
              {/if}
              <li><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20a6.5 6.5 0 0 1 13 0"></path><circle cx="17" cy="9" r="2.5"></circle><path d="M16 14.5a5 5 0 0 1 5.5 5"></path></svg><b>Team</b><span>Shared boards, seats and an audit log.</span></li>
            </ul>
          </div>

          <div class="block">
            <h3>Sign in from a terminal</h3>
            {@render terminal('npx nolzu@latest login')}
            <p class="hint" role="status">{copied}</p>
          </div>
        </div>

        <p class="hint">Free needs none of this. Everything on this machine works without an account.</p>
      {:else}
        <div class="panel">
          <CloudStatus status={data.hub} paused={data.paused ?? false} />
          {#if notDialled}<p class="said" role="status">Nolzu was dialling already, or the link was no longer Offline, so Connect again changed nothing.</p>{/if}
          {#if data.link !== null}
            <dl class="kv">
              <dt>Plan</dt>
              <dd>{planWord}</dd>
              <dt>Hub</dt>
              <dd class="mono">{data.link.host}</dd>
              <dt>This machine</dt>
              <dd class="mono">{data.link.machine}</dd>
              <dt>Last sync</dt>
              <dd>{#if data.link.lastSent === null}Nothing sent since Nolzu started{:else}<span class="mono">{clockOf(data.link.lastSent)}</span>{/if}</dd>
            </dl>
          {/if}
          <CloudLinks {account} {team} />
        </div>

        <div class="block">
          <h3>Sign out from a terminal</h3>
          {@render terminal('npx nolzu@latest logout')}
          <p class="hint" role="status">{copied}</p>
          <p class="hint">Your cloud data stays. Delete it on the web app, under Account.</p>
        </div>
      {/if}
      <!-- Every message this machine can send to a hub, one box on every plan. -->
      <DataSync {canSync} team={data.team ?? false} />
    </section>
  {/if}
</div>

<style>
  .sections,
  section {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  #runs {
    gap: var(--space-6);
  }

  .panel {
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    background: var(--panel);
    overflow: hidden;
  }

  /* A block and not a flex column, so its empty saved line adds no gap. */
  section.knowledge {
    display: block;
  }

  h3 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
    font-weight: 600;
  }

  /* The setting rows of Runs: the label on the left, the control and its hint on the right. */
  .st {
    display: grid;
    grid-template-columns: 320px minmax(0, 1fr);
    gap: 6px 28px;
    align-items: start;
    padding: 14px 0;
    border-top: 1px solid var(--line);
  }

  .rows > .st:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .lb {
    padding-top: 7px;
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--ink);
  }

  .c {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .c.sw {
    padding-top: 7px;
  }

  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .line.wide {
    gap: var(--space-4);
  }

  .line.tall {
    gap: 10px;
    min-height: 34px;
  }

  /* The three boxes read as one sentence, so each one's name is for a screen reader. */
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .wait {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .ink2 {
    color: var(--ink-2);
    font-size: var(--text-sm);
  }

  /* A comma sits against the box before it. */
  .comma {
    margin-left: -8px;
  }

  .mono {
    font-family: var(--font-mono);
  }

  input.num {
    box-sizing: border-box;
    width: 56px;
    height: 34px;
    padding: 0 10px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--ink);
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    text-align: center;
  }

  .step {
    display: inline-flex;
    align-items: center;
    height: 34px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
    overflow: hidden;
  }

  .step button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--ink-2);
    cursor: pointer;
  }

  .step button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .step svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
  }

  .step output {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 34px;
    height: 32px;
    border-right: 1px solid var(--line);
    border-left: 1px solid var(--line);
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
  }

  /* A checkbox drawn as the shared Switch, so each form still posts without a script. On is cream and
     never amber: a setting starts no run. The knob moves too, so on and off are not colour alone. */
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

  input[role='switch']:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .hint {
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .hint a {
    color: var(--blue);
  }

  .hint code {
    font-family: var(--font-mono);
    font-size: var(--mono-xs);
    overflow-wrap: anywhere;
  }

  /* Cloud. */
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .block h3 {
    margin: 0;
  }

  .plan-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    padding-bottom: 10px;
    border-bottom: 1px dashed var(--line-2);
  }

  .plan-row h3 {
    margin: 0;
  }

  /* What an account adds beside the sign-in box, one under the other on a narrow screen. No width cap. */
  .two {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
    gap: var(--space-6);
    align-items: start;
  }

  .adds {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .adds li {
    display: grid;
    grid-template-columns: 16px 120px minmax(0, 1fr);
    gap: 12px;
    align-items: center;
    padding: 9px 0;
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .adds li:first-child {
    border-top: 0;
  }

  .adds b {
    font-weight: 500;
  }

  .adds span {
    color: var(--muted);
    font-size: var(--text-xs);
  }

  .adds svg,
  .cmd svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .adds svg {
    color: var(--muted);
  }

  .cmd {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 40px;
    padding: 0 6px 0 14px;
    border: 1px solid var(--line-2);
    border-radius: var(--radius-md);
    background: var(--bg);
  }

  .cmd code {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
    overflow-wrap: anywhere;
  }

  .prompt {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: var(--mono-sm);
  }

  .kv {
    display: grid;
    grid-template-columns: 140px minmax(0, 1fr);
    margin: 0;
    padding: 2px 16px 4px;
    border-top: 1px solid var(--line);
  }

  .kv dt,
  .kv dd {
    margin: 0;
    padding: 8px 0;
    border-top: 1px solid var(--line);
    font-size: var(--text-sm);
  }

  .kv dt:first-of-type,
  .kv dt:first-of-type + dd {
    border-top: 0;
  }

  .kv dt {
    color: var(--muted);
  }

  .kv dd {
    color: var(--ink);
    overflow-wrap: anywhere;
  }

  .kv .mono {
    font-size: var(--mono-sm);
  }

  .said {
    margin: 0;
    padding: 0 16px 10px;
    font-size: var(--text-xs);
    color: var(--ink);
  }

  .refused {
    margin: 0;
    padding-left: 10px;
    box-shadow: inset 2px 0 0 var(--red);
    font-size: var(--text-xs);
    color: var(--ink);
  }

  /* The region stays on the page so a screen reader reads what lands in it, but an empty one takes no room. */
  .saved.said {
    padding: var(--space-2) 0 10px;
  }

  @media (max-width: 760px) {
    .st {
      grid-template-columns: minmax(0, 1fr);
    }

    .lb {
      padding-top: 0;
    }
  }
</style>
