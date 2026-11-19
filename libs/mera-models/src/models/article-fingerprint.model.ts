import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ArticleFingerprintDocument = ArticleFingerprint & Document;

// Lean dedup-only record. Lives 90 days so we can recognize republished URLs
// long after the hot NewsArticle row has expired at 48h. Deliberately stores
// no content, no embeddings, no translations — just enough to answer
// "have we seen this URL?".
@Schema({ collection: 'article-fingerprint', timestamps: true })
export class ArticleFingerprint {
  _id!: Types.ObjectId;

  @Prop({ required: true, unique: true })
  article_url!: string;

  @Prop({
    type: Types.ObjectId,
    ref: 'PublicationSource',
    required: false,
  })
  publicationSourceId?: Types.ObjectId;

  // 90-day retention is enforced by the data-retention-sweep job.
  @Prop({ default: Date.now })
  createdAt!: Date;

  @Prop({ default: Date.now })
  updatedAt!: Date;
}

export const ArticleFingerprintSchema =
  SchemaFactory.createForClass(ArticleFingerprint);

// v3: 90-day retention is now a MongoDB TTL on `createdAt` (90d = 7776000s),
// replacing the v1 data-retention-sweep's `deleteMany({ createdAt: { $lt } })`.
// Same `{ createdAt: 1 }` key as before (MongoDB allows only one index per key
// spec), so this is a TTL upgrade of the existing sweep index rather than a new
// one — the range scans the sweep relied on still work.
// NOTE (ops): on a database that predates this TTL, an existing non-TTL `createdAt_1` index must be
// dropped once before this TTL variant can be built (autoIndex reconcile or a
// one-off migration).
ArticleFingerprintSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 7776000 },
);

ArticleFingerprintSchema.index({ publicationSourceId: 1 }, { sparse: true });
