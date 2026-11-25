import { expect, it } from 'vitest';
import { DEFAULTS, isFolderName, isMachineKey, isSettingKey, MACHINE_KEYS, NEW_PROJECT_BRANCH_TEMPLATE, presetRows, projectRepos, readSetting, validateLimits, validateProfiles, validateRepos, validateSavedPresets, validateSetting } from './settings.ts';

const minutes = (n: number) => n * 60 * 1000;

it('starts with three agent slots', () => {
  expect(DEFAULTS.agentSlots).toBe(3);
});

it('counts the run timeout as thirty minutes of idle time', () => {
  // Idle time since the last stream line, not wall clock: an implement run can honestly
  // take an hour while printing all the way through.
  expect(DEFAULTS.runTimeoutMs).toBe(minutes(30));
});

// Quiet only changes what the card shows, so it sits well under the run timeout that ends a run.
it('calls a run quiet after five minutes with no output, and takes whole minutes only', () => {
  expect(DEFAULTS.quietAfterMs).toBe(minutes(5));
  expect(validateSetting('quietAfterMs', minutes(10))).toEqual({ ok: true, value: minutes(10) });
  expect(validateSetting('quietAfterMs', minutes(1))).toEqual({ ok: true, value: minutes(1) });
  for (const refused of [0, 30_000, minutes(1) + 1, -minutes(5), '5', null]) {
    expect(validateSetting('quietAfterMs', refused)).toMatchObject({ ok: false, message: 'The quiet time must be whole minutes, at least one, given in milliseconds.' });
  }
  expect(readSetting('quietAfterMs', '"five"')).toEqual({ value: minutes(5), fellBack: true });
});

it('waits two, then five, then fifteen minutes before giving up on an API error', () => {
  expect(DEFAULTS.retryWaitsMs).toEqual([minutes(2), minutes(5), minutes(15)]);
});

// The settings screen offers no retry as a policy, and the runner reads an empty list as one.
it('takes an empty list of retry waits, and refuses a wait that is not a number above zero', () => {
  expect(validateSetting('retryWaitsMs', [])).toEqual({ ok: true, value: [] });
  expect(validateSetting('retryWaitsMs', [0])).toMatchObject({ ok: false });
  expect(validateSetting('retryWaitsMs', 'none')).toMatchObject({ ok: false });
});

it('holds the machine awake by default, because idle sleep kills a long run with no sign', () => {
  expect(DEFAULTS.keepAwake).toBe(true);
});

it.each([0, -1, 21])('refuses %i agent slots and names the range', (slots) => {
  const result = validateSetting('agentSlots', slots);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toMatch(/1 (to|and) 20/);
});

it('accepts a slot count inside the range', () => {
  expect(validateSetting('agentSlots', 5)).toEqual({ ok: true, value: 5 });
});

it('refuses a value of the wrong shape rather than storing it', () => {
  expect(validateSetting('agentSlots', 'three').ok).toBe(false);
  expect(validateSetting('keepAwake', 'yes').ok).toBe(false);
  expect(validateSetting('modelPreset', 'medium').ok).toBe(false);
});

it('knows which keys exist, so a typo cannot create a setting nothing reads', () => {
  expect(isSettingKey('agentSlots')).toBe(true);
  expect(isSettingKey('agentSlot')).toBe(false);
  expect(isSettingKey('__proto__')).toBe(false);
});

it('refuses a branch template with no key placeholder', () => {
  // The key is what keeps two cards whose titles slug the same from sharing a branch.
  const result = validateSetting('branchTemplate', '{slug}');
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain('{key}');
  expect(validateSetting('branchTemplate', '{key}-{slug}')).toEqual({ ok: true, value: '{key}-{slug}' });
});

it('gives a project that stored no template the Gitflow one New project stores', () => {
  // A started card keeps the branch its checkout is on, so only cards not started yet take the new names.
  expect(DEFAULTS.branchTemplate).toBe(NEW_PROJECT_BRANCH_TEMPLATE);
  expect(NEW_PROJECT_BRANCH_TEMPLATE).toBe('{type}/{key}/{desc}');
  expect(validateSetting('branchTemplate', NEW_PROJECT_BRANCH_TEMPLATE)).toEqual({ ok: true, value: '{type}/{key}/{desc}' });
});

it('falls back to the default and says so when a stored value no longer parses', () => {
  // A hand edited database must not stop the app from starting.
  expect(readSetting('agentSlots', 'not json')).toEqual({ value: DEFAULTS.agentSlots, fellBack: true });
  expect(readSetting('agentSlots', '99')).toEqual({ value: DEFAULTS.agentSlots, fellBack: true });
  expect(readSetting('agentSlots', undefined)).toEqual({ value: DEFAULTS.agentSlots, fellBack: false });
});

it('reads a stored value that still parses', () => {
  expect(readSetting('agentSlots', '5')).toEqual({ value: 5, fellBack: false });
  expect(readSetting('keepAwake', 'false')).toEqual({ value: false, fellBack: false });
});

// The vendor is part of the question: each one ships its own rows, so a preset name alone names no
// model.
it('resolves a phase to the model and effort of the chosen preset, under one vendor', () => {
  expect(presetRows('light', 'claude-code').plan).toEqual({ model: 'sonnet', effort: 'medium' });
  expect(presetRows('heavy', 'claude-code').implement).toEqual({ model: 'opus', effort: 'high' });
  expect(presetRows('heavy', 'codex').implement).toEqual({ model: 'gpt-5.6-sol', effort: 'high' });
});

