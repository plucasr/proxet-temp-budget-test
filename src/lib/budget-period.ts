//
// Budget periods are calendar months of the server's local date. Transaction
// dates are zone-less "YYYY-MM-DD" strings, so a month is the half-open
// string range [first day, first day of next month) — lexicographic order of
// ISO dates matches chronological order. Pure functions; `date` is injected
// so tests can pin "today".

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM" of the given local date. */
export function monthKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

/** Half-open date range covering the local calendar month of `date`. */
export function monthRange(date: Date): { from: string; toExclusive: string } {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-based
  const nextYear = month === 11 ? year + 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  return {
    from: `${year}-${pad2(month + 1)}-01`,
    toExclusive: `${nextYear}-${pad2(nextMonth + 1)}-01`,
  };
}
