import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  NewsArticle,
  NewsArticleSchema,
} from '@mera/models/models/news-article.model';
import {
  ClusterArticleLink,
  ClusterArticleLinkSchema,
} from '@mera/models/models/cluster-article-link.model';
import { TitleSelectorService } from './title-selector.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NewsArticle.name, schema: NewsArticleSchema },
      { name: ClusterArticleLink.name, schema: ClusterArticleLinkSchema },
    ]),
  ],
  providers: [TitleSelectorService],
  exports: [TitleSelectorService],
})
export class TitleSelectorModule {}
