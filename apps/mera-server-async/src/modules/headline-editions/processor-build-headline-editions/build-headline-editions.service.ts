import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
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
  NewsCluster,
  NewsClusterDocument,
} from '@mera/models/models/news-cluster.model';
import {
  HeadlineEdition,
  HeadlineEditionDocument,
} from '@mera/models/models/headline-edition.model';
import { baseLang } from '@mera/shared';
import { SERVABLE_URL_SECURITY_FILTER } from '@mera/shared/url/url-security';
import {
  JobReporter,
  NOOP_JOB_REPORTER,
} from '../../shared-utilities/mera-worker-host';
import {
  buildScopeEdition,
  GLOBAL_SCOPE_KEY,
  HeadlineArticleInput,
  HeadlineClusterInput,
  HeadlineLinkInput,
  HeadlineSourceMeta,
  HEADLINE_BUILD_VIEWS_HOURS,
  HEADLINE_EDITION_MAX_ENTRIES,
  HEADLINE_EDITION_WINDOW_HOURS,
  HEADLINE_ENTRIES_VIEW_HOURS,
  HeadlineEntryOutput,
  HEADLINE_GLOBAL_MARKET_CAP,
  HEADLINE_GLOBAL_SOLO_MARKET_WEIGHT,
} from './headline-edition-builder';

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * `$in` batch size for the cluster-link and cluster reads. One `$in` over the
 * whole 48h pool (~530k ids, ~11 MB of BSON in Oct 2026 and growing) would
 * cross Mongo's 16 MB command limit.
 */
const ID_READ_BATCH = 50_000;

export { GLOBAL_SCOPE_KEY };

export interface BuildHeadlineEditionsResult {
  success: boolean;
  buildRunId: string;
  scopeCount: number;
  totalEntries: number;
  deletedStaleScopes: number;
  processedAt: string;
}

/**
 * Rebuilds every headline edition (GLOBAL + one per publication-source country)
 * from the 48h pool (the article TTL). Fired once per clustering run (right
 * after topic linking). Streams the pool, resolves each article's cluster via
 * cluster-article-link, partitions per country + one GLOBAL pass, then runs the
 * pure builder once per scope per reader view over only the articles that
 * arrived inside that view, upserts all editions in one bulkWrite and prunes
 * scopes no longer present.
 *
 * shortcut: the :20 build reads the previous clustering run, so the newest ~1h
 * is always unclustered and the 6h view loses about a sixth of its signal.
 * Building right after clustering finishes is the fix if 6h reads thin.
 */
/** Editions per bulkWrite: bounds the documents held at once. */
export const EDITION_WRITE_BATCH = 20;

