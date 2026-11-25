import type { Component } from 'svelte';
import { RESERVED_IDS } from './settings-sections.ts';

// The extension interface. A feature is a plain object with an id and whatever of the three parts it
// brings. It knows nothing about plans, payment or who the person is: the app works fully with no
// feature registered, and a registered one only adds.

export interface FeatureRoute {
  // The path under /f, so "cloud" answers at /f/cloud.
  path: string;
  title: string;
  component: Component;
}

export interface FeaturePanel {
  // A slot this version of the app renders. An unknown slot shows nowhere and is not refused, because
  // a feature built for a later version of the app has to stay loadable.
  slot: string;
  component: Component;
}

export interface FeatureSettingsBlock {
  // The anchor the settings nav links to, so two blocks cannot share one.
  id: string;
  title: string;
  component: Component;
}

export interface Feature {
  id: string;
  routes?: readonly FeatureRoute[];
  panels?: readonly FeaturePanel[];
  settings?: FeatureSettingsBlock;
}


// Reactive, which is why this module is `.svelte.ts`. A plain array would leave a slot that drew
// before its package registered empty until the next navigation, and a package registers late by
// nature: the app downloads it and imports it after the first screen is up.
const registered: Feature[] = $state([]);

const routeTaken = (path: string) => registered.some((feature) => (feature.routes ?? []).some((route) => route.path === path));
const sectionTaken = (id: string) => RESERVED_IDS.includes(id) || registered.some((feature) => feature.settings?.id === id);

// Why a feature cannot be registered, or null. Everything is checked before anything is stored, so a
// refused feature is never half in.
function refuse(feature: Feature): string | null {
  if (typeof feature.id !== 'string' || feature.id.trim() === '') return 'A feature was refused: it has no id.';
  if (registered.some((other) => other.id === feature.id)) return `The feature ${feature.id} was refused: another feature already has that id.`;
  for (const route of feature.routes ?? []) {
    if (route.path.trim() === '') return `The feature ${feature.id} was refused: one of its pages has no path.`;
    if (routeTaken(route.path)) return `The feature ${feature.id} was refused: another feature already answers at /f/${route.path}.`;
  }
  const settings = feature.settings;
  if (settings !== undefined && sectionTaken(settings.id)) return `The feature ${feature.id} was refused: the settings section ${settings.id} is already taken.`;
  return null;
}

// Add a feature to the app. It answers false and says why instead of throwing, because the caller is a
// package the app loaded and a refusal there must not reach the person as a crash.
export function registerFeature(feature: Feature): boolean {
  const problem = refuse(feature);
  if (problem !== null) {
    console.error(problem);
    return false;
  }
  registered.push(feature);
  return true;
}

// Run a feature package's own start code. Anything it throws stops there: the board is the free client
// and it keeps working whatever a loaded package does.
export function loadFeature(start: () => void): boolean {
  try {
    start();
    return true;
  } catch (error) {
    console.error(`A feature did not load: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// A feature component that throws while it draws is caught by the boundary around it, and the person
// gets one line in its place. Svelte reports a caught error nowhere, so without this the cause is
// lost and a package author has nothing to read.
export const featureFailed = (error: unknown): void => {
  console.error(`A feature stopped drawing: ${error instanceof Error ? error.message : String(error)}`);
};

export const features = (): readonly Feature[] => registered;

export const featureRoute = (path: string): FeatureRoute | null => registered.flatMap((feature) => feature.routes ?? []).find((route) => route.path === path) ?? null;

export const featurePanels = (slot: string): readonly FeaturePanel[] => registered.flatMap((feature) => feature.panels ?? []).filter((panel) => panel.slot === slot);

export const featureSettings = (): readonly FeatureSettingsBlock[] => registered.flatMap((feature) => feature.settings ?? []);

// Everything registered, gone. Signing out drops the packages that login brought in, and every test
// starts from an empty app.
export const clearFeatures = (): void => {
  registered.length = 0;
};
