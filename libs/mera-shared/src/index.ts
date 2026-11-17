// Constants
export { QueueName } from './constants/queue-names.enum';
// Config
export {
  DEFAULT_JOB_OPTIONS,
  QUEUE_TIMEOUTS,
  DEFAULT_LOCK_DURATION,
  FLOW_CHILD_JOB_OPTIONS,
} from './config/bullmq.config';
export { RETENTION_RULES } from './config/retention.config';
export type {
  RetentionRule,
  RetentionCascade,
} from './config/retention.config';

// Logger
export { StructuredLoggerModule } from './logger/structured-logger.module';

// Pagination
export {
  encodeCursor,
  decodeCursor,
  BaseCursorPayload,
  PublicationNameCursor,
  PublisherNameCursor,
  CreatedAtCursor,
} from './pagination/cursor.utils';

export {
  buildPublicationNameCursorFilter,
  buildPublisherNameCursorFilter,
  buildCreatedAtCursorFilter,
} from './pagination/mongo-cursor-filter';

// Health
export { HealthModule } from './health/health.module';
export type { HealthModuleOptions } from './health/health.module';

// Cache (Redis via @keyv/redis for cache-manager v7)
export {
  asCacheModuleStore,
  buildKeyvRedisStore,
  normalizeCacheNamespace,
} from './cache/keyv-redis-cache';
export type {
  CacheStore,
  KeyvRedisStoreOptions,
} from './cache/keyv-redis-cache';

// Article cache (Redis scratchpad for the ID-array ingestion pipeline)
export {
  ArticleCacheService,
  encodeVector,
  decodeVector,
} from './cache/article-cache.service';
export type {
  ArticleCacheEntry,
  ArticleCacheServiceOptions,
  ArticleCacheRedisClient,
} from './cache/article-cache.service';

// Per-chunk provider-call resilience policy (cockatiel)
export {
  buildProviderResiliencePolicy,
  DEFAULT_PROVIDER_RESILIENCE,
} from './resilience/provider-resilience';
export type { ProviderResilienceOptions } from './resilience/provider-resilience';

// Pool-wide breaker for the outbound RSS-fetch proxy pool. Deliberately NOT
// composed from provider-resilience — see that file's header for why only the
// breaker layer applies here, and why it must be a proportional one.
export {
  buildProxyEgressBreaker,
  isEgressFault,
  ProxyEgressUnavailableError,
  DEFAULT_PROXY_EGRESS_BREAKER,
} from './resilience/proxy-egress-breaker';
export type { ProxyEgressBreakerOptions } from './resilience/proxy-egress-breaker';

// Feed health: severity + quarantine policy for failed RSS fetches. Shared by
// the async fetch path and the mera-scripts feed-audit tooling.
export {
  classifyFeedFailure,
  decideFeedFailureAction,
  isChronicallyDead,
  backoffMinutes,
  PERMANENT_STATUSES,
  BLOCKED_STATUSES,
  DEFAULT_FEED_FAILURE_POLICY,
} from './feed-health/feed-failure-policy';
export type {
  FeedFailureSeverity,
  FeedFailureAction,
  FeedFailurePolicyConfig,
  FeedFailureDecision,
  FeedFetchHistory,
} from './feed-health/feed-failure-policy';

// Filters
export { HttpExceptionFilter } from './filters/http-exception.filter';

// Profile Serializer
export { CountryCodeMapper } from './profile-serializer';

// Retrieval: a followed story's names filter
export {
  buildHaystack,
  filterByMustMatch,
  groundNamesInText,
  normalizeMustMatch,
} from './retrieval/must-match';
export type {
  ArticleMatchText,
  MustMatchOutcome,
} from './retrieval/must-match';

// Followed-story names: port and prompt version
export {
  STORY_NAMES_GENERATOR,
  STORY_NAMES_PROMPT_VERSION,
  UnconfiguredStoryNamesGenerator,
} from './story-names/story-names.port';
export type {
  StoryNamesGenerator,
  StoryNamesOutcome,
} from './story-names/story-names.port';

// Retrieval: shared vector-search relevance floor
export { VECTOR_RETRIEVAL_MIN_SCORE } from './retrieval/retrieval-constants';

// Structured job logger
export { JobLogger } from './job-logger/job-logger';
export type {
  LogLevel,
  JobLoggerOptions,
  LogFields,
} from './job-logger/job-logger';

