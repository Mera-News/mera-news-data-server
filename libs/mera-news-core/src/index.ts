/**
 * `@mera/news-core` — the news retrieval, ranking and hydration pipeline.
 *
 * Everything registered here reads ONLY the anonymous news corpus (the
 * schemas in `ModelsNewsModule`). Nothing in this library may import a
 * `userId`-keyed model, a session, a guard or an app composition root: it is
 * consumed by both the app-facing API (where a user is present) and the
 * internal service-to-service news relay (where one deliberately is not).
 *
 * The single place user identity enters the pipeline is `ARTICLE_QUOTA`, and it
 * enters as an injected port — see `quota/article-quota.port.ts`.
 */

// Quota port — the one seam where a user-metered deployment differs from an
// unmetered one.
export {
  ARTICLE_QUOTA,
  type ArticleQuotaPort,
  type QuotaReservation,
} from './quota/article-quota.port';
export { NoopArticleQuota } from './quota/noop-article-quota';

// Retrieval + hydration
export { ArticlesForTopicsService } from './articles-for-topics/articles-for-topics.service';
export {
  TopicPaginationInput,
  TopicArticleIdsResult,
  ArticleIdsForTopicsResponse,
  ArticleWithClusters,
  ArticlesForTopicsByIdsResponse,
  ArticleSummary,
  ClusterMembership,
} from './articles-for-topics/dto/articles-for-topics.dto';
export { ArticleClusterMemberships } from './news-cluster/dto/article-cluster-memberships.dto';
export {
  PersonaQueryInput,
  PersonaQueryResult,
  PersonaTopicResult,
  PersonaMatchMeta,
  HeadlineScopeResult,
  HeadlineScope,
  HeadlineScopeInput,
  TopHeadlinesInput,
  PersonaTopicInput,
} from './articles-for-topics/dto/persona-query.dto';
export {
  RelatedSortModeEnum,
  toSortMode,
} from './articles-for-topics/dto/related-sort-mode.enum';
export {
  RelatedArticleFacets,
  RelatedArticlesContextInput,
  RelatedArticlesPage,
  RelatedFacetCount,
  toGeoLanguageContext,
} from './articles-for-topics/dto/related-articles.dto';

// Catalogue reads (country / publisher / source listings, article by id)
export {
  NewsArticleService,
  MAX_NEWEST_PAGE_SIZE,
} from './news-article/news-article.service';
export type { PublisherArticleSort } from './news-article/news-article.service';
export { PublisherArticleOrder } from './news-article/dto/publisher-article-order.enum';
export { ArticlesForPublicationSourceResponse } from './news-article/dto/articles-for-publication-source-response.dto';
export {
  EmbeddingSearchResponse,
  EmbeddingSearchResult,
} from './news-article/dto/embedding-search-response.dto';

// Query-side embeddings (topic → vector), used by the cold retrieval path
export {
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
} from './embedding-provider/embedding-provider.port';
export { EmbeddingProviderModule } from './embedding-provider/embedding-provider.module';
export { FakeEmbeddingProvider } from './embedding-provider/fake-embedding.provider';
export { topicEmbedText } from './embedding-provider/topic-embed-text';

// Catalogue reads moved in P2 so the internal news API can serve the same
// root fields as the app-facing API.
export { TopHeadlinesService } from './top-headlines/top-headlines.service';
export { TopHeadlinesForCountryResponse, TopHeadline } from './top-headlines/dto/top-headlines-for-country-response.dto';
export {
  NewsClusterService,
  MAX_ARTICLES_PER_CLUSTER_PAGE,
} from './news-cluster/news-cluster.service';
export { NewsClustersResponse } from './news-cluster/dto/news-clusters-response.dto';
export { ClusterArticlesConnection } from './news-cluster/dto/cluster-articles-connection.dto';
export { NewsPublisherService } from './news-publisher/news-publisher.service';
export {
  NewsPublishersResponse,
  PublicationSourcesForPublisherResponse,
} from './news-publisher/dto/news-publishers-response.dto';
export {
  SearchPublishersResponse,
  PublisherSearchHit,
} from './news-publisher/dto/search-publishers.dto';
export { CountryService } from './country/country.service';

// Headline edition scope keys — editions are keyed alpha-3 + GLOBAL, callers
// send alpha-2. Both serve paths normalize through this.
export {
  toHeadlineScopeKey,
  GLOBAL_SCOPE_KEY,
} from './headline-scope/headline-scope-key';
export {
  HEADLINE_VIEW_WINDOWS_HOURS,
  DEFAULT_HEADLINE_VIEW_WINDOW_HOURS,
  pickEditionEntries,
} from './headline-scope/headline-window';

// Shared pagination surface
export { CursorPageInfo } from './dto/pagination.dto';
export { DEFAULT_PAGE_SIZE } from './constants';

// Source address redaction
export {
  PublicSourceResolver,
  ArticleSourceUriResolver,
} from './source-url/source-url.resolvers';

// Publication page
export { PublicationProfileService } from './publication-profile/publication-profile.service';
export { PublicationProfile } from './publication-profile/dto/publication-profile.dto';

// World headlines
export { WorldHeadlinesService } from './world-headlines/world-headlines.service';
export {
  CanonicalTopicFacet,
  WorldHeadlinesResponse,
} from './world-headlines/world-headlines.dto';

// News search
export {
  NewsSearchService,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from './news-search/news-search.service';
export { NewsSearchHit } from './news-search/news-search.dto';

// Place search and the server status answer
export { PlaceService } from './place/place.service';
export { PlaceModule } from './place/place.module';
export { ServerStatusService } from './server-status/server-status.service';
export { NewsServerStatus } from './server-status/server-status.dto';

// Composition
export { MeraNewsCoreModule } from './mera-news-core.module';
