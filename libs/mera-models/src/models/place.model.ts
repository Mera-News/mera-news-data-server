import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ObjectType, Field, ID, Int, Float } from '@nestjs/graphql';

export type PlaceDocument = Place & Document;

/**
 * A searchable place (city/locality) used by the `placeSearch` typeahead. Seeded
 * from GeoNames (see the `seed-places` script). `normalized` is the lowercase,
 * ASCII-folded search key; the typeahead does an anchored prefix regex on it.
 */
@ObjectType()
@Schema({ collection: 'places', timestamps: false })
export class Place {
  @Field(() => ID)
  _id!: Types.ObjectId;

  @Field()
  @Prop({ required: true })
  city!: string;

  @Field({ nullable: true })
  @Prop({ required: false })
  region?: string;

  @Field()
  @Prop({ required: true })
  countryCode!: string;

  @Field()
  @Prop({ required: true })
  displayName!: string;

  // Lowercase, ASCII-folded search key. Prefix-searched by placeSearch. The
  // index is declared once below (PlaceSchema.index) to avoid a duplicate.
  @Field()
  @Prop({ required: true })
  normalized!: string;

  // Deduped, lowercased search keys the typeahead anchors its prefix regex on:
  // word-boundary suffixes of the ascii name + Latin-script alternate names +
  // the human region name, always including `normalized` itself (search_keys ⊇
  // {normalized}). This is what lets "porto santo" reach Vila Baleira and
  // "madeira" list Madeiran towns. Multikey btree index below.
  // Mongoose builds it at boot (autoIndex is on), same as `normalized`; a
  // deployment with autoIndex off creates it by hand.
  @Field(() => [String])
  @Prop({ type: [String], index: true })
  search_keys!: string[];

  @Field(() => Int, { nullable: true })
  @Prop({ required: false })
  population?: number;

  // GeoNames latitude/longitude (columns 4 and 5 of the `cities*` export),
  // added so the app can turn a user-pinned city into the coordinates a
  // weather provider needs WITHOUT any GPS or device-location permission.
  //
  // Nullable on purpose and for good: rows seeded before these fields existed
  // carry neither until the seeder is re-run, and the seeder's `$set` is an
  // idempotent in-place upsert, so re-running fills them without a wipe or an
  // id churn. A consumer MUST treat absent coordinates as "unresolved" and ask
  // the user, never guess -- a wrong coordinate is a confident wrong forecast.
  //
  // Plain optionals (`?: number`), never `number | null`: an explicit union
  // cannot be resolved by reflect-metadata and makes the schema build throw
  // UndefinedTypeError at bootstrap.
  //
  // NO INDEX. Nothing queries by coordinate -- these are projected out of a
  // lookup keyed on `search_keys`/`countryCode`, never filtered on. Adding one
  // would buy a standing index for nothing.
  @Field(() => Float, { nullable: true })
  @Prop({ required: false })
  latitude?: number;

  @Field(() => Float, { nullable: true })
  @Prop({ required: false })
  longitude?: number;

  // GeoNames id (column 0) and the Latin alternate names (column 3, filtered),
  // read by the article-enrichment gazetteer to canonicalise a model-named
  // place and stamp `geo_tags[].geonameId`. Persistence-only: deliberately no
  // @Field, so `placeSearch` and schema.gql are unchanged. Absent on rows
  // seeded before these columns existed; the gazetteer still canonicalises
  // names without them, it just yields no id. NO INDEX: the gazetteer loads
  // the collection into memory and never queries by either field.
  @Prop({ required: false })
  geonameId?: number;

  @Prop({ type: [String], required: false })
  alt_names?: string[];
}

export const PlaceSchema = SchemaFactory.createForClass(Place);

// Btree prefix-search index on the lowercase key. Serves the anchored
// `^<query>` regex in placeSearch. Mongoose builds it at boot (autoIndex is
// on); a deployment with autoIndex off creates it by hand.
PlaceSchema.index({ normalized: 1 });
