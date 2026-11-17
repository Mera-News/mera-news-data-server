import type { RelatedSortable } from '@mera/shared';

/**
 * Country and language chips for `relatedArticlesPage`.
 *
 * ONE NORMALIZER FOR BOTH HALVES. The facet counts and the filter must bucket a
 * row identically, or a chip labelled "7" filters to fewer than 7 rows. So both
 * go through the two functions below and nothing else:
 *
 *   - country: the publication source's alpha-3, upper-cased. Wire and
 *     international sources carry the literal `GLOBAL` and keep it as their own
 *     bucket.
 *   - language: the BASE tag, lower-cased (`zh-Hans` and `zh_TW` are `zh`).
 *
 * A row with no country (or no language) is left out of that dimension's facets
 * and never matches a filter on it.
 *
 * Filters are request-scoped. They never enter the `relkeys:` cache key, so
 * nothing a reader picks is written anywhere.
 */

export interface RelatedFacetCounts {
  countries: Array<{ code: string; count: number }>;
  languages: Array<{ code: string; count: number }>;
}

export interface RelatedFilters {
  countries: Set<string> | null;
  languages: Set<string> | null;
}

export function normalizeRelatedCountry(
  value: string | null | undefined,
): string | null {
  const v = value?.trim().toUpperCase();
  return v ? v : null;
}

export function normalizeRelatedLanguage(
  value: string | null | undefined,
): string | null {
  const v = value?.trim().toLowerCase().split(/[-_]/)[0];
  return v ? v : null;
}

/** Wire input to filter sets. Absent or empty means "no filter" on that
 *  dimension, so an app that sends `[]` gets the unfiltered list. */
export function toRelatedFilters(
  countries?: string[] | null,
  languages?: string[] | null,
): RelatedFilters {
  const toSet = (
    values: string[] | null | undefined,
    norm: (v: string) => string | null,
  ): Set<string> | null => {
    const out = new Set<string>();
    for (const v of values ?? []) {
      const n = norm(v);
      if (n) out.add(n);
    }
    return out.size > 0 ? out : null;
  };
  return {
    countries: toSet(countries, normalizeRelatedCountry),
    languages: toSet(languages, normalizeRelatedLanguage),
  };
}

function matchesCountry(k: RelatedSortable, f: RelatedFilters): boolean {
  if (!f.countries) return true;
  const c = normalizeRelatedCountry(k.countryCodeAlpha3);
  return c !== null && f.countries.has(c);
}

function matchesLanguage(k: RelatedSortable, f: RelatedFilters): boolean {
  if (!f.languages) return true;
  const l = normalizeRelatedLanguage(k.languageCode);
  return l !== null && f.languages.has(l);
}

export function matchesRelatedFilters(
  k: RelatedSortable,
  f: RelatedFilters,
): boolean {
  return matchesCountry(k, f) && matchesLanguage(k, f);
}

/**
 * Counts per chip. Each dimension is counted with the OTHER dimension's filter
 * applied and its own ignored, so picking a language narrows the country chips
 * to countries that still have rows in it, while the language chips keep
 * showing every language the reader could switch to.
 *
 * Ordered by count desc, then code asc, so the order is total.
 */
export function computeRelatedFacets(
  keys: readonly RelatedSortable[],
  f: RelatedFilters,
): RelatedFacetCounts {
  const countries = new Map<string, number>();
  const languages = new Map<string, number>();
  for (const k of keys) {
    if (matchesLanguage(k, f)) {
      const c = normalizeRelatedCountry(k.countryCodeAlpha3);
      if (c) countries.set(c, (countries.get(c) ?? 0) + 1);
    }
    if (matchesCountry(k, f)) {
      const l = normalizeRelatedLanguage(k.languageCode);
      if (l) languages.set(l, (languages.get(l) ?? 0) + 1);
    }
  }
  const sorted = (m: Map<string, number>) =>
    Array.from(m, ([code, count]) => ({ code, count })).sort(
      (a, b) => b.count - a.count || (a.code < b.code ? -1 : 1),
    );
  return { countries: sorted(countries), languages: sorted(languages) };
}