it('keeps refine cheap in the light and default presets, because it only reads and tidies', () => {
  expect(presetRows('light', 'claude-code').refine).toEqual({ model: 'haiku', effort: 'low' });
  expect(presetRows('default', 'claude-code').refine).toEqual({ model: 'haiku', effort: 'low' });
});

it('gives planning the stronger model, which is where model strength pays back', () => {
  expect(presetRows('light', 'claude-code').plan.model).toBe('sonnet');
  expect(presetRows('default', 'claude-code').plan.model).toBe('sonnet');
  expect(presetRows('heavy', 'claude-code').plan.model).toBe('opus');
});

it('gives every preset of every vendor a row for every phase a drag starts', () => {
  for (const vendor of ['claude-code', 'codex', 'cursor'] as const) {
    for (const preset of ['light', 'default', 'heavy'] as const) {
      for (const phase of ['refine', 'plan', 'implement', 'qa', 'wrapup'] as const) {
        expect(presetRows(preset, vendor)[phase].model, `${vendor} ${preset} ${phase}`).not.toBe('');
      }
    }
  }
});

it('starts with no saved preset', () => {
  expect(DEFAULTS.savedPresets).toEqual([]);
});

it('takes a saved preset with a name and a row, and one of a profile this machine lost', () => {
  expect(validateSavedPresets([{ name: 'Evenings', models: { plan: { engine: 'claude-code', model: 'opus' } } }])).toBeNull();
  expect(validateSavedPresets([{ name: 'Evenings', models: { plan: { engine: 'codex#gone', model: 'gpt-5.6-sol' } } }])).toBeNull();
});

it.each([
  [{}, /a list/],
  [['Evenings'], /a name and a table of actions/],
  [[{ name: 'Evenings', models: { dream: {} } }], /no action dream/],
  [[{ name: '', models: {} }], /needs a name/],
  // A hand edited database. Without the guard the name check calls trim on a number and the read
  // throws instead of falling back.
  [[{ name: 5, models: {} }], /needs a name/],
  [[{ name: 'Evenings', models: {} }, { name: 'Evenings', models: {} }], /already a preset called Evenings/],
  [[{ name: 'default', models: {} }], /already a preset called default/],
])('refuses the stored preset list %j and says why', (value, why) => {
  expect(validateSavedPresets(value)).toMatch(why);
  expect(validateSetting('savedPresets', value).ok).toBe(false);
});

// A relative path means something else to every process that reads it, so only a full one is taken.
it.each(['recipes', './recipes', '~/recipes'])('refuses the relative project path %j', (path) => {
  expect(validateSetting('projectPath', path).ok).toBe(false);
});

it.each(['/home/you/recipes', 'C:\\work\\recipes', '\\\\server\\share\\recipes'])('takes the full project path %j', (path) => {
  expect(validateSetting('projectPath', path).ok).toBe(true);
});

// The engine resolves a relative path against the card's checkout, which is not where a person
// keeps their browser config, so only a full path is stored.
it.each(['playwright-mcp.json', './playwright-mcp.json', '~/.nolzu/playwright-mcp.json'])('refuses the relative browser config %j', (path) => {
  expect(validateSetting('qaMcpConfigPath', path).ok).toBe(false);
});

it('takes a full browser config path, and nothing for a project checked without a browser', () => {
  expect(validateSetting('qaMcpConfigPath', '/home/you/.nolzu/playwright-mcp.json').ok).toBe(true);
  expect(validateSetting('qaMcpConfigPath', null)).toEqual({ ok: true, value: null });
  expect(DEFAULTS.qaMcpConfigPath).toBeNull();
});

it('starts with one Claude Code profile', () => {
  expect(DEFAULTS.engineProfiles).toEqual([
    { id: 'claude-code', label: 'Claude Code', vendor: 'claude-code', configDir: null },
  ]);
  // There is no separate engine setting: the vendor a run spawns comes off the profile a row
  // names, and the first profile is what a row with none of its own falls back to.
  expect(isSettingKey('engine')).toBe(false);
});

it('refuses an engine profile list that cannot be run', () => {
  const profile = { id: 'work', label: 'Work', vendor: 'codex', configDir: null };

  expect(validateProfiles([profile])).toBeNull();
  expect(validateProfiles([])).toMatch(/at least one/);
  expect(validateProfiles('claude-code')).toMatch(/a list/);
  // Two rows under one id would share every stored choice without saying so.
  expect(validateProfiles([profile, { ...profile, label: 'Other' }])).toMatch(/two engine profiles with the id work/);
  expect(validateProfiles([{ ...profile, vendor: 'gemini-cli' }])).toMatch(/does not know/);
  expect(validateProfiles([{ ...profile, label: '  ' }])).toMatch(/needs a label/);
  expect(validateProfiles([{ ...profile, id: '' }])).toMatch(/not an engine profile id/);
  expect(validateProfiles([{ ...profile, id: 'has space' }])).toMatch(/not an engine profile id/);
  expect(validateProfiles([{ ...profile, configDir: 7 }])).toMatch(/is a path/);
});

