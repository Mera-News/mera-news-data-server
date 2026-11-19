/**
 * `pre-process-articles` worker. One job carries an array of articleIds (a
 * fanout chunk or an enrich-on-ingest chunk from the projector). ONE LLM pass
 * per sub-batch produces all of an article's enrichment metadata. The service:
 *   1. reads the English text and lifecycle status in ONE query,
 *   2. keeps only rows marked TAGGING_ENQUEUED (anything else was already
 *      enriched, is being enriched by another job, or was never claimed),
 *   3. sub-batches them (the adapter's `tuning.batchSize`, else
 *      PREPROCESS_ATTENTION_CAP) under a shared cockatiel policy,
 *   4. per sub-batch, inside the bulkhead slot: CLAIMS its rows
 *      (ENQUEUED → TAGGING_IN_PROGRESS, conditional) and bills ONLY the rows it
 *      claimed, so a duplicate job for the same ids (a stale re-enqueue, the
 *      ingest path plus the fanout) never pays twice,
 *   5. writes that sub-batch's results as soon as it settles — metadata on
 *      success, TAGGING_FAILED + attempt++ on an infra failure — so a crash
 *      later in the job cannot lose calls already paid for.
 *
 * Jobs run with attempts 1; the fanout's stale sweep is the retry. A row left
 * ENQUEUED or IN_PROGRESS by a dead job is re-claimed once its stale window
 * passes (PREPROCESS_STALE_ENQUEUED_MINUTES / _IN_PROGRESS_MINUTES).
 *
 * Articles are already projected to Mongo by this stage, so this writes directly
 * to `news-article` — NO ArticleCacheService involvement. Degraded items (empty
 * tags from a content-level failure) count as SUCCESS (TAGGING_SUCCESSFUL), and
 * are deliberately indistinguishable from "not yet enriched" to the app: both
 * mean "do not rely on the metadata".
 *
 * The persisted lifecycle field names (`tags_status`, `tags_attempts`,
 * `tags_enqueued_at`, `tagsError`) and their string values are DELIBERATELY
 * unchanged by the pre-process rename — they are stage-internal, read by no
 * client, and renaming them would be a data migration for zero behavioural gain.
 * `tags_enqueued_at` holds the time of the latest ENQUEUED or IN_PROGRESS
 * transition.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import {
  ARTICLE_ENRICHMENT_PROVIDER,
  type ArticleEnrichmentProvider,
  type EnrichmentInput,
  type ArticleEnrichment,
  buildProviderResiliencePolicy,
  DEFAULT_PROVIDER_RESILIENCE,
  JobLogger,
} from '@mera/shared';
import { buildEnrichmentUpdate } from '@mera/shared/enrichment/enrichment-write';
import type {
  EnrichmentBatchResult,
  EnrichmentBatchUsage,
} from '@mera/shared/enrichment/article-enrichment-provider.port';
import type { IPolicy } from 'cockatiel';
import {
  NewsArticle,
  NewsArticleDocument,
} from '@mera/models/models/news-article.model';
import {
  TAGGING_ENQUEUED,
  TAGGING_FAILED,
  TAGGING_IN_PROGRESS,
} from '../processor-pre-process-articles-fanout/pre-process-articles-fanout.service';

export interface PreProcessArticlesResult {
  requested: number;
  tagged: number;
  degraded: number;
  failed: number;
  missing: number;
  /** Ids not billed: not ENQUEUED at read time, or claimed by another job. */
  skipped: number;
}

interface BatchOutcome {
  tagged: number;
  degraded: number;
  failed: number;
  skipped: number;
  usage?: EnrichmentBatchUsage;
  writeError?: string;
}

@Injectable()
export class PreProcessArticlesService {
  private readonly logger = new Logger(PreProcessArticlesService.name);
  private readonly jobLogger: JobLogger;
  private readonly attentionCap: number;
  private readonly policy: IPolicy;
  /** Last claim stamp handed out; claim stamps are unique per process. */
  private lastClaimMs = 0;

