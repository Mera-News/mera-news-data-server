import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  ObjectType,
  Field,
  FieldMiddleware,
  Float,
  ID,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import { PublicationSource } from './publication-source.model';
import { GeoTagDto } from './geo-tag.dto';
import {
  UrlSecurityState,
  URL_SECURITY_STATE_VALUES,
} from '@mera/shared/url/url-security';

export type NewsArticleDocument = NewsArticle & Document;

export enum ArticleProcessingStatus {
  // Initial state
  PENDING = 'pending',

  // Language detection states
  DETECT_LANGUAGE_ENQUEUED = 'detect_language_enqueued',
  DETECT_LANGUAGE_FAILED = 'detect_language_failed',
  DETECT_LANGUAGE_SUCCESSFUL = 'detect_language_successful',

  // Translation states
  TRANSLATION_ENQUEUED = 'translation_enqueued',
  TRANSLATION_FAILED = 'translation_failed',
  TRANSLATION_SUCCESS = 'translation_success',
  TRANSLATION_SKIPPED = 'translation_skipped',

  // Embedding states
  EMBEDDING_ENQUEUED = 'embedding_enqueued',
  EMBEDDING_FAILED = 'embedding_failed',
  EMBEDDING_SUCCESSFUL = 'embedding_successful',

  // Aggregation states
  AGGREGATION_ENQUEUED = 'aggregation_enqueued',
  AGGREGATION_FAILED = 'aggregation_failed',
  AGGREGATION_SUCCESSFUL = 'aggregation_successful', // Final success state
}

registerEnumType(ArticleProcessingStatus, {
  name: 'ArticleProcessingStatus',
  description: 'Status of article processing through the pipeline',
});

/**
 * Reads that populate `publicationSource` leave the populated document in
 * `publicationSourceId`; the ID serialiser would refuse it and print the whole
 * document, feed address included, in its error.
 */
const sourceIdOnly: FieldMiddleware = async (_ctx, next) => {
  const value: unknown = await next();
  // An ObjectId's `_id` is itself, so an unpopulated read passes through.
  return (value as { _id?: unknown } | null | undefined)?._id ?? value;
};

@ObjectType()
@Schema({ collection: 'news-article', timestamps: true })
export class NewsArticle {
  @Field(() => ID)
  _id!: Types.ObjectId;

  @Field()
  @Prop({ required: true })
  title!: string;

  @Field()
  @Prop({ required: true })
  description!: string;

  @Field()
  @Prop({ required: true })
  pubDate!: Date;

  @Field({ nullable: true })
  @Prop()
  creator?: string;

  @Field()
  @Prop({ required: true, unique: true })
  article_url!: string;

  @Field({ nullable: true })
  @Prop()
  image_url?: string;

  @Field()
  @Prop({ required: true })
  source_uri!: string;

  // Direct link to publication source (like NewsCluster)
  @Field(() => ID, { middleware: [sourceIdOnly] })
  @Prop({
    type: Types.ObjectId,
    ref: 'PublicationSource',
    required: true,
  })
  publicationSourceId!: Types.ObjectId;

  @Field(() => PublicationSource, { nullable: true })
  publicationSource?: PublicationSource;

  @Field()
  @Prop({
    required: true,
    enum: ['news-api', 'rss-feed'],
  })
  type!: 'news-api' | 'rss-feed';

  @Field()
  @Prop({ default: Date.now, index: true })
  createdAt!: Date;

  @Field()
  @Prop({ default: Date.now })
  updatedAt!: Date;

  // Note: fetchResultId is REMOVED - relationship goes through cluster.publicationSourceId
  // Note: clusterId is REMOVED - relationship is now many-to-many via ClusterArticleLink

  /** @deprecated Superseded by `title_en` (see below); kept as a GraphQL alias
   * for shipped app builds. */
  @Field({
    nullable: true,
    deprecationReason: 'Use title_en instead. Superseded by the v3 pipeline.',
  })
  @Prop({ required: false })
  title_en_internal_only?: string;

