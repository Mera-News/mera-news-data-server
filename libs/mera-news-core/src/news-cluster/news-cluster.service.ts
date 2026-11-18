import {
  Injectable,
  Logger,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types, QueryFilter, PipelineStage } from 'mongoose';
import {
  NewsCluster,
  NewsClusterDocument,
} from '@mera/models/models/news-cluster.model';
import {
  NewsArticle,
  NewsArticleDocument,
} from '@mera/models/models/news-article.model';
import {
  ClusterArticleLink,
  ClusterArticleLinkDocument,
} from '@mera/models/models/cluster-article-link.model';
import { encodeCursor, decodeCursor, BaseCursorPayload } from '@mera/shared';
import { SERVABLE_URL_SECURITY_FILTER } from '@mera/shared/url/url-security';
import { vectorMinScore } from '@mera/shared/embedding-provider/embedding-config';
import { Inject } from '@nestjs/common';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '@mera/news-core';
import { NewsClustersResponse } from './dto/news-clusters-response.dto';
import { ClusterArticlesConnection } from './dto/cluster-articles-connection.dto';
import { ClusterMembership } from '../articles-for-topics/dto/articles-for-topics.dto';
import { DEFAULT_PAGE_SIZE } from '../constants';

const OBJECT_ID_HEX = /^[0-9a-f]{24}$/i;

/** Most member articles one page of a cluster may hold. */
export const MAX_ARTICLES_PER_CLUSTER_PAGE = 50;

@Injectable()
export class NewsClusterService {
  private readonly logger = new Logger(NewsClusterService.name);
  private readonly minScore: number;

  constructor(
    @InjectModel(NewsCluster.name)
    private newsClusterModel: Model<NewsClusterDocument>,
    @InjectModel(ClusterArticleLink.name)
    private clusterArticleLinkModel: Model<ClusterArticleLinkDocument>,
    @InjectModel(NewsArticle.name)
    private newsArticleModel: Model<NewsArticleDocument>,
    @Inject(EMBEDDING_PROVIDER)
    private readonly embeddingProvider: EmbeddingProvider,
    config: ConfigService,
  ) {
    this.minScore = vectorMinScore(config);
  }

  /**
   * Resolve the live cluster an article currently belongs to, via its newest
   * `cluster-article-link` (an article can be re-linked across clustering runs;
   * the most recent link is the live one). Returns null when the article has no
   * link or its cluster has TTL'd out. The `articles` @ResolveField then joins
   * on the returned cluster's `_id` unchanged.
   */
  async newsClusterForArticle(articleId: string): Promise<NewsCluster | null> {
    const link = await this.clusterArticleLinkModel
      .findOne({ articleId: new Types.ObjectId(articleId) })
      .sort({ createdAt: -1 })
      .lean()
      .exec();
    if (!link) {
      return null;
    }
    return this.newsClusterModel.findById(link.clusterId).exec();
  }

