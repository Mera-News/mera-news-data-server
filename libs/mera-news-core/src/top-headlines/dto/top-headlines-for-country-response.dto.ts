import { ObjectType, Field, Int } from '@nestjs/graphql';
import { NewsArticle } from '@mera/models/models/news-article.model';
import { CursorPageInfo } from '../../dto/pagination.dto';

/**
 * One top-headline slot: the representative article plus the per-headline
 * cluster metadata the app needs to open the story ("track this story",
 * "N related") without a second round-trip. `stableClusterId` is null for an
 * unclustered singleton (or a cluster written before the field existed);
 * `clusterSize` is 0 for a singleton.
 */
@ObjectType({
  description:
    'One top-headline slot: the representative article plus its cluster metadata (stableClusterId, clusterSize). Both are null/0 for an unclustered singleton.',
})
export class TopHeadline {
  @Field(() => NewsArticle)
  article!: NewsArticle;

  @Field(() => String, {
    nullable: true,
    description:
      "Stable cross-run identity of this headline's cluster; null for a singleton.",
  })
  stableClusterId?: string | null;

  @Field(() => Int, {
    description:
      'Global cluster size across the clustering window; 0 for a singleton.',
  })
  clusterSize!: number;

  @Field(() => Int, {
    description:
      'Distinct publishers among the cluster members, counted when the edition was built; 0 for a singleton.',
  })
  publisherCount!: number;

  @Field(() => String, {
    nullable: true,
    description:
      'Passed as after, continues right after this headline. Null where the list gives no per-headline cursor.',
  })
  cursor?: string | null;
}

@ObjectType()
export class TopHeadlinesForCountryResponse {
  /**
   * The top headlines with their per-headline cluster metadata, in edition
   * order. This is the field to read going forward.
   */
  @Field(() => [TopHeadline])
  headlines!: TopHeadline[];

  /**
   * Flat article list, kept for shipped app builds. Positionally identical to
   * `headlines.map(h => h.article)`.
   */
  @Field(() => [NewsArticle], { deprecationReason: 'Use headlines' })
  articles!: NewsArticle[];

  @Field(() => CursorPageInfo)
  pageInfo!: CursorPageInfo;

  /**
   * When the served edition was materialized. Null when no edition exists for
   * the scope yet (the response then comes from the live fallback path).
   */
  @Field(() => Date, { nullable: true })
  editionBuiltAt?: Date | null;
}
