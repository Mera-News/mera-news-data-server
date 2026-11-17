import { Injectable, Logger, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue, UnrecoverableError } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import { createHash } from 'crypto';
import moment from 'moment-timezone';
import {
  QueueName,
  classifyFeedFailure,
  decideFeedFailureAction,
  DEFAULT_FEED_FAILURE_POLICY,
  JobLogger,
  ProxyEgressUnavailableError,
} from '@mera/shared';
import type {
  FeedFailureDecision,
  FeedFailurePolicyConfig,
  FeedFetchHistory,
} from '@mera/shared';
import {
  decideHttpLinksEscalation,
  DEFAULT_HTTP_LINKS_POLICY,
  HTTP_LINKS_DEACTIVATION_REASON,
  HTTP_LINKS_DEACTIVATION_SEVERITY,
  UrlSecurityState,
} from '@mera/shared/url/url-security';
import type { HttpLinksPolicyConfig } from '@mera/shared/url/url-security';
import { buildArticleCopyKeys } from '@mera/shared/url/article-copy-keys';
import {
  PublicationSource,
  PublicationSourceDocument,
} from '@mera/models/models/publication-source.model';
import {
  StateMachineFetchPublication,
  StateMachineFetchPublicationDocument,
  FetchPublicationStatus,
} from '@mera/models/models/state-machine-fetch-publication.model';
import {
  NewsArticle,
  NewsArticleDocument,
  ArticleProcessingStatus,
} from '@mera/models/models/news-article.model';
import {
  ArticleFingerprint,
  ArticleFingerprintDocument,
} from '@mera/models/models/article-fingerprint.model';
import {
  RSSFeedService,
  type MediaCandidate,
} from '../../shared-utilities/rss-feed/rss-feed.service';
import { FeedFetchError } from '../../shared-utilities/rss-feed/feed-fetch-error';
import { sanitizeText } from '../../../utils/text-sanitizer';
import { LanguageDetectionService } from '../../shared-utilities/language-detection/language-detection.service';
import { UrlSecurityProbeService } from '../../shared-utilities/url-security/url-security-probe.service';
import {
  JobReporter,
  NOOP_JOB_REPORTER,
} from '../../shared-utilities/mera-worker-host';

/**
 * Consecutive shed cycles before a feed is slowed down.
 *
 * A shed means OUR egress was unavailable, so it must never be charged to the
 * feed. But "writes nothing" is right for a transient event and wrong forever:
 * one bad credential in a PROXY_URLS rotation would shed indefinitely while
 * feed_health stayed clean and no counter could trip.
 *
 * 12 hourly cycles is 4x the worst transient we have measured (a ~3h proxy
 * event), so no real outage reaches it, while a genuine misconfiguration trips
 * overnight and leaves evidence before the next working morning. It also sits
 * below FEED_DEAD_MIN_ATTEMPTS (20) and FEED_DEAD_MIN_DAYS (7) by construction,
 * so shed cycles can never contribute to deactivation.
 */
const SHED_QUARANTINE_CYCLES = 12;

/**
 * Flat delay applied at that threshold, NOT the exponential failure ladder.
 *
 * The ladder tops out at FEED_BACKOFF_MAX_MINUTES (360), which would leave a
 * recovered pool with feeds sitting quarantined for up to six hours after the
 * cause was fixed. One cycle is enough to stop hammering a broken pool.
 */
const SHED_QUARANTINE_MINUTES = 60;

/** Provenance and bandwidth metadata for one fetch, as RSSFeedService reports it. */
type FetchMeta = Awaited<
  ReturnType<RSSFeedService['fetchRSSFeed']>
>['fetchMeta'];

export interface LoadRssFeedResult {
  success: boolean;
  rssFeedId: string;
  rssFeedName: string;
  skipped: boolean;
  skipReason?: string;
  newArticles?: number;
  duplicates?: number;
  republishedSkipped?: number;
  errors?: number;
  totalParsed?: number;
  updatedFields?: string[];
}

interface RssFeedItem {
  title?: string;
  contentSnippet?: string;
  description?: string;
  pubDate?: string;
  creator?: string;
  link?: string;
  enclosure?: {
    url?: string;
  };
  mediaThumbnail?: string | MediaCandidate | MediaCandidate[];
  mediaContent?: string | MediaCandidate | MediaCandidate[];
  [key: string]: any;
}

@Injectable()
export class LoadRSSFeedService {
  private readonly logger = new Logger(LoadRSSFeedService.name);

  // 2-hour TTL — covers repeat RSS polls (typically every 15–60 min) without
  // evicting too aggressively. MongoDB unique index remains the source of truth.
  private static readonly FP_CACHE_TTL_MS = 2 * 60 * 60 * 1000;

  private static fingerprintCacheKey(url: string): string {
    return `fp:u:${createHash('sha256').update(url).digest('hex')}`;
  }

  /** Resolved once — the thresholds driving quarantine vs deactivation. */
  private readonly failurePolicy: FeedFailurePolicyConfig;

  /**
   * Days of insecure links a feed gets before a permanent block. Deliberately a
   * SEPARATE ladder from `failurePolicy` — see the escalation block on
   * `PublicationSource`.
   */
  private readonly httpLinksPolicy: HttpLinksPolicyConfig;

  /**
   * Structured per-fetch line. `job` is stamped at construction, so this is a
   * SEPARATE logger from AxiosService's `proxy-egress` one: these lines are
   * emitted from the feed path and are keyed on by bandwidth metrics.
   */
  private readonly jobLogger: JobLogger;

  constructor(
    @InjectModel(PublicationSource.name)
    private publicationSourceModel: Model<PublicationSourceDocument>,
    @InjectModel(StateMachineFetchPublication.name)
    private fetchResultModel: Model<StateMachineFetchPublicationDocument>,
    @InjectModel(NewsArticle.name)
    private newsArticleModel: Model<NewsArticleDocument>,
    @InjectModel(ArticleFingerprint.name)
    private articleFingerprintModel: Model<ArticleFingerprintDocument>,
    private rssFeedService: RSSFeedService,
    private languageDetectionService: LanguageDetectionService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @InjectQueue(QueueName.TRANSLATE_ARTICLE)
    private readonly translateQueue: Queue,
    private readonly configService: ConfigService,
    private readonly urlSecurityProbe: UrlSecurityProbeService,
  ) {
    const d = DEFAULT_FEED_FAILURE_POLICY;
    const num = (key: string, fallback: number): number => {
      const raw = this.configService?.get<number>(key, fallback) ?? fallback;
      const parsed = parseInt(String(raw), 10);
      return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
    };

    this.failurePolicy = {
      permanentThreshold: num(
        'FEED_PERMANENT_FAILURE_THRESHOLD',
        d.permanentThreshold,
      ),
      deadMinDays: num('FEED_DEAD_MIN_DAYS', d.deadMinDays),
      deadMinAttempts: num('FEED_DEAD_MIN_ATTEMPTS', d.deadMinAttempts),
      backoffStartFailures: num(
        'FEED_BACKOFF_START_FAILURES',
        d.backoffStartFailures,
      ),
      backoffBaseMinutes: num(
        'FEED_BACKOFF_BASE_MINUTES',
        d.backoffBaseMinutes,
      ),
      backoffMaxMinutes: num('FEED_BACKOFF_MAX_MINUTES', d.backoffMaxMinutes),
      probeIntervalMinutes: num(
        'FEED_PROBE_INTERVAL_MINUTES',
        d.probeIntervalMinutes,
      ),
    };

    this.httpLinksPolicy = {
      blockAfterDays: num(
        'HTTP_LINKS_BLOCK_AFTER_DAYS',
        DEFAULT_HTTP_LINKS_POLICY.blockAfterDays,
      ),
    };

    this.jobLogger = new JobLogger({
      job: 'feed-fetch',
      level: JobLogger.parseLevel(this.configService?.get<string>('LOG_LEVEL')),
    });
  }

