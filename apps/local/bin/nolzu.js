#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { nodeRefusal, quietSqliteWarning } from './node-check.js';

// Before anything imports node:sqlite. An older Node fails on that import with a stack trace that names
// no version, so the start reads `engines` from package.json and says the one thing to do. The same
// file in a clone (apps/local) and in an install (the package root).
const { engines } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tooOld = nodeRefusal(process.version, engines?.node);
if (tooOld !== null) {
  console.error(tooOld);
  process.exit(1);
}

quietSqliteWarning(process);

await import('./start.js');
