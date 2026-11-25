import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Example from './FeatureExample.svelte';
import FeaturePage from './FeaturePage.svelte';
import FeaturePanels from './FeaturePanels.svelte';
import FeatureSettings from './FeatureSettings.svelte';
import { clearFeatures, featurePanels, featureRoute, features, featureSettings, loadFeature, registerFeature } from './features.svelte.ts';
import { MOVED, SECTIONS } from './settings-sections.ts';

const text = (body: string) => body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const LINE = 'This line comes from a registered feature.';

beforeEach(() => {
  clearFeatures();
  vi.restoreAllMocks();
});

// Nothing in the free client may depend on a feature being there, so this is the state the app ships in.
describe('an app with nothing registered', () => {
  it('has no features, no pages, no panels and no settings blocks', () => {
    expect(features()).toEqual([]);
    expect(featureRoute('cloud')).toBeNull();
    expect(featurePanels('app')).toEqual([]);
    expect(featureSettings()).toEqual([]);
  });

  it('renders the panel slot as nothing at all', () => {
    expect(text(render(FeaturePanels, { props: { name: 'app' } }).body)).toBe('');
  });

  it('says a page is not there instead of showing an empty one', () => {
    expect(text(render(FeaturePage, { props: { path: 'cloud' } }).body)).toContain('No feature answers at /f/cloud');
  });
});

describe('registerFeature', () => {
  it('takes a feature with a page, a panel and a settings block', () => {
    const ok = registerFeature({
      id: 'cloud',
      routes: [{ path: 'cloud', title: 'Cloud', component: Example }],
      panels: [{ slot: 'app', component: Example }],
      // Not `cloud`: that is the Cloud section's anchor now.
      settings: { id: 'cloud-sync', title: 'Cloud', component: Example },
    });

    expect(ok).toBe(true);
    expect(featureRoute('cloud')).toMatchObject({ title: 'Cloud' });
    expect(featurePanels('app')).toHaveLength(1);
    expect(featureSettings()).toHaveLength(1);
  });

  it('shows a panel only in the slot it asked for', () => {
    registerFeature({ id: 'cloud', panels: [{ slot: 'app', component: Example }] });

    expect(featurePanels('app')).toHaveLength(1);
    expect(featurePanels('card')).toEqual([]);
  });

  // Two packages with one id, or one package loaded twice.
  it('refuses a second feature with the same id, and keeps the first', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerFeature({ id: 'cloud', panels: [{ slot: 'app', component: Example }] });

    expect(registerFeature({ id: 'cloud', panels: [{ slot: 'app', component: Example }] })).toBe(false);
    expect(features()).toHaveLength(1);
    expect(said.mock.calls.flat().join(' ')).toContain('another feature already has that id');
  });

  it('refuses a feature with no id', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(registerFeature({ id: '  ' })).toBe(false);
    expect(features()).toEqual([]);
  });

  it('refuses a page with no path, which would answer at /f itself', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(registerFeature({ id: 'cloud', routes: [{ path: ' ', title: 'Cloud', component: Example }] })).toBe(false);
  });

  it('refuses a page at a path another feature already answers at', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerFeature({ id: 'cloud', routes: [{ path: 'cloud', title: 'Cloud', component: Example }] });

    expect(registerFeature({ id: 'team', routes: [{ path: 'cloud', title: 'Team', component: Example }] })).toBe(false);
  });

  // The nav link is an anchor, so a second section with the app's own id would jump to the wrong one.
  it.each(SECTIONS.map((section) => section.id))('refuses a settings block that takes the %s anchor', (id) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(registerFeature({ id: 'cloud', settings: { id, title: 'Cloud', component: Example } })).toBe(false);
  });

  // An old section's anchor goes to where that section went, so a block under it would never show.
  it.each([...MOVED.keys()])('refuses a settings block that takes the old %s anchor', (id) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(registerFeature({ id: 'cloud', settings: { id, title: 'Cloud', component: Example } })).toBe(false);
  });

  it('refuses a settings block with an anchor another feature took', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerFeature({ id: 'cloud', settings: { id: 'sync', title: 'Cloud', component: Example } });

    expect(registerFeature({ id: 'team', settings: { id: 'sync', title: 'Team', component: Example } })).toBe(false);
  });

  // A refused feature must not leave its pages behind for the parts that were checked first.
  it('stores nothing at all when one part of a feature is refused', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerFeature({ id: 'cloud', settings: { id: 'sync', title: 'Cloud', component: Example } });

    registerFeature({ id: 'team', routes: [{ path: 'team', title: 'Team', component: Example }], settings: { id: 'sync', title: 'Team', component: Example } });

    expect(featureRoute('team')).toBeNull();
    expect(features()).toHaveLength(1);
  });
});

