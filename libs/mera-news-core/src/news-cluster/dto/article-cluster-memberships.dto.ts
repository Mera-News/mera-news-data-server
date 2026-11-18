import { Field, ID, ObjectType } from '@nestjs/graphql';
import { ClusterMembership } from '../../articles-for-topics/dto/articles-for-topics.dto';

// The answer row of `clusterMembershipsForArticles`.
@ObjectType({
  description:
    "One article's cluster memberships from the newest COMPLETE clustering generation.",
})
export class ArticleClusterMemberships {
  @Field(() => ID)
  articleId!: string;

  @Field(() => [ClusterMembership])
  clusters!: ClusterMembership[];
}
