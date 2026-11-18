import { createHmac, randomBytes } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Model, Types } from 'mongoose';
import { ConfigService } from '@nestjs/config';
import { GraphQLError } from 'graphql';
import { readText } from '@mera/shared/config/env-choice';
import { SERVABLE_URL_SECURITY_FILTER } from '@mera/shared/url/url-security';
import {
  NewsArticle,
  NewsArticleDocument,
} from '@mera/models/models/news-article.model';
import {
  PublicationSource,
  PublicationSourceDocument,
} from '@mera/models/models/publication-source.model';
import {
  ClusterArticleLink,
  ClusterArticleLinkDocument,
} from '@mera/models/models/cluster-article-link.model';
import {
  EMBEDDING_PROVIDER,
  EmbeddingProvider,
} from '../embedding-provider/embedding-provider.port';
import { NewsSearchHit } from './news-search.dto';

/**
 * `searchNews`: hybrid search over the recent corpus. An Atlas Search (lucene)
 * lexical leg and a `$vectorSearch` semantic leg, fused by reciprocal rank.
 *
 * Semantic retrieval alone has poor exact-proper-noun recall, and its score
 * floor was tuned for long topic strings, not for the two or three words typed
 * into a search box. The lexical leg scores literal term overlap, so a headline
 * typed verbatim comes back.
 *
 * The lexical leg needs the `news_article_text_index` Atlas search index. Every
 * standing Atlas index keeps a change stream scanning all `news-article`
 * writes, so a deployment may run without it. That is why the legs degrade
 * INDEPENDENTLY below: without the text index the answer is semantic-only,
 * with the embedding provider down it is lexical-only, and only a double
 * failure is an error.
 *
 * The query text is the reader's own. It is capped before any work, never
 * placed in a cache key or a log line, and a failure is logged as the error's
 * name and code only: a database or provider error can echo the pipeline,
 * which holds the query.
 */

/** Hard ceiling on results per request. */
export const MAX_SEARCH_LIMIT = 25;

/** Applied when the caller passes no limit. */
export const DEFAULT_SEARCH_LIMIT = 20;

/** Recency window. Matches the 48h `NewsArticle` retention: older rows are gone. */
const CUTOFF_HOURS = 48;

/** The lexical (lucene) Atlas index. Optional: without it the vector leg answers alone. */
export const LEXICAL_SEARCH_INDEX = 'news_article_text_index';

/**
 * Default search-local vector floor, overridable with `SEARCH_VECTOR_MIN_SCORE`.
 * Deliberately NOT the shared `VECTOR_RETRIEVAL_MIN_SCORE` (0.78): that floor is
 * calibrated for the feed's long topic strings, where a hard cut IS the product
 * decision, and cutting a two-word search query at it returns nothing. Here the
 * rank fusion does the ranking, so the floor's only job is to keep obvious
 * garbage out of the rank list. Do not "unify" these two numbers.
 */
export const DEFAULT_SEARCH_VECTOR_MIN_SCORE = 0.7;

/** Longest query, in characters, after normalising. Longer is refused before any work. */
export const MAX_QUERY_LENGTH = 200;

/**
 * ANN over-fetch factor. The post-ANN `$match` (min-score + url-security)
 * DROPS rows, so asking the ANN for exactly `limit` documents
 * would reliably return fewer than the caller asked for. Fetch 4× per leg and
 * slice in JS after fusion has run.
 */
const ANN_OVERFETCH = 4;

/** Candidate pool per ANN result. Atlas's own guidance is ~10–20×. */
const NUM_CANDIDATES_PER_RESULT = 20;

/** Query-embedding cache TTL. Mirrors the cold path's 30 minutes. */
const EMBED_CACHE_TTL_MS = 30 * 60 * 1000;

/** `k:` is the keyed caller; an open caller would need its own prefix. */
const EMBED_CACHE_PREFIX = 'news-search-embed:k:';

/** The name and code of an error, never its message: that can echo the pipeline, which holds the query. */
function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' || typeof code === 'number'
    ? `${name} ${code}`
    : name;
}

/** Reciprocal-rank-fusion damping constant. 60 is the value from the original
 * RRF paper and the one Atlas's own `$rankFusion` defaults to. */
export const RRF_K = 60;

