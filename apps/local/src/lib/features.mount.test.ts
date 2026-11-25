import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Example from './FeatureExample.svelte';
import FeaturePage from './FeaturePage.svelte';
import FeaturePanels from './FeaturePanels.svelte';
import FeatureSettings from './FeatureSettings.svelte';
import { clearFeatures, registerFeature } from './features.svelte.ts';

// What a downloaded package looks like on its worst day: a component that throws the moment it
// draws. A Svelte component is a function, so this is one, and no broken .svelte file has to ship
// to test it.
const Broken = (() => {
  throw new Error('this panel cannot draw');
}) as never;

let instance: Record<string, unknown> | null = null;
let target: HTMLElement | null = null;

beforeEach(() => {
  clearFeatures();
  // `featureFailed` is the only thing that writes the cause, and the mock is what lets the last
  // test count that line. Svelte's boundary logs nothing of its own.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (instance !== null) void unmount(instance);
  instance = null;
  target?.remove();
  target = null;
  vi.restoreAllMocks();
});

function shown(component: unknown, props: Record<string, unknown>): string {
  target = document.body.appendChild(document.createElement('div'));
  instance = mount(component as never, { target, props }) as Record<string, unknown>;
  flushSync();
  return target.textContent ?? '';
}

it('keeps the app up when a feature panel throws while it draws', () => {
  registerFeature({ id: 'broken', panels: [{ slot: 'app', component: Broken }] });
  registerFeature({ id: 'fine', panels: [{ slot: 'app', component: Example }] });

  const text = shown(FeaturePanels, { name: 'app' });

  expect(text).toContain('A feature panel stopped drawing');
  // The panel slot sits in the layout, so a panel that took the app down would take every route
  // with it, including the board.
  expect(text).toContain('This line comes from a registered feature.');
});

it('keeps the app up when a feature page throws while it draws', () => {
  registerFeature({ id: 'broken', routes: [{ path: 'cloud', title: 'Cloud', component: Broken }] });

  expect(shown(FeaturePage, { path: 'cloud' })).toContain('This feature page stopped drawing');
  expect(vi.mocked(console.error)).toHaveBeenCalledWith('A feature stopped drawing: this panel cannot draw');
});

it('keeps the settings page up when a feature settings block throws while it draws', () => {
  registerFeature({ id: 'broken', settings: { id: 'cloud-sync', title: 'Cloud sync', component: Broken } });

  const text = shown(FeatureSettings, {});

  expect(text).toContain('This settings section stopped drawing');
  // The section keeps its heading, so the nav link above it still leads somewhere.
  expect(text).toContain('Cloud sync');
  expect(vi.mocked(console.error)).toHaveBeenCalledWith('A feature stopped drawing: this panel cannot draw');
});

it('says on the console which feature failed, once', () => {
  registerFeature({ id: 'broken', panels: [{ slot: 'app', component: Broken }] });

  shown(FeaturePanels, { name: 'app' });

  // Nothing draws the error for the person, so the console line is the only way to find it. Once,
  // because a boundary that reported the same failure on every redraw would bury it.
  expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
  expect(vi.mocked(console.error)).toHaveBeenCalledWith('A feature stopped drawing: this panel cannot draw');
});

// The order a cold load really has: the slot draws first, and the package registers a moment later,
// after its import resolved. A panel that only showed on the next navigation would leave a person who
// opened /projects looking at a page with no project list.
it('shows a panel a feature registers after the slot drew', () => {
  const text = shown(FeaturePanels, { name: 'projects' });
  expect(text).toBe('');

  registerFeature({ id: 'paid', panels: [{ slot: 'projects', component: Example }] });
  flushSync();

  expect(target?.textContent ?? '').toContain('This line comes from a registered feature.');
});

// Same array, same gap: the settings page reads it with no slot name at all.
it('shows a settings block a feature registers after the settings page drew', () => {
  shown(FeatureSettings, {});

  registerFeature({ id: 'paid', settings: { id: 'cloud-sync', title: 'Cloud sync', component: Example } });
  flushSync();

  expect(target?.textContent ?? '').toContain('Cloud sync');
});
