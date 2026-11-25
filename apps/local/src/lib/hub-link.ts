import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, registeredProjects, resolveDataDir, scoutSources, writeSetting } from '@nolzu/core/node';
import { CLOUD_OPEN, type DisplayEntitlement, hubEnvelope, isFakeMode, type ProjectSync, type RunnerMessageType, type ScoutSchedule, SERVER_MESSAGES } from '@nolzu/protocol';
import { connectToHub, createKeychain, type HubConnection, type HubSocket, type HubStatus, hubUrl, type Keychain, runKeychain, teamHubUrl } from '@nolzu/runner';
import { projectName } from './app-header.ts';
import { HUB_PROJECTS_FEATURE, shows } from './display.ts';
import { heldDisplay } from './display-sync.ts';
import { type HubJobMark, takeHubJob } from './hub-jobs.ts';
import { createHubSync, EVIDENCE_DAYS_ON_OPEN, type HubSync, recentDays } from './hub-sync.ts';
import type { Loop } from './loop.ts';

// The one place the client dials its hub. It runs from `hooks.server.ts`, in the server bundle, because
// the loop is one object per data directory and a second dial from the CLI would build a second loop
// over the same database and be refused by the writer lock.
//
// One machine, one personal socket and one team socket per team project. The personal hub is always
// dialled, and each project that has joined a team dials the team hub beside it, on a path of its own.
// `connectHub` keeps its retry wait, its heartbeat and its give-up inside one call, so the sockets are
// independent and a team hub that turns this machine down costs the personal socket nothing.

export interface HubLink {
  // What the personal connection is doing now. The screens read it; `closed` is a machine with no account
  // and a machine whose keychain would not open, because neither has a connection to report on. A team
  // socket beside it has a state of its own and no screen: `startHubLink` says why.
  status: () => HubStatus;
  // What the team connections are doing: a refusal on any of them first, and `closed` on a machine that
  // has joined no team. Not for a screen: `status` above is the one a screen reads. `dialHubAgain` needs
  // it, because a team socket that gave up has no other way back.
  teamStatus: () => HubStatus;
  // One frame from this machine to its own hub, or false when there is no socket to put it on. `project`
  // is the registry id the frame names, the start project when left out.
  send: (type: RunnerMessageType, payload: unknown, project?: number) => boolean;
  // The same, to the team hub of that project. False for a project that has joined no team and for one
  // whose team socket is not open, because neither has a wire to put the frame on.
  sendTeam: (type: RunnerMessageType, payload: unknown, project?: number) => boolean;
  // Serves a project registered after the link started: its `project.sync`, its board, and its team
  // socket on a team project.
  projectsChanged: () => void;
  close: () => void;
  // Settles once the personal dial has read the keychain, so its status is past the `closed` every link
  // starts in. Connect again waits on it: see `redialHub`.
  ready: Promise<void>;
}