  /**
   * One line per fetch, for the bandwidth and 304-hit-rate metrics.
   *
   * `feed_fetch_bytes` is the WIRE figure and is what a proxy vendor bills;
   * it is null on a chunked response and consumers must handle that rather
   * than coercing to 0. `feed_fetch_decoded_bytes` is the post-decompression
   * size, 3-5x larger on RSS XML, and must never be used as a cost proxy.
   */
  private logFeedFetch(
    rssFeedId: string,
    meta: FetchMeta,
    notModified: boolean,
  ): void {
    this.jobLogger.info('feed_fetch', {
      feedId: rssFeedId,
      status: meta.httpStatus ?? null,
      notModified,
      via: meta.via,
      feed_fetch_bytes: meta.bytes,
      feed_fetch_decoded_bytes: meta.decodedBytes,
      fetchMs: meta.fetchMs,
    });
  }

  /**
   * Check if the feed has new content by comparing last_publish_date
   * from the fetched feed against the latest stored fetch result.
   * Returns null if there's new content, or a skip reason if unchanged.
   */
  private async getSkipReasonIfUnchanged(
    publicationSourceId: Types.ObjectId,
    feedLastPublishDate: Date | undefined,
  ): Promise<string | null> {
    if (!feedLastPublishDate) {
      // No publish date in feed — can't compare, proceed with sync
      return null;
    }

    // The filter is load-bearing, not defensive. This reads the single most
    // recent row and bails to null the moment that row has no
    // `last_publish_date` — and plenty of rows do not: every FETCH_FAILED row
    // written above, and every FETCH_UNCHANGED row from a 304, which carries no
    // body and therefore no publish date. Without this clause a feed that 304s
    // (or fails once) can never skip-unchanged again on its next 200: it
    // rebuilds every article document and runs the url-security probe's network
    // calls over the whole feed, every cycle, for nothing.
    const latestFetchResult = await this.fetchResultModel
      .findOne({
        publicationSourceId,
        last_publish_date: { $exists: true, $ne: null },
      })
      .sort({ createdAt: -1 })
      .exec();

    if (!latestFetchResult?.last_publish_date) {
      // No previous fetch or no stored date — proceed with sync
      return null;
    }

    const storedDate = new Date(latestFetchResult.last_publish_date).getTime();
    const feedDate = new Date(feedLastPublishDate).getTime();

    if (feedDate <= storedDate) {
      return `Feed content unchanged (last_publish_date: ${feedLastPublishDate.toISOString()})`;
    }

    return null;
  }

  /**
   * Record a successful fetch on the feed's health columns (atomic $set).
   * Clears any prior failure state so the feed re-enters the healthy pool.
   * Deliberately does NOT touch `gated` — that flag is owned by the audit
   * tooling until the deferred proxy-vs-direct probe lands.
   */
  private async recordFetchSuccess(
    publicationSource: PublicationSource,
    meta: FetchMeta,
  ): Promise<void> {
    const set: Record<string, unknown> = {
      last_fetched_at: new Date(),
      last_fetch_status: 'ok',
      last_fetch_http_status: meta.httpStatus ?? null,
      consecutive_fetch_failures: 0,
      consecutive_empty_fetches: 0,
      last_fetch_error: null,
      last_fetch_via: meta.via,
      // A recorded outcome of any kind ends a shed run: we reached the origin,
      // so whatever was wrong with our egress is over for this feed.
      consecutive_shed_cycles: 0,
    };
    // Clear the quarantine/backoff state so the feed rejoins the normal
    // hourly cadence immediately.
    const unset: Record<string, string> = {
      fetch_next_attempt_at: '',
      fetch_failing_since: '',
      fetch_failure_cycle_id: '',
      shed_cycle_id: '',
    };

    // A run of direct successes is the evidence promote-direct-feeds reads, so
    // one proxy success has to end the run rather than pause it.
    //
    // $inc rather than read-then-write, matching every other counter in this
    // file. The in-memory value was read at the top of loadRssFeed, so a stall
    // re-delivery running the same feed concurrently would lose an increment.
    // The consequence is only slower promotion, never a wrong one, but the
    // counters here are idempotent by design and this one should not be the
    // exception. The two branches are mutually exclusive, so $set and $inc
    // never name this field in the same update.
    const inc: Record<string, number> = {};
    if (meta.via === 'direct') {
      inc.consecutive_direct_successes = 1;
    } else {
      set.consecutive_direct_successes = 0;
    }

    // VALIDATOR RULES ARE ASYMMETRIC, and getting this wrong silently reverts
    // the whole optimisation with every test still green.
    //
    //   200: overwrite both, INCLUDING clearing one the origin has stopped
    //        sending. A stale validator against changed content is worse than
    //        none: the origin would answer 304 for a feed that did change.
    //   304: update only what came back, NEVER clear. Many origins omit
    //        Last-Modified on a 304. Clearing it means the next request sends
    //        no validator, downloads the full body, and we are back to paying
    //        for every byte. No "is the header sent" test catches that.
    const isNotModified = meta.httpStatus === 304;
    this.applyValidator(set, unset, 'http_etag', meta.etag, isNotModified);
    this.applyValidator(
      set,
      unset,
      'http_last_modified',
      meta.lastModified,
      isNotModified,
    );

    // Observation only, and never cleared: an all-301/308 chain is a fact the
    // origin stated, and a later fetch that happens not to redirect does not
    // unsay it. Promotion into `feed_url` belongs to audit tooling.
    if (meta.resolvedFeedUrl) {
      set.resolved_feed_url = meta.resolvedFeedUrl;
    }

    await this.publicationSourceModel.updateOne(
      { _id: publicationSource._id },
      Object.keys(inc).length
        ? { $set: set, $unset: unset, $inc: inc }
        : { $set: set, $unset: unset },
    );

    await this.reactivateIfAutoDeactivated(publicationSource);
  }

  /**
   * Place one validator into `$set` or `$unset`, never both — Mongo rejects an
   * update naming the same field in the two operators.
   */
  private applyValidator(
    set: Record<string, unknown>,
    unset: Record<string, string>,
    field: string,
    value: string | undefined,
    isNotModified: boolean,
  ): void {
    if (value) {
      set[field] = value;
      return;
    }
    // Absent on a 304 means "unchanged, and I did not repeat myself", so the
    // stored value stays. Absent on a 200 means the origin genuinely stopped
    // sending it.
    if (!isNotModified) {
      unset[field] = '';
    }
  }

