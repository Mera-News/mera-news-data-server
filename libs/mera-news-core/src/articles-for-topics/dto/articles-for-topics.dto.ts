import { ObjectType, Field, ID, Float, Int, InputType } from '@nestjs/graphql';
import { IsOptional, IsString, MaxLength } from 'class-validator';
// GeoTagDto lives in mera-models so NewsArticle (a lib model) can
// reuse it without an app->lib inverted import. Re-exported to keep this
// module's public surface unchanged.
import { GeoTagDto } from '@mera/models/models/geo-tag.dto';

export { GeoTagDto };

@InputType()
export class TopicPaginationInput {
  @Field()
  @IsString()
  @MaxLength(512)
  topicText!: string;

  @Field({
    nullable: true,
    description:
      'articleId of the last item on the previous page; omit for first page',
  })
  @IsOptional()
  @IsString()
  afterCursor?: string;
}

@ObjectType()
export class TopicArticleIdsResult {
  @Field()
  topicText!: string;

  @Field(() => [ID])
  articleIds!: string[];

  @Field({ nullable: true })
  nextCursor?: string;

  @Field()
  hasNextPage!: boolean;
}

@ObjectType()
export class ArticleIdsForTopicsResponse {
  @Field(() => [TopicArticleIdsResult])
  results!: TopicArticleIdsResult[];
}

@ObjectType({
  description: 'Sibling article returned by the relatedArticles query',
})
export class ArticleSummary {
  @Field(() => ID)
  _id!: string;

  @Field()
  title_en!: string;

  @Field({ nullable: true })
  description_en?: string;

  @Field({ nullable: true })
  article_url?: string;

  @Field({ nullable: true })
  image_url?: string;

  @Field({ nullable: true })
  country_code?: string;

  @Field({ nullable: true })
  publication_name?: string;

  @Field({ nullable: true })
  language_code?: string;

  /** Title in the article's own language. Set only by the relatedArticlesPage hydrator. */
  @Field({ nullable: true })
  title_original?: string;

  @Field()
  pubDate!: Date;
}

@ObjectType({
  description:
    'Membership of an article in a cluster, with the HDBSCAN confidence (0.0–1.0)',
})
export class ClusterMembership {
  @Field(() => ID)
  clusterId!: string;

  @Field(() => Float)
  confidence!: number;

  // Stable identity for the cluster across rolling-window clustering
  // runs (see NewsCluster.stableClusterId). Null when the cluster is a
  // singleton/noise, or predates the field.
  @Field(() => String, { nullable: true })
  stableClusterId?: string | null;
}

@ObjectType({
  description:
    'Article summary with cluster membership — used by Flow v2 hydration',
})
export class ArticleWithClusters {
  @Field(() => ID)
  _id!: string;

  @Field(() => [ClusterMembership])
  clusters!: ClusterMembership[];

  @Field()
  title_en!: string;

  @Field({ nullable: true })
  title?: string;

  @Field({ nullable: true })
  description_en?: string;

  @Field({ nullable: true })
  article_url?: string;

  @Field({ nullable: true })
  image_url?: string;

  @Field({ nullable: true })
  country_code?: string;

  @Field({ nullable: true })
  publication_name?: string;

  @Field({ nullable: true })
  language_code?: string;

  @Field()
  pubDate!: Date;

  // --- Hydration metadata: all nullable, additive ---

  @Field(() => [GeoTagDto], { nullable: true })
  geo_tags?: {
    city?: string;
    region?: string;
    countryCode: string;
    geonameId?: number;
  }[];

  @Field(() => [String], { nullable: true })
  entities?: string[];

  @Field({ nullable: true })
  event_type?: string;

  // The PUBLICATION SOURCE's category (reuses the existing publication-source
  // join), NOT the article's own `category` field.
  @Field({ nullable: true })
  category?: string;

  // --- Enrichment v2 (jev P5b): all nullable, additive. Mirrors the fields
  // added to NewsArticle in libs/mera-models (jev P5a). geo_tags above is
  // UNCHANGED in shape but its MEANING moved: it now denotes places the event
  // happens in or where residents are directly affected, not places merely
  // mentioned in the article — a semantic change, not a wire one.

  /** global|multi_country|national|regional|city|neighbourhood|none */
  @Field({ nullable: true })
  geo_scope?: string;

  /** Up to 3 Google NLP taxonomy paths, best first. */
  @Field(() => [String], { nullable: true })
  content_categories?: string[];

  /** news|opinion|analysis|press_release|sponsored|not_news */
  @Field({ nullable: true })
  genre?: string;

  /** positive|neutral|negative|distressing */
  @Field({ nullable: true })
  tone?: string;

  /** 1-5 severity for the people affected (not geographic breadth). */
  @Field(() => Int, { nullable: true })
  significance?: number;

  // Max clusterSize over the article's linked clusters (0/null when none).
  @Field(() => Int, { nullable: true })
  maxClusterSize?: number | null;

  // The story this article belongs to: the 24-hex id of its seed article,
  // assigned once at ingest. Copies of one report share it; the app groups by
  // it. Null when the article predates the field or was never assigned.
  @Field(() => String, { nullable: true })
  story_key?: string | null;

  // Packed sign-bit sidecar of `embedding_article_data_retrieval` — 768 bits
  // (96 bytes), base64-encoded, for on-device Hamming-distance near-duplicate
  // candidate generation. bit i = (vector[i] >= 0), packed MSB-first within
  // each byte; see `packSignBits` in `@mera/shared/vector/pack-sign-bits` for
  // the exact contract the client must reproduce byte-for-byte — getting the
  // bit order wrong silently produces a plausible but incorrect distance.
  // Null when the article predates this field or embedding failed.
  @Field({ nullable: true })
  vector_sidecar_packed?: string;
}

@ObjectType({
  description:
    'Hydrated articles for a set of IDs, plus the daily-delivery-cap signal. ' +
    'The cap is charged here (delivery point), so a clipped response means the ' +
    "user hit their daily article limit — distinct from IDs that simply TTL'd out.",
})
export class ArticlesForTopicsByIdsResponse {
  @Field(() => [ArticleWithClusters])
  articles!: ArticleWithClusters[];

  @Field({
    description:
      "True when the user's daily article-delivery cap clipped this response (fewer articles returned than requested).",
  })
  dailyLimitReached!: boolean;

  @Field({
    nullable: true,
    description:
      'ISO timestamp of the next 00:00 UTC when the daily cap resets; set only when dailyLimitReached is true.',
  })
  resetAt?: string;
}
