import { ObjectType, Field, Int } from '@nestjs/graphql';

@ObjectType()
export class CursorPageInfo {
  @Field(() => String, { nullable: true })
  endCursor?: string | null;

  @Field()
  hasNextPage!: boolean;

  @Field(() => Int)
  pageSize!: number;
}
