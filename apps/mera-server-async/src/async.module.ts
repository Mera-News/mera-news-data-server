import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CacheModule } from '@nestjs/cache-manager';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { QueueName, StructuredLoggerModule, HealthModule } from '@mera/shared';
import { buildCacheModuleOptions, buildBullRootConfig } from './redis-config';

// Import queue modules - sync-news flow (ID-array ingestion pipeline)
import { NewsSyncFanoutModule } from './modules/sync-news/processor-news-sync-fanout/news-sync-fanout.module';
import { LoadRSSFeedModule } from './modules/sync-news/processor-load-rss-feed/load-rss-feed.module';
import { GenerateEmbeddingModule } from './modules/sync-news/processor-generate-embedding-news-article/generate-embedding.module';
import { DatabaseProjectorModule } from './modules/sync-news/processor-database-projector/database-projector.module';
import { TranslateArticleModule } from './modules/sync-news/processor-translate-article/translate-article.module';
import { PreProcessArticlesFanoutModule } from './modules/sync-news/processor-pre-process-articles-fanout/pre-process-articles-fanout.module';
import { PreProcessArticlesModule } from './modules/sync-news/processor-pre-process-articles/pre-process-articles.module';

// Pipeline provider composition roots (env-selected adapters)
import { TranslationProviderModule } from './modules/sync-news/pipeline-providers/translation-provider.module';
import { ArticleEnrichmentProviderModule } from './modules/sync-news/pipeline-providers/article-enrichment-provider.module';
import { PipelineEmbeddingProviderModule } from './modules/sync-news/pipeline-providers/embedding-provider.module';
import { LanguageDetectorModule } from './modules/sync-news/pipeline-providers/language-detector.module';
import { ArticleCacheModule } from './modules/sync-news/pipeline-providers/article-cache.module';

// Import queue modules - link-topics-to-clusters flow
import { LinkAllTopicsToClustersModule } from './modules/link-topics-to-clusters/processor-link-all-topics-to-clusters/link-all-topics-to-clusters.module';
import { LinkTopicToClusterModule } from './modules/link-topics-to-clusters/processor-link-topic-to-clusters/link-topic-to-clusters.module';

// Import queue modules - headline editions (precomputed top-headlines)
import { BuildHeadlineEditionsModule } from './modules/headline-editions/processor-build-headline-editions/build-headline-editions.module';

// Import queue modules - data retention
import { DataRetentionModule } from './modules/data-retention/data-retention.module';
import { LocalSchedulesModule } from './modules/local-schedules/local-schedules.module';

// Import shared utilities
import { AxiosModule } from './modules/shared-utilities/axios/axios.module';
import { RSSFeedModule } from './modules/shared-utilities/rss-feed/rss-feed.module';

// Import other modules
import { RestEndpointsModule } from './modules/rest-endpoints/rest-endpoints.module';
import { MeraModelsModule } from '@mera/models';
import { SearchIndexModule } from '@mera/models/search-index/search-index.module';

/**
 * Creates BullMQ queue configurations.
 * Default job options are set at the BullModule.forRootAsync() level.
 */
function createQueueConfigs(queueNames: QueueName[]) {
  return queueNames.map((name) => ({ name }));
}

// Get all queue names from the QueueName enum.
//
// This registers QUEUES, never WORKERS. A member with no `@Processor` gets a
// queue that accepts jobs and drains nowhere, on a noeviction Redis, so keep
// this enum and the `imports` above in step.
const ALL_QUEUES = Object.values(QueueName);

@Module({
  imports: [
    StructuredLoggerModule.forRoot('mera-server-async'),
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: 'apps/mera-server-async/.env',
      cache: true,
    }),
    // Data cache (RSS-dedup fingerprints, pub-source-info). Reads
    // PERSISTENT_REDIS_URL (falling back to REDIS_URL) and honors
    // CACHE_KEY_PREFIX so staging can share prod's persistent Redis instance
    // without key collisions. See ./redis-config.ts.
    CacheModule.registerAsync({
      isGlobal: true,
      useFactory: (configService: ConfigService) =>
        buildCacheModuleOptions(configService),
      inject: [ConfigService],
    }),
    MeraModelsModule,
    // The one process that builds a missing search index at boot.
    SearchIndexModule.forRoot({ create: true }),
    AxiosModule,

    RSSFeedModule,

    // Pipeline provider composition roots (@Global — env-selected adapters)
    TranslationProviderModule,
    ArticleEnrichmentProviderModule,
    PipelineEmbeddingProviderModule,
    LanguageDetectorModule,
    ArticleCacheModule,

    NewsSyncFanoutModule,
    LoadRSSFeedModule,
    GenerateEmbeddingModule,
    DatabaseProjectorModule,
    TranslateArticleModule,
    PreProcessArticlesFanoutModule,
    PreProcessArticlesModule,
    RestEndpointsModule,
    LinkAllTopicsToClustersModule,
    LinkTopicToClusterModule,
    BuildHeadlineEditionsModule,
    DataRetentionModule,
    LocalSchedulesModule,

    // BullMQ queues/flows. The `prefix` (BULLMQ_PREFIX, default `bull`)
    // propagates to every registerQueue()/registerFlowProducer() below and to
    // the workers/QueueEvents the explorer creates, so staging (bull-stg) reads
    // its own queues on a shared instance. See ./redis-config.ts.
    BullModule.forRootAsync({
      useFactory: (configService: ConfigService) =>
        buildBullRootConfig(configService),
      inject: [ConfigService],
    }),
    BullModule.registerQueue(...createQueueConfigs(ALL_QUEUES)),
    HealthModule.forRoot({ mongo: true, redis: true }),
  ],
})
export class MeraServerAsyncModule {}
