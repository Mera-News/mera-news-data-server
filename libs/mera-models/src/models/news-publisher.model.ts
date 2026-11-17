import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ObjectType, Field, ID } from '@nestjs/graphql';

export type NewsPublisherDocument = NewsPublisher & Document;

@ObjectType()
@Schema({ collection: 'news-publisher', timestamps: true })
export class NewsPublisher {
  @Field(() => ID)
  _id!: Types.ObjectId;

  @Field()
  @Prop({ required: true })
  name!: string;

  @Field({ nullable: true })
  @Prop()
  website_url?: string;

  @Field()
  @Prop({ required: true, index: true })
  country_code!: string;

  @Field({ nullable: true })
  @Prop()
  country_name?: string;

  /**
   * Structured taxonomy, mirrored from PublicationSource (a publisher is the
   * publication, so type/genre belongs here too; the copy on PublicationSource
   * exists because that is what the feed pipeline and the app query). Closed
   * vocabularies: PUBLICATION_TYPES / PUBLICATION_CATEGORIES in
   * @mera/models/constants/publication-taxonomy.
   */
  @Field({ nullable: true })
  @Prop({ index: true })
  publication_type?: string;

  @Field(() => [String], { nullable: true })
  @Prop({ type: [String], index: true })
  categories?: string[];

  /**
   * The publisher's own subscribe/pricing landing page, with mera.news
   * referral tracking appended client-side (see
   * `mera-app/lib/subscriptions/subscription-url.ts`). Absent/null means the
   * publisher has no consumer subscription product — that is a first-class
   * value, not missing data, and is how the app knows to skip the browser
   * step and offer "I subscribe to this" directly. No index: never queried
   * by, only read off an already-resolved publisher row.
   */
  @Field({ nullable: true })
  @Prop()
  subscription_uri?: string;

  @Field({ defaultValue: true })
  @Prop({ default: true })
  is_active!: boolean;

  @Field()
  @Prop({ default: Date.now })
  createdAt!: Date;

  @Field()
  @Prop({ default: Date.now })
  updatedAt!: Date;
}

export const NewsPublisherSchema = SchemaFactory.createForClass(NewsPublisher);

// Unique compound index: one publisher per name + country_code combination
NewsPublisherSchema.index({ name: 1, country_code: 1 }, { unique: true });

// Makes findAll's sort({name:1,_id:1}) non-blocking (no in-memory sort stage)
// for the common case of no country_code filter. It serves searchPublishers
// not at all: an unanchored $regex can never use an index, only a
// leading-anchor ($regex: /^prefix/) can, and that query orders its matches
// in process by name tier. Note the
// {name:1, country_code:1} compound index above already has `name` as its
// prefix and partially serves the same sort; a {name:1, _id:1} compound
// index would fully cover it (name + tiebreaker) but that's a bigger change
// than this stage calls for.
NewsPublisherSchema.index({ name: 1 });
