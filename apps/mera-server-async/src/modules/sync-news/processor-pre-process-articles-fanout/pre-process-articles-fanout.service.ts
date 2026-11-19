/**
 * `pre-process-articles-fanout` — the entrypoint of the served-only article
 * PRE-PROCESSING stage (fired by a scheduler via
 * `/invoke {queue_name: pre-process-articles-fanout}`).
 *
 * The stage is a single LLM pass per batch that enriches an article with
 * whatever metadata downstream consumers need. Geo/entity/event TAGGING is the
 * first such enrichment; a second one is added INSIDE the pass (one more field
 * on the provider's response schema), not as a new queue and a new cron.
 *
 * It claims ONLY the articles that will actually be served — topic-linked
 * (last 48h) plus the per-country top-headline sweep (last 24h) — filters them
 * to the un-enriched / retryable / stale-enqueued subset, marks them
 * TAGGING_ENQUEUED, and chunks them into `pre-process-articles` worker jobs.
 *
 * INDEPENDENCE INVARIANT — this stage never gates, delays or reorders the
 * scoring path. The serve path (`articleIdsForPersona` / `articlesForTopicsByIds`)
 * reads none of the lifecycle fields, and every metadata field is additive and
 * nullable, so a slow, failed or entirely disabled pre-process run is invisible
 * to scoring. Metadata is consumed AFTER scoring, as a filter.
 *
 * Retry semantics mirror `news-sync-fanout`: a single sweep against Mongo (the
 * recovery authority). TAGGING_FAILED under the attempt cap, stale
 * TAGGING_ENQUEUED (a lost or never-queued job) and stale TAGGING_IN_PROGRESS
 * (a worker that died mid-call) are re-claimed on the next run through the
 * sparse `tags_status` index, in BOTH claim modes — bounded re-spend, zero
 * manual action. `pre-process-articles` jobs run with attempts 1: this sweep
 * is the retry.
 *
 * Fresh claim, `PREPROCESS_CLAIM_MODE`:
 *   - `served` (default): topic-linked (48h) + per-country headlines (24h),
 *     filtered to rows with no `tags_status`.
 *   - `recent`: an `_id` range over the last PREPROCESS_RECENT_WINDOW_MINUTES
 *     (default 120) with no `tags_status` and English text present. The
 *     catch-up for rows projected while enrich-on-ingest was off or its
 *     enqueue failed. No index covers "tags_status missing", so the window is
 *     kept short on purpose.
 *
 * OFF BY DEFAULT. `PRE_PROCESS_ARTICLES_ENABLED` must be explicitly `true` for
 * the stage to claim anything — the provider adapter defaults to the real
 * (paid) Gemini API, so merging this code must not begin spending on its own.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { QueueName, JobLogger } from '@mera/shared';
import {
  TopicArticleLink,
  TopicArticleLinkDocument,
} from '@mera/models/models/topic-article-link.model';
import {
  NewsArticle,
  NewsArticleDocument,
} from '@mera/models/models/news-article.model';

export const TAGGING_ENQUEUED = 'TAGGING_ENQUEUED';
/**
 * A worker has claimed the row and is calling the provider. Additive status
 * value; `tags_enqueued_at` then holds the claim time, which drives the stale
 * IN_PROGRESS recovery.
 */
export const TAGGING_IN_PROGRESS = 'TAGGING_IN_PROGRESS';
export const TAGGING_SUCCESSFUL = 'TAGGING_SUCCESSFUL';
export const TAGGING_FAILED = 'TAGGING_FAILED';

const MS_PER_MINUTE = 60 * 1000;
const LINKED_WINDOW_HOURS = 48;
const HEADLINE_WINDOW_HOURS = 24;

export type PreProcessClaimMode = 'served' | 'recent';

export interface PreProcessFanoutResult {
  claimedLinked: number;
  claimedHeadline: number;
  candidates: number;
  alreadyTagged: number;
  enqueued: number;
  chunks: number;
  /** Retryable FAILED + stale ENQUEUED / IN_PROGRESS rows re-claimed. */
  swept?: number;
  /** Rows the `recent` window claimed. */
  claimedRecent?: number;
  mode?: PreProcessClaimMode;
  /** True when the run short-circuited because the stage is disabled. */
  disabled?: boolean;
}

function intConfig(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string | number>(key);
  const n = Number(raw);
  return raw !== undefined && raw !== '' && Number.isFinite(n) && n > 0
    ? n
    : fallback;
}

