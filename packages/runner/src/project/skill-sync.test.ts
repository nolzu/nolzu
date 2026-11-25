import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXTRA_SKILLS, keepForShipped, keptMark, personsSkillEdit, personsSkillText, shippedMark, SKILL_FOLDERS, syncSkillFolders, syncSkills, takeShippedSkill } from './skill-sync.ts';

let source = '';
let project = '';
let target = '';

beforeEach(() => {
  source = mkdtempSync(join(tmpdir(), 'nolzu-skills-source-'));
  project = mkdtempSync(join(tmpdir(), 'nolzu-skills-project-'));
  target = join(project, '.claude', 'skills');
});

afterEach(() => {
  rmSync(source, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const put = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const read = (path: string) => readFileSync(join(target, path), 'utf8');

// Every file under a folder, as paths relative to it, so a test can see all that was written.
function tree(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const at = join(dir, entry);
      if (statSync(at).isDirectory()) walk(at);
      else found.push(relative(root, at));
    }
  };
  walk(root);
  return found.sort();
}

const REFINE = '---\nname: nolzu-refine\ndescription: Refine a card.\n---\n\n# Refine\n';

beforeEach(() => {
  put(source, 'nolzu-refine/SKILL.md', REFINE);
  put(source, 'nolzu-refine/finish.md', 'The finish rules.\n');
  put(source, 'nolzu-plan/SKILL.md', '---\nname: nolzu-plan\ndescription: Plan a card.\n---\n');
  put(source, 'nolzu-plan/reference/steps.md', 'A nested reference file.\n');
});

it('copies every skill folder with all its files, nested ones included', () => {
  const result = syncSkills(source, target);

  expect(read('nolzu-refine/SKILL.md')).toBe(REFINE);
  expect(read('nolzu-plan/reference/steps.md')).toBe('A nested reference file.\n');
  expect(result.copied).toEqual(['nolzu-plan/SKILL.md', 'nolzu-plan/reference/steps.md', 'nolzu-refine/SKILL.md', 'nolzu-refine/finish.md']);
  expect(result.conflicts).toEqual([]);
});

it('copies nothing and reports no change on a second sync', () => {
  syncSkills(source, target);

  const again = syncSkills(source, target);

  expect(again.copied).toEqual([]);
  expect(again.removed).toEqual([]);
  expect(again.conflicts).toEqual([]);
});

// An upgrade brings a new text of the skill, and the copy nobody touched follows it.
it('replaces a file the person did not change when the package has a newer one', () => {
  syncSkills(source, target);
  // A sync that found nothing to do in between, which must still remember what it wrote.
  syncSkills(source, target);
  put(source, 'nolzu-refine/SKILL.md', `${REFINE}\nA new rule.\n`);

  const result = syncSkills(source, target);

  expect(read('nolzu-refine/SKILL.md')).toBe(`${REFINE}\nA new rule.\n`);
  expect(result.copied).toEqual(['nolzu-refine/SKILL.md']);
});

// Work the person put into a skill is theirs. It is kept and named, never written over.
it('keeps a file the person changed, and reports it as a conflict', () => {
  syncSkills(source, target);
  put(target, 'nolzu-refine/SKILL.md', `${REFINE}\nMy own rule.\n`);
  put(source, 'nolzu-refine/SKILL.md', `${REFINE}\nA new rule.\n`);

  const result = syncSkills(source, target);

  expect(read('nolzu-refine/SKILL.md')).toBe(`${REFINE}\nMy own rule.\n`);
  expect(result.conflicts).toEqual(['nolzu-refine/SKILL.md']);
  expect(result.copied).toEqual([]);
});

// A file that is already there before the first sync was never written by Nolzu, so it is the person's.
it('keeps a file that was there before Nolzu ever wrote it', () => {
  put(target, 'nolzu-refine/SKILL.md', 'Written by hand.\n');

  const result = syncSkills(source, target);

  expect(read('nolzu-refine/SKILL.md')).toBe('Written by hand.\n');
  expect(result.conflicts).toEqual(['nolzu-refine/SKILL.md']);
});

it('removes a skill the package dropped, while nobody changed it', () => {
  syncSkills(source, target);
  rmSync(join(source, 'nolzu-plan'), { recursive: true });

  const result = syncSkills(source, target);

  expect(result.removed).toEqual(['nolzu-plan/SKILL.md', 'nolzu-plan/reference/steps.md']);
  expect(tree(target).filter((path) => path.startsWith('nolzu-plan'))).toEqual([]);
  // An empty folder left behind still reads as a skill folder to the engine and to the lint.
  expect(existsSync(join(target, 'nolzu-plan'))).toBe(false);
});

it('keeps a dropped skill file the person changed, and reports it', () => {
  syncSkills(source, target);
  put(target, 'nolzu-plan/SKILL.md', 'Changed by hand.\n');
  rmSync(join(source, 'nolzu-plan'), { recursive: true });

  const result = syncSkills(source, target);

  expect(read('nolzu-plan/SKILL.md')).toBe('Changed by hand.\n');
  expect(result.conflicts).toEqual(['nolzu-plan/SKILL.md']);
  expect(result.removed).toEqual(['nolzu-plan/reference/steps.md']);
});

// Other skills in the same folder belong to the person, and the sync never reads or writes them.
it('leaves every other skill in the folder alone', () => {
  put(target, 'my-skill/SKILL.md', 'Mine.\n');

  syncSkills(source, target);
  rmSync(join(source, 'nolzu-plan'), { recursive: true });
  syncSkills(source, target);

  expect(read('my-skill/SKILL.md')).toBe('Mine.\n');
});

it('writes nothing outside the skills folder', () => {
  put(project, 'README.md', 'The project.\n');
  const before = tree(project).filter((path) => !path.startsWith('.claude/skills/'));

  syncSkills(source, target);

  expect(tree(project).filter((path) => !path.startsWith('.claude/skills/'))).toEqual(before);
});

// The record is a file in the project, and an edited one must not reach a file outside the folder.
it('removes nothing outside the skills folder, whatever the record says', () => {
  put(project, 'README.md', 'The project.\n');
  syncSkills(source, target);
  const record = join(target, '.nolzu-skills.json');
  const hashes = JSON.parse(readFileSync(record, 'utf8')) as Record<string, string>;
  writeFileSync(record, JSON.stringify({ ...hashes, '../../README.md': createHash('sha256').update('The project.\n').digest('hex') }));

  syncSkills(source, target);

  expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('The project.\n');
});

// A skill folder can be a link to a folder other projects share. Written through, the sync would change
// that folder, and removing a dropped skill would delete files every other project uses.
it('never writes or removes through a symlinked skill folder', () => {
  const shared = mkdtempSync(join(tmpdir(), 'nolzu-shared-'));
  try {
    put(shared, 'SKILL.md', 'Shared.\n');
    mkdirSync(target, { recursive: true });
    symlinkSync(shared, join(target, 'nolzu-plan'));

    const first = syncSkills(source, target);
    rmSync(join(source, 'nolzu-plan'), { recursive: true });
    const second = syncSkills(source, target);

    expect(tree(shared)).toEqual(['SKILL.md']);
    expect(readFileSync(join(shared, 'SKILL.md'), 'utf8')).toBe('Shared.\n');
    expect(first.conflicts).toEqual(['nolzu-plan/SKILL.md', 'nolzu-plan/reference/steps.md']);
    expect(second.removed).toEqual([]);
  } finally {
    rmSync(shared, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// A link that points nowhere reads as a missing file, and a write would create its target anywhere.
it('reports a dangling symlink as a conflict and creates nothing at its target', () => {
  const away = join(project, 'elsewhere.md');
  mkdirSync(join(target, 'nolzu-refine'), { recursive: true });
  symlinkSync(away, join(target, 'nolzu-refine', 'finish.md'));

  const result = syncSkills(source, target);

  expect(existsSync(away)).toBe(false);
  expect(result.conflicts).toEqual(['nolzu-refine/finish.md']);
});

it.each(['nolzu-plan\\..\\..\\..\\README.md', '/etc/hosts', 'nolzu-plan//x'])('removes nothing for the record key %j', (key) => {
  put(project, 'README.md', 'The project.\n');
  syncSkills(source, target);
  const record = join(target, '.nolzu-skills.json');
  const hashes = JSON.parse(readFileSync(record, 'utf8')) as Record<string, string>;
  writeFileSync(record, JSON.stringify({ ...hashes, [key]: createHash('sha256').update('The project.\n').digest('hex') }));

  expect(() => syncSkills(source, target)).not.toThrow();
  expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('The project.\n');
});

// A folder where a file belongs, or a record key that names a folder, must not stop every later sync.
it('reports a folder where a skill file belongs, and goes on', () => {
  mkdirSync(join(target, 'nolzu-refine', 'finish.md'), { recursive: true });
  syncSkills(source, target);
  const record = join(target, '.nolzu-skills.json');
  writeFileSync(record, JSON.stringify({ ...(JSON.parse(readFileSync(record, 'utf8')) as object), 'my-skill': 'x' }));
  mkdirSync(join(target, 'my-skill'), { recursive: true });

  const result = syncSkills(source, target);

  expect(result.conflicts).toContain('nolzu-refine/finish.md');
  expect(read('nolzu-refine/SKILL.md')).toBe(REFINE);
});

it('removes the empty folder of a dropped skill also when the folder is named with a trailing slash', () => {
  expect(syncSkills(source, `${target}/`).copied).toHaveLength(4);
  rmSync(join(source, 'nolzu-plan'), { recursive: true });

  expect(syncSkills(source, `${target}/`).removed).toEqual(['nolzu-plan/SKILL.md', 'nolzu-plan/reference/steps.md']);

  expect(existsSync(join(target, 'nolzu-plan'))).toBe(false);
});

// On a disk that ignores case, the old and the new name are one file, and removing the old name would
// remove the file the package still has.
it('keeps a file the package renamed only by case', () => {
  syncSkills(source, target);
  rmSync(join(source, 'nolzu-refine', 'finish.md'));
  put(source, 'nolzu-refine/Finish.md', 'The finish rules.\n');

  syncSkills(source, target);

  expect(read('nolzu-refine/Finish.md')).toBe('The finish rules.\n');
});

// Once the person's text is back to what Nolzu wrote, the file is Nolzu's again and takes the upgrade.
it('updates a file again once the person changed it back', () => {
  syncSkills(source, target);
  put(target, 'nolzu-refine/SKILL.md', 'Changed by hand.\n');
  syncSkills(source, target);
  put(target, 'nolzu-refine/SKILL.md', REFINE);
  put(source, 'nolzu-refine/SKILL.md', `${REFINE}\nA new rule.\n`);

  const result = syncSkills(source, target);

  expect(result.copied).toEqual(['nolzu-refine/SKILL.md']);
  expect(read('nolzu-refine/SKILL.md')).toBe(`${REFINE}\nA new rule.\n`);
});

// A Finder file on the machine the package was built on is not part of any skill.
it('copies no hidden file', () => {
  put(source, 'nolzu-plan/.DS_Store', 'finder');

  const result = syncSkills(source, target);

  expect(result.copied).not.toContain('nolzu-plan/.DS_Store');
  expect(existsSync(join(target, 'nolzu-plan', '.DS_Store'))).toBe(false);
});

// A run reads the method from the project's skills folder only where the person changed it. What the
// last sync wrote is an old copy, and what the package ships now is the same text either way.
it('tells the person\'s skill file from one Nolzu wrote', () => {
  put(source, 'nolzu-refine/SKILL.md', 'old method\n');
  syncSkills(source, target);
  const now = (text: string | null) => personsSkillText(target, 'nolzu-refine/SKILL.md', text);

  expect(now('new method\n')).toBeNull();
  expect(now('old method\n')).toBeNull();
  put(target, 'nolzu-refine/SKILL.md', 'my method\n');
  expect(now('new method\n')).toBe('my method\n');
  // A file the person added beside the skill has no record entry, so it is theirs.
  put(target, 'nolzu-refine/style.md', 'short\n');
  expect(personsSkillText(target, 'nolzu-refine/style.md', null)).toBe('short\n');
  expect(personsSkillText(target, 'nolzu-refine/missing.md', 'shipped\n')).toBeNull();
});

it('takes every changed file as the person\'s when there is no record, as a first sync does', () => {
  put(target, 'nolzu-refine/SKILL.md', 'my method\n');

  expect(personsSkillText(target, 'nolzu-refine/SKILL.md', 'shipped\n')).toBe('my method\n');
  expect(personsSkillText(target, 'nolzu-refine/SKILL.md', 'my method\n')).toBeNull();
});

// Each engine reads its own folder, so every one of them gets the same copy with its own record.
it('copies the skills into the two engine folders, each with its own record', () => {
  const synced = syncSkillFolders(source, project);

  expect(synced.map((one) => one.folder)).toEqual(['.agents/skills', '.claude/skills']);
  for (const folder of SKILL_FOLDERS) {
    expect(tree(join(project, folder))).toEqual(['.nolzu-skills.json', 'nolzu-plan/SKILL.md', 'nolzu-plan/reference/steps.md', 'nolzu-refine/SKILL.md', 'nolzu-refine/finish.md']);
  }
  expect(synced.every((one) => one.synced?.copied.length === 4)).toBe(true);
});

it('writes no byte when it runs again', () => {
  syncSkillFolders(source, project);
  const before = tree(project).map((path) => [path, statSync(join(project, path)).mtimeMs, readFileSync(join(project, path), 'utf8')]);

  const again = syncSkillFolders(source, project);

  expect(again.every((one) => one.synced?.copied.length === 0)).toBe(true);
  expect(tree(project).map((path) => [path, statSync(join(project, path)).mtimeMs, readFileSync(join(project, path), 'utf8')])).toEqual(before);
});

it('refuses a linked folder alone and still syncs the other one', () => {
  const outside = mkdtempSync(join(tmpdir(), 'nolzu-skills-outside-'));
  try {
    symlinkSync(outside, join(project, '.agents'));

    const synced = syncSkillFolders(source, project);

    expect(synced.find((one) => one.folder === '.agents/skills')?.synced).toBeNull();
    expect(readdirSync(outside)).toEqual([]);
    expect(synced.filter((one) => one.synced !== null).map((one) => one.folder)).toEqual(['.claude/skills']);
    expect(existsSync(join(project, '.claude', 'skills', 'nolzu-refine', 'SKILL.md'))).toBe(true);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

it('refuses a skills folder that is a file', () => {
  put(project, '.claude/skills', 'not a folder\n');

  expect(syncSkillFolders(source, project).map((one) => one.synced === null)).toEqual([false, true]);
});

describe('the person\'s edit across the folders', () => {
  beforeEach(() => {
    syncSkillFolders(source, project);
  });
  const edit = () => personsSkillEdit(project, 'nolzu-refine/SKILL.md', REFINE);

  it('is none while every copy is what Nolzu wrote', () => {
    expect(edit()).toBeNull();
  });

  it.each(['.claude/skills'])('is read from %s when .agents has none', (folder) => {
    put(join(project, folder), 'nolzu-refine/SKILL.md', 'my method\n');

    expect(edit()).toEqual({ text: 'my method\n', folder });
  });

  it('comes from the first folder in the order .agents, .claude', () => {
    put(join(project, '.claude/skills'), 'nolzu-refine/SKILL.md', 'from claude\n');
    expect(edit()).toEqual({ text: 'from claude\n', folder: '.claude/skills' });

    put(join(project, '.agents/skills'), 'nolzu-refine/SKILL.md', 'from codex\n');
    expect(edit()).toEqual({ text: 'from codex\n', folder: '.agents/skills' });
  });
});

describe('the Nolzu version in the record', () => {
  const recordOf = (folder = target) => JSON.parse(readFileSync(join(folder, '.nolzu-skills.json'), 'utf8')) as Record<string, string>;
  const setRecordVersion = (version: string | undefined) => {
    const files = recordOf();
    delete files.version;
    writeFileSync(join(target, '.nolzu-skills.json'), JSON.stringify(version === undefined ? files : { version, ...files }));
  };

  it('names the Nolzu that wrote it, under a key no skill path can be', () => {
    syncSkills(source, target, { version: '1.2.0' });

    expect(recordOf().version).toBe('1.2.0');
    expect(Object.keys(recordOf()).filter((key) => !key.includes('/'))).toEqual(['version']);
  });

  it('reads a record without the key as an unknown version and writes over it', () => {
    syncSkills(source, target, { version: '1.2.0' });
    setRecordVersion(undefined);
    put(source, 'nolzu-refine/finish.md', 'New finish rules.\n');

    const result = syncSkills(source, target, { version: '1.2.0' });

    expect(result.copied).toEqual(['nolzu-refine/finish.md']);
    expect(result.newer).toBeUndefined();
    expect(recordOf().version).toBe('1.2.0');
  });

  it.each([
    ['1.3.0', '1.2.9'],
    ['2.0.0', '1.10.0'],
    ['1.2.0', '1.2.0-20261028101500-abc1234'],
    ['0.0.0-20261029000000-bbb', '0.0.0-20261028000000-aaa'],
  ])('writes nothing in a folder that Nolzu %s wrote when this is %s', (recorded, installed) => {
    syncSkills(source, target, { version: recorded });
    put(source, 'nolzu-refine/finish.md', 'Older finish rules.\n');
    rmSync(join(target, 'nolzu-plan', 'SKILL.md'));
    const before = tree(target).map((path) => [path, readFileSync(join(target, path), 'utf8')]);

    const result = syncSkills(source, target, { version: installed });

    expect(result).toEqual({ copied: [], removed: [], conflicts: [], kept: [], newer: recorded });
    expect(tree(target).map((path) => [path, readFileSync(join(target, path), 'utf8')])).toEqual(before);
  });

  it.each([['1.2.0', '1.2.0'], ['1.2.0', '1.3.0'], ['not a version', '1.0.0']])('writes a folder that Nolzu %s wrote when this is %s', (recorded, installed) => {
    syncSkills(source, target, { version: recorded });
    put(source, 'nolzu-refine/finish.md', 'New finish rules.\n');

    expect(syncSkills(source, target, { version: installed }).copied).toEqual(['nolzu-refine/finish.md']);
    expect(recordOf().version).toBe(installed);
  });

  it('keeps the version out of the files it removes or reports', () => {
    syncSkills(source, target, { version: '1.0.0' });
    const result = syncSkills(source, target, { version: '1.0.0' });

    expect(result).toEqual({ copied: [], removed: [], conflicts: [], kept: [] });
    expect(personsSkillText(target, 'version', null)).toBeNull();
  });
});

describe('a dry run', () => {
  it('reports what a sync would copy, remove and keep, and writes nothing', () => {
    syncSkills(source, target, { version: '1.0.0' });
    put(source, 'nolzu-refine/finish.md', 'New finish rules.\n');
    put(target, 'nolzu-plan/SKILL.md', 'my plan\n');
    rmSync(join(source, 'nolzu-plan', 'reference'), { recursive: true });
    put(source, 'nolzu-qa/SKILL.md', 'QA.\n');
    const before = tree(target).map((path) => [path, readFileSync(join(target, path), 'utf8')]);

    const dry = syncSkills(source, target, { version: '1.1.0', dryRun: true });

    expect(dry).toEqual({ copied: ['nolzu-qa/SKILL.md', 'nolzu-refine/finish.md'], removed: ['nolzu-plan/reference/steps.md'], conflicts: ['nolzu-plan/SKILL.md'], kept: [] });
    expect(tree(target).map((path) => [path, readFileSync(join(target, path), 'utf8')])).toEqual(before);
    expect(syncSkills(source, target, { version: '1.1.0' })).toEqual(dry);
  });

  it('makes no folder in a project that has none', () => {
    syncSkills(source, target, { dryRun: true });

    expect(existsSync(target)).toBe(false);
  });

  it('reports a newer folder the same way a sync does', () => {
    syncSkills(source, target, { version: '3.0.0' });

    expect(syncSkillFolders(source, project, { version: '1.0.0', dryRun: true }).find((one) => one.folder === '.claude/skills')?.synced?.newer).toBe('3.0.0');
  });
});

describe('Keep mine and Take the new one', () => {
  const recordOf = () => JSON.parse(readFileSync(join(target, '.nolzu-skills.json'), 'utf8')) as Record<string, unknown>;

  it('stops calling a kept file a conflict, also after another sync, until the shipped text changes', () => {
    syncSkills(source, target, { version: '1.0.0' });
    put(target, 'nolzu-refine/SKILL.md', 'my method\n');
    keepForShipped(target, 'nolzu-refine/SKILL.md', shippedMark(REFINE));

    expect(syncSkills(source, target, { version: '1.0.0' })).toMatchObject({ conflicts: [], kept: ['nolzu-refine/SKILL.md'] });
    // The re-sync wrote the record again, and the keep is still in it.
    expect(recordOf().kept).toEqual({ 'nolzu-refine/SKILL.md': shippedMark(REFINE) });
    expect(recordOf().version).toBe('1.0.0');
    expect(read('nolzu-refine/SKILL.md')).toBe('my method\n');
    // A run still reads the person's text.
    expect(personsSkillText(target, 'nolzu-refine/SKILL.md', REFINE)).toBe('my method\n');

    put(source, 'nolzu-refine/SKILL.md', `${REFINE}A newer step.\n`);
    expect(syncSkills(source, target, { version: '1.1.0' })).toMatchObject({ conflicts: ['nolzu-refine/SKILL.md'], kept: [] });
    expect(recordOf().kept).toBeUndefined();
  });

  it('keeps a dropped file the person kept, and forgets a keep once the text is Nolzu\'s again', () => {
    syncSkills(source, target);
    put(target, 'nolzu-plan/reference/steps.md', 'my steps\n');
    keepForShipped(target, 'nolzu-plan/reference/steps.md', shippedMark(null));
    rmSync(join(source, 'nolzu-plan/reference'), { recursive: true });
    expect(syncSkills(source, target)).toMatchObject({ removed: [], conflicts: [], kept: ['nolzu-plan/reference/steps.md'] });

    put(target, 'nolzu-refine/SKILL.md', 'mine\n');
    keepForShipped(target, 'nolzu-refine/SKILL.md', shippedMark(REFINE));
    put(target, 'nolzu-refine/SKILL.md', REFINE);
    syncSkills(source, target);
    expect(recordOf().kept).toEqual({ 'nolzu-plan/reference/steps.md': 'gone' });
  });

  it('carries a project file\'s keep in the record through a sync', () => {
    syncSkills(source, target);
    keepForShipped(target, 'AGENTS.md', 'abc');
    syncSkills(source, target);

    expect(keptMark(target, 'AGENTS.md')).toBe('abc');
    keepForShipped(target, 'AGENTS.md', null);
    expect(keptMark(target, 'AGENTS.md')).toBeNull();
  });

  it('writes the shipped text and records it as Nolzu\'s, so the next sync updates it', () => {
    syncSkills(source, target);
    put(target, 'nolzu-refine/SKILL.md', 'my method\n');
    keepForShipped(target, 'nolzu-refine/SKILL.md', 'an older mark');

    expect(takeShippedSkill(target, 'nolzu-refine/SKILL.md', Buffer.from(REFINE))).toBe(true);
    expect(read('nolzu-refine/SKILL.md')).toBe(REFINE);
    expect(recordOf().kept).toBeUndefined();
    expect(syncSkills(source, target).conflicts).toEqual([]);
  });

  it('removes a file Nolzu no longer ships, with its empty folder', () => {
    syncSkills(source, target);
    put(target, 'nolzu-plan/reference/steps.md', 'my steps\n');

    expect(takeShippedSkill(target, 'nolzu-plan/reference/steps.md', null)).toBe(true);
    expect(existsSync(join(target, 'nolzu-plan/reference'))).toBe(false);
    expect(recordOf()['nolzu-plan/reference/steps.md']).toBeUndefined();
  });

  it('writes nothing through a linked file', () => {
    syncSkills(source, target);
    const outside = join(project, 'outside.md');
    writeFileSync(outside, 'not a skill\n');
    rmSync(join(target, 'nolzu-refine/SKILL.md'));
    symlinkSync(outside, join(target, 'nolzu-refine/SKILL.md'));

    expect(takeShippedSkill(target, 'nolzu-refine/SKILL.md', Buffer.from(REFINE))).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('not a skill\n');
  });
});

// The project's own skills in `.nolzu/skills`, shared through git, go to every engine folder beside
// Nolzu's, under the same record, and one named after a Nolzu skill is refused with a sentence.
describe('the extra skills of the workspace', () => {
  const extra = () => join(project, EXTRA_SKILLS);

  it('copies them into the three folders with the same record, and removes one the folder dropped', () => {
    put(extra(), 'deploy-notes/SKILL.md', '---\nname: deploy-notes\ndescription: How we deploy.\n---\n');
    const synced = syncSkillFolders(source, project);

    for (const folder of SKILL_FOLDERS) {
      expect(readFileSync(join(project, folder, 'deploy-notes', 'SKILL.md'), 'utf8')).toContain('How we deploy.');
      expect(readFileSync(join(project, folder, 'nolzu-refine', 'SKILL.md'), 'utf8')).toBe(REFINE);
    }
    expect(synced[0]?.synced?.copied).toContain('deploy-notes/SKILL.md');
    expect(synced[0]?.synced?.refused).toBeUndefined();

    rmSync(join(extra(), 'deploy-notes'), { recursive: true });
    expect(syncSkillFolders(source, project)[0]?.synced?.removed).toEqual(['deploy-notes/SKILL.md']);
    expect(existsSync(join(project, SKILL_FOLDERS[0], 'deploy-notes'))).toBe(false);
    // Nolzu's own stay.
    expect(existsSync(join(project, SKILL_FOLDERS[0], 'nolzu-plan', 'SKILL.md'))).toBe(true);
  });

  it('keeps a change the person made to a copy, as for a Nolzu skill', () => {
    put(extra(), 'deploy-notes/SKILL.md', 'one\n');
    syncSkillFolders(source, project);
    put(join(project, SKILL_FOLDERS[1]), 'deploy-notes/SKILL.md', 'mine\n');
    put(extra(), 'deploy-notes/SKILL.md', 'two\n');

    const synced = syncSkillFolders(source, project);
    expect(synced[1]?.synced?.conflicts).toEqual(['deploy-notes/SKILL.md']);
    expect(readFileSync(join(project, SKILL_FOLDERS[1], 'deploy-notes', 'SKILL.md'), 'utf8')).toBe('mine\n');
    expect(readFileSync(join(project, SKILL_FOLDERS[0], 'deploy-notes', 'SKILL.md'), 'utf8')).toBe('two\n');
  });

  it('refuses a skill whose SKILL.md names a Nolzu skill, whatever its folder and line ends', () => {
    put(extra(), 'my-refine/SKILL.md', '---\r\nname: nolzu-refine\r\ndescription: Mine.\r\n---\r\n');
    const synced = syncSkillFolders(source, project);
    expect(synced[0]?.synced?.refused?.[0]).toMatch(/^The skill my-refine in /);
    expect(existsSync(join(project, SKILL_FOLDERS[0], 'my-refine'))).toBe(false);
  });

  it('refuses a skill named after one Nolzu ships, whatever its case, and copies none of it', () => {
    put(extra(), 'Nolzu-Refine/SKILL.md', 'not the method\n');
    put(extra(), 'Nolzu-Refine/extra.md', 'x\n');
    const synced = syncSkillFolders(source, project);

    expect(synced[0]?.synced?.refused).toEqual([`The skill Nolzu-Refine in ${EXTRA_SKILLS} has the name of a skill Nolzu ships, in its folder or its SKILL.md, so it was not copied. Rename its folder and its name.`]);
    expect(readFileSync(join(project, SKILL_FOLDERS[0], 'nolzu-refine', 'SKILL.md'), 'utf8')).toBe(REFINE);
    expect(existsSync(join(project, SKILL_FOLDERS[0], 'nolzu-refine', 'extra.md'))).toBe(false);
  });
});