  /** @deprecated Superseded by `description_en`. */
  @Field({
    nullable: true,
    deprecationReason:
      'Use description_en instead. Superseded by the v3 pipeline.',
  })
  @Prop({ required: false })
  description_en_internal_only?: string;

  @Field({ nullable: true })
  @Prop({ required: false })
  original_language_code?: string;

  // --- v3 (Kafka pipeline) fields — additive, greenfield names from day one ---

  // Canonical English title/description written by news-translation-job-v3
  // (English articles pass through with title_en = title). Supersedes the
  // `_internal_only` names, which survive only as deprecated GraphQL aliases.
  @Field({ nullable: true })
  @Prop({ required: false })
  title_en?: string;

  @Field({ nullable: true })
  @Prop({ required: false })
  description_en?: string;

  // Terminal translation outcome. `translation_skipped = true` means either an
  // English pass-through or an unrecoverable failure — no re-claim loops (v3
  // collapses processing status: article present in Mongo = pipeline complete).
  @Field({ nullable: true })
  @Prop({ required: false, default: false })
  translation_skipped?: boolean;

  @Field({ nullable: true })
  @Prop({ required: false })
  translation_skip_reason?: string;

  // Ingest time carried through the Kafka payload (NOT Mongo insert time). Drives
  // the v3 48h TTL below so at-least-once replays can never extend an article's
  // life. Absent on v1 docs, so the TTL index is a no-op for them.
  @Prop({ required: false })
  ingestedAt?: Date;

  // --- v3 Mongo retry ledger (replaces per-item Kafka DLQs) ---
  // Jobs stamp per-stage status on the doc; the ingest job queries for
  // `*_status: 'failed'` each run and re-enqueues those docs.

  /** v3 per-stage outcome: 'ok' | 'failed' | 'requeued' (re-enqueued by ingest, awaiting retry). Absent = not yet attempted. */
  @Field({ nullable: true })
  @Prop({ required: false })
  translation_status?: string;

  @Field(() => Int, { nullable: true })
  @Prop({ required: false })
  translation_attempts?: number;

  @Field({ nullable: true })
  @Prop({ required: false })
  embedding_status?: string;

  @Field(() => Int, { nullable: true })
  @Prop({ required: false })
  embedding_attempts?: number;

  /** Resolved publication country name + category, stamped at ingest so failed items can be re-enqueued with a fully rebuilt payload (embedding enrichment needs them). */
  @Field({ nullable: true })
  @Prop({ required: false })
  country?: string;

  @Field({ nullable: true })
  @Prop({ required: false })
  category?: string;

  // Internal fields used by async service (not exposed in GraphQL).
  // select: false keeps these multi-KB vectors out of every read path unless a
  // caller explicitly opts in via .select('+embedding_article_data_*'); hydrating
  // them unfiltered OOMed the API on a 1 GiB heap.
  @Prop({ type: [Number], default: [], select: false })
  embedding_article_data_retrieval?: number[];

  // The `embedding_article_data_text_matching_internal_only` prop
  // (v3 drift, `default: []`) was REMOVED from the schema — its default was
  // materializing an empty array on every new doc while the pipeline writes the
  // canonical UNsuffixed `embedding_article_data_text_matching` (via
  // strict:false, undeclared here on purpose so `select: false` hygiene is
  // handled by the read-path exclusion strings in graphql). graphql exclusion
  // lists reference both names as plain string paths and need no declaration.

  @Prop({ required: false })
  embedding_text_source?: 'english_original' | 'english_translation';