// Only a run writes this, so a person never reads these sentences. A hand edited database is what
// they are for: a share that is not a number would draw NaN on the Engines screen.
it('refuses a stored limit state a screen could not draw', () => {
  const window = { name: 'five_hour', used: 0.62, resetsAt: 1789551000, status: 'allowed' };
  const seen = { seenAt: 1789550000000, windows: [window] };

  expect(validateLimits({ 'claude-code': seen })).toBeNull();
  // Every field but the name may be missing, because the engine leaves them out.
  expect(validateLimits({ 'claude-code': { ...seen, windows: [{ name: 'seven_day', used: null, resetsAt: null, status: null }] } })).toBeNull();
  // A window this version has no label for is kept, or a refusal under a new name would be lost.
  expect(validateLimits({ 'claude-code': { ...seen, windows: [{ ...window, name: 'opus_seven_day' }] } })).toBeNull();
  expect(validateLimits([])).toMatch(/one entry per profile id/);
  expect(validateLimits('none')).toMatch(/one entry per profile id/);
  expect(validateLimits({ 'has space': seen })).toMatch(/not an engine profile id/);
  expect(validateLimits({ 'claude-code': 'yesterday' })).toMatch(/the time it was seen and a list/);
  expect(validateLimits({ 'claude-code': { windows: [] } })).toMatch(/needs the time it was seen/);
  expect(validateLimits({ 'claude-code': { ...seen, seenAt: 'yesterday' } })).toMatch(/needs the time it was seen/);
  expect(validateLimits({ 'claude-code': { ...seen, windows: {} } })).toMatch(/holds a list of usage windows/);
  expect(validateLimits({ 'claude-code': { ...seen, windows: ['five_hour'] } })).toMatch(/a name, a share, a reset time and a status/);
  expect(validateLimits({ 'claude-code': { ...seen, windows: [{ ...window, name: '  ' }] } })).toMatch(/needs the name the engine gave it/);
  expect(validateLimits({ 'claude-code': { ...seen, windows: [{ ...window, used: 'lots' }] } })).toMatch(/share of the five_hour window/);
  expect(validateLimits({ 'claude-code': { ...seen, windows: [{ ...window, resetsAt: 'noon' }] } })).toMatch(/reset time of the five_hour window/);
  expect(validateLimits({ 'claude-code': { ...seen, windows: [{ ...window, status: 7 }] } })).toMatch(/status of the five_hour window/);
});

it('refuses a config folder a run could not use', () => {
  const codex = { id: 'codex#work', label: 'Work', vendor: 'codex', configDir: '/work/codex' };

  expect(validateProfiles([codex])).toBeNull();
  // The vendor resolves a relative folder against the card's checkout, so it would make a login
  // folder inside somebody's repository.
  expect(validateProfiles([{ ...codex, configDir: '.codex' }])).toMatch(/not a full path/);
  // The shell expands `~`, nothing here does, so the message says so where the person can fix it.
  expect(validateProfiles([{ ...codex, configDir: '~/.codex' }])).toMatch(/not expanded/);
});

it('refuses two logins of one vendor that would share a folder', () => {
  const first = { id: 'codex', label: 'Personal', vendor: 'codex', configDir: null };
  const second = { id: 'codex#work', label: 'Work', vendor: 'codex', configDir: null };

  // Both on the vendor's default place means both read the same login, and a card that picks one
  // would silently run on the other.
  expect(validateProfiles([first, second])).toMatch(/would share one login/);
  // With a folder of its own the second is a real second login.
  expect(validateProfiles([first, { ...second, configDir: '/work/codex' }])).toBeNull();
  // And one of each vendor with no folder is fine, because they are different logins already.
  expect(validateProfiles([first, { id: 'cursor', label: 'Cursor', vendor: 'cursor', configDir: null }])).toBeNull();
  // Two names over one folder is the same shared login as two names over the default place.
  const work = { id: 'codex#work', label: 'Work', vendor: 'codex', configDir: '/work/codex' };
  expect(validateProfiles([work, { ...work, id: 'codex#side', label: 'Side' }])).toMatch(/would share one login/);
  // The same folder under another vendor is another login, because the vendors read it apart.
  expect(validateProfiles([work, { id: 'cursor#work', label: 'Work', vendor: 'cursor', configDir: '/work/codex' }])).toBeNull();
});

it('falls back to the one profile when the stored list does not parse', () => {
  // A hand edited database must not stop the app from starting, and an empty list would leave
  // every action inheriting nothing.
  expect(readSetting('engineProfiles', '[]')).toEqual({ value: DEFAULTS.engineProfiles, fellBack: true });
  expect(readSetting('engineProfiles', 'not json')).toEqual({ value: DEFAULTS.engineProfiles, fellBack: true });
});

// Antigravity was an engine before 0.1.0 and is not one now (Google's terms). A machine that used it
// still stores its profile and its preset choices. They read as removed, and every other login and
// choice reads as it was stored, rather than the whole list falling back to the default.
it('reads a stored Antigravity profile and preset choice as removed, and keeps the rest', () => {
  const codex = { id: 'codex', label: 'Codex', vendor: 'codex', configDir: null };
  const agy = { id: 'antigravity', label: 'Antigravity', vendor: 'antigravity', configDir: null };
  expect(readSetting('engineProfiles', JSON.stringify([agy, codex]))).toEqual({ value: [codex], fellBack: false });
  // A new profile of it is still refused, by the vendor rule every unknown vendor meets.
  expect(validateProfiles([agy])).toMatch(/does not know/);
  const heavy = { implement: { engine: 'codex', model: 'gpt-5.6-sol' } };
  expect(readSetting('presetChoices', JSON.stringify({ 'heavy:antigravity': { implement: { engine: 'antigravity', model: 'gemini-3.1-pro-high' } }, 'heavy:codex': heavy }))).toEqual({
    value: { 'heavy:codex': heavy },
    fellBack: false,
  });
  expect(readSetting('presetEngine', '"antigravity"')).toEqual({ value: null, fellBack: true });
});

