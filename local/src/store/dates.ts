/** Items published longer ago than this are skipped at ingest, as on the full server. */
export const INGEST_MAX_AGE_DAYS = 7;

/**
 * A feed item's publish time as a UTC ISO string. A missing or unreadable date
 * becomes the time it was first seen, and a date in the future is clamped to
 * it. Returns null for an item older than the ingest cutoff.
 */
export function normalizePubDate(raw: string | null | undefined, firstSeen: Date): string | null {
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  const at = Number.isNaN(parsed) || parsed > firstSeen.getTime() ? firstSeen.getTime() : parsed;
  if (at < firstSeen.getTime() - INGEST_MAX_AGE_DAYS * 86_400_000) return null;
  return new Date(at).toISOString();
}
