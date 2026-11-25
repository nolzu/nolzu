// The repository of a Changes group, left out for the project folder, which the server reads when
// none is named. A card whose root is no repository names one on every call.
export const at = (repo: string): Record<string, string> => (repo === '.' ? {} : { repo });