  constructor(
    config: ConfigService,
    @Inject(ARTICLE_ENRICHMENT_PROVIDER)
    private readonly provider: ArticleEnrichmentProvider,
    @InjectModel(NewsArticle.name)
    private readonly articleModel: Model<NewsArticleDocument>,
  ) {
    this.jobLogger = new JobLogger({
      job: 'pre-process-articles',
      level: JobLogger.parseLevel(config.get<string>('LOG_LEVEL')),
    });
    // An adapter that owns its own HTTP retries and batch size (openrouter)
    // publishes `tuning`; the shared PROVIDER_* knobs are also read by
    // translate and embed and would abort its calls at 60s and re-bill
    // successful calls through a whole-batch retry. Without `tuning` (Gemini,
    // fake) everything below is exactly what it was.
    const tuning = provider.tuning;
    this.attentionCap =
      tuning?.batchSize ?? config.get<number>('PREPROCESS_ATTENTION_CAP', 40);

    // ONE shared policy (singleton service) so the bulkhead semaphore and the
    // circuit breaker are shared across concurrently-running tag jobs.
    this.policy = buildProviderResiliencePolicy({
      concurrency:
        tuning?.concurrency ??
        config.get<number>('PREPROCESS_MAX_CONCURRENT_BATCHES', 8),
      retryAttempts:
        tuning?.policyRetries ??
        config.get<number>(
          'PROVIDER_RETRY_ATTEMPTS',
          DEFAULT_PROVIDER_RESILIENCE.retryAttempts,
        ),
      backoffMs: config.get<number>(
        'PROVIDER_RETRY_BACKOFF_MS',
        DEFAULT_PROVIDER_RESILIENCE.backoffMs,
      ),
      maxBackoffMs: config.get<number>(
        'PROVIDER_RETRY_MAX_BACKOFF_MS',
        DEFAULT_PROVIDER_RESILIENCE.maxBackoffMs,
      ),
      breakerThreshold: config.get<number>(
        'PROVIDER_BREAKER_THRESHOLD',
        DEFAULT_PROVIDER_RESILIENCE.breakerThreshold,
      ),
      breakerHalfOpenMs: config.get<number>(
        'PROVIDER_BREAKER_HALFOPEN_MS',
        DEFAULT_PROVIDER_RESILIENCE.breakerHalfOpenMs,
      ),
      timeoutMs:
        tuning?.chunkTimeoutMs ??
        config.get<number>(
          'PROVIDER_CHUNK_TIMEOUT_MS',
          DEFAULT_PROVIDER_RESILIENCE.timeoutMs,
        ),
    });
  }

  async preProcessArticles(
    articleIds: string[],
  ): Promise<PreProcessArticlesResult> {
    const requested = articleIds.length;
    if (requested === 0) return this.emptyResult(0);

    const objectIds = articleIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const articles = await this.articleModel
      .find({ _id: { $in: objectIds } })
      .select('title_en_internal_only description_en_internal_only tags_status')
      .lean();
    const byId = new Map(articles.map((a) => [a._id.toString(), a]));

    const inputs: EnrichmentInput[] = [];
    let missing = 0;
    let skipped = 0;
    for (const id of articleIds) {
      const article = byId.get(id);
      if (!article) {
        missing++;
        continue;
      }
      // Only a row the fanout or the projector marked ENQUEUED is ours to
      // claim. SUCCESSFUL (a duplicate job), IN_PROGRESS (another job has it)
      // and anything else are skipped without a provider call.
      if (article.tags_status !== TAGGING_ENQUEUED) {
        skipped++;
        continue;
      }
      inputs.push({
        id,
        title_en: article.title_en_internal_only ?? '',
        description_en: article.description_en_internal_only ?? '',
      });
    }

    const outcomes = await Promise.all(
      this.chunk(inputs, this.attentionCap).map((batch) =>
        this.runBatch(batch),
      ),
    );

    const usage = this.emptyUsage();
    let tagged = 0;
    let degraded = 0;
    let failed = 0;
    const writeErrors: string[] = [];
    for (const o of outcomes) {
      tagged += o.tagged;
      degraded += o.degraded;
      failed += o.failed;
      skipped += o.skipped;
      if (o.usage) this.addUsage(usage, o.usage);
      if (o.writeError) writeErrors.push(o.writeError);
    }

    this.logger.log(
      `pre-process batch: requested=${requested} tagged=${tagged} degraded=${degraded} ` +
        `failed=${failed} missing=${missing} skipped=${skipped}`,
    );
    this.logUsage(usage, { requested, tagged, degraded, failed });

    // Every sub-batch has settled and written what it could. A failed write
    // leaves its rows IN_PROGRESS for the stale sweep; surface it as a failed
    // job so it is visible, without a BullMQ retry (attempts 1).
    if (writeErrors.length > 0) {
      throw new Error(
        `pre-process write failed for ${writeErrors.length} sub-batch(es): ${writeErrors[0]}`,
      );
    }

    return { requested, tagged, degraded, failed, missing, skipped };
  }

