import { ObjectType, Field, ID, Float } from '@nestjs/graphql';

/**
 * One `searchNews` result.
 *
 * THE PROJECTION IS LOAD-BEARING AND MUST NOT BE WIDENED. The hit is the
 * headline only. A client uses the hits to pick ids and then hydrates the picks
 * through `articlesForTopicsByIds`, which is where the body text and the link
 * live. A field that carries an address (a source or article URL) would also
 * need the redaction resolvers this API uses everywhere else.
 *
 * `score` is a FUSED RANK score, not a similarity. Search is hybrid (lucene +
 * vector, reciprocal rank fusion), and the two legs' raw scores are on
 * incompatible scales, so nothing meaningful can be published from either one.
 * Its magnitude has no absolute interpretation and no stable range; the only
 * thing it carries is the ORDER, which is already the order of this list.
 * Do not render it as a confidence, and do not threshold on it client-side.
 */
@ObjectType({
  description:
    'A hybrid (text + semantic) search hit. Deliberately headline-only: hydrate ' +
    'the ids you want through articlesForTopicsByIds to get body text and the link.',
})
export class NewsSearchHit {
  @Field(() => ID)
  _id!: string;

  @Field({ description: 'English headline (translated at ingest).' })
  title_en!: string;

  @Field({ nullable: true })
  image_url?: string;

  @Field({ nullable: true })
  publication_name?: string;

  @Field({ nullable: true, description: 'ISO-3166 alpha-2 of the publisher.' })
  country_code?: string;

  @Field({ description: 'Publication timestamp (ISO 8601).' })
  pubDate!: string;

  @Field(() => Float, {
    description:
      'Reciprocal-rank-fusion score across the text and semantic legs. ' +
      'Ordering signal only, with no absolute scale. Do not threshold on it.',
  })
  score!: number;
}

@ObjectType({
  description:
    'One page of searchNews hits. Best effort: each page ranks the same frozen 48h window again, so a hit can repeat or be missed across pages.',
})
export class NewsSearchPage {
  @Field(() => [NewsSearchHit])
  hits!: NewsSearchHit[];

  @Field(() => String, {
    nullable: true,
    description:
      'Passed as after, reads the next page. Null on the last page, or 2500 hits deep.',
  })
  nextCursor?: string | null;
}