  /**
   * One page of a cluster's member articles, newest link first. The membership
   * score is a diagnostic: `exposeScores` false answers null for it, so the
   * ranking signal is not shown to callers.
   */
  async clusterArticles(
    clusterId: string,
    first: number | undefined,
    after: string | undefined,
    exposeScores: boolean,
  ): Promise<ClusterArticlesConnection> {
    const pageSize = Math.min(
      first ?? MAX_ARTICLES_PER_CLUSTER_PAGE,
      MAX_ARTICLES_PER_CLUSTER_PAGE,
    );

    const linkMatch: QueryFilter<ClusterArticleLinkDocument> = {
      clusterId: new Types.ObjectId(clusterId),
    };
    if (after) {
      const cursor = decodeCursor<{ createdAt: string; _id: string }>(after);
      if (cursor) {
        linkMatch.$or = [
          { createdAt: { $lt: new Date(cursor.createdAt) } },
          {
            createdAt: new Date(cursor.createdAt),
            _id: { $lt: new Types.ObjectId(cursor._id) },
          },
        ];
      }
    }

    const links = await this.clusterArticleLinkModel
      .find(linkMatch)
      .sort({ createdAt: -1, _id: -1 })
      .select('articleId createdAt confidence')
      .limit(pageSize + 1)
      .lean()
      .exec();

    const hasNextPage = links.length > pageSize;
    const pageLinks = hasNextPage ? links.slice(0, pageSize) : links;

    if (pageLinks.length === 0) {
      return {
        articles: [],
        pageInfo: { endCursor: null, hasNextPage: false, pageSize },
      };
    }

    const articleIds = pageLinks.map(
      (l) => new Types.ObjectId(l.articleId.toString()),
    );

    // This emits full article rows (`article_url` included) for every member of
    // a cluster, so it is a serving path. An insecure member is dropped from the
    // page exactly like an article that TTL'd out from under its link.
    const articles = await this.newsArticleModel
      .find({ _id: { $in: articleIds }, ...SERVABLE_URL_SECURITY_FILTER })
      .select(
        // Exclude BOTH text-matching variants: prod v1 writes the unsuffixed
        // field; `_internal_only` covers stray v3-drift docs.
        '-embedding_article_data_retrieval -embedding_article_data_text_matching -embedding_article_data_text_matching_internal_only',
      )
      .populate({ path: 'publicationSourceId', options: { lean: true } })
      .lean()
      .exec();

    // Preserve link order (Mongo `$in` doesn't honour input order) and
    // attach the per-link confidence onto each article as a virtual field
    // (clusterConfidence) so the client can show membership strength.
    const byId = new Map(articles.map((a) => [a._id.toString(), a]));
    const ordered = pageLinks
      .map((l) => {
        const article = byId.get(l.articleId.toString());
        if (!article) return undefined;
        return {
          ...article,
          publicationSource: article.publicationSourceId,
          clusterConfidence: exposeScores ? l.confidence : null,
        };
      })
      .filter((a): a is NonNullable<typeof a> =>
        Boolean(a),
      ) as unknown as NewsArticle[];

    const lastLink = pageLinks[pageLinks.length - 1];

    return {
      articles: ordered,
      pageInfo: {
        endCursor: encodeCursor({
          createdAt: lastLink.createdAt.toISOString(),
          _id: lastLink._id.toString(),
        }),
        hasNextPage,
        pageSize,
      },
    };
  }

  /**
   * Each article's memberships from ONE complete clustering generation, for the
   * app's hourly regroup of rows it already holds. Reads only links and cluster
   * docs, never `news-article`, and takes no user.
   *
   * A cluster is complete when its link count equals its `clusterSize` (> 0);
   * mid-swap or after a crashed run an article has links in two generations.
   * Per stableClusterId only the newest complete cluster survives, then per
   * article only the clusters of its newest surviving run, so a story that
   * split between runs never answers both halves.
   *
   * An article with no links answers `clusters: []` (the app clears); one with
   * links but none surviving is OMITTED (unknown, the app keeps its value).
   * Invalid ids are dropped before any read. Response order is not request order.
   */
  async clusterMembershipsForArticles(
    articleIds: string[],
  ): Promise<{ articleId: string; clusters: ClusterMembership[] }[]> {
    const ids = [
      ...new Set(
        articleIds
          .filter((id) => OBJECT_ID_HEX.test(id))
          .map((id) => id.toLowerCase()),
      ),
    ];
    if (ids.length === 0) return [];

    const links = (await this.clusterArticleLinkModel
      .find({ articleId: { $in: ids.map((id) => new Types.ObjectId(id)) } })
      .select('articleId clusterId confidence')
      .lean()
      .exec()) as Array<{
      articleId: Types.ObjectId;
      clusterId: Types.ObjectId;
      confidence: number;
    }>;

    const clusterIds = [
      ...new Map(
        links.map((l) => [l.clusterId.toString(), l.clusterId]),
      ).values(),
    ];
    const [clusters, counts] =
      clusterIds.length === 0
        ? [[], []]
        : await Promise.all([
            this.newsClusterModel
              .find({ _id: { $in: clusterIds } })
              .select('clusterSize stableClusterId createdAt clusteringRunId')
              .lean()
              .exec() as Promise<
              Array<{
                _id: Types.ObjectId;
                clusterSize?: number | null;
                stableClusterId?: string | null;
                createdAt: Date;
                clusteringRunId?: string;
              }>
            >,
            this.clusterArticleLinkModel
              .aggregate<{
                _id: Types.ObjectId;
                n: number;
              }>([
                { $match: { clusterId: { $in: clusterIds } } },
                { $group: { _id: '$clusterId', n: { $sum: 1 } } },
              ])
              .exec(),
          ]);

    const linkCount = new Map(counts.map((c) => [c._id.toString(), c.n]));
    // Newest first: createdAt desc, then _id desc.
    const complete = clusters
      .filter(
        (c) =>
          (c.clusterSize ?? 0) > 0 &&
          linkCount.get(c._id.toString()) === c.clusterSize,
      )
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b._id.toString().localeCompare(a._id.toString()),
      );
    const seenStable = new Set<string>();
    const rank = new Map<string, number>();
    const usable = new Map<string, (typeof complete)[number]>();
    for (const c of complete) {
      if (c.stableClusterId) {
        if (seenStable.has(c.stableClusterId)) continue;
        seenStable.add(c.stableClusterId);
      }
      rank.set(c._id.toString(), rank.size);
      usable.set(c._id.toString(), c);
    }

