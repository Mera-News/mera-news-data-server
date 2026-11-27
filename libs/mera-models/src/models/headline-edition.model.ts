import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type HeadlineEditionDocument = HeadlineEdition & Document;

/**
 * One ordered slot in a materialized headline edition. Value object (no own
 * `_id`) — a denormalized pointer to the representative article of a cluster
 * (or a singleton) plus the ranking signals the builder used, kept so the serve
 * path can page over `entries` by offset without recomputing anything.
 */
@Schema({ _id: false })
export class HeadlineEditionEntry {
  // Representative article for this slot.
  @Prop({ type: Types.ObjectId, required: true })
  articleId!: Types.ObjectId;

  // The live cluster this slot represents, or null for an unclustered singleton.
  @Prop({ type: Types.ObjectId, default: null })
  clusterId!: Types.ObjectId | null;

  // Stable cross-run identity of the cluster (null for singletons / clusters
  // written before the field existed).
  @Prop({ type: String, default: null })
  stableClusterId!: string | null;

  // Global cluster size (across the whole clustering window). 0 for singletons.
  @Prop({ type: Number, required: true })
  clusterSize!: number;

  // How many of this cluster's members fall inside THIS scope and view window.
  // The primary ranking signal for country scopes (a story more locally covered
  // ranks higher); a tie-break on GLOBAL, where breadthScore leads.
  @Prop({ type: Number, required: true })
  inScopeCount!: number;

  // Sum of capped per-market contributions (see `perMarket` in the builder) —
  // the GLOBAL edition's primary ranking signal. Null on editions written
  // before the field existed.
  @Prop({ type: Number, default: null })
  breadthScore?: number | null;

  // Distinct publishers (`newsPublisherId`, else the source) among all of the
  // cluster's members in the build pool. 0 for singletons; null on editions
  // written before the field existed.
  @Prop({ type: Number, default: null })
  publisherCount?: number | null;

  // Distinct countries covering the story. Observability today; a candidate
  // "covered in N countries" UI label later.
  @Prop({ type: Number, default: null })
  marketCount?: number | null;

  // 0-based position of this slot in the edition (mirrors the array index; kept
  // explicit so a slice can be reasoned about independently of array order).
  @Prop({ type: Number, required: true })
  rank!: number;
}

export const HeadlineEditionEntrySchema =
  SchemaFactory.createForClass(HeadlineEditionEntry);

/**
 * One reader view of an edition other than 24h: the same scope ranked over
 * only the articles that arrived in the last `windowHours`.
 */
@Schema({ _id: false })
export class HeadlineEditionView {
  @Prop({ type: Number, required: true })
  windowHours!: number;

  @Prop({ type: Number, required: true })
  entryCount!: number;

  @Prop({ type: [HeadlineEditionEntrySchema], default: [] })
  entries!: HeadlineEditionEntry[];
}

export const HeadlineEditionViewSchema =
  SchemaFactory.createForClass(HeadlineEditionView);

/**
 * A precomputed, cluster-deduplicated "top headlines" page set for one scope,
 * rebuilt every clustering run by the `build-headline-editions` job. One doc per
 * scope; `scopeKey` is 'GLOBAL' or a country code exactly as stored on
 * publication-source `country_code`. The serve path reads a single doc and pages
 * over `entries` by offset — no request-time aggregation, and (unlike the live
 * `articlesForCountry` path) each big story appears at most once.
 */
@Schema({ collection: 'headline-edition', timestamps: true })
export class HeadlineEdition {
  // 'GLOBAL' or a publication-source `country_code` value.
  @Prop({ required: true, unique: true, index: true })
  scopeKey!: string;

  // Article pool (hours) the build streamed (48h, the article TTL). `entries`
  // is the 24h view ranked from it; the other views are in `views`.
  @Prop({ required: true })
  windowHours!: number;

  // When this edition was materialized.
  @Prop({ required: true })
  builtAt!: Date;

  // UUID of the builder run that wrote this edition (whole-run generation tag).
  @Prop({ required: true })
  buildRunId!: string;

  // Number of entries (== entries.length; denormalized for the pageInfo math).
  @Prop({ required: true })
  entryCount!: number;

  // Ordered, cluster-deduplicated slots (clusters first by rank, then singletons).
  @Prop({ type: [HeadlineEditionEntrySchema], default: [] })
  entries!: HeadlineEditionEntry[];

  // The 6h, 12h and 48h views. Empty on editions built before they existed;
  // the serve path then answers every view from `entries`.
  @Prop({ type: [HeadlineEditionViewSchema], default: [] })
  views?: HeadlineEditionView[];

  @Prop({ default: Date.now })
  createdAt!: Date;

  @Prop({ default: Date.now })
  updatedAt!: Date;
}

export const HeadlineEditionSchema =
  SchemaFactory.createForClass(HeadlineEdition);