  /**
   * A probe of an auto-deactivated feed succeeded — bring it back. Guarded on
   * `deactivation_reason` so a feed a human switched off stays off, and only
   * issued when the in-memory doc says the feed was deactivated, so the ~3.5k
   * healthy fetches per cycle pay nothing for this.
   */
  private async reactivateIfAutoDeactivated(
    publicationSource: PublicationSource,
  ): Promise<void> {
    if (publicationSource.is_active !== false) {
      return;
    }

    const result = await this.publicationSourceModel.updateOne(
      {
        _id: publicationSource._id,
        is_active: false,
        deactivation_reason: 'auto_fetch_failures',
      },
      {
        $set: { is_active: true, reactivated_at: new Date() },
        $unset: {
          deactivation_reason: '',
          deactivation_severity: '',
          deactivated_at: '',
        },
      },
    );

    if (result?.modifiedCount) {
      this.logger.log(
        `Reactivated publication ${publicationSource.publication_name} (${String(publicationSource._id)}) after a successful probe fetch`,
      );
    }
  }

  /**
   * Record a failed fetch on the feed's health columns (atomic $set + $inc).
   *
   * The $inc is gated on `fetch_failure_cycle_id` so it lands AT MOST ONCE per
   * fanout cycle. BullMQ re-attempts and stall re-deliveries re-enter this
   * method for the same cycle; counting each of them is what made a nominal
   * "3 strikes" rule fire after ~2 hours.
   *
   * Returns the current consecutive-failure count.
   */
  private async recordFetchFailure(
    publicationSource: PublicationSource,
    error: unknown,
    cycleId: string,
  ): Promise<number> {
    const category =
      error instanceof FeedFetchError ? error.category : 'network';
    const httpStatus =
      error instanceof FeedFetchError ? error.httpStatus : undefined;
    const message = error instanceof Error ? error.message : String(error);

    const healthFields: Record<string, unknown> = {
      last_fetched_at: new Date(),
      last_fetch_status: category,
      last_fetch_http_status: httpStatus ?? null,
      last_fetch_error: message,
      // A FAILURE also ends a shed run. We reached the origin and it answered
      // badly, which says our egress is working; the two counters measure
      // different things and must not blur together.
      consecutive_shed_cycles: 0,
    };

    // Anchor the elapsed-time window on the first failure of a run.
    if (!(publicationSource.consecutive_fetch_failures ?? 0)) {
      healthFields.fetch_failing_since = new Date();
    }

    const updated = await this.publicationSourceModel.findOneAndUpdate(
      {
        _id: publicationSource._id,
        fetch_failure_cycle_id: { $ne: cycleId },
      },
      {
        $set: { ...healthFields, fetch_failure_cycle_id: cycleId },
        $inc: { consecutive_fetch_failures: 1 },
      },
      { new: true },
    );

    if (updated) {
      return updated.consecutive_fetch_failures ?? 0;
    }

    // This cycle already counted — refresh the diagnostic fields only.
    const current = await this.publicationSourceModel.findByIdAndUpdate(
      publicationSource._id,
      { $set: healthFields },
      { new: true },
    );
    return current?.consecutive_fetch_failures ?? 0;
  }

  /**
   * Record that this feed was SHED because our own egress was unavailable.
   *
   * Deliberately NOT a fetch failure. It writes no StateMachineFetchPublication
   * row, so `getFetchHistory` and the chronic-death rule never see it, and it
   * never touches `consecutive_fetch_failures`. Our outage is not the feed's
   * fault and must not be evidence against it.
   *
   * What it DOES write is the minimum needed for a shed that never stops to be
   * visible in the database: a counter, a timestamp and a distinct
   * `last_fetch_status`. Without them, one bad credential in a PROXY_URLS
   * rotation sheds ~1/32 of fetches forever while `feed_health.byStatus` stays
   * clean and `last_fetch_status` holds its last good value, and nothing in
   * the product can tell you. This is deliberately DB-level rather than a
   * Cloud Monitoring alert, because an alert needs a terraform apply that this
   * work does not perform.
   *
   * The $inc is cycle-gated for the same reason `recordFetchFailure`'s is:
   * BullMQ re-attempts and stall re-deliveries re-enter here for one cycle.
   */
  private async recordShed(
    publicationSource: PublicationSource,
    cycleId: string,
  ): Promise<void> {
    try {
      const updated = await this.publicationSourceModel.findOneAndUpdate(
        { _id: publicationSource._id, shed_cycle_id: { $ne: cycleId } },
        {
          $set: {
            last_shed_at: new Date(),
            shed_cycle_id: cycleId,
            last_fetch_status: 'shed',
          },
          $inc: { consecutive_shed_cycles: 1 },
        },
        { new: true },
      );

      // Already counted this cycle.
      if (!updated) return;

      if ((updated.consecutive_shed_cycles ?? 0) < SHED_QUARANTINE_CYCLES) {
        return;
      }

      // Flat delay, not the failure ladder. Slowing down is about not hammering
      // a pool we know is broken; it is not a judgement about the feed, and it
      // must not cost hours of ingest once the pool comes back.
      await this.publicationSourceModel.updateOne(
        { _id: publicationSource._id },
        {
          $set: {
            fetch_next_attempt_at: new Date(
              Date.now() + SHED_QUARANTINE_MINUTES * 60_000,
            ),
          },
        },
      );
      this.logger.warn(
        `Feed ${publicationSource.publication_name} has been shed for ` +
          `${updated.consecutive_shed_cycles} consecutive cycles; ` +
          `backing off ${SHED_QUARANTINE_MINUTES}m. This is an EGRESS problem, ` +
          `not a feed problem: check PROXY_URLS and the proxy account.`,
      );
    } catch (shedError) {
      // Never let bookkeeping mask the shed itself.
      this.logger.error(
        `Failed to record shed for ${publicationSource.publication_name}: ` +
          (shedError instanceof Error ? shedError.message : String(shedError)),
      );
    }
  }

  /**
   * A fetch that parsed cleanly but returned zero items. The publisher is
   * simply quiet — never counted as a failure, only tracked for visibility.
   */
  private async recordBenignFetch(
    publicationSource: PublicationSource,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.publicationSourceModel.updateOne(
      { _id: publicationSource._id },
      {
        $set: {
          last_fetched_at: new Date(),
          last_fetch_status: 'empty_feed',
          last_fetch_http_status: null,
          last_fetch_error: message,
        },
        $inc: { consecutive_empty_fetches: 1 },
      },
    );
  }

