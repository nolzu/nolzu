// A value that starts with a dash would be read as a flag. Nothing here goes through a
// shell, so each argument is passed on its own and a space is only a problem where the
// value is a name rather than a path.
export function guardLeadingDash(value: string, field: string): string {
  if (value === '' || value.startsWith('-')) {
    throw new Error(`The ${field} ${JSON.stringify(value)} cannot be passed to the engine, because it would be read as a flag.`);
  }
  return value;
}

export function guardName(value: string, field: string): string {
  if (/\s/.test(value)) {
    throw new Error(`The ${field} ${JSON.stringify(value)} cannot be passed to the engine, because a name holds no whitespace.`);
  }
  return guardLeadingDash(value, field);
}
