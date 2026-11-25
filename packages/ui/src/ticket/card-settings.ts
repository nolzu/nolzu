import { engineName, type Estimate, estimateShort, presetLabel } from '@nolzu/protocol';

// The tab still reads the preset names from here; they live in protocol so the server can check them.
export { presetLabel };


// The card stores only what differs from its preset, so a row with any value of its own is changed.
export const isChanged = (own: Readonly<Record<string, string | undefined>>): boolean => Object.values(own).some((value) => value !== undefined);

// A step the project set in Settings, Models follows that row and not the preset.
export const fromProject = (from: { model: string; effort: string }): boolean => from.model === 'global' || from.effort === 'global';

/**
 * "Heavy uses opus · high": what Reset gives the row back.
 *
 * The engine is named only when it is not the one the row runs on now, and the figure only where runs
 * measured one. `effortInName` drops the effort for an engine that reads it off the
 * model id, as the picker shows none there.
 */
export function presetUses(
  preset: string,
  follows: { engine: string; model: string; effort: string; from: { model: string; effort: string } },
  engineNow: string,
  estimate?: Estimate,
  effortInName = false,
): string {
  const what = [...(follows.engine === engineNow ? [] : [engineName(follows.engine)]), follows.model, ...(effortInName ? [] : [follows.effort])].join(' · ');
  const name = fromProject(follows.from) ? 'The project' : presetLabel(preset);
  return `${name} uses ${what}${estimate === undefined ? '' : `, ${estimateShort(estimate)}`}.`;
}

// What Reset said it did, naming what the step follows now.
export const resetSaid = (step: string, preset: string, follows: { from: { model: string; effort: string } }): string =>
  `${step} follows ${fromProject(follows.from) ? 'the project' : presetLabel(preset)} again.`;

// How many values a row stores. An engine is stored only with its model, so the pair counts once.
export const ownValues = (own: Readonly<{ engine?: string; model?: string; effort?: string }>): number =>
  (own.engine !== undefined || own.model !== undefined ? 1 : 0) + (own.effort !== undefined ? 1 : 0);

// The line under the heading: how many values the card set itself.
export function followsSaid(preset: string, values: number): string {
  const name = presetLabel(preset);
  if (values === 0) return `No values of its own. Every step changes when ${name} changes.`;
  return `With ${values} ${values === 1 ? 'value' : 'values'} of its own. The rest changes when ${name} changes.`;
}

const listed = (items: readonly string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

// What a preset switch did, in one line that names each step it cleared.
export function switchSaid(preset: string, cleared: readonly string[]): string {
  const now = `This card follows ${presetLabel(preset)} now.`;
  return cleared.length === 0 ? now : `${now} It dropped its own choice for ${listed(cleared)}.`;
}