// A list of the boards that are off, and not of the ones that are on. A board a later version adds is
// then on for everybody, including a person who turned one off before it existed.
it('starts with every board on, and refuses Delivery, an unknown board and a board named twice', () => {
  expect(DEFAULTS.offBoards).toEqual([]);
  expect(validateSetting('offBoards', ['epics', 'prreview'])).toEqual({ ok: true, value: ['epics', 'prreview'] });
  expect(validateSetting('offBoards', ['delivery'])).toEqual({ ok: false, message: 'The Delivery board cannot be turned off.' });
  expect(validateSetting('offBoards', ['recipes'])).toEqual({ ok: false, message: 'There is no recipes board.' });
  expect(validateSetting('offBoards', ['epics', 'epics'])).toEqual({ ok: false, message: 'The Epics board is in the list twice.' });
  expect(validateSetting('offBoards', 'epics')).toEqual({ ok: false, message: 'The boards that are off are a list of board names.' });
  expect(readSetting('offBoards', '["delivery"]')).toEqual({ value: [], fellBack: true });
});

// Research is one list over two kinds, so the two are on or off together. A list
// from before that holds one of them reads as Research on, because a kind that was on was in use.
it('keeps both Research kinds on or off together', () => {
  expect(validateSetting('offBoards', ['questions', 'investigations', 'epics'])).toEqual({ ok: true, value: ['questions', 'investigations', 'epics'] });
  expect(validateSetting('offBoards', ['investigations', 'prreview'])).toEqual({ ok: true, value: ['prreview'] });
  expect(readSetting('offBoards', '["questions"]')).toEqual({ value: [], fellBack: false });
});

// The project-wide stack hook is gone: its rows moved to an own answer under '*' in a migration.
it('knows no stack hook keys any more', () => {
  expect(Object.keys(DEFAULTS).filter((key) => key.startsWith('stack'))).toEqual([]);
});

// The high-water mark of the hub relay. A machine that has finished no job is at zero, and a stored
// value nobody can read falls back to zero, which makes the next job run rather than be dropped.
it('starts the hub mark at zero and takes whole numbers from zero up', () => {
  expect(DEFAULTS.hubJobDone).toBe(0);
  expect(validateSetting('hubJobDone', 0)).toEqual({ ok: true, value: 0 });
  expect(validateSetting('hubJobDone', 12)).toEqual({ ok: true, value: 12 });
  expect(validateSetting('hubJobDone', -1)).toMatchObject({ ok: false });
  expect(validateSetting('hubJobDone', 1.5)).toMatchObject({ ok: false });
  expect(readSetting('hubJobDone', '"7"')).toEqual({ value: 0, fellBack: true });
});

// The team project this machine joined. It sits beside the personal id and replaces nothing: a
// machine on a team project holds both and dials both hubs.
it('starts with no team project and takes the id the team hub minted', () => {
  expect(DEFAULTS.teamProjectId).toBeNull();
  expect(validateSetting('teamProjectId', 'team-project-1')).toEqual({ ok: true, value: 'team-project-1' });
  expect(validateSetting('teamProjectId', null)).toEqual({ ok: true, value: null });
  expect(validateSetting('teamProjectId', ' ')).toMatchObject({ ok: false });
  expect(validateSetting('teamProjectId', 7)).toMatchObject({ ok: false });
});

// A second mark and not a share of the one above. A job id counts from 1 inside each hub, so one mark for
// both sockets would drop the other hub's first jobs and ack every one of them.
it('starts the team hub mark at zero and keeps it apart from the personal one', () => {
  expect(DEFAULTS.teamHubJobDone).toBe(0);
  expect(validateSetting('teamHubJobDone', 0)).toEqual({ ok: true, value: 0 });
  expect(validateSetting('teamHubJobDone', 12)).toEqual({ ok: true, value: 12 });
  expect(validateSetting('teamHubJobDone', -1)).toMatchObject({ ok: false });
  expect(validateSetting('teamHubJobDone', 1.5)).toMatchObject({ ok: false });
  expect(readSetting('teamHubJobDone', '"7"')).toEqual({ value: 0, fellBack: true });
});

// The account's projects as the personal hub last listed them. Null until the hub has answered, which
// is every free machine, so `/api/projects` answers this machine's project alone there.
it('starts with no account project list and keeps the one the hub sent', () => {
  const listed = [{ id: 'p-1', name: 'recipes', lastActivity: '2026-10-07T09:15:00.000Z' }];
  expect(DEFAULTS.accountProjects).toBeNull();
  expect(validateSetting('accountProjects', listed)).toEqual({ ok: true, value: listed });
  expect(validateSetting('accountProjects', [])).toEqual({ ok: true, value: [] });
  expect(validateSetting('accountProjects', null)).toEqual({ ok: true, value: null });
  expect(validateSetting('accountProjects', [{ name: 'recipes' }])).toMatchObject({ ok: false });
  expect(readSetting('accountProjects', '{"projects":[]}')).toEqual({ value: null, fellBack: true });
});

// The three the Projects page writes. The rate is the one a person can get wrong by typing, so it
// is refused in its own words and the other two are not dragged down with it.
it('starts with no client name and no hourly rate, and bills in US dollars', () => {
  expect(DEFAULTS.clientName).toBeNull();
  expect(DEFAULTS.hourlyRate).toBeNull();
  expect(DEFAULTS.currency).toBe('USD');
});

