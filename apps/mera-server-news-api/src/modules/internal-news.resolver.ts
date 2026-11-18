import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { GraphQLError } from 'graphql';
import {
  assertCursorLength,
  assertKeysetCursor,
  assertOffsetCursor,
} from './cursor-guard';
import {
  Args,
  Context,
  ID,
  Int,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { NewsArticle } from '@mera/models/models/news-article.model';
import { NewsCluster } from '@mera/models/models/news-cluster.model';
import { Place } from '@mera/models/models/place.model';
import { NewsPublisher } from '@mera/models/models/news-publisher.model';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import {
  ArticleClusterMemberships,
  ArticleSummary,
  ArticlesForPublicationSourceResponse,
  ArticlesForTopicsByIdsResponse,
  ArticlesForTopicsService,
  DEFAULT_HEADLINE_VIEW_WINDOW_HOURS,
  DEFAULT_PAGE_SIZE,
  HEADLINE_VIEW_WINDOWS_HOURS,
  NewsArticleService,
  NewsClusterService,
  NewsPublisherService,
  NewsPublishersResponse,
  PublicationSourcesForPublisherResponse,
  SearchPublishersResponse,
  HeadlineScope,
  PersonaQueryInput,
  PersonaQueryResult,
  TopHeadlinesForCountryResponse,
  TopHeadlinesService,
  CountryService,
  NewsServerStatus,
  PlaceService,
  PublicationProfile,
  PublicationProfileService,
  PublisherArticleOrder,
  RelatedArticlesContextInput,
  RelatedArticlesPage,
  RelatedSortModeEnum,
  ServerStatusService,
  toGeoLanguageContext,
  toSortMode,
} from '@mera/news-core';
import type { ApiKeyRequest } from '../guards/api-key.guard';

/**
 * The internal news surface — every root field the news client's `MeraNewsAdapter`
 * sends, and nothing else.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FIELD NAMES AND ARGUMENT SHAPES ARE A WIRE CONTRACT
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The adapter's documents are compile-time constants on the other side of the
 * wire (the client's `mera-news.documents.ts`).
 * A renamed field or a changed argument does not surface as a build error
 * anywhere — it surfaces as GraphQL `errors`, which the adapter deliberately
 * degrades to an empty result and logs only as an error COUNT. The visible
 * symptom is a thin or empty feed with no cause recorded.
 *
 * So these signatures mirror the app-facing resolvers in
 * `apps/mera-server-graphql` exactly, argument names, defaults and nullability
 * included.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT IS DELIBERATELY MISSING
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * No `@CurrentUser`. No `SubscriptionGuard`. No user-side query
 * (`userBilling`, `userPersonaByUserId`, `unblockRequestStatus`) and no
 * mutation of any kind. There is no user here to identify: the caller owns all
 * user data and, by design, cannot send an identity — its outbound header set
 * is frozen and test-enforced on its side.
 *
 * `articlesForTopicsByIds` is therefore UNMETERED here (`NoopArticleQuota`),
 * and `articlesForStories` is the same read under its other name, served
 * because the client sends it. Quota is the caller's job.
 */
/** Default page size for `relatedArticlesPage`; the ceiling is below. */
const DEFAULT_RELATED_PAGE_SIZE = 10;

@Resolver()
export class InternalNewsResolver {
  constructor(
    private readonly articlesForTopicsService: ArticlesForTopicsService,
    private readonly newsArticleService: NewsArticleService,
    private readonly topHeadlinesService: TopHeadlinesService,
    private readonly newsClusterService: NewsClusterService,
    private readonly newsPublisherService: NewsPublisherService,
    private readonly countryService: CountryService,
    private readonly placeService: PlaceService,
    private readonly serverStatusService: ServerStatusService,
    private readonly publicationProfileService: PublicationProfileService,
  ) {}

  // ───────────────────────────────────────────────────────────────────────────
  // Retrieval + hydration  (adapter: resolveTopics, hydrateArticles)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Caps mirror the app-facing resolver's and are ENFORCED here, not inherited.
   *
   * Nothing upstream validates for us: this resolver is reachable without a
   * session, so "the app would never send that" is not an argument. And the
   * cost is real rather than theoretical — every COLD topic in a request is a
   * Jina embed plus an Atlas `$vectorSearch`, so an unbounded topic list is a
   * bill and a mongot load spike, not just a large response.
   */
  @Query(() => PersonaQueryResult, { name: 'articleIdsForPersona' })
  async articleIdsForPersona(
    @Args('query') query: PersonaQueryInput,
  ): Promise<PersonaQueryResult> {
    const topics = query.topics ?? [];
    if (topics.length > MAX_TOPICS_PER_REQUEST) {
      throw new BadRequestException(
        `Too many topics: ${topics.length} exceeds the maximum of ${MAX_TOPICS_PER_REQUEST}`,
      );
    }
    for (const topic of topics) {
      if (topic.text != null && topic.text.length > MAX_TOPIC_TEXT_LENGTH) {
        throw new BadRequestException(
          `topicText exceeds the maximum length of ${MAX_TOPIC_TEXT_LENGTH} characters`,
        );
      }
    }

    const headlines = query.topHeadlines;
    if (headlines) {
      if ((headlines.scopes?.length ?? 0) > MAX_HEADLINE_SCOPES) {
        throw new BadRequestException(
          `Too many headline scopes: ${headlines.scopes.length} exceeds the maximum of ${MAX_HEADLINE_SCOPES}`,
        );
      }
      if (
        headlines.limitPerScope != null &&
        headlines.limitPerScope > MAX_LIMIT_PER_SCOPE
      ) {
        throw new BadRequestException(
          `limitPerScope ${headlines.limitPerScope} exceeds the maximum of ${MAX_LIMIT_PER_SCOPE}`,
        );
      }
      for (const scope of headlines.scopes ?? []) {
        // COUNTRY without a code reaches the headline resolution path on a
        // shape the app-facing resolver rejects before any work starts.
        if (scope.scope === HeadlineScope.COUNTRY && !scope.countryCode) {
          throw new BadRequestException(
            `COUNTRY headline scope requires a countryCode`,
          );
        }
        // Bounded by the SAME ceiling as the query-level limit — otherwise six
        // scopes could each exceed the cap the query-level check enforces.
        if (scope.limit != null && scope.limit > MAX_LIMIT_PER_SCOPE) {
          throw new BadRequestException(
            `headline scope limit ${scope.limit} exceeds the maximum of ${MAX_LIMIT_PER_SCOPE}`,
          );
        }
      }
    }

    return this.articlesForTopicsService.getArticleIdsForPersona(query);
  }

  /**
   * UNMETERED. `ARTICLE_QUOTA` is bound to `NoopArticleQuota` in this app, so
   * `dailyLimitReached` is always false and `resetAt` always absent — pinned by
   * the news-api contract tests in `test/integration/retrieval/`.
   */
  @Query(() => ArticlesForTopicsByIdsResponse, {
    name: 'articlesForTopicsByIds',
  })
  async articlesForTopicsByIds(
    @Args('articleIds', { type: () => [ID] }) articleIds: string[],
    @Context('req') req: ApiKeyRequest,
  ): Promise<ArticlesForTopicsByIdsResponse> {
    // Unmetered AND unbounded is the wrong combination. On the app-facing API
    // the quota IS the cap on this query; here there is no quota, so request
    // size is the only bound left — exactly the reasoning `articlesForStories`
    // already applies to the other quota-free hydration path. The adapter
    // chunks at 50 (`DEFAULT_HYDRATE_CHUNK_SIZE`), so this never bites a
    // well-behaved caller.
    if (articleIds.length > MAX_ARTICLE_IDS_PER_REQUEST) {
      throw new BadRequestException(
        `Too many article ids: ${articleIds.length} exceeds the maximum of ${MAX_ARTICLE_IDS_PER_REQUEST}`,
      );
    }
    // The quota is charged to whoever the key belongs to, as the guard's
    // verifier answered it. Never a caller-supplied value, so no identity can
    // be smuggled in through this argument. Unread under the no-op binding.
    const principal = req?.apiPrincipal;
    if (!principal) throw new UnauthorizedException('Invalid API key');
    return this.articlesForTopicsService.getArticlesForTopicsByIds(
      articleIds,
      principal,
    );
  }

  @Query(() => ArticlesForTopicsByIdsResponse, {
    name: 'articlesForStories',
    description:
      'Hydrate articles by id for followed ("tracked") stories. Same payload as articlesForTopicsByIds. dailyLimitReached is always false and resetAt is always absent. Capped at 50 ids per request.',
  })
  async articlesForStories(
    @Args('articleIds', { type: () => [ID] }) articleIds: string[],
    @Context('req') req: ApiKeyRequest,
  ): Promise<ArticlesForTopicsByIdsResponse> {
    if (articleIds.length > MAX_ARTICLE_IDS_PER_REQUEST) {
      throw new BadRequestException(
        `Too many article ids: ${articleIds.length} exceeds the maximum of ${MAX_ARTICLE_IDS_PER_REQUEST}`,
      );
    }
    const principal = req?.apiPrincipal;
    if (!principal) throw new UnauthorizedException('Invalid API key');
    return this.articlesForTopicsService.getArticlesForStories(
      articleIds,
      principal,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Article reads  (adapter: getArticle, listArticles)
  // ───────────────────────────────────────────────────────────────────────────

  @Query(() => NewsArticle, {
    name: 'articleById',
    nullable: true,
    description:
      'Fetch a single article by ID. Returns null if not found (e.g. TTL’d out).',
  })
  async articleById(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<NewsArticle | null> {
    return this.newsArticleService.articleById(id);
  }

  @Query(() => TopHeadlinesForCountryResponse, {
    name: 'topHeadlinesForCountry',
    description:
      'A country\'s precomputed, cluster-deduplicated top headlines (each big story appears once), paged over the materialized edition. A null or "GLOBAL" countryCode spans all countries. windowHours ranks the stories most covered in the last 6, 12, 24 (default) or 48 hours. Falls back to the live path (editionBuiltAt: null) when no edition exists yet.',
  })
  async topHeadlinesForCountry(
    @Args('countryCode', {
      type: () => String,
      nullable: true,
      description: 'ISO country code, or null/"GLOBAL" for all countries',
    })
    countryCode: string | undefined,
    @Args('first', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_PAGE_SIZE,
      description: 'Number of items to fetch',
    })
    first?: number,
    @Args('after', {
      type: () => String,
      nullable: true,
      description: 'Cursor to fetch items after',
    })
    after?: string,
    @Args('windowHours', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_HEADLINE_VIEW_WINDOW_HOURS,
      description:
        'Rank by coverage in the last 6, 12, 24 or 48 hours. Any other value is BAD_WINDOW.',
    })
    windowHours?: number,
  ): Promise<TopHeadlinesForCountryResponse> {
    if (countryCode && countryCode.length > MAX_COUNTRY_CODE_LENGTH) {
      throw new BadRequestException(
        `countryCode exceeds the maximum length of ${MAX_COUNTRY_CODE_LENGTH} characters`,
      );
    }
    assertOffsetCursor(after);
    const window = windowHours ?? DEFAULT_HEADLINE_VIEW_WINDOW_HOURS;
    if (!(HEADLINE_VIEW_WINDOWS_HOURS as readonly number[]).includes(window)) {
      throw new GraphQLError(
        `windowHours must be one of ${HEADLINE_VIEW_WINDOWS_HOURS.join(', ')}`,
        { extensions: { code: 'BAD_WINDOW' } },
      );
    }
    return this.topHeadlinesService.topHeadlinesForCountry(
      countryCode,
      first ?? DEFAULT_PAGE_SIZE,
      after,
      window,
    );
  }

  @Query(() => ArticlesForPublicationSourceResponse, {
    name: 'articlesForCountry',
  })
  async articlesForCountry(
    @Args('countryCode', { type: () => String, nullable: true })
    countryCode: string | undefined,
    @Args('first', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_PAGE_SIZE,
    })
    first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ): Promise<ArticlesForPublicationSourceResponse> {
    assertKeysetCursor(after);
    return this.newsArticleService.articlesForCountry(
      countryCode,
      first ?? DEFAULT_PAGE_SIZE,
      after,
    );
  }

  @Query(() => ArticlesForPublicationSourceResponse, {
    name: 'articlesForPublisher',
    description:
      "A publisher's articles across all its feeds. Default order TOP_HEADLINES: last 24h sorted by largest cluster size. order NEWEST: newest first over 48h.",
  })
  async articlesForPublisher(
    @Args('newsPublisherId', { type: () => ID }) newsPublisherId: string,
    @Args('first', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_PAGE_SIZE,
    })
    first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
    @Args('order', {
      type: () => PublisherArticleOrder,
      nullable: true,
      defaultValue: PublisherArticleOrder.TOP_HEADLINES,
      description:
        'TOP_HEADLINES (default) keeps the original view. NEWEST is newest first across all feeds.',
    })
    order?: PublisherArticleOrder,
  ): Promise<ArticlesForPublicationSourceResponse> {
    assertKeysetCursor(after);
    if (order === PublisherArticleOrder.NEWEST) {
      return this.newsArticleService.articlesForPublisher(
        newsPublisherId,
        first ?? DEFAULT_PAGE_SIZE,
        after,
        'NEWEST',
      );
    }
    // The default path calls the service exactly as it always has, so the
    // original ordering cannot drift through this argument.
    return this.newsArticleService.articlesForPublisher(
      newsPublisherId,
      first ?? DEFAULT_PAGE_SIZE,
      after,
    );
  }

  @Query(() => ArticlesForPublicationSourceResponse, {
    name: 'articlesForPublicationSource',
  })
  async articlesForPublicationSource(
    @Args('publicationSourceId', { type: () => ID })
    publicationSourceId: string,
    @Args('first', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_PAGE_SIZE,
    })
    first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ): Promise<ArticlesForPublicationSourceResponse> {
    assertKeysetCursor(after);
    return this.newsArticleService.articlesForPublicationSource(
      publicationSourceId,
      first ?? DEFAULT_PAGE_SIZE,
      after,
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Story context  (adapter: getRelatedArticles — both fields in ONE document)
  // ───────────────────────────────────────────────────────────────────────────

  @Query(() => [ArticleSummary], { name: 'relatedArticles' })
  async relatedArticles(
    @Args('articleId', { type: () => ID }) articleId: string,
    @Args('stableClusterId', { type: () => String, nullable: true })
    stableClusterId?: string | null,
  ): Promise<ArticleSummary[]> {
    return this.articlesForTopicsService.getRelatedArticles(
      articleId,
      stableClusterId,
    );
  }

  /**
   * One ordered page of an article's sibling coverage.
   *
   * `context` carries the reader's geo/language signals, which the RELEVANCE
   * ordering needs. It exists only to order this response: it is length-capped
   * here, never logged, and never part of any cache key.
   */
  @Query(() => RelatedArticlesPage, { name: 'relatedArticlesPage' })
  async relatedArticlesPage(
    @Args('articleId', { type: () => ID }) articleId: string,
    @Args('stableClusterId', { type: () => String, nullable: true })
    stableClusterId?: string | null,
    @Args('sortMode', {
      type: () => RelatedSortModeEnum,
      nullable: true,
      defaultValue: RelatedSortModeEnum.RELEVANCE,
    })
    sortMode?: RelatedSortModeEnum | null,
    @Args('context', {
      type: () => RelatedArticlesContextInput,
      nullable: true,
    })
    context?: RelatedArticlesContextInput | null,
    @Args('excludeIds', { type: () => [ID], nullable: true })
    excludeIds?: string[] | null,
    @Args('countries', {
      type: () => [String],
      nullable: true,
      description:
        'Only coverage from these countries, ISO alpha-3 (GLOBAL for international sources). Absent or empty means all.',
    })
    countries?: string[] | null,
    @Args('languages', {
      type: () => [String],
      nullable: true,
      description:
        'Only coverage in these languages, base tags such as `de`. Absent or empty means all.',
    })
    languages?: string[] | null,
    @Args('first', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_RELATED_PAGE_SIZE,
    })
    first?: number | null,
    @Args('after', { type: () => String, nullable: true })
    after?: string | null,
  ): Promise<RelatedArticlesPage> {
    if (excludeIds && excludeIds.length > MAX_RELATED_EXCLUDE_IDS) {
      throw new BadRequestException(
        `excludeIds accepts at most ${MAX_RELATED_EXCLUDE_IDS} ids, received ${excludeIds.length}`,
      );
    }
    for (const [name, values] of [
      ['countries', countries],
      ['languages', languages],
    ] as const) {
      if (values && values.length > MAX_RELATED_FILTER_VALUES) {
        throw new BadRequestException(
          `${name} accepts at most ${MAX_RELATED_FILTER_VALUES} values, received ${values.length}`,
        );
      }
    }
    assertRelatedContextCaps(context);
    assertCursorLength(after);
    const pageSize = Math.min(
      Math.max(first ?? DEFAULT_RELATED_PAGE_SIZE, 1),
      MAX_RELATED_PAGE_SIZE,
    );
    return this.articlesForTopicsService.getRelatedArticlesPage({
      articleId,
      stableClusterId,
      sortMode: toSortMode(sortMode),
      context: toGeoLanguageContext(context),
      excludeIds,
      countries,
      languages,
      first: pageSize,
      after,
    });
  }

  @Query(() => NewsCluster, { name: 'newsClusterForArticle', nullable: true })
  async newsClusterForArticle(
    @Args('articleId', { type: () => ID }) articleId: string,
  ): Promise<NewsCluster | null> {
    return this.newsClusterService.newsClusterForArticle(articleId);
  }

  @Query(() => [ArticleClusterMemberships], {
    name: 'clusterMembershipsForArticles',
    description:
      'Cluster memberships for up to 500 article ids, from the newest complete clustering generation. An article with no links returns clusters: []; one whose links are all mid-swap is omitted. Response order is not request order.',
  })
  async clusterMembershipsForArticles(
    @Args('articleIds', { type: () => [ID] }) articleIds: string[],
  ): Promise<ArticleClusterMemberships[]> {
    if (articleIds.length > MAX_MEMBERSHIP_ARTICLE_IDS) {
      throw new BadRequestException(
        `Too many article ids: ${articleIds.length} exceeds the maximum of ${MAX_MEMBERSHIP_ARTICLE_IDS}`,
      );
    }
    return this.newsClusterService.clusterMembershipsForArticles(articleIds);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Catalogue  (adapter: listPublishers, listCountryCodes, countArticlesSince)
  // ───────────────────────────────────────────────────────────────────────────

  @Query(() => NewsPublishersResponse, { name: 'newsPublishers' })
  async newsPublishers(
    @Args('countryCode', { type: () => String, nullable: true })
    countryCode?: string,
    @Args('first', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_PAGE_SIZE,
    })
    first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ): Promise<NewsPublishersResponse> {
    assertKeysetCursor(after);
    return this.newsPublisherService.findAll(
      countryCode,
      first ?? DEFAULT_PAGE_SIZE,
      after,
    );
  }

  @Query(() => SearchPublishersResponse, { name: 'searchPublishers' })
  async searchPublishers(
    @Args('query', { type: () => String })
    query: string,
    @Args('first', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_PAGE_SIZE,
      description: 'Number of items to fetch',
    })
    first?: number,
    @Args('after', {
      type: () => String,
      nullable: true,
      description: 'Cursor to fetch items after',
    })
    after?: string,
  ): Promise<SearchPublishersResponse> {
    // Tighter than the service's own bound: strangers can reach this surface.
    const length = query.trim().length;
    if (length < MIN_SEARCH_QUERY_LENGTH || length > MAX_SEARCH_QUERY_LENGTH) {
      throw new BadRequestException(
        `query must be ${MIN_SEARCH_QUERY_LENGTH} to ${MAX_SEARCH_QUERY_LENGTH} characters`,
      );
    }
    const size = first ?? DEFAULT_PAGE_SIZE;
    if (size < 1 || size > MAX_SEARCH_PAGE_SIZE) {
      throw new BadRequestException(
        `first must be between 1 and ${MAX_SEARCH_PAGE_SIZE}`,
      );
    }
    assertCursorLength(after);
    return this.newsPublisherService.searchPublishers(query, size, after, {
      maxTimeMS: SEARCH_MAX_TIME_MS,
    });
  }

  /**
   * The publication page. Keyed by EXACTLY ONE of `newsPublisherId`, or `name`
   * plus `countryCode` (feed rows carry no publication id). Anything else is a
   * `BAD_PROFILE_KEY` error; a key that matches nothing is null.
   */
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Query(() => PublicationProfile, {
    name: 'publicationProfile',
    nullable: true,
  })
  async publicationProfile(
    @Args('newsPublisherId', { type: () => ID, nullable: true })
    newsPublisherId?: string,
    @Args('name', { type: () => String, nullable: true }) name?: string,
    @Args('countryCode', { type: () => String, nullable: true })
    countryCode?: string,
    @Args('language', { type: () => String, nullable: true })
    language?: string,
  ): Promise<PublicationProfile | null> {
    const tooLong = (value: string | null | undefined, max: number) =>
      value != null && value.length > max;
    if (tooLong(name, MAX_PROFILE_NAME_LENGTH)) {
      throw new BadRequestException(
        `name exceeds the maximum length of ${MAX_PROFILE_NAME_LENGTH} characters`,
      );
    }
    if (tooLong(countryCode, MAX_COUNTRY_CODE_LENGTH)) {
      throw new BadRequestException(
        `countryCode exceeds the maximum length of ${MAX_COUNTRY_CODE_LENGTH} characters`,
      );
    }
    if (tooLong(language, MAX_PROFILE_LANGUAGE_LENGTH)) {
      throw new BadRequestException(
        `language exceeds the maximum length of ${MAX_PROFILE_LANGUAGE_LENGTH} characters`,
      );
    }
    // An id that cannot name a publisher names no publication, not a server error.
    if (newsPublisherId != null && !OBJECT_ID_HEX.test(newsPublisherId)) {
      return null;
    }
    return this.publicationProfileService.findProfile({
      newsPublisherId,
      name,
      countryCode,
      language,
    });
  }

  @Query(() => PublicationSourcesForPublisherResponse, {
    name: 'publicationSourcesForNewsPublisher',
  })
  async publicationSourcesForNewsPublisher(
    @Args('publisherId', { type: () => ID })
    publisherId: string,
  ): Promise<PublicationSourcesForPublisherResponse> {
    // An id that cannot name a publisher names no sources, not a server error.
    if (!OBJECT_ID_HEX.test(publisherId)) return { publicationSources: [] };
    return this.newsPublisherService.findPublicationSourcesForPublisher(
      publisherId,
    );
  }

  @Query(() => [Place], {
    name: 'placeSearch',
    description:
      'Typeahead place search (anchored prefix on the lowercase key, population ' +
      'desc). Returns [] for queries under 2 chars; limit capped at 15.',
  })
  async placeSearch(
    @Args('query', { type: () => String }) query: string,
    @Args('limit', { type: () => Int, defaultValue: 8 }) limit: number,
  ): Promise<Place[]> {
    if (query.length > MAX_PLACE_QUERY_LENGTH) {
      throw new BadRequestException(
        `query exceeds the maximum length of ${MAX_PLACE_QUERY_LENGTH} characters`,
      );
    }
    return this.placeService.placeSearch(query, limit, {
      maxTimeMS: PLACE_MAX_TIME_MS,
    });
  }

  @Query(() => NewsServerStatus, {
    name: 'newsServerStatus',
    description:
      'What this server offers: whether places are seeded, how fresh the news is, and the state of clustering and headlines.',
  })
  async newsServerStatus(): Promise<NewsServerStatus> {
    return this.serverStatusService.status();
  }

  @Query(() => [String], { name: 'allCountries' })
  async allCountries(): Promise<string[]> {
    return this.countryService.findAllCountries();
  }

  /**
   * `since` is optional. The client's adapter currently sends the argument-less
   * form and documents that it IGNORES its own `since` because the backend had
   * no way to accept one — this is that way. Until the adapter is updated, the
   * argument-less path is what actually runs.
   */
  @Query(() => Int, { name: 'recentArticleCount' })
  async recentArticleCount(
    @Args('since', { type: () => Date, nullable: true })
    since?: Date | null,
  ): Promise<number> {
    return this.articlesForTopicsService.getRecentArticleCount(since);
  }
}

