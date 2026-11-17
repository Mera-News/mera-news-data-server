import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MongooseModule } from '@nestjs/mongoose';
import { QueueName } from '@mera/shared';
import {
  PublicationSource,
  PublicationSourceSchema,
} from '@mera/models/models/publication-source.model';
import {
  StateMachineFetchPublication,
  StateMachineFetchPublicationSchema,
} from '@mera/models/models/state-machine-fetch-publication.model';
import {
  NewsArticle,
  NewsArticleSchema,
} from '@mera/models/models/news-article.model';
import {
  ArticleFingerprint,
  ArticleFingerprintSchema,
} from '@mera/models/models/article-fingerprint.model';
import { LoadRSSFeedService } from './load-rss-feed.service';
import { LoadRSSFeedProcessor } from './load-rss-feed.processor';
import { RSSFeedModule } from '../../shared-utilities/rss-feed/rss-feed.module';
import { LanguageDetectionModule } from '../../shared-utilities/language-detection/language-detection.module';
import { UrlSecurityModule } from '../../shared-utilities/url-security/url-security.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PublicationSource.name, schema: PublicationSourceSchema },
      {
        name: StateMachineFetchPublication.name,
        schema: StateMachineFetchPublicationSchema,
      },
      { name: NewsArticle.name, schema: NewsArticleSchema },
      { name: ArticleFingerprint.name, schema: ArticleFingerprintSchema },
    ]),
    BullModule.registerQueue({ name: QueueName.TRANSLATE_ARTICLE }),
    RSSFeedModule,
    LanguageDetectionModule,
    UrlSecurityModule,
  ],
  providers: [LoadRSSFeedService, LoadRSSFeedProcessor],
  exports: [LoadRSSFeedService],
})
export class LoadRSSFeedModule {}