  /**
   * One sub-batch end to end: claim inside the bulkhead slot, enrich, write.
   * Never throws; every failure is folded into the outcome.
   */
  private async runBatch(batch: EnrichmentInput[]): Promise<BatchOutcome> {
    const out: BatchOutcome = { tagged: 0, degraded: 0, failed: 0, skipped: 0 };
    // Claimed once, even if the policy retries the call (Gemini path).
    // A holder, not a `let`: the closure assigns it, and TS would otherwise
    // narrow a plain local to `null` after the call.
    const claim: { rows: EnrichmentInput[] | null } = { rows: null };
    let result: Awaited<ReturnType<PreProcessArticlesService['enrich']>>;
    try {
      result = await this.policy.execute(async ({ signal }) => {
        claim.rows ??= await this.claim(batch);
        if (claim.rows.length === 0) return { outputs: [] };
        return this.enrich(claim.rows, signal);
      });
    } catch (err) {
      const reason = err as { usage?: EnrichmentBatchUsage };
      if (reason?.usage) out.usage = reason.usage;
      const rows = claim.rows ?? [];
      out.skipped = batch.length - rows.length;
      // Whole sub-batch died (network/5xx after retries, breaker open,
      // timeout, out of credit). Only rows this job claimed are marked; a
      // failed claim leaves them ENQUEUED for the stale sweep.
      const message = err instanceof Error ? err.message : String(err);
      const now = new Date();
      out.failed = rows.length;
      await this.write(
        rows.map((i) => this.failureOp(i.id, `Tagging error: ${message}`, now)),
        out,
      );
      return out;
    }

    const rows = claim.rows ?? [];
    out.skipped = batch.length - rows.length;
    if (result.usage) out.usage = result.usage;
    const now = new Date();
    const ops: AnyBulkWriteOperation<NewsArticleDocument>[] = [];
    rows.forEach((item, j) => {
      const res = result.outputs[j];
      if (!res) {
        // Provider broke its contract (missing aligned output) — treat as infra
        // failure for this item so the fanout re-drives it.
        ops.push(this.failureOp(item.id, 'Tagging error: missing output', now));
        out.failed++;
        return;
      }
      // Degraded items (empty tags) are a content-level outcome, NOT infra —
      // they count as SUCCESS so the fanout does not re-drive them forever.
      // An adapter reporting usage counts its own degraded rows exactly.
      if (
        !result.usage &&
        res.geo_tags.length === 0 &&
        res.entities.length === 0
      ) {
        out.degraded++;
      }
      out.tagged++;
      ops.push(this.successOp(item.id, res));
    });
    if (result.usage) out.degraded += result.usage.degraded;
    await this.write(ops, out);
    return out;
  }

  private async write(
    ops: AnyBulkWriteOperation<NewsArticleDocument>[],
    out: BatchOutcome,
  ): Promise<void> {
    if (ops.length === 0) return;
    try {
      await this.articleModel.bulkWrite(ops, { ordered: false });
    } catch (err) {
      out.writeError = (err as Error).message;
    }
  }

