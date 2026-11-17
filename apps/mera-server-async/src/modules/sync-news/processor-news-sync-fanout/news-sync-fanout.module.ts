import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { QueueName } from '@mera/shared';
import {
  PublicationSource,
  PublicationSourceSchema,
} from '@mera/models/models/publication-source.model';
import {
  NewsArticle,
  NewsArticleSchema,
} from '@mera/models/models/news-article.model';
import { NewsSyncFanoutService } from './news-sync-fanout.service';
import { NewsSyncFanoutProcessor } from './news-sync-fanout.processor';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: PublicationSource.name, schema: PublicationSourceSchema },
      { name: NewsArticle.name, schema: NewsArticleSchema },
    ]),
    BullModule.registerQueue(
      { name: QueueName.LOAD_RSS_FEED },
      { name: QueueName.TRANSLATE_ARTICLE },
      { name: QueueName.GENERATE_EMBEDDING_ARTICLE },
    ),
  ],
  providers: [NewsSyncFanoutService, NewsSyncFanoutProcessor],
})
export class NewsSyncFanoutModule {}