  /**
   * Roll up this feed's recorded fetch history over the retention window
   * (14 days, per RETENTION_RULES). Only rows stamped with `fetch_outcome` are
   * counted, so downstream failures (e.g. article-save errors) never look like
   * fetch failures. This is the evidence base for "is this feed really dead".
   */
  private async getFetchHistory(
    publicationSourceId: Types.ObjectId,
  ): Promise<FeedFetchHistory> {
    const rows = await this.fetchResultModel.aggregate<{
      _id: string;
      count: number;
      oldest: Date;
    }>([
      {
        $match: {
          publicationSourceId,
          fetch_outcome: { $in: ['success', 'failure'] },
        },
      },
      {
        $group: {
          _id: '$fetch_outcome',
          count: { $sum: 1 },
          oldest: { $min: '$createdAt' },
        },
      },
    ]);

    const success = rows.find((r) => r._id === 'success');
    const failure = rows.find((r) => r._id === 'failure');
    const dates = [success?.oldest, failure?.oldest].filter(Boolean) as Date[];

    return {
      successes: success?.count ?? 0,
      failures: failure?.count ?? 0,
      oldestAt: dates.length
        ? new Date(Math.min(...dates.map((d) => new Date(d).getTime())))
        : null,
    };
  }

  /**
   * Apply the policy decision to the feed. Quarantine writes only a next-attempt
   * time (the feed stays active); deactivate is reserved for permanent statuses
   * and evidence-based chronic death. Guarded so a health-write error never
   * masks the original fetch error.
   */
  private async applyFeedFailureDecision(
    publicationSource: PublicationSource,
    rssFeedId: string,
    decision: FeedFailureDecision,
  ): Promise<void> {
    try {
      if (decision.action === 'retry_next_cycle') {
        await this.publicationSourceModel.findByIdAndUpdate(
          publicationSource._id,
          { $unset: { fetch_next_attempt_at: '' } },
        );
        return;
      }

      if (decision.action === 'quarantine') {
        await this.publicationSourceModel.findByIdAndUpdate(
          publicationSource._id,
          { $set: { fetch_next_attempt_at: decision.nextAttemptAt } },
        );
        return;
      }

      if (decision.action === 'deactivate') {
        await this.publicationSourceModel.findByIdAndUpdate(
          publicationSource._id,
          {
            $set: {
              is_active: false,
              deactivated_at: new Date(),
              deactivation_reason: 'auto_fetch_failures',
              deactivation_severity: decision.severity,
              fetch_next_attempt_at: decision.nextAttemptAt,
            },
          },
        );
        this.logger.warn(
          `Deactivated publication ${publicationSource.publication_name} (${rssFeedId}): ${decision.reason}`,
        );
      }
    } catch (decisionError) {
      this.logger.error(
        `Failed to apply feed failure decision for ${rssFeedId}: ${decisionError instanceof Error ? decisionError.message : String(decisionError)}`,
      );
    }
  }