it('refuses an hourly rate that is not a number, in its own sentence', () => {
  expect(validateSetting('hourlyRate', '80')).toMatchObject({ ok: false, message: 'The hourly rate is a number, such as 80, or nothing at all.' });
  // Number('eighty') is NaN, which is a number and still not a rate.
  expect(validateSetting('hourlyRate', Number.NaN)).toMatchObject({ ok: false });
  expect(validateSetting('hourlyRate', -5)).toMatchObject({ ok: false });
  expect(validateSetting('hourlyRate', 80)).toEqual({ ok: true, value: 80 });
  expect(validateSetting('hourlyRate', 82.5)).toEqual({ ok: true, value: 82.5 });
  expect(validateSetting('hourlyRate', null)).toEqual({ ok: true, value: null });
});

it('takes a client name or nothing, and refuses an empty one', () => {
  expect(validateSetting('clientName', 'The recipe app')).toEqual({ ok: true, value: 'The recipe app' });
  expect(validateSetting('clientName', null)).toEqual({ ok: true, value: null });
  // Empty means nothing, and the screen stores null for it, so an empty string never reaches here.
  expect(validateSetting('clientName', '  ')).toMatchObject({ ok: false });
});

it('takes a three-letter currency code and nothing else', () => {
  expect(validateSetting('currency', 'EUR')).toEqual({ ok: true, value: 'EUR' });
  expect(validateSetting('currency', 'eur')).toMatchObject({ ok: false });
  expect(validateSetting('currency', 'EURO')).toMatchObject({ ok: false });
  expect(validateSetting('currency', null)).toMatchObject({ ok: false });
  expect(readSetting('currency', '"euro"')).toEqual({ value: 'USD', fellBack: true });
});

// Null is how every project saved before several repositories existed reads, so it has to mean the
// one repository those projects already had, on the base branch they already set.
it('reads no repository list as one repository at the project folder on the base branch', () => {
  expect(DEFAULTS.repos).toBeNull();
  expect(projectRepos({ repos: null, baseBranch: 'develop' })).toEqual([{ path: '.', base: 'develop' }]);
});

it('gives each repository its own base and falls back to the base branch setting', () => {
  const repos = [
    { path: '.', base: null },
    { path: 'api', base: 'master' },
    { path: 'web', base: null },
  ];
  expect(validateSetting('repos', repos)).toEqual({ ok: true, value: repos });
  expect(projectRepos({ repos, baseBranch: 'main' })).toEqual([
    { path: '.', base: 'main' },
    { path: 'api', base: 'master' },
    { path: 'web', base: 'main' },
  ]);
});

it('takes a list of child repositories with no root repository', () => {
  const repos = [{ path: 'api', base: 'main' }, { path: 'web', base: 'develop' }];
  expect(validateRepos(repos)).toBeNull();
  expect(validateSetting('repos', null)).toEqual({ ok: true, value: null });
});

it('keeps only the folder and the base of a stored repository', () => {
  expect(validateSetting('repos', [{ path: 'api', base: null, cmd: 'x' }])).toEqual({ ok: true, value: [{ path: 'api', base: null }] });
});

it.each([
  [{}, /a list/],
  [[], /empty/],
  [['api'], /a folder and a base branch/],
  [[{ path: '..', base: null }], /not "." or one folder name/],
  [[{ path: 'a/b', base: null }], /not "." or one folder name/],
  [[{ path: 'a\\b', base: null }], /not "." or one folder name/],
  [[{ path: '', base: null }], /not "." or one folder name/],
  [[{ path: 7, base: null }], /needs a folder/],
  [[{ path: 'api', base: null }, { path: 'api', base: 'main' }], /"api" is in the list twice/],
  [[{ path: '.', base: null }, { path: '.', base: null }], /"\." is in the list twice/],
  [[{ path: 'api', base: null }, { path: 'API', base: null }], /"API" is in the list twice/],
  [[{ path: '.', base: null }, { path: '.git', base: null }], /not "\." or one folder name/],
  [[{ path: '.GIT', base: null }], /not "\." or one folder name/],
  [[{ path: 'api', base: null }, { path: '.', base: null }], /comes first/],
  [[{ path: 'api', base: ' ' }], /base branch of "api" is empty/],
  [[{ path: 'api', base: 3 }], /base branch of "api" is not a branch name/],
  [[{ path: 'api' }], /base branch of "api" is not a branch name/],
])('refuses the repository list %j and says why', (value, why) => {
  expect(validateRepos(value)).toMatch(why);
  expect(validateSetting('repos', value).ok).toBe(false);
});

it('falls back to one repository when the stored list cannot be read', () => {
  expect(readSetting('repos', '[{"path":"../other","base":null}]')).toEqual({ value: null, fellBack: true });
  expect(readSetting('repos', 'not json')).toEqual({ value: null, fellBack: true });
});

// Both orders, because the check keeps one spelling of each folder and compares the next row to it.
it('refuses two repositories that differ only in case, whichever comes first', () => {
  expect(validateRepos([{ path: 'API', base: null }, { path: 'api', base: null }])).toMatch(/"api" is in the list twice/);
});

