import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { GraphQLError } from 'graphql';
import {
  PublicationSource,
  PublicationSourceDocument,
} from '@mera/models/models/publication-source.model';
import {
  NewsPublisher,
  NewsPublisherDocument,
} from '@mera/models/models/news-publisher.model';
import { redactAddress } from '@mera/shared/url/strip-url-secrets';
import { PublicationProfile } from './dto/publication-profile.dto';
import { normalizePublicationName } from './normalize-publication-name';
import { readDisplayName } from './read-display-name';

/** Client-visible `extensions.code` for a profile request with a bad key. */
export const BAD_PROFILE_KEY = 'BAD_PROFILE_KEY';

/** Publication types that render as an official source. */
const OFFICIAL_TYPES = new Set(['government', 'regulator']);

const SOURCE_FIELDS =
  '_id newsPublisherId publication_name publication_url publication_type ' +
  'categories country_code country_name detected_language_code ' +
  'feed_language_code is_active publication_name_i18n';

export interface PublicationProfileKey {
  newsPublisherId?: string | null;
  name?: string | null;
  countryCode?: string | null;
  language?: string | null;
}

type SourceRow = Pick<
  PublicationSource,
  | 'publication_name'
  | 'publication_url'
  | 'publication_type'
  | 'categories'
  | 'country_code'
  | 'country_name'
  | 'detected_language_code'
  | 'feed_language_code'
  | 'is_active'
  | 'publication_name_i18n'
> & { _id: Types.ObjectId; newsPublisherId?: Types.ObjectId | null };

type PublisherRow = Pick<
  NewsPublisher,
  | 'name'
  | 'website_url'
  | 'country_code'
  | 'country_name'
  | 'publication_type'
  | 'categories'
  | 'subscription_uri'
  | 'readingScore'
> & { _id: Types.ObjectId };

/**
 * The error never echoes the key it was given: a page request names the
 * publication a person is reading, and that must not reach a log.
 */
function badKey(): GraphQLError {
  return new GraphQLError(
    'publicationProfile needs newsPublisherId, or name and countryCode',
    { extensions: { code: BAD_PROFILE_KEY } },
  );
}

