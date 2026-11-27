import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getSetting, openDatabase, recordKnowledgeChanges, startRun, writeSetting } from '@nolzu/core/node';
import { chmodSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveKnowledgeDir } from '@nolzu/core';
import { skillsFolder } from '@nolzu/skills';
import { checkKnowledgeDir, git as runGit, gitEnv, keepForShipped, keptMark, type RunGit } from '@nolzu/runner';
import { filesOffer, filesStatusLine } from './project-files-notice.ts';
import { checkProject, createWorkspace, engineCheck, handEditedFiles, keepMine, knowledgeMovesPending, NOLZU_VERSION, onboardRedirect, applySetup, projectFilesNotice, projectFilesStatus, removeMade, saveProject, setupSaid, storeTickets, takeShipped } from './onboard.ts';

let dir = '';
let db: DatabaseSync;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nolzu-onboard-'));
  db = openDatabase(dir);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('onboardRedirect', () => {
  it('sends a first run with no project to New project', () => {
    expect(onboardRedirect(db, '/')).toBe('/new');
    expect(onboardRedirect(db, '/t/APP-1/overview')).toBe('/new');
    expect(onboardRedirect(db, '/onboard')).toBe('/new');
  });

  it('does not send New project to itself', () => {
    expect(onboardRedirect(db, '/new')).toBeNull();
  });

  it('leaves a machine with a project alone', () => {
    writeSetting(db, 'projectPath', '/work/recipes');

    expect(onboardRedirect(db, '/')).toBeNull();
  });

  // The redirect asks only whether there is a project yet, so a first run that ended and then lost
  // its project goes to New project again.
  it('sends a machine with no project yet to New project, also after a first run ended', () => {
    writeSetting(db, 'onboarding', { done: true });

    expect(onboardRedirect(db, '/')).toBe('/new');
    expect(onboardRedirect(db, '/new/task')).toBeNull();
  });
});

describe('the engine check', () => {
  it('reports the three engines from the detector it is given', async () => {
    const found = await engineCheck(async (binary) => (binary === 'claude' ? { code: 0, stdout: '2.1.278 (Claude Code)\n' } : { code: null, stdout: '', missing: true }));

    expect(found.map((one) => [one.engine, one.found])).toEqual([
      ['claude-code', true],
      ['cursor', false],
      ['codex', false],
    ]);
  });

  // The check reads versions only, so nothing about a login ever reaches the page.
  it('sends no token and no credential path to the page', async () => {
    const payload = JSON.stringify(await engineCheck(async () => ({ code: 0, stdout: '1.0.0\n' })));

    expect(payload).not.toMatch(/token|credential|\.claude\/|api[_-]?key|secret/i);
  });
});

