import { describe, expect, it, vi } from 'vitest';
import { drawnAt, resolve, route } from './app-paths.ts';

// Every expected address here is written out by hand and checked against SvelteKit's own
// `resolve_route` in `src/utils/routing.js`, and the depths below against its server `resolve` in
// `src/runtime/app/paths/server.js`. The stub is only worth having while it answers what a person's
// browser gets: one that is close but not right makes a page test pass on an address that never
// existed, which is worse than the page having no test at all.
describe('the $app/paths stub', () => {
  it('leaves a route with no parameter alone', () => {
    expect(route('/evidence')).toBe('/evidence');
    expect(route('/')).toBe('/');
  });

  it('fills a parameter in raw, so the page encodes its own', () => {
    expect(route('/t/[key]/[tab]', { key: 'APP-4', tab: 'log' })).toBe('/t/APP-4/log');
    expect(route('/t/[key]', { key: 'APP%204' })).toBe('/t/APP%204');
    // Not encoded here. The real one splices the value in as it is, so a page that needs an id
    // encoded calls encodeURIComponent itself and a test reads the address a person clicks.
    expect(route('/t/[key]', { key: 'a b' })).toBe('/t/a b');
  });

  it('drops an optional segment nobody filled in, with its slash', () => {
    expect(route('/t/[key]/[[tab]]', { key: 'APP-4' })).toBe('/t/APP-4');
    expect(route('/t/[key]/[[tab]]', { key: 'APP-4', tab: 'log' })).toBe('/t/APP-4/log');
    // An empty string counts as nobody filled it in, because the real one tests the value for
    // truth and not for undefined.
    expect(route('/t/[key]/[[tab]]', { key: 'APP-4', tab: '' })).toBe('/t/APP-4');
  });

  it('ignores a matcher and a route group, which are not in the address', () => {
    expect(route('/scout/f/[id=number]', { id: '7' })).toBe('/scout/f/7');
    expect(route('/(app)/settings')).toBe('/settings');
  });

  it('keeps a rest parameter whole, and drops it when it is empty', () => {
    expect(route('/f/[...path]', { path: 'docs/a.md' })).toBe('/f/docs/a.md');
    expect(route('/f/[...path]', { path: '' })).toBe('/f');
  });

  it('keeps a trailing slash the route id carries', () => {
    expect(route('/evidence/')).toBe('/evidence/');
  });

  it('throws on a required parameter nobody passed, rather than answering an address with brackets in it', () => {
    expect(() => route('/t/[key]/[tab]', { key: 'APP-4' })).toThrow("Missing parameter 'tab' in route /t/[key]/[tab]");
    // A rest parameter left out of the parameters throws as well. Only a rest that was passed and
    // is empty drops. Passed as `{}` and not left off the call, because the real one reads the
    // parameters it was handed and a call with none is a TypeError there.
    expect(() => route('/f/[...path]', {})).toThrow("Missing parameter 'path' in route /f/[...path]");
  });

  it('throws on a value with a slash at either end, which would build a different route', () => {
    expect(() => route('/t/[key]', { key: '/APP-4' })).toThrow(
      "Parameter 'key' in route /t/[key] cannot start or end with a slash -- this would cause an invalid route like foo//bar",
    );
    expect(() => route('/t/[key]', { key: 'APP-4/' })).toThrow('cannot start or end with a slash');
  });

  it('throws on a path that is not absolute', () => {
    expect(() => route('evidence')).toThrow('Cannot use `resolve(...)` with a non-absolute pathname or route ID (got "evidence")');
  });
});

// What a page draws into an href. The server answers every address relative to the page it is
// drawing, so the same call is a different string on a screen one segment below the root and on one
// three segments below it, and only the page being drawn decides which.
describe('the address a drawn page serves', () => {
  it('counts the depth of the page that draws the link', () => {
    drawnAt('/evidence');
    expect(resolve('/evidence')).toBe('./evidence');
    expect(resolve('/t/[key]/[tab]', { key: 'APP-1', tab: 'log' })).toBe('./t/APP-1/log');
    expect(resolve('/')).toBe('./');

    // Two segments below the root. An address from the root would have gone to the same place here
    // and to nowhere from a deeper screen, which is the whole reason the depth is in the stub.
    drawnAt('/t/APP-4/log');
    expect(resolve('/evidence')).toBe('../../evidence');
    expect(resolve('/')).toBe('../../');
  });

  // The guard is the whole reason `drawnAt` is not optional: a test that forgets it must be told so,
  // not handed an address from the root that happens to work on one page and nowhere else. `drawn`
  // is module state and sticks once any test has set it, so this one loads the stub fresh.
  it('refuses to answer before a test says which page is drawn', async () => {
    vi.resetModules();
    const fresh = (await import('./app-paths.ts')) as typeof import('./app-paths.ts');

    // The route half needs no page and still answers, which is what the split is for.
    expect(fresh.route('/evidence')).toBe('/evidence');
    expect(() => fresh.resolve('/evidence')).toThrow(/drawnAt\(\) with the address of the page/);
  });
});
