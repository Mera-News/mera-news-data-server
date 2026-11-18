import { Args, Int, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { ConfigService } from '@nestjs/config';
import { NewsCluster } from '@mera/models/models/news-cluster.model';
import {
  ClusterArticlesConnection,
  MAX_ARTICLES_PER_CLUSTER_PAGE,
  NewsClusterService,
} from '@mera/news-core';
import { assertKeysetCursor } from './cursor-guard';

/**
 * `NewsCluster.articles`. The field sits only under the single cluster that
 * `newsClusterForArticle` returns, so it runs once per request: no N+1.
 */
@Resolver(() => NewsCluster)
export class NewsClusterArticlesResolver {
  constructor(
    private readonly newsClusterService: NewsClusterService,
    private readonly config: ConfigService,
  ) {}

  @ResolveField(() => ClusterArticlesConnection, { name: 'articles' })
  async articles(
    @Parent() cluster: NewsCluster,
    @Args('first', {
      type: () => Int,
      nullable: true,
      defaultValue: MAX_ARTICLES_PER_CLUSTER_PAGE,
      description: `Number of articles to fetch (max ${MAX_ARTICLES_PER_CLUSTER_PAGE})`,
    })
    first?: number,
    @Args('after', {
      type: () => String,
      nullable: true,
      description: 'Cursor to fetch articles after',
    })
    after?: string,
  ): Promise<ClusterArticlesConnection> {
    assertKeysetCursor(after);
    // The membership score is a diagnostic: shown outside production only.
    return this.newsClusterService.clusterArticles(
      String(cluster._id),
      Math.max(first ?? MAX_ARTICLES_PER_CLUSTER_PAGE, 1),
      after,
      this.config.get<string>('NODE_ENV') !== 'production',
    );
  }
}