  /**
   * Detect and set language codes for a publication source.
   * Sets feed_language_code from RSS metadata and detected_language_code from content analysis.
   */
  private async detectAndSetLanguageCodes(
    publicationSource: PublicationSource,
    fetchResult: StateMachineFetchPublicationDocument,
    result: { language_code?: string; items: RssFeedItem[] },
  ): Promise<{
    success: boolean;
    detectedCode: string | null;
    error?: string;
  }> {
    // Update state to LANGUAGE_DETECTION_ENQUEUED
    await this.fetchResultModel.findByIdAndUpdate(fetchResult._id, {
      status: FetchPublicationStatus.LANGUAGE_DETECTION_ENQUEUED,
    });

    try {
      // Set feed_language_code from RSS metadata (if available)
      const feedLanguageCode = result.language_code?.trim() || null;

      // Try detecting language from the first few articles — first may have ambiguous text
      let detectedLanguageCode: string | null = null;
      const maxAttempts = Math.min(2, result.items.length);
      for (let i = 0; i < maxAttempts; i++) {
        const item = result.items[i];
        const textToAnalyze =
          `${item.title || ''} ${item.description || item.contentSnippet || ''}`.slice(
            0,
            500,
          );

        if (!textToAnalyze.trim()) continue;

        try {
          detectedLanguageCode =
            this.languageDetectionService.detectLanguage(textToAnalyze);
          if (detectedLanguageCode) break;
        } catch (detectError) {
          this.logger.warn(
            `Language detection attempt ${i + 1} failed for ${publicationSource.publication_name}: ${detectError instanceof Error ? detectError.message : String(detectError)}`,
          );
        }
      }

      // Fall back to RSS feed language if CLD3 failed and feed declares a non-English language.
      // English declarations are unreliable — publishers often leave the default unchanged.
      if (
        !detectedLanguageCode &&
        feedLanguageCode &&
        !feedLanguageCode.toLowerCase().startsWith('en')
      ) {
        detectedLanguageCode = feedLanguageCode;
        this.logger.log(
          `Using RSS feed language code '${feedLanguageCode}' for ${publicationSource.publication_name} (CLD3 detection failed)`,
        );
      }

      // Update PublicationSource with language codes. Only touch
      // detected_language_code when THIS run actually produced a fresh
      // value (CLD3 success, or the non-English feed-declaration fallback
      // above) — never overwrite prior-run "memory" with null just because
      // this run's sample failed to detect anything.
      const sourceUpdate: Record<string, unknown> = {
        feed_language_code: feedLanguageCode,
      };
      if (detectedLanguageCode) {
        sourceUpdate.detected_language_code = detectedLanguageCode;
      }
      await this.publicationSourceModel.findByIdAndUpdate(
        publicationSource._id,
        sourceUpdate,
      );

      // Update fetch result with success
      await this.fetchResultModel.findByIdAndUpdate(fetchResult._id, {
        status: FetchPublicationStatus.LANGUAGE_DETECTION_SUCCESSFUL,
        detected_language_code: detectedLanguageCode,
      });

      // The code stamped on THIS run's articles. An `en*` feed declaration
      // can NEVER become the detected code (unreliable — see above). If
      // nothing was detected this run, prefer the publication's previously
      // stored detection (persistent memory from earlier runs) over null —
      // `publicationSource` was read fresh at the top of `loadRssFeed`, so
      // its `detected_language_code` reflects pre-this-run DB state.
      const articleLanguageCode =
        detectedLanguageCode ||
        publicationSource.detected_language_code ||
        null;

      return {
        success: true,
        detectedCode: articleLanguageCode,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      await this.fetchResultModel.findByIdAndUpdate(fetchResult._id, {
        status: FetchPublicationStatus.LANGUAGE_DETECTION_FAILED,
        errorMessage: `Language detection failed: ${errorMessage}`,
      });

      return { success: false, detectedCode: null, error: errorMessage };
    }
  }

  /**
   * Load RSS feed by ID - fetch articles and update metadata
   */
  async loadRssFeed(
    rssFeedId: string,
    reporter: JobReporter = NOOP_JOB_REPORTER,
    cycleId = 'adhoc',
  ): Promise<LoadRssFeedResult> {
    // Find publication source
    const publicationSource =
      await this.publicationSourceModel.findById(rssFeedId);
    if (!publicationSource) {
      throw new Error(`Publication source not found: ${rssFeedId}`);
    }
    await reporter.progress(
      10,
      `Fetching feed "${publicationSource.publication_name}"`,
    );

    // Always fetch the RSS feed first — frequency-based skipping is unreliable
    // because feeds can update at any time regardless of declared frequency.
    // Instead, we compare last_publish_date to decide whether to proceed.
    let result: Awaited<ReturnType<RSSFeedService['fetchRSSFeed']>>;
    try {
      result = await this.rssFeedService.fetchRSSFeed(publicationSource);
    } catch (error) {
      // SEAM 2 of 3, and the one that matters most. Our shared egress is down;
      // this feed is fine. NOTHING is written:
      //   - no StateMachineFetchPublication row, because getFetchHistory() reads
      //     those and the chronic-death rule counts them — a pool outage would
      //     otherwise manufacture "evidence" that thousands of feeds are dead;
      //   - no recordFetchFailure(), so consecutive_fetch_failures is untouched;
      //   - no applyFeedFailureDecision(), so nothing is quarantined.
      // What IS written (recordShed, below) is deliberately narrow: a shed
      // counter, a timestamp and last_fetch_status:'shed'. That last one
      // REVERSES an earlier decision to leave the status alone. The reason is
      // that "writes nothing" is correct for a transient event and wrong for a
      // permanent one: one bad credential in a PROXY_URLS rotation sheds
      // forever while feed_health.byStatus stays clean and no counter can trip,
      // so nothing in the product can tell you. No history row is written, so
      // the chronic-death rule still cannot see any of it.
      // UnrecoverableError (never a returned value) so the shed lands in the
      // FAILED tab: visible, countable, alertable. MeraWorkerHost carries the
      // 2026-07-10 note about 5,000 discards that read as successes.
      //
      // COUPLING — writing nothing means no `fetch_next_attempt_at`, so a
      // shed feed is due again on the very next fanout. That is correct and
      // harmless at the hourly cron, and becomes a 12x amplification the moment
      // the */5 cron lands. A fetch-lease release must be added HERE before
      // any faster cron, alongside the lease itself, the cycleId hour bucket,
      // and the two interval writes. The coupling is invisible from either file on its own.
      if (error instanceof ProxyEgressUnavailableError) {
        await this.recordShed(publicationSource, cycleId);
        this.logger.warn(
          `Shed feed ${publicationSource.publication_name} (${rssFeedId}): proxy egress unavailable`,
        );
        throw new UnrecoverableError('proxy egress unavailable');
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const category =
        error instanceof FeedFetchError ? error.category : 'network';
      const httpStatus =
        error instanceof FeedFetchError ? error.httpStatus : undefined;
      const severity = classifyFeedFailure({ category, httpStatus });

      // Keep the per-fetch state-machine history row (Bull Board + pipeline).
      // `fetch_outcome` marks it as fetch-attributable evidence.
      await this.fetchResultModel.create({
        publicationSourceId: publicationSource._id,
        status: FetchPublicationStatus.FETCH_FAILED,
        startedAt: new Date(),
        errorMessage,
        completedAt: new Date(),
        fetch_outcome: 'failure',
        fetch_category: category,
        fetch_http_status: httpStatus ?? null,
      });

      this.logger.warn(
        `Failed to load RSS feed ${publicationSource.publication_name} (${rssFeedId}): ${errorMessage}`,
      );

      if (severity === 'benign') {
        // A feed with zero items is a quiet publisher, not a broken feed.
        await this.recordBenignFetch(publicationSource, error);
      } else {
        const consecutiveFailures = await this.recordFetchFailure(
          publicationSource,
          error,
          cycleId,
        );
        const history = await this.getFetchHistory(publicationSource._id);
        const decision = decideFeedFailureAction({
          severity,
          consecutiveFailures,
          history,
          isDeactivated: publicationSource.is_active === false,
          now: new Date(),
          config: this.failurePolicy,
        });
        await this.applyFeedFailureDecision(
          publicationSource,
          rssFeedId,
          decision,
        );
      }

      throw error;
    }

    // Fetch succeeded — record feed health BEFORE the skip-unchanged check so a
    // reachable-but-unchanged feed still counts as healthy, and the later
    // article-save-failure path is never miscounted as a fetch failure.
    await this.recordFetchSuccess(publicationSource, result.fetchMeta);

    this.logFeedFetch(rssFeedId, result.fetchMeta, result.notModified === true);

    // 304: the origin confirmed our copy is current. This branch MUST come
    // before detectAndSetLanguageCodes.
    //
    // There is no body, so there is no last_publish_date, so
    // getSkipReasonIfUnchanged would return null ("can't compare, proceed") and
    // let execution fall through. Language detection would then run over zero
    // items, and `feed_language_code` is written UNCONDITIONALLY from that run
    // (unlike `detected_language_code`, which is explicitly guarded against
    // exactly this). Every feed would have its language nulled every hour.
    //
    // The history row is not optional either. getFetchHistory counts only rows
    // carrying `fetch_outcome`, and isChronicallyDead deactivates a feed with
    // zero successes across deadMinDays/deadMinAttempts. A feed that 304s
    // happily for weeks and then starts failing would look like it had never
    // once succeeded.
    if (result.notModified) {
      await this.fetchResultModel.create({
        publicationSourceId: publicationSource._id,
        status: FetchPublicationStatus.FETCH_UNCHANGED,
        startedAt: new Date(),
        completedAt: new Date(),
        fetch_outcome: 'success',
        fetch_http_status: result.fetchMeta.httpStatus ?? null,
      });

      const skipReason = 'Feed not modified (HTTP 304)';
      await reporter.log(`Skipped: ${skipReason}`);
      return {
        success: true,
        rssFeedId,
        rssFeedName: publicationSource.publication_name,
        skipped: true,
        skipReason,
      };
    }

    // Check if feed content has actually changed since last fetch
    const skipReason = await this.getSkipReasonIfUnchanged(
      publicationSource._id,
      result.last_publish_date,
    );
    if (skipReason) {
      // Record the healthy-but-unchanged fetch. Without this row the history
      // shows only failures for a reachable, quiet feed, which would make an
      // evidence-based health check declare a working feed dead.
      await this.fetchResultModel.create({
        publicationSourceId: publicationSource._id,
        status: FetchPublicationStatus.FETCH_UNCHANGED,
        startedAt: new Date(),
        completedAt: new Date(),
        last_publish_date: result.last_publish_date,
        fetch_outcome: 'success',
        fetch_http_status: result.fetchMeta.httpStatus ?? null,
      });

      await reporter.log(`Skipped: ${skipReason}`);
      return {
        success: true,
        rssFeedId,
        rssFeedName: publicationSource.publication_name,
        skipped: true,
        skipReason,
      };
    }
    await reporter.progress(
      30,
      `Fetched ${result.items.length} items from "${publicationSource.publication_name}"`,
    );

    // Create fetch result record with PENDING status
    const fetchResult = await this.fetchResultModel.create({
      publicationSourceId: publicationSource._id,
      status: FetchPublicationStatus.PENDING,
      startedAt: new Date(),
    });

    try {
      // Update fetch result with metadata and FETCH_SUCCESS status
      await this.fetchResultModel.findByIdAndUpdate(fetchResult._id, {
        status: FetchPublicationStatus.FETCH_SUCCESS,
        language_code: result.language_code,
        publication_image_uri: result.publication_image_uri,
        update_frequency: result.update_frequency || 'hourly',
        update_period: result.update_period || 1,
        last_publish_date: result.last_publish_date,
        fetch_outcome: 'success',
        fetch_http_status: result.fetchMeta.httpStatus ?? null,
      });

      // Detect and set language codes for the publication source
      const languageDetectionResult = await this.detectAndSetLanguageCodes(
        publicationSource,
        fetchResult,
        result,
      );
      await reporter.progress(
        50,
        `Language detected: ${languageDetectionResult.detectedCode ?? 'unknown'} — saving articles`,
      );

      // Save articles and enqueue processing with detected language code
      const {
        newArticles,
        duplicates,
        republishedSkipped,
        errors,
        articleProcessingIds,
        insecureArticles,
        evaluatedArticles,
      } = await this.saveItemsAndEnqueueProcessing(
        fetchResult,
        publicationSource.feed_url,
        publicationSource._id.toString(),
        result.items,
        languageDetectionResult.detectedCode,
      );

      // Insecure-link ladder. Runs on the FETCH's articles, not the inserted
      // ones, so a feed that fixed its links still resets even when everything
      // it published this hour is a republish we already have.
      await this.applyHttpLinksEscalation(
        publicationSource,
        rssFeedId,
        insecureArticles,
        evaluatedArticles,
      );

      // Update fetch result with final status
      const finalStatus =
        articleProcessingIds.length > 0
          ? FetchPublicationStatus.ENQUEUE_ARTICLE_PROCESSING_SUCCESSFUL
          : FetchPublicationStatus.FETCH_SUCCESS;

      await this.fetchResultModel.findByIdAndUpdate(fetchResult._id, {
        status: finalStatus,
        articlesProcessed: result.items.length,
        articlesCreated: newArticles,
        articlesFailed: errors,
        totalArticlesToProcess: articleProcessingIds.length,
        articlesSuccessfullyEnqueued: articleProcessingIds.length,
        articleProcessingIds: articleProcessingIds.map(
          (id) => new Types.ObjectId(id),
        ),
        completedAt: new Date(),
      });

      await reporter.progress(
        90,
        `Saved ${newArticles} new, ${duplicates} duplicates, ${republishedSkipped} republished, ${errors} errors; enqueued ${articleProcessingIds.length} for processing`,
      );

      return {
        success: true,
        rssFeedId,
        rssFeedName: publicationSource.publication_name,
        skipped: false,
        newArticles,
        duplicates,
        republishedSkipped,
        errors,
        totalParsed: result.items.length,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Update fetch result with failure status. NOTE: the feed FETCH itself
      // already succeeded (health recorded 'ok' above); this is a downstream
      // article-save/processing failure, so we do NOT touch feed health or
      // deactivate on it — deactivation is purely fetch-driven.
      // Deliberately leaves `fetch_outcome: 'success'` in place for the same
      // reason: the fetch is what the health history measures.
      await this.fetchResultModel.findByIdAndUpdate(fetchResult._id, {
        status: FetchPublicationStatus.FETCH_FAILED,
        errorMessage,
        completedAt: new Date(),
      });

      this.logger.warn(
        `Failed to load RSS feed ${publicationSource.publication_name} (${rssFeedId}): ${errorMessage}`,
      );

      throw error;
    }
  }

  /**
   * Save articles from RSS feed items and enqueue processing via linear queue
   */
  private async saveItemsAndEnqueueProcessing(
    fetchResult: StateMachineFetchPublicationDocument,
    sourceUri: string,
    publicationSourceId: string,
    items: RssFeedItem[],
    languageCode: string | null,
  ): Promise<{
    newArticles: number;
    duplicates: number;
    republishedSkipped: number;
    errors: number;
    articleProcessingIds: string[];
    /** Articles whose `article_url` landed `insecure` — the escalation input. */
    insecureArticles: number;
    /** Articles whose URL was classified at all (0 = no evidence either way). */
    evaluatedArticles: number;
  }> {
    let newArticles = 0;
    let duplicates = 0;
    let republishedSkipped = 0;
    let errors = 0;
    let itemsMissingFields = 0;
    const articleProcessingIds: string[] = [];

    // Build article documents (validation only, no DB calls)
    const validDocs: Array<Record<string, any>> = [];
    for (const item of items) {
      try {
        const doc = this.buildArticleDocument(
          sourceUri,
          publicationSourceId,
          item,
          languageCode,
          fetchResult._id,
        );
        validDocs.push(doc);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('Article published before cutoff date')) {
          this.logger.warn(
            `Skipping old article "${item.title ?? 'unknown'}" (${item.link ?? 'unknown'}): ${message}`,
          );
        } else if (message.includes('Missing required fields')) {
          // Some feeds repeat thousands of these every hour, so one line per feed.
          itemsMissingFields++;
        } else {
          this.logger.error(
            `Failed to build article "${item.title ?? 'unknown'}" (${item.link ?? 'unknown'}): ${message}`,
          );
        }
        errors++;
      }
    }
    if (itemsMissingFields > 0) {
      this.logger.warn(
        `Skipped ${itemsMissingFields} item(s) from ${sourceUri}: missing a title or link`,
      );
    }

    // Insecure-URL policy, applied BEFORE dedup so `article_url` is already in
    // its final (possibly upgraded) form everywhere downstream. Never throws —
    // the probe degrades every failure to "https unavailable".
    const { insecureArticles, evaluatedArticles, rawUrlByStoredUrl } =
      await this.applyUrlSecurity(validDocs);

    // Pre-filter against the 90-day fingerprint ledger so URLs we already
    // saw (even if their hot NewsArticle row has since aged out at 48h)
    // don't re-enter the pipeline as "new". The hot collection's own
    // unique index on article_url still catches near-simultaneous races
    // inside the 48h window.
    //
    // Two-layer check: Redis cache first (O(1) per URL, no DB round-trip for
    // repeat polls), MongoDB fallback for cache misses only.
    //
    // AN UPGRADED ARTICLE IS LOOKED UP UNDER BOTH FORMS. The ledger holds the
    // http URL from every poll before the upgrade existed, and the hot
    // collection's unique index cannot help either (the https row genuinely
    // does not exist yet) — so checking only the rewritten URL would let every
    // still-republished http article re-enter as new on the first run after
    // deploy. Silent, and bounded only by how many http links the feed repeats.
    const candidateDocs = validDocs;
    let dedupedDocs: Array<Record<string, any>> = candidateDocs;
    if (candidateDocs.length > 0) {
      const lookupUrlsFor = (doc: Record<string, any>): string[] => {
        const stored = doc.article_url as string;
        const raw = rawUrlByStoredUrl.get(stored);
        return raw && raw !== stored ? [stored, raw] : [stored];
      };
      const urls = Array.from(
        new Set(candidateDocs.flatMap((d) => lookupUrlsFor(d))),
      );

      // 1. Check Redis for all URLs in parallel.
      const cacheResults = await Promise.all(
        urls.map((url) =>
          this.cacheManager.get<string>(
            LoadRSSFeedService.fingerprintCacheKey(url),
          ),
        ),
      );
      const cachedSeenSet = new Set(
        urls.filter((_, i) => cacheResults[i] != null),
      );

      // 2. Query MongoDB only for URLs not in cache.
      const urlsMissingFromCache = urls.filter((u) => !cachedSeenSet.has(u));
      const dbSeenSet = new Set<string>();
      if (urlsMissingFromCache.length > 0) {
        const seen = await this.articleFingerprintModel
          .find(
            { article_url: { $in: urlsMissingFromCache } },
            { article_url: 1, _id: 0 },
          )
          .lean()
          .exec();
        if (seen.length > 0) {
          // Backfill cache so the next poll skips MongoDB for these URLs.
          await Promise.all(
            seen.map((s) =>
              this.cacheManager.set(
                LoadRSSFeedService.fingerprintCacheKey(s.article_url),
                '1',
                LoadRSSFeedService.FP_CACHE_TTL_MS,
              ),
            ),
          );
          for (const s of seen) dbSeenSet.add(s.article_url);
        }
      }

      const combinedSeenSet = new Set([...cachedSeenSet, ...dbSeenSet]);
      if (combinedSeenSet.size > 0) {
        dedupedDocs = candidateDocs.filter(
          (d) => !lookupUrlsFor(d).some((u) => combinedSeenSet.has(u)),
        );
        republishedSkipped = candidateDocs.length - dedupedDocs.length;
      }
    }

    // Batch insert all valid articles (ordered: false so duplicates don't halt the batch)
    const savedArticleIds: string[] = [];
    const savedUrls: string[] = [];
    if (dedupedDocs.length > 0) {
      try {
        const inserted = await this.newsArticleModel.insertMany(dedupedDocs, {
          ordered: false,
        });
        for (const doc of inserted) {
          savedArticleIds.push(doc._id.toString());
          savedUrls.push(doc.article_url);
        }
        newArticles = inserted.length;
        duplicates = dedupedDocs.length - inserted.length - errors;
      } catch (error) {
        // With ordered: false, insertMany throws but still inserts non-duplicate docs
        const bulkError = error as {
          insertedDocs?: Array<{ _id: Types.ObjectId; article_url: string }>;
          writeErrors?: Array<{ code?: number }>;
        };
        if (bulkError.insertedDocs) {
          for (const doc of bulkError.insertedDocs) {
            if (doc?._id) {
              savedArticleIds.push(doc._id.toString());
              if (doc.article_url) savedUrls.push(doc.article_url);
            }
          }
        }
        newArticles = savedArticleIds.length;

        // Count duplicate key errors vs other errors
        const writeErrors = bulkError.writeErrors ?? [];
        for (const writeError of writeErrors) {
          if (writeError.code === 11000) {
            duplicates++;
          } else {
            errors++;
          }
        }
      }
    }

    // ID-array pipeline: ONE translate-article job carrying this feed's new ids
    // (same feed, coherent Gemini chunks). Enqueued IMMEDIATELY after the
    // insert, before any bookkeeping: a re-run of this feed dedupes these URLs
    // and enqueues nothing, so a throw or SIGTERM between the insert and this
    // add would strand the articles until the fanout sweep's 90-minute grace.
    // Translation results land in the Redis scratchpad, not Mongo.
    if (savedArticleIds.length > 0) {
      await this.translateQueue.add(
        'translate-article',
        { articleIds: savedArticleIds },
        { jobId: `translate-article-${publicationSourceId}-${Date.now()}` },
      );
    }

    // Write fingerprints AFTER the hot insert succeeds. If we wrote them
    // first and the hot insert failed, a transient error would block this
    // URL for 90 days; writing after means failures naturally retry on the
    // next RSS poll.
    // An upgraded article is fingerprinted under BOTH forms. The https form is
    // what future polls of an unchanged feed will now compute; the http form is
    // what the feed literally republishes and what earlier polls recorded. One
    // extra ledger row on ~1% of articles buys a dedup that cannot break if the
    // host's https support (and therefore the upgrade) ever flips back.
    const ledgerUrls = Array.from(
      new Set(
        savedUrls.flatMap((u) => {
          const raw = rawUrlByStoredUrl.get(u);
          return raw && raw !== u ? [u, raw] : [u];
        }),
      ),
    );

    if (ledgerUrls.length > 0) {
      try {
        const pubObjectId = new Types.ObjectId(publicationSourceId);
        await this.articleFingerprintModel.insertMany(
          ledgerUrls.map((u) => ({
            article_url: u,
            publicationSourceId: pubObjectId,
          })),
          { ordered: false },
        );
      } catch (error) {
        // Duplicate fingerprints (11000) are expected on retries — ignore.
        const bulkError = error as { writeErrors?: Array<{ code?: number }> };
        const writeErrors = bulkError.writeErrors ?? [];
        const nonDup = writeErrors.filter((e) => e.code !== 11000).length;
        if (nonDup > 0) {
          this.logger.warn(
            `article-fingerprint insert had ${nonDup} non-duplicate errors for publication ${publicationSourceId}`,
          );
        }
      }

      // Populate the Redis cache for newly written fingerprints so subsequent
      // polls within the 2h TTL window skip the MongoDB round-trip entirely.
      await Promise.all(
        ledgerUrls.map((url) =>
          this.cacheManager.set(
            LoadRSSFeedService.fingerprintCacheKey(url),
            '1',
            LoadRSSFeedService.FP_CACHE_TTL_MS,
          ),
        ),
      );
    }

    articleProcessingIds.push(...savedArticleIds);

    return {
      newArticles,
      duplicates,
      republishedSkipped,
      errors,
      articleProcessingIds,
      insecureArticles,
      evaluatedArticles,
    };
  }

  /**
   * Classify every built document's URLs and rewrite them in place.
   *
   * Mutates `docs` because the alternative — rebuilding the array — would
   * duplicate `buildArticleDocument`'s field list at a second site, and these
   * are freshly-built local objects nothing else holds a reference to.
   *
   * Returns the escalation inputs plus a stored-URL -> as-published map, which
   * the fingerprint dedup below needs to look an upgraded article up under the
   * URL earlier polls recorded.
   *
   * NOTE what is NOT counted: a suppressed `image_url` never contributes to
   * `insecureArticles`. Only `article_url` may escalate a feed — losing an image
   * is a cosmetic degradation, not evidence a publisher ships insecure links to
   * its readers.
   */
  private async applyUrlSecurity(docs: Array<Record<string, any>>): Promise<{
    insecureArticles: number;
    evaluatedArticles: number;
    rawUrlByStoredUrl: Map<string, string>;
  }> {
    const rawUrlByStoredUrl = new Map<string, string>();
    if (docs.length === 0) {
      return { insecureArticles: 0, evaluatedArticles: 0, rawUrlByStoredUrl };
    }

    const resolutions = await this.urlSecurityProbe.resolveBatch(
      docs.map((d) => ({
        articleUrl: d.article_url as string,
        imageUrl: d.image_url as string | undefined,
      })),
    );

    let insecureArticles = 0;
    for (let i = 0; i < docs.length; i++) {
      const resolution = resolutions[i];
      docs[i].article_url = resolution.articleUrl;
      docs[i].image_url = resolution.imageUrl;
      // Left UNSET when the probe is disabled and the URL is http — absent
      // means "never evaluated" and stays servable.
      if (resolution.state) {
        docs[i].url_security_state = resolution.state;
      }
      if (resolution.state === UrlSecurityState.INSECURE) {
        insecureArticles++;
      }
      if (resolution.rawArticleUrl !== resolution.articleUrl) {
        rawUrlByStoredUrl.set(resolution.articleUrl, resolution.rawArticleUrl);
      }
    }

    return {
      insecureArticles,
      evaluatedArticles: docs.length,
      rawUrlByStoredUrl,
    };
  }

  /**
   * Advance (or clear) the feed's insecure-link ladder for one fetch.
   *
   * Composes with the EXISTING quarantine machinery rather than adding a second
   * deactivation path: a permanent block is just `is_active:false` with
   * `deactivation_reason: 'http_links_permanent'`, and because that reason is
   * NOT `'auto_fetch_failures'` the auto-reactivation probe skips the feed by
   * construction. Zero new machinery, and "forever" really is forever.
   *
   * NEVER touches `fetch_next_attempt_at` or any fetch-failure counter. A feed
   * can be simultaneously http-escalating and fetch-healthy; the two ladders are
   * independent and whichever trips first deactivates.
   */
  private async applyHttpLinksEscalation(
    publicationSource: PublicationSourceDocument,
    rssFeedId: string,
    insecureArticles: number,
    evaluatedArticles: number,
  ): Promise<void> {
    // With the probe off, `upgraded` is unreachable and every http-emitting feed
    // would escalate at full speed toward an irreversible block. A switch named
    // "disable probe" must not arm a deactivation timer.
    if (!this.urlSecurityProbe.probeEnabled) return;

    const decision = decideHttpLinksEscalation({
      state: {
        http_links_first_seen_at: publicationSource.http_links_first_seen_at,
        http_links_last_seen_at: publicationSource.http_links_last_seen_at,
        http_links_day_count: publicationSource.http_links_day_count,
      },
      insecureArticles,
      evaluatedArticles,
      now: new Date(),
      config: this.httpLinksPolicy,
    });

    if (decision.action === 'none') return;

    if (decision.action === 'reset') {
      await this.publicationSourceModel.updateOne(
        { _id: publicationSource._id },
        {
          $unset: {
            http_links_first_seen_at: '',
            http_links_last_seen_at: '',
            http_links_day_count: '',
          },
        },
      );
      this.logger.log(
        `http-links: ${publicationSource.publication_name} (${rssFeedId}) — ${decision.reason}`,
      );
      return;
    }

    const update: Record<string, unknown> = {
      http_links_first_seen_at: decision.firstSeenAt,
      http_links_last_seen_at: decision.lastSeenAt,
      http_links_day_count: decision.dayCount,
    };

    if (decision.action === 'deactivate') {
      update.is_active = false;
      update.deactivated_at = new Date();
      update.deactivation_reason = HTTP_LINKS_DEACTIVATION_REASON;
      update.deactivation_severity = HTTP_LINKS_DEACTIVATION_SEVERITY;
    }

    await this.publicationSourceModel.updateOne(
      { _id: publicationSource._id },
      { $set: update },
    );

    const message = `http-links: ${publicationSource.publication_name} (${rssFeedId}) — ${decision.reason}`;
    if (decision.action === 'deactivate') {
      this.logger.warn(`${message}; feed deactivated permanently`);
    } else {
      this.logger.log(message);
    }
  }

  /**
   * Resolve one `media:thumbnail`/`media:content` field — a bare string, a
   * single object, or (with the parser's `keepArray: true`) an array of
   * objects — down to one URL. When several candidates declare `width` the
   * largest wins; ties and undeclared widths keep the first candidate with a
   * URL, so single-element and no-dimension feeds are unaffected.
   */
  private resolveMediaCandidateUrl(
    candidate: string | MediaCandidate | MediaCandidate[] | undefined,
  ): string | undefined {
    if (!candidate) return undefined;
    const list = Array.isArray(candidate) ? candidate : [candidate];
    let bestUrl: string | undefined;
    let bestWidth = -1;
    for (const c of list) {
      const url = typeof c === 'string' ? c : c.url || c.$?.url;
      if (!url) continue;
      const widthRaw =
        typeof c === 'string' ? undefined : (c.width ?? c.$?.width);
      const width = widthRaw ? parseInt(widthRaw, 10) : 0;
      const effectiveWidth = Number.isNaN(width) ? 0 : width;
      if (bestUrl === undefined || effectiveWidth > bestWidth) {
        bestUrl = url;
        bestWidth = effectiveWidth;
      }
    }
    return bestUrl;
  }

  /**
   * Pick the article image. Preference order: `media:content`, then
   * `enclosure`, then `media:thumbnail` — `media:content` deliberately
   * outranks `enclosure`, reversing the old order. A `<media:thumbnail>` is
   * by definition the thumbnail; preferring it (the pre-existing behaviour)
   * meant picking the low-resolution image on feeds that publish both.
   */
  private selectImageUrl(item: RssFeedItem): string | undefined {
    return (
      this.resolveMediaCandidateUrl(item.mediaContent) ??
      item.enclosure?.url ??
      this.resolveMediaCandidateUrl(item.mediaThumbnail)
    );
  }

  /**
   * Build a plain article document object from an RSS item (no DB call).
   * Validates fields and throws on invalid items.
   */
  private buildArticleDocument(
    sourceUri: string,
    publicationSourceId: string,
    item: RssFeedItem,
    languageCode: string | null,
    fetchPublicationId?: Types.ObjectId,
  ): Record<string, any> {
    const title = sanitizeText(item.title);
    const rawDescription =
      item.contentSnippet || item.description || item.title || '';
    const description = sanitizeText(rawDescription);
    const articleUrl = item.link?.trim();

    const pubDateMoment = item.pubDate ? moment(item.pubDate) : moment();
    const oneWeekAgo = moment().subtract(7, 'days');

    if (pubDateMoment.isBefore(oneWeekAgo)) {
      throw new Error(
        `Article published before cutoff date (published: ${pubDateMoment.format('YYYY-MM-DD')}, cutoff: ${oneWeekAgo.format('YYYY-MM-DD')})`,
      );
    }

    const pubDate = pubDateMoment.toDate();
    const creator =
      typeof item.creator === 'string' ? sanitizeText(item.creator) : undefined;

    const imageUrl = this.selectImageUrl(item);

    if (!title || !articleUrl) {
      throw new Error('Missing required fields: title or article_url');
    }

    return {
      title,
      description,
      pubDate,
      creator,
      article_url: articleUrl,
      // Scheme-independent, so a later http->https upgrade of article_url
      // leaves them valid.
      copy_keys: buildArticleCopyKeys(articleUrl),
      image_url: imageUrl,
      source_uri: sourceUri,
      publicationSourceId: new Types.ObjectId(publicationSourceId),
      original_language_code: languageCode,
      type: 'rss-feed',
      processingStatus: ArticleProcessingStatus.PENDING,
      fetchPublicationId,
      processingStartedAt: new Date(),
    };
  }
}
