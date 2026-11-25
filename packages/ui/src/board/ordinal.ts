// 1st, 2nd, 3rd, 4th, and 11th to 13th, which take "th" although they end in 1, 2 and 3.
export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}
