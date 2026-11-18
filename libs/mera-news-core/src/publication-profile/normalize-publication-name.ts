/**
 * The ONE key form for looking a publication up by its display name.
 *
 * Feed rows (`ArticleWithClusters`, `ArticleSummary`, on-device suggestion
 * rows) carry no publication id, only `publication_name` + `country_code`, so
 * any per-publication lookup from a card keys on (name, country). The server
 * and the app must build that key identically; the app keeps a verbatim copy
 * of this function, so change both together or not at all.
 *
 * Deliberately minimal: trim and Unicode NFC, nothing else.
 * - No case folding: the app echoes the exact string the server sent, and
 *   distinct outlets can differ only by case or accent ("La Nacion" and
 *   "La Nación" are different papers in different countries).
 * - No punctuation stripping, for the same reason.
 * NFC exists only so a name typed or copied through a layer that decomposed
 * its accents still matches the stored, composed form.
 */
export function normalizePublicationName(
  raw: string | null | undefined,
): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().normalize('NFC');
}