/**
 * Leg weights. NOT equal, and the asymmetry is the fix for the reported bug
 * rather than a tuning preference.
 *
 * At equal weights the two legs' rank-0 documents score identically, so which
 * one opens the result list is decided by the tie-break, i.e. arbitrarily. The
 * complaint being fixed is "I typed the headline and it did not come back", so
 * an exact lexical hit must not be able to lose the top slot to a coin flip.
 * Weighting the semantic leg a notch lower makes lexical win every tie
 * deterministically, while leaving it far too small a gap to suppress the
 * semantic leg: a document found by BOTH still scores 1.9/(k+1) and beats
 * either leg alone, which is the whole point of fusing.
 */
export const LEXICAL_WEIGHT = 1.0;
export const SEMANTIC_WEIGHT = 0.9;

/** Default ceiling on the blocking embedding round trip inside the semantic leg. */
const DEFAULT_EMBED_TIMEOUT_MS = 2500;

/**
 * The one projection both legs share.
 *
 * IT IS NOT THE DTO'S FIELD LIST, AND THAT IS THE POINT. Two independent
 * constraints meet here:
 *
 *   1. `Model.aggregate()` BYPASSES Mongoose `select: false`, so an
 *      un-projected pipeline hands back `embedding_article_data_retrieval`
 *      (768 floats), `embedding_article_data_text_matching` and
 *      `vector_sidecar_packed` on every row. `avgObjSize` on this collection is
 *      ~21.9 KB, so two un-projected legs is ~3.6 MB per request on the 1 GiB
 *      Cloud Run heap that these vectors have already OOMed once.
 *   2. The descriptions ride along for the result-shape mapping; the narrow
 *      public shape is still produced in JS at the end, which is what keeps
 *      `description_en` out of the GraphQL type.
 */
const RETRIEVAL_PROJECTION = Object.freeze({
  title: 1,
  title_en: 1,
  title_en_internal_only: 1,
  description_en: 1,
  description_en_internal_only: 1,
  image_url: 1,
  publicationSourceId: 1,
  pubDate: 1,
  createdAt: 1,
  score: 1,
});

type ArticleRow = Record<string, unknown>;

type PublicationSourceLean = {
  _id: Types.ObjectId;
  publication_name?: string;
  country_code?: string;
};

/** One ranked result list entering the fusion, with its relative weight. */
export interface RankedLeg<T> {
  readonly rows: readonly T[];
  readonly weight: number;
}

/**
 * Reciprocal rank fusion.
 *
 * WHY RANK AND NOT SCORE. Lucene's `searchScore` is an unbounded BM25 value and
 * Atlas's `vectorSearchScore` is a cosine mapped into [0,1]; they are not on
 * comparable scales, so any weighted sum of the two needs a tuning constant
 * that will not survive a change in corpus size. Rank is scale-free: a
 * document's contribution from a leg is `weight / (k + rank)`, so a document
 * found by BOTH legs necessarily outranks one found by either, which is
 * exactly the behaviour the reported bug needs.
 *
 * Ties break on `key` ascending so the order is TOTAL. A non-total order over
 * a paginated or sliced list is how the feed's warm path once learned to skip
 * and repeat rows; there is no reason to re-learn it here.
 */
export function fuseByReciprocalRank<T>(
  legs: readonly RankedLeg<T>[],
  keyOf: (row: T) => string,
  k: number = RRF_K,
): { row: T; score: number }[] {
  const acc = new Map<string, { row: T; score: number }>();

  for (const leg of legs) {
    leg.rows.forEach((row, index) => {
      const key = keyOf(row);
      const contribution = leg.weight / (k + index + 1);
      const existing = acc.get(key);
      if (existing) {
        existing.score += contribution;
      } else {
        acc.set(key, { row, score: contribution });
      }
    });
  }

  return Array.from(acc.entries())
    .sort((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1))
    .map(([, value]) => value);
}

/** Normalized headline, for the duplicate check. Case, punctuation and
 *  whitespace are all noise when two outlets run the same wire headline. */