describe('loadFeature', () => {
  // The board is the free client. A paid package that breaks may not take it down.
  it('keeps the app up when a feature throws while registering', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(
      loadFeature(() => {
        throw new Error('the bundle is half downloaded');
      }),
    ).toBe(false);
    expect(said.mock.calls.flat().join(' ')).toContain('the bundle is half downloaded');
    expect(features()).toEqual([]);
  });

  it('keeps what the feature registered before it threw', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    loadFeature(() => {
      registerFeature({ id: 'cloud', panels: [{ slot: 'app', component: Example }] });
      throw new Error('the second half failed');
    });

    expect(featurePanels('app')).toHaveLength(1);
  });

  it('answers true and keeps what a feature registered', () => {
    expect(loadFeature(() => registerFeature({ id: 'cloud' }))).toBe(true);
    expect(features()).toHaveLength(1);
  });
});

describe('what the app renders', () => {
  it('shows a registered panel in its slot', () => {
    registerFeature({ id: 'cloud', panels: [{ slot: 'app', component: Example }] });

    expect(text(render(FeaturePanels, { props: { name: 'app' } }).body)).toContain(LINE);
  });

  it('leaves the slot empty for a panel that asked for another one', () => {
    registerFeature({ id: 'cloud', panels: [{ slot: 'card', component: Example }] });

    expect(text(render(FeaturePanels, { props: { name: 'app' } }).body)).toBe('');
  });

  it('shows a registered page at its path', () => {
    registerFeature({ id: 'cloud', routes: [{ path: 'cloud', title: 'Cloud', component: Example }] });
    const shown = render(FeaturePage, { props: { path: 'cloud' } });

    expect(text(shown.body)).toContain(LINE);
    expect(shown.head).toContain('Cloud');
  });

  // Two features loaded at once, which is the case where answering with whichever came first is wrong.
  it('gives each path its own page', () => {
    registerFeature({ id: 'cloud', routes: [{ path: 'cloud', title: 'Cloud', component: Example }] });
    registerFeature({ id: 'team', routes: [{ path: 'team', title: 'Team', component: Example }] });

    expect(render(FeaturePage, { props: { path: 'team' } }).head).toContain('Team');
    expect(render(FeaturePage, { props: { path: 'cloud' } }).head).toContain('Cloud');
  });

  // The slot is a prop, so a component that ignores it would show every panel in every slot.
  it('shows a panel of another slot when that slot is the one asked for', () => {
    registerFeature({ id: 'cloud', panels: [{ slot: 'card', component: Example }] });

    expect(text(render(FeaturePanels, { props: { name: 'card' } }).body)).toContain(LINE);
  });

  it('shows a registered settings block under its own heading and anchor', () => {
    registerFeature({ id: 'cloud', settings: { id: 'sync', title: 'Cloud sync', component: Example } });
    const body = render(FeatureSettings).body;

    expect(body).toContain('id="sync"');
    expect(text(body)).toContain('Cloud sync');
    expect(text(body)).toContain(LINE);
  });
});

// The settings anchors are written down twice, because the module that owns them reads sqlite.
it('keeps the copied list of settings anchors equal to the real one', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const section of SECTIONS) expect(registerFeature({ id: section.id, settings: { id: section.id, title: section.title, component: Example } })).toBe(false);

  expect(registerFeature({ id: 'cloud', settings: { id: 'sync', title: 'Cloud', component: Example } })).toBe(true);
});
