import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { QueueName } from '@mera/shared';
import {
  NewsArticle,
  NewsArticleSchema,
} from '@mera/models/models/news-article.model';
import { TranslateArticleProcessor } from './translate-article.processor';
import { TranslateArticleService } from './translate-article.service';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: NewsArticle.name, schema: NewsArticleSchema },
    ]),
    BullModule.registerQueue({ name: QueueName.GENERATE_EMBEDDING_ARTICLE }),
  ],
  providers: [TranslateArticleService, TranslateArticleProcessor],
})
export class TranslateArticleModule {}
