import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'One node of the seeded canonical category tree.' })
export class CanonicalTopic {
  @Field(() => ID)
  id!: string;

  @Field(() => String)
  path!: string;

  @Field(() => String)
  label!: string;

  @Field(() => Int)
  level!: number;

  // A union-typed field needs its GraphQL type stated.
  @Field(() => ID, {
    nullable: true,
    description: 'Null while only the first level is seeded.',
  })
  parentId?: string | null;
}
