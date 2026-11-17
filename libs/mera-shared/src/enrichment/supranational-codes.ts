/**
 * Supranational PLACE codes accepted in `GeoTag.countryCode` alongside ISO-3166
 * alpha-2 country codes.
 *
 * WHY THIS EXISTS: the model already emits `country_code: "EU"` on its own —
 * measured 75 times across four 348-article runs — and every one of those was
 * silently discarded by `normalizeLocations` as unmappable. A story about an EU
 * directive, a Gulf summit or a Sahel drought is genuinely about a region, and
 * forcing it to name a member state is worse data than letting it name the bloc.
 *
 * WHY THE CODES ARE LONGER THAN TWO LETTERS (except EU): ISO-3166 alpha-2 owns
 * the entire two-letter space, so a token of any other length can never collide
 * with a real country. The obvious short forms are all taken — `AF` is
 * Afghanistan, `AS` American Samoa, `NA` Namibia, `SA` Saudi Arabia — so
 * `AFRICA`, `ASIA`, `NORTH_AMERICA` and friends are spelled out. `EU` is the one
 * safe two-letter member: it is an ISO-3166-1 *exceptionally reserved* code, so
 * it is permanently withheld from assignment to any country and cannot become
 * ambiguous later.
 *
 * This is a CURATED list, not an open vocabulary. Adding to it is a deliberate
 * act — consumers key on these strings, and an open set would be indistinguishable
 * from the model inventing region names.
 */
export const SUPRANATIONAL_CODES = Object.freeze({
  EU: 'European Union',
  EUROPE: 'Europe',
  MIDDLE_EAST: 'Middle East',
  NORTH_AFRICA: 'North Africa',
  SUB_SAHARAN_AFRICA: 'Sub-Saharan Africa',
  AFRICA: 'Africa',
  ASIA: 'Asia',
  SOUTH_ASIA: 'South Asia',
  SOUTHEAST_ASIA: 'Southeast Asia',
  CENTRAL_ASIA: 'Central Asia',
  EAST_ASIA: 'East Asia',
  NORTH_AMERICA: 'North America',
  CENTRAL_AMERICA: 'Central America',
  SOUTH_AMERICA: 'South America',
  LATIN_AMERICA: 'Latin America',
  CARIBBEAN: 'Caribbean',
  OCEANIA: 'Oceania',
  BALKANS: 'Balkans',
  NORDICS: 'Nordics',
  BALTICS: 'Baltics',
  GULF: 'Gulf',
  GLOBAL: 'Global',
} as const);

export type SupranationalCode = keyof typeof SUPRANATIONAL_CODES;

const SUPRANATIONAL_CODE_SET: ReadonlySet<string> = new Set(
  Object.keys(SUPRANATIONAL_CODES),
);

/**
 * Whether `code` is one of the curated supranational codes. Matching is on the
 * UPPERCASED, trimmed token — callers hand in whatever the model emitted.
 */
export function isSupranationalCode(code: string): boolean {
  return SUPRANATIONAL_CODE_SET.has(code.trim().toUpperCase());
}

/** Human-readable English name for a supranational code, or null. */
export function supranationalName(code: string): string | null {
  const key = code.trim().toUpperCase();
  return SUPRANATIONAL_CODE_SET.has(key)
    ? SUPRANATIONAL_CODES[key as SupranationalCode]
    : null;
}
