// Whether a typed confirm may turn its button on. Exact, with no trim and no case folding, because
// the server compares the typed folder name exactly and refuses anything else.
export function typedName(typed: string, name: string): boolean {
  return name !== '' && typed === name;
}
