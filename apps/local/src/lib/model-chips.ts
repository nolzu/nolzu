// The short step names on a preset card's chips ("ref" for Refine). The
// chip names its model in full above it.

// The short names. Any other step takes its first word.
const STEP_WORDS: Readonly<Record<string, string>> = { Refine: 'ref', Implement: 'impl', 'Wrap-up': 'wrap' };

export const stepWord = (step: string): string => STEP_WORDS[step] ?? (step.toLowerCase().split(/[^a-z0-9]/)[0] || step.toLowerCase());
