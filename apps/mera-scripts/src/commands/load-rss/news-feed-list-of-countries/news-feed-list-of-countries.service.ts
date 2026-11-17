import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PublicationSource } from '@mera/models/models/publication-source.model';
import { NewsPublisher } from '@mera/models/models/news-publisher.model';
import * as fs from 'fs';
import * as path from 'path';
import { CountryCodeMapper } from './country-code-mapper';
import {
  coercePublicationCategories,
  coercePublicationType,
} from '@mera/models/constants/publication-taxonomy';

interface FeedUri {
  uri: string;
  category?: string;
  language_code?: string;
  gated?: boolean;
  // Annotations written by the RSS-repo codegen (direct-fetch validation).
  // The generated file now carries EVERY feed, valid or not; we map these
  // onto the provenance flag `is_active_codegen`.
  is_valid?: boolean;
  validation_status?: string; // 'valid' | 'invalid' | 'bot_protected'
}

interface PublicationEntry {
  publication_name: string;
  publication_website_uri: string;
  /**
   * Structured taxonomy from the RSS repo (closed vocabularies, see
   * @mera/models/constants/publication-taxonomy). Unlike `category` these are
   * NOT embedding inputs, so they are refreshed on every run instead of being
   * create-only.
   */
  publication_type?: string;
  categories?: string[];
  /**
   * The publisher's own subscribe/pricing page, or an explicit `null` meaning
   * "checked, there is no consumer subscription product". BOTH are values.
   *
   * Optional-and-nullable is not the same as optional: the key being ABSENT
   * means the upstream file says nothing about this publisher and the existing
   * Mongo value must survive, whereas `null` is a positive statement the app
   * reads to skip the browser step. That distinction is why this is written
   * with a presence test below and never with `?:` truthiness.
   */
  publication_subscription_uri?: string | null;
  publication_rss_feed_uris: FeedUri[];
}

interface FeedsData {
  [countryCode: string]: PublicationEntry[];
}

@Injectable()
export class NewsFeedListOfCountriesService {
  private readonly logger = new Logger(NewsFeedListOfCountriesService.name);

  constructor(
    @InjectModel(PublicationSource.name)
    private publicationSourceModel: Model<PublicationSource>,
    @InjectModel(NewsPublisher.name)
    private newsPublisherModel: Model<NewsPublisher>,
  ) {}

