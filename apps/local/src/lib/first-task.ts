// The keys the next cards get, from the number the counter gives next, for the first task screen.
export const nextKeys = (prefix: string, next: number, count = 3): string[] => Array.from({ length: count }, (_, at) => `${prefix}-${next + at}`);
