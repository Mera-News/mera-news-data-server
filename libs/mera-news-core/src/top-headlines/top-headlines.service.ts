import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { GraphQLError } from 'graphql';
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
  editionListExpression,
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
  publisherCount?: number | null;
}

/** Where a hydrated slice sits in its list, for the per-headline cursors. */
interface SlicePosition {
  offset: number;
  /** Set for an edition read: such cursors are refused once it is rebuilt. */
  builtAt?: Date | null;
}

/** `first` is clamped to this, never refused. */
export const MAX_TOP_HEADLINES_PAGE_SIZE = 200;

/** `$slice` takes a 32-bit position. */
const MAX_SLICE_POSITION = 2 ** 31 - 1;

interface OffsetCursor {
  offset: number;
  builtAt?: string;
}

/**
 * Encode an offset-based cursor. The materialized editions are an ordered array,
 * so paging is a simple offset — the keyset cursors in `@mera/shared` are
 * sort-key-shaped and don't fit, hence this tiny local codec. Every cursor
 * carries `builtAt` when there is an edition, so a rebuilt one is detected;
 * a bare `{ offset }` cursor given out earlier still pages across a rebuild.
 */
function encodeOffsetCursor(offset: number, builtAt?: Date | null): string {
  const payload: OffsetCursor = builtAt
    ? { offset, builtAt: new Date(builtAt).toISOString() }
    : { offset };
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
}

/** Decode an offset cursor. Returns null on any malformed/invalid input. */
function decodeOffsetCursor(cursor: string): OffsetCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64').toString('utf-8'),
    ) as { offset?: unknown; builtAt?: unknown };
    if (
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0 &&
      (parsed.builtAt === undefined || typeof parsed.builtAt === 'string')
    ) {
      return parsed.builtAt === undefined
        ? { offset: parsed.offset }
        : { offset: parsed.offset, builtAt: parsed.builtAt };
    }
    return null;
  } catch {
    return null;
  }
}

export function clampTopHeadlinesPageSize(first: number): number {
  const n = Number.isFinite(first) ? Math.floor(first) : DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(n, 1), MAX_TOP_HEADLINES_PAGE_SIZE);
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
    const pageSize = clampTopHeadlinesPageSize(first);
    const cursor = after ? decodeOffsetCursor(after) : null;
    const offset = Math.min(cursor?.offset ?? 0, MAX_SLICE_POSITION);

    // Only the page is read: an edition holds up to a thousand entries per view.
    const [edition] = await this.headlineEditionModel
      .aggregate<{
        builtAt?: Date | null;
        total: number;
        page: HeadlineEntryMeta[];
      }>([
        { $match: { scopeKey } },
        { $project: { builtAt: 1, list: editionListExpression(windowHours) } },
        {
          $project: {
            builtAt: 1,
            total: { $size: '$list' },
            page: { $slice: ['$list', offset, pageSize] },
          },
        },
      ])
      .exec();

    const builtAt = edition?.builtAt ?? null;
    if (
      cursor?.builtAt !== undefined &&
      (!builtAt || new Date(builtAt).toISOString() !== cursor.builtAt)
    ) {
      throw new GraphQLError(
        'The headline list was rebuilt after this cursor was given out. Start again from the first page.',
        { extensions: { code: 'EDITION_CHANGED' } },
      );
    }

    if (!edition) {
      return this.liveFallback(
        countryCode,
        pageSize,
        after,
        cursor ? offset : null,
        windowHours,
      );
    }

    const headlines = await this.hydrate(edition.page, { offset, builtAt });
    const hasNextPage = offset + pageSize < edition.total;
    return {
      headlines,
      articles: headlines.map((h) => h.article),
      pageInfo: {
        endCursor: hasNextPage
          ? encodeOffsetCursor(offset + pageSize, builtAt)
          : null,
        hasNextPage,
        pageSize,
      },
      editionBuiltAt: builtAt,
    };
  }

  /**
   * Cold scope, no edition built yet: the live path, so the app still gets
   * headlines (uncluster-deduped) until the next build runs. It has no cluster
   * context, so each headline is a singleton (stableClusterId null, sizes 0).
   * It pages by offset like an edition; `offset` is null only for a keyset
   * cursor this path gave out before, which still pages as it did.
   */
  private async liveFallback(
    countryCode: string | null | undefined,
    pageSize: number,
    after: string | undefined,
    offset: number | null,
    windowHours: number,
  ): Promise<TopHeadlinesForCountryResponse> {
    const keyset = !!after && offset === null;
    const start = offset ?? 0;
    const live = keyset
      ? await this.newsArticleService.articlesForCountry(
          countryCode,
          pageSize,
          after,
          windowHours,
        )
      : await this.newsArticleService.articlesForCountryAtOffset(
          countryCode,
          start,
          pageSize,
          windowHours,
        );
    const headlines: TopHeadline[] = live.articles.map((article, i) => ({
      article,
      stableClusterId: null,
      clusterSize: 0,
      publisherCount: 0,
      cursor: keyset ? null : encodeOffsetCursor(start + i + 1),
    }));
    const { hasNextPage } = live.pageInfo;
    return {
      headlines,
      articles: live.articles,
      pageInfo: {
        endCursor: keyset
          ? live.pageInfo.endCursor
          : hasNextPage
            ? encodeOffsetCursor(start + pageSize)
            : null,
        hasNextPage,
        pageSize,
      },
      editionBuiltAt: null,
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
  async hydrate(
    entries: HeadlineEntryMeta[],
    position?: SlicePosition,
  ): Promise<TopHeadline[]> {
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
    for (const [index, entry] of entries.entries()) {
      const doc = byId.get(entry.articleId.toString());
      if (!doc) {
        // Article TTL'd out since the edition was built — drop the slot whole.
        continue;
      }
      const stableClusterId = entry.stableClusterId ?? null;
      const liveSize = stableClusterId
        ? (liveSizeByStableId.get(stableClusterId) ?? 0)
        : 0;
      const clusterSize = liveSize > 1 ? liveSize : 0;
      ordered.push({
        article: {
          ...doc,
          publicationSource: doc.publicationSourceId,
        } as unknown as NewsArticle,
        stableClusterId,
        // Live cluster size, self-inclusive. 0 when the stable cluster no longer
        // exists or has collapsed to a singleton — so the card never advertises
        // related articles the detail screen can't show.
        clusterSize,
        // An edition built before the field existed has none: 0 until the next
        // build (hourly) writes it, rather than a count read per request.
        publisherCount: clusterSize > 0 ? (entry.publisherCount ?? 0) : 0,
        // Counted on the slice as read, so a dropped slot never shifts the next one.
        cursor: position
          ? encodeOffsetCursor(position.offset + index + 1, position.builtAt)
          : null,
      });
    }
    return ordered;
  }
}
