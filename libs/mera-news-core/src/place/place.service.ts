import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Place, PlaceDocument } from '@mera/models/models/place.model';

const MAX_LIMIT = 15;
const MIN_QUERY_LENGTH = 2;

/**
 * Strip Latin diacritics so a caller's "Munchen" and "Munchen" both reach the
 * same row. GeoNames' own `asciiname` column (which is what `normalized` is
 * built from) is folded the same way, so this reproduces the seeded key for
 * every Latin-1 / Latin Extended-A accent. It does NOT reproduce it for
 * ligature-style folds (SS, O with stroke, AE), which is fine: those cities
 * still match through their accented alternate name in `search_keys`.
 */
function foldDiacritics(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Escape user text for safe use inside a RegExp. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class PlaceService {
  constructor(
    @InjectModel(Place.name)
    private readonly placeModel: Model<PlaceDocument>,
  ) {}

  /**
   * Anchored prefix search over the multikey `search_keys` array, highest
   * population first. Matching any key (a word-boundary suffix of the name, a
   * Latin alternate name, or the region) surfaces the place, so "porto santo"
   * reaches Vila Baleira and "madeira" lists Madeiran towns. Returns [] for
   * queries shorter than 2 chars; limit is clamped to [1, 15].
   *
   * Docs are always seeded with search_keys ⊇ {normalized}, so a single
   * search_keys filter subsumes the old `normalized` search, so there is no $or fallback.
   */
  async placeSearch(
    query: string,
    limit = 8,
    opts?: { maxTimeMS?: number },
  ): Promise<Place[]> {
    const trimmed = (query ?? '').trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return [];

    const cappedLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const prefix = `^${escapeRegex(trimmed.toLowerCase())}`;

    const find = this.placeModel
      .find({ search_keys: { $regex: prefix } })
      .sort({ population: -1 })
      .limit(cappedLimit);
    if (opts?.maxTimeMS) find.maxTimeMS(opts.maxTimeMS);
    return find.lean().exec() as unknown as Promise<Place[]>;
  }

  /**
   * Exact, single-purpose lookup: the one best `places` row for a city name the
   * caller already holds, so a client can turn a known city into coordinates.
   *
   * DELIBERATELY NOT `placeSearch`. That one is an anchored PREFIX regex and
   * returns up to 15 rows, so "Paris" hands back Paris FR and Paris TX and
   * every Paris-something; picking a coordinate out of that list client-side is
   * how a confidently wrong coordinate happens. Widening `placeSearch` to serve
   * both was rejected for the same reason.
   *
   * Matched on `search_keys`, NOT on `normalized`, and this is the correctness
   * point rather than a preference. `normalized` is `asciiname.toLowerCase()`
   * (GeoNames column 2, already ASCII-folded), while `Place.city` is column 1
   * WITH its diacritics -- so a caller echoing back the city it was shown would
   * miss every accented city in Europe and get `null`, which surfaces as the
   * client asking its reader to confirm a place it had already resolved. Every doc
   * is seeded with `search_keys` containing `normalized` plus the Latin
   * alternate names, so one multikey equality match covers both spellings, and
   * the folded candidate covers the case where only the ASCII form was seeded.
   *
   * `countryCode` is required, not optional: it is the difference between the
   * French Paris and the Texan one, and every caller has it (as ISO
   * alpha-2). Upper-cased before matching because
   * GeoNames stores it upper-case.
   *
   * Returns the highest-population match, or `null`. `null` is a first-class
   * answer -- an auto-derived location row can carry no city at all -- and the
   * caller must ask the reader rather than substitute a guess.
   */
  async placeCoordinates(
    city: string,
    countryCode: string,
  ): Promise<Place | null> {
    const trimmedCity = (city ?? '').trim().toLowerCase();
    const trimmedCountry = (countryCode ?? '').trim().toUpperCase();
    // Both are required. An empty city with a country would otherwise match
    // nothing and an empty country would match the same city in 40 countries;
    // bail rather than let either shape reach Mongo.
    if (!trimmedCity || !trimmedCountry) return null;

    // Deduped: an unaccented input folds to itself, and `$in` with a repeated
    // term is a wasted comparison per candidate row.
    const candidates = Array.from(
      new Set([trimmedCity, foldDiacritics(trimmedCity)]),
    );

    const match = await this.placeModel
      .findOne({
        search_keys: { $in: candidates },
        countryCode: trimmedCountry,
      })
      .sort({ population: -1 })
      .lean()
      .exec();

    return (match as unknown as Place | null) ?? null;
  }
}
