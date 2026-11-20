import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { GraphQLError } from 'graphql';
import {
  SEARCH_INDEX_STATE,
  VECTOR_NOT_READY,
  type SearchIndexState,
} from '@mera/shared/health/search-index-state';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import { createHash } from 'node:crypto';
import {
  NewsArticle,
  NewsArticleDocument,
} from '@mera/models/models/news-article.model';
import {
  ClusterArticleLink,
  ClusterArticleLinkDocument,
} from '@mera/models/models/cluster-article-link.model';
import {
  NewsCluster,
  NewsClusterDocument,
} from '@mera/models/models/news-cluster.model';
import {
  PublicationSource,
  PublicationSourceDocument,
} from '@mera/models/models/publication-source.model';
import {
  UserTopic,
  UserTopicDocument,
} from '@mera/models/models/user-topic.model';
import {
  TopicArticleLink,
  TopicArticleLinkDocument,
} from '@mera/models/models/topic-article-link.model';
import { orderRelatedArticles } from '@mera/shared';
import {
  isCalibratedEmbedding,
  vectorMinScore,
} from '@mera/shared/embedding-provider/embedding-config';
import type {
  RelatedSortable,
  RelatedSortMode,
  UserGeoLanguageContext,
} from '@mera/shared';
import { SERVABLE_URL_SECURITY_FILTER } from '@mera/shared/url/url-security';
import {
  filterByMustMatch,
  groundNamesInText,
  type ArticleMatchText,
} from '@mera/shared/retrieval/must-match';
import {
  PLACE_TERMS_PROMPT_VERSION,
  STORY_NAMES_GENERATOR,
  STORY_NAMES_PROMPT_VERSION,
  type StoryGatesOutcome,
  type StoryNamesGenerator,
  type StoryNamesOutcome,
} from '@mera/shared/story-names/story-names.port';
import { EMBEDDING_PROVIDER } from '../embedding-provider/embedding-provider.port';
import type { EmbeddingProvider } from '../embedding-provider/embedding-provider.port';
import { topicEmbedText } from '../embedding-provider/topic-embed-text';
import { ARTICLE_QUOTA } from '../quota/article-quota.port';
import type { ArticleQuotaPort } from '../quota/article-quota.port';
import {
  TopicPaginationInput,
  TopicArticleIdsResult,
  ArticleIdsForTopicsResponse,
  ArticleWithClusters,
  ArticlesForTopicsByIdsResponse,
  ArticleSummary,
} from './dto/articles-for-topics.dto';
import {
  PersonaQueryInput,
  PersonaQueryResult,
  PersonaTopicResult,
  PersonaMatchMeta,
  HeadlineScopeResult,
  HeadlineScope,
} from './dto/persona-query.dto';
import { RelatedArticlesPage } from './dto/related-articles.dto';
import {
  computeRelatedFacets,
  matchesRelatedFilters,
  toRelatedFilters,
} from './related-facets';
import { NewsArticleService } from '../news-article/news-article.service';
import { HEAVY_ARTICLE_FIELDS_EXCLUSION } from '../constants';
import {
  STORY_GATES_VERSION,
  isStoryGateKind,
  passesStoryGates,
  type StoryGate,
} from './story-gates';

const CACHE_TTL_MS = 30 * 60 * 1000;
// TTL for a topic that resolved to NOTHING (gated to nothing on the warm path, or a
// vector search with no hit on the cold path). Longer than CACHE_TTL_MS on purpose: a
// topic with no match cannot acquire one faster than the ingest pipeline runs (hourly,
// :00/:10/:20), so re-resolving it every 30 min buys no freshness and costs one Atlas
// `$vectorSearch` per topic per cycle. Measured 2026-09-17: 1,150 of 2,475 `user-topic`
// rows have no fresh `TopicArticleLink` at all — the linker writes none when a topic
// matches nothing — so they are permanently cold and pay this on every cache expiry.
// Applies ONLY to topic resolution. The `relkeys:` related-articles cache keeps
// CACHE_TTL_MS for a populated list (load-bearing for cursor coherence) and
// RELATED_EMPTY_CACHE_TTL_MS for a complete empty one.
const DEFAULT_EMPTY_CACHE_TTL_MS = 60 * 60 * 1000;
const CUTOFF_HOURS = 24;
// A followed story reaches back over all the coverage the corpus still holds
// (articles expire at 48h), so a follow a day after the last article is not empty.
const STRICT_CUTOFF_HOURS = 48;
const cutoffFor = (strict: boolean): Date =>
  new Date(
    Date.now() - (strict ? STRICT_CUTOFF_HOURS : CUTOFF_HOURS) * 60 * 60 * 1000,
  );
// Heap backstop on how many siblings one story may order at once. Not a product
// cap — the write side bounds cluster size nowhere, and the worst story measured
// held 179. A cluster past this is logged, never silently trimmed.
const MAX_RELATED_KEYS = 500;
// TTL for a related-keys list that is COMPLETE but EMPTY (every member TTL'd out or
// failed the url-security filter). Short on purpose: an empty entry is the one a
// reader notices, and a story's membership changes every clustering run.
const RELATED_EMPTY_CACHE_TTL_MS = 60 * 1000;

/**
 * A topic-resolution slower than this is logged in full at WARN.
 *
 * WARN, not INFO, on purpose: production often runs LOG_LEVEL=warn, so an INFO
 * diagnostic is written and then dropped — which is exactly why the client-side
 * 30s aborts on this query could not be sized from the server side. Logging only
 * the TAIL keeps the volume near zero while capturing every request that is
 * actually a problem. Tunable without a deploy via PERSONA_SLOW_LOG_MS.
 */
const DEFAULT_SLOW_RESOLVE_LOG_MS = 5_000;
// Bumped 0.76 → 0.78 (score-distribution audit, 2026-07-17): the world-weather /
// world-politics junk tail on the retrieval vectors lives at 0.745–0.78, while
// healthy topics separate cleanly at ~0.785; EU-AI-Act-class topics still keep
// ≥40 candidates above 0.78. 0.76 was nearly inert (top-100 ANN floors already
// sit at 0.745–0.754), so it trimmed almost nothing.
// The default lives in @mera/shared (VECTOR_RETRIEVAL_MIN_SCORE) so this
// site, news-cluster.service.ts, and the async data-retrieval search stay in
// lockstep; VECTOR_MIN_SCORE overrides it.
/**
 * Ceiling on `getRecentArticleCount(since)`. `news-article` is swept at 48h
 * (RETENTION_RULES), so no lookback beyond it can be answered truthfully — an
 * unclamped query would silently return the 48h number for a request about
 * last month.
 */
const MAX_COUNT_LOOKBACK_HOURS = 48;
const NUM_CANDIDATES = 200;
const VECTOR_SEARCH_LIMIT = 100;
// Phase-3 bound: the Atlas `$vectorSearch` fan-out over cold topics. Despite the
// name it replaced (`EMBEDDING_CONCURRENCY`), this bounds NO embedding — phase 2
// embeds through a SEQUENTIAL chunk loop bounded by `JINA_QUERY_BATCH`, and this
// constant had exactly one use: the phase-3 `mapConcurrent` below.
//
// It carried a "must NOT be raised" note justified by "mongot/Atlas CPU", i.e. the
// co-located-mongot topology where search work competes with the database for the
// primary's CPU. On a cluster with DEDICATED ATLAS SEARCH NODES, the search indexes
// report status from search-node hosts apart from the data replica set, and
// `$vectorSearch` executes there, so this knob spends
// SEARCH-NODE capacity and cannot contend with the primary. The old note no longer
// applies and has been removed rather than softened.
//
// It is still a real budget: the bound is PER REQUEST, so concurrent requests multiply
// load on those nodes, and search-node CPU is the same resource behind the hourly Atlas
// CPU alerts. Env-tunable (`VECTOR_SEARCH_CONCURRENCY`) because this is the knob an
// incident wants to turn without a deploy.
const DEFAULT_VECTOR_SEARCH_CONCURRENCY = 8;
// Phase-1 classify/warm bound: a Redis GET (cache hit) or a couple of small
// indexed Mongo reads (warm path) — cheap and safe to fan out much wider so a
// fully-cached ~54-topic persona call resolves in a few rounds, not ~27.
// Strict story-names generation (an LLM call) does ride this bound; the loose
// place anchor does not: it generates in the background.
const CLASSIFY_CONCURRENCY = 12;
const DEFAULT_JINA_QUERY_BATCH = 64;
// Ceiling on ONE cold-path Jina round trip. Per call, NOT per phase, and the
// distinction is the whole design: the chunk loop in `embedColdTopics` is
// sequential, so a single budget shared across it would let slow-but-succeeding
// chunks consume the allowance and blank the later ones outright — turning a
// merely LOADED provider into a half-empty feed. Per call, a loaded Jina simply
// answers slowly and every topic still resolves; the deadline fires only on a
// genuinely stalled call. The cost is that worst case scales with chunk count
// (MAX_TOPICS_PER_REQUEST 200 / JINA_QUERY_BATCH 64 = 4 chunks = 32s), which is
// the accepted price of never blanking a topic that would have resolved.
// Infra sets JINA_QUERY_TIMEOUT_MS on news-graphql; this default matches it so
// an unset var behaves identically.
const DEFAULT_JINA_QUERY_TIMEOUT_MS = 8_000;
// Exclude BOTH text-matching variants: the pipeline writes the unsuffixed field;
// `_internal_only` covers stray v3-drift docs. Multi-KB vectors must never
// hydrate on read paths (1 Gi heap).
const EXCLUDE_EMBEDDINGS =
  '-embedding_article_data_retrieval -embedding_article_data_text_matching -embedding_article_data_text_matching_internal_only';
// Minimum age of `UserTopic.lastRequestedAt` before a feed request rewrites it.
// `lastRequestedAt` is the retention clock for the anonymous topic cache (see
// the `UserTopic` rule in RETENTION_RULES), so it only has to be accurate to
// within a fraction of the 14-day TTL. The staleness guard means a topic is
// written at most ~4x/day NO MATTER how many users request it — i.e. there is
// no write amplification per feed sync, only a cheap indexed no-op match.
const TOUCH_THROTTLE_MS = 6 * 60 * 60 * 1000;

