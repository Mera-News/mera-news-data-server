import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  NewsArticle,
  NewsArticleSchema,
} from '@mera/models/models/news-article.model';
import {
  PublicationSource,
  PublicationSourceSchema,
} from '@mera/models/models/publication-source.model';
import {
  ClusterArticleLink,
  ClusterArticleLinkSchema,
} from '@mera/models/models/cluster-article-link.model';
import {
  NewsCluster,
  NewsClusterSchema,
} from '@mera/models/models/news-cluster.model';
import {
  HeadlineEdition,
  HeadlineEditionSchema,
} from '@mera/models/models/headline-edition.model';
import { BuildHeadlineEditionsService } from './build-headline-editions.service';
import { BuildHeadlineEditionsProcessor } from './build-headline-editions.processor';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: NewsArticle.name, schema: NewsArticleSchema },
      { name: PublicationSource.name, schema: PublicationSourceSchema },
      { name: ClusterArticleLink.name, schema: ClusterArticleLinkSchema },
      { name: NewsCluster.name, schema: NewsClusterSchema },
      { name: HeadlineEdition.name, schema: HeadlineEditionSchema },
    ]),
  ],
  providers: [BuildHeadlineEditionsService, BuildHeadlineEditionsProcessor],
  exports: [BuildHeadlineEditionsService],
})
export class BuildHeadlineEditionsModule {}