// A workspace is a folder that holds repositories and is never one a card changes. Null is every
// project made before workspaces existed, and keeps all of the rules above.
it('reads no workspace setting as an ordinary project', () => {
  expect(DEFAULTS.workspace).toBeNull();
  expect(validateSetting('workspace', true)).toEqual({ ok: true, value: true });
  expect(validateSetting('workspace', null)).toEqual({ ok: true, value: null });
  expect(validateSetting('workspace', false)).toMatchObject({ ok: false });
  expect(readSetting('workspace', '"yes"')).toEqual({ value: null, fellBack: true });
});

it('takes an empty list in a workspace and nowhere else', () => {
  expect(validateRepos([], true)).toBeNull();
  expect(validateSetting('repos', [], true)).toEqual({ ok: true, value: [] });
  expect(readSetting('repos', '[]', true)).toEqual({ value: [], fellBack: false });
  expect(projectRepos({ repos: [], baseBranch: 'main' })).toEqual([]);

  expect(validateRepos([])).toMatch(/empty/);
  expect(readSetting('repos', '[]')).toEqual({ value: null, fellBack: true });
});

it('refuses the workspace folder itself in a workspace list', () => {
  expect(validateRepos([{ path: '.', base: null }, { path: 'api', base: null }], true)).toBe(
    'A workspace is never a repository a card changes, so "." is not in its list.',
  );
  expect(validateRepos([{ path: 'api', base: null }], true)).toBeNull();
});

it.each([
  ['worktrees', /where Nolzu keeps its own files/],
  ['WORKTREES', /where Nolzu keeps its own files/],
  ['.tasks', /where Nolzu keeps its own files/],
  ['.nolzu', /where Nolzu keeps its own files/],
  ['-x', /starts with "-"/],
  ['--upload-pack=x', /starts with "-"/],
])('refuses %s as a repository folder in every list', (path, why) => {
  expect(isFolderName(path)).toBe(false);
  for (const workspace of [false, true]) {
    expect(validateRepos([{ path, base: null }], workspace)).toMatch(why);
  }
});

// The coach notes a person closed, by name, so each note shows once. A row nobody can read falls back
// to none closed, which shows a note again and loses nothing.
it('starts with no coach note closed, and takes a list of short note names', () => {
  expect(DEFAULTS.seenNotes).toEqual([]);
  expect(validateSetting('seenNotes', ['first-drag'])).toEqual({ ok: true, value: ['first-drag'] });
  expect(validateSetting('seenNotes', 'first-drag')).toMatchObject({ ok: false });
  expect(validateSetting('seenNotes', [''])).toMatchObject({ ok: false });
  expect(validateSetting('seenNotes', ['First drag'])).toMatchObject({ ok: false });
  expect(validateSetting('seenNotes', [3])).toMatchObject({ ok: false });
  expect(readSetting('seenNotes', '"first-drag"')).toEqual({ value: [], fellBack: true });
});

// Getting started records the two steps that leave no row of their own. Null is a project New project
// did not make, which shows no list, so a machine that updates sees none.
it('starts with no Getting started list, and records only the plain summary read and the first push', () => {
  expect(DEFAULTS.gettingStarted).toBeNull();
  expect(validateSetting('gettingStarted', [])).toEqual({ ok: true, value: [] });
  expect(validateSetting('gettingStarted', ['summary', 'push'])).toEqual({ ok: true, value: ['summary', 'push'] });
  expect(validateSetting('gettingStarted', null)).toEqual({ ok: true, value: null });
  expect(validateSetting('gettingStarted', ['card'])).toMatchObject({ ok: false });
  expect(validateSetting('gettingStarted', ['push', 'push'])).toMatchObject({ ok: false });
  expect(validateSetting('gettingStarted', 'push')).toMatchObject({ ok: false });
  expect(readSetting('gettingStarted', '["drag"]')).toEqual({ value: null, fellBack: true });
});

// The newest finding the person has seen on the Scout page, as that finding's first seen stamp. Null is
// a project nobody opened Scout on, where every finding counts as new.
it('starts with no Scout seen marker, and takes a stamp', () => {
  expect(DEFAULTS.scoutSeen).toBeNull();
  expect(validateSetting('scoutSeen', '2026-10-12T13:02:00.000Z')).toEqual({ ok: true, value: '2026-10-12T13:02:00.000Z' });
  expect(validateSetting('scoutSeen', null)).toEqual({ ok: true, value: null });
  expect(validateSetting('scoutSeen', 'yesterday')).toMatchObject({ ok: false });
  expect(validateSetting('scoutSeen', 7)).toMatchObject({ ok: false });
  expect(readSetting('scoutSeen', '"soon"')).toEqual({ value: null, fellBack: true });
});

// The engine of a built-in preset and the saved preset in use, per project. Both start empty, which is
// how a project reads from before the choice: the first login, the built-in preset.
it('starts with no preset engine and no saved preset chosen, and takes each', () => {
  expect([DEFAULTS.presetEngine, DEFAULTS.savedPreset]).toEqual([null, null]);
  expect(validateSetting('presetEngine', 'cursor')).toEqual({ ok: true, value: 'cursor' });
  expect(validateSetting('presetEngine', 'codex#work')).toMatchObject({ ok: false });
  expect(validateSetting('savedPreset', 'Evenings')).toEqual({ ok: true, value: 'Evenings' });
  expect(validateSetting('savedPreset', ' ')).toMatchObject({ ok: false });
  expect(isMachineKey('presetEngine')).toBe(false);
  expect(isMachineKey('savedPreset')).toBe(false);
  expect(DEFAULTS.presetChosen).toBe(false);
  expect(validateSetting('presetChosen', true)).toEqual({ ok: true, value: true });
  expect(validateSetting('presetChosen', 'yes')).toMatchObject({ ok: false });
  expect(isMachineKey('presetChosen')).toBe(false);
});