  // Packed sign-bit sidecar of `embedding_article_data_retrieval` — 768 bits
  // (one sign bit per dimension) = 96 bytes, vs. 3 KB for the full float32
  // vector. Built for on-device Hamming-distance near-duplicate candidate
  // generation: shipping the full vector for ~400 articles/sync is 1.2 MB,
  // too heavy on mobile at a 60s cadence; the packed sidecar is ~38 KB/sync.
  //
  // Computed at embedding time (generate-embedding.service.ts, alongside
  // embedding_article_data_retrieval), NOT per request, via the pure
  // `packSignBits` helper in `@mera/shared/vector/pack-sign-bits` — see that
  // file for the exact (MSB-first) bit-order contract the on-device client
  // must reproduce byte-for-byte.
  //
  // Buffer, not a base64 String: this field lives on every article in the
  // corpus forever, so the ~33%-smaller-at-rest Buffer/BinData encoding wins
  // over the wire-simplicity of base64. It is base64-encoded only at the
  // GraphQL/DTO boundary that actually needs to put it on the wire (see
  // `ArticleWithClusters.vector_sidecar_packed` in articles-for-topics.dto.ts)
  // — GraphQL has no native binary scalar.
  //
  // No `@Field()`: kept off the raw GraphQL `NewsArticle` type on purpose (it
  // is also used directly by other resolvers, e.g. top-headlines, that must
  // not gain this field) — exposure lives solely on the DTO above.
  //
  // select: false, matching the embedding vectors above, so it never rides
  // along on an ordinary read; callers opt in via `.select('+vector_sidecar_packed')`.
  @Prop({ type: Buffer, select: false })
  vector_sidecar_packed?: Buffer;

  // --- Story dedup (StoryKeyIndexService, database-projector) ---
  // No index on any of these: `autoIndex` would build one on deploy over the
  // largest collection, and no query filters on them (the projector's boot
  // rebuild is an `_id` range). `news-article.model.spec.ts` pins that.

  // Write-once story id: the 24-hex `_id` of the story's seed article (an
  // article that starts a story carries its own `_id`). String, not ObjectId:
  // the projector writes it in a pipeline update, which Mongoose never casts.
  @Prop({ type: String, required: false })
  story_key?: string;

  // Exact-copy keys stamped at ingest (`buildArticleCopyKeys`): `dpg:<id>`,
  // `<host>:<numeric id>`, `url:<articleUrlKey>`. Two articles sharing one are
  // the same story whatever their text.
  @Prop({ type: [String], required: false, default: undefined })
  copy_keys?: string[];

  // `packSignBits` of the text-matching vector (96 bytes), the near-copy
  // signal. Read only by the index rebuild, so `select: false` like the
  // retrieval sidecar above.
  @Prop({ type: Buffer, select: false })
  vector_sidecar_tm_packed?: Buffer;

  // --- Article processing pipeline fields ---

  /** @deprecated Internal per-stage pipeline state — not for client use. */
  @Field(() => ArticleProcessingStatus, {
    nullable: true,
    deprecationReason:
      'v1-only pipeline state; in v3 an article present in the DB is complete.',
  })
  @Prop({
    enum: ArticleProcessingStatus,
    default: ArticleProcessingStatus.PENDING,
  })
  processingStatus?: ArticleProcessingStatus;

  /** @deprecated FK into StateMachineFetchPublication; written only by
   * mera-server-async. Not for client use. */
  @Field(() => ID, {
    nullable: true,
    deprecationReason:
      'v1-only link to the fetch state machine; unused by the v3 pipeline.',
  })
  @Prop({
    type: Types.ObjectId,
    ref: 'StateMachineFetchPublication',
    required: false,
  })
  fetchPublicationId?: Types.ObjectId;

  // Translation tracking (written by mera-server-async). Note
  // `translationSkipReason` (camelCase) is distinct from the retry-ledger
  // `translation_skip_reason` (snake_case) above.
  @Prop()
  translationError?: string;

  @Prop()
  translationCompletedAt?: Date;

  @Prop()
  translationSkipReason?: string;

  // Embedding tracking (written by mera-server-async).
  @Prop()
  embeddingError?: string;

  @Prop()
  embeddingCompletedAt?: Date;

  // Aggregation tracking. `assignedClusterId` and `aggregationError` are DEAD
  // (no reader or writer anywhere — cluster membership lives in
  // ClusterArticleLink).
  @Prop({ type: Types.ObjectId, ref: 'NewsCluster' })
  assignedClusterId?: Types.ObjectId;

  @Prop()
  aggregationError?: string;

  @Prop()
  aggregationCompletedAt?: Date;

