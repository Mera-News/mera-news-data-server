import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  NewsArticle,
  NewsArticleDocument,
} from '@mera/models/models/news-article.model';
import {
  HeadlineEdition,
  HeadlineEditionDocument,
} from '@mera/models/models/headline-edition.model';
import {
  NewsCluster,
  NewsClusterDocument,
} from '@mera/models/models/news-cluster.model';
import { SERVABLE_URL_SECURITY_FILTER } from '@mera/shared/url/url-security';
import { NewsArticleService } from '../news-article/news-article.service';
import { DEFAULT_PAGE_SIZE } from '../constants';
import { toHeadlineScopeKey } from '../headline-scope/headline-scope-key';
import {
  DEFAULT_HEADLINE_VIEW_WINDOW_HOURS,
  editionProjectionForWindow,
  pickEditionEntries,
} from '../headline-scope/headline-window';
import {
  TopHeadline,
  TopHeadlinesForCountryResponse,
} from './dto/top-headlines-for-country-response.dto';

/** The per-entry cluster metadata the hydrate step needs (from the edition). */
interface HeadlineEntryMeta {
  articleId: Types.ObjectId;
  stableClusterId?: string | null;
  clusterSize?: number | null;
}

/**
 * Encode an offset-based cursor. The materialized editions are an ordered array,
 * so paging is a simple offset — the keyset cursors in `@mera/shared` are
 * sort-key-shaped and don't fit, hence this tiny local codec.
 */
function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf-8').toString('base64');
}

/** Decode an offset cursor. Returns null on any malformed/invalid input. */
function decodeOffsetCursor(cursor: string): number | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64').toString('utf-8'),
    ) as { offset?: unknown };
    if (
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return parsed.offset;
    }
    return null;
  } catch {
    return null;
  }
}

@Injectable()
export class TopHeadlinesService {
  private readonly logger = new Logger(TopHeadlinesService.name);

  constructor(
    @InjectModel(NewsArticle.name)
    private readonly newsArticleModel: Model<NewsArticleDocument>,
    @InjectModel(HeadlineEdition.name)
    private readonly headlineEditionModel: Model<HeadlineEditionDocument>,
    @InjectModel(NewsCluster.name)
    private readonly newsClusterModel: Model<NewsClusterDocument>,
    private readonly newsArticleService: NewsArticleService,
  ) {}

  /**
   * Serve a country's top headlines from the precomputed, cluster-deduplicated
   * edition's list for `windowHours` (the stories most covered in that many
   * hours; the caller validates the value). On a miss (no edition for the scope yet) falls back
   * to the live `articlesForCountry` aggregation with `editionBuiltAt: null`.
   */
  async topHeadlinesForCountry(
    countryCode: string | null | undefined,
    first: number = DEFAULT_PAGE_SIZE,
    after?: string,
    windowHours: number = DEFAULT_HEADLINE_VIEW_WINDOW_HOURS,
  ): Promise<TopHeadlinesForCountryResponse> {
    const scopeKey = toHeadlineScopeKey(countryCode);

    const edition = await this.headlineEditionModel
      .findOne({ scopeKey })
      .select(editionProjectionForWindow(windowHours))
      .lean()
      .exec();

    if (!edition) {
      // Cold scope — no edition built yet. Fall back to the live path so the app
      // still gets headlines (uncluster-deduped) until the next build runs. The
      // fallback has no cluster context, so each headline is emitted as a
      // singleton (stableClusterId: null, clusterSize: 0).
      const fallback = await this.newsArticleService.articlesForCountry(
        countryCode,
        first,
        after,
        windowHours,
      );
      const headlines: TopHeadline[] = fallback.articles.map((article) => ({
        article,
        stableClusterId: null,
        clusterSize: 0,
      }));
      return { ...fallback, headlines, editionBuiltAt: null };
    }

    const entries = pickEditionEntries(edition, windowHours);
    const entryCount = entries.length;

    const offset = after ? (decodeOffsetCursor(after) ?? 0) : 0;
    const slice = entries.slice(offset, offset + first);

    const headlines = await this.hydrate(slice);

    const hasNextPage = offset + first < entryCount;
    const endCursor = hasNextPage ? encodeOffsetCursor(offset + first) : null;

    return {
      headlines,
      articles: headlines.map((h) => h.article),
      pageInfo: {
        endCursor,
        hasNextPage,
        pageSize: first,
      },
      editionBuiltAt: edition.builtAt ?? null,
    };
  }

