import { describe, expect, it } from 'vitest';
import * as onboarding from './onboarding.ts';
import { appAddress, needsOnboarding, nextKey, prefixProblem, proposePrefix, proposeStart, scriptPort, START, usesPlaywright, validateProgress } from './onboarding.ts';
import { readSetting } from './settings.ts';

describe('the first run', () => {
  it('starts not done, and keeps no wizard steps', () => {
    expect(START).toEqual({ done: false });
    expect(Object.keys(onboarding)).not.toContain('STEPS');
  });
});

describe('needsOnboarding', () => {
  it('sends a first run with no project to New project', () => {
    expect(needsOnboarding({ projectPath: null, onboarding: START })).toBe(true);
  });

  // The redirect asks only whether there is a project: a first run that ended and then lost its
  // project has nothing to show either.
  it('leaves alone a machine with a project, and sends one with no project yet to New project', () => {
    expect(needsOnboarding({ projectPath: '/work/recipes', onboarding: START })).toBe(false);
    expect(needsOnboarding({ projectPath: '/work/recipes', onboarding: { done: true } })).toBe(false);
    expect(needsOnboarding({ projectPath: null, onboarding: { done: true } })).toBe(true);
  });
});

describe('validateProgress', () => {
  it('takes whether the first run is done, and refuses anything else', () => {
    expect(validateProgress(START)).toBeNull();
    expect(validateProgress({ done: true })).toBeNull();
    expect(validateProgress('welcome')).not.toBeNull();
    expect(validateProgress(null)).not.toBeNull();
    expect(validateProgress({ done: 'yes' })).toMatch(/yes or no/);
  });

  // A machine that ran the old wizard stored its step and the skipped steps beside the flag.
  it('takes a row the old wizard wrote', () => {
    expect(validateProgress({ step: 'summary', skipped: ['stack'], done: true })).toBeNull();
    expect(readSetting('onboarding', JSON.stringify({ step: 'summary', skipped: ['stack'], done: true }))).toEqual({ value: { done: true }, fellBack: false });
  });
});

describe('the ticket key prefix', () => {
  it.each([
    ['recipe-app', 'APP'],
    ['shop', 'SHOP'],
    ['my_big-service2', 'SERV'],
    ['x', 'PROJ'],
    ['', 'PROJ'],
  ])('proposes a prefix from the folder %j', (folder, prefix) => {
    expect(proposePrefix(folder)).toBe(prefix);
  });

  it('reads the key the next card gets, after the numbers already given', () => {
    expect(nextKey('APP', 0)).toBe('APP-1');
    expect(nextKey('APP', 2)).toBe('APP-3');
  });

  it.each(['A', 'ABCDEFG', 'app', 'AP1', ''])('refuses %j with the rule', (prefix) => {
    expect(prefixProblem(prefix, [], null)).toMatch(/two to six/);
  });

  it('refuses a prefix another project already counts with, and names it', () => {
    expect(prefixProblem('WEB', ['WEB'], 'APP')).toMatch(/WEB is in use/);
  });

  it('takes the prefix this project already has, or a new one', () => {
    expect(prefixProblem('APP', ['APP'], 'APP')).toBeNull();
    expect(prefixProblem('SHOP', ['APP'], 'APP')).toBeNull();
  });

  // Research numbers its two kinds as Q-7 and INV-4, so the project's prefix may be neither, or a new
  // investigation and a Delivery card would count under one prefix.
  it('refuses the prefix a Research kind counts with, and names the kind', () => {
    expect(prefixProblem('INV', [], 'APP')).toBe('INV is the key prefix of Investigations on Research. Pick another prefix.');
    expect(prefixProblem('INV', [], 'INV')).toBe('INV is the key prefix of Investigations on Research. Pick another prefix.');
  });

  it('proposes no prefix a Research kind counts with', () => {
    expect(proposePrefix('inv')).toBe('PROJ');
  });
});

describe('proposeStart', () => {
  it('proposes the script that starts something', () => {
    expect(proposeStart({ dev: 'vite', stop: 'vite --close', test: 'vitest' })).toEqual({ command: 'npm run dev', from: 'dev' });
    expect(proposeStart({ up: 'docker compose up', down: 'docker compose down' })).toEqual({ command: 'npm run up', from: 'up' });
  });

  it('prefers dev over start, because a card runs in a checkout', () => {
    expect(proposeStart({ start: 'node server.js', dev: 'vite' })?.from).toBe('dev');
  });

  // A guess here would run the wrong thing on somebody's machine, so nothing is better.
  it('proposes nothing when no script says it starts anything', () => {
    expect(proposeStart({ test: 'vitest', build: 'tsc', lint: 'eslint .' })).toBeNull();
    expect(proposeStart({})).toBeNull();
    expect(proposeStart(null)).toBeNull();
    expect(proposeStart(undefined)).toBeNull();
  });
});

// The address a person types for an app they started. QA checks against it, so a
// typo must not reach QA as a place to look.
describe('appAddress', () => {
  it('puts http in front of a bare host and port', () => {
    expect(appAddress('localhost:5173')).toBe('http://localhost:5173');
    expect(appAddress(' 127.0.0.1:3000/app ')).toBe('http://127.0.0.1:3000/app');
  });

  it('keeps an address that names its scheme', () => {
    expect(appAddress('http://localhost:5173')).toBe('http://localhost:5173');
    expect(appAddress('https://recipes.test')).toBe('https://recipes.test');
  });

  it.each(['', '   ', 'local host:5173', 'ftp://localhost:21', 'http://'])('refuses %j', (typed) => {
    expect(appAddress(typed)).toBeNull();
  });
});

// The browser switch shows only on this answer, so it says Playwright only where the project has it.
describe('usesPlaywright', () => {
  it('finds Playwright among the dependencies or the dev dependencies', () => {
    expect(usesPlaywright({ devDependencies: { '@playwright/test': '1.50.0' } }, [])).toBe(true);
    expect(usesPlaywright({ dependencies: { playwright: '1.50.0' } }, [])).toBe(true);
  });

  it('finds a Playwright config file', () => {
    expect(usesPlaywright(null, ['package.json', 'playwright.config.ts'])).toBe(true);
    expect(usesPlaywright(null, ['playwright.config.mjs'])).toBe(true);
  });

  it('finds nothing in a project without it', () => {
    expect(usesPlaywright({ devDependencies: { vitest: '5.0.0' }, scripts: { test: 'playwright test' } }, ['package.json', 'vite.config.ts'])).toBe(false);
    expect(usesPlaywright(null, [])).toBe(false);
    expect(usesPlaywright('not an object', ['README.md'])).toBe(false);
  });
});

// A port the start script names is the one place the app address can be read, not guessed.
describe('scriptPort', () => {
  it('reads --port and -p', () => {
    expect(scriptPort('vite dev --port 5174')).toBe(5174);
    expect(scriptPort('vite --port=4000 --host')).toBe(4000);
    expect(scriptPort('next dev -p 3001')).toBe(3001);
  });

  it('reads nothing from a script that names no port', () => {
    expect(scriptPort('vite')).toBeNull();
    expect(scriptPort(undefined)).toBeNull();
  });

  it('reads a flag only as a word of its own, and a port of two digits or more', () => {
    expect(scriptPort('serve--port 3000')).toBeNull();
    expect(scriptPort('next dev -p 5')).toBeNull();
  });
});

it('refuses an address with a space in its path', () => {
  expect(appAddress('localhost:5173/a b')).toBeNull();
});