  /**
   * `onlyFeedUrls` (the --only CLI flag) upserts just those feeds and their
   * publishers, for adding a publisher in seconds instead of the ~30 min full
   * pass. It skips the delete-sync, which would read every other feed as absent.
   */
  async loadFeeds(syncDelete = false, onlyFeedUrls?: string[]): Promise<void> {
    const only = onlyFeedUrls?.length ? new Set(onlyFeedUrls) : null;
    if (only && syncDelete) {
      throw new Error('--only cannot be combined with --sync-delete');
    }

    // Use absolute path from project root
    const projectRoot = process.cwd();
    const filePath = path.join(
      projectRoot,
      'apps',
      'mera-scripts',
      'seed-data',
      'active-feeds-auto-generated.json',
    );

    try {
      // Read and parse JSON file
      const fileContent = fs.readFileSync(filePath, 'utf-8');
      const feedsData = JSON.parse(fileContent) as FeedsData;

      if (only) {
        const seedUrls = new Set(
          Object.values(feedsData).flatMap((pubs) =>
            pubs.flatMap((p) => p.publication_rss_feed_uris.map((f) => f.uri)),
          ),
        );
        const missing = [...only].filter((u) => !seedUrls.has(u));
        // A typo must fail loudly, not report a clean run that wrote nothing.
        if (missing.length > 0) {
          throw new Error(
            `--only feed(s) not in the seed: ${missing.join(', ')}`,
          );
        }
      }

      const seedFeedUrls = new Set<string>();
      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      let repointedCount = 0;

      // Every publisher id that exists, so an existing feed pointing at a
      // DELETED publisher can be told apart from one pointing at a live one.
      const livePublisherIds = new Set<string>(
        (await this.newsPublisherModel.distinct('_id')).map(String),
      );

      // Process each country
      for (const countryCode in feedsData) {
        const publications = feedsData[countryCode];

        for (const publication of publications) {
          if (
            only &&
            !publication.publication_rss_feed_uris.some((f) => only.has(f.uri))
          ) {
            continue;
          }
          try {
            // Structured taxonomy, coerced against the closed vocabularies so a
            // stale RSS-repo slug can never reach Mongo. Absent => key omitted,
            // so an untagged publication never wipes an existing tag.
            const publicationType = coercePublicationType(
              publication.publication_type,
            );
            const categories = coercePublicationCategories(
              publication.categories,
            );
            const publisherTaxonomy: Record<string, unknown> = {
              ...(publicationType ? { publication_type: publicationType } : {}),
              ...(categories ? { categories } : {}),
              // PRESENCE, not truthiness. The taxonomy lines above can use
              // truthiness safely because an empty type or an empty category
              // list carries no meaning. `subscription_uri` is different:
              // `null` is the value the app uses to skip the browser step and
              // offer "I subscribe to this" directly, and
              // `...(uri ? {subscription_uri: uri} : {})` silently drops
              // exactly those rows — the ones the feature most needs.
              ...('publication_subscription_uri' in publication
                ? {
                    subscription_uri:
                      publication.publication_subscription_uri ?? null,
                  }
                : {}),
            };

            // Upsert NewsPublisher (idempotent by name + country_code)
            const publisher = await this.newsPublisherModel.findOneAndUpdate(
              {
                name: publication.publication_name,
                country_code: countryCode,
              },
              {
                $setOnInsert: {
                  name: publication.publication_name,
                  website_url: publication.publication_website_uri,
                  country_code: countryCode,
                  country_name: CountryCodeMapper.getCountryName(countryCode),
                  is_active: true,
                },
                // Taxonomy and subscription_uri are refreshed on every run
                // (neither is an embedding input and neither carries runtime
                // state), so a change in the RSS repo actually lands. Only set
                // keys the seed provides — an absent field must not wipe an
                // existing value.
                //
                // PRECEDENCE, because two writers touch subscription_uri:
                // this import wins over `apply-subscription-uris` for every
                // publisher the upstream file expresses, because load-rss runs
                // after it. `apply-subscription-uris` is the EXCEPTION path,
                // for the 106 Mongo rows with no upstream key and for rows
                // approved out of the tier (b) review; anything the upstream
                // file can express belongs upstream, or the next import
                // silently reverts it.
                //
                // $set, never $setOnInsert. The create-only group below is
                // create-only for a reason (website_url and country_name are
                // stable identity), but a subscription page moves, and a field
                // that only ever landed on newly-created publishers would be
                // wrong for all 4,554 rows that already exist.
                ...(Object.keys(publisherTaxonomy).length > 0
                  ? { $set: publisherTaxonomy }
                  : {}),
              },
              { upsert: true, new: true },
            );
            livePublisherIds.add(String(publisher._id));

            // Process each feed URI for this publication
            for (const feedUri of publication.publication_rss_feed_uris) {
              if (only && !only.has(feedUri.uri)) continue;
              seedFeedUrls.add(feedUri.uri);

              try {
                const desiredGated = !!feedUri.gated;

                // Check if feed already exists by feed_url
                const existingFeed = await this.publicationSourceModel
                  .findOne({ feed_url: feedUri.uri })
                  .exec();

                const desiredCodegenActive = feedUri.is_valid !== false;
                const desiredCodegenStatus =
                  feedUri.validation_status ??
                  (feedUri.is_valid === false ? 'invalid' : 'valid');

                if (existingFeed) {
                  // Set newsPublisherId if missing or dangling, propagate
                  // gated changes, and refresh the codegen verdict on every
                  // run. NEVER touch `is_active_user` (human-owned) or
                  // `is_active` (runtime-owned) here.
                  const setFields: Record<string, unknown> = {};

                  // A feed whose publisher row was deleted still fetches, but
                  // every by-publisher lookup (the publications screen, the
                  // publisher's articles) stops seeing it. Re-point only a
                  // missing or dead id, never a live one that merely differs:
                  // a feed URL listed under two seed entries would otherwise
                  // flip between them on every run.
                  if (
                    !existingFeed.newsPublisherId ||
                    !livePublisherIds.has(String(existingFeed.newsPublisherId))
                  ) {
                    if (existingFeed.newsPublisherId) repointedCount++;
                    setFields.newsPublisherId = publisher._id;
                  }

                  if (!!existingFeed.gated !== desiredGated) {
                    setFields.gated = desiredGated;
                  }

                  // Refresh the codegen verdict only when it changed (preserves
                  // the skip path; backfills legacy rows missing these fields).
                  if (
                    existingFeed.is_active_codegen !== desiredCodegenActive ||
                    existingFeed.codegen_status !== desiredCodegenStatus
                  ) {
                    setFields.is_active_codegen = desiredCodegenActive;
                    setFields.codegen_status = desiredCodegenStatus;
                    setFields.codegen_checked_at = new Date();
                  }

                  // Taxonomy IS updatable in place, unlike `category`: it is not
                  // an embedding input, so re-tagging a publication in the RSS
                  // repo propagates on the next run instead of only affecting
                  // newly-created rows.
                  if (
                    publicationType &&
                    existingFeed.publication_type !== publicationType
                  ) {
                    setFields.publication_type = publicationType;
                  }

                  if (
                    categories &&
                    (existingFeed.categories ?? []).join('|') !==
                      categories.join('|')
                  ) {
                    setFields.categories = categories;
                  }

                  if (Object.keys(setFields).length > 0) {
                    await this.publicationSourceModel.updateOne(
                      { _id: existingFeed._id },
                      { $set: setFields },
                    );
                    updatedCount++;
                  } else {
                    skippedCount++;
                  }
                  continue;
                }

                // Use category from JSON if present, otherwise default to 'general_news'
                const category = feedUri.category || 'general_news';

                // Create new publication source linked to publisher.
                // Two provenance flags: is_active_codegen from the direct-fetch
                // verdict, is_active_user defaults true (these feeds were
                // proxy-validated at merge — "checked by me"). The fanout fetches
                // when EITHER is true, so a codegen-invalid but proxy-valid feed
                // is still tried. is_active (runtime kill-switch) uses its default.
                await this.publicationSourceModel.create({
                  publication_name: publication.publication_name,
                  publication_url: publication.publication_website_uri,
                  feed_url: feedUri.uri,
                  type: 'rss-feed',
                  country_code: countryCode,
                  // Mongoose 9's create() types reject null for an optional path.
                  country_name:
                    CountryCodeMapper.getCountryName(countryCode) ?? undefined,
                  category: category,
                  ...publisherTaxonomy,
                  newsPublisherId: publisher._id,
                  gated: desiredGated,
                  is_active_codegen: desiredCodegenActive,
                  is_active_user: true,
                  codegen_status: desiredCodegenStatus,
                  codegen_checked_at: new Date(),
                });
                createdCount++;
              } catch (err) {
                const errorMessage =
                  err instanceof Error ? err.message : String(err);
                this.logger.error(
                  `Failed to save feed ${feedUri.uri} for ${publication.publication_name} (${countryCode}): ${errorMessage}`,
                );
              }
            }
          } catch (err) {
            const errorMessage =
              err instanceof Error ? err.message : String(err);
            this.logger.error(
              `Failed to process publisher ${publication.publication_name} (${countryCode}): ${errorMessage}`,
            );
          }
        }
      }

      if (repointedCount > 0) {
        this.logger.log(
          `re-pointed ${repointedCount} feeds from deleted publishers`,
        );
      }

      if (only) {
        this.logger.log(
          `load-rss --only summary: created=${createdCount}, updated=${updatedCount}, skipped=${skippedCount} (delete-sync not run)`,
        );
        return;
      }

      await this.syncDeletedSources(seedFeedUrls, syncDelete, {
        createdCount,
        updatedCount,
        skippedCount,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to read or parse JSON file: ${errorMessage}`);
      throw err;
    }
  }

  /**
   * Removes publication-source rows (type: 'rss-feed' only) whose feed_url
   * is no longer present in the seed JSON, then cleans up any news-publisher
   * docs left with zero remaining publication-source rows. Guarded behind
   * `syncDelete` (the --sync-delete CLI flag) and a >50% safety check to
   * protect against an empty/truncated seed file wiping the collection.
   */
  private async syncDeletedSources(
    seedFeedUrls: Set<string>,
    syncDelete: boolean,
    upsertCounts: {
      createdCount: number;
      updatedCount: number;
      skippedCount: number;
    },
  ): Promise<void> {
    const { createdCount, updatedCount, skippedCount } = upsertCounts;
    const upsertedCount = createdCount + updatedCount;

    const totalRssFeeds = await this.publicationSourceModel.countDocuments({
      type: 'rss-feed',
    });

    const deleteCandidates = await this.publicationSourceModel
      .find({
        type: 'rss-feed',
        feed_url: { $nin: Array.from(seedFeedUrls) },
      })
      .exec();

    if (!syncDelete) {
      this.logger.log(
        `[dry-run] load-rss summary: upserted=${upsertedCount} (created=${createdCount}, updated=${updatedCount}), skipped=${skippedCount}, would-delete-sources=${deleteCandidates.length} (pass --sync-delete to apply)`,
      );
      return;
    }

    if (deleteCandidates.length > totalRssFeeds * 0.5) {
      this.logger.error(
        `Refusing to sync-delete: ${deleteCandidates.length} of ${totalRssFeeds} rss-feed publication-sources would be removed (>50%). The seed file may be empty or truncated. Aborting delete-sync — no rows deleted.`,
      );
      this.logger.log(
        `load-rss summary: upserted=${upsertedCount} (created=${createdCount}, updated=${updatedCount}), skipped=${skippedCount}, deleted-sources=0, deleted-publishers=0 (delete-sync aborted by safety guard)`,
      );
      return;
    }

    let deletedSourcesCount = 0;
    let deletedPublishersCount = 0;

    if (deleteCandidates.length > 0) {
      const candidateIds = deleteCandidates.map((doc) => doc._id);
      const publisherIds = Array.from(
        new Set(
          deleteCandidates
            .map((doc) => doc.newsPublisherId)
            .filter((id): id is Types.ObjectId => !!id)
            .map((id) => id.toString()),
        ),
      );

      const deleteResult = await this.publicationSourceModel.deleteMany({
        _id: { $in: candidateIds },
      });
      deletedSourcesCount = deleteResult.deletedCount || 0;

      for (const publisherId of publisherIds) {
        const remaining = await this.publicationSourceModel.countDocuments({
          newsPublisherId: publisherId,
        });
        if (remaining === 0) {
          await this.newsPublisherModel.deleteOne({ _id: publisherId });
          deletedPublishersCount++;
        }
      }
    }

    this.logger.log(
      `load-rss summary: upserted=${upsertedCount} (created=${createdCount}, updated=${updatedCount}), skipped=${skippedCount}, deleted-sources=${deletedSourcesCount}, deleted-publishers=${deletedPublishersCount}`,
    );
  }
}