export function normalizeTitleForDedup(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Collapse a ranked list so each story appears once.
 *
 * WHY THIS IS NOT OPTIONAL POLISH. The fused candidates for a news query can run
 * to well over a hundred rows for a handful of real stories, and one headline
 * exists on separate rows from separate outlets. Without this, one wire story
 * eats most of a 25-slot page.
 *
 * TWO KEYS, AND THE SECOND IS THE LOAD-BEARING ONE. Cluster membership is the
 * obvious key, but the clustering job SHATTERS stories, measured here, two
 * rows carrying the byte-identical headline landed in different clusters and
 * survived a cluster-only collapse sitting at ranks 1 and 2. So a row is also
 * dropped when its normalized title has already been seen. Title equality
 * needs no job to have run and cannot be shattered.
 *
 * The FIRST member wins and the caller passes a list already sorted by fused
 * score, so the survivor is the best-scoring member of its story.
 *
 * Rows with neither key resolvable pass through untouched, clustering is a
 * separate job and a row it has not reached must still be findable. Cluster
 * `_id`s are not stable between runs, which does not matter: this groups
 * WITHIN one request and never needs identity across them, so
 * `stableClusterId` would buy nothing and would miss the single-member
 * clusters that never receive one.
 */
export function collapseByStory<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  clusterOf: (articleId: string) => string | undefined,
  titleOf?: (row: T) => string | undefined,
): T[] {
  const seenClusters = new Set<string>();
  const seenTitles = new Set<string>();
  const out: T[] = [];

  for (const row of rows) {
    const cluster = clusterOf(keyOf(row));
    const rawTitle = titleOf?.(row);
    const title = rawTitle ? normalizeTitleForDedup(rawTitle) : '';

    if (cluster !== undefined && seenClusters.has(cluster)) continue;
    if (title.length > 0 && seenTitles.has(title)) continue;

    if (cluster !== undefined) seenClusters.add(cluster);
    if (title.length > 0) seenTitles.add(title);
    out.push(row);
  }
  return out;
}

@Injectable()
export class NewsSearchService {
  private readonly logger = new Logger(NewsSearchService.name);
  private readonly embedTimeoutMs: number;
  private readonly minScore: number;
  private readonly cacheSecret: string;

  constructor(
    @InjectModel(NewsArticle.name)
    private readonly newsArticleModel: Model<NewsArticleDocument>,
    @InjectModel(PublicationSource.name)
    private readonly publicationSourceModel: Model<PublicationSourceDocument>,
    @InjectModel(ClusterArticleLink.name)
    private readonly clusterArticleLinkModel: Model<ClusterArticleLinkDocument>,
    @Inject(EMBEDDING_PROVIDER)
    private readonly embeddingProvider: EmbeddingProvider,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly configService: ConfigService,
  ) {
    const configured = Number(
      this.configService.get<string>(
        'NEWS_SEARCH_EMBED_TIMEOUT_MS',
        String(DEFAULT_EMBED_TIMEOUT_MS),
      ),
    );
    this.embedTimeoutMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_EMBED_TIMEOUT_MS;

    const floor = readText(this.configService, 'SEARCH_VECTOR_MIN_SCORE');
    this.minScore =
      floor === '' ? DEFAULT_SEARCH_VECTOR_MIN_SCORE : Number(floor);
    if (!(this.minScore > 0 && this.minScore <= 1)) {
      throw new Error(
        'SEARCH_VECTOR_MIN_SCORE must be a number above 0 and at most 1',
      );
    }

    // The cache key is a keyed hash of the query, so no cache holds the text.
    const secret = readText(this.configService, 'SEARCH_CACHE_SECRET');
    this.cacheSecret = secret === '' ? randomBytes(32).toString('hex') : secret;
    if (secret === '') {
      this.logger.warn(
        'SEARCH_CACHE_SECRET is unset: the search cache is per process',
      );
    }
  }

  /**
   * Trim + collapse internal whitespace, case preserved: the query is embedded
   * as typed. Lower-casing happens only in {@link cacheKeyFor}.
   */
  static normalizeQuery(query: string): string {
    return query.trim().replace(/\s+/g, ' ');
  }

  /**
   * Cache key for the query embedding: a keyed hash of the normalized query,
   * lower-cased, never the text. Two readers typing the same words with
   * different casing or spacing must not each buy an embedding call: the
   * vectors would be near-identical anyway, so whichever casing arrives first
   * is the one that gets embedded.
   */
  cacheKeyFor(normalized: string): string {
    const digest = createHmac('sha256', this.cacheSecret)
      .update(normalized.toLowerCase())
      .digest('hex');
    return `${EMBED_CACHE_PREFIX}${digest}`;
  }

