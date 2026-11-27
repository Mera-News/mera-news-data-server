import { Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { QueryFilter, Model, Types } from 'mongoose';
import {
  NewsArticle,
  NewsArticleDocument,
} from '@mera/models/models/news-article.model';
import {
  PublicationSource,
  PublicationSourceDocument,
} from '@mera/models/models/publication-source.model';
import {
  HeadlineEdition,
  HeadlineEditionDocument,
} from '@mera/models/models/headline-edition.model';
import {
  encodeCursor,
  decodeCursor,
  BaseCursorPayload,
  CreatedAtCursor,
  buildCreatedAtCursorFilter,
  articleUrlKey,
} from '@mera/shared';
import { SERVABLE_URL_SECURITY_FILTER } from '@mera/shared/url/url-security';
import { Inject } from '@nestjs/common';
import {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from '../embedding-provider/embedding-provider.port';
import { ArticlesForPublicationSourceResponse } from './dto/articles-for-publication-source-response.dto';
import { EmbeddingSearchResponse } from './dto/embedding-search-response.dto';
import {
  DEFAULT_PAGE_SIZE,
  HEAVY_ARTICLE_FIELDS_EXCLUSION,
} from '../constants';
import { toHeadlineScopeKey } from '../headline-scope/headline-scope-key';
import { pickEditionCard } from '../world-headlines/reading-rank';

const MS_PER_HOUR = 60 * 60 * 1000;
const TOP_HEADLINES_WINDOW_HOURS = 24;
/**
 * `NEWEST` spans an article's whole life: rows TTL out of `news-article` at
 * 48h, so this window is a belt for stragglers the TTL monitor has not reaped.
 */
const NEWEST_WINDOW_HOURS = 48;
/**
 * Page-size ceiling for `NEWEST`. The top-headlines path has no clamp (its
 * 24h window bounds it); this one is a plain newest-first scan, so the caller
 * must not be able to ask for the whole 48h in one page.
 */
export const MAX_NEWEST_PAGE_SIZE = 50;

/**
 * How `articlesForPublisher` orders a publisher's articles.
 * `TOP_HEADLINES` is the original behaviour and the default; `NEWEST` is
 * newest first across all of the publisher's feeds.
 */
export type PublisherArticleSort = 'TOP_HEADLINES' | 'NEWEST';
// Top-headline candidate pools are user-independent and only change hourly
// (clustering :20 cron), so a short cache spares the whole-window aggregation.
const TOP_HEADLINES_CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * How old a `headline-edition` doc may be before the persona headline path
 * stops trusting it and falls back to the live aggregation. Editions are
 * rebuilt once per clustering run (hourly, :20 cron), so this allows roughly
 * two build cycles plus slack. Overridable via
 * `HEADLINE_EDITION_MAX_AGE_MINUTES`.
 */
const HEADLINE_EDITION_MAX_AGE_MINUTES = 150;

/**
 * Compound keyset cursor for the "top headlines" sort
 * (maxClusterSize desc, createdAt desc, _id desc).
 */
interface ClusterSizeCursor extends BaseCursorPayload {
  maxClusterSize: number;
  createdAt: string; // ISO 8601
}

/**
 * Persona query: a lean top-headline candidate — the article id, its largest
 * live cluster's size + identity, for cluster-dedup before returning to the app.
 */
export interface HeadlineCandidate {
  articleId: string;
  maxClusterSize: number;
  largestClusterId: string | null;
  stableClusterId: string | null;
}

@Injectable()
export class NewsArticleService {
  private readonly logger = new Logger(NewsArticleService.name);
  /** Max trusted edition age (ms) — see `HEADLINE_EDITION_MAX_AGE_MINUTES`. */
  private readonly headlineEditionMaxAgeMs: number;

  constructor(
    @InjectModel(NewsArticle.name)
    private newsArticleModel: Model<NewsArticleDocument>,
    @InjectModel(PublicationSource.name)
    private publicationSourceModel: Model<PublicationSourceDocument>,
    @Inject(EMBEDDING_PROVIDER)
    private readonly embeddingProvider: EmbeddingProvider,
    @Inject(CACHE_MANAGER)
    private readonly cacheManager: Cache,
    @InjectModel(HeadlineEdition.name)
    private readonly headlineEditionModel: Model<HeadlineEditionDocument>,
    private readonly configService: ConfigService,
  ) {
    // ConfigService returns the raw string when the env var is set, so coerce
    // and fall back to the constant on anything non-finite.
    const configured = Number(
      this.configService.get(
        'HEADLINE_EDITION_MAX_AGE_MINUTES',
        HEADLINE_EDITION_MAX_AGE_MINUTES,
      ),
    );
    const minutes =
      Number.isFinite(configured) && configured > 0
        ? configured
        : HEADLINE_EDITION_MAX_AGE_MINUTES;
    this.headlineEditionMaxAgeMs = minutes * 60 * 1000;
  }

  async articleById(id: string): Promise<NewsArticle | null> {
    if (!Types.ObjectId.isValid(id)) {
      return null;
    }
    // Easy to overlook, but it emits a full article row —
    // `article_url` included — for any id a client asks for, so leaving it
    // unfiltered would be a single-query bypass of every other filter. An
    // insecure article now reads as "not found", the same shape a TTL'd-out one
    // already has.
    const article = await this.newsArticleModel
      .findOne({
        _id: new Types.ObjectId(id),
        ...SERVABLE_URL_SECURITY_FILTER,
      })
      .populate({ path: 'publicationSourceId', options: { lean: true } })
      .lean()
      .exec();
    if (!article) return null;
    // Mirror what the cluster.articles resolver does — the @Field
    // `publicationSource` is a virtual, so we have to copy the populated doc
    // over from `publicationSourceId` for GraphQL to see it.
    return {
      ...article,
      publicationSource: article.publicationSourceId,
    } as unknown as NewsArticle;
  }

  /**
   * Shared "top headlines" building block: articles matching `baseMatch`,
   * published within the last 24h, sorted by their largest live cluster size
   * (a bigger cluster = a more widely-covered story), keyset-paginated.
   *
   * An article can belong to several clusters (cluster-article-link is
   * many-to-many); we rank by the *largest* of those clusters' sizes. Articles
   * with no live cluster get maxClusterSize 0 and sort last.
   */
  private async topHeadlines(
    baseMatch: QueryFilter<NewsArticleDocument>,
    first: number = DEFAULT_PAGE_SIZE,
    after?: string,
    windowHours: number = TOP_HEADLINES_WINDOW_HOURS,
    skip = 0,
  ): Promise<ArticlesForPublicationSourceResponse> {
    const cutoff = new Date(Date.now() - windowHours * MS_PER_HOUR);

    // One filter covers `articlesForPublicationSource`, `articlesForPublisher`
    // and `articlesForCountry` — they all funnel through this builder, and
    // `articlesForCountry` is also the cold-scope fallback for the Explore tab.
    const pipeline: any[] = [
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: cutoff },
          ...SERVABLE_URL_SECURITY_FILTER,
        },
      },
      {
        $lookup: {
          from: 'cluster-article-link',
          localField: '_id',
          foreignField: 'articleId',
          as: 'clusterLinks',
        },
      },
      {
        $lookup: {
          from: 'news-cluster',
          localField: 'clusterLinks.clusterId',
          foreignField: '_id',
          as: 'clusters',
        },
      },
      {
        $addFields: {
          maxClusterSize: { $ifNull: [{ $max: '$clusters.clusterSize' }, 0] },
        },
      },
    ];

    if (after) {
      const c = decodeCursor<ClusterSizeCursor>(after);
      if (c) {
        const cursorCreatedAt = new Date(c.createdAt);
        const cursorId = new Types.ObjectId(c._id);
        pipeline.push({
          $match: {
            $or: [
              { maxClusterSize: { $lt: c.maxClusterSize } },
              {
                maxClusterSize: c.maxClusterSize,
                createdAt: { $lt: cursorCreatedAt },
              },
              {
                maxClusterSize: c.maxClusterSize,
                createdAt: cursorCreatedAt,
                _id: { $lt: cursorId },
              },
            ],
          },
        });
      }
    }

    pipeline.push(
      { $sort: { maxClusterSize: -1, createdAt: -1, _id: -1 } },
      ...(skip > 0 ? [{ $skip: skip }] : []),
      { $limit: first + 1 },
      // Re-attach the `publicationSource` virtual (mirrors `articleById`) and
      // drop the heavy join arrays + select:false embedding vectors that
      // aggregation would otherwise hydrate (a 1 GiB heap is enough otherwise).
      {
        $lookup: {
          from: 'publication-source',
          localField: 'publicationSourceId',
          foreignField: '_id',
          as: 'publicationSource',
        },
      },
      {
        $unwind: {
          path: '$publicationSource',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          clusterLinks: 0,
          clusters: 0,
          ...HEAVY_ARTICLE_FIELDS_EXCLUSION,
        },
      },
    );

    const results = await this.newsArticleModel.aggregate(pipeline).exec();

    const hasNextPage = results.length > first;
    const articles = (hasNextPage ? results.slice(0, first) : results) as Array<
      NewsArticle & { maxClusterSize?: number; createdAt: Date }
    >;

    const itemCursors = articles.map((item) =>
      encodeCursor<ClusterSizeCursor>({
        maxClusterSize: item.maxClusterSize ?? 0,
        createdAt: new Date(item.createdAt).toISOString(),
        _id: item._id.toString(),
      }),
    );

    return {
      articles: articles as unknown as NewsArticle[],
      pageInfo: {
        endCursor: itemCursors.at(-1) ?? null,
        hasNextPage,
        pageSize: first,
      },
      itemCursors,
    };
  }

  /**
   * Top headlines for a single feed (publication source): its last-24h
   * articles sorted by largest cluster size.
   */
  async articlesForPublicationSource(
    publicationSourceId: string,
    first: number = DEFAULT_PAGE_SIZE,
    after?: string,
  ): Promise<ArticlesForPublicationSourceResponse> {
    return this.topHeadlines(
      { publicationSourceId: new Types.ObjectId(publicationSourceId) },
      first,
      after,
    );
  }

  /**
   * Top headlines aggregated across all of a publisher's feeds.
   */
  async articlesForPublisher(
    newsPublisherId: string,
    first: number = DEFAULT_PAGE_SIZE,
    after?: string,
    order: PublisherArticleSort = 'TOP_HEADLINES',
  ): Promise<ArticlesForPublicationSourceResponse> {
    const sourceIds = await this.publicationSourceIdsFor({
      newsPublisherId: new Types.ObjectId(newsPublisherId),
    });
    if (order === 'NEWEST') {
      return this.newestArticles(
        { publicationSourceId: { $in: sourceIds } },
        first,
        after,
      );
    }
    return this.topHeadlines(
      { publicationSourceId: { $in: sourceIds } },
      first,
      after,
    );
  }

  /**
   * Newest first (`createdAt` desc, `_id` desc) over the full 48h article
   * life, keyset-paginated on `{createdAt, _id}`. No cluster lookups, so it is
   * served by the `{publicationSourceId: 1, createdAt: -1}` index.
   *
   * DEDUPED BY CANONICAL URL within the page: a publisher's feeds overlap (a
   * story sits in "top stories" and in its section feed), and without this the
   * same article appears twice in a row. The first occurrence in sort order
   * (the newest ingest) wins. `endCursor` is the last RAW row of the page, not
   * the last kept one, so a dropped duplicate still advances the cursor.
   * A duplicate that straddles a page boundary is not caught; the app's list
   * dedupes by id, and by then the two rows have different ids, so this is an
   * accepted rare repeat rather than a stall.
   */
  private async newestArticles(
    baseMatch: QueryFilter<NewsArticleDocument>,
    first: number,
    after?: string,
  ): Promise<ArticlesForPublicationSourceResponse> {
    const pageSize = Math.min(
      Math.max(1, Math.floor(Number(first) || DEFAULT_PAGE_SIZE)),
      MAX_NEWEST_PAGE_SIZE,
    );
    const cutoff = new Date(Date.now() - NEWEST_WINDOW_HOURS * MS_PER_HOUR);

    const pipeline: any[] = [
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: cutoff },
          ...SERVABLE_URL_SECURITY_FILTER,
        },
      },
    ];

    if (after) {
      const c = decodeCursor<CreatedAtCursor>(after);
      if (c && c.createdAt && Types.ObjectId.isValid(c._id)) {
        pipeline.push({ $match: buildCreatedAtCursorFilter(c) });
      }
    }

    pipeline.push(
      { $sort: { createdAt: -1, _id: -1 } },
      { $limit: pageSize + 1 },
      {
        $lookup: {
          from: 'publication-source',
          localField: 'publicationSourceId',
          foreignField: '_id',
          as: 'publicationSource',
        },
      },
      {
        $unwind: {
          path: '$publicationSource',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: { ...HEAVY_ARTICLE_FIELDS_EXCLUSION },
      },
    );

    const results = (await this.newsArticleModel
      .aggregate(pipeline)
      .exec()) as Array<NewsArticle & { createdAt: Date }>;

    const hasNextPage = results.length > pageSize;
    const page = hasNextPage ? results.slice(0, pageSize) : results;

    const seen = new Set<string>();
    const articles = page.filter((article) => {
      const url = article.article_url;
      if (typeof url !== 'string' || url.trim() === '') return true;
      const key = articleUrlKey(url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const cursorOf = (row: { createdAt: Date; _id: unknown }) =>
      encodeCursor<CreatedAtCursor>({
        createdAt: new Date(row.createdAt).toISOString(),
        _id: String(row._id),
      });
    const lastRaw = page.at(-1);

    return {
      articles: articles as unknown as NewsArticle[],
      pageInfo: {
        endCursor: lastRaw ? cursorOf(lastRaw) : null,
        hasNextPage,
        pageSize,
      },
      itemCursors: articles.map(cursorOf),
    };
  }

  /**
   * Top headlines across all of a country's sources, or with `NEWEST` its
   * newest articles. A null/"GLOBAL" countryCode drops the source filter (all
   * countries).
   */
  async articlesForCountry(
    countryCode: string | null | undefined,
    first: number = DEFAULT_PAGE_SIZE,
    after?: string,
    windowHours: number = TOP_HEADLINES_WINDOW_HOURS,
    order: PublisherArticleSort = 'TOP_HEADLINES',
  ): Promise<ArticlesForPublicationSourceResponse> {
    const baseMatch = await this.countryMatch(countryCode);
    if (order === 'NEWEST') {
      return this.newestArticles(baseMatch, first, after);
    }
    return this.topHeadlines(baseMatch, first, after, windowHours);
  }

  /**
   * The `articlesForCountry` top-headline order read at a position instead of
   * after a keyset cursor: the cold-scope fallback of `topHeadlinesForCountry`
   * pages by offset, as its editions do.
   */
  async articlesForCountryAtOffset(
    countryCode: string | null | undefined,
    offset: number,
    first: number,
    windowHours: number = TOP_HEADLINES_WINDOW_HOURS,
  ): Promise<ArticlesForPublicationSourceResponse> {
    return this.topHeadlines(
      await this.countryMatch(countryCode),
      first,
      undefined,
      windowHours,
      offset,
    );
  }

  private async countryMatch(
    countryCode: string | null | undefined,
  ): Promise<QueryFilter<NewsArticleDocument>> {
    if (!countryCode || countryCode === 'GLOBAL') return {};
    const sourceIds = await this.publicationSourceIdsFor({
      country_code: countryCode,
    });
    return { publicationSourceId: { $in: sourceIds } };
  }

  /**
   * Persona query: lean top-headline candidates for a scope — the article id, its
   * cluster's size + identity, so the caller can cluster-dedup before returning
   * to the app. A null/"GLOBAL" countryCode spans all countries.
   *
   * Served from the precomputed `headline-edition` collection (the same source
   * the Explore tab's `topHeadlinesForCountry` reads), so the For You feed's
   * headline scopes rank by exactly the same logic — notably the GLOBAL
   * edition's cross-market BREADTH ranking, which the old per-request
   * aggregation (raw `maxClusterSize` desc) did not have. Edition entries are
   * already ordered by `rank` and cluster-deduplicated; we take the first
   * `poolSize` in that order and deliberately do NOT re-sort by size.
   *
   * Falls back to the live aggregation when the scope has no edition, has an
   * empty one, or has one older than `HEADLINE_EDITION_MAX_AGE_MINUTES`.
   */
  async topHeadlineCandidates(
    countryCode: string | null | undefined,
    poolSize: number,
    language: string | null = null,
  ): Promise<HeadlineCandidate[]> {
    // This result is user-independent per (scope, countryCode, poolSize) and
    // only changes hourly (clustering :20 cron), so cache the candidate list
    // for 10 min — TTL-only invalidation — to skip the edition read (or, on the
    // fallback path, the whole-window aggregation).
    const useCountryFilter = Boolean(countryCode && countryCode !== 'GLOBAL');
    const cacheKey = `top-headlines:${
      useCountryFilter ? 'country' : 'global'
    }:${useCountryFilter ? countryCode : 'global'}:${poolSize}:${language ?? '-'}`;

    const cached = await this.cacheManager.get<HeadlineCandidate[]>(cacheKey);
    if (cached) return cached;

    const candidates =
      (await this.headlineEditionCandidates(countryCode, poolSize, language)) ??
      (await this.topHeadlineCandidatesLive(countryCode, poolSize));

    await this.cacheManager.set(
      cacheKey,
      candidates,
      TOP_HEADLINES_CACHE_TTL_MS,
    );
    return candidates;
  }

  /**
   * Read one scope's precomputed edition and project it onto `HeadlineCandidate`.
   * Returns null (caller falls back to the live aggregation) when the edition is
   * missing, empty, or stale — each case logged at `warn` with the scope + age so
   * a silently-stale edition is visible.
   *
   * Field mapping: the edition's `clusterSize` (the build run's single
   * highest-confidence link) stands in for the aggregation's `maxClusterSize`
   * (the largest of an article's several linked clusters), and `clusterId` for
   * `largestClusterId`. The caller (`resolveHeadlineScopes`) uses the former only
   * for display and the latter only as a dedup key, so the two are
   * interchangeable there.
   */
  private async headlineEditionCandidates(
    countryCode: string | null | undefined,
    poolSize: number,
    language: string | null = null,
  ): Promise<HeadlineCandidate[] | null> {
    const scopeKey = toHeadlineScopeKey(countryCode);

    let edition: HeadlineEdition | null;
    try {
      edition = await this.headlineEditionModel
        .findOne({ scopeKey })
        // `entries` is the 24h list; the other views are never read here.
        .select('-views')
        .lean<HeadlineEdition | null>()
        .exec();
    } catch (err) {
      this.logger.warn(
        `topHeadlineCandidates: headline-edition read failed for scope ${scopeKey} (${
          (err as Error).message
        }) — falling back to the live aggregation`,
      );
      return null;
    }

    if (!edition) {
      this.logger.warn(
        `topHeadlineCandidates: no headline-edition for scope ${scopeKey} — falling back to the live aggregation`,
      );
      return null;
    }

    const builtAtMs = edition.builtAt
      ? new Date(edition.builtAt).getTime()
      : NaN;
    // A missing/unparseable builtAt counts as stale — never "fresh by NaN".
    if (!Number.isFinite(builtAtMs)) {
      this.logger.warn(
        `topHeadlineCandidates: headline-edition for scope ${scopeKey} has no usable builtAt — falling back to the live aggregation`,
      );
      return null;
    }

    const ageMs = Date.now() - builtAtMs;
    if (ageMs > this.headlineEditionMaxAgeMs) {
      this.logger.warn(
        `topHeadlineCandidates: headline-edition for scope ${scopeKey} is stale (age ${Math.round(
          ageMs / 60000,
        )}m > ${Math.round(
          this.headlineEditionMaxAgeMs / 60000,
        )}m) — falling back to the live aggregation`,
      );
      return null;
    }

    // `entries` is the 24h list, the view Explore defaults to, so both paths
    // rank identically.
    const entries = edition.entries ?? [];
    if (entries.length === 0) {
      this.logger.warn(
        `topHeadlineCandidates: headline-edition for scope ${scopeKey} is empty (age ${Math.round(
          ageMs / 60000,
        )}m) — falling back to the live aggregation`,
      );
      return null;
    }

    return entries.slice(0, poolSize).map((e) => ({
      articleId: pickEditionCard(e, language).toString(),
      maxClusterSize: e.clusterSize ?? 0,
      largestClusterId: e.clusterId ? e.clusterId.toString() : null,
      stableClusterId: e.stableClusterId ?? null,
    }));
  }

  /**
   * The pre-edition serve path, kept as the fallback: the same 24h window and
   * `maxClusterSize` ranking as `topHeadlines`, projecting only the ids/sizes the
   * persona query needs (no article hydration, no keyset cursor) and resolving
   * the article's LARGEST linked cluster (its _id + stableClusterId).
   * Returns up to `poolSize` candidates sorted by maxClusterSize desc.
   */
  private async topHeadlineCandidatesLive(
    countryCode: string | null | undefined,
    poolSize: number,
  ): Promise<HeadlineCandidate[]> {
    let baseMatch: QueryFilter<NewsArticleDocument> = {};
    if (countryCode && countryCode !== 'GLOBAL') {
      const sourceIds = await this.publicationSourceIdsFor({
        country_code: countryCode,
      });
      baseMatch = { publicationSourceId: { $in: sourceIds } };
    }

    const cutoff = new Date(
      Date.now() - TOP_HEADLINES_WINDOW_HOURS * MS_PER_HOUR,
    );

    const pipeline: any[] = [
      {
        $match: {
          ...baseMatch,
          createdAt: { $gte: cutoff },
          ...SERVABLE_URL_SECURITY_FILTER,
        },
      },
      {
        $lookup: {
          from: 'cluster-article-link',
          localField: '_id',
          foreignField: 'articleId',
          as: 'clusterLinks',
        },
      },
      {
        $lookup: {
          from: 'news-cluster',
          localField: 'clusterLinks.clusterId',
          foreignField: '_id',
          as: 'clusters',
        },
      },
      // Reduce to the single largest cluster (by clusterSize) for this article.
      {
        $addFields: {
          largestCluster: {
            $reduce: {
              input: '$clusters',
              initialValue: null,
              in: {
                $cond: [
                  {
                    $or: [
                      { $eq: ['$$value', null] },
                      {
                        $gt: [
                          { $ifNull: ['$$this.clusterSize', 0] },
                          { $ifNull: ['$$value.clusterSize', 0] },
                        ],
                      },
                    ],
                  },
                  '$$this',
                  '$$value',
                ],
              },
            },
          },
        },
      },
      {
        $addFields: {
          maxClusterSize: { $ifNull: ['$largestCluster.clusterSize', 0] },
          largestClusterId: '$largestCluster._id',
          stableClusterId: '$largestCluster.stableClusterId',
        },
      },
      { $sort: { maxClusterSize: -1, createdAt: -1, _id: -1 } },
      { $limit: poolSize },
      {
        $project: {
          _id: 1,
          maxClusterSize: 1,
          largestClusterId: 1,
          stableClusterId: 1,
        },
      },
    ];

    const results = await this.newsArticleModel.aggregate(pipeline).exec();

    const candidates: HeadlineCandidate[] = results.map(
      (r: Record<string, unknown>) => ({
        articleId: (r._id as Types.ObjectId).toString(),
        maxClusterSize: (r.maxClusterSize as number) ?? 0,
        largestClusterId: r.largestClusterId
          ? (r.largestClusterId as Types.ObjectId).toString()
          : null,
        stableClusterId: (r.stableClusterId as string | undefined) ?? null,
      }),
    );

    return candidates;
  }

  private async publicationSourceIdsFor(
    filter: QueryFilter<PublicationSourceDocument>,
  ): Promise<Types.ObjectId[]> {
    const sources = await this.publicationSourceModel
      .find(filter)
      .select('_id')
      .lean()
      .exec();
    return sources.map((s) => s._id as Types.ObjectId);
  }

  async searchVector(
    queryText: string,
    limit = 10,
    minScore = 0,
    numCandidates = 5000,
    cutoffHours?: number,
  ): Promise<EmbeddingSearchResponse> {
    const [queryEmbedding] = await this.embeddingProvider.embed(
      [queryText],
      undefined,
      'retrieval.query',
    );

    const pipeline: any[] = [
      {
        $vectorSearch: {
          index: 'embedding_article_data_retrieval_index',
          path: 'embedding_article_data_retrieval',
          queryVector: queryEmbedding,
          numCandidates,
          limit,
        },
      },
      {
        $addFields: {
          score: { $meta: 'vectorSearchScore' },
        },
      },
      // POST-ANN: `url_security_state` is not a declared filter field on the
      // Atlas vector index, so the exclusion cannot ride inside $vectorSearch.
      { $match: { ...SERVABLE_URL_SECURITY_FILTER } },
    ];

    if (cutoffHours) {
      const cutoffDate = new Date(Date.now() - cutoffHours * 60 * 60 * 1000);
      pipeline.push({ $match: { createdAt: { $gte: cutoffDate } } });
    }

    if (minScore > 0) {
      pipeline.push({ $match: { score: { $gte: minScore } } });
    }

    pipeline.push(
      { $limit: limit },
      { $project: HEAVY_ARTICLE_FIELDS_EXCLUSION },
    );

    const results = await this.newsArticleModel.aggregate(pipeline).exec();

    return {
      results: results.map((r: Record<string, unknown>) => ({
        article: r as unknown as NewsArticle,
        score: r.score as number,
      })),
      query: queryText,
      totalResults: results.length,
    };
  }
}
