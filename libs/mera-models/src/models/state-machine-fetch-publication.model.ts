/**
 * Per-fetch state machine tracking a publication's RSS fetch/processing job.
 * Written by mera-server-async.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import { PublicationSource } from './publication-source.model';

export type StateMachineFetchPublicationDocument =
  StateMachineFetchPublication & Document;

export enum FetchPublicationStatus {
  PENDING = 'pending',
  FETCH_FAILED = 'fetch_failed',
  FETCH_SUCCESS = 'fetch_success',
  /**
   * Fetch succeeded but the feed's last_publish_date was unchanged, so no
   * articles were ingested. Recorded so the fetch history reflects a HEALTHY
   * feed — without this row a quiet-but-reachable feed looks like it has never
   * succeeded, which would poison any history-based health evaluation.
   */
  FETCH_UNCHANGED = 'fetch_unchanged',
  LANGUAGE_DETECTION_ENQUEUED = 'language_detection_enqueued',
  LANGUAGE_DETECTION_FAILED = 'language_detection_failed',
  LANGUAGE_DETECTION_SUCCESSFUL = 'language_detection_successful',
  ENQUEUE_ARTICLE_PROCESSING_SUCCESSFUL = 'enqueue_article_processing_successful',
  ENQUEUE_ARTICLE_PROCESSING_FAILED = 'enqueue_article_processing_failed',
  BATCH_TRANSLATION_ENQUEUED = 'batch_translation_enqueued',
  BATCH_TRANSLATION_IN_PROGRESS = 'batch_translation_in_progress',
  BATCH_TRANSLATION_SUCCESSFUL = 'batch_translation_successful',
  BATCH_TRANSLATION_FAILED = 'batch_translation_failed',
  COMPLETED = 'completed',
}

registerEnumType(FetchPublicationStatus, {
  name: 'FetchPublicationStatus',
  description: 'Status of a publication fetch operation',
});

@ObjectType()
@Schema({ collection: 'state-machine-fetch-publication', timestamps: true })
export class StateMachineFetchPublication {
  @Field(() => ID)
  _id!: Types.ObjectId;

  @Field(() => ID)
  @Prop({
    type: Types.ObjectId,
    ref: 'PublicationSource',
    required: true,
  })
  publicationSourceId!: Types.ObjectId;

  @Field(() => PublicationSource, { nullable: true })
  publicationSource?: PublicationSource;

  @Field(() => FetchPublicationStatus)
  @Prop({
    required: true,
    enum: FetchPublicationStatus,
    default: FetchPublicationStatus.PENDING,
  })
  status!: FetchPublicationStatus;

  // Existing metadata fields from RSS feed
  @Field({ nullable: true })
  @Prop()
  language_code?: string;

  @Field({ nullable: true })
  @Prop()
  detected_language_code?: string;

  @Field({ nullable: true })
  @Prop()
  publication_image_uri?: string;

  @Field({ nullable: true })
  @Prop()
  update_frequency?: string;

  @Field({ nullable: true })
  @Prop()
  update_period?: number;

  @Field({ nullable: true })
  @Prop()
  last_publish_date?: Date;

  // Tracking fields for state machine
  @Field({ nullable: true })
  @Prop()
  articlesProcessed?: number;

  @Field({ nullable: true })
  @Prop()
  articlesCreated?: number;

  @Field({ nullable: true })
  @Prop()
  articlesFailed?: number;

  @Field({ nullable: true })
  @Prop()
  errorMessage?: string;

  @Field({ nullable: true })
  @Prop()
  startedAt?: Date;

  @Field({ nullable: true })
  @Prop()
  completedAt?: Date;

  // New fields for article processing tracking
  @Field(() => [ID], { nullable: true })
  @Prop({
    type: [Types.ObjectId],
    ref: 'NewsArticle',
    default: [],
  })
  articleProcessingIds?: Types.ObjectId[];

  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: 0 })
  totalArticlesToProcess?: number;

  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: 0 })
  articlesSuccessfullyEnqueued?: number;

  @Field({ nullable: true })
  @Prop()
  enqueueFailureReason?: string;

  // ---------------------------------------------------------------------
  // Fetch-health facts. Written ONLY by the fetch step of load-rss-feed, so
  // rows produced by later stages (e.g. an article-save failure) are excluded
  // from health evaluation by construction — they carry no `fetch_outcome`.
  // Mongoose-only (no @Field) — schema.gql is untouched.
  // ---------------------------------------------------------------------

  /** 'success' | 'failure' — the fetch itself, independent of downstream work. */
  @Prop()
  fetch_outcome?: string;

  /** FeedFetchCategory of a failed fetch ('http_status', 'timeout', …). */
  @Prop()
  fetch_category?: string;

  /** HTTP status of a failed fetch, when there was a response. */
  @Prop({ type: Number })
  fetch_http_status?: number | null;

  @Field()
  @Prop({ default: Date.now, index: true })
  createdAt!: Date;

  @Field()
  @Prop({ default: Date.now })
  updatedAt!: Date;
}

export const StateMachineFetchPublicationSchema = SchemaFactory.createForClass(
  StateMachineFetchPublication,
);

// Compound indexes for efficient queries.
// Note: single-field indexes on publicationSourceId/status were dropped as
// redundant prefixes of the compound indexes below; createdAt single-field
// is still declared via @Prop({ index: true }).
StateMachineFetchPublicationSchema.index({
  publicationSourceId: 1,
  createdAt: -1,
});
StateMachineFetchPublicationSchema.index({ status: 1, createdAt: -1 });

// Feed-health evaluation: per-source success/failure rollup over the retention
// window. Covers the `fetch_outcome`-scoped counts read on the failure path.
StateMachineFetchPublicationSchema.index({
  publicationSourceId: 1,
  fetch_outcome: 1,
  createdAt: -1,
});
