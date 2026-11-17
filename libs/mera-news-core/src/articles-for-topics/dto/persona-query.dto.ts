import {
  ObjectType,
  Field,
  ID,
  Int,
  Float,
  InputType,
  registerEnumType,
} from '@nestjs/graphql';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Scope of a top-headlines request within a persona query.
 * COUNTRY requires a countryCode; GLOBAL spans all countries and takes none.
 */
export enum HeadlineScope {
  COUNTRY = 'COUNTRY',
  GLOBAL = 'GLOBAL',
}

registerEnumType(HeadlineScope, {
  name: 'HeadlineScope',
  description:
    'Top-headlines scope. COUNTRY requires countryCode; GLOBAL takes none.',
});

@InputType({
  description:
    'A single persona topic. `limit` overrides the query-level limitPerTopic; ' +
    '`afterCursor` is the articleId of the last item on the previous page.',
})
export class PersonaTopicInput {
  @Field()
  @IsString()
  @MaxLength(512)
  text!: string;

  @Field(() => Int, { nullable: true })
  @IsOptional()
  limit?: number;

  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  afterCursor?: string;

  /**
   * Opt this topic into the followed-story match: every article must name the
   * story, by the names stored on the topic's `UserTopic` row (generated from
   * the text alone on the first strict request; see `resolveStoryNames`). The
   * GraphQL description below predates this and still speaks of place terms;
   * rewording it moves `schema.gql` and needs an app codegen.
   *
   * The flag itself is REQUEST-SCOPED: it lives on the in-memory
   * classification and never reaches `UserTopic`, the anonymous shared cache
   * and the privacy boundary. The names it causes to be stored describe the
   * text, never who asked.
   *
   * No `@IsBoolean()`: no ValidationPipe runs on nested inputs here (see the
   * resolver's caps), so GraphQL's own type system is the enforcement.
   */
  @Field(() => Boolean, {
    defaultValue: false,
    description:
      'Require the narrowest place term in the topic rather than any of them. ' +
      'Request-scoped and never stored.',
  })
  strictMatch!: boolean;
}

@InputType({
  description:
    'A single top-headlines scope. COUNTRY requires countryCode; GLOBAL takes none.',
})
export class HeadlineScopeInput {
  @Field(() => HeadlineScope)
  scope!: HeadlineScope;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  countryCode?: string;

  /**
   * Per-scope depth override. Absent ⇒ the query-level `limitPerScope`.
   *
   * Exists because reader interest is not uniform across scopes: someone may
   * want 25 headlines from the country they live in and 5 from a country they
   * merely have family in. `limitPerScope` alone cannot express that — it sits
   * OUTSIDE the scopes array, so one number governs every scope.
   *
   * Bounded by the same maximum of 25 as `limitPerScope` (enforced at the
   * resolver, re-clamped in the service) — a per-scope override must not be a
   * way around the query-level ceiling.
   */
  @Field(() => Int, { nullable: true })
  @IsOptional()
  limit?: number;
}

@InputType({
  description:
    'Optional top-headlines block. Up to 6 scopes; limitPerScope capped at 25.',
})
export class TopHeadlinesInput {
  @Field(() => [HeadlineScopeInput])
  scopes!: HeadlineScopeInput[];

  @Field(() => Int, { defaultValue: 10 })
  limitPerScope!: number;
}

@InputType({
  description:
    'Privacy-lean persona query: topic texts + optional top-headlines scopes. ' +
    'No locations, weights, or exclude-topics are ever accepted here (deliberate).',
})
export class PersonaQueryInput {
  @Field(() => [PersonaTopicInput], {
    description: 'Up to MAX_TOPICS_PER_REQUEST (default 200); topicText ≤ 512.',
  })
  topics!: PersonaTopicInput[];

  @Field(() => TopHeadlinesInput, { nullable: true })
  @IsOptional()
  topHeadlines?: TopHeadlinesInput;

  @Field(() => Int, { defaultValue: 20 })
  limitPerTopic!: number;

  @Field(() => Int, {
    nullable: true,
    description:
      'Optional hard cap on total ids across topicResults; the lowest-priority ' +
      '(last) topics are truncated first once the cap is reached.',
  })
  @IsOptional()
  maxArticles?: number;
}

@ObjectType({
  description:
    'Per-article match metadata. textScore is ALWAYS null in v1. ' +
    "stableClusterId is the id of the article's largest-clusterSize linked " +
    'cluster, null when the article is a singleton/unclustered.',
})
export class PersonaMatchMeta {
  @Field(() => ID)
  articleId!: string;

  /**
   * ANN cosine similarity, or NULL when this row was never scored.
   *
   * MUST stay nullable. Warm-path rows (TopicArticleLink cache hits) are served
   * without ever running a vector search, and the cold path filters
   * `score >= VECTOR_RETRIEVAL_MIN_SCORE` (0.78) — so a genuine score is always
   * >= 0.78 and `0` is unreachable as a real similarity.
   *
   * The client scales every positive topic weight by
   * `smoothstep(vectorScore, 0.78, 0.90)` whenever the value is non-null, and
   * `smoothstep(0, …) === 0`. Emitting `0` for "not scored" therefore ZEROES the
   * topic weight of every warm-path article — silently, with no error anywhere.
   * `null` is the client's documented "no signal" case and passes through
   * unmodulated at x1.
   */
  @Field(() => Float, { nullable: true })
  vectorScore?: number | null;

  @Field(() => Float, { nullable: true })
  textScore?: number | null;

  @Field(() => String, { nullable: true })
  stableClusterId?: string | null;
}

@ObjectType({
  description: 'Resolved article ids + match metadata for one persona topic.',
})
export class PersonaTopicResult {
  @Field()
  topicText!: string;

  @Field(() => [ID])
  articleIds!: string[];

  @Field(() => [PersonaMatchMeta])
  matchMeta!: PersonaMatchMeta[];

  @Field(() => ID, { nullable: true })
  nextCursor?: string | null;

  @Field()
  hasNextPage!: boolean;
}

@ObjectType({
  description:
    'Top-headline article ids for one scope. clusterSizes and stableClusterIds ' +
    'are positionally aligned with articleIds.',
})
export class HeadlineScopeResult {
  @Field(() => HeadlineScope)
  scope!: HeadlineScope;

  @Field(() => String, { nullable: true })
  countryCode?: string | null;

  @Field(() => [ID])
  articleIds!: string[];

  @Field(() => [Int])
  clusterSizes!: number[];

  // [String]! — list is non-null, items may be null (singleton/unclustered).
  @Field(() => [String], { nullable: 'items' })
  stableClusterIds!: (string | null)[];
}

@ObjectType({
  description:
    'Privacy-lean persona query result: per-topic article ids + match metadata, ' +
    'plus optional per-scope top headlines.',
})
export class PersonaQueryResult {
  @Field(() => [PersonaTopicResult])
  topicResults!: PersonaTopicResult[];

  @Field(() => [HeadlineScopeResult])
  headlineResults!: HeadlineScopeResult[];
}