function present(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function unique(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!present(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** `_id` ascending, so every "first" below is deterministic. */
function byId(a: { _id: Types.ObjectId }, b: { _id: Types.ObjectId }): number {
  const x = String(a._id);
  const y = String(b._id);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Collapse the rows a (name, country) key matched onto ONE publisher: the one
 * holding the most ACTIVE matching rows, ties to the lowest id. A key rarely
 * spans more than one publisher, so this is a tie-break, not a merge.
 */
export function pickPublisherId(rows: SourceRow[]): Types.ObjectId | null {
  const tally = new Map<string, { id: Types.ObjectId; active: number }>();
  for (const row of rows) {
    if (!row.newsPublisherId) continue;
    const key = String(row.newsPublisherId);
    const entry = tally.get(key) ?? { id: row.newsPublisherId, active: 0 };
    if (row.is_active !== false) entry.active += 1;
    tally.set(key, entry);
  }
  let best: { key: string; id: Types.ObjectId; active: number } | null = null;
  for (const [key, entry] of tally) {
    if (
      best === null ||
      entry.active > best.active ||
      (entry.active === best.active && key < best.key)
    ) {
      best = { key, ...entry };
    }
  }
  return best?.id ?? null;
}

@Injectable()
export class PublicationProfileService {
  constructor(
    @InjectModel(PublicationSource.name)
    private readonly publicationSourceModel: Model<PublicationSourceDocument>,
    @InjectModel(NewsPublisher.name)
    private readonly newsPublisherModel: Model<NewsPublisherDocument>,
  ) {}

  /**
   * Resolve a publication page by EXACTLY ONE key: a publisher id, or a name
   * plus country (feed rows carry no id, so cards can only send the latter).
   * Anything else is `BAD_PROFILE_KEY`. A key that matches nothing is null.
   */
  async findProfile(
    key: PublicationProfileKey,
  ): Promise<PublicationProfile | null> {
    const byPublisher = key.newsPublisherId != null;
    const byName = key.name != null || key.countryCode != null;
    if (byPublisher === byName) throw badKey();

    let publisherId: Types.ObjectId;
    let matchedRowId: string | null = null;

    if (byPublisher) {
      if (!Types.ObjectId.isValid(key.newsPublisherId as string)) return null;
      publisherId = new Types.ObjectId(key.newsPublisherId as string);
    } else {
      const name = normalizePublicationName(key.name);
      const countryCode = present(key.countryCode)
        ? key.countryCode.trim().toUpperCase()
        : '';
      if (name === '' || countryCode === '') throw badKey();

      const candidates = unique([key.name, name]);
      const rows = (
        (await this.publicationSourceModel
          .find(
            {
              publication_name: { $in: candidates },
              country_code: countryCode,
            },
            { _id: 1, newsPublisherId: 1, publication_name: 1, is_active: 1 },
          )
          .lean()
          .exec()) as unknown as SourceRow[]
      ).filter(
        (row) => normalizePublicationName(row.publication_name) === name,
      );

      const picked = pickPublisherId(rows);
      if (!picked) return null;
      publisherId = picked;
      const mainMatch = rows
        .filter((r) => String(r.newsPublisherId) === String(picked))
        .sort((a, b) =>
          a.is_active === b.is_active ? byId(a, b) : a.is_active ? -1 : 1,
        )[0];
      matchedRowId = mainMatch ? String(mainMatch._id) : null;
    }

    const [publisher, sourcesRaw] = await Promise.all([
      this.newsPublisherModel
        .findOne({ _id: publisherId })
        .lean()
        .exec() as unknown as Promise<PublisherRow | null>,
      this.publicationSourceModel
        .find({ newsPublisherId: publisherId })
        .select(SOURCE_FIELDS)
        .lean()
        .exec() as unknown as Promise<SourceRow[]>,
    ]);
    const sources = [...(sourcesRaw ?? [])].sort(byId);
    if (!publisher && sources.length === 0) return null;

    const main =
      sources.find((s) => String(s._id) === matchedRowId) ??
      sources.find((s) => s.is_active !== false) ??
      sources[0] ??
      null;

    const name = publisher?.name ?? main?.publication_name ?? '';
    const mainName = main?.publication_name ?? name;
    const displayName =
      (present(key.language)
        ? readDisplayName(main?.publication_name_i18n, key.language)
        : undefined) ?? mainName;

    const website = publisher?.website_url;
    const mainUrl = main?.publication_url;
    const subscriptionUri = publisher?.subscription_uri;

    const publicationType =
      publisher?.publication_type ??
      sources.find((s) => present(s.publication_type))?.publication_type ??
      null;

    return {
      newsPublisherId: String(publisherId),
      name,
      displayName,
      homepageUrl: present(website)
        ? redactAddress(website)
        : present(mainUrl)
          ? redactAddress(mainUrl)
          : null,
      publicationType,
      categories: unique([
        ...(publisher?.categories ?? []),
        ...sources.flatMap((s) => s.categories ?? []),
      ]),
      languages: unique(
        sources.map((s) => s.detected_language_code ?? s.feed_language_code),
      ),
      isOfficial:
        publicationType !== null && OFFICIAL_TYPES.has(publicationType),
      countryCode: publisher?.country_code ?? main?.country_code ?? '',
      countryName: publisher?.country_name ?? main?.country_name ?? null,
      sourceNames: unique(sources.map((s) => s.publication_name)),
      subscriptionUri: present(subscriptionUri) ? subscriptionUri : null,
      readingScore:
        typeof publisher?.readingScore === 'number' &&
        Number.isFinite(publisher.readingScore)
          ? publisher.readingScore
          : null,
    };
  }
}