export interface HubLinkDeps {
  keychain?: Keychain;
  // How a socket is opened, so a test drives a stub hub and no test reaches the network.
  socket?: (url: string, token: string) => () => HubSocket;
  // Where a line about the hub goes. One line per failure, never a crash: the app serves pages
  // whatever the hub does.
  say?: (line: string) => void;
  // The loop of another registered project, for a job that names it, so a test opens it in its own
  // temp folder. Left out, `loop(env, project)`, which keeps the Free rule of one open project.
  projectLoop?: (project: number) => Loop;
  // The signed display document, which says whether the link serves every project or the open one alone.
  // Left out, the one the server holds.
  display?: () => DisplayEntitlement;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// One socket of a link: the status a screen reads, the writer a job answers on, and the close the quit
// path reaches. A link holds one for the personal hub and, on a team project, a second for the team hub.
interface Wire {
  status: HubStatus;
  connection: HubConnection | null;
  // True once this wire has been closed, so a connection whose keychain read was still running when the
  // close came is closed as it lands. Without it a team wire dropped for a new team id goes on taking
  // and acking the old hub's jobs.
  closed: boolean;
  // `project` is the registry id the frame names, the link's own project when left out.
  post: (type: RunnerMessageType, payload: unknown, project?: number) => boolean;
  close: () => void;
  // The keychain read and the dial after it, settled either way.
  ready: Promise<void>;
}

// What a link holds for one project it serves. Each project has its own registration, its own board
// memory per socket, and on a team project its own team socket and job mark, because two team projects
// may belong to two teams with two hubs.
interface Served {
  live: Loop;
  // True once the personal hub has this project's `project.sync`. It refuses a board row before that.
  registered: boolean;
  sync: HubSync;
  teamSync: HubSync;
  // The team socket, null until the project stores a team project id.
  team: Wire | null;
  // The team project id that socket was dialled for. A stored id that differs from it means the project
  // joined another team, and another team is another hub.
  teamFor: string | null;
  leave: () => void;
}

// The job id a frame this machine sends carries. Every frame needs one and the hub ignores it on a
// settings message, because only `job.ack` may take a queue row. It counts from 1, so no frame of this
// process carries the same id twice and a hub log can tell two saves apart.
let sentFrames = 0;

// When a frame of this machine last went out on an open socket, for Last sync on Settings, Cloud. Null
// until the first one. Read on a page load, like the status: nothing polls it.
let lastSent: number | null = null;

// The keychain read of the link started last, until it settles. A link reads `closed` while it reads,
// so a press of Connect again then, at start or as a second press, would drop that read and start
// another: a second OS dialog and a socket that is closed as soon as it opens.
let reading: Promise<void> | null = null;

// The link the init hook started, so a screen can read what the connection is doing. One per module
// instance, the way `loop.ts` holds its `open` map and for the same reason: the dial lives
// in the server bundle, and the hook that starts it has nowhere to hand the status to.
let started: HubLink | null = null;

// What the last dial was made with, so a dial again uses the same loop, environment and stubs. The init
// hook is the only caller in the product and it has nothing to hand these to either.
let dialled: { live: Loop; env: NodeJS.ProcessEnv; deps: HubLinkDeps } | null = null;

// A link with no socket: fake mode, and sync paused after Delete my cloud data. Held like any other, so
// `hubStatus()` says `closed` and `sendToHub` answers false through it.
const idleLink = (): HubLink => ({ status: () => 'closed', teamStatus: () => 'closed', send: () => false, sendTeam: () => false, projectsChanged: () => {}, close: () => {}, ready: Promise.resolve() });

// The account the last dial again was made for. A hub that will not serve this machine must be dialled
// again when the account changed and not on every page load: a plan that still does not open the board
// would otherwise put a socket in the air on every navigation for as long as the app runs.
let dialledFor: string | null = null;

// Limit: one key for both stopped states, so a token minted again for the same account is dialled for
// once and the restart stays in the sentence for the second try. Have `nolzu login` tell the running
// server when a machine signed in again, the way `nolzu logout` will have to.

// What in the document says the account changed. The expiry is left out on purpose. `currentDisplay`
// refreshes the document at half its life, so a key holding the expiry would change on a timer instead
// of when somebody bought or cancelled something.
const accountKey = (document: DisplayEntitlement): string =>
  [document.id, document.plan, document.seats, [...document.features].sort().join(' ')].join('|');

/**
 * Register this machine's project with the hub, and resend the schedules it holds.
 *
 * On every connect and not once. The hub may have lost the row, the fields below may have changed
 * while the link was down, and a sync costs one frame. It runs here, where the connect happens, and
 * never in a page load: reading the keychain and opening the socket both take time, and a load may
 * not wait on either.
 *
 * The id is minted on this machine. Nothing in the local database is stable enough for the hub to key
 * a project row on: the `projects` table is written by nothing, the project path follows a folder that
 * a person may move, and the name is that path's last part. So the first connect after this version
 * mints one and stores it, which is what every machine in existence does on its next start, and the
 * project keeps that id from then on.
 *
 * A machine with no project path sends nothing and mints nothing. There is no project to register, and
 * an id minted now would belong to whatever folder the person picks later.
 *
 * Answers whether the registration went out. The hub refuses a board row from a socket that has not
 * named its project, so board sync waits on this.
 */
function registerProject(db: DatabaseSync, send: (type: RunnerMessageType, payload: unknown) => boolean): boolean {
  const name = projectName(db);
  if (name === null) return false;

  const stored = getSetting(db, 'projectId');
  const id = stored ?? randomUUID();
  if (stored === null) writeSetting(db, 'projectId', id);

  const sync: ProjectSync = {
    id,
    name,
    flow: getSetting(db, 'deliveryFlow'),
    clientName: getSetting(db, 'clientName'),
    hourlyRate: getSetting(db, 'hourlyRate'),
    currency: getSetting(db, 'currency'),
    // The moment of this sync, not the moment a field changed. Nothing here stores the second one. The
    // hub keeps the last write, and one project id belongs to one machine, so this stamp has no other
    // writer to lose to.
    updatedAt: new Date().toISOString(),
    // What this build can run, read off the protocol package's own list rather than written out, so a
    // job type added there is handled the moment `hub-jobs.ts` learns it and never before. The hub
    // holds back a job this list does not name, which is what keeps a job out of a queue that would
    // never drain it.
    handles: SERVER_MESSAGES,
    // True on a machine that holds the id the team hub minted, which is what having joined a team means.
    // Nothing else could say it: the hub mints that id and a `project.join` job stores it. Null on every
    // machine in existence, so nothing anybody already registered turns into a team project on its own.
    team: getSetting(db, 'teamProjectId') !== null,
  };
  if (!send('project.sync', sync)) return false;

  // Only after the registration went out. The hub keys a schedule on the project row, so a schedule
  // frame that arrives without one is refused and the person's setting stays on this machine.
  //
  // Limit: no plan check and no bound check here. A schedule is stored only by a save that was
  // allowed, and the hub reads every frame again before it writes a row.
  for (const source of scoutSources(db)) {
    // Limit: a source with no stored schedule is skipped, so a stop that never reached the hub is
    // never sent again from here, and a stale row up there outlives the link it was lost on. A column
    // saying the hub still owes this source a stop is the fix, the day one of these shows up.
    if (source.scheduleMinutes === 0) continue;
    // A source whose checks the person turned off sends a 0, not nothing. Its own save sends that 0
    // now, from `saveScoutSource`, and this is the copy for a save made while the link was down. The 0
    // deletes the hub's row and its due entry, so a row up there cannot go on being checked while this
    // machine refuses the same check and the screen says the checks are off. Turning the source on
    // again arms it from the interval its row still holds, on the next connect.
    const on = source.enabled;
    const schedule: ScoutSchedule = {
      projectId: id,
      sourceId: source.id,
      intervalMinutes: on ? source.scheduleMinutes : 0,
      notify: on && source.notify,
      // Straight off the row, and not gated on `on` the way the flag above is. A source turned off
      // sends a 0, which deletes the row up there, so there is no schedule left for either flag to
      // act on. Sending what the columns hold keeps this frame a copy of the row.
      createCards: source.createCards,
      autoAssess: source.autoAssess,
    };
    send('scout.schedule', schedule);
  }
  return true;
}

/**
 * What the connection is doing, for a screen.
 *
 * `closed` before the dial has started, on a machine with no account, and after the app has been told
 * to shut down, because none of the three has a connection to report on.
 */
export const hubStatus = (): HubStatus => started?.status() ?? 'closed';

/**
 * Send one frame to the hub, and answer whether it went.
 *
 * False on a machine with no account, on one whose link is down, and in fake mode, because none of
 * them has a socket. The caller owes the person a sentence in that case: what was stored here is
 * stored, and the hub does not have it. A frame that did not go is not held for a retry: the
 * registration on the next connect is what sends the stored schedules again.
 */
export const sendToHub = (type: RunnerMessageType, payload: unknown, project?: number): boolean => started?.send(type, payload, project) ?? false;

/**
 * Send one frame to the team hub of a project, the start project when none is named, and answer whether
 * it went.
 *
 * False for a project that has joined no team, as every project has until a `project.join` job
 * arrives, and false while that socket is down. The caller owes the person a sentence then, the way
 * `sendToHub` does: what this machine stored is stored, and the team does not have it.
 */
export const sendToTeamHub = (type: RunnerMessageType, payload: unknown, project?: number): boolean => started?.sendTeam(type, payload, project) ?? false;

/**
 * Tell the link a project was registered, so it is synced now and not at the next server start.
 *
 * New project calls this once the new project has its folder, because the hub refuses a project with
 * no name. Nothing happens on a machine with no link.
 */
export const hubProjectsChanged = (): void => started?.projectsChanged();

/**
 * Dial the hub for the account this machine is signed in as.
 *
 * The dial is not awaited. Reading the keychain can raise an OS password dialog whose refusal throws,
 * and the app has to be serving pages by then. A client with no device token dials nothing, which is
 * what `connectToHub` answering null means, and that is the free client and not a fault.
 *
 * Fake mode dials nothing either, unless a test hands in its own socket. A demo run in fake mode is on a machine
 * that may be signed in, and it has no business opening a socket to the real hub while a person is
 * looking at a board full of made-up cards.
 *
 * One personal socket for the machine, and one team socket for each team project. A team socket goes to
 * the team hub on a path of its own, and it is opened only for a project that holds the id the team hub
 * minted. The personal socket does not change: it is dialled first, its status is the one a screen reads,
 * and a team hub that is down or will not serve this machine costs it nothing.
 *
 * The personal socket carries every project the link serves: each registers with its own `project.sync`
 * and pushes its own board, each frame naming its project. On Free that is the one open project, as
 * before a machine could hold several.
 */
export function startHubLink(live: Loop, env: NodeJS.ProcessEnv, deps: HubLinkDeps = {}): HubLink {
  dialled = { live, env, deps };
  const say = deps.say ?? ((line: string) => console.error(line));
  const display = deps.display ?? heldDisplay;
  let stopped = false;
  // One job at a time, in the order the hub sent them, and one queue for every socket. The hub delivers
  // its queue oldest first, and a move that ran after the run it queues would undo that order. The catch
  // keeps the chain alive, so one failed job does not stop the ones behind it. Serving a project made
  // later goes through the same queue, so two calls cannot serve one project twice.
  let waiting: Promise<void> = Promise.resolve();
  // What the link holds for each project it serves, by registry id.
  const served = new Map<number, Served>();

  // A run in fake mode dials nothing, and the link it gets back is held like any other, so `hubStatus()` and
  // `sendToHub` answer through it rather than through a null nobody set. Without that the two lines below
  // are reachable by a caller holding the link and by nothing else, which is how a test came to pass on a
  // path it was not exercising.
  //
  // A machine whose person deleted their cloud data dials nothing either, until they turn sync back on
  // (`resumeSync`). A dial would send the whole board back up.
  //
  // While the cloud is closed there is no hub to dial, and no account token to read from the keychain.
  // A test hands its own socket, so the code below keeps its tests.
  if (((isFakeMode(env) || !CLOUD_OPEN) && deps.socket === undefined) || getSetting(live.db, 'syncPaused')) {
    started = idleLink();
    return started;
  }

  // One keychain object for every dial, not one each. It saves the object and not the read:
  // `connectToHub` reads the token on every call and `createKeychain` caches nothing, so a team dial
  // runs the OS command again.
  //
  // Limit: no cache on the read. The team socket is dialled when a `project.join` job arrives, which
  // may be hours after the start, and a cached token would be the one a later `nolzu login` replaced.
  const keychain = deps.keychain ?? createKeychain(process.platform, runKeychain, resolveDataDir(env));

  // The loop of the project a job names, or of the first project when it names none, which is what every
  // job meant before a machine held several. A project the registry does not hold is refused: running
  // the job on another project would move a card that only shares its key.
  const loopFor = async (project: number | undefined): Promise<Loop> => {
    const registered = registeredProjects(live.db).map((one) => one.id);
    const id = project ?? registered[0];
    if (id === undefined || !registered.includes(id)) {
      throw new Error(`It names project ${project}, and this machine has no such project, so no project ran it.`);
    }
    if (id === live.project) return live;
    if (deps.projectLoop !== undefined) return deps.projectLoop(id);
    // Imported late because `loop.ts` imports this file.
    const { loop } = await import('./loop.ts');
    return loop(env, id);
  };

  // The projects the personal socket carries: every registered one. A hub that does not read `project`
  // gets the first project alone: it files every frame under the project synced last and runs a job
  // with no project on the first, so a second sync would put one project's board rows and jobs on the other.
  const servedIds = (): number[] => {
    const ids = registeredProjects(live.db).map((one) => one.id);
    return shows(display(), HUB_PROJECTS_FEATURE) ? ids : ids.slice(0, 1);
  };

  // Dial one hub and keep the socket it answers with. `where` names the hub in the sentence a failed
  // dial gets, and `watch` is what that socket does with its own status. `owner` is the project a team
  // socket belongs to: its jobs run there, and its frames name it.
  const dial = (url: string, mark: HubJobMark, where: string, watch: (status: HubStatus) => void, owner?: number): Wire => {
    const wire: Wire = {
      status: 'closed',
      connection: null,
      closed: false,
      // One frame from this machine, with the next job id. Only on an open socket: a frame written while
      // the dial is still waiting would be dropped by the socket itself, and the caller would be told it
      // went. The counter is shared by every socket on purpose, so no frame of this process carries the
      // same id twice and a hub log can tell two saves apart.
      post: (type, payload, project = owner ?? live.project) => {
        if (wire.status !== 'open' || wire.connection === null) return false;
        const went = wire.connection.send(hubEnvelope(type, ++sentFrames, payload, project));
        if (went) lastSent = Date.now();
        return went;
      },
      close: () => {
        wire.closed = true;
        wire.connection?.close();
        wire.connection = null;
      },
      ready: Promise.resolve(),
    };
    wire.ready = connectToHub({
      keychain,
      url,
      socket: deps.socket,
      onStatus: (next) => {
        wire.status = next;
        watch(next);
      },
      onMessage: (message) => {
        // The socket acks the job as soon as this returns, and this returns once the job is in the queue,
        // so the ack is on the wire before the work runs. What that costs is in the docstring on
        // `takeHubJob`. A job that could not be taken is one line here, and the hub is not asked to send it
        // again: a card that is gone or a stage that starts nothing would come back on every connect for
        // ever.
        //
        // The job answers on this socket's own writer and is measured against the mark of the project it
        // runs on, so an ack goes back to the hub that asked for it and one hub's job ids cannot drop the
        // other's.
        //
        // The serving that follows has a catch of its own. It reads the database, so it can fail for
        // reasons the job has nothing to do with, and by then the job has run and the mark has moved.
        //
        // The job runs on the loop of the project it names, and answers under that project. A team
        // socket's job runs on the socket's own project, and one naming another project is refused,
        // because that project has a team socket of its own or none.
        waiting = waiting
          .then(async () => {
            if (owner !== undefined && message.project !== undefined && message.project !== owner) {
              throw new Error(`It names project ${message.project} on the team socket of project ${owner}, so no project ran it.`);
            }
            const target = await loopFor(owner ?? message.project);
            await takeHubJob(target, message, (type, payload) => wire.post(type, payload, target.project), mark);
          })
          .catch((error) => say(`A job from the hub did not run: ${reason(error)}`))
          .then(serveProjects)
          .catch((error) => say(`Nolzu could not dial its team hub: ${reason(error)}`));
      },
      onUnreadable: (sentence) => say(sentence),
      // The socket has stopped dialling by now. The rest of the link goes down with it, so no team socket
      // and no later change sends a frame, and the setting keeps it down across a restart.
      onDeleted: () => {
        writeSetting(live.db, 'syncPaused', true);
        say('Your cloud data was deleted, so Nolzu paused sync. Turn it back on in Settings, Cloud.');
        link.close();
        started = idleLink();
      },
    })
      .then((made) => {
        wire.connection = made;
        // close() can be called while the keychain is still being read, and the socket is in the air by
        // then. Either the app quit or this one wire was dropped for a hub it no longer belongs to.
        if (stopped || wire.closed) made?.close();
      })
      .catch((error) => {
        wire.status = 'closed';
        say(`Nolzu could not reach ${where}: ${reason(error)}`);
      });
    return wire;
  };

  // Register one project with this machine's own hub, and say the one line a failure gets. This runs
  // inside a socket handler and inside a job chain, and the app has to go on serving pages and running
  // jobs whatever the hub does with a settings frame.
  function syncProject(one: Served): boolean {
    try {
      return registerProject(one.live.db, (type, payload) => own.post(type, payload, one.live.project));
    } catch (error) {
      say(`Nolzu could not register its project with the hub: ${reason(error)}`);
      return false;
    }
  }

  // Board sync, evidence history and Scout findings of one project, to the personal hub, once the hub
  // has its registration, because the hub refuses a board row from a project it has not been told about.
  // A project with no folder at the open is registered on its first change after it has one.
  // A connect sends the last week of evidence, and a change sends only the days its rows touched.
  // Neither may throw: this runs inside the loop's own change report.
  function pushBoard(one: Served, onOpen: boolean): void {
    if (!one.registered) {
      if (own.status !== 'open') return;
      one.registered = syncProject(one);
      if (!one.registered) return;
      onOpen = true;
    }
    try {
      const touched = one.sync.board();
      one.sync.findings();
      const days = onOpen ? recentDays(EVIDENCE_DAYS_ON_OPEN) : touched;
      // A link closed while the git calls ran has closed its database too, and that is no failure.
      if (days.length > 0) void one.sync.evidence(days).catch((error) => stopped || say(`Nolzu could not send its evidence to the hub: ${reason(error)}`));
    } catch (error) {
      say(`Nolzu could not send its board to the hub: ${reason(error)}`);
    }
  }
  // The same board, up the project's team socket on a team project. A memory of its own, because the
  // sockets open and drop apart. `card.state` without its runs, and each run's cost, tokens and model on
  // `run.cost`: the evidence, a run's question, its verdict reason and its failure stay with the person's
  // own hub. No registration first either, because the team hub reads the project off the device that
  // holds the socket and never off the frame. Every card here is on the team project, because each team
  // project has a socket of its own.
  function pushTeamBoard(one: Served): void {
    if (one.team?.status !== 'open' || getSetting(one.live.db, 'teamProjectId') === null) return;
    try {
      one.teamSync.board();
      one.teamSync.runCosts();
    } catch (error) {
      say(`Nolzu could not send its board to the team hub: ${reason(error)}`);
    }
  }

  // Starts holding one project: its board memories and a listener on its loop.
  function serve(project: Loop): Served {
    const one: Served = {
      live: project,
      registered: false,
      sync: createHubSync(project.db, (type, payload) => own.post(type, payload, project.project), { snapshot: project.snapshot }),
      teamSync: createHubSync(project.db, (type, payload) => one.team?.post(type, payload) ?? false, { runs: false }),
      team: null,
      teamFor: null,
      leave: project.onChange(() => {
        pushBoard(one, false);
        pushTeamBoard(one);
      }),
    };
    served.set(project.project, one);
    return one;
  }

  // The team hub, beside the personal one. Only for a project that has joined a team: the id a
  // `project.join` job stored is the one thing that says this project works on a shared board, and a
  // project without it has no team hub to be served by.
  //
  // Limit: this socket registers nothing with the team hub. The team hub keys its rows on the id it
  // minted itself, so there is nothing for a second registration to say. Give it one when the team hub
  // needs a field this machine holds and its own hub does not.
  //
  // Called again after every job, because the job may be a `project.join` that stored the id or changed
  // it. A person who joined a team would otherwise wait for the next server start before a team job
  // reached them.
  function openTeamHub(one: Served): void {
    if (stopped) return;
    const id = getSetting(one.live.db, 'teamProjectId');
    if (id === null) return;
    // The wire in the air already belongs to this team's hub, which is the answer on every call but the
    // first and the one after a join to another team.
    if (one.team !== null && id === one.teamFor) return;
    // The stored id names another team, so the wire in the air is on the wrong hub. Left open it would
    // go on taking and acking that hub's jobs while nothing from the new one ever arrived. The job mark
    // is put back by the `project.join` branch in `hub-jobs.ts`, where the new id is written.
    one.team?.close();
    one.teamFor = id;
    one.team = dial(
      teamHubUrl(env),
      'teamHubJobDone',
      'its team hub',
      (next) => {
        // The whole board on every open, the same rule the personal socket keeps.
        if (next === 'open') {
          one.teamSync.reset();
          pushTeamBoard(one);
        }
        // A refusal stops this socket's loop and leaves the personal one alone, so the app goes on working
        // and the screen goes on saying so. Without a line here that is silent, and a person would see the
        // cloud connected and no team card ever arrive.
        //
        // Two sentences and not one, because the way out is not the same. A plan is bought, and a token is
        // signed in for again. The screen tells neither: the status it reads is the personal socket's.
        if (next === 'unpaid') {
          say('This plan does not open the team hub, so nothing from the team board reaches this machine. The rest of Nolzu goes on working.');
        }
        if (next === 'refused') {
          say('The team hub turned this machine down, so nothing from the team board reaches it. Run `npx nolzu@latest login` again, and update Nolzu if that does not help.');
        }
      },
      one.live.project,
    );
    // The machine's own hub learns about the team here and not at the next reconnect. The `team` marker
    // on `project.sync` is read off the setting a `project.join` job has just written, and the personal
    // socket is held open by the heartbeat, so its next `open` may be days away. On a personal socket
    // that is not open yet this sends nothing, and the registration on its `open` carries the marker.
    syncProject(one);
  }

  // Serves every project the link should and does not yet, and dials the team socket of each team
  // project. Runs after every job, on a personal open, and when New project made a project, so a project
  // made later is registered and pushed without a restart.
  //
  // Limit: a project stops being served only with the link. A plan that ends mid-session keeps its
  // projects synced until the next start or dial again, which a changed document triggers.
  async function serveProjects(): Promise<void> {
    for (const id of servedIds()) {
      if (stopped) return;
      let one = served.get(id);
      if (one === undefined) {
        const project = await loopFor(id);
        if (stopped || served.has(id)) continue;
        one = serve(project);
        pushBoard(one, true);
      }
      openTeamHub(one);
    }
  }
  const projectsChanged = (): void => {
    waiting = waiting.then(serveProjects).catch((error) => say(`Nolzu could not send a project to the hub: ${reason(error)}`));
  };

  const own = dial(hubUrl(env), 'hubJobDone', 'its hub', (next) => {
    // The hub turned the plan down, so the project list it sent while the plan was paid goes too, and
    // `/api/projects` answers this machine's project alone, as on a machine that never paid.
    if (next === 'unpaid') writeSetting(live.db, 'accountProjects', null);
    if (next !== 'open') {
      for (const one of served.values()) one.registered = false;
      return;
    }
    // One `project.sync` per project, the start project first, each with its own board.
    for (const one of served.values()) {
      one.sync.reset();
      one.registered = false;
      pushBoard(one, true);
    }
  });
  const read = own.ready;
  reading = read;
  void read.then(() => {
    if (reading === read) reading = null;
  });
  // The start project is served at once when it is served at all, so its team socket is dialled beside
  // the personal one without waiting for the queue. The others follow through the queue.
  if (servedIds().includes(live.project)) openTeamHub(serve(live));
  projectsChanged();

  const link: HubLink = {
    // The personal socket's status, and not the sockets folded into one. Every account has this socket and
    // only a team project has another, so a team hub that is down would otherwise draw `waiting` on a
    // machine whose own link is open and serving. No second indicator was invented for the team sockets:
    // the line each says when it is turned down is where that state is told.
    status: () => own.status,
    // A team socket that was turned down, so `dialHubAgain` can dial it again, else the first team
    // socket's status, and `closed` on a machine with no team socket.
    teamStatus: () => {
      const all = [...served.values()].flatMap((one) => (one.team === null ? [] : [one.team.status]));
      return all.find((status) => status === 'refused' || status === 'unpaid') ?? all[0] ?? 'closed';
    },
    // The personal socket. A job that arrived on a team socket answers on the writer that socket
    // handed it, so neither hub's frames can go out on the other's connection.
    send: (type, payload, project) => own.post(type, payload, project),
    // The team socket of a project, the start project's when none is named, for the knowledge proposal a
    // run on a team project makes. The board and the run costs go up it from `pushTeamBoard` and not
    // through here. Read through the wire held now, so a project that joined a team after this link
    // started sends on the socket that join opened.
    sendTeam: (type, payload, project = live.project) => served.get(project)?.team?.post(type, payload) ?? false,
    projectsChanged,
    ready: own.ready,
    close() {
      stopped = true;
      own.close();
      for (const one of served.values()) {
        one.leave();
        one.team?.close();
      }
      // The module stops holding a link that will never report anything again. `connectHub` says
      // `closed` on its way out, so the status itself is already right.
      if (started === link) started = null;
    },
  };
  started = link;
  return link;
}

/**
 * Dial again when a document says the account changed under a link that stopped for good.
 *
 * `connectHub` gives up for the life of the process on a refusal code, so a plan bought in the browser
 * would otherwise reach this machine only at the next server start, and a run started from the cloud
 * would wait that long. The signed display document is the trigger the client already has:
 * `currentDisplay` refreshes it on a page load and it carries the plan.
 *
 * One dial per document change, never one per page load, because the document changes when the account
 * did. `unpaid` waits for a plan that opens the board, so a document without that feature changes
 * nothing here. `refused` waits for a token or a newer build, and the document shows neither, so the
 * first document to arrive after the refusal is the signal there.
 *
 * Either socket is enough. A team hub that turned this machine down stops its own loop for the life of
 * the process, the same way the personal one does, and nothing else dials it again, so a Team plan
 * bought in the browser would never reach the team board. The team half is dialled again on any changed
 * document and not on a feature this file names: the client cannot say which word the team hub gates on,
 * that word is the hub's, and a document that changed is already an account that changed. The whole link
 * goes down and up, which costs the personal socket one reconnect.
 *
 * Answers whether it dialled, for a test. The dial inside is not awaited, the way the dial from `init`
 * is not, so a page load never waits for a keychain that may put an OS password dialog on the screen.
 * Fake mode never gets here: it dials nothing, so there is no stopped link and `hubStatus` says
 * `closed`.
 */
export function dialHubAgain(document: DisplayEntitlement): boolean {
  const status = hubStatus();
  // The personal socket, with the one rule it has: `unpaid` there waits for the plan that opens the
  // board, so a document without that feature is no signal.
  const own = status === 'refused' || (status === 'unpaid' && shows(document, 'cloud-board'));
  const team = started?.teamStatus();
  if (!own && team !== 'unpaid' && team !== 'refused') return false;
  if (dialled === null) return false;
  const key = accountKey(document);
  if (key === dialledFor) return false;
  dialledFor = key;
  started?.close();
  startHubLink(dialled.live, dialled.env, dialled.deps);
  return true;
}

/**
 * When a frame last went to a hub, or null when none has since Nolzu started.
 */
export const hubLastSent = (): number | null => lastSent;

// The longest a press of Connect again waits for the keychain read. The read can put an OS password
// dialog on the screen, and the person who pressed is the one to answer it, so a few seconds is the
// right size. A read still going after that is left to finish and shows on the next load.
const REDIAL_WAIT_MS = 5000;

/**
 * Dial again because a person pressed Connect again on Settings, Cloud. Answers whether it dialled.
 *
 * Only from `closed`, the one stopped state nothing leaves by itself: the keychain read failed or found
 * no token, so `connectHub` never started its loop. `connecting` and `waiting` are dialling already and
 * `open` has nothing to fix. `refused` and `unpaid` wait for the account to change, and `dialHubAgain`
 * dials on the document that says it did. A link whose keychain read is still going reads `closed` too,
 * and is left to finish (`reading`). No load and no timer calls this, only the `redial` action.
 *
 * The press waits for the keychain read, so the load that follows the press says Connecting, or
 * Offline again when there is still no token, and not the Offline the person pressed on.
 */
export async function redialHub(): Promise<boolean> {
  if (dialled === null || reading !== null || hubStatus() !== 'closed') return false;
  await dialForPress(dialled);
  return true;
}

// A press dials again and waits for the keychain read, capped at `REDIAL_WAIT_MS`, because the read can
// sit behind an OS dialog the person has not answered yet.
async function dialForPress(from: NonNullable<typeof dialled>): Promise<void> {
  started?.close();
  const link = startHubLink(from.live, from.env, from.deps);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([link.ready, new Promise<void>((resolve) => (timer = setTimeout(resolve, REDIAL_WAIT_MS)))]);
  clearTimeout(timer);
}

/**
 * Turn sync back on after Delete my cloud data, from Settings, Cloud. Clears the pause and dials at once,
 * and the open sends the whole board, as every connect does. Answers whether it dialled: false when no
 * link was ever started, such as in fake mode, where the cleared setting is the whole job, and while a
 * keychain read from an earlier press still goes.
 */
export async function resumeSync(db: DatabaseSync | null = dialled?.live.db ?? null): Promise<boolean> {
  if (db !== null) writeSetting(db, 'syncPaused', false);
  // A second press while the first one's keychain read goes would start a second read, and a second OS
  // dialog, so it leaves that read to finish.
  if (dialled === null || reading !== null) return false;
  await dialForPress(dialled);
  return true;
}

/**
 * Close the link this module holds and forget the account it was dialled for.
 *
 * The quit path in `hooks.server.ts` calls this, and so does a test. A dial again starts a link no
 * caller has a handle on, so the only close that reaches the live socket and its heartbeat is one that
 * reads what the module holds now.
 */
export const closeHubLink = (): void => {
  started?.close();
  started = null;
  dialled = null;
  dialledFor = null;
  lastSent = null;
  reading = null;
};