// How QA gets the app, as the question at the first QA stores it, per repository. The address is read
// with the rule the question uses, so a hand edited row cannot hold an address the question would refuse.
it('takes each answer to how QA gets the app per repository, and nothing until it is answered', () => {
  expect(DEFAULTS.qaApp).toBeNull();
  expect(validateSetting('qaApp', { web: { mode: 'code' } })).toEqual({ ok: true, value: { web: { mode: 'code' } } });
  expect(validateSetting('qaApp', { '.': { mode: 'running', address: 'localhost:5173' } })).toEqual({ ok: true, value: { '.': { mode: 'running', address: 'http://localhost:5173' } } });
  expect(validateSetting('qaApp', { web: { mode: 'dev', command: 'npm run dev', repo: 'web' }, api: { mode: 'code' } })).toEqual({
    ok: true,
    value: { web: { mode: 'dev', command: 'npm run dev', repo: 'web' }, api: { mode: 'code' } },
  });
  expect(validateSetting('qaApp', {})).toEqual({ ok: true, value: null });
  expect(validateSetting('qaApp', null)).toEqual({ ok: true, value: null });
});

// The one answer a project stored before answers were per repository.
it('moves a single QA app answer to its repository, or to every repository when it names none', () => {
  expect(validateSetting('qaApp', { mode: 'dev', command: 'npm run dev', repo: 'web', scripts: 'a'.repeat(64) })).toEqual({
    ok: true,
    value: { web: { mode: 'dev', command: 'npm run dev', repo: 'web', scripts: 'a'.repeat(64) } },
  });
  expect(validateSetting('qaApp', { mode: 'code' })).toEqual({ ok: true, value: { '*': { mode: 'code' } } });
  expect(validateSetting('qaApp', { mode: 'running', address: 'localhost:5173' })).toEqual({ ok: true, value: { '*': { mode: 'running', address: 'http://localhost:5173' } } });
});

it.each([
  { mode: 'running', address: 'not an address' },
  { mode: 'dev', command: ' ', repo: '.' },
  { mode: 'dev', command: 'npm run dev', repo: '../web' },
  { mode: 'stack' },
  'code',
  { '../web': { mode: 'code' } },
  { web: { mode: 'dev', command: 'npm run dev', repo: 'api' } },
  { web: { mode: 'stack' } },
  { api: { mode: 'own', start: '  ' } },
  { web: { mode: 'dev', command: 'npm run dev', repo: 'web', folder: '../api' } },
  { web: { mode: 'dev', command: 'npm run dev', repo: 'web', folder: 7 } },
  { api: { mode: 'own', stop: 'docker compose down' } },
  { api: { mode: 'own', start: 'docker compose up -d', stop: 7 } },
])('refuses the QA app answer %j', (value) => {
  expect(validateSetting('qaApp', value).ok).toBe(false);
});

it('keeps the scripts hash of a start command, and drops one in another shape', () => {
  const hash = 'a'.repeat(64);
  expect(validateSetting('qaApp', { '.': { mode: 'dev', command: 'npm run dev', repo: '.', scripts: hash } })).toEqual({ ok: true, value: { '.': { mode: 'dev', command: 'npm run dev', repo: '.', scripts: hash } } });
  expect(validateSetting('qaApp', { '.': { mode: 'dev', command: 'npm run dev', repo: '.', scripts: 'x' } })).toEqual({ ok: true, value: { '.': { mode: 'dev', command: 'npm run dev', repo: '.' } } });
});

// Your own commands: Start is required, Stop and Status are optional, and an empty one is none.
it('takes own commands as a QA app answer, per repository or for every one', () => {
  expect(validateSetting('qaApp', { api: { mode: 'own', start: ' docker compose up -d ', stop: 'docker compose down', status: '  ' } })).toEqual({
    ok: true,
    value: { api: { mode: 'own', start: 'docker compose up -d', stop: 'docker compose down', status: null } },
  });
  expect(validateSetting('qaApp', { '*': { mode: 'own', start: './up.sh {key}', extra: 1 } })).toEqual({ ok: true, value: { '*': { mode: 'own', start: './up.sh {key}', stop: null, status: null } } });
});

// A start command one folder down keeps that folder, where it runs.
it('keeps the folder of a start command one folder down', () => {
  expect(validateSetting('qaApp', { web: { mode: 'dev', command: 'npm run dev', repo: 'web', folder: 'frontend' } })).toEqual({
    ok: true,
    value: { web: { mode: 'dev', command: 'npm run dev', repo: 'web', folder: 'frontend' } },
  });
});

it('keeps only the fields of the code mode in the QA app answer', () => {
  expect(validateSetting('qaApp', { '.': { mode: 'code', command: 'rm -rf /', extra: 1 } })).toEqual({ ok: true, value: { '.': { mode: 'code' } } });
});

// Jira can be the ticket system. Nothing else can, and the site and the
// email are read the way a Jira Scout source reads them.
it('takes local or jira as the ticket system and refuses anything else', () => {
  expect(DEFAULTS.ticketSystem).toBe('local');
  expect(validateSetting('ticketSystem', 'local')).toEqual({ ok: true, value: 'local' });
  expect(validateSetting('ticketSystem', 'jira')).toEqual({ ok: true, value: 'jira' });
  for (const refused of ['linear', 'github', 'Jira', '', null, 1]) {
    expect(validateSetting('ticketSystem', refused)).toEqual({ ok: false, message: 'The ticket system is local or jira.' });
  }
  expect(readSetting('ticketSystem', '"linear"')).toEqual({ value: 'local', fellBack: true });
});

