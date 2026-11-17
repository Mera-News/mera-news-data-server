/**
 * ArticleEnrichmentProvider port (served-only article tagging). Business logic
 * never imports the Gemini SDK/REST surface — it hands a batch of English
 * article text to this port and gets back one aligned set of tags per input.
 *
 * Contract (mirrors {@link TranslationProvider}): `enrichBatch` returns exactly one
 * {@link EnrichmentOutput} per input, in input order, keyed by the input `id`.
 * Per-item CONTENT failures (safety block, id misalignment surviving the
 * single-item retry, unparseable row) come back DEGRADED — empty `geo_tags`,
 * empty `entities`, `event_type: 'other'` — so the article still flows through
 * the pipeline marked TAGGING_SUCCESSFUL (no data loss, no DLQ). Only INFRA
 * failures (network, 5xx after retries, auth/config) THROW, so the caller can
 * mark the chunk TAGGING_FAILED and let the fanout sweep re-drive it.
 */
export const ARTICLE_ENRICHMENT_PROVIDER = 'ARTICLE_ENRICHMENT_PROVIDER';

/** A single geo tag: the place the article CONTENT is about. */
export interface GeoTag {
  /** Canonical English city name (e.g. "Mumbai", "Munich"). Omitted when none. */
  city?: string;
  /** State/province in canonical English (e.g. "Madhya Pradesh"). Omitted when none. */
  region?: string;
  /**
   * A PLACE code, UPPERCASE. Either ISO-3166 alpha-2 (e.g. "IN", "NL") or one
   * of the curated supranational codes in {@link SUPRANATIONAL_CODES} (e.g.
   * "EU", "MIDDLE_EAST"). Required for a valid tag.
   *
   * The two spaces cannot collide: alpha-2 owns every two-letter token, and the
   * only two-letter supranational code is "EU", which ISO-3166-1 reserves and
   * never assigns to a country. A supranational tag carries NO `city` and NO
   * `region` — "the city of the European Union" is not a thing.
   */
  countryCode: string;
  /**
   * GeoNames id of the canonicalised city, when the place resolved against
   * the `places` gazetteer and the row carries one. Never on a country-only,
   * region-only or supranational tag.
   */
  geonameId?: number;
}

/** The tag payload extracted for one article. */
export interface ArticleEnrichment {
  /**
   * ≤3 places, most-central-first, countries before supranational codes.
   * Empty when none. Gemini adapter: places the content is about. OpenRouter
   * adapter: places where the event happens or whose residents are directly
   * affected (the field name is kept on purpose).
   */
  geo_tags: GeoTag[];
  /** ≤5 canonical English proper nouns (people/orgs/products). Empty when none. */
  entities: string[];
  /** One of the fixed event-type enum values; degraded items get 'other'. */
  event_type: string;
  /**
   * Only ever populated while `ENRICHMENT_CATEGORY_ENABLED` is on; degraded
   * rows leave it unset. Gemini adapter: a two-level `CONTENT_CATEGORIES`
   * path the model returned verbatim. OpenRouter adapter:
   * `content_categories[0]`, a snapped NLP-tree node.
   */
  content_category?: string;
  /**
   * The fields below are written only by the OpenRouter adapter. Each is
   * absent (never null) when the model returned nothing valid; a closed
   * vocabulary is enforced in code before it gets here.
   */
  /** ≤3 NLP-tree nodes, best first, none a prefix of another. */
  content_categories?: string[];
  /** One of GEO_SCOPES in enrichment-spec.ts. */
  geo_scope?: string;
  /** One of GENRES in enrichment-spec.ts. */
  genre?: string;
  /** One of TONES in enrichment-spec.ts. */
  tone?: string;
  /** Integer 1-5. */
  significance?: number;
}

export interface EnrichmentInput {
  /** Stable id used for the every-input-id-exactly-once contract. */
  id: string;
  /** Canonical English title (the pipeline's `title_en_internal_only`). */
  title_en: string;
  /** Canonical English description (`description_en_internal_only`). */
  description_en: string;
}

export interface EnrichmentOutput extends ArticleEnrichment {
  id: string;
}

/** What one `enrichBatchWithUsage` call cost and how it went. */
export interface EnrichmentBatchUsage {
  /** HTTP calls made, bisection and single-item retries included. */
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** Billed cost as the host reported it (OpenRouter `usage.cost`). */
  costUsd: number;
  /** Returned model id → calls. */
  models: Record<string, number>;
  /** Host that actually served (OpenRouter `provider`) → calls. */
  providers: Record<string, number>;
  /** Items that left the batch call for a bisected or single-item retry. */
  itemFallbacks: number;
  /** Items that came back degraded. */
  degraded: number;
}

export interface EnrichmentBatchResult {
  outputs: EnrichmentOutput[];
  usage: EnrichmentBatchUsage;
}

/**
 * How the caller should wrap this provider's batch calls. Present only on an
 * adapter that owns its own HTTP retries and batch size; the caller then
 * sub-batches at `batchSize`, bounds concurrency at `concurrency`, bounds a
 * whole `enrichBatch` at `chunkTimeoutMs` and retries it `policyRetries`
 * times (0: a whole-batch retry would re-bill calls that already succeeded).
 */
export interface EnrichmentProviderTuning {
  batchSize: number;
  concurrency: number;
  chunkTimeoutMs: number;
  policyRetries: number;
}

export interface ArticleEnrichmentProvider {
  enrichBatch(
    items: EnrichmentInput[],
    signal?: AbortSignal,
  ): Promise<EnrichmentOutput[]>;
  /** Same contract as `enrichBatch`, plus this call's own usage. */
  enrichBatchWithUsage?(
    items: EnrichmentInput[],
    signal?: AbortSignal,
  ): Promise<EnrichmentBatchResult>;
  readonly tuning?: EnrichmentProviderTuning;
}