describe('opening a folder as the project', () => {
  // A real repository in a temp folder, so the save is tested against git and not a stub of it.
  let home = '';
  const gitEnv = () => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' });
  const repoAt = (name: string, branch = 'main') => {
    const at = join(home, name);
    mkdirSync(at, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', branch, at], { env: gitEnv() });
    execFileSync('git', ['-C', at, 'commit', '-q', '--allow-empty', '-m', 'first'], { env: gitEnv() });
    return at;
  };
  const answer = (path: string, template = '{key}-{slug}', base?: string) => ({ path, template, base, home, env: gitEnv() });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nolzu-onboard-home-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('stores the path, the base branch and the template', async () => {
    const at = repoAt('recipes', 'trunk');

    const saved = await saveProject(db, answer(at, 'feature/{key}-{slug}'));

    expect(saved.ok).toBe(true);
    expect(getSetting(db, 'projectPath')).toBe(at);
    expect(getSetting(db, 'baseBranch')).toBe('trunk');
    expect(getSetting(db, 'branchTemplate')).toBe('feature/{key}-{slug}');
  });

  // The first allowed-commands list is filled when the project is saved, so the person sees it
  // on /projects before a run uses it.
  it('fills the allowed commands from the project scripts when the project is saved', async () => {
    const at = repoAt('recipes');
    writeFileSync(join(at, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));

    await saveProject(db, answer(at));

    expect(getSetting(db, 'allowedCommands')).toEqual(['npm install', 'npm test']);
  });

  // `teamProjectId` belongs to the machine and only a `project.join` job writes it, so a folder
  // saved over a team's folder used to keep the old id. A wrap-up run then read it, committed
  // nothing to this person's own knowledge files, and sent their note to that team.
  it('lets go of the team when another folder becomes the project', async () => {
    await saveProject(db, answer(repoAt('team-recipes')));
    writeSetting(db, 'teamProjectId', 'team-project-1');

    await saveProject(db, answer(repoAt('my-own')));

    expect(getSetting(db, 'teamProjectId')).toBeNull();
  });

  // The other side. Saving the same folder again is not leaving the team.
  it('keeps the team when the same folder is saved again', async () => {
    const at = repoAt('team-recipes');
    await saveProject(db, answer(at));
    writeSetting(db, 'teamProjectId', 'team-project-1');
    writeSetting(db, 'qaApp', { '.': { mode: 'code' } });

    await saveProject(db, answer(at, 'feature/{key}-{slug}'));

    expect(getSetting(db, 'teamProjectId')).toBe('team-project-1');
    expect(getSetting(db, 'qaApp')).toEqual({ '.': { mode: 'code' } });
  });

  // The answer to the question at the first QA belongs to the project it was given for. Kept, the new
  // project's first QA would ask nothing and could start a command in a folder it has not got.
  it('asks how QA gets the app again when another folder becomes the project', async () => {
    await saveProject(db, answer(repoAt('recipes')));
    writeSetting(db, 'qaApp', { '.': { mode: 'dev', command: 'npm run dev', repo: '.' } });

    await saveProject(db, answer(repoAt('shop')));

    expect(getSetting(db, 'qaApp')).toBeNull();
  });

  it('takes the base branch the person typed over the one the scan found', async () => {
    const at = repoAt('recipes');
    execFileSync('git', ['-C', at, 'branch', 'develop'], { env: gitEnv() });

    await saveProject(db, answer(at, '{key}-{slug}', 'develop'));

    expect(getSetting(db, 'baseBranch')).toBe('develop');
  });

  // A card starts from the base branch, so one the repository does not have fails every first start.
  it.each(['nope', 'my branch', '-x'])('refuses a base branch the repository does not have, %j, and stores nothing', async (base) => {
    const saved = await saveProject(db, answer(repoAt('recipes'), '{key}-{slug}', base));

    expect(saved.ok).toBe(false);
    expect(saved.ok ? '' : saved.reason).toContain(base);
    expect(getSetting(db, 'projectPath')).toBeNull();
  });

  // A plain folder of repositories is one project, each repository with the base the scan found.
  it('saves a folder that holds several repositories, each with its base branch', async () => {
    repoAt('shop/web', 'master');
    repoAt('shop/api');

    const saved = await saveProject(db, answer(join(home, 'shop')));

    expect(saved.ok).toBe(true);
    expect(getSetting(db, 'projectPath')).toBe(join(home, 'shop'));
    expect(getSetting(db, 'repos')).toEqual([
      { path: 'api', base: 'main' },
      { path: 'web', base: 'master' },
    ]);
  });

  // The page always sends the base field, and hides it for several repositories, so its value
  // must not overwrite the base each repository was found on.
  it('ignores a typed base for a folder of several repositories', async () => {
    repoAt('shop/web', 'master');
    repoAt('shop/api');

    const saved = await saveProject(db, answer(join(home, 'shop'), '{key}-{slug}', 'main'));

    expect(saved.ok).toBe(true);
    expect(getSetting(db, 'repos')).toEqual([
      { path: 'api', base: 'main' },
      { path: 'web', base: 'master' },
    ]);
  });

  it('saves a root repository with the repository inside it, the root first', async () => {
    const at = repoAt('recipes');
    repoAt('recipes/api', 'develop');

    const saved = await saveProject(db, answer(at));

    expect(saved.ok).toBe(true);
    expect(getSetting(db, 'repos')).toEqual([
      { path: '.', base: 'main' },
      { path: 'api', base: 'develop' },
    ]);
    expect(getSetting(db, 'baseBranch')).toBe('main');
  });

  // The one-repository path writes what it always wrote, so no list appears where none was.
  it('leaves the repository list unset for a folder with one repository, and the base as before', async () => {
    const at = repoAt('recipes', 'trunk');

    await saveProject(db, answer(at));

    expect(getSetting(db, 'repos')).toBeNull();
    expect(getSetting(db, 'baseBranch')).toBe('trunk');
    expect(db.prepare("SELECT key FROM settings WHERE key = 'repos'").get()).toBeUndefined();
  });

  it('drops a list saved before when the folder saved now holds one repository', async () => {
    repoAt('shop/web');
    repoAt('shop/api');
    await saveProject(db, answer(join(home, 'shop')));

    await saveProject(db, answer(repoAt('recipes')));

    expect(getSetting(db, 'repos')).toBeNull();
  });

  // A workspace flag left over would read the next project's list by the workspace rules.
  it('drops the workspace flag of the project saved before', async () => {
    writeSetting(db, 'workspace', true);
    writeSetting(db, 'repos', [{ path: 'api', base: null }]);

    expect((await saveProject(db, answer(repoAt('recipes')))).ok).toBe(true);

    expect(getSetting(db, 'workspace')).toBeNull();
    expect(getSetting(db, 'repos')).toBeNull();
  });

  it.each([
    ['detached', (at: string) => execFileSync('git', ['-C', at, 'checkout', '-q', '--detach'], { env: gitEnv() }), /repository api is on no branch/],
    ['unborn', (at: string) => execFileSync('git', ['-C', at, 'checkout', '-q', '--orphan', 'fresh'], { env: gitEnv() }), /repository api.*fresh has no commit/],
  ])('refuses a repository whose base is %s, names it, and stores nothing', async (_, make, why) => {
    repoAt('shop/web');
    make(repoAt('shop/api'));

    const saved = await saveProject(db, answer(join(home, 'shop')));

    expect(saved.ok).toBe(false);
    expect(saved.ok ? '' : saved.reason).toMatch(why);
    expect(getSetting(db, 'projectPath')).toBeNull();
    expect(getSetting(db, 'repos')).toBeNull();
  });

  // A folder with one repository inside shows the base field, so what is typed there counts.
  it('takes the typed base for a folder with one repository inside, and refuses one it has not, by name', async () => {
    const web = repoAt('shop/web', 'master');
    execFileSync('git', ['-C', web, 'branch', 'develop'], { env: gitEnv() });

    const refused = await saveProject(db, answer(join(home, 'shop'), '{key}-{slug}', 'nope'));
    expect(refused.ok ? '' : refused.reason).toBe('There is no branch nope in the repository web. Type a branch it has, such as the one it is on.');
    expect(getSetting(db, 'projectPath')).toBeNull();

    expect((await saveProject(db, answer(join(home, 'shop'), '{key}-{slug}', 'develop'))).ok).toBe(true);
    expect(getSetting(db, 'repos')).toEqual([{ path: 'web', base: 'develop' }]);
    expect(getSetting(db, 'baseBranch')).toBe('develop');
  });

  // A clone made from another branch has origin's default branch only as origin/main. The page shows
  // no base field for several repositories, so the sentence names the git step instead.
  it('names the git step when a repository has no local copy of the base the scan found', async () => {
    const origin = repoAt('origin-api');
    execFileSync('git', ['-C', origin, 'branch', 'feature'], { env: gitEnv() });
    repoAt('shop/web');
    execFileSync('git', ['clone', '-q', '-b', 'feature', origin, join(home, 'shop', 'api')], { env: gitEnv() });

    const saved = await saveProject(db, answer(join(home, 'shop')));

    expect(saved.ok ? '' : saved.reason).toBe('There is no local branch main in the repository api. Make it there with git branch main origin/main, then save again.');
    expect(getSetting(db, 'repos')).toBeNull();
  });

  it('asks for a folder rather than scanning the home folder when the field is empty', async () => {
    const checked = await checkProject(answer('  '));

    expect(checked.scan).toEqual({ ok: false, reason: 'Type the folder that holds your project.' });
  });

  it.each([
    ['a folder that is not there', (h: string) => join(h, 'nope'), /not there/],
    ['a file', (h: string) => (writeFileSync(join(h, 'notes.txt'), 'x'), join(h, 'notes.txt')), /is a file/],
    ['a folder with no repository', (h: string) => (mkdirSync(join(h, 'empty')), join(h, 'empty')), /repository/],
  ])('refuses %s, says why and stores nothing', async (_, make, why) => {
    const saved = await saveProject(db, answer(make(home)));

    expect(saved).toMatchObject({ ok: false });
    expect(saved.ok ? '' : saved.reason).toMatch(why);
    expect(getSetting(db, 'projectPath')).toBeNull();
  });

  it('resolves a ~ path and a relative one against the home folder, and shows the result', async () => {
    const at = repoAt('recipes');

    expect((await checkProject(answer('~/recipes'))).path).toBe(at);
    expect((await checkProject(answer('recipes'))).path).toBe(at);
  });

  it('lists every repository of a folder that holds several', async () => {
    repoAt('shop/web');
    repoAt('shop/api');

    const checked = await checkProject(answer(join(home, 'shop')));

    expect(checked.scan.ok && checked.scan.repos.map((repo) => repo.path).sort()).toEqual(['api', 'web']);
  });

  it('previews the branch name with the template typed, and says why git would refuse one', async () => {
    const at = repoAt('recipes');

    const good = await checkProject(answer(at, 'feature/{key}'));
    const bad = await checkProject(answer(at, 'feature/{nope}'));

    expect(good.scan.ok && good.scan.branchPreview).toEqual({ ok: true, name: 'feature/PROJ-123' });
    expect(bad.scan.ok && bad.scan.branchPreview.ok).toBe(false);
  });

  it('refuses a template the setting would refuse, and stores nothing', async () => {
    const saved = await saveProject(db, answer(repoAt('recipes'), 'feature/no-key'));

    expect(saved.ok).toBe(false);
    expect(getSetting(db, 'projectPath')).toBeNull();
  });
});

describe('the key prefix', () => {
  it('stores the prefix and the local system', () => {
    expect(storeTickets(db, 'RCP')).toBeNull();
    expect(getSetting(db, 'localKeyPrefix')).toBe('RCP');
    // Stored as a row, and not only read back as the default, so the answer is there when the default changes.
    expect(db.prepare("SELECT value FROM settings WHERE key = 'ticketSystem'").get()).toEqual({ value: '"local"' });
  });

  it('keeps Jira as the system when the prefix changes', () => {
    writeSetting(db, 'ticketSystem', 'jira');

    expect(storeTickets(db, 'RCP')).toBeNull();

    expect(getSetting(db, 'ticketSystem')).toBe('jira');
  });

  it('takes a prefix typed with spaces around it', () => {
    storeTickets(db, ' RCP ');

    expect(getSetting(db, 'localKeyPrefix')).toBe('RCP');
  });

  it.each(['rcp', 'R', 'TOOLONGX'])('refuses %j with the rule and stores nothing', (prefix) => {
    expect(storeTickets(db, prefix)).toMatch(/two to six/);
    expect(db.prepare("SELECT count(*) AS n FROM settings WHERE key = 'localKeyPrefix'").get()).toEqual({ n: 0 });
  });

  // Its own earlier prefix is this project's, and going back to it is fine.
  it('takes a prefix this project used before', () => {
    db.prepare("INSERT INTO seq (name, value) VALUES ('ticket:1:APP', 2)").run();
    writeSetting(db, 'localKeyPrefix', 'SHOP');

    expect(storeTickets(db, 'APP')).toBeNull();
  });

  it('refuses the default prefix too when another project counts with it and none is stored', () => {
    db.prepare("INSERT INTO seq (name, value) VALUES ('ticket:2:APP', 4)").run();

    expect(storeTickets(db, 'APP')).not.toBeNull();
  });

  it('refuses a prefix another project already counts with', () => {
    db.prepare("INSERT INTO seq (name, value) VALUES ('ticket:2:WEB', 4)").run();

    expect(storeTickets(db, 'WEB')).toMatch(/WEB is in use/);
  });

  // Local tickets need no login, so nothing stored here is a secret of any kind.
  it('stores no secret of any kind', () => {
    storeTickets(db, 'RCP');
    // Both tables, because a machine key's row lives in machine.db.
    const values = JSON.stringify(db.prepare('SELECT key, value FROM main.settings UNION ALL SELECT key, value FROM machine.settings').all());

    expect(values).not.toMatch(/token|secret|password|api[_-]?key|credential/i);
  });
});

describe('writing the project files', () => {
  let home = '';
  const gitEnv = () => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  const project = () => {
    const at = join(home, 'recipes');
    mkdirSync(at, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', at], { env: gitEnv() });
    // The setup commits with the person's own git name, and a CI machine has none.
    execFileSync('git', ['-C', at, 'config', 'user.name', 'T'], { env: gitEnv() });
    execFileSync('git', ['-C', at, 'config', 'user.email', 't@example.invalid'], { env: gitEnv() });
    execFileSync('git', ['-C', at, 'commit', '-q', '--allow-empty', '-m', 'first'], { env: gitEnv() });
    writeSetting(db, 'projectPath', at);
    return at;
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nolzu-summary-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('writes the project files and the skills, and reports what it wrote', async () => {
    const at = project();

    const report = await applySetup(db);

    expect(report.written).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']));
    expect(report.skills).not.toBeNull();
    expect(report.failed).toBeNull();
    expect(existsSync(join(at, 'WORKSPACE.md'))).toBe(false);
    expect(existsSync(join(at, 'worktrees'))).toBe(true);
    expect(existsSync(join(at, '.tasks'))).toBe(true);
    expect(report.skills?.map((one) => one.folder)).toEqual(['.agents/skills', '.claude/skills']);
    for (const folder of ['.agents', '.claude']) expect(existsSync(join(at, folder, 'skills', 'nolzu-refine', 'SKILL.md'))).toBe(true);
    expect(report.skills?.[0]?.copied).toEqual(expect.arrayContaining([expect.stringContaining('nolzu-refine')]));
  });

  // The workspace's own skills in .nolzu/skills go with Nolzu's, and one named after a Nolzu skill is
  // refused in one sentence. Take the new one puts back the workspace's text, not nothing.
  it("copies the workspace's own skills, refuses a name Nolzu ships, and takes back their text", async () => {
    const at = project();
    mkdirSync(join(at, '.nolzu', 'skills', 'deploy-notes'), { recursive: true });
    writeFileSync(join(at, '.nolzu', 'skills', 'deploy-notes', 'SKILL.md'), '---\nname: deploy-notes\ndescription: How we deploy.\n---\n');
    mkdirSync(join(at, '.nolzu', 'skills', 'nolzu-plan'), { recursive: true });
    writeFileSync(join(at, '.nolzu', 'skills', 'nolzu-plan', 'SKILL.md'), 'not the method\n');

    const report = await applySetup(db);

    for (const folder of ['.agents', '.claude']) expect(readFileSync(join(at, folder, 'skills', 'deploy-notes', 'SKILL.md'), 'utf8')).toContain('How we deploy.');
    expect(report.refused).toEqual([{ path: '.nolzu/skills', message: 'The skill nolzu-plan in .nolzu/skills has the name of a skill Nolzu ships, in its folder or its SKILL.md, so it was not copied. Rename its folder and its name.' }]);
    expect(readFileSync(join(at, '.claude', 'skills', 'nolzu-plan', 'SKILL.md'), 'utf8')).not.toBe('not the method\n');

    writeFileSync(join(at, '.claude', 'skills', 'deploy-notes', 'SKILL.md'), 'mine\n');
    const edits = await handEditedFiles(db);
    expect(edits.find((one) => one.path === '.claude/skills/deploy-notes/SKILL.md')?.gone).toBe(false);
  });

  // Write the project files on the Projects page answers in one sentence.
  it('says in one answer what a write did', async () => {
    project();
    const first = setupSaid(await applySetup(db));
    expect(first).toMatch(/^Wrote .*CLAUDE\.md.*\. Copied \d+ skill files into \.agents\/skills and \.claude\/skills\.$/);

    expect(setupSaid(await applySetup(db))).toBe('Every project file was there already. The skills were up to date.');
    expect(
      setupSaid({ written: [], removed: [], kept: ['AGENTS.md'], alreadyRight: [], refused: [{ path: 'CLAUDE.md', message: 'CLAUDE.md is a link, so it was left alone.' }], skills: null, failed: null, knowledge: { written: [], problem: 'The repository files could not be committed.' } }),
    ).toBe('Every project file was there already. Kept AGENTS.md as you wrote it. CLAUDE.md is a link, so it was left alone. The repository files could not be committed.');
  });

  // A symlinked CLAUDE.md is a normal dotfiles setup. Writing through it would change a file every
  // other project shares, so it is left and said, and the rest of the setup still happens.
  it('leaves a linked file alone, says so, and still copies the skills', async () => {
    const at = project();
    const shared = join(home, 'shared-CLAUDE.md');
    writeFileSync(shared, 'Mine.\n');
    symlinkSync(shared, join(at, 'CLAUDE.md'));

    const report = await applySetup(db);

    expect(report.refused.map((one) => one.path)).toEqual(['CLAUDE.md']);
    expect(report.refused[0]?.message).toMatch(/by hand/);
    expect(readFileSync(shared, 'utf8')).toBe('Mine.\n');
    expect(report.written).toEqual(expect.arrayContaining(['AGENTS.md']));
    expect(report.skills?.[0]?.copied.length).toBeGreaterThan(0);
    expect(report.failed).toBeNull();
  });

  // A skills folder sits under `.claude` or `.agents`, which a dotfiles setup often links out of the
  // project. The sync guards its own folder and cannot see the one above it, so the setup checks them,
  // folder by folder.
  it('copies no skill through a linked .claude, says why, and still fills the other folder', async () => {
    const at = project();
    const outside = join(home, 'dotfiles-claude');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(at, '.claude'));

    const report = await applySetup(db);

    expect(report.skills?.map((one) => one.folder)).toEqual(['.agents/skills']);
    expect(report.refused.map((one) => one.path).filter((path) => path.includes('skills'))).toEqual(['.claude/skills']);
    expect(report.refused.find((one) => one.path === '.claude/skills')?.message).toBe('.claude or .claude/skills is a link, or something other than a folder, so the skills were not copied there. Move it away, or copy the skills by hand.');
    expect(readdirSync(outside)).toEqual([]);
    expect(setupSaid(report)).toMatch(/Copied \d+ skill files into \.agents\/skills\.$/);
  });

  // The answer names only the folders a write changed, and says nothing about skills none got.
  it('names only the folders that got a copy, and claims no skills when every folder was refused', async () => {
    const at = project();
    await applySetup(db);
    rmSync(join(at, '.claude', 'skills', 'nolzu-refine', 'SKILL.md'));
    expect(setupSaid(await applySetup(db))).toMatch(/Copied 1 skill file into \.claude\/skills\.$/);

    for (const folder of ['.agents', '.claude']) {
      rmSync(join(at, folder, 'skills'), { recursive: true, force: true });
      writeFileSync(join(at, folder, 'skills'), 'not a folder\n');
    }
    const said = setupSaid(await applySetup(db));
    expect(said).not.toMatch(/skills were up to date|Copied/);
    expect(said).toContain('.claude or .claude/skills is a link');
  });

  it('writes no byte on a second run, and reports nothing new', async () => {
    project();
    await applySetup(db);

    const again = await applySetup(db);

    expect(again.written).toEqual([]);
    expect(again.skills).toHaveLength(2);
    expect(again.skills?.flatMap((one) => one.copied)).toEqual([]);
    // Written by Nolzu before, not by the person, so the report must not say they wrote them.
    expect(again.kept).toEqual([]);
    expect(again.alreadyRight).toEqual(expect.arrayContaining(['AGENTS.md', 'CLAUDE.md']));
  });

  describe('the status of the project files', () => {
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    const record = (at: string, folder: string) => join(at, folder, '.nolzu-skills.json');
    const readRecord = (at: string, folder: string) => JSON.parse(readFileSync(record(at, folder), 'utf8')) as Record<string, string>;
    // A shipped file put back to an older text, with the record matching it, as an older Nolzu left it.
    const makeOld = (at: string, folder: string, path: string) => {
      writeFileSync(join(at, folder, path), 'An older method.\n');
      writeFileSync(record(at, folder), JSON.stringify({ ...readRecord(at, folder), [path]: sha('An older method.\n') }));
    };

    it('is none for a project Nolzu never wrote skills into', () => {
      const at = project();

      expect(projectFilesStatus(at)).toBeNull();
    });

    it('has nothing to update right after a write, and the record names this Nolzu', async () => {
      const at = project();
      await applySetup(db);

      expect(projectFilesStatus(at)).toEqual({ updates: [], yours: [], newer: null });
      expect(readRecord(at, '.agents/skills').version).toBe(NOLZU_VERSION);
    });

    it('lists the untouched files a write would update and the hand edits it keeps, and writes nothing', async () => {
      const at = project();
      await applySetup(db);
      makeOld(at, '.agents/skills', 'nolzu-refine/SKILL.md');
      writeFileSync(join(at, '.claude/skills/nolzu-plan/SKILL.md'), 'My own plan.\n');
      writeFileSync(join(at, 'AGENTS.md'), readFileSync(join(at, 'AGENTS.md'), 'utf8').replace(/<!-- nolzu:start -->[\s\S]*<!-- nolzu:end -->/, '<!-- nolzu:start -->\nOld rules.\n<!-- nolzu:end -->'));
      writeFileSync(join(at, 'WORKSPACE.md'), 'My workspace.\n');

      const status = projectFilesStatus(at);

      expect(status).toEqual({ updates: ['AGENTS.md', '.agents/skills/nolzu-refine/SKILL.md'], yours: ['.claude/skills/nolzu-plan/SKILL.md'], newer: null });
      expect(readFileSync(join(at, '.agents/skills/nolzu-refine/SKILL.md'), 'utf8')).toBe('An older method.\n');
      expect(readFileSync(join(at, 'AGENTS.md'), 'utf8')).toContain('Old rules.');
    });

    it('says a newer Nolzu wrote a folder, and a write then writes no project file at all', async () => {
      const at = project();
      await applySetup(db);
      makeOld(at, '.claude/skills', 'nolzu-refine/SKILL.md');
      makeOld(at, '.agents/skills', 'nolzu-refine/SKILL.md');
      writeFileSync(record(at, '.claude/skills'), JSON.stringify({ ...readRecord(at, '.claude/skills'), version: '999.0.0' }));
      // The newer Nolzu's agent rules, which an older one must not put back.
      writeFileSync(join(at, 'AGENTS.md'), '<!-- nolzu:start -->\nNewer rules.\n<!-- nolzu:end -->\n');
      const line = `These project files come from Nolzu 999.0.0, newer than this Nolzu ${NOLZU_VERSION}. Update Nolzu.`;

      expect(projectFilesStatus(at)?.newer).toBe(line);

      const report = await applySetup(db);

      expect(report.failed?.message).toBe(line);
      expect(readFileSync(join(at, 'AGENTS.md'), 'utf8')).toContain('Newer rules.');
      expect(readFileSync(join(at, '.claude/skills/nolzu-refine/SKILL.md'), 'utf8')).toBe('An older method.\n');
      expect(readFileSync(join(at, '.agents/skills/nolzu-refine/SKILL.md'), 'utf8')).toBe('An older method.\n');
      expect(readRecord(at, '.claude/skills').version).toBe('999.0.0');
    });

    it('does not count a linked file as an update, since the write refuses it', async () => {
      const at = project();
      await applySetup(db);
      const elsewhere = join(home, 'shared-agents.md');
      writeFileSync(elsewhere, '<!-- nolzu:start -->\nOld rules.\n<!-- nolzu:end -->\n');
      rmSync(join(at, 'AGENTS.md'));
      symlinkSync(elsewhere, join(at, 'AGENTS.md'));

      expect(projectFilesStatus(at)?.updates).toEqual([]);
    });

    // A knowledge folder of the older layout is something a write changes, so the notice offers Update.
    it('counts the knowledge files a write would move, and offers Update for them alone', async () => {
      const at = project();
      await applySetup(db);
      const k = join(at, '.nolzu', 'knowledge');
      rmSync(join(k, 'repository.md'));
      mkdirSync(join(k, 'repositories'));
      writeFileSync(join(k, 'repositories', 'project-root.md'), 'The recipe site.\n');
      // Settings, Project reads the status fresh, and the notice takes it.
      await handEditedFiles(db);

      const status = projectFilesNotice(db);
      expect(status).toEqual({ updates: [], yours: [], newer: null, moves: 1, kept: 0 });
      expect(filesStatusLine(status)).toBe('1 knowledge file waits to move into the folder of its repository.');
      expect(filesOffer(status)).toBe(true);
      expect(filesStatusLine({ updates: [], yours: [], newer: null, moves: 3 })).toBe('3 knowledge files wait to move into the folders of their repositories.');
      expect(filesOffer({ updates: [], yours: [], newer: null, moves: 0 })).toBe(false);
      // A file whose new place holds one already stays, and the line says so with no Update for it.
      const kept = { updates: [], yours: [], newer: null, moves: 0, kept: 2 };
      expect(filesStatusLine(kept)).toBe('2 knowledge files stay at their old place, because a file is at the new place already. Merge them by hand.');
      expect(filesOffer(kept)).toBe(false);
    });

    // Kept for the project until a write or a switch, so a page load walks no folder.
    it('reads the status once per project and again after a write', async () => {
      const at = project();
      await applySetup(db);
      expect(projectFilesNotice(db)).toEqual({ updates: [], yours: [], newer: null, moves: 0, kept: 0 });

      makeOld(at, '.agents/skills', 'nolzu-refine/SKILL.md');
      expect(projectFilesNotice(db)?.updates).toEqual([]);

      writeSetting(db, 'projectPath', join(home, 'gone'));
      expect(projectFilesNotice(db)).toBeNull();
      writeSetting(db, 'projectPath', at);
      expect(projectFilesNotice(db)?.updates).toEqual(['.agents/skills/nolzu-refine/SKILL.md']);

      await applySetup(db);
      expect(projectFilesNotice(db)?.updates).toEqual([]);
    });
  });

  describe('the files changed by hand', () => {
    const PLAN = '.claude/skills/nolzu-plan/SKILL.md';
    const commitAll = (at: string) => {
      execFileSync('git', ['-C', at, 'add', '-A'], { env: gitEnv() });
      execFileSync('git', ['-C', at, 'commit', '-q', '-m', 'files'], { env: gitEnv() });
    };
    // A written project with one skill file changed by hand and committed, so git holds the person's text.
    const edited = async () => {
      const at = project();
      await applySetup(db);
      writeFileSync(join(at, PLAN), 'My own plan.\n');
      commitAll(at);
      return at;
    };

    it('lists each one with a diff from the shipped text to the person\'s', async () => {
      const at = await edited();

      const [one, ...rest] = await handEditedFiles(db);

      expect(rest).toEqual([]);
      expect(one).toMatchObject({ path: PLAN, gone: false, unsaved: false });
      expect(one?.patch).toContain('+My own plan.');
      expect(one?.patch).toMatch(/^-name: nolzu-plan$/m);
      // From the first hunk on, so the temp folder the shipped text sits in never shows.
      expect(one?.patch).toMatch(/^@@ /);
      writeFileSync(join(at, PLAN), 'Not committed.\n');
      expect((await handEditedFiles(db))[0]?.unsaved).toBe(true);
    });

    it('takes the shipped text with no ask when git holds the person\'s, and the file is Nolzu\'s again', async () => {
      const at = await edited();
      const shipped = readFileSync(join(at, '.agents/skills/nolzu-plan/SKILL.md'), 'utf8');

      expect(await takeShipped(db, PLAN, false)).toEqual({ said: `Wrote Nolzu's text to ${PLAN}. Commit it.` });
      expect(readFileSync(join(at, PLAN), 'utf8')).toBe(shipped);
      expect(projectFilesStatus(at)?.yours).toEqual([]);
    });

    it('asks once more for a file with changes git has not committed, and writes on the answer', async () => {
      const at = await edited();
      writeFileSync(join(at, PLAN), 'A newer edit, not committed.\n');

      expect(await takeShipped(db, PLAN, false)).toEqual({ problem: `git has not committed your changes to ${PLAN}. Taking the new one loses them.`, ask: true });
      expect(readFileSync(join(at, PLAN), 'utf8')).toBe('A newer edit, not committed.\n');

      expect(await takeShipped(db, PLAN, true)).toMatchObject({ said: expect.any(String) });
      expect(readFileSync(join(at, PLAN), 'utf8')).toContain('name: nolzu-plan');
    });

    it('asks for an untracked file too', async () => {
      const at = project();
      await applySetup(db);
      writeFileSync(join(at, PLAN), 'My own plan.\n');

      expect(await takeShipped(db, PLAN, false)).toMatchObject({ ask: true });
      // An ignored file is no safer: git holds none of it.
      writeFileSync(join(at, '.gitignore'), '.claude/\n');
      commitAll(at);
      expect(await takeShipped(db, PLAN, false)).toMatchObject({ ask: true });
    });

    it('keeps the person\'s file off the pending count, also after another write of the project files', async () => {
      const at = await edited();

      expect(keepMine(db, PLAN)).toEqual({ said: `Kept your ${PLAN}. Nolzu asks again when it ships a new text for it.` });
      expect(projectFilesNotice(db)?.yours).toEqual([]);
      await applySetup(db);
      expect(projectFilesStatus(at)?.yours).toEqual([]);
      expect(await handEditedFiles(db)).toEqual([]);
      expect(readFileSync(join(at, PLAN), 'utf8')).toBe('My own plan.\n');
    });

    it('counts a kept file again once a newer Nolzu ships another text for it', async () => {
      const at = await edited();
      keepMine(db, PLAN);
      const skills = join(home, 'newer-skills');
      cpSync(skillsFolder(), skills, { recursive: true });
      writeFileSync(join(skills, 'nolzu-plan/SKILL.md'), `${readFileSync(join(skills, 'nolzu-plan/SKILL.md'), 'utf8')}A newer step.\n`);

      expect(projectFilesStatus(at, skills)?.yours).toEqual([PLAN]);
    });

    it('keeps and takes a project file the planner leaves alone', async () => {
      const at = project();
      await applySetup(db);
      writeFileSync(join(at, '.claude/settings.json'), 'not json\n');
      commitAll(at);
      expect(projectFilesStatus(at)?.yours).toEqual(['.claude/settings.json']);

      keepMine(db, '.claude/settings.json');
      expect(projectFilesStatus(at)?.yours).toEqual([]);
      await applySetup(db);
      expect(projectFilesStatus(at)?.yours).toEqual([]);
    });

    it('writes a fresh project file on Take the new one', async () => {
      const at = project();
      await applySetup(db);
      writeFileSync(join(at, '.claude/settings.json'), 'not json\n');
      commitAll(at);
      // A keep for a text an older Nolzu shipped, which the take clears.
      keepForShipped(join(at, '.agents/skills'), '.claude/settings.json', 'an older mark');

      expect(await takeShipped(db, '.claude/settings.json', false)).toMatchObject({ said: expect.any(String) });
      expect(JSON.parse(readFileSync(join(at, '.claude/settings.json'), 'utf8'))).toHaveProperty('hooks');
      expect(keptMark(join(at, '.agents/skills'), '.claude/settings.json')).toBeNull();
    });

    it('writes and keeps nothing once a newer Nolzu wrote the project', async () => {
      const at = project();
      await applySetup(db);
      writeFileSync(join(at, '.claude/settings.json'), 'not json\n');
      commitAll(at);
      const recordAt = join(at, '.claude/skills/.nolzu-skills.json');
      writeFileSync(recordAt, JSON.stringify({ ...(JSON.parse(readFileSync(recordAt, 'utf8')) as object), version: '999.0.0' }));
      const line = `These project files come from Nolzu 999.0.0, newer than this Nolzu ${NOLZU_VERSION}. Update Nolzu.`;

      expect(await takeShipped(db, '.claude/settings.json', true)).toEqual({ problem: line });
      expect(keepMine(db, '.claude/settings.json')).toEqual({ problem: line });
      expect(readFileSync(join(at, '.claude/settings.json'), 'utf8')).toBe('not json\n');
    });

    it('refuses a path the status does not call the person\'s', async () => {
      const at = await edited();

      expect(await takeShipped(db, 'README.md', true)).toEqual({ problem: 'README.md is not a file you changed, so nothing was written.' });
      expect(keepMine(db, '.agents/skills/nolzu-refine/SKILL.md')).toMatchObject({ problem: expect.any(String) });
      expect(existsSync(join(at, 'README.md'))).toBe(false);
    });
  });

  // A WORKSPACE.md with no Nolzu section is the person's own file, so a write never touches it.
  it('leaves a WORKSPACE.md the person wrote alone', async () => {
    const at = project();
    writeFileSync(join(at, 'WORKSPACE.md'), 'My own notes.\n');

    const report = await applySetup(db);

    expect(report.removed).toEqual([]);
    expect(readFileSync(join(at, 'WORKSPACE.md'), 'utf8')).toBe('My own notes.\n');
  });

  // An older Nolzu's WORKSPACE.md is folded into AGENTS.md: the status lists it, and the write removes it
  // and says so.
  it('removes an older WORKSPACE.md that holds only the Nolzu section, and says so', async () => {
    const at = project();
    await applySetup(db);
    writeFileSync(join(at, 'WORKSPACE.md'), '<!-- nolzu:start -->\n# This project and Nolzu\n<!-- nolzu:end -->\n');
    expect(projectFilesStatus(at)?.updates).toEqual(['WORKSPACE.md']);

    const report = await applySetup(db);

    expect(report.removed).toEqual(['WORKSPACE.md']);
    expect(existsSync(join(at, 'WORKSPACE.md'))).toBe(false);
    expect(setupSaid(report)).toContain('Removed WORKSPACE.md, as AGENTS.md holds its text now.');
  });

  // Each repository of a project with several gets a first knowledge file, in one commit.
  describe('with several repositories', () => {
    const git = (at: string, ...args: string[]) => execFileSync('git', ['-C', at, ...args], { env: gitEnv(), encoding: 'utf8' }).trim();
    const repoAt = (at: string) => {
      mkdirSync(at, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'main', at], { env: gitEnv() });
      git(at, 'commit', '-q', '--allow-empty', '-m', 'first');
      return at;
    };
    const knowledge = (at: string) => join(at, '.nolzu', 'knowledge');
    // A root repository holding an api repository, which ignores it the way a team often does.
    const twoRepos = () => {
      const at = project();
      writeFileSync(join(at, 'go.mod'), 'module recipes\n');
      mkdirSync(join(at, 'bin'));
      writeFileSync(join(at, 'bin', 'console'), '');
      writeFileSync(join(at, '.gitignore'), '/api/\n');
      git(at, 'add', '-A');
      git(at, 'commit', '-q', '-m', 'go');
      const api = repoAt(join(at, 'api'));
      writeFileSync(join(api, 'package.json'), '{}');
      mkdirSync(join(api, 'src'));
      writeSetting(db, 'repos', [
        { path: '.', base: 'main' },
        // Not the root's base, so a file that took the project's one base would show it.
        { path: 'api', base: 'develop' },
      ]);
      return at;
    };

    it('writes one file per repository and commits both in one knowledge commit', async () => {
      const at = twoRepos();

      const report = await applySetup(db, undefined, gitEnv());

      expect(report.knowledge).toEqual({ written: ['repository.md', 'api/repository.md', 'run-recipe.md'], problem: null });
      expect(readFileSync(join(knowledge(at), 'api', 'repository.md'), 'utf8')).toContain('Base branch: `develop`.');
      expect(readFileSync(join(knowledge(at), 'api', 'repository.md'), 'utf8')).not.toMatch(/Stack|Top folders/);
      expect(readFileSync(join(knowledge(at), 'repository.md'), 'utf8')).toContain('Base branch: `main`.');
      // The root has a go.mod and no package.json, so its section holds the Go guesses of the stack table.
      const recipe = readFileSync(join(at, '.nolzu', 'knowledge', 'run-recipe.md'), 'utf8');
      expect(recipe).toContain('## The project folder\n\nRun these in the project folder.\n\n- Install: `go mod download`, a first guess from `go.mod`.');
      expect(recipe).toContain('- Test: `go test ./...`, a first guess from `go.mod`.');
      // A file below the top counts too, as it does for the allowed commands.
      expect(recipe).toContain('- Lint: `bin/console lint:container`, a first guess from `bin/console`.');
      expect(recipe).toContain('## The api repository');
      expect(recipe).toContain('- Install: `npm install`, because `package.json` is at its top and no lockfile names another tool.');
      expect(git(at, 'log', '-1', '--pretty=%s')).toBe('knowledge: repository files');
      expect(git(at, 'show', '--name-only', '--pretty=', 'HEAD').split('\n').sort()).toEqual([
        '.nolzu/knowledge/api/repository.md',
        '.nolzu/knowledge/repository.md',
        '.nolzu/knowledge/run-recipe.md',
      ]);
    });

    it('writes no byte and makes no commit on a second run', async () => {
      const at = twoRepos();
      await applySetup(db, undefined, gitEnv());
      const head = git(at, 'rev-parse', 'HEAD');
      const text = readFileSync(join(knowledge(at), 'api', 'repository.md'), 'utf8');

      const again = await applySetup(db, undefined, gitEnv());

      expect(again.knowledge).toEqual({ written: [], problem: null });
      expect(git(at, 'rev-parse', 'HEAD')).toBe(head);
      expect(readFileSync(join(knowledge(at), 'api', 'repository.md'), 'utf8')).toBe(text);
    });

    it('keeps a file the person changed, and writes only the missing one', async () => {
      const at = twoRepos();
      mkdirSync(join(knowledge(at), 'api'), { recursive: true });
      writeFileSync(join(knowledge(at), 'api', 'repository.md'), 'The api serves the recipe list.\n');

      const report = await applySetup(db, undefined, gitEnv());

      expect(report.knowledge?.written).toEqual(['repository.md', 'run-recipe.md']);
      expect(readFileSync(join(knowledge(at), 'api', 'repository.md'), 'utf8')).toBe('The api serves the recipe list.\n');
      expect(git(at, 'show', '--name-only', '--pretty=', 'HEAD').split('\n')).toEqual(['.nolzu/knowledge/repository.md', '.nolzu/knowledge/run-recipe.md']);
    });

    // A repository file in a folder git ignores could never be committed, so none is written.
    it('writes no repository file when git ignores its folder, and names the line', async () => {
      const at = twoRepos();
      writeFileSync(join(at, '.gitignore'), 'api/\n');
      git(at, 'add', '.gitignore');
      git(at, 'commit', '-q', '-m', 'ignore api');

      const report = await applySetup(db, undefined, gitEnv());

      expect(report.knowledge).toEqual({ written: [], problem: expect.stringContaining('git ignores api/ in the knowledge folder, through the .gitignore line api/') });
      expect(existsSync(join(knowledge(at), 'api'))).toBe(false);
    });

    // A knowledge folder of the older layout moves into the folders of its repositories, once, by code.
    describe('moving the older knowledge layout', () => {
      const note = (paths: string) => `---\ndescription: Read before changing search.\npaths: ${paths}\n---\n\nSearch lower cases both sides.\n`;
      // The root repository and api, with every kind of file the older layout had, committed.
      const oldLayout = () => {
        const at = twoRepos();
        const k = knowledge(at);
        mkdirSync(join(k, 'repositories'), { recursive: true });
        writeFileSync(join(k, 'repositories', 'project-root.md'), 'The recipe site.\n');
        writeFileSync(join(k, 'repositories', 'api.md'), 'The api serves the recipe list.\n');
        writeFileSync(join(k, 'search.md'), note('api/src/search.ts'));
        writeFileSync(join(k, 'lists.md'), note('api/src/list.ts, go.mod'));
        writeFileSync(join(k, 'build.md'), note('go.mod'));
        writeFileSync(join(k, 'words.md'), '# Words\n\nRecipe, not dish.\n');
        git(at, 'add', '-A');
        git(at, 'commit', '-q', '-m', 'old knowledge');
        return at;
      };
      const files = (at: string) => git(at, 'ls-files', '.nolzu/knowledge').split('\n');

      it('moves the repository files and each note to the folder its paths name, in one commit', async () => {
        const at = oldLayout();
        expect(knowledgeMovesPending(db)).toEqual({ moves: 4, kept: 0 });

        const report = await applySetup(db, undefined, gitEnv());

        expect(report.knowledgeMove).toEqual({
          said: 'Moved 4 knowledge files into the folders of their repositories and committed the move. words.md stays at the top of the knowledge folder, because its paths name no repository. Move it by hand.',
          refused: null,
        });
        expect(setupSaid(report)).toContain('Moved 4 knowledge files into the folders of their repositories and committed the move.');
        expect(readFileSync(join(knowledge(at), 'api', 'repository.md'), 'utf8')).toBe('The api serves the recipe list.\n');
        expect(readFileSync(join(knowledge(at), 'repository.md'), 'utf8')).toBe('The recipe site.\n');
        expect(existsSync(join(knowledge(at), 'repositories'))).toBe(false);
        // git sees each one as a rename, in one commit with a plain message.
        const move = git(at, 'log', '--format=%s', '--grep=group the files').split('\n');
        expect(move).toEqual(['knowledge: group the files by repository']);
        const renames = git(at, 'show', '-M', '--name-status', '--pretty=', 'HEAD~1').split('\n').map((line) => line.replace(/^R\d+/, 'R'));
        expect(renames.sort()).toEqual(
          [
            'R\t.nolzu/knowledge/lists.md\t.nolzu/knowledge/shared/lists.md',
            'R\t.nolzu/knowledge/repositories/api.md\t.nolzu/knowledge/api/repository.md',
            'R\t.nolzu/knowledge/repositories/project-root.md\t.nolzu/knowledge/repository.md',
            'R\t.nolzu/knowledge/search.md\t.nolzu/knowledge/api/search.md',
          ].sort(),
        );
        // The repository files are there now, so only the run recipe is new.
        expect(report.knowledge?.written).toEqual(['run-recipe.md']);
        expect(files(at)).toEqual(expect.arrayContaining(['.nolzu/knowledge/build.md', '.nolzu/knowledge/words.md', '.nolzu/knowledge/api/search.md', '.nolzu/knowledge/shared/lists.md']));
        expect(git(at, 'status', '--porcelain', '--', '.nolzu/knowledge')).toBe('');
        expect(knowledgeMovesPending(db)).toEqual({ moves: 0, kept: 0 });

        // A second write has nothing to move and says nothing about it.
        expect((await applySetup(db, undefined, gitEnv())).knowledgeMove).toEqual({ said: null, refused: null });
      });

      it('never overwrites a file at the new place, and says which stays', async () => {
        const at = oldLayout();
        mkdirSync(join(knowledge(at), 'api'));
        writeFileSync(join(knowledge(at), 'api', 'repository.md'), 'Written by hand.\n');
        git(at, 'add', '-A');
        git(at, 'commit', '-q', '-m', 'new file');

        const report = await applySetup(db, undefined, gitEnv());

        expect(report.knowledgeMove?.said).toContain('repositories/api.md stays where it is, because a file is at its new place already. Merge it by hand.');
        expect(readFileSync(join(knowledge(at), 'api', 'repository.md'), 'utf8')).toBe('Written by hand.\n');
        expect(readFileSync(join(knowledge(at), 'repositories', 'api.md'), 'utf8')).toBe('The api serves the recipe list.\n');
        expect(existsSync(join(knowledge(at), 'api', 'search.md'))).toBe(true);
        // The file that stayed is still counted for the notice, and named on the next write too.
        expect(knowledgeMovesPending(db)).toEqual({ moves: 0, kept: 1 });
        expect((await applySetup(db, undefined, gitEnv())).knowledgeMove?.said).toBe('repositories/api.md stays where it is, because a file is at its new place already. Merge it by hand.');
      });

      // The folder as git and the disk hold it, to compare before and after a move that went back.
      const snapshot = (at: string) => ({ files: readdirSync(knowledge(at), { recursive: true }).map(String).sort(), status: git(at, 'status', '--porcelain', '--', '.nolzu/knowledge'), head: git(at, 'rev-parse', 'HEAD') });

      it('puts every file back when git cannot commit the move', async () => {
        const at = oldLayout();
        const before = snapshot(at);
        // A lock git leaves while it writes the index, so the add fails.
        writeFileSync(join(at, '.git', 'index.lock'), '');
        const report = await applySetup(db, undefined, gitEnv());
        rmSync(join(at, '.git', 'index.lock'));

        expect(report.knowledgeMove?.refused).toMatch(/^Nolzu moved no knowledge file into the folders of their repositories\. git could not commit the move, so every file went back\./);
        expect(snapshot(at)).toEqual(before);
        expect(knowledgeMovesPending(db)).toEqual({ moves: 4, kept: 0 });
      });

      it('puts every file back when one cannot be moved', async () => {
        const at = oldLayout();
        // The api folder takes no file, so the second move fails after the first went through.
        mkdirSync(join(knowledge(at), 'api'));
        chmodSync(join(knowledge(at), 'api'), 0o500);
        const before = snapshot(at);
        try {
          const report = await applySetup(db, undefined, gitEnv());
          expect(report.knowledgeMove?.refused).toMatch(/A file could not be moved, so every file went back\./);
          expect(snapshot(at)).toEqual(before);
        } finally {
          chmodSync(join(knowledge(at), 'api'), 0o700);
        }
      });

      // A plain folder holds no repository to commit in, so the files move with no commit and the sentence says so.
      it('moves with no commit in a knowledge folder that is in no git repository', async () => {
        const at = join(home, 'shop');
        repoAt(join(at, 'api'));
        repoAt(join(at, 'web'));
        writeSetting(db, 'projectPath', at);
        writeSetting(db, 'repos', [
          { path: 'api', base: 'main' },
          { path: 'web', base: 'main' },
        ]);
        mkdirSync(join(knowledge(at), 'repositories'), { recursive: true });
        writeFileSync(join(knowledge(at), 'repositories', 'api.md'), 'The api.\n');
        writeFileSync(join(knowledge(at), 'search.md'), note('api/src/search.ts'));

        const report = await applySetup(db, undefined, gitEnv());

        expect(report.knowledgeMove).toEqual({ said: 'Moved 2 knowledge files into the folders of their repositories. The knowledge folder is in no git repository, so nothing was committed.', refused: null });
        expect(readFileSync(join(knowledge(at), 'api', 'repository.md'), 'utf8')).toBe('The api.\n');
        expect(existsSync(join(knowledge(at), 'api', 'search.md'))).toBe(true);
      });

      it('refuses a move through a link, and moves nothing', async () => {
        const at = oldLayout();
        const outside = join(home, 'elsewhere');
        mkdirSync(outside);
        symlinkSync(outside, join(knowledge(at), 'shared'));
        git(at, 'add', '-A');
        git(at, 'commit', '-q', '-m', 'linked shared folder');
        const before = snapshot(at);

        const report = await applySetup(db, undefined, gitEnv());

        expect(report.knowledgeMove?.refused).toContain('lists.md or its new place shared/lists.md is a link, or a folder on the way is.');
        expect(snapshot(at)).toEqual(before);
        expect(readdirSync(outside)).toEqual([]);
      });

      // Each refusal moves nothing and writes no repository file, which would block the move later.
      const refusedWith = async (at: string, why: RegExp) => {
        const head = git(at, 'rev-parse', 'HEAD');
        const report = await applySetup(db, undefined, gitEnv());
        expect(report.knowledgeMove?.refused).toMatch(why);
        expect(setupSaid(report)).toContain(report.knowledgeMove?.refused);
        expect(report.knowledge).toBeNull();
        expect(existsSync(join(knowledge(at), 'repositories', 'api.md'))).toBe(true);
        expect(existsSync(join(knowledge(at), 'search.md'))).toBe(true);
        expect(existsSync(join(knowledge(at), 'api'))).toBe(false);
        expect(git(at, 'rev-parse', 'HEAD')).toBe(head);
      };

      it('refuses while the knowledge folder has changes git has not committed', async () => {
        const at = oldLayout();
        writeFileSync(join(knowledge(at), 'words.md'), '# Words\n\nChanged.\n');
        await refusedWith(at, /^Nolzu moved no knowledge file into the folders of their repositories\. The knowledge folder has changes git has not committed\. Commit or drop them\. Then write the project files again\.$/);
      });

      // A .gitignore line with no leading slash matches the repository's folder in the knowledge folder too.
      it('refuses when git would ignore a new place, and says which line to change', async () => {
        const at = oldLayout();
        writeFileSync(join(at, '.gitignore'), 'api/\n');
        git(at, 'add', '.gitignore');
        git(at, 'commit', '-q', '-m', 'ignore api');
        await refusedWith(at, /git ignores api\/ in the knowledge folder, through the \.gitignore line api\/, so nothing written there can be committed\. Start each with a slash, such as \/api\//);
      });

      // With the whole .nolzu folder ignored, the sentence names that, not one repository folder.
      it('names the ignored knowledge folder first', async () => {
        const at = oldLayout();
        writeFileSync(join(at, '.gitignore'), '.nolzu/\napi/\n');
        git(at, 'add', '.gitignore');
        git(at, 'commit', '-q', '-m', 'ignore all');
        await refusedWith(at, /git ignores .*\.nolzu\/knowledge, so nothing written there can be committed\. Take it out of \.gitignore/);
      });

      it('refuses while a knowledge change waits for review', async () => {
        const at = oldLayout();
        const runId = startRun(db, { cardKey: 'APP-1', phase: 'wrapup', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
        recordKnowledgeChanges(db, { cardKey: 'APP-1', runId, commitSha: null, status: 'pending', files: [{ path: '.nolzu/knowledge/words.md', summary: 'x' }] });
        db.prepare("UPDATE runs SET state = 'complete' WHERE id = ?").run(runId);
        await refusedWith(at, /A knowledge change waits for review\./);
      });

      it('refuses while a knowledge run is queued or running', async () => {
        const at = oldLayout();
        startRun(db, { cardKey: 'kb-maintenance', phase: 'optimize', engine: 'fake', model: null, effort: null, sessionId: null, logPath: '', lane: 'knowledge' });
        await refusedWith(at, /A knowledge run is queued or running\./);
      });
    });

    // The default folder of a plain folder sits in no repository, so nothing can be committed there,
    // but every run's knowledge index still reads the files.
    it('writes the files with no commit for a root that is no repository, and says so', async () => {
      const at = join(home, 'shop');
      repoAt(join(at, 'web'));
      repoAt(join(at, 'api'));
      writeSetting(db, 'projectPath', at);
      writeSetting(db, 'repos', [
        { path: 'api', base: 'main' },
        { path: 'web', base: 'main' },
      ]);

      const report = await applySetup(db, undefined, gitEnv());

      expect(report.failed).toBeNull();
      expect(report.knowledge).toEqual({ written: ['api/repository.md', 'web/repository.md', 'run-recipe.md'], problem: expect.stringMatching(/is in no git repository, so Nolzu wrote the knowledge files without a commit/) });
      expect(readFileSync(join(at, '.nolzu', 'knowledge', 'run-recipe.md'), 'utf8')).toMatch(/## The api repository[\s\S]*## The web repository/);
    });

    // A linked repository folder often points into another project, so nothing is written through it.
    it('writes nothing through a linked repository folder, and says so', async () => {
      const at = twoRepos();
      const outside = join(home, 'elsewhere');
      mkdirSync(outside);
      mkdirSync(join(at, '.nolzu', 'knowledge'), { recursive: true });
      symlinkSync(outside, join(knowledge(at), 'api'));
      const head = git(at, 'rev-parse', 'HEAD');

      const report = await applySetup(db, undefined, gitEnv());

      // The other files sit beside the link, not through it, so they are written and committed.
      expect(report.knowledge).toEqual({ written: ['repository.md', 'run-recipe.md'], problem: expect.stringMatching(/did not write api\/repository\.md .* is a link/) });
      expect(readdirSync(outside)).toEqual([]);
      expect(git(at, 'show', '--name-only', '--pretty=', 'HEAD').split('\n')).toEqual(['.nolzu/knowledge/repository.md', '.nolzu/knowledge/run-recipe.md']);
      expect(git(at, 'rev-parse', 'HEAD~1')).toBe(head);
    });
  });

  // One repository gets its file and the run recipe too, from its own package.json.
  it('writes the repository file and the run recipe for a project with one repository', async () => {
    const at = project();
    writeFileSync(join(at, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', dev: 'vite' } }));
    writeFileSync(join(at, 'pnpm-lock.yaml'), '');

    const report = await applySetup(db, undefined, gitEnv());

    expect(report.knowledge).toEqual({ written: ['repository.md', 'run-recipe.md'], problem: null });
    const recipe = readFileSync(join(at, '.nolzu', 'knowledge', 'run-recipe.md'), 'utf8');
    expect(recipe).toContain('- Test: `pnpm test`, the `test` script in `package.json`.');
    expect(recipe).toContain('- Start: `pnpm run dev`, the `dev` script in `package.json`.');
    expect(recipe).toContain('- Lint: Not read.');
    expect(execFileSync('git', ['-C', at, 'show', '--name-only', '--pretty=', 'HEAD'], { encoding: 'utf8' }).trim().split('\n')).toEqual(['.nolzu/knowledge/repository.md', '.nolzu/knowledge/run-recipe.md']);
  });

  it('says the folder is gone when it was deleted after the project was set', async () => {
    const at = project();
    rmSync(at, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

    expect((await applySetup(db)).failed?.message).toMatch(/not there any more/);
  });

  it('says so when there is no project to write into, and writes nothing', async () => {
    const report = await applySetup(db);

    expect(report.failed?.message).toMatch(/no project/i);
    expect(report.written).toEqual([]);
    // Null, so the page never reads a sync that did not run as "already up to date".
    expect(report.skills).toBeNull();
  });

});

// Every path in this block comes from `home`, a folder made with mkdtempSync and removed after each
// test, so nothing here is written outside it. The one exception is the database, which the file's
// own beforeEach puts in a second temp folder.
describe('making a workspace', () => {
  let home = '';
  const env = () => ({ ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' });
  const at = (name: string) => join(home, name);
  const make = (name = 'recipes', parent = home) => createWorkspace(db, { parent, name, home, env: env() });
  const inGit = (folder: string, ...args: string[]) => execFileSync('git', ['-C', folder, ...args], { env: env(), encoding: 'utf8' }).trim();
  const cards = () => db.prepare('SELECT key, board, stage, title, summary FROM cards').all() as { key: string; board: string; stage: string; title: string; summary: string | null }[];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nolzu-idea-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  it('makes <parent>/<name> a repository with one commit, its .gitignore, the guard and an empty list', async () => {
    const folder = at('recipes');

    const made = await make();

    expect(made).toMatchObject({ ok: true, path: folder });
    expect(inGit(folder, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(inGit(folder, 'branch', '--show-current')).toBe('main');
    expect(readFileSync(join(folder, '.gitignore'), 'utf8')).toBe('/worktrees/\n/.tasks/\n');
    // In the commit, not only on disk.
    const tracked = inGit(folder, 'ls-files').split('\n');
    expect(tracked).toEqual(expect.arrayContaining(['.gitignore', 'AGENTS.md', 'CLAUDE.md', '.claude/hooks/nolzu-phase-guard.mjs', '.claude/settings.json']));
    expect(inGit(folder, 'status', '--porcelain')).toBe('');
    // git tracks no empty folder, so these two are asserted on disk, and the .gitignore keeps them out.
    expect(statSync(join(folder, '.tasks')).isDirectory()).toBe(true);
    expect(statSync(join(folder, 'worktrees')).isDirectory()).toBe(true);
    expect(getSetting(db, 'projectPath')).toBe(folder);
    expect(getSetting(db, 'workspace')).toBe(true);
    expect(getSetting(db, 'repos')).toEqual([]);
    expect(getSetting(db, 'baseBranch')).toBe('main');
  });

  // The other tests make the workspace in the home folder, so a path built from home would pass them.
  it('makes the workspace in the parent typed, not in the home folder', async () => {
    mkdirSync(at('work'));

    const made = await make('recipes', at('work'));

    expect(made).toMatchObject({ ok: true, path: join(at('work'), 'recipes') });
    expect(getSetting(db, 'projectPath')).toBe(join(at('work'), 'recipes'));
    expect(readdirSync(home)).toEqual(['work']);
  });

  it('leaves a knowledge folder that passes the knowledge check', async () => {
    await make();
    const folder = resolveKnowledgeDir({ knowledgeDir: getSetting(db, 'knowledgeDir'), projectPath: at('recipes') }) ?? '';
    const run: RunGit = (args) => runGit(args, { cwd: folder, env: gitEnv(env() as Record<string, string>) });

    expect(await checkKnowledgeDir(folder, { projectPath: at('recipes'), run })).toMatchObject({ ok: true });
  });

  // A list saved for a folder of repositories earlier would make the new workspace read repositories it has not got.
  it('replaces a repository list saved before with an empty one, and writes no repository file', async () => {
    for (const name of ['shop/web', 'shop/api']) {
      mkdirSync(at(name), { recursive: true });
      inGit(home, 'init', '-q', '-b', 'main', at(name));
      inGit(at(name), 'commit', '-q', '--allow-empty', '-m', 'first');
    }
    await saveProject(db, { path: at('shop'), template: '{key}-{slug}', home, env: env() });
    expect(getSetting(db, 'repos')).toHaveLength(2);

    const made = await make('fresh');

    expect(made.ok).toBe(true);
    expect(getSetting(db, 'repos')).toEqual([]);
    expect(existsSync(join(at('fresh'), '.nolzu', 'knowledge', 'repository.md'))).toBe(false);
    expect(inGit(at('fresh'), 'rev-list', '--count', 'HEAD')).toBe('1');
  });

  it('writes what the project files say, not only their names', async () => {
    const folder = at('recipes');

    await make();

    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toContain("`.tasks/<card key>/` holds what a card's runs wrote");
    expect(readFileSync(join(folder, 'AGENTS.md'), 'utf8')).toContain('Commit nothing. A person reads the diff and commits.');
    expect(readFileSync(join(folder, 'CLAUDE.md'), 'utf8')).toContain('Read AGENTS.md');
    expect(existsSync(join(folder, 'WORKSPACE.md'))).toBe(false);
  });

  // Nolzu never writes into a folder it did not make, an empty one included.
  it('refuses a name that is taken, and writes nothing into it', async () => {
    const folder = at('recipes');
    mkdirSync(folder);
    writeFileSync(join(folder, '.DS_Store'), '');

    const made = await make();

    expect(made).toEqual({ ok: false, reason: `${folder} is there already. Pick another name, or another folder to put it in.` });
    expect(readdirSync(folder)).toEqual(['.DS_Store']);
    expect(cards()).toEqual([]);
    expect(getSetting(db, 'projectPath')).toBeNull();
  });

  it('refuses a name taken by a file, and leaves the file alone', async () => {
    const file = at('recipes');
    writeFileSync(file, 'Mine.\n');

    expect(await make()).toEqual({ ok: false, reason: `${file} is there already. Pick another name, or another folder to put it in.` });
    expect(readFileSync(file, 'utf8')).toBe('Mine.\n');
  });

  it('refuses a parent folder that is not there, and makes nothing', async () => {
    const made = await make('recipes', at('work'));

    expect(made).toEqual({ ok: false, reason: `The folder ${at('work')} is not there. Make it first, or type a folder that is.` });
    expect(existsSync(at('work'))).toBe(false);
  });

  it('refuses a name the folder rules refuse, each with a sentence', async () => {
    for (const name of ['shop/web', '-x', 'worktrees', '.nolzu', '..']) {
      const made = await make(name);
      expect(made.ok ? '' : made.reason).toBe(`The name ${JSON.stringify(name)} cannot name a folder. Use one folder name with no slash that does not start with "-" and is not worktrees, .tasks or .nolzu.`);
    }
    expect(await make('  ')).toEqual({ ok: false, reason: 'Type a name for the workspace. It becomes the name of its folder.' });
    expect(await make('recipes', '')).toEqual({ ok: false, reason: 'Type the folder the workspace goes in.' });
    expect(readdirSync(home)).toEqual([]);
  });

  // New project and the idea page type the project's own folder, made when it is not there.
  describe('in the folder typed', () => {
    const inFolder = (folder: string, extra: { env?: Record<string, string | undefined> } = {}) => createWorkspace(db, { folder, home, env: env(), ...extra });

    it('makes a folder that is not there, with the folders above it', async () => {
      const made = await inFolder('~/nolzu/daily-habits');

      expect(made).toMatchObject({ ok: true, path: join(home, 'nolzu', 'daily-habits') });
      expect(getSetting(db, 'projectPath')).toBe(join(home, 'nolzu', 'daily-habits'));
      expect(inGit(join(home, 'nolzu', 'daily-habits'), 'rev-list', '--count', 'HEAD')).toBe('1');
      expect(readdirSync(home)).toEqual(['nolzu']);
    });

    it('uses an empty folder that is there', async () => {
      mkdirSync(at('recipes'));

      expect(await inFolder(at('recipes'))).toMatchObject({ ok: true, path: at('recipes') });
      expect(existsSync(join(at('recipes'), '.git'))).toBe(true);
    });

    it('refuses a folder with anything in it, and writes nothing into it', async () => {
      mkdirSync(at('recipes'));
      writeFileSync(join(at('recipes'), '.DS_Store'), '');

      expect(await inFolder('~/recipes')).toEqual({ ok: false, reason: `${at('recipes')} has files in it already. Type a new folder, or an empty one.` });
      expect(readdirSync(at('recipes'))).toEqual(['.DS_Store']);
      expect(getSetting(db, 'projectPath')).toBeNull();
    });

    it('refuses a path that is a file, or has a file above it, and makes nothing', async () => {
      writeFileSync(at('notes'), 'Mine.\n');

      expect(await inFolder('~/notes')).toEqual({ ok: false, reason: `${at('notes')} is a file, not a folder. Type another folder for the project.` });
      expect(await inFolder('~/notes/recipes')).toEqual({ ok: false, reason: `${at('notes')} is a file, not a folder. Type another folder for the project.` });
      expect(readFileSync(at('notes'), 'utf8')).toBe('Mine.\n');
      expect(readdirSync(home)).toEqual(['notes']);
    });

    it('refuses an empty field and a last folder name the folder rules refuse', async () => {
      expect(await inFolder('  ')).toEqual({ ok: false, reason: 'Type the project folder. Nolzu makes it if it is not there.' });
      for (const name of ['-x', 'worktrees', '.nolzu']) {
        expect(await inFolder(`~/code/${name}`)).toEqual({ ok: false, reason: `The folder name ${JSON.stringify(name)} cannot be used. Use a name that does not start with "-" and is not worktrees, .tasks or .nolzu.` });
      }
      expect(readdirSync(home)).toEqual([]);
    });

    it('asks git for a name before it makes any folder', async () => {
      const made = await inFolder('~/nolzu/daily-habits', { env: { ...env(), GIT_AUTHOR_NAME: '' } });

      expect(made.ok).toBe(false);
      expect(readdirSync(home)).toEqual([]);
    });

    // git refuses to make a repository through a link, so the folder it points to is used and stored.
    it('uses the empty folder a typed link points to, and stores that folder', async () => {
      mkdirSync(at('volume'));
      symlinkSync(at('volume'), at('recipes'));

      const made = await inFolder('~/recipes');

      expect(made).toMatchObject({ ok: true, path: realpathSync.native(at('volume')) });
      expect(getSetting(db, 'projectPath')).toBe(realpathSync.native(at('volume')));
      expect(existsSync(join(at('volume'), '.git'))).toBe(true);
      expect(lstatSync(at('recipes')).isSymbolicLink()).toBe(true);
    });

    it('stores the folder typed with a trailing slash without it', async () => {
      expect(await inFolder('~/nolzu/recipes/')).toMatchObject({ ok: true, path: join(home, 'nolzu', 'recipes') });
      expect(getSetting(db, 'projectPath')).toBe(join(home, 'nolzu', 'recipes'));
    });

    // git var passes and git init fails on a hash it does not know, as a refused init does.
    it('takes back the folders it made when git cannot start the repository, and keeps an empty one that was there', async () => {
      const broken = { env: { ...env(), GIT_DEFAULT_HASH: 'none' } };

      expect(await inFolder('~/nolzu/daily-habits', broken)).toMatchObject({ ok: false });
      expect(readdirSync(home)).toEqual([]);

      mkdirSync(at('recipes'));
      expect(await inFolder('~/recipes', broken)).toMatchObject({ ok: false });
      expect(readdirSync(home)).toEqual(['recipes']);
      expect(getSetting(db, 'projectPath')).toBeNull();
    });

    // The second folder has a name the file system refuses, so its mkdir fails after the first was made.
    it('takes back the folders already made when a later one cannot be made', async () => {
      const refused = await inFolder(`~/outer/${'x'.repeat(300)}`);

      expect(refused).toMatchObject({ ok: false });
      expect(readdirSync(home)).toEqual([]);
      expect(getSetting(db, 'projectPath')).toBeNull();
    });

    it('takes back only the folders it made, the deepest first, and stops at one with something in it', () => {
      mkdirSync(at('a/b/c'), { recursive: true });
      removeMade([at('a/b'), at('a/b/c')]);
      expect(readdirSync(home)).toEqual(['a']);
      expect(readdirSync(at('a'))).toEqual([]);

      mkdirSync(at('x/y/z'), { recursive: true });
      writeFileSync(at('x/y/kept'), '');
      removeMade([at('x'), at('x/y'), at('x/y/z')]);
      expect(readdirSync(at('x/y'))).toEqual(['kept']);
    });
  });

  // A machine with no git: Linux with none installed, or a Mac with only Apple's stand-in.
  it('stops before writing when git does not run, and says how to get it', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'nolzu-no-git-'));
    const made = await createWorkspace(db, { parent: home, name: 'recipes', home, env: { ...env(), PATH: empty } });
    rmSync(empty, { recursive: true, force: true });

    expect(made.ok ? '' : made.reason).toMatch(/^git does not run on this machine, so nothing was written\. Install /);
    expect(readdirSync(home)).toEqual([]);
  });

  // The half-failure that really happens: git refuses the commit at the very end. It is asked first,
  // so the run stops before the folder is made.
  it('stops before writing when git has no name to commit with', async () => {
    const made = await createWorkspace(db, { parent: home, name: 'recipes', home, env: { ...env(), GIT_AUTHOR_NAME: '' } });

    expect(made.ok).toBe(false);
    expect(made.ok ? '' : made.reason).toMatch(/git has no name and email to commit with.*empty ident name/s);
    expect(readdirSync(home)).toEqual([]);
    expect(cards()).toEqual([]);
    expect(getSetting(db, 'projectPath')).toBeNull();
  });
});
