/**
 * The enrichment spec for the OpenAI-compatible LLM adapter, defined ONCE:
 * the closed vocabularies, the place rule and the system prompt built from
 * them. Ported verbatim from the bake-off
 * (apps/mera-scripts/eval-data/enrichment-bakeoff/lib/spec.mjs and the
 * SYSTEM_PROMPT in lib/vertex.mjs), which is where the held-out scores and the
 * China-politics probe were measured. Any edit here changes the exact bytes
 * those measurements describe, and one batched prompt couples every field it
 * emits, so treat a wording change as a model change.
 *
 * The prompt carries NO taxonomy list and NO geo data. Categories and places
 * come from the model's own knowledge and are post-validated in code
 * (category-snap.ts, place-gazetteer.ts, enrichment-normalizer.ts).
 */
import type { EnrichmentInput } from './article-enrichment-provider.port';

export const EVENT_TYPE_DESCRIPTIONS = Object.freeze({
  election: 'elections, campaigns, votes, referendums',
  policy: 'government policy, laws, regulation, diplomacy',
  conflict: 'war, armed conflict, military action, terrorism',
  crime: 'crime, police, courts, trials',
  protest: 'protests, strikes, demonstrations',
  disaster: 'natural or industrial disasters',
  accident: 'accidents: crashes, fires, collapses',
  weather: 'weather and forecasts',
  business: 'business, markets, economy, companies, prices',
  sports: 'sports',
  entertainment: 'entertainment, celebrities, culture, arts',
  health: 'health, medicine, disease',
  science_tech: 'science, technology, research, space',
  obituary: 'a death notice or obituary',
  other: 'none of the above',
} as const);

export const GEO_SCOPE_DESCRIPTIONS = Object.freeze({
  global: 'the whole world',
  multi_country: 'several specific countries',
  national: 'one whole country',
  regional: 'a state, province or region within a country',
  city: 'one city or town',
  neighbourhood: 'part of a city',
  none: 'no geographic impact',
} as const);

export const GENRE_DESCRIPTIONS = Object.freeze({
  news: 'a straight news report',
  opinion: 'an opinion column, editorial or op-ed',
  analysis: 'an explainer or background analysis',
  press_release: 'an announcement published as-is by a company or government',
  sponsored: 'advertising or an advertorial',
  not_news: 'not news: listings, horoscopes, recipes, puzzles, site notices',
} as const);

export const TONE_DESCRIPTIONS = Object.freeze({
  positive: 'good news',
  neutral: 'neutral',
  negative: 'bad news without violence or death',
  distressing: 'upsetting: violence, death, abuse or casualties',
} as const);

/** Index i describes significance i + 1. */
export const SIGNIFICANCE_DESCRIPTIONS: readonly string[] = Object.freeze([
  'trivia, entertainment or celebrity',
  'a minor local matter',
  'notable: affects a community or a sector',
  'major: lives, livelihoods, laws or large sums',
  'critical emergency: mass casualties, war escalation, national emergency',
]);

export type GeoScope = keyof typeof GEO_SCOPE_DESCRIPTIONS;
export type Genre = keyof typeof GENRE_DESCRIPTIONS;
export type Tone = keyof typeof TONE_DESCRIPTIONS;

export const GEO_SCOPES = Object.keys(GEO_SCOPE_DESCRIPTIONS) as GeoScope[];
export const GENRES = Object.keys(GENRE_DESCRIPTIONS) as Genre[];
export const TONES = Object.keys(TONE_DESCRIPTIONS) as Tone[];

export const PLACE_RULE =
  'Places are where the event happens or whose residents are directly affected. ' +
  "The publisher's country does not count unless the event is there. A place merely mentioned does not count. " +
  'A nationality implies its country when those people or institutions are central.';

/** Descriptions are cut here before they reach the model (bake-off parity). */
export const DESCRIPTION_MAX_CHARS = 1500;

const list = (o: object): string => Object.keys(o).join(', ');

export const SYSTEM_PROMPT = `You tag news articles with metadata. The input is a JSON array of articles. Return a JSON array with one object per article, same order, and nothing else.
Object keys:
"id": the article id, copied exactly.
"event_type": one of ${list(EVENT_TYPE_DESCRIPTIONS)}.
"categories": 1 to 3 Google Cloud Natural Language content categories (the v2 content classification taxonomy), as full paths such as "/Real Estate/Real Estate Listings/Residential Sales" or "/Sports/Team Sports/Soccer". Best first. Use the deepest level you are sure of. Never list a category together with its own parent.
"geo_scope": how wide the area whose residents are directly affected is, one of ${list(GEO_SCOPE_DESCRIPTIONS)}.
"places": up to 3 places, most central first, each {"city": string or null, "region": string or null, "country": ISO 3166 alpha-2}. ${PLACE_RULE} Canonical English names. Never invent a place the text does not name or clearly imply.
"entities": up to 5 people, organisations or named things the article is centrally about, canonical English names. Not places.
"genre": one of ${list(GENRE_DESCRIPTIONS)}.
"tone": one of ${list(TONE_DESCRIPTIONS)}.
"significance": 1 to 5, severity for the people affected, not geographic breadth: ${SIGNIFICANCE_DESCRIPTIONS.map((s, i) => `${i + 1} ${s}`).join('; ')}.`;

/** The whole per-request payload: the articles, nothing else. */
export function buildUserPayload(items: EnrichmentInput[]): string {
  return JSON.stringify(
    items.map((a) => ({
      id: a.id,
      title: a.title_en,
      description: (a.description_en || '').slice(0, DESCRIPTION_MAX_CHARS),
    })),
  );
}
