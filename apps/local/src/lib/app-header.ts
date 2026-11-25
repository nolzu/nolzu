import { basename } from 'node:path';
import { readSetting } from '@nolzu/core';
import type { RowSource } from './ticket.ts';

// The rail's project selector shows the project by its folder name. With no project set, or a root path with no
// folder name, it shows none.
export function projectName(db: RowSource): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('projectPath') as { value: string } | undefined;
  const path = readSetting('projectPath', row?.value).value;
  return path === null ? null : basename(path) || null;
}
