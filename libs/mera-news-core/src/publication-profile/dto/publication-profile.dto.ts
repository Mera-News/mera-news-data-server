import { ObjectType, Field, ID, Int } from '@nestjs/graphql';

/**
 * One publication as the app's publication page shows it: a PUBLISHER, never a
 * feed. The app has no concept of feeds, so everything here is collapsed
 * across the publisher's `publication-source` rows.
 */
@ObjectType({
  description:
    'A publication (a publisher, not a feed) as shown on the publication page.',
})
export class PublicationProfile {
  @Field(() => ID, {
    description: 'Page through its articles with articlesForPublisher.',
  })
  newsPublisherId!: string;

  @Field({ description: 'The publisher name.' })
  name!: string;

  @Field({
    description:
      'The main source name in the requested language, else its raw name.',
  })
  displayName!: string;

  @Field(() => String, { nullable: true })
  homepageUrl!: string | null;

  @Field(() => String, { nullable: true })
  publicationType!: string | null;

  @Field(() => [String])
  categories!: string[];

  @Field(() => [String], {
    description: 'Language codes across all of its sources.',
  })
  languages!: string[];

  @Field({ description: 'True for a government body or a regulator.' })
  isOfficial!: boolean;

  @Field()
  countryCode!: string;

  @Field(() => String, { nullable: true })
  countryName!: string | null;

  @Field(() => [String], {
    description:
      'Every source publication_name under this publisher. Key per-publication preferences on these.',
  })
  sourceNames!: string[];

  @Field(() => String, {
    nullable: true,
    description:
      "The publisher's subscribe page. Null means it sells no consumer subscription.",
  })
  subscriptionUri!: string | null;

  @Field(() => Int, {
    nullable: true,
    description:
      "The publication's phone reading score, 0 to 100, from the reading check. Null when it has none.",
  })
  readingScore!: number | null;
}
