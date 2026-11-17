import { ObjectType, Field, ID } from '@nestjs/graphql';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { CursorPageInfo } from '../../dto/pagination.dto';

/**
 * A publisher-keyed search hit. Deliberately flat (not `NewsPublisher` +
 * `@ResolveField publicationSources`) — that resolve field fetches ALL of a
 * publisher's sources, which would contradict "matching sources" and cost an
 * N+1 fetch per row. `matchingSources` here is the subset of the publisher's
 * `PublicationSource`s whose name/URL actually matched the query.
 */
@ObjectType()
export class PublisherSearchHit {
  @Field(() => ID)
  _id!: string;

  @Field()
  name!: string;

  @Field({ nullable: true })
  website_url?: string;

  @Field()
  country_code!: string;

  @Field({ nullable: true })
  country_name?: string;

  /**
   * The publisher's subscribe/pricing page, or null when the publisher has
   * no consumer subscription product. Mirrors `NewsPublisher.subscription_uri`
   * — see that field's doc comment. Without this on the flat hit, the `+`
   * picker can't see it (this DTO deliberately doesn't reuse `NewsPublisher`
   * — see the class comment above).
   */
  @Field(() => String, { nullable: true })
  subscription_uri?: string | null;

  @Field(() => [PublicationSource])
  matchingSources!: PublicationSource[];
}

@ObjectType()
export class SearchPublishersResponse {
  @Field(() => [PublisherSearchHit])
  publishers!: PublisherSearchHit[];

  @Field(() => CursorPageInfo)
  pageInfo!: CursorPageInfo;
}