  /**
   * Hydrate the sliced edition entries into `TopHeadline` pairs (per-entry
   * cluster meta + full article), preserving the edition order and dropping
   * whole slots whose article has since TTL'd out. Mirrors
   * `NewsArticleService.articleById`: the `publicationSource` @Field is a virtual
   * copied from the populated `publicationSourceId`, and the multi-KB embedding
   * vectors are excluded from the read.
   */
  async hydrate(entries: HeadlineEntryMeta[]): Promise<TopHeadline[]> {
    if (entries.length === 0) {
      return [];
    }

    const articleIds = entries.map((e) => e.articleId);
    // Editions are built with the same exclusion, so an insecure article should
    // never be an entry — but an edition outlives the build that made it, so a
    // slot whose article was reclassified since is dropped here exactly like a
    // slot whose article TTL'd out. (The cold-scope fallback above goes through
    // `articlesForCountry`, which filters in NewsArticleService.topHeadlines.)
    const docs = await this.newsArticleModel
      .find({ _id: { $in: articleIds }, ...SERVABLE_URL_SECURITY_FILTER })
      .select(
        '-embedding_article_data_retrieval -embedding_article_data_text_matching -embedding_article_data_text_matching_internal_only',
      )
      .populate({ path: 'publicationSourceId', options: { lean: true } })
      .lean()
      .exec();

    const byId = new Map<string, (typeof docs)[number]>();
    for (const doc of docs) {
      byId.set(doc._id.toString(), doc);
    }

    // Resolve each headline's LIVE cluster size from its retained
    // `stableClusterId`. The edition stores a build-time `clusterSize` snapshot,
    // but clustering wipe-and-reinserts every run (re-minting the raw
    // `clusterId`), so that number goes stale within a cycle. Reading the
    // current generation by stable id keeps the badge consistent with the live
    // siblings the detail screen resolves the same way (`getRelatedArticles`).
    const stableIds = Array.from(
      new Set(
        entries
          .map((e) => e.stableClusterId)
          .filter((id): id is string => !!id),
      ),
    );
    const liveSizeByStableId = new Map<string, number>();
    if (stableIds.length > 0) {
      const clusters = await this.newsClusterModel
        .find({ stableClusterId: { $in: stableIds } })
        .select('stableClusterId clusterSize')
        .lean()
        .exec();
      for (const cluster of clusters) {
        if (cluster.stableClusterId) {
          liveSizeByStableId.set(
            cluster.stableClusterId,
            cluster.clusterSize ?? 0,
          );
        }
      }
    }

    const ordered: TopHeadline[] = [];
    for (const entry of entries) {
      const doc = byId.get(entry.articleId.toString());
      if (!doc) {
        // Article TTL'd out since the edition was built — drop the slot whole.
        continue;
      }
      const stableClusterId = entry.stableClusterId ?? null;
      const liveSize = stableClusterId
        ? (liveSizeByStableId.get(stableClusterId) ?? 0)
        : 0;
      ordered.push({
        article: {
          ...doc,
          publicationSource: doc.publicationSourceId,
        } as unknown as NewsArticle,
        stableClusterId,
        // Live cluster size, self-inclusive. 0 when the stable cluster no longer
        // exists or has collapsed to a singleton — so the card never advertises
        // related articles the detail screen can't show.
        clusterSize: liveSize > 1 ? liveSize : 0,
      });
    }
    return ordered;
  }
}
