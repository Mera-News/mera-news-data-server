import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { ConfigModule } from '@nestjs/config';
import { QueueName } from '@mera/shared';
import {
  NewsArticle,
  NewsArticleSchema,
} from '@mera/models/models/news-article.model';
import {
  PublicationSource,
  PublicationSourceSchema,
} from '@mera/models/models/publication-source.model';
import {
  UserTopic,
  UserTopicSchema,
} from '@mera/models/models/user-topic.model';
import { CanonicalTopicIndex } from './canonical-topic-index.service';
import { GenerateEmbeddingService } from './generate-embedding.service';
import { GenerateEmbeddingProcessor } from './generate-embedding.processor';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: NewsArticle.name, schema: NewsArticleSchema },
      { name: PublicationSource.name, schema: PublicationSourceSchema },
      { name: UserTopic.name, schema: UserTopicSchema },
    ]),
    BullModule.registerQueue({ name: QueueName.DATABASE_PROJECTOR }),
  ],
  providers: [
    CanonicalTopicIndex,
    GenerateEmbeddingService,
    GenerateEmbeddingProcessor,
  ],
  exports: [GenerateEmbeddingService],
})
export class GenerateEmbeddingModule {}