@Injectable()
export class BuildHeadlineEditionsService {
  private readonly logger = new Logger(BuildHeadlineEditionsService.name);
  private readonly maxEntries: number;
  private readonly breadthRanking: boolean;
  private readonly marketCap: number;
  private readonly soloMarketWeight: number;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(NewsArticle.name)
    private readonly articleModel: Model<NewsArticleDocument>,
    @InjectModel(PublicationSource.name)
    private readonly publicationSourceModel: Model<PublicationSourceDocument>,
    @InjectModel(ClusterArticleLink.name)
    private readonly clusterArticleLinkModel: Model<ClusterArticleLinkDocument>,
    @InjectModel(NewsCluster.name)
    private readonly newsClusterModel: Model<NewsClusterDocument>,
    @InjectModel(HeadlineEdition.name)
    private readonly headlineEditionModel: Model<HeadlineEditionDocument>,
  ) {
    this.maxEntries = this.config.get<number>(
      'HEADLINE_EDITION_MAX_ENTRIES',
      HEADLINE_EDITION_MAX_ENTRIES,
    );
    // Kill switch for the global breadth ranking — flipping it back reverts the
    // GLOBAL edition to the legacy inScopeCount ordering on the next run.
    this.breadthRanking =
      String(this.config.get('HEADLINE_GLOBAL_BREADTH_RANKING', 'true')) !==
      'false';
    this.marketCap = Number(
      this.config.get('HEADLINE_GLOBAL_MARKET_CAP', HEADLINE_GLOBAL_MARKET_CAP),
    );
    this.soloMarketWeight = Number(
      this.config.get(
        'HEADLINE_GLOBAL_SOLO_MARKET_WEIGHT',
        HEADLINE_GLOBAL_SOLO_MARKET_WEIGHT,
      ),
    );
  }

  async buildHeadlineEditions(
    reporter: JobReporter = NOOP_JOB_REPORTER,
  ): Promise<BuildHeadlineEditionsResult> {
    const startedAt = Date.now();
    const buildRunId = randomUUID();
    const builtAt = new Date();
    const cutoff = new Date(
      startedAt - HEADLINE_EDITION_WINDOW_HOURS * MS_PER_HOUR,
    );

    // 1. Publication-source -> {country, publisher} map, and the set of scope
    //    countries. `newsPublisherId` collapses one publisher's many regional
    //    feeds into a single voice for the breadth score.
    const sources = await this.publicationSourceModel
      .aggregate<{
        _id: Types.ObjectId;
        country_code?: string;
        newsPublisherId?: Types.ObjectId | null;
        detected_language_code?: string;
        feed_language_code?: string;
        readingScore?: unknown;
      }>([
        {
          $project: {
            country_code: 1,
            newsPublisherId: 1,
            detected_language_code: 1,
            feed_language_code: 1,
          },
        },
        {
          $lookup: {
            from: 'news-publisher',
            localField: 'newsPublisherId',
            foreignField: '_id',
            pipeline: [{ $project: { _id: 0, readingScore: 1 } }],
            as: 'publisher',
          },
        },
        {
          $project: {
            country_code: 1,
            newsPublisherId: 1,
            detected_language_code: 1,
            feed_language_code: 1,
            readingScore: { $first: '$publisher.readingScore' },
          },
        },
      ])
      .exec();
    const interned = new Map<string, string>();
    const intern = (tag: string | null): string | null => {
      if (tag === null) return null;
      const hit = interned.get(tag);
      if (hit) return hit;
      interned.set(tag, tag);
      return tag;
    };
    const langBySource = new Map<string, string | null>();
    const scoreBySource = new Map<string, number>();
    const countryBySource = new Map<string, string>();
    const sourceMeta = new Map<string, HeadlineSourceMeta>();
    const countryScopeKeys = new Set<string>();
    const publisherBySource = new Map<string, string>();
    for (const src of sources) {
      const sourceId = src._id.toString();
      const publisherKey = src.newsPublisherId?.toString() ?? sourceId;
      publisherBySource.set(sourceId, publisherKey);
      langBySource.set(
        sourceId,
        intern(baseLang(src.detected_language_code ?? src.feed_language_code)),
      );
      if (
        typeof src.readingScore === 'number' &&
        Number.isFinite(src.readingScore)
      ) {
        scoreBySource.set(sourceId, src.readingScore);
      }
      const country = src.country_code;
      if (!country) continue;
      countryBySource.set(sourceId, country);
      sourceMeta.set(sourceId, { country, publisherKey });
      // Wire/international sources carry `country_code: 'GLOBAL'`, the same
      // literal as the global scope sentinel. Registering it as a country scope
      // would make it collide with GLOBAL — see the bucket push below.
      if (country !== GLOBAL_SCOPE_KEY) {
        countryScopeKeys.add(country);
      }
    }
    await reporter.progress(
      20,
      `Loaded ${sources.length} publication-source(s), ${countryScopeKeys.size} country scope(s), scoredSources=${scoreBySource.size}`,
    );

    // 2. Stream the 48h pool, partitioning per country + one GLOBAL pass.
    const scopeBuckets = new Map<string, HeadlineArticleInput[]>();
    scopeBuckets.set(GLOBAL_SCOPE_KEY, []);
    for (const scopeKey of countryScopeKeys) {
      scopeBuckets.set(scopeKey, []);
    }

    const allArticleIds: Types.ObjectId[] = [];
    // The CHEAPEST place to enforce the insecure-URL exclusion: an insecure
    // article never enters the candidate pool, so it can never be picked as a
    // story's representative and displace a servable one. The serve-side
    // filters in TopHeadlinesService/NewsArticleService are then belt-and-braces
    // for editions built before this landed.
    const cursor = this.articleModel
      .find({ createdAt: { $gte: cutoff }, ...SERVABLE_URL_SECURITY_FILTER })
      .select('_id publicationSourceId createdAt pubDate image_url story_key original_language_code')
      .lean()
      .cursor();

    for await (const doc of cursor) {
      const sourceId = doc.publicationSourceId?.toString() ?? '';
      const id = doc._id.toString();
      const article: HeadlineArticleInput = {
        _id: id,
        publicationSourceId: sourceId,
        createdAt: new Date(doc.createdAt),
        pubDate: new Date(doc.pubDate),
        image_url: doc.image_url ?? null,
        lang:
          doc.original_language_code != null
            ? intern(baseLang(doc.original_language_code))
            : (langBySource.get(sourceId) ?? null),
        score: scoreBySource.get(sourceId) ?? null,
        // Null for a self-seeded row: the builder falls back to _id, and ~530k
        // duplicate id strings stay off the heap.
        story_key:
          doc.story_key && String(doc.story_key) !== id
            ? String(doc.story_key)
            : null,
      };
      allArticleIds.push(doc._id as Types.ObjectId);

      scopeBuckets.get(GLOBAL_SCOPE_KEY)!.push(article);
      const country = countryBySource.get(article.publicationSourceId);
      // A wire source's country IS 'GLOBAL', whose bucket is the array we just
      // pushed into — pushing again would count the article twice in the global
      // edition's inScopeCount (which is how it came to exceed clusterSize).
      if (country && country !== GLOBAL_SCOPE_KEY) {
        scopeBuckets.get(country)!.push(article);
      }
    }
    await reporter.progress(
      50,
      `Streamed ${allArticleIds.length} article(s) in the ${HEADLINE_EDITION_WINDOW_HOURS}h window`,
    );

    // 3. Resolve cluster links + cluster metadata for the in-scope articles.
    const { linksByArticleId, clustersById } =
      await this.loadClusterContext(allArticleIds);
    await reporter.progress(
      70,
      `Resolved ${linksByArticleId.size} link(s) across ${clustersById.size} cluster(s)`,
    );

    this.logger.log(
      `headline editions: ${allArticleIds.length} article(s) in the pool, heapUsedMb=${Math.round(
        process.memoryUsage().heapUsed / 1048576,
      )}`,
    );

    const globalPool = scopeBuckets.get(GLOBAL_SCOPE_KEY)!;

    // 4. Build every scope (GLOBAL + every country, incl. zero-article ones).
    const builtScopeKeys: string[] = [
      GLOBAL_SCOPE_KEY,
      ...Array.from(countryScopeKeys),
    ];
    let totalEntries = 0;
    // Lists first, then publisher counts for only the clusters an edition shows, then documents
    // written in batches: holding every scope's documents for one bulkWrite, and a publisher set
    // for every cluster in the pool, ran the worker out of heap on a ~500k-article pool.
    const listsByScope = new Map<string, Map<number, HeadlineEntryOutput[]>>();
    const shownClusters = new Set<string>();

    const toEntryDocs = (entries: HeadlineEntryOutput[]) =>
      entries.map((e) => ({
        articleId: new Types.ObjectId(e.articleId),
        clusterId: e.clusterId ? new Types.ObjectId(e.clusterId) : null,
        stableClusterId: e.stableClusterId,
        clusterSize: e.clusterSize,
        inScopeCount: e.inScopeCount,
        rank: e.rank,
        cards: e.cards.map((c) => ({
          articleId: new Types.ObjectId(c.articleId),
          ...(c.lang !== null ? { lang: c.lang } : {}),
          ...(c.score !== null ? { score: c.score } : {}),
        })),
        breadthScore: e.breadthScore ?? null,
        marketCount: e.marketCount ?? null,
        publisherCount: e.clusterId
          ? (publishersByCluster.get(e.clusterId)?.size ?? 0)
          : 0,
      }));
    const publishersByCluster = new Map<string, Set<string>>();

    for (const scopeKey of builtScopeKeys) {
      const articles = scopeBuckets.get(scopeKey) ?? [];
      const listsByView = new Map<number, HeadlineEntryOutput[]>();
      for (const viewHours of HEADLINE_BUILD_VIEWS_HOURS) {
        // Coverage counts only what arrived inside the view, so a story is
        // ranked by how much it was covered in the last N hours and its
        // representative is one of those articles.
        const viewCutoff = builtAt.getTime() - viewHours * MS_PER_HOUR;
        const viewList = buildScopeEdition(
          scopeKey,
          articles.filter((a) => a.createdAt.getTime() >= viewCutoff),
          linksByArticleId,
          clustersById,
          this.maxEntries,
          {
            sourceMeta,
            breadthRanking: this.breadthRanking,
            marketCap: this.marketCap,
            soloMarketWeight: this.soloMarketWeight,
          },
        );
        listsByView.set(viewHours, viewList);
        totalEntries += viewList.length;
        for (const e of viewList) if (e.clusterId) shownClusters.add(e.clusterId);
      }
      listsByScope.set(scopeKey, listsByView);
      this.logger.log(
        `headline edition scope=${scopeKey} entries=${listsByView.get(HEADLINE_ENTRIES_VIEW_HOURS)?.length ?? 0} ` +
          `articles=${articles.length}` +
          (scopeKey === GLOBAL_SCOPE_KEY
            ? ` breadthRanking=${this.breadthRanking} marketCap=${this.marketCap}`
            : ''),
      );
    }
    scopeBuckets.clear();

    // Distinct publishers per shown cluster, over the whole pool whatever the scope or view: the
    // count a story card shows beside the cluster size.
    for (const id of shownClusters) publishersByCluster.set(id, new Set<string>());
    for (const article of globalPool) {
      const set = publishersByCluster.get(
        linksByArticleId.get(article._id)?.clusterId ?? '',
      );
      if (set)
        set.add(
          publisherBySource.get(article.publicationSourceId) ??
            article.publicationSourceId,
        );
    }

    let ops: AnyBulkWriteOperation<HeadlineEditionDocument>[] = [];
    for (const scopeKey of builtScopeKeys) {
      const listsByView = listsByScope.get(scopeKey)!;
      const entries = listsByView.get(HEADLINE_ENTRIES_VIEW_HOURS) ?? [];

      const doc = {
        scopeKey,
        windowHours: HEADLINE_EDITION_WINDOW_HOURS,
        builtAt,
        buildRunId,
        entryCount: entries.length,
        entries: toEntryDocs(entries),
        views: HEADLINE_BUILD_VIEWS_HOURS.filter(
          (h) => h !== HEADLINE_ENTRIES_VIEW_HOURS,
        ).map((h) => {
          const list = listsByView.get(h) ?? [];
          return {
            windowHours: h,
            entryCount: list.length,
            entries: toEntryDocs(list),
          };
        }),
      };

      ops.push({
        replaceOne: {
          filter: { scopeKey },
          // createdAt/updatedAt are filled by the timestamps plugin on write.
          replacement: doc as unknown as HeadlineEditionDocument,
          upsert: true,
        },
      });
      listsByScope.delete(scopeKey);
      if (ops.length >= EDITION_WRITE_BATCH) {
        await this.headlineEditionModel.bulkWrite(ops, { ordered: false });
        ops = [];
      }
    }

    // 5. The last batch.
    if (ops.length > 0) {
      await this.headlineEditionModel.bulkWrite(ops, { ordered: false });
    }
    this.logger.log(
      `headline editions written, heapUsedMb=${Math.round(process.memoryUsage().heapUsed / 1048576)}`,
    );

    // 6. Drop editions for scopes that no longer exist.
    const deleteResult = await this.headlineEditionModel.deleteMany({
      scopeKey: { $nin: builtScopeKeys },
    });
    const deletedStaleScopes = deleteResult.deletedCount ?? 0;

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `built ${builtScopeKeys.length} headline edition(s), ${totalEntries} total entries, ` +
        `pruned ${deletedStaleScopes} stale scope(s) in ${durationMs}ms (run ${buildRunId})`,
    );
    await reporter.progress(
      95,
      `Built ${builtScopeKeys.length} edition(s) in ${durationMs}ms`,
    );

    return {
      success: true,
      buildRunId,
      scopeCount: builtScopeKeys.length,
      totalEntries,
      deletedStaleScopes,
      processedAt: new Date().toISOString(),
    };
  }

  /**
   * Load the cluster-article-links for the given articles (highest-confidence
   * link kept per article) plus the metadata of every cluster those links point
   * to.
   */
  private async loadClusterContext(articleIds: Types.ObjectId[]): Promise<{
    linksByArticleId: Map<string, HeadlineLinkInput>;
    clustersById: Map<string, HeadlineClusterInput>;
  }> {
    const linksByArticleId = new Map<string, HeadlineLinkInput>();
    const clustersById = new Map<string, HeadlineClusterInput>();
    if (articleIds.length === 0) {
      return { linksByArticleId, clustersById };
    }

    const links: Array<{
      articleId: Types.ObjectId;
      clusterId: Types.ObjectId;
      confidence?: number;
    }> = [];
    for (let i = 0; i < articleIds.length; i += ID_READ_BATCH) {
      links.push(
        ...(await this.clusterArticleLinkModel
          .find({ articleId: { $in: articleIds.slice(i, i + ID_READ_BATCH) } })
          .select('clusterId articleId confidence')
          .lean()
          .exec()),
      );
    }

    const clusterIds = new Set<string>();
    for (const link of links) {
      const articleId = link.articleId.toString();
      const clusterId = link.clusterId.toString();
      const confidence = link.confidence ?? 0;
      const existing = linksByArticleId.get(articleId);
      // Effectively one link per article per run; keep the strongest on dupes.
      if (!existing || confidence > existing.confidence) {
        linksByArticleId.set(articleId, { clusterId, confidence });
      }
      clusterIds.add(clusterId);
    }

    const allClusterIds = Array.from(clusterIds).map(
      (id) => new Types.ObjectId(id),
    );
    for (let i = 0; i < allClusterIds.length; i += ID_READ_BATCH) {
      const clusters = await this.newsClusterModel
        .find({ _id: { $in: allClusterIds.slice(i, i + ID_READ_BATCH) } })
        .select('_id clusterSize stableClusterId')
        .lean()
        .exec();
      for (const cluster of clusters) {
        clustersById.set(cluster._id.toString(), {
          clusterSize: cluster.clusterSize ?? 0,
          stableClusterId: cluster.stableClusterId ?? null,
        });
      }
    }

    return { linksByArticleId, clustersById };
  }
}