  /**
   * ENQUEUED → IN_PROGRESS for this sub-batch, then read back (an `_id`
   * projection) exactly the rows this claim stamped. A row another job
   * claimed first is not in the result and is not billed.
   */
  private async claim(batch: EnrichmentInput[]): Promise<EnrichmentInput[]> {
    const claimAt = this.nextClaimStamp();
    const ids = batch.map((i) => new Types.ObjectId(i.id));
    await this.articleModel.updateMany(
      { _id: { $in: ids }, tags_status: TAGGING_ENQUEUED },
      { $set: { tags_status: TAGGING_IN_PROGRESS, tags_enqueued_at: claimAt } },
    );
    const docs = await this.articleModel
      .find(
        {
          _id: { $in: ids },
          tags_status: TAGGING_IN_PROGRESS,
          tags_enqueued_at: claimAt,
        },
        { _id: 1 },
      )
      .lean();
    const mine = new Set(docs.map((d) => d._id.toString()));
    return batch.filter((i) => mine.has(i.id));
  }

  /** Strictly increasing within this process, so two claims never share one. */
  private nextClaimStamp(): Date {
    const ms = Math.max(Date.now(), this.lastClaimMs + 1);
    this.lastClaimMs = ms;
    return new Date(ms);
  }

  /** Prefer the usage-reporting call when the adapter has one. */
  private async enrich(
    batch: EnrichmentInput[],
    signal: AbortSignal,
  ): Promise<{
    outputs: EnrichmentBatchResult['outputs'];
    usage?: EnrichmentBatchUsage;
  }> {
    if (this.provider.enrichBatchWithUsage) {
      return this.provider.enrichBatchWithUsage(batch, signal);
    }
    return { outputs: await this.provider.enrichBatch(batch, signal) };
  }

  /**
   * One structured line per job: what it cost, which model and which host
   * actually served it, and how many items fell back or degraded. Only an
   * adapter that reports usage (openrouter) fills the cost fields.
   */
  private logUsage(
    usage: EnrichmentBatchUsage,
    counts: {
      requested: number;
      tagged: number;
      degraded: number;
      failed: number;
    },
  ): void {
    const processed = counts.tagged + counts.failed;
    this.jobLogger.info('pre_process_usage', {
      ...counts,
      item_fallbacks: usage.itemFallbacks,
      requests: usage.requests,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      costUsd: Number(usage.costUsd.toFixed(6)),
      costPer1kArticles:
        processed > 0
          ? Number(((usage.costUsd / processed) * 1000).toFixed(4))
          : 0,
      models: usage.models,
      providers: usage.providers,
    });
  }

  private emptyUsage(): EnrichmentBatchUsage {
    return {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      models: {},
      providers: {},
      itemFallbacks: 0,
      degraded: 0,
    };
  }

  private addUsage(into: EnrichmentBatchUsage, u: EnrichmentBatchUsage): void {
    into.requests += u.requests;
    into.promptTokens += u.promptTokens;
    into.completionTokens += u.completionTokens;
    into.costUsd += u.costUsd;
    into.itemFallbacks += u.itemFallbacks;
    into.degraded += u.degraded;
    for (const [k, v] of Object.entries(u.models)) {
      into.models[k] = (into.models[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(u.providers)) {
      into.providers[k] = (into.providers[k] ?? 0) + v;
    }
  }

  private successOp(
    articleId: string,
    out: ArticleEnrichment,
  ): AnyBulkWriteOperation<NewsArticleDocument> {
    return {
      updateOne: {
        filter: { _id: new Types.ObjectId(articleId) },
        // Shared with the backfill so both write the same fields.
        update: buildEnrichmentUpdate(out),
      },
    };
  }

  private failureOp(
    articleId: string,
    message: string,
    now: Date,
  ): AnyBulkWriteOperation<NewsArticleDocument> {
    return {
      updateOne: {
        // Only while still ours: never clobber a row a later job finished.
        filter: {
          _id: new Types.ObjectId(articleId),
          tags_status: TAGGING_IN_PROGRESS,
        },
        update: {
          $set: {
            tags_status: TAGGING_FAILED,
            tagsError: message,
            updatedAt: now,
          },
          $inc: { tags_attempts: 1 },
        },
      },
    };
  }

  private chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    const step = Math.max(1, size);
    for (let i = 0; i < items.length; i += step) {
      out.push(items.slice(i, i + step));
    }
    return out;
  }

  private emptyResult(requested: number): PreProcessArticlesResult {
    return {
      requested,
      tagged: 0,
      degraded: 0,
      failed: 0,
      missing: 0,
      skipped: 0,
    };
  }
}
