import { BadRequestException, UnauthorizedException } from '@nestjs/common';
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
  ArticleSummary,
  ArticlesForPublicationSourceResponse,
  ArticlesForTopicsByIdsResponse,
  ArticlesForTopicsService,
  DEFAULT_PAGE_SIZE,
  NewsArticleService,
  NewsClusterService,
  NewsPublisherService,
  NewsPublishersResponse,
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
 * which is why there is no `articlesForStories` twin: on this surface the two
 * would be the same query. Quota is the caller's job.
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
  })
  async topHeadlinesForCountry(
    @Args('countryCode', { type: () => String, nullable: true })
    countryCode: string | undefined,
    @Args('first', {
      type: () => Int,
      nullable: true,
      defaultValue: DEFAULT_PAGE_SIZE,
    })
    first?: number,
    @Args('after', { type: () => String, nullable: true }) after?: string,
  ): Promise<TopHeadlinesForCountryResponse> {
    return this.topHeadlinesService.topHeadlinesForCountry(
      countryCode,
      first ?? DEFAULT_PAGE_SIZE,
      after,
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
