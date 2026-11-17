// `CountryCodeMapper` lives on the ROOT `@mera/shared` barrel.
import { CountryCodeMapper } from '@mera/shared';

/** The sentinel scope for the cross-market edition and for wire/international sources. */
export const GLOBAL_SCOPE_KEY = 'GLOBAL';

/**
 * Normalize a caller's country code to the key `headline-edition` is stored under.
 *
 * `build-headline-editions` writes `scopeKey` straight from
 * `publication-source.country_code`, which is **alpha-3** (NLD / IND / ESP) plus the
 * `GLOBAL` sentinel. Callers send **alpha-2** (the app's persona country scopes), so a
 * bare `toUpperCase()` matched nothing and every country scope silently fell through to
 * the live aggregation — un-deduped singletons, no breadth ranking, and only a `warn` to
 * show for it.
 *
 * Normalize at READ, never in the builder: the builder's cleanup pass deletes rows by
 * `scopeKey: { $nin: builtScopeKeys }`, so any alpha-2 row written there is swept on the
 * next run.
 *
 * Both serve paths MUST use this — `NewsArticleService.topHeadlineCandidates` (the For You
 * headline scopes) and `TopHeadlinesService.topHeadlinesForCountry` (Explore). They read
 * the same editions and must rank identically; normalizing one and not the other is the
 * exact bug this helper exists to prevent.
 *
 * An unmappable code falls back to its uppercased self, preserving today's behaviour (a
 * miss, then the live aggregation) rather than throwing on junk input.
 */
export function toHeadlineScopeKey(
  countryCode: string | null | undefined,
): string {
  if (!countryCode) return GLOBAL_SCOPE_KEY;

  const upper = countryCode.trim().toUpperCase();
  if (!upper || upper === GLOBAL_SCOPE_KEY) return GLOBAL_SCOPE_KEY;

  // toAlpha3 passes 'GLOBAL' through, converts alpha-2, validates alpha-3, else null.
  return CountryCodeMapper.toAlpha3(upper) ?? upper;
}
