import { ObjectType, Field } from '@nestjs/graphql';
import { NewsCluster } from '@mera/models/models/news-cluster.model';
import { CursorPageInfo } from '../../dto/pagination.dto';

@ObjectType()
export class NewsClustersResponse {
  @Field(() => [NewsCluster])
  newsClusters!: NewsCluster[];

  @Field(() => CursorPageInfo)
  pageInfo!: CursorPageInfo;
}
