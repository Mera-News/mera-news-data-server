/**
 * A feed item's publish time as a UTC ISO string. A missing or unreadable date
 * becomes the time it was first seen, and a date in the future is clamped to
 * it. Unlike the full server, no item is skipped for its age: a feed loaded
 * once to be analysed keeps everything it offers.
 */
export function normalizePubDate(raw: string | null | undefined, firstSeen: Date): string {
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  const at = Number.isNaN(parsed) || parsed > firstSeen.getTime() ? firstSeen.getTime() : parsed;
  return new Date(at).toISOString();
}
