/**
 * `news-sync-fanout` — the hourly `:00` entrypoint of the ID-array ingestion
 * pipeline. Replaces BOTH `load-rss-feed-all` (the RSS
 * fan-out) and `trigger-article-translations` (the claim machinery). It:
 *   1. enqueues one `load-rss-feed` job per active feed (fresh ingestion),
 *   2. SWEEP A — re-drives translation stragglers/failures into
 *      `translate-article` batches,
 *   3. SWEEP B — re-drives embedding stragglers/failures into
 *      `generate-embedding-article` batches,
 *   4. emits ONE structured `fanout_health` log line (the Cloud Logging metric
 *      keys on `jsonPayload.message = "fanout_health"`), replacing `claim_health`.
 *
 * Recovery is now a single hourly sweep against Mongo (the recovery authority):
 * happy-path articles have NO Mongo text until the projector writes them, so a
 * cache-lost in-flight article simply looks "untranslated, older than grace" and
 * is re-picked here — bounded re-spend, zero manual action.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { QueryFilter, Model } from 'mongoose';
import { QueueName, JobLogger } from '@mera/shared';
import {
  PublicationSource,
  PublicationSourceDocument,
} from '@mera/models/models/publication-source.model';
import {
  NewsArticle,
  NewsArticleDocument,
  ArticleProcessingStatus,
} from '@mera/models/models/news-article.model';

export interface NewsSyncFanoutResult {
  feedsEnqueued: number;
  /** Auto-deactivated feeds re-probed this run (auto-reactivation path). */
  probeEnqueued: number;
  translateSwept: number;
  embedSwept: number;
  failedRetried: number;
  translateJobs: number;
  embedJobs: number;
  oldestUnprocessedAgeMinutes: number;
}

@Injectable()
export class NewsSyncFanoutService {
  /** Feed jobs per `addBulk` call — one Redis MULTI each. */
  private static readonly ENQUEUE_BULK_SIZE = 500;