async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  const queue = [...items.entries()];
  async function worker() {
    let entry: [number, T] | undefined;
    while ((entry = queue.shift())) {
      const [i, item] = entry;
      results[i] = await fn(item);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

/**
 * Internal engine input. `TopicPaginationInput` is the GraphQL arg type of
 * `articleIdsForTopics`, so the strict flag deliberately does NOT live on it —
 * adding a field there would change that query's public contract too. Widening
 * it here keeps `strictMatch` on `PersonaTopicInput` alone; a plain
 * `TopicPaginationInput[]` is still assignable because the field is optional.
 */
type EngineTopicInput = TopicPaginationInput & { strictMatch?: boolean };

/**
 * A strict topic's names for this request. `names: []` means no filter (a
 * broad story, a `cat:` text, or no generator configured); `'failed'` means
 * generation ran and failed, so the topic answers `[]` this request, uncached,
 * and the next strict request tries again.
 */
type StoryNames = { names: string[]; generated: boolean } | 'failed';

/** A strict topic's gates for this request; same meanings as `StoryNames`. */
type StoryGates = { gates: StoryGate[]; generated: boolean } | 'failed';

/**
 * A loose topic's place anchor for this request: an article must name one of
 * `terms` or `regions`. `terms: []` means no filter. There is no failed state:
 * the anchor fails OPEN, because a failed or slow generation must never blank
 * a topic the way a wrong followed story may.
 */
type PlaceAnchor = {
  terms: string[];
  regions: string[];
  /** No stored anchor yet: generation runs in the background, this answer is unfiltered. */
  pending: boolean;
};

const NO_PLACE: PlaceAnchor = { terms: [], regions: [], pending: false };

/** Background place generations in flight per process; the rest wait for a later request. */
const PLACE_GENERATION_CONCURRENCY = 4;
/** An unfiltered answer served while the anchor is generated; short so the next request filters. */
const PLACE_PENDING_CACHE_TTL_MS = 60 * 1000;

/** Exact English country names (never a substring match: CountryCodeMapper reads "Jordan Peterson" as JOR). */
const COUNTRY_NAMES: Set<string> = (() => {
  const names = new Set(['usa', 'uk', 'uae']);
  const dn = new Intl.DisplayNames(['en'], { type: 'region' });
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (const a of A) {
    for (const b of A) {
      const n = dn.of(a + b);
      if (n && n !== a + b) names.add(n.toLowerCase());
    }
  }
  return names;
})();

/** The `UserTopic` fields phase 1 reads, in one query. */
type StoredTopicRow = {
  _id: Types.ObjectId;
  must_match?: string[];
  must_match_version?: number;
  place_terms?: string[];
  place_regions?: string[];
  place_terms_version?: number;
  story_gates?: { kind: string; text: string; vector: number[] }[];
  story_gates_version?: number;
};

/** The must-match haystack fields (coalesce, never pick title_en alone: it is almost never populated). */
const articleMatchText = (a: {
  title_en?: string | null;
  title_en_internal_only?: string | null;
  description_en?: string | null;
  description_en_internal_only?: string | null;
  title?: string | null;
}): ArticleMatchText => ({
  titleEn: a.title_en ?? a.title_en_internal_only,
  descriptionEn: a.description_en ?? a.description_en_internal_only,
  titleOriginal: a.title,
});

/**
 * A place's region joins the anchor only when its best `places` match is at
 * least this big: a small namesake is usually the wrong place ("Goa" matches
 * only a Philippine town of 21k, whose region is Bicol). Below it the anchor
 * is the place alone.
 */
const MIN_REGION_PLACE_POPULATION = 50_000;

/** GeoNames' first level in the UK is a country; never anchor on one. */
const COUNTRY_LEVEL_REGIONS = new Set([
  'england',
  'scotland',
  'wales',
  'northern ireland',
]);

/** The inline generation budget on the request path. */
const STORY_NAMES_TIMEOUT_MS = 3000;

/**
 * A topic's classification after phase 1. `cold` topics start with empty
 * `entries`, filled in phase 3 after the batched embed + vector search.
 */
interface Classification {
  input: EngineTopicInput;
  key: string;
  cold: boolean;
  /**
   * Strictness resolved ONCE, here, and read by the cache key, the warm gate
   * and the cold gate alike. Resolving it independently at each site is how a
   * cache key and the filter it guards drift apart, which would serve strict
   * results under the loose key.
   */
  strict: boolean;
  /**
   * Strict topics only, null otherwise. A promise started in phase 1 so the
   * inline generation overlaps the warm link reads or the cold embed.
   */
  names: Promise<StoryNames> | null;
  /** Strict topics only, null otherwise; started in phase 1 like `names`. */
  gates: Promise<StoryGates> | null;
  /** Loose topics only, null otherwise; started in phase 1 like `names`. */
  places: Promise<PlaceAnchor> | null;
  entries: CachedArticleEntry[];
}

/** The minimum an article must expose to be ordered by `orderRelatedArticles`.
 *  This — not the full ArticleSummary — is what gets cached per cluster: it is
 *  ~60 bytes a row against ~500, and it is context-free so every reader of the
 *  story shares one entry. `storyKey` stays local, so the shared related-sort
 *  copy (and the app's verbatim twin) does not change. */
type RelatedSortKey = RelatedSortable & { storyKey?: string | null };

/** One generation's candidate for a story's cluster: its raw id and the
 *  denormalized member count the clustering job wrote beside it. */
interface RelatedClusterCandidate {
  _id: Types.ObjectId;
  clusterSize?: number | null;
}

/**
 * Per-phase cost of one topic-resolution, in ms, plus the fan-out that explains
 * it. Sized to answer one question from a log line alone: when a persona query
 * exceeds the app's 30s abort, WHICH phase spent the time and how many topics
 * went down the cold path to cause it.
 */
interface ResolveTimings {
  topics: number;
  classifyMs: number;
  embedMs: number;
  vectorMs: number;
  totalMs: number;
  /** Topics that missed the classify cache and the warm path. */
  cold: number;
  /** Cold topics whose vector was already stored on UserTopic (no Jina call). */
  embedCached: number;
  /** Cold topics actually sent to the embedding provider. */
  embedded: number;
  /** Provider request count (cold texts chunked at JINA_QUERY_BATCH). */
  embedChunks: number;
  /** Slowest single $vectorSearch in this request. */
  slowestVectorMs: number;
  /** Cold topics whose vector search threw and were isolated to []. */
  vectorErrors: number;
  /** Cold texts the embedding provider never returned, isolated to []. */
  embedDropped: number;
}

interface CachedArticleEntry {
  _id: string;
  clusterIds: string[];
  title_en: string;
  title?: string;
  description_en?: string;
  article_url?: string;
  image_url?: string;
  country_code?: string;
  publication_name?: string;
  language_code?: string;
  pubDate: string;
  // Persona query: the cold-path $vectorSearch score for this article. Absent on
  // warm-path / older cached entries (they were never scored) — the persona
  // matchMeta exposes it when present, else 0.
  score?: number;
}

type PublicationSourceLean = {
  _id: Types.ObjectId;
  publication_name?: string;
  country_code?: string;
  detected_language_code?: string;
  feed_language_code?: string;
  // The publication source's category (surfaced on ArticleWithClusters).
  category?: string;
};

type ArticleLean = {
  _id: Types.ObjectId;
  // v3 canonical fields (populated by the v3 projector). Preferred over the
  // deprecated *_internal_only aliases below.
  title_en?: string;
  description_en?: string;
  original_language_code?: string;
  title_en_internal_only?: string;
  description_en_internal_only?: string;
  title?: string;
  description?: string;
  article_url?: string;
  image_url?: string;
  pubDate?: Date;
  createdAt?: Date;
  publicationSourceId: Types.ObjectId;
  // Hydration metadata (written by the tagging pipeline; all optional).
  geo_tags?: {
    city?: string;
    region?: string;
    countryCode: string;
    geonameId?: number;
  }[];
  entities?: string[];
  event_type?: string;
  // Enrichment v2 (jev P5a on NewsArticle; all optional).
  geo_scope?: string;
  content_categories?: string[];
  genre?: string;
  tone?: string;
  significance?: number;
  // The seed article's id (24-hex string), written once at ingest.
  story_key?: string | null;
  // Packed sign-bit vector sidecar (select: false on the model — only
  // populated when explicitly `.select('+vector_sidecar_packed')`ed, as
  // hydrateArticles does below). Buffer at rest; base64-encoded onto the DTO.
  // Typed loosely (not just Buffer) because a `.lean()` read can hand back
  // either a real Buffer or a bson Binary wrapper depending on driver
  // promotion settings — toBase64Sidecar() below normalizes both.
  vector_sidecar_packed?: Buffer | { buffer: ArrayBufferLike } | null;
};

/**
 * Normalize a Mongoose Buffer-schema field read via `.lean()` to base64.
 * `.lean()` bypasses Mongoose's document hydration, so depending on driver
 * settings the field can come back as either a real Node `Buffer` or a bson
 * `Binary` wrapper (which exposes the same bytes via `.buffer`) — this
 * handles both rather than assuming one.
 */
function toBase64Sidecar(
  raw: Buffer | { buffer: ArrayBufferLike } | null | undefined,
): string | undefined {
  if (!raw) return undefined;
  if (Buffer.isBuffer(raw)) return raw.toString('base64');
  if (raw.buffer)
    return Buffer.from(raw.buffer as ArrayBuffer).toString('base64');
  return undefined;
}

@Injectable()
export class ArticlesForTopicsService {
  private readonly logger = new Logger(ArticlesForTopicsService.name);
  private readonly jinaQueryBatch: number;
  private readonly jinaQueryTimeoutMs: number;
  // One WARN per process when strict topics are served without a generator.
  private storyNamesUnconfiguredWarned = false;
  private placeGenerationsInFlight = 0;
  // Threshold above which a topic-resolution is logged in full. Env-tunable so
  // the bar can be moved on a live service without a deploy.
  private readonly slowResolveLogMs: number;
  // Phase-3 `$vectorSearch` fan-out width. See DEFAULT_VECTOR_SEARCH_CONCURRENCY.
  private readonly vectorSearchConcurrency: number;
  // TTL for a resolved-to-nothing topic. See DEFAULT_EMPTY_CACHE_TTL_MS.
  private readonly emptyCacheTtlMs: number;
  // False off the tuned embedding model, where scores are not comparable.
  private readonly scoresCalibrated: boolean;
  private readonly minScore: number;

  constructor(
    @InjectModel(NewsArticle.name)
    private newsArticleModel: Model<NewsArticleDocument>,
    @InjectModel(ClusterArticleLink.name)
    private clusterArticleLinkModel: Model<ClusterArticleLinkDocument>,
    @InjectModel(NewsCluster.name)
    private newsClusterModel: Model<NewsClusterDocument>,
    @InjectModel(PublicationSource.name)
    private publicationSourceModel: Model<PublicationSourceDocument>,
    @InjectModel(UserTopic.name)
    private userTopicModel: Model<UserTopicDocument>,
    @InjectModel(TopicArticleLink.name)
    private topicArticleLinkModel: Model<TopicArticleLinkDocument>,
    @Inject(EMBEDDING_PROVIDER)
    private readonly embeddingProvider: EmbeddingProvider,
    @Inject(ARTICLE_QUOTA)
    private readonly articleQuota: ArticleQuotaPort,
    private readonly newsArticleService: NewsArticleService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly configService: ConfigService,
    @Inject(STORY_NAMES_GENERATOR)
    private readonly storyNames: StoryNamesGenerator,
    // Unbound in a host that does not track index states: cold topics run as before.
    @Optional()
    @Inject(SEARCH_INDEX_STATE)
    private readonly indexes?: SearchIndexState | null,
  ) {
    this.scoresCalibrated = isCalibratedEmbedding(this.configService);
    this.minScore = vectorMinScore(this.configService);
    this.jinaQueryBatch =
      Number(
        this.configService.get<string | number>(
          'JINA_QUERY_BATCH',
          DEFAULT_JINA_QUERY_BATCH,
        ),
      ) || DEFAULT_JINA_QUERY_BATCH;

    // `Number.isFinite(x) && x > 0` rather than the `|| DEFAULT` used just
    // above: Number('') is 0 and Number('-1') is -1, and `||` would accept the
    // negative, producing an AbortSignal that fires immediately and blanks
    // every cold topic on every request.
    const configuredTimeout = Number(
      this.configService.get<string | number>(
        'JINA_QUERY_TIMEOUT_MS',
        DEFAULT_JINA_QUERY_TIMEOUT_MS,
      ),
    );
    this.jinaQueryTimeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_JINA_QUERY_TIMEOUT_MS;

    this.slowResolveLogMs =
      Number(
        this.configService.get<string | number>(
          'PERSONA_SLOW_LOG_MS',
          DEFAULT_SLOW_RESOLVE_LOG_MS,
        ),
      ) || DEFAULT_SLOW_RESOLVE_LOG_MS;

    // Same `Number.isFinite(x) && x > 0` guard as the Jina timeout, for a
    // sharper reason: `mapConcurrent` spawns exactly `concurrency` workers, so a
    // 0 or negative value spawns none and the phase-3 `await Promise.all([])`
    // resolves instantly with EVERY cold topic left unresolved — a silently
    // empty feed, not an error.
    const configuredVectorConcurrency = Number(
      this.configService.get<string | number>(
        'VECTOR_SEARCH_CONCURRENCY',
        DEFAULT_VECTOR_SEARCH_CONCURRENCY,
      ),
    );
    this.vectorSearchConcurrency =
      Number.isFinite(configuredVectorConcurrency) &&
      configuredVectorConcurrency > 0
        ? Math.floor(configuredVectorConcurrency)
        : DEFAULT_VECTOR_SEARCH_CONCURRENCY;

    // Guarded the same way: a 0 or negative TTL makes every empty result a cache
    // MISS, restoring the per-request vector search this constant exists to avoid.
    const configuredEmptyTtl = Number(
      this.configService.get<string | number>(
        'PERSONA_EMPTY_CACHE_TTL_MS',
        DEFAULT_EMPTY_CACHE_TTL_MS,
      ),
    );
    this.emptyCacheTtlMs =
      Number.isFinite(configuredEmptyTtl) && configuredEmptyTtl > 0
        ? configuredEmptyTtl
        : DEFAULT_EMPTY_CACHE_TTL_MS;
  }

  /**
   * Cache a resolved-to-nothing answer, except for a followed story (strict).
   * Followed topics are few and the reader asked for exactly that story, so an
   * empty answer re-checks on the next sync instead of hiding fresh coverage,
   * or a since-deployed fix, for the whole empty TTL.
   */
  private async cacheEmpty(key: string, strict: boolean): Promise<void> {
    if (strict) return;
    await this.cacheManager.set(key, [], this.emptyCacheTtlMs);
  }

  /**
   * A strict topic's names for this request: the row's when they are at the
   * current prompt version, else generated inline within
   * `STORY_NAMES_TIMEOUT_MS`. Never rejects.
   */
  private async resolveStoryNames(
    topicText: string,
    row: StoredTopicRow | null,
  ): Promise<StoryNames> {
    if (
      row &&
      Array.isArray(row.must_match) &&
      (row.must_match_version ?? 0) >= STORY_NAMES_PROMPT_VERSION
    ) {
      return {
        names: groundNamesInText(row.must_match, topicText),
        generated: false,
      };
    }
    // Canonical rows never carry names, and the warm read excludes them, so a
    // `cat:` text would generate names it could never store.
    if (topicText.startsWith('cat:')) return { names: [], generated: false };

    let outcome: StoryNamesOutcome;
    try {
      outcome = await this.storyNames.generate(
        topicText,
        AbortSignal.timeout(STORY_NAMES_TIMEOUT_MS),
      );
    } catch {
      outcome = { status: 'failed', reason: 'threw' };
    }
    if (outcome.status === 'ok') {
      return {
        names: groundNamesInText(outcome.names, topicText),
        generated: true,
      };
    }
    if (outcome.status === 'unconfigured') {
      // Not fail closed: a missing env must never blank every followed story.
      if (!this.storyNamesUnconfiguredWarned) {
        this.storyNamesUnconfiguredWarned = true;
        this.logger.warn(
          'story-names: no generator configured; strict topics are served ' +
            'unfiltered until GEMINI env is set',
        );
      }
      return { names: [], generated: false };
    }
    this.logger.warn(
      `story-names: generation failed (${outcome.reason}); ` +
        'the strict topic answers [] this request',
    );
    return 'failed';
  }

  /**
   * Store generated names on the anonymous row. Conditional, so it never
   * touches a canonical row nor downgrades names from a newer prompt; no
   * upsert, because a first-ever cold topic's row exists only after phase 2.
   */
  private async persistStoryNames(
    topicText: string,
    names: string[],
  ): Promise<void> {
    try {
      await this.userTopicModel
        .updateOne(
          {
            news_topic_text: topicText,
            is_canonical: { $ne: true },
            must_match_version: { $not: { $gte: STORY_NAMES_PROMPT_VERSION } },
          },
          {
            $set: {
              must_match: names,
              must_match_version: STORY_NAMES_PROMPT_VERSION,
              must_match_at: new Date(),
            },
          },
        )
        .exec();
    } catch (err) {
      this.logger.warn(
        `story-names: could not store names (${(err as Error).message})`,
      );
    }
  }

  /**
   * A loose topic's place anchor: the row's at the current prompt version. With
   * none, serve unfiltered NOW (`pending`) and generate in the background, so a
   * cold herd after a deploy never puts an LLM call on the request path. Never
   * rejects.
   */
  private resolvePlaceAnchor(
    topicText: string,
    row: StoredTopicRow | null,
  ): PlaceAnchor {
    if (
      row &&
      Array.isArray(row.place_terms) &&
      (row.place_terms_version ?? 0) >= PLACE_TERMS_PROMPT_VERSION
    ) {
      const terms = groundNamesInText(row.place_terms, topicText);
      return {
        terms,
        regions: terms.length > 0 ? (row.place_regions ?? []) : [],
        pending: false,
      };
    }
    if (topicText.startsWith('cat:')) return NO_PLACE;
    if (this.placeGenerationsInFlight < PLACE_GENERATION_CONCURRENCY) {
      this.placeGenerationsInFlight++;
      void this.generateAndStorePlaceAnchor(topicText).finally(() => {
        this.placeGenerationsInFlight--;
      });
    }
    return { ...NO_PLACE, pending: true };
  }

  /** Generates, grounds and stores the anchor. Never rejects. */
  private async generateAndStorePlaceAnchor(topicText: string): Promise<void> {
    let outcome: StoryNamesOutcome;
    try {
      outcome = await this.storyNames.generatePlaceTerms(
        topicText,
        AbortSignal.timeout(STORY_NAMES_TIMEOUT_MS),
      );
    } catch {
      outcome = { status: 'failed', reason: 'threw' };
    }
    if (outcome.status !== 'ok') {
      if (outcome.status === 'failed') {
        this.logger.warn(
          `place-anchor: generation failed (${outcome.reason}); ` +
            'the topic stays unfiltered',
        );
      }
      return;
    }
    const terms = groundNamesInText(outcome.names, topicText).filter(
      (t) => !COUNTRY_NAMES.has(t.toLowerCase()),
    );
    await this.persistPlaceAnchor(topicText, {
      terms,
      regions: await this.placeRegions(terms),
      pending: false,
    });
  }

  /**
   * Each place's first-level region (state or province) from `places`, the
   * most populous match on `search_keys` or `normalized` (`normalized` is ASCII-folded; plus a
   * diacritic-folded key). Never the country: `places` has no country names. A failed read
   * keeps the places alone.
   */
  private async placeRegions(terms: string[]): Promise<string[]> {
    // shortcut: raw collection through the topic model's connection, so neither
    // app module registers `Place`; register it if this ever needs the schema.
    const places = this.userTopicModel.db.collection('places');
    const regions: string[] = [];
    for (const term of terms) {
      const key = term.toLowerCase();
      const folded = key.normalize('NFD').replace(/\p{M}/gu, '');
      const keys = Array.from(new Set([key, folded]));
      try {
        // `normalized` too: rows seeded before search_keys carry only it.
        const hit = await places.findOne(
          {
            $or: [
              { search_keys: { $in: keys } },
              { normalized: { $in: keys } },
            ],
          },
          {
            projection: { region: 1, population: 1, city: 1, alt_names: 1 },
            sort: { population: -1 },
          },
        );
        if (!hit || !(Number(hit.population) >= MIN_REGION_PLACE_POPULATION)) {
          continue;
        }
        const region = typeof hit.region === 'string' ? hit.region.trim() : '';
        // Aliases too ("München" -> "Munich"): coverage spells the place its own way.
        const aliases = [
          hit.city,
          ...(Array.isArray(hit.alt_names)
            ? (hit.alt_names as unknown[]).slice(0, 5)
            : []),
        ].filter(
          (a): a is string =>
            typeof a === 'string' && a.trim().length >= 4 && a.length <= 60,
        );
        for (const name of [
          ...(region && !COUNTRY_LEVEL_REGIONS.has(region.toLowerCase())
            ? [region]
            : []),
          ...aliases.map((a) => a.trim()),
        ]) {
          const known = [...terms, ...regions].map((t) => t.toLowerCase());
          if (!known.includes(name.toLowerCase())) regions.push(name);
        }
      } catch (err) {
        this.logger.warn(
          `place-anchor: places read failed (${(err as Error).message})`,
        );
      }
    }
    return regions;
  }

  /** Store a generated anchor. Same conditions as `persistStoryNames`. */
  private async persistPlaceAnchor(
    topicText: string,
    anchor: PlaceAnchor,
  ): Promise<void> {
    try {
      await this.userTopicModel
        .updateOne(
          {
            news_topic_text: topicText,
            is_canonical: { $ne: true },
            place_terms_version: { $not: { $gte: PLACE_TERMS_PROMPT_VERSION } },
          },
          {
            $set: {
              place_terms: anchor.terms,
              place_regions: anchor.regions,
              place_terms_version: PLACE_TERMS_PROMPT_VERSION,
            },
          },
        )
        .exec();
    } catch (err) {
      this.logger.warn(
        `place-anchor: could not store terms (${(err as Error).message})`,
      );
    }
  }

  /** Filters a loose topic by its anchor; no stored anchor means unfiltered. */
  private async applyPlaceAnchor<T>(
    seam: 'warm' | 'cold',
    topicText: string,
    items: T[],
    getText: (item: T) => ArticleMatchText,
    places: Promise<PlaceAnchor> | null,
  ): Promise<T[]> {
    if (!places) return items;
    const anchor = await places;
    if (anchor.terms.length === 0) return items;
    return this.applyStoryNames(
      seam,
      topicText,
      items,
      getText,
      [...anchor.terms, ...anchor.regions],
      'place-anchor',
    );
  }

  /** Keep only articles naming the story; no names means no filter. */
  private applyStoryNames<T>(
    seam: 'warm' | 'cold',
    topicText: string,
    items: T[],
    getText: (item: T) => ArticleMatchText,
    names: string[],
    kind: 'must-match' | 'place-anchor' = 'must-match',
  ): T[] {
    if (names.length === 0) return items;
    const { kept, removed } = filterByMustMatch(names, items, getText);
    if (removed > 0) {
      this.logger.log(
        `${kind} (${seam}): kept=${kept.length} removed=${removed}`,
      );
    }
    return kept;
  }

  /**
   * A strict topic's gates: the row's at the current version, else generated
   * inline (same timeout and outcomes as story names), grounded in the topic
   * text, limited to registered kinds and embedded. Never rejects.
   */
  private async resolveStoryGates(
    topicText: string,
    row: StoredTopicRow | null,
  ): Promise<StoryGates> {
    if (
      row &&
      Array.isArray(row.story_gates) &&
      (row.story_gates_version ?? 0) >= STORY_GATES_VERSION
    ) {
      return {
        gates: row.story_gates.filter(
          (g): g is StoryGate =>
            isStoryGateKind(g.kind) && (g.vector?.length ?? 0) > 0,
        ),
        generated: false,
      };
    }
    if (topicText.startsWith('cat:')) return { gates: [], generated: false };

    let outcome: StoryGatesOutcome;
    try {
      outcome = await this.storyNames.generateStoryGates(
        topicText,
        AbortSignal.timeout(STORY_NAMES_TIMEOUT_MS),
      );
    } catch {
      outcome = { status: 'failed', reason: 'threw' };
    }
    // No generator: served without gates, as with story names.
    if (outcome.status === 'unconfigured') {
      return { gates: [], generated: false };
    }
    if (outcome.status === 'failed') {
      this.logger.warn(
        `story-gates: generation failed (${outcome.reason}); ` +
          'the strict topic answers [] this request',
      );
      return 'failed';
    }

    const wanted = outcome.gates.filter(
      (g) =>
        isStoryGateKind(g.kind) &&
        groundNamesInText([g.text], topicText).length > 0,
    );
    if (wanted.length < outcome.gates.length) {
      this.logger.log(
        `story-gates: dropped ${outcome.gates.length - wanted.length} ` +
          'unregistered or ungrounded gates',
      );
    }
    if (wanted.length === 0) return { gates: [], generated: true };

    let vectors: number[][];
    try {
      vectors = await this.embeddingProvider.embed(
        wanted.map((g) => g.text),
        AbortSignal.timeout(this.jinaQueryTimeoutMs),
      );
    } catch (err) {
      this.logger.warn(
        `story-gates: embedding failed (${(err as Error).message}); ` +
          'the strict topic answers [] this request',
      );
      return 'failed';
    }
    return {
      gates: wanted.map((g, i) => ({
        kind: g.kind as StoryGate['kind'],
        text: g.text,
        vector: vectors[i],
      })),
      generated: true,
    };
  }

  /** Store generated gates. Same conditions as `persistStoryNames`. */
  private async persistStoryGates(
    topicText: string,
    gates: StoryGate[],
  ): Promise<void> {
    try {
      await this.userTopicModel
        .updateOne(
          {
            news_topic_text: topicText,
            is_canonical: { $ne: true },
            story_gates_version: { $not: { $gte: STORY_GATES_VERSION } },
          },
          {
            $set: {
              story_gates: gates,
              story_gates_version: STORY_GATES_VERSION,
            },
          },
        )
        .exec();
    } catch (err) {
      this.logger.warn(
        `story-gates: could not store gates (${(err as Error).message})`,
      );
    }
  }

  /**
   * Keeps the articles whose retrieval vector passes every gate. The vectors
   * are read here, by id, only for a topic that has gates; an article without
   * one fails closed.
   */
  private async applyStoryGates<T>(
    seam: 'warm' | 'cold',
    items: T[],
    idOf: (item: T) => Types.ObjectId,
    gates: StoryGate[],
  ): Promise<T[]> {
    if (gates.length === 0 || items.length === 0) return items;
    const rows = (await this.newsArticleModel
      .find(
        { _id: { $in: items.map(idOf) } },
        { _id: 1, embedding_article_data_retrieval: 1 },
      )
      .lean()
      .exec()) as unknown as Array<{
      _id: Types.ObjectId;
      embedding_article_data_retrieval?: number[];
    }>;
    const vectors = new Map(
      rows.map((r) => [r._id.toString(), r.embedding_article_data_retrieval]),
    );
    const kept = items.filter((i) =>
      passesStoryGates(gates, vectors.get(idOf(i).toString())),
    );
    if (kept.length < items.length) {
      this.logger.log(
        `story-gates (${seam}): kept=${kept.length} ` +
          `removed=${items.length - kept.length}`,
      );
    }
    return kept;
  }

  /**
   * Classify-cache key. The strict key carries the story-names prompt version,
   * so answers filtered by older names (or by nothing) are never served after
   * a bump, and its 48h window, since it answers more than the loose key. The
   * loose key carries the place-terms prompt version for the same reason.
   */
  private buildCacheKey(topicText: string, strict = false): string {
    const hash = createHash('sha256').update(topicText).digest('hex');
    return strict
      ? `aft:strict:v${STORY_NAMES_PROMPT_VERSION}:g${STORY_GATES_VERSION}:w48:${hash}`
      : `aft:pl${PLACE_TERMS_PROMPT_VERSION}:${hash}`;
  }

  /** TTL for a populated answer: short while the place anchor is still pending. */
  private async populatedTtl(
    places: Promise<PlaceAnchor> | null,
  ): Promise<number> {
    return places && (await places).pending
      ? PLACE_PENDING_CACHE_TTL_MS
      : CACHE_TTL_MS;
  }

  async getArticleIdsForTopics(
    topics: TopicPaginationInput[],
    limitPerTopic: number,
  ): Promise<ArticleIdsForTopicsResponse> {
    // Candidate listing only — this is stateless and returns every matching ID
    // in the 24h window on each call. The daily-delivery cap is NOT charged
    // here (the app re-requests the same IDs every sync); it's charged at the
    // delivery point, getArticlesForTopicsByIds, against only the new-to-device
    // IDs the app actually hydrates.
    //
    // Two-phase design so a large cold request batches its Jina calls:
    //   Phase 1 (classify): resolve cache + warm-path hits concurrently; the
    //     rest are cold.
    //   Phase 2 (batch embed): bulk-fetch existing UserTopic vectors in one
    //     query; embed only the remainder, chunked at JINA_QUERY_BATCH.
    //   Phase 3 (vector search): run $vectorSearch + caching per cold topic,
    //     bounded to VECTOR_SEARCH_CONCURRENCY (Atlas search nodes only).
    // Results are assembled in the ORIGINAL topic order; per-topic errors are
    // isolated so one bad topic never fails the whole query.

    // Resolve every topic's entries through the shared 3-phase engine, then
    // assemble in original topic order, mixing cached/warm/cold results.
    const timings = this.newTimings();
    const startedAt = Date.now();
    const classifications = await this.resolveTopicEntries(topics, timings);
    const results = classifications.map((c) =>
      this.paginate(c.input, c.entries, limitPerTopic),
    );
    timings.totalMs = Date.now() - startedAt;
    this.logSlowResolve('articleIdsForTopics', timings, {
      limitPerTopic,
    });

    return { results };
  }

  /** A zeroed accumulator, so callers never deal with partial objects. */
  private newTimings(): ResolveTimings {
    return {
      topics: 0,
      classifyMs: 0,
      embedMs: 0,
      vectorMs: 0,
      totalMs: 0,
      cold: 0,
      embedCached: 0,
      embedded: 0,
      embedChunks: 0,
      slowestVectorMs: 0,
      vectorErrors: 0,
      embedDropped: 0,
    };
  }

  /**
   * Emit one structured line per SLOW topic-resolution.
   *
   * Deliberately WARN and deliberately threshold-gated. The app aborts this
   * query at 30s (REQUEST_ABORT_MS) and a platform may let the server keep
   * working much longer, so the failure the user sees leaves no trace: the
   * cold-path diagnostic is INFO, and production often runs above INFO.
   * Logging the tail only means normal traffic stays silent while every request
   * near the abort ceiling is fully explained by a single line.
   *
   * Never throws — instrumentation must not be able to fail the query it
   * measures.
   */
  private logSlowResolve(
    operation: string,
    t: ResolveTimings,
    extra: Record<string, unknown> = {},
  ): void {
    try {
      if (t.totalMs < this.slowResolveLogMs) return;
      this.logger.warn({
        msg: 'persona-resolve-slow',
        operation,
        totalMs: t.totalMs,
        classifyMs: t.classifyMs,
        embedMs: t.embedMs,
        vectorMs: t.vectorMs,
        slowestVectorMs: t.slowestVectorMs,
        topics: t.topics,
        cold: t.cold,
        // warm = served from the classify cache or TopicArticleLink, i.e. the
        // topics that cost nothing. A request that is slow with cold=0 is a
        // different bug from one that is slow with cold=40.
        warm: t.topics - t.cold,
        embedCached: t.embedCached,
        embedded: t.embedded,
        embedChunks: t.embedChunks,
        vectorErrors: t.vectorErrors,
        // The client gives up here; anything at or beyond it is a feed the user
        // never saw.
        clientAbortMs: 30_000,
        ...extra,
      });
    } catch {
      // Instrumentation is never worth an exception.
    }
  }

  /**
   * Shared per-topic resolution engine (extracted so both `articleIdsForTopics`
   * and `articleIdsForPersona` reuse identical cache→warm→cold internals). Runs
   * phases 1–3 and returns the classifications with `entries` populated (in the
   * ORIGINAL topic order); per-topic errors are isolated. Pagination/shaping is
   * the caller's job.
   */
  private async resolveTopicEntries(
    topics: EngineTopicInput[],
    timings?: ResolveTimings,
  ): Promise<Classification[]> {
    const t0 = Date.now();

    // Phase 1 — classify (cache/warm reads only, so use the wider bound).
    const classifications = await mapConcurrent(
      topics,
      (input) => this.classifyTopic(input),
      CLASSIFY_CONCURRENCY,
    );
    const t1 = Date.now();

    // A cold topic needs the vector index. Not ready, it would answer [] and
    // read as "no news", so say so before spending an embedding call.
    if (this.indexes && classifications.some((c) => c.cold)) {
      const state = await this.indexes.vector();
      if (VECTOR_NOT_READY.includes(state)) {
        throw new GraphQLError(
          `Topic search is not ready: the vector search index is ${state}.`,
          { extensions: { code: 'INDEX_NOT_READY', state } },
        );
      }
    }

    // Phase 2 — batch-embed cold topics.
    const coldEmbeddings = await this.embedColdTopics(classifications, timings);
    const t2 = Date.now();

    // Phase 3 — vector-search each cold topic (Mongo-bounded concurrency).
    const coldClassifications = classifications.filter((c) => c.cold);
    let slowestVectorMs = 0;
    let vectorErrors = 0;
    await mapConcurrent(
      coldClassifications,
      async (c) => {
        const tv = Date.now();
        try {
          const embedding = coldEmbeddings.get(c.input.topicText);
          const names = c.names ? await c.names : null;
          const gates = c.gates ? await c.gates : null;
          if (names === 'failed' || gates === 'failed') {
            c.entries = [];
          } else {
            // Phase 2 has upserted the row by now, so a first-ever topic's
            // generated names and gates have somewhere to land.
            if (names?.generated) {
              await this.persistStoryNames(c.input.topicText, names.names);
            }
            if (gates?.generated) {
              await this.persistStoryGates(c.input.topicText, gates.gates);
            }
            c.entries = embedding
              ? await this.runColdVectorSearch(
                  c.input.topicText,
                  c.key,
                  embedding,
                  c.strict,
                  names?.names ?? [],
                  c.places,
                  gates?.gates ?? [],
                )
              : [];
          }
        } catch (err) {
          // Per-topic isolation: a single failed topic must not fail the query.
          vectorErrors += 1;
          this.logger.error(
            `articleIdsForTopics: cold topic failed: ${(err as Error).message}`,
          );
          c.entries = [];
        } finally {
          // Measured per topic, not just in aggregate: the question "is one
          // topic pathological or are they all ~1s and merely serialized"
          // decides whether the fix is a concurrency bump or an index problem,
          // and the aggregate cannot separate those two. Compare against
          // `vectorMs`: serialized work shows slowestVectorMs << vectorMs.
          const dt = Date.now() - tv;
          if (dt > slowestVectorMs) slowestVectorMs = dt;
        }
      },
      this.vectorSearchConcurrency,
    );

    if (timings) {
      timings.topics = topics.length;
      timings.classifyMs = t1 - t0;
      timings.embedMs = t2 - t1;
      timings.vectorMs = Date.now() - t2;
      timings.cold = coldClassifications.length;
      timings.slowestVectorMs = slowestVectorMs;
      timings.vectorErrors = vectorErrors;
    }

    // Refresh the retention clock for EVERY topic text in this request —
    // regardless of whether it resolved from the Redis cache, the warm path or
    // the cold path. Covering cache hits is deliberate: the classify cache has
    // a short TTL, so keying retention off warm/cold traffic alone would make a
    // topic's survival depend on cache behaviour. Fire-and-forget.
    this.touchTopics(topics.map((t) => t.topicText));

    return classifications;
  }

  /**
   * Refresh `UserTopic.lastRequestedAt` for the given topic texts — the age
   * signal the retention sweep uses to expire the anonymous topic cache.
   *
   * Deliberately NOT awaited: the response must not wait on this write, and a
   * failure must never fail the query (hence the terminal `.catch`). The `$or`
   * staleness guard bounds writes to ~1 per topic per TOUCH_THROTTLE_MS across
   * ALL users, and also covers rows written before the field existed
   * (`$exists: false`).
   *
   * Nothing about WHICH client made the request is recorded — the cache stays
   * anonymous.
   */
  private touchTopics(topicTexts: string[]): void {
    const texts = Array.from(new Set(topicTexts));
    if (texts.length === 0) return;

    const now = Date.now();
    void this.userTopicModel
      .updateMany(
        {
          news_topic_text: { $in: texts },
          $or: [
            { lastRequestedAt: { $lt: new Date(now - TOUCH_THROTTLE_MS) } },
            { lastRequestedAt: { $exists: false } },
          ],
        },
        { $set: { lastRequestedAt: new Date(now) } },
      )
      .catch((err: unknown) => {
        this.logger.warn(
          `lastRequestedAt touch failed (non-fatal): ${(err as Error).message}`,
        );
      });
  }

  /**
   * Privacy-lean persona query. Stateless, quota-FREE (charging stays at
   * `getArticlesForTopicsByIds`, the delivery point). Reuses the same 3-phase
   * engine as `articleIdsForTopics` for topics, and the NewsArticleService
   * top-headlines aggregation for the optional headline scopes.
   */
  async getArticleIdsForPersona(
    query: PersonaQueryInput,
  ): Promise<PersonaQueryResult> {
    const limitPerTopic = query.limitPerTopic ?? 20;

    // --- Topic results (reuse the shared engine) ---
    const engineInputs: EngineTopicInput[] = query.topics.map((t) => ({
      topicText: t.text,
      afterCursor: t.afterCursor,
      // Request-scoped only. Nothing downstream writes it: the UserTopic upsert
      // in embedColdTopics sets news_topic_text / news_topic_embed /
      // lastRequestedAt and nothing else, so the shared cache stays anonymous.
      strictMatch: t.strictMatch === true,
    }));
    const personaTimings = this.newTimings();
    const personaStartedAt = Date.now();
    const classifications = await this.resolveTopicEntries(
      engineInputs,
      personaTimings,
    );

    // Paginate per-topic (per-topic `limit` overrides limitPerTopic).
    const pages = classifications.map((c, i) => {
      const perTopicLimit = query.topics[i].limit ?? limitPerTopic;
      const page = this.paginateEntries(
        c.entries,
        c.input.afterCursor,
        perTopicLimit,
      );
      return { topicText: query.topics[i].text, ...page };
    });

    // Resolve each returned article's stable id = the id of its largest-
    // clusterSize linked cluster (null when singleton/unclustered). One lean
    // query over all clusters referenced by the paginated topic articles.
    const allTopicClusterIds = pages.flatMap((p) =>
      p.entries.flatMap((e) =>
        e.clusterIds.map((cid) => new Types.ObjectId(cid)),
      ),
    );
    const clusterMeta = await this.fetchClusterMeta(allTopicClusterIds);

    let topicResults: PersonaTopicResult[] = pages.map((p) => {
      const matchMeta: PersonaMatchMeta[] = p.entries.map((e) => ({
        articleId: e._id,
        // `?? null`, NEVER `?? 0`. Warm-path entries are served from the
        // TopicArticleLink cache and were never ANN-scored, so `score` is
        // absent for them. `0` is not a neutral placeholder: the client
        // multiplies positive topic weights by smoothstep(v, 0.78, 0.90)
        // whenever v is non-null, and smoothstep(0, …) === 0 — which zeroed the
        // topic weight of every warm-path article. See PersonaMatchMeta.
        // Off the tuned Jina model the client's score curve would mis-weight
        // topics, so no score is sent.
        vectorScore: this.scoresCalibrated ? (e.score ?? null) : null,
        textScore: null, // ALWAYS null in v1.
        stableClusterId: this.largestClusterStableId(e.clusterIds, clusterMeta),
      }));
      return {
        topicText: p.topicText,
        articleIds: p.entries.map((e) => e._id),
        matchMeta,
        nextCursor: p.nextCursor ?? null,
        hasNextPage: p.hasNextPage,
      };
    });

    // Optional hard cap on total ids across topicResults — truncate the
    // lowest-priority (last) topics first.
    if (query.maxArticles != null && query.maxArticles >= 0) {
      topicResults = this.applyMaxArticles(topicResults, query.maxArticles);
    }

    // --- Headline results (optional) ---
    const headlineResults = query.topHeadlines
      ? await this.resolveHeadlineScopes(
          query.topHeadlines.scopes,
          query.topHeadlines.limitPerScope ?? 10,
        )
      : [];

    // Measured to the END of the resolver, not just to the end of topic
    // resolution: headline scopes and the cluster-meta join are inside the same
    // request the client is timing, so a breakdown that stopped at phase 3 could
    // report "fast" for a request the user saw abort.
    personaTimings.totalMs = Date.now() - personaStartedAt;
    this.logSlowResolve('articleIdsForPersona', personaTimings, {
      headlineScopes: query.topHeadlines?.scopes.length ?? 0,
      maxArticles: query.maxArticles ?? null,
      // The two phases outside resolveTopicEntries, so they cannot hide.
      postResolveMs:
        personaTimings.totalMs -
        (personaTimings.classifyMs +
          personaTimings.embedMs +
          personaTimings.vectorMs),
    });

    return { topicResults, headlineResults };
  }

  /**
   * Truncate topicResults so the total article-id count across all topics does
   * not exceed `maxArticles`. Earlier topics keep priority; the last topics are
   * trimmed (and dropped entirely once the budget is exhausted). matchMeta stays
   * aligned with articleIds. nextCursor/hasNextPage are recomputed for a topic
   * that got clipped mid-page.
   */
  private applyMaxArticles(
    topicResults: PersonaTopicResult[],
    maxArticles: number,
  ): PersonaTopicResult[] {
    let remaining = maxArticles;
    return topicResults.map((t) => {
      if (remaining >= t.articleIds.length) {
        remaining -= t.articleIds.length;
        return t;
      }
      const keep = Math.max(0, remaining);
      remaining = 0;
      const articleIds = t.articleIds.slice(0, keep);
      const matchMeta = t.matchMeta.slice(0, keep);
      const clipped = keep < t.articleIds.length;
      return {
        ...t,
        articleIds,
        matchMeta,
        // A mid-page clip means there is more to fetch; the new cursor is the
        // last kept id (empty page keeps the topic's original cursor state off).
        nextCursor:
          articleIds.length > 0
            ? articleIds[articleIds.length - 1]
            : t.nextCursor,
        hasNextPage: clipped ? true : t.hasNextPage,
      };
    });
  }

  /**
   * Build the per-scope top-headline results. Dedup is CLUSTER-level and spans
   * scopes: a story is emitted by the FIRST scope (request order) that carries
   * it and skipped everywhere after, keyed on stableClusterId (falling back to
   * the largest clusterId, then the article id so unclustered articles are
   * never merged).
   *
   * Request order therefore decides which scope owns a story the reader's
   * country AND the world both cover. The client sends country scopes first and
   * GLOBAL last (`buildRetrievalProfile`), so a big domestic story lands in the
   * reader's own country scope and GLOBAL carries what is genuinely
   * international — which is the association the Dashboard sections want.
   *
   * Depth is per scope (`HeadlineScopeInput.limit`), falling back to the
   * query-level `limitPerScope`. Scopes are capped at 6, and every depth — both
   * forms — at 25 (enforced at the resolver, re-clamped here).
   */
  private async resolveHeadlineScopes(
    scopes: {
      scope: HeadlineScope;
      countryCode?: string | null;
      limit?: number | null;
    }[],
    limitPerScope: number,
  ): Promise<HeadlineScopeResult[]> {
    const clampLimit = (n: number): number => Math.min(Math.max(n, 0), 25);
    const defaultLimit = clampLimit(limitPerScope);
    /** Per-scope depth: the scope's own `limit` when given, else the
     *  query-level default. Clamped identically either way. */
    const limitFor = (s: { limit?: number | null }): number =>
      s.limit != null ? clampLimit(s.limit) : defaultLimit;

    // Fetch every scope's candidate pool in parallel (each is an independent,
    // now-cached top-headlines read). The cross-scope `emitted` dedup below is
    // request-order-dependent, so it stays a serial pass over the pre-fetched
    // pools — preserving the exact scope association + ordering as before.
    const scopeCandidates = await Promise.all(
      scopes.map(async (s) => {
        const countryCode =
          s.scope === HeadlineScope.GLOBAL ? null : s.countryCode;
        // Pool is sized from THIS scope's depth so a deep scope still has
        // enough candidates left after per-scope + cross-scope dedup.
        const poolSize = Math.min(Math.max(limitFor(s) * 5, 25), 200);
        try {
          const candidates =
            await this.newsArticleService.topHeadlineCandidates(
              countryCode ?? null,
              poolSize,
            );
          return {
            scope: s.scope,
            countryCode,
            limit: limitFor(s),
            candidates,
          };
        } catch (err) {
          this.logger.error(
            `articleIdsForPersona: headline scope failed (${s.scope}/${
              countryCode ?? 'GLOBAL'
            }): ${(err as Error).message}`,
          );
          return {
            scope: s.scope,
            countryCode,
            limit: limitFor(s),
            candidates: [] as Awaited<
              ReturnType<NewsArticleService['topHeadlineCandidates']>
            >,
          };
        }
      }),
    );

    const emitted = new Set<string>();
    // Cross-scope dedup is CLUSTER-level, not article-level. Each scope's
    // edition picks its own representative article for a story, so the same
    // cluster can surface as two DIFFERENT article ids in two scopes — an
    // article-id set alone lets one story occupy two scopes (and, on the
    // client, two Dashboard sections). Keying on the cluster collapses it to
    // the first scope in request order.
    const emittedClusterKeys = new Set<string>();
    const out: HeadlineScopeResult[] = [];

    for (const { scope, countryCode, limit, candidates } of scopeCandidates) {
      const articleIds: string[] = [];
      const clusterSizes: number[] = [];
      const stableClusterIds: (string | null)[] = [];

      for (const c of candidates) {
        if (articleIds.length >= limit) break;
        if (emitted.has(c.articleId)) continue; // cross-scope dedup

        // Cluster dedup key: stable id, else largest clusterId, else the
        // article itself (unclustered articles are each kept, so they are
        // never merged with one another).
        const clusterKey = c.stableClusterId
          ? `s:${c.stableClusterId}`
          : c.largestClusterId
            ? `c:${c.largestClusterId}`
            : `a:${c.articleId}`;
        if (emittedClusterKeys.has(clusterKey)) continue;
        emittedClusterKeys.add(clusterKey);

        articleIds.push(c.articleId);
        clusterSizes.push(c.maxClusterSize);
        stableClusterIds.push(c.stableClusterId);
        emitted.add(c.articleId);
      }

      out.push({
        scope,
        countryCode: countryCode ?? null,
        articleIds,
        clusterSizes,
        stableClusterIds,
      });
    }

    return out;
  }

  /** The stableClusterId of the article's largest-clusterSize linked cluster. */
  private largestClusterStableId(
    clusterIds: string[],
    clusterMeta: Map<
      string,
      { clusterSize: number; stableClusterId: string | null }
    >,
  ): string | null {
    let best: { clusterSize: number; stableClusterId: string | null } | null =
      null;
    for (const cid of clusterIds) {
      const meta = clusterMeta.get(cid);
      if (!meta) continue;
      if (best === null || meta.clusterSize > best.clusterSize) best = meta;
    }
    return best?.stableClusterId ?? null;
  }

  /**
   * Phase 1 for a single topic: resolve a cache hit or a warm-path hit
   * (UserTopic + fresh TopicArticleLink). If neither resolves, the topic is
   * marked cold (to be embedded + vector-searched in phases 2/3).
   */
  private async classifyTopic(
    input: EngineTopicInput,
  ): Promise<Classification> {
    const strict = input.strictMatch === true;
    const key = this.buildCacheKey(input.topicText, strict);

    const cached = await this.cacheManager.get<CachedArticleEntry[]>(key);
    // A cached empty array is a hit, except for a followed story (strict): its
    // empties are never written, and one left from an older deploy must not
    // hide the story's coverage for the rest of its TTL.
    if (cached && !(strict && cached.length === 0)) {
      return {
        input,
        key,
        cold: false,
        strict,
        names: null,
        gates: null,
        places: null,
        entries: cached,
      };
    }

    const row = (await this.userTopicModel
      .findOne({
        news_topic_text: input.topicText,
        is_canonical: { $ne: true },
      })
      .select(
        '_id must_match must_match_version place_terms place_regions place_terms_version story_gates story_gates_version',
      )
      .lean()
      .exec()) as StoredTopicRow | null;
    const names = strict ? this.resolveStoryNames(input.topicText, row) : null;
    const gates = strict ? this.resolveStoryGates(input.topicText, row) : null;
    const places = strict
      ? null
      : Promise.resolve(this.resolvePlaceAnchor(input.topicText, row));

    const warm = row
      ? await this.tryWarmPath(
          row._id,
          input.topicText,
          key,
          strict,
          names,
          gates,
          places,
        )
      : null;
    if (warm !== null) {
      return {
        input,
        key,
        cold: false,
        strict,
        names,
        gates,
        places,
        entries: warm,
      };
    }

    return {
      input,
      key,
      cold: true,
      strict,
      names,
      gates,
      places,
      entries: [],
    };
  }

  /**
   * Warm path: if the topic already exists in UserTopic and has TopicArticleLink
   * records pointing to articles within the 24h window, use those pre-computed
   * links instead of running vector search. Returns the built entries (and
   * caches them) on a hit, or `null` when the topic must fall through to the
   * cold path (no topic, no links, or all links stale).
   */
  private async tryWarmPath(
    topicId: Types.ObjectId,
    topicText: string,
    key: string,
    strict: boolean,
    names: Promise<StoryNames> | null,
    gates: Promise<StoryGates> | null,
    places: Promise<PlaceAnchor> | null,
  ): Promise<CachedArticleEntry[] | null> {
    const cutoffDate = cutoffFor(strict);

    // `confidence` is the article-level $vectorSearch score the async linker
    // recorded when it wrote the link — the same quantity the cold path calls
    // `score`, on the same embedding space. Selected so the page can be ordered
    // by match quality; deliberately NOT surfaced (see the entry build below).
    const topicLinks = (await this.topicArticleLinkModel
      .find({ topicId })
      .select('articleId confidence')
      .lean()
      .exec()) as Array<{ articleId: Types.ObjectId; confidence?: number }>;

    if (topicLinks.length === 0) return null;

    const confidenceByArticle = new Map<string, number>();
    for (const link of topicLinks) {
      confidenceByArticle.set(link.articleId.toString(), link.confidence ?? 0);
    }

    const linkedArticleIds = topicLinks.map((l) => l.articleId);
    const allLinkedArticles = (await this.newsArticleModel
      .find({
        _id: { $in: linkedArticleIds },
        createdAt: { $gte: cutoffDate },
        // Warm path: TopicArticleLink rows were written before the article's URL
        // was necessarily classified, so the exclusion has to be applied on read.
        ...SERVABLE_URL_SECURITY_FILTER,
      })
      .select(EXCLUDE_EMBEDDINGS)
      .lean()
      .exec()) as unknown as ArticleLean[];

    // Cold fallthrough is decided on the UNFILTERED set: "no links" and "every
    // link stale" still mean the topic has no warm answer.
    if (allLinkedArticles.length === 0) return null;

    let linkedArticles = allLinkedArticles;
    if (names) {
      const resolved = await names;
      // Fail closed for this request only: nothing is cached.
      if (resolved === 'failed') return [];
      if (resolved.generated) {
        await this.persistStoryNames(topicText, resolved.names);
      }
      linkedArticles = this.applyStoryNames(
        'warm',
        topicText,
        allLinkedArticles,
        articleMatchText,
        resolved.names,
      );
    }
    if (gates) {
      const resolved = await gates;
      if (resolved === 'failed') return [];
      if (resolved.generated) {
        await this.persistStoryGates(topicText, resolved.gates);
      }
      linkedArticles = await this.applyStoryGates(
        'warm',
        linkedArticles,
        (a) => a._id,
        resolved.gates,
      );
    }
    linkedArticles = await this.applyPlaceAnchor(
      'warm',
      topicText,
      linkedArticles,
      articleMatchText,
      places,
    );

    // Filtered to nothing is a real answer, not a cache miss: falling through
    // to the cold path would embed and search only to filter a superset of the
    // same articles by the same names.
    if (linkedArticles.length === 0) {
      await this.cacheEmpty(key, strict);
      return [];
    }

    // Best match first. The previous order was the `$in` fetch's, i.e. _id
    // ascending, so `limitPerTopic` took the OLDEST links rather than the
    // closest ones. `_id` breaks ties because `paginateEntries` resolves
    // `afterCursor` by index: without a total order, a cache expiry mid-
    // pagination can skip or repeat articles.
    linkedArticles.sort((a, b) => {
      const aId = a._id.toString();
      const bId = b._id.toString();
      const byConfidence =
        (confidenceByArticle.get(bId) ?? 0) -
        (confidenceByArticle.get(aId) ?? 0);
      return byConfidence !== 0 ? byConfidence : aId.localeCompare(bId);
    });

    const articleObjectIds = linkedArticles.map((a) => a._id);
    const [clusterLinks, pubSources] = await Promise.all([
      this.clusterArticleLinkModel
        .find({ articleId: { $in: articleObjectIds } })
        .select('articleId clusterId')
        .lean()
        .exec() as Promise<
        Array<{ articleId: Types.ObjectId; clusterId: Types.ObjectId }>
      >,
      this.fetchPublicationSourcesByIds(
        linkedArticles.map((a) => a.publicationSourceId),
      ),
    ]);

    const clustersByArticle = buildClusterMap(clusterLinks);
    const pubById = new Map(pubSources.map((p) => [p._id.toString(), p]));

    const entries: CachedArticleEntry[] = linkedArticles.map((a) => {
      const artId = a._id.toString();
      const pub = pubById.get(a.publicationSourceId.toString());
      return {
        _id: artId,
        clusterIds: clustersByArticle.get(artId) ?? [],
        title_en: a.title_en ?? a.title_en_internal_only ?? a.title ?? '',
        title: a.title ?? undefined,
        description_en:
          a.description_en ?? a.description_en_internal_only ?? a.description,
        article_url: a.article_url,
        image_url: a.image_url,
        country_code: pub?.country_code,
        publication_name: pub?.publication_name,
        language_code:
          a.original_language_code ??
          pub?.detected_language_code ??
          pub?.feed_language_code,
        pubDate: (a.pubDate ?? a.createdAt ?? new Date()).toISOString(),
        // `score` is deliberately NOT set from the link's `confidence`, even
        // though it is now in hand and the two are the same quantity. `score`
        // feeds `matchMeta.vectorScore`, and the client multiplies every
        // positive topic weight by smoothstep(v, 0.78, 0.90) whenever that
        // value is non-null. Warm rows are null today, so the discount is inert
        // on them; populating it would silently start discounting the entire
        // warm feed. It is a real latent bug and it gets its own change with
        // its own measurement — do not "complete" this line.
      };
    });

    await this.cacheManager.set(key, entries, await this.populatedTtl(places));
    return entries;
  }

  /**
   * Phase 2: resolve a query vector for every cold topic. Existing
   * `UserTopic.news_topic_embed` vectors are bulk-fetched in ONE `$in` query;
   * only the topics still lacking a vector are sent to the `EmbeddingProvider`
   * (Jina API `retrieval.query`), chunked at `JINA_QUERY_BATCH` so a 133-topic
   * cold request makes a handful of batched calls instead of ~133 single ones.
   * New vectors are bulk-upserted back to UserTopic (same fields/semantics as
   * the previous per-topic upsert). Returns a topicText → vector map.
   */
  private async embedColdTopics(
    classifications: Classification[],
    timings?: ResolveTimings,
  ): Promise<Map<string, number[]>> {
    const embeddings = new Map<string, number[]>();

    const coldTexts = Array.from(
      new Set(
        classifications.filter((c) => c.cold).map((c) => c.input.topicText),
      ),
    );
    if (coldTexts.length === 0) return embeddings;

    // Bulk-fetch any already-computed vectors in a single query.
    const existingDocs = (await this.userTopicModel
      .find({ news_topic_text: { $in: coldTexts } })
      .select('news_topic_text news_topic_embed')
      .lean()
      .exec()) as Array<{
      news_topic_text: string;
      news_topic_embed?: number[];
    }>;

    for (const doc of existingDocs) {
      if (doc.news_topic_embed?.length) {
        embeddings.set(doc.news_topic_text, doc.news_topic_embed);
      }
    }

    // Only texts still lacking a vector go to the provider.
    const toEmbed = coldTexts.filter((t) => !embeddings.has(t));

    // Chunk at JINA_QUERY_BATCH.
    const chunks: string[][] = [];
    for (let i = 0; i < toEmbed.length; i += this.jinaQueryBatch) {
      chunks.push(toEmbed.slice(i, i + this.jinaQueryBatch));
    }

    if (timings) {
      timings.embedCached = coldTexts.length - toEmbed.length;
      timings.embedded = toEmbed.length;
      timings.embedChunks = chunks.length;
    }

    this.logger.log(
      `articleIdsForTopics cold-embed: cold=${coldTexts.length} ` +
        `cached=${coldTexts.length - toEmbed.length} embed=${toEmbed.length} ` +
        `chunks=${chunks.length} sizes=[${chunks
          .map((c) => c.length)
          .join(',')}]`,
    );

    const bulkOps: AnyBulkWriteOperation<UserTopicDocument>[] = [];
    let droppedTexts = 0;
    let dropReason = '';
    for (const chunk of chunks) {
      // Fresh deadline per call — see DEFAULT_JINA_QUERY_TIMEOUT_MS for why
      // this is NOT hoisted out of the loop.
      const signal = AbortSignal.timeout(this.jinaQueryTimeoutMs);
      let vectors: number[][];
      try {
        vectors = await this.embeddingProvider.embed(
          chunk.map((t) => topicEmbedText(t)),
          signal,
        );
      } catch (err) {
        // Phase 2 had NO error isolation before this, unlike phase 3 below: any
        // provider failure — 429, 5xx, DNS, stall — propagated out of
        // `resolveTopicEntries` and failed the WHOLE query, so the client
        // retried straight back into the same wall. Under burst a 429 is the
        // likely failure, so the texts in this chunk are dropped instead and
        // their topics resolve empty, while cached and warm topics (which never
        // reach phase 2 at all) serve normally.
        droppedTexts += chunk.length;
        dropReason = signal.aborted
          ? `timeout after ${this.jinaQueryTimeoutMs}ms`
          : `${(err as Error)?.constructor?.name ?? 'Error'}: ${
              (err as Error)?.message ?? String(err)
            }`;
        continue;
      }
      for (let i = 0; i < chunk.length; i++) {
        const text = chunk[i];
        const vector = vectors[i];
        embeddings.set(text, vector);
        bulkOps.push({
          updateOne: {
            filter: { news_topic_text: text },
            update: {
              $setOnInsert: { news_topic_text: text },
              // `lastRequestedAt` MUST be set explicitly here: mongoose schema
              // defaults do NOT apply to bulkWrite upserts, so a topic created
              // on the cold path would otherwise land without the retention
              // clock and become immortal (sweepRule never matches documents
              // missing the age field).
              $set: {
                news_topic_embed: vector,
                lastRequestedAt: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
    }

    // Chunks that DID succeed are still warmed — a partial provider failure
    // must not throw away the vectors it managed to return.
    if (bulkOps.length > 0) {
      await this.userTopicModel.bulkWrite(bulkOps);
    }

    if (droppedTexts > 0) {
      if (timings) timings.embedDropped = droppedTexts;
      // WARN, and nothing alerts on it: the query now answers 200 with these
      // topics empty, so the only evidence a provider is degraded is this line.
      // Grep `cold-embed: dropped` before concluding the feed logic regressed.
      // One line after the loop rather than one per chunk, so a total outage
      // reads as a single entry instead of four.
      this.logger.warn(
        `articleIdsForTopics cold-embed: dropped ${droppedTexts} of ` +
          `${toEmbed.length} texts, their topics resolve empty (${dropReason})`,
      );
    }

    return embeddings;
  }

  /**
   * Phase 3 for a single cold topic: Flow v2's vector-search fallback. The
   * query vector is resolved in phase 2; this runs the Atlas `$vectorSearch`,
   * builds the article entries, and caches them (30-min TTL).
   */
  private async runColdVectorSearch(
    topicText: string,
    key: string,
    queryEmbedding: number[],
    strict: boolean,
    names: string[],
    places: Promise<PlaceAnchor> | null = null,
    gates: StoryGate[] = [],
  ): Promise<CachedArticleEntry[]> {
    const cutoffDate = cutoffFor(strict);

    // createdAt is passed as a pre-filter inside $vectorSearch so the ANN only
    // considers documents within the 24h window. This requires the Atlas vector
    // search index to declare createdAt as a { type: "filter" } field.
    // Without this, ANN scores the full collection then $match drops stale docs,
    // forcing a larger numCandidates to compensate for the post-filter loss.
    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: 'embedding_article_data_retrieval_index',
          path: 'embedding_article_data_retrieval',
          queryVector: queryEmbedding,
          numCandidates: NUM_CANDIDATES,
          limit: VECTOR_SEARCH_LIMIT,
          filter: { createdAt: { $gte: cutoffDate } },
        },
      },
      { $addFields: { score: { $meta: 'vectorSearchScore' } } },
      // POST-ANN, not a $vectorSearch `filter`: `url_security_state` is not
      // declared as a filter field on the Atlas index, so it cannot go inside
      // the ANN stage. Insecure rows are ~1.3% of the corpus, so the candidate
      // loss from filtering after the fact is negligible.
      {
        $match: {
          ...SERVABLE_URL_SECURITY_FILTER,
          score: { $gte: this.minScore },
        },
      },
      { $limit: VECTOR_SEARCH_LIMIT },
      { $project: HEAVY_ARTICLE_FIELDS_EXCLUSION },
    ];

    const rawResultsAll = await this.newsArticleModel
      .aggregate<Record<string, unknown>>(pipeline)
      .exec();

    // A followed story keeps only articles that name it (see @mera/shared
    // must-match); every other topic is unfiltered.
    const coldMatchText = (r: Record<string, unknown>) =>
      articleMatchText(r as Parameters<typeof articleMatchText>[0]);
    const rawResults = await this.applyPlaceAnchor(
      'cold',
      topicText,
      await this.applyStoryGates(
        'cold',
        this.applyStoryNames(
          'cold',
          topicText,
          rawResultsAll,
          coldMatchText,
          names,
        ),
        (r) => r._id as Types.ObjectId,
        gates,
      ),
      coldMatchText,
      places,
    );

    if (rawResults.length === 0) {
      await this.cacheEmpty(key, strict);
      return [];
    }

    const articleObjectIds = rawResults.map((r) => r._id as Types.ObjectId);

    const [clusterLinks, pubSources] = await Promise.all([
      this.clusterArticleLinkModel
        .find({ articleId: { $in: articleObjectIds } })
        .select('articleId clusterId')
        .lean()
        .exec() as Promise<
        Array<{ articleId: Types.ObjectId; clusterId: Types.ObjectId }>
      >,
      this.fetchPublicationSources(rawResults),
    ]);

    const clustersByArticle = buildClusterMap(clusterLinks);
    const pubById = new Map(pubSources.map((p) => [p._id.toString(), p]));

    const entries: CachedArticleEntry[] = rawResults.map(
      (r: Record<string, unknown>) => {
        const artId = (r._id as Types.ObjectId).toString();
        const pub = pubById.get(
          (r.publicationSourceId as Types.ObjectId)?.toString() ?? '',
        );
        return {
          _id: artId,
          clusterIds: clustersByArticle.get(artId) ?? [],
          title_en:
            (r.title_en as string | undefined) ??
            (r.title_en_internal_only as string | undefined) ??
            (r.title as string | undefined) ??
            '',
          title: r.title as string | undefined,
          description_en:
            (r.description_en as string | undefined) ??
            (r.description_en_internal_only as string | undefined) ??
            (r.description as string | undefined),
          article_url: r.article_url as string | undefined,
          image_url: r.image_url as string | undefined,
          country_code: pub?.country_code,
          publication_name: pub?.publication_name,
          language_code:
            (r.original_language_code as string | undefined) ??
            pub?.detected_language_code ??
            pub?.feed_language_code,
          pubDate: (
            (r.pubDate as Date | undefined) ??
            (r.createdAt as Date | undefined) ??
            new Date()
          ).toISOString(),
          // Retain the ANN score so the persona matchMeta can expose it.
          score: typeof r.score === 'number' ? r.score : undefined,
        };
      },
    );

    await this.cacheManager.set(key, entries, await this.populatedTtl(places));
    return entries;
  }

  /**
   * Slice a topic's resolved entries into a page (cursor-after semantics),
   * identical to the previous per-topic pagination.
   */
  private paginate(
    input: TopicPaginationInput,
    entries: CachedArticleEntry[],
    limitPerTopic: number,
  ): TopicArticleIdsResult {
    const page = this.paginateEntries(
      entries,
      input.afterCursor,
      limitPerTopic,
    );
    return {
      topicText: input.topicText,
      articleIds: page.entries.map((e) => e._id),
      hasNextPage: page.hasNextPage,
      nextCursor: page.nextCursor,
    };
  }

  /**
   * Cursor-after pagination over resolved entries (shared by the topics and
   * persona shaping). Returns the sliced entries plus cursor/hasNextPage.
   */
  private paginateEntries(
    entries: CachedArticleEntry[],
    afterCursor: string | undefined,
    limit: number,
  ): {
    entries: CachedArticleEntry[];
    nextCursor?: string;
    hasNextPage: boolean;
  } {
    let startIdx = 0;
    if (afterCursor) {
      const idx = entries.findIndex((e) => e._id === afterCursor);
      if (idx !== -1) startIdx = idx + 1;
    }

    const page = entries.slice(startIdx, startIdx + limit);
    const hasNextPage = startIdx + limit < entries.length;
    const nextCursor = page.length > 0 ? page[page.length - 1]._id : undefined;

    return { entries: page, nextCursor, hasNextPage };
  }

  async getArticlesForTopicsByIds(
    articleIds: string[],
    userId: string,
    /**
     * Session-resolved account creation date, forwarded to the quota
     * reservation so a user inside the free 14-day Starter window gets the
     * granted cap instead of the 0 a doc-less user would otherwise get. Never
     * client-supplied; `undefined` simply means "no grant".
     */
    userCreatedAt?: unknown,
  ): Promise<ArticlesForTopicsByIdsResponse> {
    if (articleIds.length === 0) {
      return { articles: [], dailyLimitReached: false };
    }

    // Charge the daily-delivery cap here — this is the point the server hands
    // the user full article content, and the app only requests new-to-device
    // IDs, so each article is counted at most once. Reserve the request, then
    // hydrate only the granted slice (topic/request order preserved).
    const { granted, limitReached, resetAt } = await this.articleQuota.reserve(
      userId,
      articleIds.length,
      new Date(),
      userCreatedAt,
    );
    const grantedIds =
      granted < articleIds.length ? articleIds.slice(0, granted) : articleIds;

    return {
      articles: await this.hydrateArticles(grantedIds),
      dailyLimitReached: limitReached,
      resetAt: limitReached ? resetAt.toISOString() : undefined,
    };
  }

  /**
   * Quota-EXEMPT hydration for followed-story ("tracked story") articles.
   *
   * Identical hydration to `getArticlesForTopicsByIds` — same shape, same
   * fields, literally the same `hydrateArticles` body — with ONE difference: it
   * never calls `reserveArticleQuota`, so nothing it returns counts against the
   * user's daily article cap. A followed story is a topic the user explicitly
   * asked to keep receiving, and the product decision is that following a story
   * must not consume the allowance.
   *
   * `dailyLimitReached` is therefore always false and `resetAt` is always
   * absent: the response type is shared with the metered query purely so the
   * client can reuse one mapper, and those two fields are meaningless here.
   *
   * WHY THE CALLER IS TRUSTED. The server cannot verify that an id "belongs to"
   * a followed story without persisting a user→story (hence user→topic) link,
   * which the privacy invariant forbids — no collection may associate a user
   * with a topic. So a modified client CAN route ordinary feed hydration
   * through here and evade the cap. That is a known, accepted property of this
   * endpoint, not an oversight. What still holds: the caller must present a
   * valid session, and is capped per request by the resolver.
   *
   * Note the arithmetic. Against the granted Starter allowance of 250/day,
   * five 50-id calls here replace a day's feed at zero cost. That is a wider
   * exemption than it looks, though less stark than it was against the 100 cap
   * this briefly shipped with. Kept deliberately: following a story must not
   * consume the allowance,
   * and anyone already following stories keeps receiving them. Limiting how
   * many stories may be followed is an app-side gate on the follow ACTION,
   * which is the only place it CAN live, per the paragraph above.
   *
   * Nothing about the caller is counted or stored on this path: no quota call
   * at all.
   */
  async getArticlesForStories(
    articleIds: string[],
    userId: string,
  ): Promise<ArticlesForTopicsByIdsResponse> {
    if (articleIds.length === 0) {
      return { articles: [], dailyLimitReached: false };
    }

    void userId; // callers still pass it; this path charges and records nothing.
    const articles = await this.hydrateArticles(articleIds);

    return { articles, dailyLimitReached: false };
  }

  /**
   * Shared hydration body — id list → fully-shaped article rows (clusters,
   * publication source, cluster meta). Extracted so the metered
   * (`getArticlesForTopicsByIds`) and quota-exempt (`getArticlesForStories`)
   * entry points cannot drift in what they return; the ONLY difference between
   * them is what happens to the quota before this runs.
   */
  private async hydrateArticles(
    articleIds: string[],
  ): Promise<ArticleWithClusters[]> {
    const objectIds = articleIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    if (objectIds.length === 0) {
      return [];
    }

    // The DELIVERY point for both `getArticlesForTopicsByIds` (metered) and
    // `getArticlesForStories` (quota-exempt) — the id lists reaching here come
    // from the client, so this filter is the last line of defence and must not
    // be relaxed even though the id-producing paths filter too.
    const articles = (await this.newsArticleModel
      .find({ _id: { $in: objectIds }, ...SERVABLE_URL_SECURITY_FILTER })
      // Explicit opt-in to the packed vector sidecar — select: false on the
      // model, and this is the ONLY hydration path that needs it (the app's
      // on-device near-dup dedup runs over articlesForTopicsByIds results).
      // The `+` prefix is LOAD-BEARING here (verified empirically against
      // Mongoose's `_applyPaths`): EXCLUDE_EMBEDDINGS makes this an
      // exclusion-style projection, and only the `+field` form forces a
      // select:false field back in against that shape. A PLAIN (unprefixed)
      // name would instead get pushed onto the exclusion list and dropped —
      // the opposite of the inclusive-projection backfill query below/
      // elsewhere, where plain names (no `+`) are the correct form. Don't
      // "simplify" one to match the other; they resolve oppositely on
      // purpose. See backfill-vector-sidecar.service.ts for that side.
      .select(EXCLUDE_EMBEDDINGS + ' +vector_sidecar_packed')
      .lean()
      .exec()) as unknown as ArticleLean[];

    if (articles.length === 0) {
      return [];
    }

    const [clusterLinks, pubSources] = await Promise.all([
      this.clusterArticleLinkModel
        .find({ articleId: { $in: objectIds } })
        .select('articleId clusterId confidence')
        .lean()
        .exec() as Promise<
        Array<{
          articleId: Types.ObjectId;
          clusterId: Types.ObjectId;
          confidence: number;
        }>
      >,
      this.fetchPublicationSourcesByIds(
        articles.map((a) => a.publicationSourceId),
      ),
    ]);

    // Resolve each linked cluster's stableClusterId + clusterSize (one
    // lean query) so the hydration path carries the stable ids AND the
    // maxClusterSize through to the app without a second round trip.
    const clusterMeta = await this.fetchClusterMeta(
      clusterLinks.map((l) => l.clusterId),
    );

    // Group the article's linked clusterIds so maxClusterSize is a lookup.
    const clusterIdsByArticle = buildClusterMap(clusterLinks);
    const membershipsByArticle = buildClusterMembershipMap(
      clusterLinks,
      clusterMeta,
    );
    const pubById = new Map(pubSources.map((p) => [p._id.toString(), p]));

    const mapped: ArticleWithClusters[] = articles.map((a) => {
      const artId = a._id.toString();
      const pub = pubById.get(a.publicationSourceId.toString());
      // Max clusterSize over the article's linked clusters (null when none).
      const linkedClusterIds = clusterIdsByArticle.get(artId) ?? [];
      let maxClusterSize: number | null = null;
      for (const cid of linkedClusterIds) {
        const size = clusterMeta.get(cid)?.clusterSize ?? 0;
        if (maxClusterSize === null || size > maxClusterSize) {
          maxClusterSize = size;
        }
      }
      return {
        _id: artId,
        clusters: membershipsByArticle.get(artId) ?? [],
        title_en: a.title_en ?? a.title_en_internal_only ?? a.title ?? '',
        title: a.title ?? undefined,
        description_en:
          a.description_en ?? a.description_en_internal_only ?? a.description,
        article_url: a.article_url,
        image_url: a.image_url,
        country_code: pub?.country_code,
        publication_name: pub?.publication_name,
        language_code:
          a.original_language_code ??
          pub?.detected_language_code ??
          pub?.feed_language_code,
        pubDate: a.pubDate ?? a.createdAt ?? new Date(),
        // Hydration metadata (all nullable/additive).
        geo_tags: a.geo_tags,
        entities: a.entities,
        event_type: a.event_type,
        category: pub?.category,
        maxClusterSize,
        vector_sidecar_packed: toBase64Sidecar(a.vector_sidecar_packed),
        // Enrichment v2 (all nullable/additive).
        geo_scope: a.geo_scope,
        content_categories: a.content_categories,
        genre: a.genre,
        tone: a.tone,
        significance: a.significance,
        story_key: a.story_key ?? null,
      };
    });

    return mapped;
  }

  private async fetchPublicationSources(
    rawArticles: Record<string, unknown>[],
  ): Promise<PublicationSourceLean[]> {
    const ids = Array.from(
      new Set(
        rawArticles
          .map((r) => (r.publicationSourceId as Types.ObjectId)?.toString())
          .filter(Boolean),
      ),
    ).map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return [];
    return this.publicationSourceModel
      .find({ _id: { $in: ids } })
      .lean()
      .exec() as Promise<PublicationSourceLean[]>;
  }

  private async fetchPublicationSourcesByIds(
    ids: Types.ObjectId[],
  ): Promise<PublicationSourceLean[]> {
    const uniqueIds = Array.from(new Set(ids.map((id) => id.toString()))).map(
      (id) => new Types.ObjectId(id),
    );
    if (uniqueIds.length === 0) return [];
    return this.publicationSourceModel
      .find({ _id: { $in: uniqueIds } })
      .lean()
      .exec() as Promise<PublicationSourceLean[]>;
  }

  /**
   * Bulk-resolve each cluster's `stableClusterId` + `clusterSize` in ONE
   * lean query. Returns a clusterId → { stableClusterId, clusterSize } map;
   * missing docs / null fields map to `stableClusterId: null` and
   * `clusterSize: 0` (singleton/noise clusters or docs written before the
   * fields existed). Feeds both the hydration membership map (stable ids +
   * maxClusterSize) and the persona largest-cluster resolution.
   */
  private async fetchClusterMeta(
    clusterIds: Types.ObjectId[],
  ): Promise<
    Map<string, { stableClusterId: string | null; clusterSize: number }>
  > {
    const uniqueIds = Array.from(
      new Set(clusterIds.map((id) => id.toString())),
    ).map((id) => new Types.ObjectId(id));
    if (uniqueIds.length === 0) return new Map();

    const clusters = (await this.newsClusterModel
      .find({ _id: { $in: uniqueIds } })
      .select('stableClusterId clusterSize')
      .lean()
      .exec()) as unknown as Array<{
      _id: Types.ObjectId;
      stableClusterId?: string | null;
      clusterSize?: number | null;
    }>;

    return new Map(
      clusters.map((c) => [
        c._id.toString(),
        {
          stableClusterId: c.stableClusterId ?? null,
          clusterSize: c.clusterSize ?? 0,
        },
      ]),
    );
  }

  /**
   * How many articles arrived recently.
   *
   * `since` is OPTIONAL and additive. Omitted, this behaves exactly as it
   * always has: a rolling 24h count, cached for 10 minutes under one shared
   * key. That default path is unchanged — same cutoff, same cache key, same
   * TTL — because it is what every installed app binary calls today.
   *
   * WHY `since` EXISTS. The hourly push notification asks a different
   * question — "how many since this user last looked" — and answers it today by
   * reading `UserDailyUsage.updatedAt` and counting `ArticleFingerprint`
   * itself, straddling the user/news boundary in one query path. That is the
   * single biggest blocker to giving the async service a news-only database
   * credential. With this argument the count becomes something a caller can ask
   * for over the wire, so the notification worker can move to the side that
   * owns the user data and get the news number through the port.
   *
   * WHY IT IS NOT CACHED. `since` is caller-supplied and effectively unbounded
   * in cardinality — every distinct instant would mint a cache entry, so the
   * hit rate would be ~0 while the key space grew without limit. The shared
   * cache is deliberately reserved for the argument-less form, which is the
   * high-traffic one.
   *
   * `since` is CLAMPED to the retention window. `news-article` is swept at 48h,
   * so a caller asking about last month cannot get a true answer — it would get
   * the 48h number dressed up as a monthly one. Clamping makes the ceiling
   * explicit and the result honest: "everything we still have".
   */
  async getRecentArticleCount(since?: Date | null): Promise<number> {
    const floor = new Date(Date.now() - MAX_COUNT_LOOKBACK_HOURS * 3600_000);

    if (since instanceof Date && !Number.isNaN(since.getTime())) {
      const cutoffDate = since < floor ? floor : since;
      return this.newsArticleModel.countDocuments({
        createdAt: { $gte: cutoffDate },
      });
    }

    const cacheKey = 'recent-article-count';
    const cached = await this.cacheManager.get<number>(cacheKey);
    if (cached !== null && cached !== undefined) return cached;
    const cutoffDate = new Date(Date.now() - CUTOFF_HOURS * 60 * 60 * 1000);
    const count = await this.newsArticleModel.countDocuments({
      createdAt: { $gte: cutoffDate },
    });
    await this.cacheManager.set(cacheKey, count, 10 * 60 * 1000);
    return count;
  }

  async getRelatedArticles(
    articleId: string,
    stableClusterId?: string | null,
  ): Promise<ArticleSummary[]> {
    // An id we cannot parse is "this article has no siblings", not a 500. The
    // argument is a client-supplied `ID`, so an unguarded `new ObjectId(...)`
    // makes any malformed value a BSONError that escapes as INTERNAL_SERVER_ERROR
    // — which is what it did in production (`GetRelatedArticles`, okhttp, up to
    // 2026-08-11). The detail screen treats this list as supplementary and
    // renders the empty case already, so the empty list is the answer the caller
    // can actually use. Same rule as `FactCheckService.factCheck`.
    if (!Types.ObjectId.isValid(articleId)) return [];

    const articleObjectId = new Types.ObjectId(articleId);

    // Resolve the cluster to read siblings from. Prefer the retained
    // `stableClusterId` — the identity that survives each wipe-and-reinsert
    // clustering run — by mapping it to the CURRENT generation's raw cluster
    // `_id`. This keeps the related set aligned with the story the top-headlines
    // card was built around, even though the raw `clusterId` is re-minted every
    // run. Fall back to the article's own live link when no stable id is
    // supplied (For-You callers / older app builds that don't pass one).
    let clusterId: Types.ObjectId | null = null;
    if (stableClusterId) {
      const cluster = await this.newsClusterModel
        .findOne({ stableClusterId })
        .select('_id')
        .lean()
        .exec();
      clusterId = cluster?._id ?? null;
    }
    if (!clusterId) {
      const link = await this.clusterArticleLinkModel
        .findOne({ articleId: articleObjectId })
        .select('clusterId')
        .lean()
        .exec();
      clusterId = link?.clusterId ?? null;
    }
    if (!clusterId) return [];

    const siblingLinks = await this.clusterArticleLinkModel
      .find({
        clusterId,
        articleId: { $ne: articleObjectId },
      })
      .select('articleId')
      .lean()
      .exec();
    if (siblingLinks.length === 0) return [];

    const siblingArticleIds = siblingLinks.map((l) => l.articleId);

    const articles = (await this.newsArticleModel
      .find({
        _id: { $in: siblingArticleIds },
        ...SERVABLE_URL_SECURITY_FILTER,
      })
      .select(EXCLUDE_EMBEDDINGS)
      .lean()
      .exec()) as unknown as ArticleLean[];

    const pubSources = await this.fetchPublicationSourcesByIds(
      articles.map((a) => a.publicationSourceId),
    );
    const pubById = new Map(pubSources.map((p) => [p._id.toString(), p]));

    return articles.map((a) => {
      const pub = pubById.get(a.publicationSourceId.toString());
      return {
        _id: a._id.toString(),
        title_en: a.title_en ?? a.title_en_internal_only ?? a.title ?? '',
        description_en:
          a.description_en ?? a.description_en_internal_only ?? a.description,
        article_url: a.article_url,
        image_url: a.image_url,
        country_code: pub?.country_code,
        publication_name: pub?.publication_name,
        language_code:
          a.original_language_code ??
          pub?.detected_language_code ??
          pub?.feed_language_code,
        pubDate: a.pubDate ?? a.createdAt ?? new Date(),
      };
    });
  }

  /**
   * One ordered page of an article's sibling coverage.
   *
   * The unbounded `getRelatedArticles` above returns every sibling in one shot,
   * which on a heavily-syndicated wire story is a few hundred rows the client
   * then has to order and render at once. This method does the ordering here and
   * hands back 10 rows at a time.
   *
   * Ordering CANNOT be pushed into Mongo. Tier B ranks each country block by its
   * size across the WHOLE candidate set, so the order of any one page depends on
   * rows that are not in it. The whole set is therefore materialized, ordered
   * in-process, and only then sliced — which is affordable precisely because of
   * the cache below.
   */
  async getRelatedArticlesPage(input: {
    articleId: string;
    stableClusterId?: string | null;
    sortMode: RelatedSortMode;
    context: UserGeoLanguageContext | null;
    excludeIds?: string[] | null;
    /** Chip filters, ISO alpha-3 (or GLOBAL). Absent or empty = no filter. */
    countries?: string[] | null;
    /** Chip filters, base language tags. Absent or empty = no filter. */
    languages?: string[] | null;
    first: number;
    after?: string | null;
  }): Promise<RelatedArticlesPage> {
    const empty: RelatedArticlesPage = {
      articles: [],
      pageInfo: { endCursor: null, hasNextPage: false, pageSize: 0 },
      restarted: false,
      facets: { countries: [], languages: [] },
    };

    // Same rule as getRelatedArticles: an unparseable id is "no siblings", not
    // a 500. See the comment there for the production BSONError that earned it.
    if (!Types.ObjectId.isValid(input.articleId)) return empty;
    const articleObjectId = new Types.ObjectId(input.articleId);

    const keys = await this.loadRelatedSortKeys(
      articleObjectId,
      input.stableClusterId,
    );
    if (keys.length === 0) return empty;

    // The viewed article is IN the cached list (see loadRelatedSortKeys on why
    // the cache cannot exclude it), so drop it here with the caller's ids.
    //
    // Exclusion BEFORE ordering, not after. The suggestion route already renders
    // its local siblings as a head block and passes them here; excluding them
    // afterwards would short-change every page (10 fetched, 2 rendered,
    // hasNextPage still true).
    // Read before exclusion drops the viewed row. An entry cached before
    // story_key existed has no storyKey, so the partition below is skipped.
    const viewedStory =
      keys.find((k) => k.id === input.articleId)?.storyKey ?? null;
    const excluded = new Set(input.excludeIds ?? []);
    excluded.add(input.articleId);
    const candidates = keys.filter((k) => !excluded.has(k.id));
    if (candidates.length === 0) return empty;

    // Chip filters, like exclusion, run BEFORE ordering so every page stays
    // full. The
    // facets are counted over the unfiltered candidates (each dimension with
    // the other's filter applied), so a chip keeps its count while selected.
    const filters = toRelatedFilters(input.countries, input.languages);
    const facets = computeRelatedFacets(candidates, filters);
    const filtered =
      filters.countries || filters.languages
        ? candidates.filter((k) => matchesRelatedFilters(k, filters))
        : candidates;
    if (filtered.length === 0) return { ...empty, facets };

    let ordered = orderRelatedArticles(filtered, input.context, input.sortMode);
    // Best match puts copies of the viewed story first. Oldest and Newest are
    // flat sorts the reader picked, so they stay untouched. A stable partition
    // of a total order is still total, so the id cursor below stays valid.
    if (viewedStory && input.sortMode === 'relevance') {
      ordered = [
        ...ordered.filter((k) => k.storyKey === viewedStory),
        ...ordered.filter((k) => k.storyKey !== viewedStory),
      ];
    }

    // Id cursor, not an offset. The ordered list is rebuildable rather than
    // durable (30-minute cache, and a clustering run replaces the membership
    // underneath it), and a bare offset would then silently skip or repeat rows.
    // An id that no longer resolves degrades to "restart from the top", which we
    // report so the client replaces its list instead of appending to it. Safe
    // because orderRelatedArticles is a TOTAL order — id ASC is the final
    // tiebreak in every mode.
    let startIdx = 0;
    let restarted = false;
    if (input.after) {
      const idx = ordered.findIndex((e) => e.id === input.after);
      if (idx !== -1) {
        startIdx = idx + 1;
      } else {
        restarted = true;
      }
    }

    const pageKeys = ordered.slice(startIdx, startIdx + input.first);
    const hasNextPage = startIdx + input.first < ordered.length;
    const articles = await this.hydrateArticleSummaries(
      pageKeys.map((k) => k.id),
    );

    return {
      articles,
      pageInfo: {
        // The cursor is the last ORDERED id, not the last hydrated one: a row
        // dropped by the security filter or the article TTL between the cache
        // write and now must still advance the cursor past itself, or the next
        // page starts on the row we just failed to render and the reader stalls.
        endCursor:
          pageKeys.length > 0 ? pageKeys[pageKeys.length - 1].id : null,
        hasNextPage,
        pageSize: articles.length,
      },
      restarted,
      facets,
    };
  }

  /**
   * Every generation's cluster for this story, newest first.
   *
   * NOT a `findOne`, and this is the whole fix for "a top story opens with no
   * related articles". The clustering job persists by GENERATION SWAP: it
   * inserts the new generation's clusters, then its links, and only then deletes
   * the old generation's links and clusters. For that whole window TWO
   * `news-cluster` docs carry the same `stableClusterId`, and an article has a
   * link in both. An unsorted `findOne` lands on either one, so a read could hit
   * the new cluster before its links existed or the old cluster after its links
   * were gone, and the empty answer was then cached for everyone reading the
   * story. The caller picks the newest COMPLETE generation from this list.
   *
   * Prefers the retained `stableClusterId` (the identity that survives each
   * run), and falls back to the clusters the article itself is linked to.
   */
  private async findRelatedClusterCandidates(
    articleObjectId: Types.ObjectId,
    stableClusterId?: string | null,
  ): Promise<RelatedClusterCandidate[]> {
    if (stableClusterId) {
      const byStable = (await this.newsClusterModel
        .find({ stableClusterId })
        .select('_id clusterSize')
        .sort({ createdAt: -1, _id: -1 })
        .lean()
        .exec()) as unknown as RelatedClusterCandidate[];
      if (byStable.length > 0) return byStable;
    }

    const ownLinks = (await this.clusterArticleLinkModel
      .find({ articleId: articleObjectId })
      .select('clusterId')
      .lean()
      .exec()) as unknown as Array<{ clusterId: Types.ObjectId }>;
    if (ownLinks.length === 0) return [];

    const clusterIds = ownLinks.map((l) => l.clusterId);
    const clusters = (await this.newsClusterModel
      .find({ _id: { $in: clusterIds } })
      .select('_id clusterSize')
      .sort({ createdAt: -1, _id: -1 })
      .lean()
      .exec()) as unknown as RelatedClusterCandidate[];
    if (clusters.length > 0) return clusters;

    // Links with no cluster doc behind them: only reachable mid-swap on the
    // legacy wipe-first path. Serve them, but with no size to check against,
    // so the read counts as incomplete and is never cached.
    return clusterIds.map((id) => ({ _id: id, clusterSize: null }));
  }

  /**
   * The story's sortable keys, cached.
   *
   * Keyed on the STABLE cluster id whenever the caller supplied one. A raw
   * `clusterId` does not survive a clustering run (the job re-mints every
   * cluster each hour), so a raw-keyed entry either serves ids from a dead
   * generation or misses and rebuilds over different membership, and either way
   * the reader's cursor stops resolving mid-scroll. Keyed on the stable id the
   * list stays coherent for the whole scroll and goes at most 30 minutes stale;
   * hydration is live, so an article that TTL'd out in the meantime simply drops
   * from its page.
   *
   * WHAT IS CACHED, AND WHAT NEVER IS. A generation is COMPLETE when its link
   * count equals the `clusterSize` the job wrote beside it; the newest complete
   * generation wins. A complete list is cached for 30 min, or for 60 s when it
   * is empty (every member TTL'd out or insecure). An INCOMPLETE read, which
   * only happens while a clustering run is swapping generations, is served but
   * never cached, because the entry is shared by every reader of the story and
   * a cached partial list would outlive the swap by half an hour. Compare LINK
   * counts, never key counts: keys drop legitimately for TTL'd or insecure rows.
   *
   * Context- and mode-free ON PURPOSE: ordering is cheap in-process over a few
   * hundred rows, so every reader of a story shares one entry. That is what
   * keeps reader preferences out of Redis entirely and avoids fragmenting the
   * cache per user.
   *
   * For the same reason the list holds the WHOLE cluster, including the article
   * being viewed. The entry is keyed on the cluster, not on the reader's
   * article, so excluding one article here would serve that omission to every
   * other reader of the same story. The caller drops its own article, and gets
   * tier A's anchor country out of the same pass for free.
   */
  private async loadRelatedSortKeys(
    articleObjectId: Types.ObjectId,
    stableClusterId?: string | null,
  ): Promise<RelatedSortKey[]> {
    if (stableClusterId) {
      const cached = await this.cacheManager.get<RelatedSortKey[]>(
        `relkeys:${stableClusterId}`,
      );
      if (cached) return cached;
    }

    const candidates = await this.findRelatedClusterCandidates(
      articleObjectId,
      stableClusterId,
    );
    if (candidates.length === 0) return [];

    if (!stableClusterId) {
      const cached = await this.cacheManager.get<RelatedSortKey[]>(
        `relkeys:${candidates[0]._id.toString()}`,
      );
      if (cached) return cached;
    }

    let chosen: {
      clusterId: Types.ObjectId;
      articleIds: Types.ObjectId[];
    } | null = null;
    let complete = false;
    for (const candidate of candidates) {
      const links = (await this.clusterArticleLinkModel
        .find({ clusterId: candidate._id })
        .select('articleId')
        .lean()
        .exec()) as unknown as Array<{ articleId: Types.ObjectId }>;
      const articleIds = links.map((l) => l.articleId);
      const size = candidate.clusterSize;
      if (
        typeof size === 'number' &&
        Number.isFinite(size) &&
        size > 0 &&
        articleIds.length === size
      ) {
        chosen = { clusterId: candidate._id, articleIds };
        complete = true;
        break;
      }
      // Incomplete: remember the fullest read so a mid-swap request still
      // answers with something, then keep looking for a complete generation.
      if (!chosen || articleIds.length > chosen.articleIds.length) {
        chosen = { clusterId: candidate._id, articleIds };
      }
    }
    if (!chosen) return [];

    if (!complete) {
      this.logger.warn(
        `relatedArticlesPage: no complete generation for ${stableClusterId ?? chosen.clusterId.toString()} ` +
          `(${candidates.length} candidate(s), serving ${chosen.articleIds.length} link(s) uncached)`,
      );
    }

    let siblingArticleIds = chosen.articleIds;
    if (siblingArticleIds.length > MAX_RELATED_KEYS) {
      // Heap backstop, not a product cap. Nothing observed comes close (worst
      // measured story: 179 siblings), but nothing bounds cluster size on the
      // write side either. Logged rather than silent: a truncated list is
      // indistinguishable from full coverage once it renders.
      this.logger.warn(
        `relatedArticlesPage: cluster ${chosen.clusterId.toString()} has ${siblingArticleIds.length} siblings, truncating to ${MAX_RELATED_KEYS}`,
      );
      siblingArticleIds = siblingArticleIds.slice(0, MAX_RELATED_KEYS);
    }

    const keys = await this.buildRelatedSortKeys(siblingArticleIds);

    if (complete) {
      await this.cacheManager.set(
        `relkeys:${stableClusterId ?? chosen.clusterId.toString()}`,
        keys,
        keys.length > 0 ? CACHE_TTL_MS : RELATED_EMPTY_CACHE_TTL_MS,
      );
    }
    return keys;
  }

  /** Servable sibling rows to context-free sort keys. */
  private async buildRelatedSortKeys(
    siblingArticleIds: Types.ObjectId[],
  ): Promise<RelatedSortKey[]> {
    if (siblingArticleIds.length === 0) return [];

    const articles = (await this.newsArticleModel
      .find({
        _id: { $in: siblingArticleIds },
        ...SERVABLE_URL_SECURITY_FILTER,
      })
      .select(
        '_id publicationSourceId original_language_code pubDate createdAt story_key',
      )
      .lean()
      .exec()) as unknown as ArticleLean[];

    const pubSources = await this.fetchPublicationSourcesByIds(
      articles.map((a) => a.publicationSourceId),
    );
    const pubById = new Map(pubSources.map((p) => [p._id.toString(), p]));

    return articles.map((a) => {
      const pub = pubById.get(a.publicationSourceId.toString());
      const raw = a.pubDate ?? a.createdAt ?? null;
      const ms = raw ? new Date(raw).getTime() : NaN;
      return {
        id: a._id.toString(),
        countryCodeAlpha3: pub?.country_code ?? null,
        languageCode:
          a.original_language_code ??
          pub?.detected_language_code ??
          pub?.feed_language_code ??
          null,
        publicationName: pub?.publication_name ?? null,
        pubDateMs: Number.isFinite(ms) ? ms : null,
        storyKey: a.story_key ? String(a.story_key) : null,
      };
    });
  }

  /** Hydrate one page's ids into ArticleSummary, preserving the ordered order.
   *  Rows the security filter or the 48h TTL removed simply drop out. */
  private async hydrateArticleSummaries(
    ids: string[],
  ): Promise<ArticleSummary[]> {
    if (ids.length === 0) return [];
    const objectIds = ids.map((id) => new Types.ObjectId(id));
    const articles = (await this.newsArticleModel
      .find({ _id: { $in: objectIds }, ...SERVABLE_URL_SECURITY_FILTER })
      .select(EXCLUDE_EMBEDDINGS)
      .lean()
      .exec()) as unknown as ArticleLean[];

    const pubSources = await this.fetchPublicationSourcesByIds(
      articles.map((a) => a.publicationSourceId),
    );
    const pubById = new Map(pubSources.map((p) => [p._id.toString(), p]));
    const byId = new Map(
      articles.map((a) => {
        const pub = pubById.get(a.publicationSourceId.toString());
        return [
          a._id.toString(),
          {
            _id: a._id.toString(),
            title_en: a.title_en ?? a.title_en_internal_only ?? a.title ?? '',
            description_en:
              a.description_en ??
              a.description_en_internal_only ??
              a.description,
            article_url: a.article_url,
            image_url: a.image_url,
            country_code: pub?.country_code,
            publication_name: pub?.publication_name,
            language_code:
              a.original_language_code ??
              pub?.detected_language_code ??
              pub?.feed_language_code,
            title_original: a.title,
            pubDate: a.pubDate ?? a.createdAt ?? new Date(),
          } as ArticleSummary,
        ];
      }),
    );

    return ids
      .map((id) => byId.get(id))
      .filter((a): a is ArticleSummary => a !== undefined);
  }
}

function buildClusterMap(
  links: Array<{ articleId: Types.ObjectId; clusterId: Types.ObjectId }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const link of links) {
    const artId = link.articleId.toString();
    const existing = map.get(artId);
    if (existing) {
      existing.push(link.clusterId.toString());
    } else {
      map.set(artId, [link.clusterId.toString()]);
    }
  }
  return map;
}

function buildClusterMembershipMap(
  links: Array<{
    articleId: Types.ObjectId;
    clusterId: Types.ObjectId;
    confidence: number;
  }>,
  clusterMeta: Map<
    string,
    { stableClusterId: string | null; clusterSize: number }
  >,
): Map<
  string,
  Array<{
    clusterId: string;
    confidence: number;
    stableClusterId: string | null;
  }>
> {
  const map = new Map<
    string,
    Array<{
      clusterId: string;
      confidence: number;
      stableClusterId: string | null;
    }>
  >();
  for (const link of links) {
    const artId = link.articleId.toString();
    const clusterId = link.clusterId.toString();
    const membership = {
      clusterId,
      confidence: link.confidence,
      stableClusterId: clusterMeta.get(clusterId)?.stableClusterId ?? null,
    };
    const existing = map.get(artId);
    if (existing) {
      existing.push(membership);
    } else {
      map.set(artId, [membership]);
    }
  }
  return map;
}
