import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ObjectType, Field, ID, Float } from '@nestjs/graphql';

export type TopicClusterLinkDocument = TopicClusterLink & Document;

@ObjectType()
@Schema({ collection: 'topic-cluster-link', timestamps: true })
export class TopicClusterLink {
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
    ref: 'NewsCluster',
    required: true,
  })
  clusterId!: Types.ObjectId;

  // Confidence/similarity score (0.0 - 1.0)
  @Field(() => Float)
  @Prop({ required: true })
  confidence!: number;

  // Whether this is the primary topic for this cluster
  @Prop({ default: false, index: true })
  isPrimary!: boolean;

  // Retention is enforced by the data-retention-sweep job (cascade from NewsCluster).
  @Field()
  @Prop({ default: Date.now, index: true })
  createdAt!: Date;
}

export const TopicClusterLinkSchema =
  SchemaFactory.createForClass(TopicClusterLink);

// Indexes
TopicClusterLinkSchema.index({ topicId: 1, clusterId: 1 }, { unique: true });
TopicClusterLinkSchema.index({
  topicId: 1,
  createdAt: -1,
  confidence: -1,
});
TopicClusterLinkSchema.index({ clusterId: 1, confidence: -1 });
