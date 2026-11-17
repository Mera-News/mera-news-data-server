import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { QueueName } from '@mera/shared';
import {
  UserTopic,
  UserTopicSchema,
} from '@mera/models/models/user-topic.model';
import {
  StateMachineLinkTopicsToClusters,
  StateMachineLinkTopicsToClustersSchema,
} from '@mera/models/models/state-machine-link-topics-to-clusters.model';
import { LinkAllTopicsToClustersService } from './link-all-topics-to-clusters.service';
import { LinkAllTopicsToClustersProcessor } from './link-all-topics-to-clusters.processor';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: UserTopic.name, schema: UserTopicSchema },
      {
        name: StateMachineLinkTopicsToClusters.name,
        schema: StateMachineLinkTopicsToClustersSchema,
      },
    ]),
    BullModule.registerQueue({ name: QueueName.LINK_TOPIC_TO_CLUSTERS }),
    BullModule.registerQueue({ name: QueueName.BUILD_HEADLINE_EDITIONS }),
  ],
  providers: [LinkAllTopicsToClustersService, LinkAllTopicsToClustersProcessor],
  exports: [LinkAllTopicsToClustersService],
})
export class LinkAllTopicsToClustersModule {}
