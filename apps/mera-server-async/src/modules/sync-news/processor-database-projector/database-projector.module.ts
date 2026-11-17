import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
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
  TopicArticleLink,
  TopicArticleLinkSchema,
} from '@mera/models/models/topic-article-link.model';
import { DatabaseProjectorService } from './database-projector.service';
import { DatabaseProjectorProcessor } from './database-projector.processor';
import { StoryKeyIndexService } from './story-key-index.service';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: NewsArticle.name, schema: NewsArticleSchema },
      // Story-key near-copy exclusion interns feed -> publisher.
      { name: PublicationSource.name, schema: PublicationSourceSchema },
      { name: TopicArticleLink.name, schema: TopicArticleLinkSchema },
    ]),
    // Enrich on ingest hands marked ids to the existing queue (no new queue).
    BullModule.registerQueue({ name: QueueName.PRE_PROCESS_ARTICLES }),
  ],
  providers: [
    DatabaseProjectorService,
    DatabaseProjectorProcessor,
    StoryKeyIndexService,
  ],
  exports: [DatabaseProjectorService],
})
export class DatabaseProjectorModule {}
