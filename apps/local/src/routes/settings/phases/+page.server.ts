import { fail } from '@sveltejs/kit';
import { getSetting } from '@nolzu/core/node';
import { phaseLabel, SCOUT_AND_EVIDENCE } from '@nolzu/protocol';
import { INSTRUCTION_PHASES, phaseInstructionsPath, readPhaseInstructions, savePhaseInstructions } from '@nolzu/runner';
import { database } from '$lib/db.ts';
import type { Actions, PageServerLoad } from './$types';

// Each phase with what its file in the project folder holds. Read off the disk on every load, because
// the file is the project's and a pull can change it.
export const load: PageServerLoad = () => {
  const project = getSetting(database(), 'projectPath');
  return {
    hasFolder: project !== null,
    // Assessment reads Scout findings only, so it waits with Scout. A file already there still works.
    phases: INSTRUCTION_PHASES.filter((phase) => SCOUT_AND_EVIDENCE || phase !== 'assess').map((phase) => {
      const read = project === null ? undefined : readPhaseInstructions(project, phase);
      return { phase, label: phaseLabel(phase), path: phaseInstructionsPath(phase), text: read?.text ?? '', cut: read?.cut ?? false };
    }),
  };
};

export const actions: Actions = {
  // One phase at a time. A refusal sends back what was typed, so the box does not lose it.
  save: async ({ request }) => {
    const form = await request.formData();
    const phase = form.get('phase')?.toString() ?? '';
    const text = form.get('text')?.toString() ?? '';
    const project = getSetting(database(), 'projectPath');
    const message = project === null ? 'This project has no folder, so there is nowhere to keep the file.' : savePhaseInstructions(project, phase, text);
    return message === null ? { phase, saved: true } : fail(400, { phase, text, message });
  },
};
