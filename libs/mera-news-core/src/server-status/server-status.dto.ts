import { Field, ObjectType } from '@nestjs/graphql';

/** What this news server offers. Nothing in it names a person, a query or a key. */
@ObjectType()
export class NewsServerStatus {
  @Field({ description: 'True once the places seed has been loaded.' })
  placesSeeded!: boolean;

  @Field(() => Date, {
    nullable: true,
    description: 'When the newest article was stored.',
  })
  lastArticleAt!: Date | null;

  @Field(() => Date, { nullable: true })
  lastClusteringAt!: Date | null;

  @Field(() => Date, { nullable: true })
  lastTopicLinkAt!: Date | null;

  @Field()
  headlineEditionsBuilt!: boolean;

  @Field(() => String, { nullable: true })
  vectorIndexState!: string | null;

  @Field(() => String, { nullable: true })
  embeddingModel!: string | null;
}