  private readonly logger = new Logger(NewsSyncFanoutService.name);
  private readonly jobLogger: JobLogger;
  private readonly graceMinutes: number;
  private readonly maxAttempts: number;
  private readonly sweepCap: number;
  private readonly chunkSize: number;
  private readonly feedFetchJobAttempts: number;
  private readonly probeMaxPerRun: number;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(PublicationSource.name)
    private readonly publicationSourceModel: Model<PublicationSourceDocument>,
    @InjectModel(NewsArticle.name)
    private readonly articleModel: Model<NewsArticleDocument>,
    @InjectQueue(QueueName.LOAD_RSS_FEED)
    private readonly loadRssFeedQueue: Queue,
    @InjectQueue(QueueName.TRANSLATE_ARTICLE)
    private readonly translateQueue: Queue,
    @InjectQueue(QueueName.GENERATE_EMBEDDING_ARTICLE)
    private readonly embeddingQueue: Queue,
  ) {
    this.graceMinutes = this.config.get<number>('FANOUT_GRACE_MINUTES', 90);
    this.maxAttempts = this.config.get<number>('MAX_TRANSLATION_ATTEMPTS', 5);
    this.sweepCap = this.config.get<number>('MAX_ITEMS_PER_RUN', 5000);
    this.chunkSize = this.config.get<number>('FANOUT_CHUNK_SIZE', 250);
    // Overrides the global DEFAULT_JOB_OPTIONS.attempts (2) for feed fetches
    // only. A second attempt re-runs the whole fetch against a feed that just
    // failed, and the next hourly cycle re-drives it anyway.
    this.feedFetchJobAttempts = this.config.get<number>(
      'FEED_FETCH_JOB_ATTEMPTS',
      1,
    );
    this.probeMaxPerRun = this.config.get<number>(
      'FEED_PROBE_MAX_PER_RUN',
      250,
    );
    this.jobLogger = new JobLogger({
      job: 'news-sync-fanout',
      level: JobLogger.parseLevel(this.config.get<string>('LOG_LEVEL')),
    });
  }

  async runFanout(): Promise<NewsSyncFanoutResult> {
    const now = new Date();
    const graceCutoff = new Date(now.getTime() - this.graceMinutes * 60 * 1000);

    // 1. Fresh ingestion: one load-rss-feed job per fetchable feed.
    //    Gate = runtime kill-switch AND (codegen OR user provenance). A feed is
    //    fetched when EITHER provenance flag is not false, so a feed that failed
    //    codegen's direct fetch but passed proxy validation is still tried;
    //    skipped only when a human has set both provenance flags false.
    //    `$ne:false` treats legacy rows with unset flags as active.
    const provenanceGate = {
      $or: [
        { is_active_codegen: { $ne: false } },
        { is_active_user: { $ne: false } },
      ],
    };
    // Quarantine gate: a failing feed backs off via fetch_next_attempt_at
    // instead of being switched off. Absent/past = due now.
    const dueGate = {
      $or: [
        { fetch_next_attempt_at: { $exists: false } },
        { fetch_next_attempt_at: { $lte: now } },
      ],
    };

    const feeds = await this.publicationSourceModel
      .find({
        $and: [{ is_active: { $ne: false } }, provenanceGate, dueGate],
      })
      .select('_id')
      .lean();

    // Probe pool: auto-deactivated feeds get a slow re-check so a feed that
    // recovers comes back on its own. Requiring `deactivation_reason` means a
    // human-set is_active:false is never resurrected automatically.
    const probeFeeds = await this.publicationSourceModel
      .find({
        $and: [
          { is_active: false, deactivation_reason: 'auto_fetch_failures' },
          provenanceGate,
          dueGate,
        ],
      })
      .select('_id')
      .sort({ fetch_next_attempt_at: 1 })
      .limit(this.probeMaxPerRun)
      .lean();

    const timestamp = now.getTime();
    // `cycleId` makes the feed-health failure counter idempotent per fanout
    // cycle: BullMQ re-attempts (and stall re-deliveries) re-enter the same
    // processor and would otherwise each $inc consecutive_fetch_failures,
    // making a "3 strikes" rule fire after ~2 cycles instead of 3.
    const cycleId = String(timestamp);
    const enqueueStartedAt = Date.now();

    await this.enqueueFeedJobs([
      ...feeds.map((feed) =>
        this.buildFeedJob(feed._id.toString(), cycleId, timestamp, false),
      ),
      ...probeFeeds.map((feed) =>
        this.buildFeedJob(feed._id.toString(), cycleId, timestamp, true),
      ),
    ]);

    const enqueueMs = Date.now() - enqueueStartedAt;

    // feed_backlog — per-run enqueue telemetry, a SEPARATE message from both
    // fanout_health and feed_health so neither Cloud Logging metric is
    // affected. `enqueueMs` is the regression guard on the addBulk rewrite:
    // the previous one-`add`-per-feed shape took ~420s for 4.8k feeds, which
    // was invisible because nothing measured it.
    this.jobLogger.info('feed_backlog', {
      dueTotal: feeds.length,
      enqueued: feeds.length,
      probeEnqueued: probeFeeds.length,
      deferred: 0,
      enqueueMs,
    });

    // 2. SWEEP A — translate stragglers/failures.
    const sweepA = await this.articleModel
      .find(this.translateSweepFilter(graceCutoff))
      .select('_id processingStatus')
      .limit(this.sweepCap)
      .lean();
    const translateFailedCount = sweepA.filter(
      (a) => a.processingStatus === ArticleProcessingStatus.TRANSLATION_FAILED,
    ).length;
    const translateIds = sweepA.map((a) => a._id.toString());
    const translateJobs = await this.enqueueChunks(
      this.translateQueue,
      'translate-article',
      translateIds,
      timestamp,
    );

    // 3. SWEEP B — embedding stragglers/failures.
    const sweepB = await this.articleModel
      .find(this.embedSweepFilter(graceCutoff))
      .select('_id processingStatus')
      .limit(this.sweepCap)
      .lean();
    const embedFailedCount = sweepB.filter(
      (a) => a.processingStatus === ArticleProcessingStatus.EMBEDDING_FAILED,
    ).length;
    const embedIds = sweepB.map((a) => a._id.toString());
    const embedJobs = await this.enqueueChunks(
      this.embeddingQueue,
      'generate-embedding-article',
      embedIds,
      timestamp,
    );

    // 4. Oldest still-unprojected article (no Mongo English text, not terminally
    //    failed) — the pipeline-lag canary the alert keys on. The processingStatus
    //    $in is the pre-translation states, so this rides the compound
    //    {processingStatus, createdAt} index instead of walking the whole
    //    createdAt index — the old $ne/$exists shape examined the entire
    //    collection (227k docs, 0 returned) once the pipeline caught up.
    //    title_en_internal_only stays as a residual AND to preserve exact
    //    semantics; it's only evaluated on the handful of index-matched docs.
    const oldestUnprocessed = await this.articleModel
      .findOne({
        processingStatus: {
          $in: [
            ArticleProcessingStatus.PENDING,
            ArticleProcessingStatus.DETECT_LANGUAGE_ENQUEUED,
            ArticleProcessingStatus.DETECT_LANGUAGE_FAILED,
            ArticleProcessingStatus.DETECT_LANGUAGE_SUCCESSFUL,
            ArticleProcessingStatus.TRANSLATION_ENQUEUED,
          ],
        },
        title_en_internal_only: { $exists: false },
      })
      .sort({ createdAt: 1 })
      .select('createdAt')
      .lean();
    // Clamped at 0: an article inserted mid-run can carry a createdAt slightly
    // AFTER the `now` captured at the top of the run, which would otherwise
    // round to -1 and corrupt the fanout_health metric.
    const oldestUnprocessedAgeMinutes = oldestUnprocessed?.createdAt
      ? Math.max(
          0,
          Math.round(
            (now.getTime() - new Date(oldestUnprocessed.createdAt).getTime()) /
              60_000,
          ),
        )
      : 0;

    const failedRetried = translateFailedCount + embedFailedCount;

    // 5. feed_health — auxiliary per-run line on feed-fetch health (a SEPARATE
    //    message from fanout_health so its Cloud Logging metric is untouched).
    //    Guarded: an aggregation hiccup must never fail the fanout run.
    await this.emitFeedHealth(probeFeeds.length);

    // 6. fanout_health — one structured line per run, ALWAYS emitted (the Cloud
    //    Logging metric parses jsonPayload.message = "fanout_health").
    // NOTE: existing keys are load-bearing for the Cloud Logging metric —
    // `probeEnqueued` is additive only.
    this.jobLogger.info('fanout_health', {
      feedsEnqueued: feeds.length,
      probeEnqueued: probeFeeds.length,
      translateSwept: translateIds.length,
      embedSwept: embedIds.length,
      failedRetried,
      oldestUnprocessedAgeMinutes,
    });

    this.logger.log(
      `fanout: feeds=${feeds.length} probes=${probeFeeds.length} ` +
        `translateSwept=${translateIds.length} ` +
        `(${translateJobs} jobs) embedSwept=${embedIds.length} ` +
        `(${embedJobs} jobs) failedRetried=${failedRetried}`,
    );

    return {
      feedsEnqueued: feeds.length,
      probeEnqueued: probeFeeds.length,
      translateSwept: translateIds.length,
      embedSwept: embedIds.length,
      failedRetried,
      translateJobs,
      embedJobs,
      oldestUnprocessedAgeMinutes,
    };
  }

  /**
   * Emit one `feed_health` line summarizing feed-fetch health: a breakdown of
   * fetchable feeds by `last_fetch_status`, plus counts of gated and
   * runtime-deactivated feeds. Best-effort — never throws into the fanout run.
   */
  private async emitFeedHealth(probed = 0): Promise<void> {
    try {
      const now = new Date();
      const [facet] = await this.publicationSourceModel.aggregate<{
        byStatus: Array<{ _id: string; count: number }>;
        gated: Array<{ n: number }>;
        deactivated: Array<{ n: number }>;
        quarantined: Array<{ n: number }>;
        autoDeactivated: Array<{ _id: string; count: number }>;
        reactivated: Array<{ n: number }>;
      }>([
        {
          $facet: {
            byStatus: [
              { $match: { type: 'rss-feed', is_active: { $ne: false } } },
              {
                $group: {
                  _id: { $ifNull: ['$last_fetch_status', 'unknown'] },
                  count: { $sum: 1 },
                },
              },
            ],
            gated: [{ $match: { gated: true } }, { $count: 'n' }],
            deactivated: [
              { $match: { type: 'rss-feed', is_active: false } },
              { $count: 'n' },
            ],
            // Active but backed off — the population that would previously
            // have been permanently deactivated. Expected to grow; the point
            // is that `deactivated` should stay flat instead.
            quarantined: [
              {
                $match: {
                  type: 'rss-feed',
                  is_active: { $ne: false },
                  fetch_next_attempt_at: { $gt: now },
                },
              },
              { $count: 'n' },
            ],
            autoDeactivated: [
              { $match: { deactivation_reason: 'auto_fetch_failures' } },
              {
                $group: {
                  _id: { $ifNull: ['$deactivation_severity', 'unknown'] },
                  count: { $sum: 1 },
                },
              },
            ],
            reactivated: [
              { $match: { reactivated_at: { $exists: true } } },
              { $count: 'n' },
            ],
          },
        },
      ]);

      this.jobLogger.info('feed_health', {
        byStatus: Object.fromEntries(
          (facet?.byStatus ?? []).map((r) => [r._id, r.count]),
        ),
        gated: facet?.gated?.[0]?.n ?? 0,
        deactivated: facet?.deactivated?.[0]?.n ?? 0,
        quarantined: facet?.quarantined?.[0]?.n ?? 0,
        probed,
        reactivated: facet?.reactivated?.[0]?.n ?? 0,
        deactivatedBySeverity: Object.fromEntries(
          (facet?.autoDeactivated ?? []).map((r) => [r._id, r.count]),
        ),
      });
    } catch (err) {
      this.logger.warn(
        `feed_health aggregation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * SWEEP A filter: `translation_failed` under the attempt cap (transient
   * outages heal next cycle) OR cache-lost in-flights (no Mongo English text,
   * not terminally failed, older than grace).
   *
   * Branch 2 excludes `aggregation_successful` so it rides the compound
   * {processingStatus, createdAt} index. With only `$ne: <failed>` the bounds
   * covered the ~99% of the corpus the ML job has already stamped, so every
   * run fetched every article (~283k docs, 3-5 min on the prod primary) to
   * return nothing. The ML job stamps only articles it clustered, which all
   * have text and vectors, so no re-drivable article is excluded. The one
   * behaviour this narrows: a backfill that unsets text or vectors on a
   * stamped article must also reset `processingStatus`, or no sweep sees it.
   */
  private translateSweepFilter(
    graceCutoff: Date,
  ): QueryFilter<NewsArticleDocument> {
    return {
      $or: [
        {
          processingStatus: ArticleProcessingStatus.TRANSLATION_FAILED,
          $or: [
            { translation_attempts: { $lt: this.maxAttempts } },
            { translation_attempts: { $exists: false } },
          ],
        },
        {
          title_en_internal_only: { $exists: false },
          processingStatus: {
            $nin: [
              ArticleProcessingStatus.TRANSLATION_FAILED,
              ArticleProcessingStatus.AGGREGATION_SUCCESSFUL,
            ],
          },
          createdAt: { $lt: graceCutoff },
        },
      ],
    };
  }

  /**
   * SWEEP B filter: `embedding_failed` under the attempt cap OR translated but
   * unprojected/unembedded (has Mongo English text, missing retrieval vector,
   * older than grace) — only failure re-drives reach this, since happy-path
   * articles have NO Mongo text until projection. Branch 2 excludes
   * `aggregation_successful` for the same index reason as SWEEP A.
   */
  private embedSweepFilter(
    graceCutoff: Date,
  ): QueryFilter<NewsArticleDocument> {
    return {
      $or: [
        {
          processingStatus: ArticleProcessingStatus.EMBEDDING_FAILED,
          $or: [
            { embedding_attempts: { $lt: this.maxAttempts } },
            { embedding_attempts: { $exists: false } },
          ],
        },
        {
          title_en_internal_only: { $exists: true, $ne: '' },
          embedding_article_data_retrieval: { $in: [null, []] },
          processingStatus: {
            $nin: [
              ArticleProcessingStatus.EMBEDDING_FAILED,
              ArticleProcessingStatus.AGGREGATION_SUCCESSFUL,
            ],
          },
          createdAt: { $lt: graceCutoff },
        },
      ],
    };
  }

  /** Chunk ids into ≤chunkSize batches and enqueue one job per chunk. */
  private async enqueueChunks(
    queue: Queue,
    jobName: string,
    ids: string[],
    timestamp: number,
  ): Promise<number> {
    let jobs = 0;
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      const articleIds = ids.slice(i, i + this.chunkSize);
      await queue.add(
        jobName,
        { articleIds },
        { jobId: `${jobName}-fanout-${timestamp}-${jobs}` },
      );
      jobs++;
    }
    return jobs;
  }

  /**
   * Build one `load-rss-feed` job descriptor.
   *
   * `jobId` and `attempts` are deliberately byte-identical to what the previous
   * per-feed `queue.add()` produced — the addBulk rewrite changes the transport
   * only, never the job identity or the retry budget.
   */
  private buildFeedJob(
    id: string,
    cycleId: string,
    timestamp: number,
    probe: boolean,
  ) {
    return {
      name: 'load-rss-feed',
      data: { rssFeedId: id, cycleId, ...(probe ? { probe: true } : {}) },
      opts: {
        jobId: `load-rss-feed-${id}-${timestamp}`,
        attempts: this.feedFetchJobAttempts,
      },
    };
  }

  /**
   * Enqueue feed jobs via chunked `addBulk` — one Redis MULTI per chunk instead
   * of one round trip per feed.
   *
   * The previous shape was a `Promise.all` of ~4.8k individual `queue.add()`
   * calls, measured at ~7 MINUTES of wall clock in prod (2026-08-11). That
   * delay lands entirely before any feed is fetched, so it came straight out of
   * the hour the catalogue had to drain in.
   *
   * Chunked rather than one giant call so a single MULTI stays a bounded Redis
   * payload; 500 is small enough to be unremarkable and large enough that the
   * whole catalogue is ~10 round trips.
   */
  private async enqueueFeedJobs(
    jobs: ReturnType<NewsSyncFanoutService['buildFeedJob']>[],
  ): Promise<number> {
    for (
      let i = 0;
      i < jobs.length;
      i += NewsSyncFanoutService.ENQUEUE_BULK_SIZE
    ) {
      await this.loadRssFeedQueue.addBulk(
        jobs.slice(i, i + NewsSyncFanoutService.ENQUEUE_BULK_SIZE),
      );
    }
    return jobs.length;
  }
}