  /** Clamp the caller's limit into `[1, MAX_SEARCH_LIMIT]`. */
  static clampLimit(limit?: number | null): number {
    if (limit == null || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
    return Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.floor(limit)));
  }

  async searchNews(
    query: string,
    limit?: number | null,
  ): Promise<NewsSearchHit[]> {
    const normalized = NewsSearchService.normalizeQuery(query);
    if (normalized.length === 0) return [];
    // Before any embedding or search call, and without echoing the text.
    if (normalized.length > MAX_QUERY_LENGTH) {
      throw new GraphQLError(
        `The query is longer than ${MAX_QUERY_LENGTH} characters. Shorten it.`,
        { extensions: { code: 'QUERY_TOO_LONG' } },
      );
    }
    // shortcut: the stored embedding model is not compared with the configured one, so a model change serves mismatched vectors until the corpus is re-embedded, add the check when the embedding meta document exists.

    const effectiveLimit = NewsSearchService.clampLimit(limit);
    const annLimit = effectiveLimit * ANN_OVERFETCH;
    const cutoffDate = new Date(Date.now() - CUTOFF_HOURS * 60 * 60 * 1000);

    // Concurrent, and each leg is allowed to fail on its own. This is the
    // shape the feed learned the hard way: a provider error hard-failing the
    // whole query turned into a bare 500 with a blank screen behind it.
    const [lexical, semantic] = await Promise.allSettled([
      this.runLexicalLeg(normalized, annLimit, cutoffDate),
      this.runSemanticLeg(normalized, annLimit, cutoffDate),
    ]);

    if (lexical.status === 'rejected' && semantic.status === 'rejected') {
      this.logger.error(
        `searchNews: both legs failed. lexical=${describeError(lexical.reason)} ` +
          `semantic=${describeError(semantic.reason)}`,
      );
      throw new GraphQLError('Search is unavailable right now.', {
        extensions: { code: 'SEARCH_UNAVAILABLE' },
      });
    }
    if (lexical.status === 'rejected') {
      // The expected cause in a deployment without the text index is a missing
      // `news_article_text_index`. Semantic-only is a degraded answer, not an
      // error, so say so at warn and serve it.
      this.logger.warn(
        `searchNews: lexical leg failed, serving semantic-only. ${describeError(lexical.reason)}`,
      );
    }
    if (semantic.status === 'rejected') {
      this.logger.warn(
        `searchNews: semantic leg failed, serving lexical-only. ${describeError(semantic.reason)}`,
      );
    }

    const lexicalRows = lexical.status === 'fulfilled' ? lexical.value : [];
    const semanticRows = semantic.status === 'fulfilled' ? semantic.value : [];

    const fused = fuseByReciprocalRank<ArticleRow>(
      [
        { rows: lexicalRows, weight: LEXICAL_WEIGHT },
        { rows: semanticRows, weight: SEMANTIC_WEIGHT },
      ],
      (row) => String(row._id),
    );

    // Collapse near-duplicates BEFORE slicing. Slicing first would hand the
    // limit to whichever story happened to be most syndicated.
    const collapsed = await this.collapseFusedByStory(fused);

    const sliced = collapsed.slice(0, effectiveLimit);
    if (sliced.length === 0) return [];

    const pubById = await this.fetchPublicationSources(
      sliced.map((entry) => entry.row),
    );

    return sliced.map(({ row: r, score }) => {
      const pub = pubById.get(
        (r.publicationSourceId as Types.ObjectId)?.toString() ?? '',
      );
      return {
        _id: (r._id as Types.ObjectId).toString(),
        title_en:
          (r.title_en as string | undefined) ??
          (r.title_en_internal_only as string | undefined) ??
          (r.title as string | undefined) ??
          '',
        image_url: r.image_url as string | undefined,
        publication_name: pub?.publication_name,
        country_code: pub?.country_code,
        pubDate: (
          (r.pubDate as Date | undefined) ??
          (r.createdAt as Date | undefined) ??
          new Date()
        ).toISOString(),
        score,
      };
    });
  }

  /**
   * Look up the story each fused row belongs to and collapse duplicates.
   *
   * One `cluster-article-link` query over the whole candidate set, served by
   * the `{articleId, confidence}` index. A row can legitimately sit in more
   * than one cluster (article-to-cluster is many-to-many), so the FIRST link
   * returned wins, an arbitrary but stable choice within a request, which is
   * all the grouping needs.
   *
   * Fails OPEN: if the lookup throws, return the uncollapsed list rather than
   * losing the search. Duplicate results are a worse page; no results is a
   * broken feature.
   */
  private async collapseFusedByStory(
    fused: { row: ArticleRow; score: number }[],
  ): Promise<{ row: ArticleRow; score: number }[]> {
    if (fused.length === 0) return fused;

    try {
      const ids = fused.map((e) => new Types.ObjectId(String(e.row._id)));
      const links = await this.clusterArticleLinkModel
        .find({ articleId: { $in: ids } })
        .select('articleId clusterId')
        .lean()
        .exec();

      const clusterByArticle = new Map<string, string>();
      for (const link of links as unknown as {
        articleId: Types.ObjectId;
        clusterId: Types.ObjectId;
      }[]) {
        const key = link.articleId.toString();
        if (!clusterByArticle.has(key)) {
          clusterByArticle.set(key, link.clusterId.toString());
        }
      }

      const collapsed = collapseByStory(
        fused,
        (e) => String(e.row._id),
        (articleId) => clusterByArticle.get(articleId),
        (e) =>
          (e.row.title_en as string | undefined) ??
          (e.row.title_en_internal_only as string | undefined) ??
          (e.row.title as string | undefined),
      );
      if (collapsed.length < fused.length) {
        this.logger.log(
          `searchNews story-collapse: ${fused.length} -> ${collapsed.length}`,
        );
      }
      return collapsed;
    } catch (error) {
      this.logger.warn(
        `searchNews: story collapse failed, serving duplicates. ${describeError(error)}`,
      );
      return fused;
    }
  }

  /**
   * Lexical leg: Atlas Search over the English text, plus the original-language
   * title so a native-language query still lands.
   *
   * NOTE THE FIELD NAMES. `title_en` / `description_en` are the v3 names and are
   * not populated by the pipeline, which writes
   * `title_en_internal_only` / `description_en_internal_only`.
   * The `@deprecated` markers on the model are inverted relative to reality.
   * An index or a query built on `title_en` matches nothing at all.
   *
   * No lexical post-filter on either leg: a BM25 hit already contains the
   * query's terms, and a place filter on the vector leg made any capitalized
   * token ("Apple iPhone 17 launch") a mandatory literal.
   */
  private async runLexicalLeg(
    normalized: string,
    annLimit: number,
    cutoffDate: Date,
  ): Promise<ArticleRow[]> {
    // `any[]`: mongoose's `PipelineStage` union does not model `$search`.
    const pipeline: any[] = [
      {
        $search: {
          index: LEXICAL_SEARCH_INDEX,
          compound: {
            should: [
              // The reported symptom is "I typed the headline and got
              // nothing", so a near-verbatim title match has to dominate.
              {
                phrase: {
                  query: normalized,
                  path: ['title_en_internal_only', 'title'],
                  slop: 2,
                  score: { boost: { value: 8 } },
                },
              },
              {
                text: {
                  query: normalized,
                  path: 'title_en_internal_only',
                  score: { boost: { value: 4 } },
                },
              },
              {
                text: {
                  query: normalized,
                  path: 'title',
                  score: { boost: { value: 3 } },
                },
              },
              {
                text: {
                  query: normalized,
                  path: 'description_en_internal_only',
                },
              },
              // One typo tolerated, never on the first two characters (a
              // prefixLength of 0 makes short queries match almost anything).
              {
                text: {
                  query: normalized,
                  path: [
                    'title_en_internal_only',
                    'description_en_internal_only',
                  ],
                  fuzzy: { maxEdits: 1, prefixLength: 2 },
                  score: { boost: { value: 0.5 } },
                },
              },
            ],
            minimumShouldMatch: 1,
            // Recency rides INSIDE `$search`, same reasoning as the ANN's
            // pre-filter: the alternative scores the whole collection and then
            // throws the stale half away.
            filter: [{ range: { path: 'createdAt', gte: cutoffDate } }],
          },
        },
      },
      // `$limit` IMMEDIATELY after `$search` so Atlas pushes it down into the
      // lucene query. Anything between the two (even the `$addFields` that
      // reads the score) can defeat the pushdown, and without it `$search`
      // materializes every match, over a 48h window holding ~325k documents,
      // a one-common-word query matches a very large fraction of them.
      // The url-security `$match` therefore runs AFTER the limit: insecure
      // rows are ~0.07% of the corpus, so filtering late costs a rounding
      // error and limiting late costs the whole result set.
      { $limit: annLimit },
      { $addFields: { score: { $meta: 'searchScore' } } },
      // POST-`$search`, not a `compound.filter`: `$ne` semantics matter here:
      // an ABSENT `url_security_state` means "never evaluated" and those rows
      // must keep serving, which a positive index filter cannot express.
      { $match: { ...SERVABLE_URL_SECURITY_FILTER } },
      { $project: { ...RETRIEVAL_PROJECTION } },
    ];

    return this.newsArticleModel.aggregate<ArticleRow>(pipeline).exec();
  }

  /**
   * Semantic leg: unchanged `$vectorSearch` and a search-local floor.
   */
  private async runSemanticLeg(
    normalized: string,
    annLimit: number,
    cutoffDate: Date,
  ): Promise<ArticleRow[]> {
    const queryEmbedding = await this.embedQuery(normalized);

    // `createdAt` is a PRE-filter INSIDE `$vectorSearch`, never a later
    // `$match`. The index declares it as a `{type:'filter'}` field, so the ANN
    // only ever considers documents inside the window. The alternative,
    // filtering after the ANN, spends the entire candidate budget on the full
    // collection and then throws the stale hits away, which is why
    // `news-article.service.ts`'s `searchVector` needs `numCandidates: 5000`
    // to return anything useful. Do NOT copy that shape here.
    // `any[]`: mongoose's `PipelineStage` union does not model `$vectorSearch`.
    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: 'embedding_article_data_retrieval_index',
          path: 'embedding_article_data_retrieval',
          queryVector: queryEmbedding,
          numCandidates: annLimit * NUM_CANDIDATES_PER_RESULT,
          limit: annLimit,
          filter: { createdAt: { $gte: cutoffDate } },
        },
      },
      { $addFields: { score: { $meta: 'vectorSearchScore' } } },
      // POST-ANN, not a `$vectorSearch` filter: `url_security_state` is NOT a
      // declared filter field on the Atlas index, so it cannot ride inside the
      // ANN stage. `$ne: 'insecure'` (never `$in`), an ABSENT field means
      // "never evaluated" and those rows must keep serving.
      {
        $match: {
          ...SERVABLE_URL_SECURITY_FILTER,
          score: { $gte: this.minScore },
        },
      },
      { $limit: annLimit },
      { $project: { ...RETRIEVAL_PROJECTION } },
    ];

    return this.newsArticleModel.aggregate<ArticleRow>(pipeline).exec();
  }

  /**
   * Embed the (normalized) query with task `retrieval.query`, cached 30 minutes
   * on the normalized string. A search box produces many near-identical
   * requests as the user retypes; each cache miss is a paid embedding call.
   *
   * The `AbortSignal` is the reason this can be a leg rather than the whole
   * request: without a deadline the lexical results sit behind an unbounded
   * provider tail, and "hybrid search" degrades to "as slow as the provider's worst
   * minute". The port has always taken a signal; nothing used to pass one.
   */
  private async embedQuery(normalized: string): Promise<number[]> {
    const key = this.cacheKeyFor(normalized);
    const cached = await this.cacheManager.get<number[]>(key);
    if (cached && cached.length > 0) return cached;

    const [vector] = await this.embeddingProvider.embed(
      [normalized],
      AbortSignal.timeout(this.embedTimeoutMs),
      'retrieval.query',
    );
    await this.cacheManager.set(key, vector, EMBED_CACHE_TTL_MS);
    return vector;
  }

  private async fetchPublicationSources(
    rows: ArticleRow[],
  ): Promise<Map<string, PublicationSourceLean>> {
    const ids = Array.from(
      new Set(
        rows
          .map((r) => (r.publicationSourceId as Types.ObjectId)?.toString())
          .filter(Boolean),
      ),
    ).map((id) => new Types.ObjectId(id));
    if (ids.length === 0) return new Map();

    const sources = (await this.publicationSourceModel
      .find({ _id: { $in: ids } })
      .select('publication_name country_code')
      .lean()
      .exec()) as unknown as PublicationSourceLean[];

    return new Map(sources.map((p) => [p._id.toString(), p]));
  }
}
