import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import {
  NewsArticle,
  NewsArticleSchema,
} from '@mera/models/models/news-article.model';
import { PreProcessArticlesProcessor } from './pre-process-articles.processor';
import { PreProcessArticlesService } from './pre-process-articles.service';

@Module({
  imports: [
    ConfigModule,
    MongooseModule.forFeature([
      { name: NewsArticle.name, schema: NewsArticleSchema },
    ]),
  ],
  providers: [PreProcessArticlesService, PreProcessArticlesProcessor],
})
export class PreProcessArticlesModule {}
