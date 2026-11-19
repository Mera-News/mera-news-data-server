import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { QueryFilter, Model, Types } from 'mongoose';
import {
  NewsPublisher,
  NewsPublisherDocument,
} from '@mera/models/models/news-publisher.model';
import {
  PublicationSource,
  PublicationSourceDocument,
} from '@mera/models/models/publication-source.model';
import {
  encodeCursor,
  decodeCursor,
  PublisherNameCursor,
  buildPublisherNameCursorFilter,
} from '@mera/shared';
import { NewsPublishersResponse } from './dto/news-publishers-response.dto';
import { PublicationSourcesForPublisherResponse } from './dto/news-publishers-response.dto';
import {
  PublisherSearchHit,
  SearchPublishersResponse,
} from './dto/search-publishers.dto';
import { DEFAULT_PAGE_SIZE } from '../constants';

const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_MAX_QUERY_LENGTH = 100;

/**
 * Escape user text for safe use inside a RegExp. Mirrors
 * `place.service.ts`'s `escapeRegex` — duplicated rather than shared because
 * it's two call sites and three lines: three similar lines of code are
 * better than a premature abstraction.
 *
 * This is the ReDoS guard: an unescaped user string like `(a+)+$` compiled
 * straight into a RegExp is a catastrophic-backtracking vector, and it would
 * be running against a COLLSCAN (see searchPublishers below) on every call.
 */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Mastheads carry an article the reader leaves out: "guardian" must rank
// "The Guardian" as exact, "figaro" must rank "Le Figaro" the same way.
const LEADING_ARTICLE = /^(the|le|la|el|der|die|das)\s+/i;