it('keeps the Jira site as its https origin, and refuses one a Jira Scout source refuses', () => {
  expect(DEFAULTS.jiraSite).toBeNull();
  expect(validateSetting('jiraSite', null)).toEqual({ ok: true, value: null });
  expect(validateSetting('jiraSite', ' https://you.atlassian.net/jira/your-work ')).toEqual({ ok: true, value: 'https://you.atlassian.net' });
  expect(validateSetting('jiraSite', 'http://you.atlassian.net')).toMatchObject({ ok: false, message: expect.stringMatching(/starts with https/) });
  expect(validateSetting('jiraSite', 'you.atlassian.net')).toMatchObject({ ok: false, message: expect.stringMatching(/not a site address/) });
  expect(validateSetting('jiraSite', 'https://me:secret@you.atlassian.net')).toMatchObject({ ok: false, message: expect.not.stringContaining('secret') });
});

it('takes the Jira account email, and refuses one with no @ or with a space', () => {
  expect(DEFAULTS.jiraEmail).toBeNull();
  expect(validateSetting('jiraEmail', ' dana@example.com ')).toEqual({ ok: true, value: 'dana@example.com' });
  for (const refused of ['', 'dana', 'dana@', '@example.com', 'dana smith@example.com', 7]) {
    expect(validateSetting('jiraEmail', refused)).toEqual({ ok: false, message: 'The Jira account email is the address you sign in to Jira with, such as you@example.com.' });
  }
});

// These follow the machine and not a project. The Runs settings, the engine
// logins and their limits, the hub's job marks, the account's project list, the first run, the
// project opened last, the Jira login of Settings, Integrations, and the accepted terms.
it('names the machine keys, and leaves every other key with the project', () => {
  expect([...MACHINE_KEYS].sort()).toEqual(
    [
      'accountProjects',
      'agentSlots',
      'currentProject',
      'engineLimits',
      'engineProfiles',
      'gettingStarted',
      'hubJobDone',
      'jiraEmail',
      'jiraSite',
      'keepAwake',
      'onboarding',
      'retryWaitsMs',
      'runTimeoutMs',
      'seenNotes',
      'syncPaused',
      'termsAccepted',
    ].sort(),
  );
  expect(isMachineKey('engineProfiles')).toBe(true);
  for (const key of ['projectPath', 'repos', 'projectId', 'teamProjectId', 'teamHubJobDone', 'quietAfterMs', 'models'] as const) expect(isMachineKey(key)).toBe(false);
});

it('takes a registry id or nothing as the current project', () => {
  expect(validateSetting('currentProject', null)).toEqual({ ok: true, value: null });
  expect(validateSetting('currentProject', 2)).toEqual({ ok: true, value: 2 });
  for (const refused of [0, -1, 1.5, '2']) expect(validateSetting('currentProject', refused)).toMatchObject({ ok: false });
  expect(isMachineKey('currentProject')).toBe(true);
});

// When Read pull requests last finished, for the PR reviews board's "read 12m ago". Null before the first.
it('starts with no pull request read time, and takes a stamp', () => {
  expect(DEFAULTS.pullsReadAt).toBeNull();
  expect(validateSetting('pullsReadAt', '2026-10-20T09:12:00.000Z')).toEqual({ ok: true, value: '2026-10-20T09:12:00.000Z' });
  expect(validateSetting('pullsReadAt', null)).toEqual({ ok: true, value: null });
  expect(validateSetting('pullsReadAt', 'soon')).toMatchObject({ ok: false });
  expect(isMachineKey('pullsReadAt')).toBe(false);
});

// Set up the project keeps one mark per step, per project. Null is a project made before the steps.
it('starts with no setup marks, and takes a known step with a known mark only', () => {
  expect(DEFAULTS.setupSteps).toBeNull();
  expect(validateSetting('setupSteps', { learn: 'self', qa: 'dismissed' })).toEqual({ ok: true, value: { learn: 'self', qa: 'dismissed' } });
  expect(validateSetting('setupSteps', null)).toEqual({ ok: true, value: null });
  for (const refused of [[], 'learn', { cook: 'done' }, { learn: 'later' }]) expect(validateSetting('setupSteps', refused)).toMatchObject({ ok: false });
  expect(isMachineKey('setupSteps')).toBe(false);
});

// The path rules need the disk and live in the runner. Here only the shape, so a hand edit that
// breaks it falls back to empty lists, which loosen nothing.
it('keeps three empty wall lists by default and refuses another shape', () => {
  expect(DEFAULTS.wallLists).toEqual({ hidden: [], exceptions: [], writable: [] });
  const lists = { hidden: ['~/secrets'], exceptions: ['.env.test'], writable: ['~/.gradle'] };
  expect(validateSetting('wallLists', lists)).toEqual({ ok: true, value: lists });
  expect(validateSetting('wallLists', { hidden: [], exceptions: [] }).ok).toBe(false);
  expect(validateSetting('wallLists', { hidden: [1], exceptions: [], writable: [] }).ok).toBe(false);
  expect(validateSetting('wallLists', null).ok).toBe(false);
  expect(readSetting('wallLists', '{"hidden":"~/x"}')).toEqual({ value: DEFAULTS.wallLists, fellBack: true });
});
