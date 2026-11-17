import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  NewsArticle,
  NewsArticleSchema,
} from '@mera/models/models/news-article.model';
import { ArticleSearchService } from './article-search.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NewsArticle.name, schema: NewsArticleSchema },
    ]),
  ],
  providers: [ArticleSearchService],
  exports: [ArticleSearchService],
})
export class ArticleSearchModule {}
