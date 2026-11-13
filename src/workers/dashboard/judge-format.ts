/** Whole cents; an amount under a cent says so instead of showing $0.00. */
export function judgeMoney(dollars: number | null | undefined, bare = false): string {
  if (dollars === null || dollars === undefined) return 'Cost unavailable';
  const text = dollars > 0 && dollars < 0.005 ? 'less than $0.01' : dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return bare ? text : `About ${text}`;
}
export function judgeHours(n: number): string { return n.toLocaleString('en-US', { maximumFractionDigits: 1 }); }
export function judgeCount(n: number): string {
  const rounded = n >= 1_000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : Math.round(n);
  return rounded.toLocaleString('en-US');
}
/** "About 25 minutes", "About 5 hours", or nights of 8 hours for local sorting. */
export function judgeDuration(hours: number): string {
  const minutes = Math.max(1, Math.round(hours * 60));
  if (minutes < 60) return `About ${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (hours < 8) return `About ${judgeHours(hours)} hour${judgeHours(hours) === '1' ? '' : 's'}`;
  const nights = Math.round(hours / 8);
  return `About ${nights} night${nights === 1 ? '' : 's'} (${Math.round(hours)} hours)`;
}
