import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  UserTopic,
  UserTopicSchema,
} from '@mera/models/models/user-topic.model';
import {
  TopicClusterLink,
  TopicClusterLinkSchema,
} from '@mera/models/models/topic-cluster-link.model';
import {
  ClusterArticleLink,
  ClusterArticleLinkSchema,
} from '@mera/models/models/cluster-article-link.model';
import {
  TopicArticleLink,
  TopicArticleLinkSchema,
} from '@mera/models/models/topic-article-link.model';
import {
  StateMachineLinkTopicsToClusters,
  StateMachineLinkTopicsToClustersSchema,
} from '@mera/models/models/state-machine-link-topics-to-clusters.model';
import { ArticleSearchModule } from '../../shared-utilities/article-search/article-search.module';
import { LinkTopicToClusterService } from './link-topic-to-clusters.service';
import { LinkTopicToClusterProcessor } from './link-topic-to-clusters.processor';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserTopic.name, schema: UserTopicSchema },
      { name: TopicClusterLink.name, schema: TopicClusterLinkSchema },
      { name: ClusterArticleLink.name, schema: ClusterArticleLinkSchema },
      { name: TopicArticleLink.name, schema: TopicArticleLinkSchema },
      {
        name: StateMachineLinkTopicsToClusters.name,
        schema: StateMachineLinkTopicsToClustersSchema,
      },
    ]),
    ArticleSearchModule,
  ],
  providers: [LinkTopicToClusterService, LinkTopicToClusterProcessor],
  exports: [LinkTopicToClusterService],
})
export class LinkTopicToClusterModule {}
