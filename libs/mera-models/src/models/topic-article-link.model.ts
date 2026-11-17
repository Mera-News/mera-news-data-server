import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';

export type TopicArticleLinkDocument = TopicArticleLink & Document;

@ObjectType()
@Schema({ collection: 'topic-article-link', timestamps: true })
export class TopicArticleLink {
  @Field(() => ID)
  _id!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'UserTopic',
    required: true,
  })
  topicId!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'NewsArticle',
    required: true,
    index: true,
  })
  articleId!: Types.ObjectId;

  // Confidence/similarity score from vector search (0.0 - 1.0)
  @Field(() => Float)
  @Prop({ required: true })
  confidence!: number;

  // Retention is enforced by the data-retention-sweep job (cascade from NewsArticle).
  @Field()
  @Prop({ default: Date.now, index: true })
  createdAt!: Date;

  // v3 (additive): clustering-run generation tag. The topic-linker writes links
  // tagged with the current run and, at the END of its run, deletes links from
  // stale generations across NewsCluster/ClusterArticleLink/TopicArticleLink.
  @Prop({ required: false, index: true })
  clusteringRunId?: string;

  // Link to a canonical category row; excluded from enrichment claiming.
  @Prop({ required: false })
  canonical?: boolean;
}

export const TopicArticleLinkSchema =
  SchemaFactory.createForClass(TopicArticleLink);

// Indexes
TopicArticleLinkSchema.index({ topicId: 1, articleId: 1 }, { unique: true });
// articleId lookups are served by the `articleId: 1` index on the @Prop above
// (the `{ articleId: 1, confidence: -1 }` superset and the
// `{ topicId: 1, createdAt: -1, confidence: -1 }` index were unused — 0 ops).