  // General processing tracking. `processingCompletedAt` is DEAD (no reader or
  // writer anywhere).
  @Prop()
  processingStartedAt?: Date;

  @Prop()
  processingCompletedAt?: Date;

  // Virtual GraphQL-only field. Not persisted on the article doc — populated
  // by cluster-context resolvers from ClusterArticleLink.confidence so the
  // client can show how strongly each article belongs to the surrounding
  // cluster (HDBSCAN membership probability, 0.0–1.0).
  @Field(() => Float, { nullable: true })
  clusterConfidence?: number | null;

  // --- Served-only article tagging (geo/entity/event metadata) ---
  // Written by the `pre-process-articles` worker for the served subset only (topic-linked
  // + top-headline sweep). Additive + nullable; untagged articles simply have
  // these unset. geo_tags is a subdocument array with `_id: false` (no per-entry
  // ObjectIds — these are value objects, not references).

  // Exposed on GraphQL (nullable) so the Explore-tab listing queries
  // (articlesForCountry / articlesForPublisher / articlesForPublicationSource)
  // can return tagging metadata for on-device city/region filtering. The
  // tags_* bookkeeping fields below stay internal (no @Field).
  @Field(() => [GeoTagDto], { nullable: true })
  @Prop({
    type: [
      {
        _id: false,
        city: { type: String, required: false },
        region: { type: String, required: false },
        countryCode: { type: String, required: true },
        // GeoNames id of the canonicalised city. MUST be declared here: the
        // pre-process bulkWrite is strict, so an undeclared subfield is
        // stripped silently with no error.
        geonameId: { type: Number, required: false },
      },
    ],
    required: false,
  })
  geo_tags?: {
    city?: string;
    region?: string;
    countryCode: string;
    geonameId?: number;
  }[];

  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], required: false })
  entities?: string[];

  @Field({ nullable: true })
  @Prop({ required: false })
  event_type?: string;

  /**
   * A two-level Google-taxonomy content category (e.g. "/Health/Health
   * Conditions"), written by the enrichment pass ONLY while
   * `ENRICHMENT_CATEGORY_ENABLED` is on, and only when the model returned a path
   * that is in `CONTENT_CATEGORIES` verbatim. Absent otherwise, including on
   * every degraded row.
   *
   * NOT the same thing as `category` above — that one is the PUBLICATION
   * SOURCE's category, stamped at ingest and fed into the retrieval embedding
   * text by `buildArticleData`. Overwriting it would corrupt embeddings, which
   * is precisely why this is a separate field.
   *
   * No consumer reads it yet. It exists so data can accumulate the moment the
   * flag is turned on.
   */
  @Field({ nullable: true })
  @Prop({ required: false })
  content_category?: string;

  // --- Enrichment v2 (OpenRouter adapter): closed-vocabulary metadata ---
  // All additive and nullable. Absent on untagged rows, degraded rows and every
  // row enriched by the Gemini adapter. Vocabularies live in
  // libs/mera-shared/src/enrichment/enrichment-spec.ts and are enforced in code
  // before the write, so an unknown value is never persisted.

  /** How wide the directly affected area is: global|multi_country|national|regional|city|neighbourhood|none. */
  @Field({ nullable: true })
  @Prop({ required: false })
  geo_scope?: string;

  /**
   * Up to 3 Google Cloud NLP content-category paths, best first, snapped onto
   * the full NLP tree (nlp-category-tree.ts), no path a prefix of another.
   */
  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], required: false })
  content_categories?: string[];

  /** news|opinion|analysis|press_release|sponsored|not_news */
  @Field({ nullable: true })
  @Prop({ required: false })
  genre?: string;

  /** positive|neutral|negative|distressing */
  @Field({ nullable: true })
  @Prop({ required: false })
  tone?: string;

  /** 1-5 severity for the people affected (not geographic breadth). */
  @Field(() => Int, { nullable: true })
  @Prop({ required: false })
  significance?: number;

  /** Tagging pipeline outcome: 'TAGGING_ENQUEUED' | 'TAGGING_IN_PROGRESS' | 'TAGGING_SUCCESSFUL' | 'TAGGING_FAILED'. */
  @Prop({ required: false })
  tags_status?: string;

  @Prop({ required: false })
  tags_attempts?: number;

  @Prop({ required: false })
  tagsError?: string;

  /** When the pre-process-articles-fanout claimed the article; drives stale-enqueued recovery. */
  @Prop({ required: false })
  tags_enqueued_at?: Date;

  // --- Insecure-URL policy (operational; deliberately NOT a @Field) ---------

  /**
   * Whether `article_url` may be served. See `UrlSecurityState` in
   * `@mera/shared/url/url-security` for the three values and their meaning.
   *
   * A STATE, not a boolean, because http URLs are three different situations:
   * already https (`secure`), was http and the https twin resolved so the https
   * URL is what is stored (`upgraded`), and was http with no working https twin
   * (`insecure` — stored as published and excluded from every serving path).
   *
   * NO SCHEMA DEFAULT, on purpose. Absent is a real fourth state meaning "never
   * evaluated": every one of the ~304k rows written before this field existed,
   * plus anything ingested while `HTTP_UPGRADE_PROBE_ENABLED=false`. Every
   * serving filter is `$ne: 'insecure'`, so absent stays SERVABLE — the safe
   * default for a corpus-wide unknown is the status quo, not a blackout. The
   * `backfill-url-security` command is what turns absent into a real value.
   *
   * Mongoose-only (no `@Field`): this is an operational flag the server acts on,
   * not something a client chooses. Exposing it would churn schema.gql and the
   * app codegen for a value no client may act on differently than the server
   * already has.
   */
  @Prop({ type: String, enum: URL_SECURITY_STATE_VALUES, required: false })
  url_security_state?: UrlSecurityState;
}