/**
 * Field resolver for `NewsPublisher.publicationSources`.
 *
 * NOT optional: the adapter's `MeraNewsPublishers` document selects
 * `publicationSources { … }`, and without this the field is unresolvable and
 * the whole query returns `errors`. It mirrors the app-facing resolver's
 * `@ResolveField` of the same name.
 */
@Resolver(() => NewsPublisher)
export class InternalNewsPublisherFieldResolver {
  constructor(private readonly newsPublisherService: NewsPublisherService) {}

  @ResolveField(() => [PublicationSource], { name: 'publicationSources' })
  async publicationSources(
    @Parent() publisher: NewsPublisher,
  ): Promise<PublicationSource[]> {
    const result =
      await this.newsPublisherService.findPublicationSourcesForPublisher(
        publisher._id.toString(),
      );
    return result.publicationSources;
  }
}

/**
 * Request caps, mirroring `apps/mera-server-graphql`'s app-facing resolver.
 *
 * They are duplicated rather than shared because they are a property of the
 * SURFACE, not of the pipeline: each service must be able to tighten its own
 * bound without silently tightening the other's. The values are identical
 * today, and `internal-news.contract.spec.ts` covers the shapes the adapter
 * actually sends, all of which sit well inside them.
 */
const MAX_TOPICS_PER_REQUEST = 200;
const MAX_TOPIC_TEXT_LENGTH = 512;
const MAX_HEADLINE_SCOPES = 6;
const MAX_LIMIT_PER_SCOPE = 25;
/**
 * Ceiling on quota-free hydration. Matches `articlesForStories`'s
 * `MAX_STORY_ARTICLE_IDS_PER_REQUEST`, for the same stated reason: the metered
 * sibling is bounded by its quota, an unmetered one is bounded only by request
 * size. The adapter chunks at 50.
 */
