import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { QueueName } from '@mera/shared';
import {
  TopicArticleLink,
  TopicArticleLinkSchema,
} from '@mera/models/models/topic-article-link.model';
import {
  NewsArticle,
  NewsArticleSchema,
} from '@mera/models/models/news-article.model';
import { PreProcessArticlesFanoutService } from './pre-process-articles-fanout.service';
import { PreProcessArticlesFanoutProcessor } from './pre-process-articles-fanout.processor';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: TopicArticleLink.name, schema: TopicArticleLinkSchema },
      { name: NewsArticle.name, schema: NewsArticleSchema },
    ]),
    BullModule.registerQueue({ name: QueueName.PRE_PROCESS_ARTICLES }),
  ],
  providers: [
    PreProcessArticlesFanoutService,
    PreProcessArticlesFanoutProcessor,
  ],
})
export class PreProcessArticlesFanoutModule {}
