import { ObjectType, Field, Int } from '@nestjs/graphql';

// Shared GraphQL shape for the `geo_tags` article metadata. Lives in
// mera-models (not an app) because both the NewsArticle model and the
// articles-for-topics hydration DTO expose it — code-first schema generation
// requires exactly one @ObjectType per type name.
@ObjectType({
  description:
    'A geo tag on an article (written by the tagging pipeline). city/region are ' +
    'optional; countryCode is always present.',
})
export class GeoTagDto {
  @Field({ nullable: true })
  city?: string;

  @Field({ nullable: true })
  region?: string;

  @Field()
  countryCode!: string;

  // GeoNames id of the canonicalised city, when the place resolved against
  // the `places` gazetteer. Absent for countries, regions, supranational codes
  // and any place the gazetteer could not resolve.
  @Field(() => Int, { nullable: true })
  geonameId?: number;
}