// Translation port + adapters (Gemini / fake) + adaptive tuning
export { TRANSLATION_PROVIDER } from './translation/translation-provider.port';
export type {
  TranslationProvider,
  TranslateInput,
  TranslateOutput,
  TranslationProviderTuning,
} from './translation/translation-provider.port';
export { GeminiTransport, type GeminiTokenFn } from './gemini/gemini-transport';
export { GeminiTranslationService } from './translation/gemini-translation.service';
export { FakeTranslationProvider } from './translation/fake-translation.provider';
export {
  deriveTranslationTuning,
  deriveTranslationTuningFromConfig,
} from './translation/translation-tuning';
export {
  buildTranslationPrompt,
  parseAlignedTranslations,
  parseLenientTranslations,
  lenientTranslationText,
  type TranslatedText,
} from './translation/translation-prompt';
export {
  resolveRoutedTranslationConfig,
  normaliseTranslationLang,
  DEFAULT_TRANSLATION_OPENROUTER_LANGS,
  type RoutedTranslationConfig,
} from './translation/routed-translation-config';
export {
  OpenRouterTranslationService,
  TranslationInfraError,
  type TranslationFallbackReason,
} from './translation/openrouter-translation.service';
export { RoutingTranslationProvider } from './translation/routing-translation.provider';
export type {
  TranslationTuning,
  TranslationTuningInputs,
} from './translation/translation-tuning';

// Embedding provider port + adapters (Jina API / fake).
export { EMBEDDING_PROVIDER } from './embedding-provider/embedding-provider.port';
export type {
  EmbeddingProvider,
  EmbeddingTask,
} from './embedding-provider/embedding-provider.port';
export { JinaEmbeddingService } from './embedding-provider/jina-embedding.service';
export { FakeEmbeddingProvider } from './embedding-provider/fake-embedding.provider';

// Article-enrichment port + adapters (Gemini / fake) — the single LLM pass
// behind the served-only `pre-process-articles` stage. Tagging (geo/entity/
// event) is its first enrichment; further enrichments extend this port.
export { ARTICLE_ENRICHMENT_PROVIDER } from './enrichment/article-enrichment-provider.port';
export type {
  ArticleEnrichmentProvider,
  EnrichmentInput,
  EnrichmentOutput,
  ArticleEnrichment,
  GeoTag,
} from './enrichment/article-enrichment-provider.port';
export {
  GeminiEnrichmentService,
  EVENT_TYPES,
} from './enrichment/gemini-enrichment.service';
export { FakeEnrichmentProvider } from './enrichment/fake-enrichment.provider';
export {
  SUPRANATIONAL_CODES,
  isSupranationalCode,
  supranationalName,
} from './enrichment/supranational-codes';
export type { SupranationalCode } from './enrichment/supranational-codes';
export {
  CONTENT_CATEGORIES,
  isValidContentCategory,
} from './enrichment/content-taxonomy';

// Embedding-input builder
export { buildArticleData } from './article-data/article-data';

// Language detector port (wraps the existing CLD3 service)
export { LANGUAGE_DETECTOR } from './language-detection/language-detector.port';
export type { LanguageDetector } from './language-detection/language-detector.port';

// Canonical article-URL handling. Shared so the http->https upgrade, the
// `article-fingerprint` ledger and every consumer of a stored article URL can
// never disagree about which URLs are the same article.
export {
  normalizeArticleUrl,
  articleUrlKey,
  isInsecureUrl,
  httpsVariant,
} from './url/normalize-article-url';

// Related-articles ordering. A COPY of mera-app/lib/feed-grouping — the two
// must move together; see the banner in related-sort/geo-language-priority.ts.
// Consumed by `relatedArticlesPage`, which orders the whole candidate set
// before slicing a page out of it.
export { orderRelatedArticles } from './related-sort/related-articles-sort';
export type {
  RelatedSortable,
  RelatedSortMode,
} from './related-sort/related-articles-sort';
export {
  normPublicationName,
  baseLang,
  normAlpha3,
  sourcePriorityTier,
  countryRank,
} from './related-sort/geo-language-priority';
export type {
  UserGeoLanguageContext,
  SourceTagged,
} from './related-sort/geo-language-priority';