@Injectable()
export class PreProcessArticlesFanoutService {
  private readonly logger = new Logger(PreProcessArticlesFanoutService.name);
  private readonly jobLogger: JobLogger;
  private readonly headlineTopN: number;
  private readonly maxAttempts: number;
  private readonly maxItemsPerRun: number;
  private readonly chunkSize: number;
  private readonly staleMinutes: number;
  private readonly staleInProgressMinutes: number;
  private readonly recentWindowMinutes: number;
  private readonly claimMode: PreProcessClaimMode;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(TopicArticleLink.name)
    private readonly topicArticleLinkModel: Model<TopicArticleLinkDocument>,
    @InjectModel(NewsArticle.name)
    private readonly articleModel: Model<NewsArticleDocument>,
    @InjectQueue(QueueName.PRE_PROCESS_ARTICLES)
    private readonly preProcessQueue: Queue,
  ) {
    this.headlineTopN = this.config.get<number>(
      'PREPROCESS_HEADLINE_TOP_N',
      30,
    );
    this.maxAttempts = this.config.get<number>('MAX_PREPROCESS_ATTEMPTS', 5);
    this.maxItemsPerRun = this.config.get<number>(
      'PREPROCESS_MAX_ITEMS_PER_RUN',
      5000,
    );
    this.chunkSize = this.config.get<number>('FANOUT_CHUNK_SIZE', 250);
    // Kill switch — DEFAULT OFF. Every claim query and every provider call sits
    // behind this, so the stage costs exactly nothing until it is set to 'true'.
    this.enabled =
      String(
        this.config.get<string | boolean>(
          'PRE_PROCESS_ARTICLES_ENABLED',
          false,
        ),
      ).toLowerCase() === 'true';
    this.staleMinutes = this.config.get<number>(
      'PREPROCESS_STALE_ENQUEUED_MINUTES',
      90,
    );
    // Must exceed the longest a claimed batch can legitimately run: the
    // adapter's whole-batch timeout (ENRICHMENT_LLM_CHUNK_TIMEOUT_MS, 15 min
    // by default). A shorter window re-claims a live batch and bills it twice.
    this.staleInProgressMinutes = intConfig(
      this.config,
      'PREPROCESS_STALE_IN_PROGRESS_MINUTES',
      45,
    );
    this.recentWindowMinutes = intConfig(
      this.config,
      'PREPROCESS_RECENT_WINDOW_MINUTES',
      120,
    );
    this.claimMode =
      String(this.config.get<string>('PREPROCESS_CLAIM_MODE') ?? 'served')
        .trim()
        .toLowerCase() === 'recent'
        ? 'recent'
        : 'served';
    this.jobLogger = new JobLogger({
      job: 'pre-process-articles-fanout',
      level: JobLogger.parseLevel(this.config.get<string>('LOG_LEVEL')),
    });
    const chunkTimeoutMin =
      intConfig(this.config, 'ENRICHMENT_LLM_CHUNK_TIMEOUT_MS', 900_000) /
      MS_PER_MINUTE;
    if (this.staleInProgressMinutes <= chunkTimeoutMin) {
      this.jobLogger.warn('pre_process_stale_window_too_short', {
        staleInProgressMinutes: this.staleInProgressMinutes,
        chunkTimeoutMinutes: chunkTimeoutMin,
      });
    }
  }

  async runPreProcessFanout(): Promise<PreProcessFanoutResult> {
    // Kill switch FIRST — before any Mongo claim — so a manual Bull Board or
    // `/invoke` trigger also no-ops rather than spending.
    if (!this.enabled) {
      this.jobLogger.info('pre_process_fanout_disabled', {});
      this.logger.log(
        'pre-process-fanout: disabled (PRE_PROCESS_ARTICLES_ENABLED is not true) — no claim, no spend',
      );
      return {
        claimedLinked: 0,
        claimedHeadline: 0,
        candidates: 0,
        alreadyTagged: 0,
        enqueued: 0,
        chunks: 0,
        disabled: true,
      };
    }

    const now = new Date();

    // Sweep — BOTH modes: retryable FAILED and stale ENQUEUED / IN_PROGRESS
    // rows, through the sparse tags_status index. It runs first so recovery
    // is never starved by fresh volume; retries are bounded by the attempt
    // cap, so they can never starve fresh rows for long either.
    const swept = await this.sweepLifecycle(now, this.maxItemsPerRun);
    const budget = Math.max(0, this.maxItemsPerRun - swept.length);

    let linkedIds: string[] = [];
    let headlineIds: string[] = [];
    let candidates = 0;
    let fresh: string[];
    if (this.claimMode === 'recent') {
      fresh = budget > 0 ? await this.claimRecent(now, budget) : [];
    } else {
      // Claim A — topic-linked articles in the 48h window (the personalized
      // served set). Claim B — per-country top headlines (last 24h).
      linkedIds = await this.claimLinked(now);
      headlineIds = await this.claimHeadlines(now);
      // The per-run cap lives on the FILTER, never on the candidate union.
      // Capping candidates first would starve the tail forever:
      // `distinct('articleId')` returns a stable order, so the same first N
      // candidates would be examined every run and — once they are all
      // enriched — the run would enqueue zero while thousands of newer
      // articles behind the cut never get looked at.
      const union = this.dedupe([...linkedIds, ...headlineIds]);
      candidates = union.length;
      fresh =
        budget > 0 && union.length > 0
          ? await this.filterUnenriched(union, budget)
          : [];
    }

    const taggable = this.dedupe([...swept, ...fresh]);
    const alreadyTagged = candidates - fresh.length;

    // Mark claimed TAGGING_ENQUEUED, then chunk into worker jobs.
    let chunks = 0;
    if (taggable.length > 0) {
      await this.markEnqueued(taggable, now);
      chunks = await this.enqueueChunks(taggable, now.getTime());
    }

    const summary = {
      mode: this.claimMode,
      claimedLinked: linkedIds.length,
      claimedHeadline: headlineIds.length,
      claimedRecent: this.claimMode === 'recent' ? fresh.length : 0,
      swept: swept.length,
      alreadyTagged,
      enqueued: taggable.length,
      chunks,
    };
    this.jobLogger.info('pre_process_fanout_health', summary);

    this.logger.log(
      `pre-process-fanout: mode=${this.claimMode} linked=${linkedIds.length} ` +
        `headline=${headlineIds.length} recent=${summary.claimedRecent} ` +
        `swept=${swept.length} candidates=${candidates} ` +
        `alreadyTagged=${alreadyTagged} enqueued=${taggable.length} (${chunks} chunks)`,
    );

    return { ...summary, candidates };
  }

  /** Distinct articleIds from topic-article-link created within the 48h window. */
  private async claimLinked(now: Date): Promise<string[]> {
    const cutoff = new Date(
      now.getTime() - LINKED_WINDOW_HOURS * 60 * MS_PER_MINUTE,
    );
    const ids = await this.topicArticleLinkModel
      .distinct('articleId', {
        createdAt: { $gte: cutoff },
        canonical: { $ne: true },
      })
      .exec();
    return ids.map((id) => id.toString());
  }

  /**
   * Per-country top-headline sweep: for each active country, the top-N last-24h
   * articles ranked by their largest live cluster size. ONE aggregation grouping
   * by country (mirrors the graphql topHeadlines ranking, minus cursors).
   */
  private async claimHeadlines(now: Date): Promise<string[]> {
    const cutoff = new Date(
      now.getTime() - HEADLINE_WINDOW_HOURS * 60 * MS_PER_MINUTE,
    );
    const grouped = await this.articleModel
      .aggregate<{ _id: string; ids: Types.ObjectId[] }>([
        { $match: { createdAt: { $gte: cutoff } } },
        {
          $lookup: {
            from: 'publication-source',
            localField: 'publicationSourceId',
            foreignField: '_id',
            as: 'ps',
          },
        },
        { $unwind: '$ps' },
        { $match: { 'ps.is_active': { $ne: false } } },
        {
          $lookup: {
            from: 'cluster-article-link',
            localField: '_id',
            foreignField: 'articleId',
            as: 'clusterLinks',
          },
        },
        {
          $lookup: {
            from: 'news-cluster',
            localField: 'clusterLinks.clusterId',
            foreignField: '_id',
            as: 'clusters',
          },
        },
        {
          $addFields: {
            maxClusterSize: { $ifNull: [{ $max: '$clusters.clusterSize' }, 0] },
          },
        },
        // Sort BEFORE grouping so each country's $push preserves headline order.
        { $sort: { 'ps.country_code': 1, maxClusterSize: -1, createdAt: -1 } },
        {
          $group: {
            _id: '$ps.country_code',
            ids: { $push: '$_id' },
          },
        },
        { $project: { ids: { $slice: ['$ids', this.headlineTopN] } } },
      ])
      .allowDiskUse(true)
      .exec();

    const ids: string[] = [];
    for (const country of grouped) {
      for (const id of country.ids) ids.push(id.toString());
    }
    return ids;
  }

  /**
   * The lifecycle states a run may (re-)claim, each branch led by an equality
   * on `tags_status` so the sparse index serves it.
   */
  private retryPredicates(now: Date): Record<string, unknown>[] {
    const staleEnqueued = new Date(
      now.getTime() - this.staleMinutes * MS_PER_MINUTE,
    );
    const staleInProgress = new Date(
      now.getTime() - this.staleInProgressMinutes * MS_PER_MINUTE,
    );
    return [
      { tags_status: TAGGING_FAILED, tags_attempts: { $lt: this.maxAttempts } },
      {
        tags_status: TAGGING_ENQUEUED,
        tags_enqueued_at: { $lt: staleEnqueued },
      },
      {
        tags_status: TAGGING_IN_PROGRESS,
        tags_enqueued_at: { $lt: staleInProgress },
      },
    ];
  }

  /**
   * Sweep: retryable FAILED + stale ENQUEUED + stale IN_PROGRESS, anywhere in
   * the collection. Sorted `_id: -1` so a backlog drains NEWEST-FIRST.
   */
  private async sweepLifecycle(now: Date, cap: number): Promise<string[]> {
    const docs = await this.articleModel
      .find({ $or: this.retryPredicates(now) })
      .select('_id')
      .sort({ _id: -1 })
      .limit(cap)
      .lean();
    return docs.map((d) => d._id.toString());
  }

  /**
   * Served mode: the candidates with no `tags_status` yet. This is where the
   * fresh cap is applied — see the note in {@link runPreProcessFanout}.
   */
  private async filterUnenriched(
    candidateIds: string[],
    cap: number,
  ): Promise<string[]> {
    const objectIds = candidateIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));
    const docs = await this.articleModel
      .find({ _id: { $in: objectIds }, tags_status: { $exists: false } })
      .select('_id')
      .sort({ _id: -1 })
      .limit(cap)
      .lean();
    return docs.map((d) => d._id.toString());
  }

  /**
   * Recent mode: rows created in the last PREPROCESS_RECENT_WINDOW_MINUTES
   * (an `_id` range, never `createdAt`, which no index leads with) that carry
   * English text and no `tags_status`. Capped on the query, newest first.
   */
  private async claimRecent(now: Date, cap: number): Promise<string[]> {
    const since = Types.ObjectId.createFromTime(
      Math.floor(
        (now.getTime() - this.recentWindowMinutes * MS_PER_MINUTE) / 1000,
      ),
    );
    const docs = await this.articleModel
      .find({
        _id: { $gte: since },
        tags_status: { $exists: false },
        title_en_internal_only: { $nin: [null, ''] },
      })
      .select('_id')
      .sort({ _id: -1 })
      .limit(cap)
      .lean();
    return docs.map((d) => d._id.toString());
  }

  /**
   * Stamp the claimed articles TAGGING_ENQUEUED with the claim timestamp, but
   * only while they are still in a claimable state: a row that turned
   * SUCCESSFUL, or was re-claimed by a live worker, between the read and this
   * write keeps its status.
   */
  private async markEnqueued(ids: string[], now: Date): Promise<void> {
    await this.articleModel.updateMany(
      {
        _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
        $or: [
          { tags_status: { $exists: false } },
          ...this.retryPredicates(now),
        ],
      },
      { $set: { tags_status: TAGGING_ENQUEUED, tags_enqueued_at: now } },
    );
  }

  /** Chunk ids at chunkSize and addBulk one pre-process-articles job per chunk. */
  private async enqueueChunks(
    ids: string[],
    timestamp: number,
  ): Promise<number> {
    const jobs: {
      name: string;
      data: { articleIds: string[] };
      opts: object;
    }[] = [];
    for (let i = 0; i < ids.length; i += this.chunkSize) {
      jobs.push({
        name: 'pre-process-articles',
        data: { articleIds: ids.slice(i, i + this.chunkSize) },
        opts: {
          jobId: `pre-process-articles-fanout-${timestamp}-${jobs.length}`,
          // The next run's sweep is the retry; a BullMQ retry would re-bill
          // enrichment calls that already succeeded.
          attempts: 1,
        },
      });
    }
    if (jobs.length > 0) await this.preProcessQueue.addBulk(jobs);
    return jobs.length;
  }

  private dedupe(ids: string[]): string[] {
    return [...new Set(ids)];
  }
}