    const linksByArticle = new Map<string, typeof links>();
    for (const l of links) {
      const key = l.articleId.toString();
      linksByArticle.set(key, [...(linksByArticle.get(key) ?? []), l]);
    }

    const rows: { articleId: string; clusters: ClusterMembership[] }[] = [];
    for (const articleId of ids) {
      const own = linksByArticle.get(articleId) ?? [];
      if (own.length === 0) {
        rows.push({ articleId, clusters: [] });
        continue;
      }
      const kept = own
        .filter((l) => usable.has(l.clusterId.toString()))
        .sort(
          (a, b) =>
            rank.get(a.clusterId.toString())! -
            rank.get(b.clusterId.toString())!,
        );
      if (kept.length === 0) continue;
      const run = usable.get(kept[0].clusterId.toString())!.clusteringRunId;
      const clustersOut = kept
        .filter(
          (l) => usable.get(l.clusterId.toString())!.clusteringRunId === run,
        )
        .map((l) => ({
          clusterId: l.clusterId.toString(),
          confidence: l.confidence,
          stableClusterId:
            usable.get(l.clusterId.toString())!.stableClusterId ?? null,
        }))
        .sort((a, b) => b.confidence - a.confidence);
      rows.push({ articleId, clusters: clustersOut });
    }
    return rows;
  }

  async findNewsClusterById(clusterId: string): Promise<NewsCluster> {
    const cluster = await this.newsClusterModel
      .findById(new Types.ObjectId(clusterId))
      .exec();

    if (!cluster) {
      throw new NotFoundException(`Cluster with ID ${clusterId} not found`);
    }

    return cluster;
  }

  async newsClusters(
    first: number = DEFAULT_PAGE_SIZE,
    after?: string,
    countryCodes?: string[],
  ): Promise<NewsClustersResponse> {
    if (countryCodes?.length) {
      throw new NotImplementedException(
        'Country code filtering not yet implemented for new cluster model',
      );
    }

    const baseQuery: QueryFilter<NewsClusterDocument> = {};

    return this.paginateAndFilterClusters(baseQuery, first, after);
  }

  /**
   * Returns clusters whose articles semantically match `topicText` via
   * Atlas Vector Search — same embedding space and score threshold as the
   * `articleIdsForTopics` (Flow v2) path. Useful for the persona-article
   * drill-down screen where the app no longer holds a server-assigned topic ID.
   */
  async newsClustersForTopicText(
    topicText: string,
    first: number = DEFAULT_PAGE_SIZE,
    after?: string,
  ): Promise<NewsClustersResponse> {
    const [embedding] = await this.embeddingProvider.embed([topicText]);

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const articles = await this.newsArticleModel
      .aggregate<{ _id: Types.ObjectId }>([
        {
          $vectorSearch: {
            index: 'embedding_article_data_retrieval_index',
            path: 'embedding_article_data_retrieval',
            queryVector: embedding,
            numCandidates: 200,
            limit: 100,
            filter: { createdAt: { $gte: cutoff } },
          },
        },
        { $addFields: { score: { $meta: 'vectorSearchScore' } } },
        { $match: { score: { $gte: this.minScore } } },
        { $project: { _id: 1 } },
      ])
      .exec();

    if (articles.length === 0) {
      return {
        newsClusters: [],
        pageInfo: { endCursor: null, hasNextPage: false, pageSize: first },
      };
    }

    const rawClusterIds = await this.clusterArticleLinkModel
      .distinct('clusterId', { articleId: { $in: articles.map((a) => a._id) } })
      .exec();

    const clusterIds = rawClusterIds.map(
      (id) => new Types.ObjectId(id.toString()),
    );

    return this.paginateAndFilterClusters(
      { _id: { $in: clusterIds } },
      first,
      after,
    );
  }

  /**
   * Shared two-stage zombie-filter + pagination used by both `newsClusters`
   * and `newsClustersForTopicText`.
   *
   * Stage 1 (cheap): aggregate keeping only clusters with ≥1 live
   * ClusterArticleLink. Over-pulls so stage 2 has room to drop zombies without
   * producing short pages.
   *
   * Stage 2 (bounded): verifies each candidate has a live NewsArticle behind
   * at least one of its links.
   */
  private async paginateAndFilterClusters(
    baseQuery: QueryFilter<NewsClusterDocument>,
    first: number,
    after?: string,
  ): Promise<NewsClustersResponse> {
    if (after) {
      const cursorPayload = decodeCursor<BaseCursorPayload>(after);
      if (cursorPayload) {
        baseQuery.$and = [
          { _id: { $lt: new Types.ObjectId(cursorPayload._id) } },
        ];
      }
    }

    const overFetchMultiplier = 3;
    const candidateLimit = (first + 1) * overFetchMultiplier;
    const stage1: PipelineStage[] = [
      { $match: baseQuery },
      {
        $lookup: {
          from: 'cluster-article-link',
          localField: '_id',
          foreignField: 'clusterId',
          pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }],
          as: 'link',
        },
      },
      { $match: { 'link.0': { $exists: true } } },
      { $project: { link: 0 } },
      { $sort: { _id: -1 } },
      { $limit: candidateLimit },
    ];

    const candidates = await this.newsClusterModel
      .aggregate<NewsCluster>(stage1)
      .exec();

    const candidateIds = candidates.map((c) => new Types.ObjectId(c._id));
    let liveClusterIdSet = new Set<string>();
    if (candidateIds.length > 0) {
      const liveDocs = await this.clusterArticleLinkModel
        .aggregate<{ _id: Types.ObjectId }>([
          { $match: { clusterId: { $in: candidateIds } } },
          {
            $lookup: {
              from: 'news-article',
              localField: 'articleId',
              foreignField: '_id',
              pipeline: [{ $project: { _id: 1 } }],
              as: 'article',
            },
          },
          { $match: { 'article.0': { $exists: true } } },
          { $group: { _id: '$clusterId' } },
        ])
        .exec();
      liveClusterIdSet = new Set(liveDocs.map((d) => d._id.toString()));
    }

    const live = candidates.filter((c) =>
      liveClusterIdSet.has(c._id.toString()),
    );
    const droppedCount = candidates.length - live.length;
    if (droppedCount > 0) {
      this.logger.warn(
        `paginateAndFilterClusters: dropped ${droppedCount}/${candidates.length} ` +
          `zombie clusters (links exist but no live news-article).`,
      );
    }

    const hasNextPage = live.length > first;
    const pageClusters = hasNextPage ? live.slice(0, first) : live;

    const results = pageClusters as unknown as NewsClusterDocument[];

    let endCursor: string | null = null;
    if (results.length > 0) {
      const lastItem = results[results.length - 1];
      const cursorPayload: BaseCursorPayload = {
        _id: lastItem._id.toString(),
      };
      endCursor = encodeCursor(cursorPayload);
    }

    return {
      newsClusters: results,
      pageInfo: {
        endCursor,
        hasNextPage,
        pageSize: first,
      },
    };
  }
}
