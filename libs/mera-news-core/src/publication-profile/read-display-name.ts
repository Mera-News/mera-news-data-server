import type { PublicationSource } from '@mera/models/models/publication-source.model';

/**
 * Reads one locale out of `publication_name_i18n`, tolerant of whether
 * Mongoose's `.lean()` handed back a plain object or a `Map` instance (both
 * are legitimate depending on lean's `flattenMaps` option, which this query
 * does not set). Returns `undefined` on any kind of miss so the caller's
 * fallback-to-`name` logic stays in one place.
 */
export function readDisplayName(
  i18n: PublicationSource['publication_name_i18n'],
  language: string,
): string | undefined {
  if (!i18n) return undefined;
  if (i18n instanceof Map) return i18n.get(language) ?? undefined;
  return (i18n as unknown as Record<string, string>)[language] ?? undefined;
}
