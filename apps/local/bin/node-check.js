// Plain JavaScript with no import, so an old Node reads it. The Node of `engines` in package.json, and
// not a second copy of the number that could drift from it.

/**
 * Why this Node cannot run Nolzu, or null. `running` is `process.version`, `wanted` the `engines.node`
 * range: one or more of ">=22.16.0" and "^22.16.0" joined by "||". A range this cannot read refuses
 * nothing.
 */
export function nodeRefusal(running, wanted) {
  const have = /(\d+)\.(\d+)\.(\d+)/.exec(running);
  const ranges = (wanted ?? '').split('||').map((one) => /^\s*(\^|>=)\s*(\d+)\.(\d+)\.(\d+)\s*$/.exec(one));
  if (have === null || ranges.length === 0 || ranges.some((one) => one === null)) return null;
  const version = have.slice(1, 4).map(Number);
  const atLeast = (need) => {
    for (let part = 0; part < 3; part += 1) if (version[part] !== need[part]) return version[part] > need[part];
    return true;
  };
  const fits = ranges.some(([, kind, ...parts]) => {
    const need = parts.map(Number);
    return (kind === '>=' || version[0] === need[0]) && atLeast(need);
  });
  if (fits) return null;
  const named = ranges.map(([, kind, ...parts]) => `${parts.join('.')} or ${kind === '^' ? `a newer ${parts[0]}` : 'newer'}`).join(', or ');
  return `Nolzu needs Node ${named}, and this is Node ${have[0]}. Install a newer Node from https://nodejs.org or with your version manager (for example nvm install 24), then start Nolzu again.`;
}

/**
 * Node 22 marks node:sqlite experimental and says so on every start, a line that reads like a fault
 * and names nothing to do. This drops that one warning from `target.emitWarning`; every other warning
 * goes through as before.
 */
export function quietSqliteWarning(target) {
  const emitWarning = target.emitWarning;
  target.emitWarning = (warning, ...rest) => {
    const text = typeof warning === 'string' ? warning : warning?.message;
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0]?.type ?? warning?.name);
    if (type === 'ExperimentalWarning' && typeof text === 'string' && text.startsWith('SQLite is an experimental feature')) return;
    return emitWarning.call(target, warning, ...rest);
  };
}