export const NewsArticleSchema = SchemaFactory.createForClass(NewsArticle);

// Index for efficient queries by date
NewsArticleSchema.index({ publicationSourceId: 1, createdAt: -1 });
// Processing pipeline index — serves the processingStatus queries.
NewsArticleSchema.index({ processingStatus: 1, createdAt: -1 });

// v3 retry ledger indexes — ingest job queries `{translation_status:'failed'}` /
// `{embedding_status:'failed'}` every run. Sparse since most docs never fail.
NewsArticleSchema.index({ translation_status: 1 }, { sparse: true });
NewsArticleSchema.index({ embedding_status: 1 }, { sparse: true });

// Tagging: the pre-process-articles-fanout claim query filters on tags_status
// (missing / TAGGING_FAILED under attempt cap / stale TAGGING_ENQUEUED). Sparse
// since only the served subset is ever tagged. Mongoose builds it at boot
// (autoIndex is on); a deployment with autoIndex off creates it by hand.
NewsArticleSchema.index({ tags_status: 1 }, { sparse: true });

// Insecure-URL exclusion: every serving path adds `{url_security_state: {$ne:
// 'insecure'}}` alongside its own recency bound, so the exclusion and the 24h/48h
// window are served by one index. Mongoose builds it at boot (autoIndex is
// on); a deployment with autoIndex off creates it by hand.
NewsArticleSchema.index({ url_security_state: 1, createdAt: -1 });

// Newest first across every source (`articlesForCountry` GLOBAL, order NEWEST):
// the index above cannot give that order under its `$ne`, so without this one
// the whole 48h window is sorted in memory. Mongoose builds it at boot
// (autoIndex is on); a deployment with autoIndex off creates it by hand.
NewsArticleSchema.index({ createdAt: -1, _id: -1 });

// 48h retention enforced by a MongoDB TTL keyed on the payload `ingestedAt`
// (NOT insert time) so replays cannot extend an article's life. TTL only acts
// on docs whose `ingestedAt` is a Date; docs without it are untouched and are
// swept by the data-retention job on `createdAt`. 48h = 172800s.
NewsArticleSchema.index(
  { ingestedAt: 1 },
  { expireAfterSeconds: 172800, name: 'v3_ingestedAt_ttl' },
);
