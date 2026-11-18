import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { GraphQLError } from 'graphql';
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
@Resolver()
export class InternalNewsResolver {
  constructor(
    private readonly articlesForTopicsService: ArticlesForTopicsService,
    private readonly newsArticleService: NewsArticleService,
    private readonly topHeadlinesService: TopHeadlinesService,
    private readonly newsClusterService: NewsClusterService,
    private readonly newsPublisherService: NewsPublisherService,
    private readonly countryService: CountryService,
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
    assertCursorLength(after);
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
    return this.newsArticleService.articlesForCountry(
      countryCode,
      first ?? DEFAULT_PAGE_SIZE,
      after,
    );
  }

  @Query(() => ArticlesForPublicationSourceResponse, {
    name: 'articlesForPublisher',
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
  ): Promise<ArticlesForPublicationSourceResponse> {
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
const MAX_CURSOR_LENGTH = 512;
const MIN_SEARCH_QUERY_LENGTH = 2;
const MAX_SEARCH_QUERY_LENGTH = 64;
const MAX_SEARCH_PAGE_SIZE = 50;
/** The publisher search is the one unindexed scan on this surface. */
const SEARCH_MAX_TIME_MS = 2000;
const OBJECT_ID_HEX = /^[0-9a-fA-F]{24}$/;

function assertCursorLength(after: string | null | undefined): void {
  if (after && after.length > MAX_CURSOR_LENGTH) {
    throw new BadRequestException(
      `after exceeds the maximum length of ${MAX_CURSOR_LENGTH} characters`,
    );
  }
}
