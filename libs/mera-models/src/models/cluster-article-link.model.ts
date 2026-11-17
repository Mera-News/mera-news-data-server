import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';

export type ClusterArticleLinkDocument = ClusterArticleLink & Document;

@ObjectType()
@Schema({ collection: 'cluster-article-link', timestamps: true })
export class ClusterArticleLink {
  @Field(() => ID)
  _id!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'NewsCluster',
    required: true,
  })
  clusterId!: Types.ObjectId;

  @Prop({
    type: Types.ObjectId,
    ref: 'NewsArticle',
    required: true,
  })
  articleId!: Types.ObjectId;

  // Confidence/similarity score from vector search (0.0 - 1.0)
  @Field(() => Float)
  @Prop({ required: true })
  confidence!: number;

  // Retention is enforced by the data-retention-sweep job (cascade from NewsArticle/NewsCluster).
  @Field()
  @Prop({ default: Date.now, index: true })
  createdAt!: Date;

  // v3 (additive): clustering-run generation tag (see NewsCluster.clusteringRunId).
  @Prop({ required: false, index: true })
  clusteringRunId?: string;
}

export const ClusterArticleLinkSchema =
  SchemaFactory.createForClass(ClusterArticleLink);

// Indexes
ClusterArticleLinkSchema.index(
  { clusterId: 1, articleId: 1 },
  { unique: true },
);
ClusterArticleLinkSchema.index({
  clusterId: 1,
  createdAt: -1,
  confidence: -1,
});
ClusterArticleLinkSchema.index({ articleId: 1, confidence: -1 });
