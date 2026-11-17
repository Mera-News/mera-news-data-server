import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

import { Document, Types } from 'mongoose';
import { ObjectType, Field, ID, Float, Int } from '@nestjs/graphql';

export type NewsClusterDocument = NewsCluster & Document;

@ObjectType()
@Schema({ collection: 'news-cluster', timestamps: true })
export class NewsCluster {
  @Field(() => ID)
  _id!: Types.ObjectId;

  @Field()
  @Prop({ default: Date.now, index: true })
  createdAt!: Date;

  @Field()
  @Prop({ default: Date.now })
  updatedAt!: Date;

  // Total members in this cluster across the rolling clustering window
  // (includes low-confidence fringe members). Denormalized by the Python
  // clustering job (mera-ml-server-py `_persist_clusters`) so readers don't
  // have to count cluster-article-link rows. Singletons/noise are size 1.
  // Nullable for back-compat with cluster docs written before this field.
  @Field(() => Int, { nullable: true })
  @Prop({ type: Number })
  clusterSize?: number | null;

  // Populated only when this cluster is fetched in the context of a specific
  // user topic (e.g. `newsClusters(userTopicId: ...)`). Carries the
  // TopicClusterLink confidence so the client can show match strength.
  @Field(() => Float, { nullable: true })
  topicConfidence?: number | null;

  // v3 (additive): stamps the clustering run (UUID) that wrote this cluster.
  // The projector/topic-linker tag every write with it; the topic-linker deletes
  // stale generations at the END of its run (generation swap — see the plan's
  // idempotency section). Indexed for the `deleteMany({clusteringRunId:{$ne}})`.
  @Prop({ required: false, index: true })
  clusteringRunId?: string;

  // Additive: stable identity for a multi-member cluster, written by the
  // Python clustering job (mera-ml-server-py `_persist_clusters`) so a story
  // can be tracked across rolling-window clustering runs even though the
  // underlying NewsCluster doc is wipe-and-reinserted each run. Singletons/
  // noise clusters do not get one. Nullable everywhere — back-compat with
  // cluster docs written before this field, and with singleton clusters.
  @Field(() => String, { nullable: true })
  @Prop({ required: false, index: true })
  stableClusterId?: string;
}

export const NewsClusterSchema = SchemaFactory.createForClass(NewsCluster);