const MAX_ARTICLE_IDS_PER_REQUEST = 50;

/** Same ceiling as the app-facing API: the app's feed window, with room. */
const MAX_MEMBERSHIP_ARTICLE_IDS = 500;
const MAX_COUNTRY_CODE_LENGTH = 8;
const MIN_SEARCH_QUERY_LENGTH = 2;
const MAX_SEARCH_QUERY_LENGTH = 64;
const MAX_SEARCH_PAGE_SIZE = 50;
const MAX_PLACE_QUERY_LENGTH = 64;
/** Place search is an indexed prefix match; this only bounds a pathological scan. */
const PLACE_MAX_TIME_MS = 1000;
/** The publisher search is the one unindexed scan on this surface. */
const SEARCH_MAX_TIME_MS = 2000;
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

/** Page size for `relatedArticlesPage`'s ceiling. */
const MAX_RELATED_PAGE_SIZE = 50;
/** Ceiling on `excludeIds`: every id becomes a Set entry and a filter pass over the ordered list. */
const MAX_RELATED_EXCLUDE_IDS = 200;
/** Ceiling on each chip filter list. */
const MAX_RELATED_FILTER_VALUES = 50;
/** Ceilings on the reader's preferences: the lists and each string in them. */
const MAX_RELATED_CONTEXT_ITEMS = 50;
const MAX_RELATED_CONTEXT_STRING_LENGTH = 64;
const MAX_PROFILE_NAME_LENGTH = 200;
const MAX_PROFILE_LANGUAGE_LENGTH = 16;

/** Names the limit and never the value: a preference is the reader's own text. */
function assertRelatedContextCaps(
  context: RelatedArticlesContextInput | null | undefined,
): void {
  if (!context) return;
  for (const [field, value] of Object.entries(context)) {
    const strings = Array.isArray(value) ? value : value == null ? [] : [value];
    if (Array.isArray(value) && value.length > MAX_RELATED_CONTEXT_ITEMS) {
      throw new BadRequestException(
        `context.${field} accepts at most ${MAX_RELATED_CONTEXT_ITEMS} items, received ${value.length}`,
      );
    }
    if (
      strings.some(
        (v) =>
          typeof v === 'string' && v.length > MAX_RELATED_CONTEXT_STRING_LENGTH,
      )
    ) {
      throw new BadRequestException(
        `context.${field} accepts values of at most ${MAX_RELATED_CONTEXT_STRING_LENGTH} characters`,
      );
    }
  }
}
