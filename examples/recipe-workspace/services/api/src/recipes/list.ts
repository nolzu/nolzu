import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Recipe {
  id: number;
  title: string;
  minutes: number;
  tags: string[];
}

// Read from disk rather than through a JSON import, so the file works on any Node that can
// run TypeScript, with no import attribute to get wrong.
export function listRecipes(): Recipe[] {
  const file = join(import.meta.dirname, 'data.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Recipe[];
}