/** 0 exact, 1 prefix, 2 anything else. `query` must be lower-cased. */
function nameMatchTier(name: string, query: string): number {
  const full = name.toLowerCase();
  const bare = full.replace(LEADING_ARTICLE, '');
  if (full === query || bare === query) return 0;
  if (full.startsWith(query) || bare.startsWith(query)) return 1;
  return 2;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

@Injectable()
export class NewsPublisherService {
  constructor(
    @InjectModel(NewsPublisher.name)
    private newsPublisherModel: Model<NewsPublisherDocument>,
    @InjectModel(PublicationSource.name)
    private publicationSourceModel: Model<PublicationSourceDocument>,
  ) {}

  async findAll(
    countryCode?: string,
    first: number = DEFAULT_PAGE_SIZE,
    after?: string,
  ): Promise<NewsPublishersResponse> {
    const matchQuery: QueryFilter<NewsPublisherDocument> = {
      is_active: true,
    };

    if (countryCode) {
      matchQuery.country_code = countryCode;
    }

    if (after) {
      const cursorPayload = decodeCursor<PublisherNameCursor>(after);
      if (cursorPayload) {
        const cursorFilter = buildPublisherNameCursorFilter(cursorPayload);
        matchQuery.$and = [cursorFilter];
      }
    }

    const results = await this.newsPublisherModel
      .find(matchQuery)
      .sort({ name: 1, _id: 1 })
      .limit(first + 1)
      .exec();

    const hasNextPage = results.length > first;
    const newsPublishers = hasNextPage ? results.slice(0, first) : results;

    let endCursor: string | null = null;
    if (newsPublishers.length > 0) {
      const lastItem = newsPublishers[newsPublishers.length - 1];
      const cursorPayload: PublisherNameCursor = {
        name: lastItem.name,
        _id: lastItem._id.toString(),
      };
      endCursor = encodeCursor(cursorPayload);
    }

    return {
      newsPublishers,
      pageInfo: {
        endCursor,
        hasNextPage,
        pageSize: first,
      },
    };
  }

  async findPublicationSourcesForPublisher(
    publisherId: string,
  ): Promise<PublicationSourcesForPublisherResponse> {
    const publicationSources = await this.publicationSourceModel
      .find({ newsPublisherId: new Types.ObjectId(publisherId) })
      .sort({ category: 1, publication_name: 1 })
      .exec();

    return { publicationSources };
  }

  /**
   * Find a publisher by name OR website — across all countries — so the app
   * can answer "does this publication exist, and which country is it in"
   * (e.g. typing "Times of India"). Publisher-keyed: a hit that matched via
   * one of its `PublicationSource`s is folded into the SAME row as a hit
   * that matched on the publisher's own name/website, never a second row.
   *
   * DECISION (do not re-open): plain Mongo `$regex`, not an Atlas Search
   * index.
   *   1. ~10,000 publication-source docs and ~9,300 news-publisher docs
   *      (a large catalogue) — the whole collection fits in RAM, so an unanchored
   *      case-insensitive regex is a cheap COLLSCAN. `$regex` cannot use an
   *      index at all (only a leading-anchor `^prefix` form can), and
   *      that's fine at this size — revisit only if either
   *      collection grows into the hundreds of thousands.
   *   2. A deployment may run without an Atlas Search index (see
   *      `docs/self-host.md`) — a search feature built on one would silently
   *      return zero results there until someone creates the index.
   *   3. Atlas Search's default analyzer stems and tokenizes, which would
   *      match "time" and "india" as separate tokens — worse than substring
   *      matching for a proper-noun lookup like "Times of India".
   *
   * Ordering is in process, because a tier is not indexable: every match
   * loads as `{_id, name}` only, then just the page is hydrated. A short
   * query can match a quarter of both collections, on every keystroke.
   */
  async searchPublishers(
    query: string,
    first: number = DEFAULT_PAGE_SIZE,
    after?: string,
    opts?: { maxTimeMS?: number },
  ): Promise<SearchPublishersResponse> {
    const trimmed = (query ?? '').trim();
    if (trimmed.length < SEARCH_MIN_QUERY_LENGTH) {
      // Guard, not a silent empty page: a 1-char query would match nearly
      // everything, so this is a malformed request, not "no results yet".
      throw new BadRequestException(
        `query must be at least ${SEARCH_MIN_QUERY_LENGTH} characters`,
      );
    }
    if (trimmed.length > SEARCH_MAX_QUERY_LENGTH) {
      throw new BadRequestException(
        `query exceeds the maximum length of ${SEARCH_MAX_QUERY_LENGTH} characters`,
      );
    }

    const safeFirst = Math.max(1, first);
    // Both scans are unindexed, so a caller that exposes this to strangers can bound them.
    const scanOptions = opts?.maxTimeMS ? { maxTimeMS: opts.maxTimeMS } : {};
    const rx = new RegExp(escapeRegex(trimmed), 'i');

    // Source-side match: publications whose name or URL contains the query.
    const sourceMatch = {
      $or: [{ publication_name: rx }, { publication_url: rx }],
    };
    const sourceRefs = await this.publicationSourceModel
      .find(sourceMatch)
      .setOptions(scanOptions)
      .select('newsPublisherId')
      .lean()
      .exec();

    // A source without a linked publisher can't be folded into a
    // publisher-keyed row, so it's dropped from the id union (there is
    // nothing to key it to).
    const sourcePublisherIds = Array.from(
      new Set(
        sourceRefs
          .map((s) => s.newsPublisherId)
          .filter((id): id is Types.ObjectId => !!id)
          .map((id) => id.toString()),
      ),
    ).map((id) => new Types.ObjectId(id));

    const matchQuery: QueryFilter<NewsPublisherDocument> = {
      // Mirrors findAll's house convention — publishers are never flipped
      // inactive by the pipeline (only sources are), so this is a no-op in
      // practice today, but keeps the two publisher-reading queries in sync.
      is_active: true,
      $or: [
        { _id: { $in: sourcePublisherIds } },
        { name: rx },
        { website_url: rx },
      ],
    };

    const lowerQuery = trimmed.toLowerCase();
    const matches = await this.newsPublisherModel
      .find(matchQuery)
      .setOptions(scanOptions)
      .select('name')
      .lean()
      .exec();
    const ordered = matches
      .map((p) => ({
        _id: p._id,
        id: p._id.toString(),
        name: p.name,
        tier: nameMatchTier(p.name, lowerQuery),
      }))
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          compareCodeUnits(a.name, b.name) ||
          compareCodeUnits(a.id, b.id),
      );

    // An id that no longer matches restarts at the top (findIndex's -1 + 1).
    const cursor = after ? decodeCursor<PublisherNameCursor>(after) : null;
    const start = cursor
      ? ordered.findIndex((row) => row.id === cursor._id) + 1
      : 0;
    const page = ordered.slice(start, start + safeFirst);
    const hasNextPage = ordered.length > start + safeFirst;
    const pageIds = page.map((row) => row._id);

    const [publishers, pageSources] = await Promise.all([
      this.newsPublisherModel
        .find({ _id: { $in: pageIds } })
        .lean()
        .exec(),
      this.publicationSourceModel
        .find({ ...sourceMatch, newsPublisherId: { $in: pageIds } })
        .exec(),
    ]);
    const publishersById = new Map(
      publishers.map((p) => [p._id.toString(), p]),
    );

    const sourcesByPublisherId = new Map<string, PublicationSourceDocument[]>();
    for (const source of pageSources) {
      if (!source.newsPublisherId) continue;
      const key = source.newsPublisherId.toString();
      const list = sourcesByPublisherId.get(key) ?? [];
      list.push(source);
      sourcesByPublisherId.set(key, list);
    }

    const hits: PublisherSearchHit[] = page.flatMap((row) => {
      const p = publishersById.get(row.id);
      if (!p) return [];
      return [
        {
          _id: row.id,
          name: p.name,
          website_url: p.website_url,
          country_code: p.country_code,
          country_name: p.country_name,
          // Explicit null, not undefined: a publisher confirmed to have no
          // subscription product must read the same as an unset one on the wire.
          subscription_uri: p.subscription_uri ?? null,
          matchingSources: sourcesByPublisherId.get(row.id) ?? [],
        },
      ];
    });

    const lastRow = page[page.length - 1];
    const endCursor = lastRow
      ? encodeCursor<PublisherNameCursor>({
          name: lastRow.name,
          _id: lastRow.id,
        })
      : null;

    return {
      publishers: hits,
      pageInfo: {
        endCursor,
        hasNextPage,
        pageSize: safeFirst,
      },
    };
  }
}
