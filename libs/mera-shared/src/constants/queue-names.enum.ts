/**
 * Enum defining all BullMQ queue names used across the application.
 * Use these constants instead of hardcoded strings for type safety.
 */
export enum QueueName {
  LOAD_RSS_FEED = 'load-rss-feed',
  NEWS_SYNC_FANOUT = 'news-sync-fanout',
  GENERATE_EMBEDDING_ARTICLE = 'generate-embedding-article',
  DATABASE_PROJECTOR = 'database-projector',
  LINK_ALL_TOPICS_TO_CLUSTERS = 'link-all-topics-to-clusters',
  LINK_TOPIC_TO_CLUSTERS = 'link-topic-to-clusters',
  BUILD_HEADLINE_EDITIONS = 'build-headline-editions',
  TRANSLATE_ARTICLE = 'translate-article',
  PRE_PROCESS_ARTICLES_FANOUT = 'pre-process-articles-fanout',
  PRE_PROCESS_ARTICLES = 'pre-process-articles',
  DATA_RETENTION_SWEEP = 'data-retention-sweep',
}
