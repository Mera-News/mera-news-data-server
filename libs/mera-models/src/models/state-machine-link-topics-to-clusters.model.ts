/**
 * Batch topic-linking state machine. Written by mera-server-async's
 * link-all-topics-to-clusters run.
 */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';

export type StateMachineLinkTopicsToClustersDocument =
  StateMachineLinkTopicsToClusters & Document;

export enum LinkTopicsToClustersStatus {
  PENDING = 'pending',
  ENQUEUE_SUCCESS = 'enqueue_success', // Final success state
  ENQUEUE_FAILED = 'enqueue_failed',
}

registerEnumType(LinkTopicsToClustersStatus, {
  name: 'LinkTopicsToClustersStatus',
  description: 'Status of batch topic-to-cluster linking operation',
});

@ObjectType()
@Schema({
  collection: 'state-machine-link-topics-to-clusters',
  timestamps: true,
})
export class StateMachineLinkTopicsToClusters {
  @Field(() => ID)
  _id!: Types.ObjectId;

  @Field(() => LinkTopicsToClustersStatus)
  @Prop({
    required: true,
    enum: LinkTopicsToClustersStatus,
    default: LinkTopicsToClustersStatus.PENDING,
  })
  status!: LinkTopicsToClustersStatus;

  @Field(() => Int)
  @Prop({ required: true })
  totalTopicsEnqueuedForProcessing!: number;

  @Field(() => [ID])
  @Prop({ type: [Types.ObjectId], ref: 'UserTopic', default: [] })
  processedTopicIds!: Types.ObjectId[];

  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: 0 })
  successfullyEnqueuedCount?: number;

  @Field(() => Int, { nullable: true })
  @Prop({ type: Number, default: 0 })
  failedToEnqueueCount?: number;

  @Field({ nullable: true })
  @Prop()
  errorMessage?: string;

  @Field()
  @Prop({ default: Date.now, index: true })
  createdAt!: Date;

  @Field()
  @Prop({ default: Date.now })
  updatedAt!: Date;
}

export const StateMachineLinkTopicsToClustersSchema =
  SchemaFactory.createForClass(StateMachineLinkTopicsToClusters);

// Add index for efficient querying
StateMachineLinkTopicsToClustersSchema.index({ createdAt: -1 });
StateMachineLinkTopicsToClustersSchema.index({ status: 1, createdAt: -1 });

// Backward compatibility aliases
/**
 * @deprecated Use StateMachineLinkTopicsToClusters instead
 */
export const StateMachineUserTopic = StateMachineLinkTopicsToClusters;
/**
 * @deprecated Use StateMachineLinkTopicsToClustersDocument instead
 */
export type StateMachineUserTopicDocument =
  StateMachineLinkTopicsToClustersDocument;
/**
 * @deprecated Use StateMachineLinkTopicsToClustersSchema instead
 */
export const StateMachineUserTopicSchema =
  StateMachineLinkTopicsToClustersSchema;
