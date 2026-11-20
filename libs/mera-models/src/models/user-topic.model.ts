import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema, Types } from 'mongoose';

export type UserTopicDocument = UserTopic & Document;

// NOT a GraphQL @ObjectType. `UserTopic` is a server-internal, anonymous topic
// cache: one row per distinct topic text, no owner field, but in practice most
// rows are a single user's location-anchored private query. Exposing any of it
// (an object type, a vector search, a per-topic count) is a cross-user read of
// what is effectively a set of personal profiles, so there is no GraphQL layer
// here. The Mongoose schema below is unchanged — it is
// still the live personalization warm/cold cache and the retention target.
@Schema({ collection: 'user-topic' })
export class UserTopic {
  _id!: Types.ObjectId;

  @Prop({ required: true, unique: true, index: true })
  news_topic_text!: string;

  @Prop({ required: true, type: [Number] })
  news_topic_embed!: number[];

  // Whether this is a canonical category (Google NLP) vs user-generated
  @Prop({ default: false, index: true })
  is_canonical!: boolean;

  // Canonical rows (is_canonical) are the seeded category tree, keyed by
  // news_topic_text = "cat:" + canonical_path. Never user-derived.
  @Prop({ required: false })
  canonical_level?: number;

  @Prop({ required: false })
  canonical_path?: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: false })
  canonical_parent_id?: MongooseSchema.Types.ObjectId;

  @Prop({ type: [Number], required: false })
  canonical_embed?: number[];

  @Prop({ default: Date.now, index: true })
  createdAt!: Date;

  @Prop({ default: Date.now })
  updatedAt!: Date;

  // Retention signal for the ANONYMOUS topic cache. `UserTopic` is keyed by
  // `news_topic_text` and shared by every client — no document here records
  // WHICH user asked for a topic, and this field does not change that: it is
  // refreshed (throttled) whenever ANY client requests the topic, so it only
  // ever says "somebody asked for this recently", never who.
  //
  // Needed because nothing links a user to a topic any more (no persona holds
  // topic ids), so lifetime is now purely
  // age-based: the `UserTopic` rule in RETENTION_RULES drops topics nobody has
  // requested in 14 days (they regenerate via the cold path on next request).
  // `updatedAt` above cannot serve this purpose — the schema has no
  // `timestamps: true`, so it is stamped once at insert and never maintained.
  @Prop({ type: Date, default: Date.now, index: true })
  lastRequestedAt!: Date;

  // A followed story's names (any one must appear in an article), derived by
  // an LLM from `news_topic_text` ALONE and written only when a strict request
  // asks for this text, never on a canonical row. Like everything here they
  // describe the text, not who asked; they are swept with the row. `[]` means a
  // broad story with no filter. `must_match_version` is the prompt version
  // (`STORY_NAMES_PROMPT_VERSION`); an older one regenerates on the next strict
  // request. No index: every read is by the unique `news_topic_text`.
  // `default: undefined`: Mongoose defaults arrays to `[]`, which would read as
  // "broad story" on a row nobody generated names for.
  @Prop({ type: [String], required: false, default: undefined })
  must_match?: string[];

  @Prop({ required: false })
  must_match_version?: number;

  @Prop({ type: Date, required: false })
  must_match_at?: Date;

  // A LOOSE topic's place anchor ("Bhopal weather" -> ["Bhopal"]), derived by
  // an LLM from `news_topic_text` ALONE, plus each place's first-level region
  // from `places` ("Madhya Pradesh"), never the country. An article must name
  // one of them. `[]` means no place, no filter. Same lifecycle as
  // `must_match`: never on a canonical row, swept with the row, no index.
  // `place_terms_version` is `PLACE_TERMS_PROMPT_VERSION`.
  @Prop({ type: [String], required: false, default: undefined })
  place_terms?: string[];

  @Prop({ type: [String], required: false, default: undefined })
  place_regions?: string[];

  @Prop({ required: false })
  place_terms_version?: number;

  // A followed story's gates (`story-gates.ts` in news-core): each a kind, a
  // text derived by an LLM from `news_topic_text` ALONE, and that text's query
  // vector. An article must pass every gate. `[]` means no gate. Same
  // lifecycle as `must_match`. `story_gates_version` is `STORY_GATES_VERSION`.
  @Prop({
    type: [{ kind: String, text: String, vector: [Number], _id: false }],
    required: false,
    default: undefined,
  })
  story_gates?: { kind: string; text: string; vector: number[] }[];

  @Prop({ required: false })
  story_gates_version?: number;
}

export const UserTopicSchema = SchemaFactory.createForClass(UserTopic);

UserTopicSchema.index({ is_canonical: 1, canonical_level: 1 });
