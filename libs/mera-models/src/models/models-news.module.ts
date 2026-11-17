import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { UserTopic, UserTopicSchema } from './user-topic.model';
import {
  StateMachineLinkTopicsToClusters,
  StateMachineLinkTopicsToClustersSchema,
} from './state-machine-link-topics-to-clusters.model';
import {
  PublicationSource,
  PublicationSourceSchema,
} from './publication-source.model';
import { NewsCluster, NewsClusterSchema } from './news-cluster.model';
import {
  StateMachineFetchPublication,
  StateMachineFetchPublicationSchema,
} from './state-machine-fetch-publication.model';
import { NewsArticle, NewsArticleSchema } from './news-article.model';
import {
  TopicClusterLink,
  TopicClusterLinkSchema,
} from './topic-cluster-link.model';
import {
  TopicArticleLink,
  TopicArticleLinkSchema,
} from './topic-article-link.model';
import { NewsPublisher, NewsPublisherSchema } from './news-publisher.model';
import {
  ClusterArticleLink,
  ClusterArticleLinkSchema,
} from './cluster-article-link.model';
import {
  ArticleFingerprint,
  ArticleFingerprintSchema,
} from './article-fingerprint.model';
import {
  HeadlineEdition,
  HeadlineEditionSchema,
} from './headline-edition.model';

/**
 * News-side schemas: the shared, anonymous corpus. Nothing registered here is
 * keyed by a user, which is what lets the news services eventually run with a
 * credential that cannot reach any user-owned collection. Keep it that way:
 * nothing with a `userId` is registered here.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      // NOT user data despite the name: `UserTopic` is a global, anonymous,
      // text-keyed topic cache with no owner field, shared by every client.
      // Same for its two edge collections below.
      { name: UserTopic.name, schema: UserTopicSchema },
      {
        name: StateMachineLinkTopicsToClusters.name,
        schema: StateMachineLinkTopicsToClustersSchema,
      },
      { name: PublicationSource.name, schema: PublicationSourceSchema },
      { name: NewsCluster.name, schema: NewsClusterSchema },
      {
        name: StateMachineFetchPublication.name,
        schema: StateMachineFetchPublicationSchema,
      },
      { name: NewsArticle.name, schema: NewsArticleSchema },
      // Edge models for topic graph (anonymous, keyed by topic text)
      { name: TopicClusterLink.name, schema: TopicClusterLinkSchema },
      { name: TopicArticleLink.name, schema: TopicArticleLinkSchema },
      // Cluster-article relationship (many-to-many with confidence)
      { name: ClusterArticleLink.name, schema: ClusterArticleLinkSchema },
      // News publishers (parent grouping for publication sources)
      { name: NewsPublisher.name, schema: NewsPublisherSchema },
      // 90-day URL-only dedup ledger; outlives the 48h NewsArticle TTL
      { name: ArticleFingerprint.name, schema: ArticleFingerprintSchema },
      // Precomputed, cluster-deduplicated top-headlines editions (per scope)
      { name: HeadlineEdition.name, schema: HeadlineEditionSchema },
    ]),
  ],
  exports: [MongooseModule],
})
export class ModelsNewsModule {}
