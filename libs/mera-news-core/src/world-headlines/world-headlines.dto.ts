import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { CursorPageInfo } from '../dto/pagination.dto';
import { TopHeadline } from '../top-headlines/dto/top-headlines-for-country-response.dto';

@ObjectType()
export class CanonicalTopicFacet {
  @Field(() => ID)
  topicId!: string;

  @Field(() => Int)
  count!: number;
}

@ObjectType()
export class WorldHeadlinesResponse {
  @Field(() => [TopHeadline])
  headlines!: TopHeadline[];

  @Field(() => CursorPageInfo)
  pageInfo!: CursorPageInfo;

  @Field(() => Date, { nullable: true })
  editionBuiltAt?: Date | null;

  @Field(() => [CanonicalTopicFacet], {
    description:
      'Story counts per canonical topic over the whole edition (ignores the filter), descendants rolled up, nonzero only.',
  })
  facets!: CanonicalTopicFacet[];

  @Field(() => String, {
    nullable: true,
    description:
      'Null on a normal answer. When a topic filter was sent but cannot apply, headlines is empty and this says why: NO_EDITION, NO_CANONICAL_TOPICS or NO_TOPIC_LINKS. The unfiltered list is never served for a filtered request.',
  })
  unavailableReason?: string | null;
}
