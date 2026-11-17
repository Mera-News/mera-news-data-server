/**
 * Publication taxonomy — the closed vocabularies for `publication_type` and
 * `categories` on PublicationSource / NewsPublisher.
 *
 * WHY THIS EXISTS SEPARATELY FROM `category`:
 * `PublicationSource.category` is free text (1125 distinct values in the feed
 * database, mixing genre, language, region and government-agency role) AND it is
 * an embedding input — it is interpolated into `embedding_article_data_retrieval`
 * (see libs/mera-shared/src/article-data/article-data.ts), which is the
 * $vectorSearch field. Re-keying it would mean re-embedding the corpus, so it is
 * left exactly as it is and the structured taxonomy lives in these new fields.
 *
 * Pattern follows EVENT_TYPES in
 * libs/mera-shared/src/enrichment/gemini-enrichment.service.ts: a frozen list, a
 * Set, and a coercion that maps anything unknown to a fallback. Nothing writes
 * these fields without going through the coercions below, so a hallucinated slug
 * from a crawler agent can never reach Mongo.
 */

/**
 * What KIND of outlet this is. Anything unknown coerces to 'other'.
 *
 * `government` vs `regulator`: `government` is the state speaking for itself —
 * a ministry, a parliament, a police force, a national statistics or weather
 * office. `regulator` is an independent supervisory authority that publishes on
 * its own mandate rather than the government's — financial regulators, data
 * protection and competition authorities, food safety and medicines agencies,
 * cyber security authorities. The distinction matters to a reader deciding how
 * to weigh a source, which is the whole reason this vocabulary exists.
 */
export const PUBLICATION_TYPES = [
  'newspaper',
  'magazine',
  'tv',
  'radio',
  'wire_agency',
  'digital_native',
  'government',
  'regulator',
  'other',
] as const;

export type PublicationType = (typeof PUBLICATION_TYPES)[number];

const PUBLICATION_TYPE_SET = new Set<string>(PUBLICATION_TYPES);

/**
 * What the outlet is ABOUT. The first 17 are the Apple News+ genre rails
 * (https://www.apple.com/apple-news/publications/ — the UNION of the four
 * storefronts' nav sections, minus `featured`/`new`, which are merchandising, and
 * minus `newspapers`, which is a type not a genre). The storefronts differ:
 * US/CA carry `men`/`women`/`kids`/`outdoors`, UK drops `kids`/`outdoors`, and AU
 * collapses them all into one `lifestyle` rail — so `lifestyle` is a real slug.
 * The rest are ours, required to classify the publications already in the feed
 * database (government/regulator feeds alone are ~1000 rows).
 */
export const PUBLICATION_CATEGORIES = [
  // --- Apple News+ genres ---
  'news_politics',
  'entertainment',
  'sports',
  'business',
  'style_beauty',
  'food',
  'travel',
  'health',
  'home_garden',
  'science_tech',
  'cars',
  'hobbies',
  'mens_lifestyle',
  'womens_lifestyle',
  'lifestyle',
  'outdoors',
  'kids_parenting',
  // --- ours ---
  'general_news',
  'regional_news',
  'government',
  'weather',
  'crime_justice',
  'culture_arts',
  'education',
  'religion',
  'opinion',
  'other',
] as const;

export type PublicationCategory = (typeof PUBLICATION_CATEGORIES)[number];

const PUBLICATION_CATEGORY_SET = new Set<string>(PUBLICATION_CATEGORIES);

/**
 * Apple's category nav id -> our category slug.
 *
 * `newspapers` is absent on purpose: it describes the publication TYPE, not a
 * genre (see APPLE_TYPE_NAV_IDS). `featured` and `new` are merchandising rails
 * that carry no information about the publication, so they are absent too.
 */
export const APPLE_CATEGORY_MAP: Readonly<Record<string, PublicationCategory>> =
  Object.freeze({
    news: 'news_politics',
    entertainment: 'entertainment',
    sports: 'sports',
    business: 'business',
    style: 'style_beauty',
    food: 'food',
    travel: 'travel',
    health: 'health',
    home: 'home_garden',
    science: 'science_tech',
    cars: 'cars',
    hobbies: 'hobbies',
    men: 'mens_lifestyle',
    women: 'womens_lifestyle',
    // AU-only rail that merges men/women/kids/outdoors into one section.
    lifestyle: 'lifestyle',
    outdoors: 'outdoors',
    kids: 'kids_parenting',
  });

/** Apple nav ids that imply a publication_type instead of a category. */
export const APPLE_TYPE_NAV_IDS: Readonly<Record<string, PublicationType>> =
  Object.freeze({ newspapers: 'newspaper' });

/** Apple nav ids that carry no taxonomy information at all. */
export const APPLE_IGNORED_NAV_IDS: readonly string[] = Object.freeze([
  'featured',
  'new',
]);

export const isPublicationType = (value: unknown): value is PublicationType =>
  typeof value === 'string' && PUBLICATION_TYPE_SET.has(value);

export const isPublicationCategory = (
  value: unknown,
): value is PublicationCategory =>
  typeof value === 'string' && PUBLICATION_CATEGORY_SET.has(value);

/**
 * Normalize a claimed publication type. Returns undefined for absent input (so
 * callers can distinguish "not classified" from "classified as other") and
 * 'other' for anything present but unrecognized.
 */
export function coercePublicationType(
  value: unknown,
): PublicationType | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return isPublicationType(normalized) ? normalized : 'other';
}

/**
 * Normalize a claimed category list: trims, lower-cases, maps unknown slugs to
 * 'other', de-duplicates while preserving order. Returns undefined for absent or
 * empty input so an unclassified publication stays unclassified rather than
 * acquiring a misleading ['other'].
 */
export function coercePublicationCategories(
  value: unknown,
): PublicationCategory[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const out: PublicationCategory[] = [];
  for (const raw of value) {
    if (raw === undefined || raw === null || raw === '') continue;
    const normalized = String(raw)
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_');
    const slug: PublicationCategory = isPublicationCategory(normalized)
      ? normalized
      : 'other';
    if (!out.includes(slug)) out.push(slug);
  }

  return out.length > 0 ? out : undefined;
}
