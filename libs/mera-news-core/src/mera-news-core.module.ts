import {
  DynamicModule,
  Module,
  type ModuleMetadata,
  Provider,
} from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  NewsArticle,
  NewsArticleSchema,
} from '@mera/models/models/news-article.model';
import {
  ClusterArticleLink,
  ClusterArticleLinkSchema,
} from '@mera/models/models/cluster-article-link.model';
import {
  NewsCluster,
  NewsClusterSchema,
} from '@mera/models/models/news-cluster.model';
import {
  PublicationSource,
  PublicationSourceSchema,
} from '@mera/models/models/publication-source.model';
import {
  UserTopic,
  UserTopicSchema,
} from '@mera/models/models/user-topic.model';
import {
  TopicArticleLink,
  TopicArticleLinkSchema,
} from '@mera/models/models/topic-article-link.model';
import {
  HeadlineEdition,
  HeadlineEditionSchema,
} from '@mera/models/models/headline-edition.model';
import {
  NewsPublisher,
  NewsPublisherSchema,
} from '@mera/models/models/news-publisher.model';
import { ArticlesForTopicsService } from './articles-for-topics/articles-for-topics.service';
import { NewsArticleService } from './news-article/news-article.service';
import { TopHeadlinesService } from './top-headlines/top-headlines.service';
import { NewsClusterService } from './news-cluster/news-cluster.service';
import { NewsPublisherService } from './news-publisher/news-publisher.service';
import { CountryService } from './country/country.service';
import { ARTICLE_QUOTA } from './quota/article-quota.port';
import { STORY_NAMES_GENERATOR } from '@mera/shared/story-names/story-names.port';

/**
 * Self-contained composition of the news pipeline, for an app that wants the
 * whole thing in one import.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `forRoot` AND NOT A PLAIN `@Module`
 *
 * The pipeline needs exactly one thing it cannot decide for itself: whether
 * delivery is metered. That is `ARTICLE_QUOTA`, and its correct binding depends
 * on the trust boundary the consuming app sits on — an app-facing API meters
 * against the signed-in user, an internal service-to-service relay has no user
 * to meter and must not acquire one.
 *
 * Passing it in makes that a decision the app states out loud in its own
 * composition root, rather than something this library guesses. There is
 * deliberately no default: a missing binding is a boot-time DI failure, which
 * is exactly what should happen — the alternative is a service that boots
 * healthy and then either charges nobody or refuses everybody.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE CONSUMER MUST STILL PROVIDE
 *
 *   EMBEDDING_PROVIDER   `EmbeddingProviderModule` (exported from this lib) is
 *                        `@Global()`, so importing it anywhere in the app is
 *                        enough.
 *   CACHE_MANAGER        `CacheModule` — the topic-classification cache.
 *   ConfigService        `ConfigModule` — read at construction for
 *                        `JINA_QUERY_BATCH`.
 *   A Mongoose connection scoped to the NEWS collections only.
 *
 * NOTE: `apps/mera-server-graphql` does NOT use this module. It keeps its own
 * long-standing `ArticlesForTopicsModule` / `NewsArticleModule` wiring, which
 * registers the same models alongside the user-side ones it also needs —
 * rewiring the live app was churn with no behavioural gain. This is the
 * composition root for `apps/mera-server-news-api`, which registers news models
 * and nothing else and imports this module directly.
 */
@Module({})
export class MeraNewsCoreModule {
  /**
   * @param quota The `ARTICLE_QUOTA` binding. Use `NoopArticleQuota` for an
   * unmetered (internal, no-user) deployment.
   * @param storyNames The `STORY_NAMES_GENERATOR` binding. Required for the
   * same reason as `quota`: a surface that never generates states it
   * (`UnconfiguredStoryNamesGenerator`, which still applies stored names).
   */
  static forRoot(options: {
    quota: Provider;
    storyNames: Provider;
    /** Modules the `quota` or `storyNames` provider needs for its own dependencies. */
    imports?: ModuleMetadata['imports'];
  }): DynamicModule {
    return {
      module: MeraNewsCoreModule,
      imports: [
        // Every schema below is news-side (see `ModelsNewsModule`). Nothing
        // keyed by a `userId` is registered here, and nothing may be added:
        // that is what lets a consumer run this pipeline with a database
        // credential that cannot reach the user collections at all.
        MongooseModule.forFeature([
          { name: NewsArticle.name, schema: NewsArticleSchema },
          { name: ClusterArticleLink.name, schema: ClusterArticleLinkSchema },
          { name: NewsCluster.name, schema: NewsClusterSchema },
          { name: PublicationSource.name, schema: PublicationSourceSchema },
          // Anonymous, text-keyed topic cache — no owner field. News-side
          // despite the name; see the comment in `ModelsNewsModule`.
          { name: UserTopic.name, schema: UserTopicSchema },
          { name: TopicArticleLink.name, schema: TopicArticleLinkSchema },
          { name: HeadlineEdition.name, schema: HeadlineEditionSchema },
          { name: NewsPublisher.name, schema: NewsPublisherSchema },
        ]),
        ...(options.imports ?? []),
      ],
      providers: [
        options.quota,
        options.storyNames,
        NewsArticleService,
        ArticlesForTopicsService,
        TopHeadlinesService,
        NewsClusterService,
        NewsPublisherService,
        CountryService,
      ],
      exports: [
        ARTICLE_QUOTA,
        STORY_NAMES_GENERATOR,
        NewsArticleService,
        ArticlesForTopicsService,
        TopHeadlinesService,
        NewsClusterService,
        NewsPublisherService,
        CountryService,
        MongooseModule,
      ],
    };
  }
}
