/**
 * ID-array batch translation. One job carries an array of
 * articleIds (a feed's new ids, or a fanout sweep chunk). The service:
 *   1. reads source text from Mongo in ONE query,
 *   2. CLD3-detects language / splits English pass-throughs,
 *   3. chunks the non-English remainder per language at derived caps and issues
 *      direct Gemini `translateBatch` calls under a shared cockatiel policy
 *      (retry + circuit-breaker + timeout + bulkhead semaphore),
 *   4. settles ALL chunks (Promise.allSettled: a job never dies
 *      because some provider requests died),
 *   5. persists successes to the Redis scratchpad (pipelined SET) and the failed
 *      subset to Mongo in ONE bulkWrite (translation_failed, attempts++, error).
 *
 * The translated delta lives in the cache — Mongo is NOT written on the happy
 * path (the terminal database-projector flushes it later). Field names match the
 * live pipeline (`title_en_internal_only`, `description_en_internal_only`,
 * `embedding_text_source`, `translationSkipReason`). The MicroBatcher is gone —
 * chunking + Promise.allSettled + the bulkhead replace cross-job coalescing.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation } from 'mongoose';
import { Model, Types } from 'mongoose';
import {
  ArticleCacheService,
  type ArticleCacheEntry,
  TRANSLATION_PROVIDER,
  type TranslationProvider,
  type TranslateInput,
  deriveTranslationTuningFromConfig,
  buildProviderResiliencePolicy,
  DEFAULT_PROVIDER_RESILIENCE,
  LANGUAGE_DETECTOR,
  type LanguageDetector,
} from '@mera/shared';
import type { IPolicy } from 'cockatiel';
import {
  NewsArticle,
  NewsArticleDocument,
  ArticleProcessingStatus,
} from '@mera/models/models/news-article.model';

export interface TranslateBatchResult {
  requested: number;
  translated: number;
  passthrough: number;
  alreadyReady: number;
  failed: number;
  missing: number;
  /** Ids that are English-ready after this run → caller enqueues embedding. */
  successIds: string[];
}

@Injectable()
export class TranslateArticleService {
  private readonly logger = new Logger(TranslateArticleService.name);
  private readonly maxBatch: number;
  private readonly tokenBudget: number;
  private readonly policy: IPolicy;

  constructor(
    config: ConfigService,
    @Inject(TRANSLATION_PROVIDER)
    private readonly provider: TranslationProvider,
    @Inject(LANGUAGE_DETECTOR) private readonly detector: LanguageDetector,
    @InjectModel(NewsArticle.name)
    private readonly articleModel: Model<NewsArticleDocument>,
    private readonly cache: ArticleCacheService,
  ) {
    const derived = deriveTranslationTuningFromConfig(config);
    this.tokenBudget = derived.tokenBudget;
    this.maxBatch = derived.maxBatch;

    // A provider that owns its own retries, deadlines and concurrency
    // (`routed`) publishes `tuning`: the shared PROVIDER_* knobs would abort
    // its calls at 60 s and re-bill paid calls through a whole-batch retry.
    // Without `tuning` (gemini, fake) everything below is what it was.
    const tuning = provider.tuning;

    // ONE shared policy (singleton service) so the bulkhead semaphore and the
    // circuit breaker are shared across concurrently-running translate jobs.
    this.policy = buildProviderResiliencePolicy({
      concurrency: tuning?.concurrency ?? derived.maxConcurrentBatches,
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
      // TRANSLATION_CHUNK_TIMEOUT_MS is translation-only: Flex calls outlast
      // the shared 60 s PROVIDER_CHUNK_TIMEOUT_MS that embed and enrichment keep.
      timeoutMs:
        tuning?.chunkTimeoutMs ??
        Number(
          config.get(
            'TRANSLATION_CHUNK_TIMEOUT_MS',
            config.get<number>(
              'PROVIDER_CHUNK_TIMEOUT_MS',
              DEFAULT_PROVIDER_RESILIENCE.timeoutMs,
            ),
          ),
        ),
    });
  }

  async translateArticles(articleIds: string[]): Promise<TranslateBatchResult> {
    const requested = articleIds.length;
    if (requested === 0) {
      return this.emptyResult(0);
    }

    const objectIds = articleIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    const articles = await this.articleModel
      .find({ _id: { $in: objectIds } })
      .select('title description title_en_internal_only original_language_code')
      .lean();
    const byId = new Map(articles.map((a) => [a._id.toString(), a]));

    // Idempotency: skip re-paying Gemini for anything already translated in the
    // cache.
    const cached = await this.cache.getMany(articleIds);

    const now = new Date();
    const nowIso = now.toISOString();
    const successIds: string[] = [];
    const cacheWrites: ArticleCacheEntry[] = [];
    const failureOps: AnyBulkWriteOperation<NewsArticleDocument>[] = [];
    const toTranslate: TranslateInput[] = [];

    let translated = 0;
    let passthrough = 0;
    let alreadyReady = 0;
    let missing = 0;

    for (const id of articleIds) {
      const article = byId.get(id);
      if (!article) {
        missing++;
        continue;
      }

      // Already English-ready (cache translation, or a Mongo failure-record that
      // earned its translation) → forward to embedding, skip Gemini.
      if (
        cached.get(id)?.title_en_internal_only ||
        article.title_en_internal_only
      ) {
        alreadyReady++;
        successIds.push(id);
        continue;
      }

      const title = article.title ?? '';
      const description = article.description ?? '';

      // A titleless article can never be embedded: the embedding stage requires
      // English title text and otherwise drops the id as `missing`, which
      // records NOTHING in Mongo — no status, no attempt counter. Sweep A then
      // re-drives it every hour, this path resolves the same empty title again,
      // and the loop only ends when the 48h retention rule deletes the row
      // (prod 2026-09-07/09: one article, 44 consecutive cycles, every stage
      // reporting success). Terminal here, so the sweep-A attempt cap ends it.
      if (!title.trim()) {
        failureOps.push(
          this.failureOp(id, 'Translation skipped: article has no title', now),
        );
        continue;
      }

      // A short kanji-only title is under CLD3's minBytes, so the script
      // fallback reads it as `zh`; a Japanese description overrules that.
      const t = this.detector.detect(title);
      const detected =
        t === 'zh' && description && this.detector.detect(description) === 'ja'
          ? 'ja'
          : t || this.detector.detect(description) || null;

      if (detected && detected.startsWith('en')) {
        passthrough++;
        const entry: ArticleCacheEntry = {
          articleId: id,
          title_en_internal_only: title,
          description_en_internal_only: description,
          embedding_text_source: 'english_original',
          translationSkipReason: 'Article is in English',
          translationCompletedAt: nowIso,
        };
        // Self-correct a truthful label: per-article CLD3 here is far more
        // reliable than the per-batch/feed-declared code stamped at ingest
        // (e.g. an `en*` RSS feed declaration leaking onto non-English
        // articles). Only write when it actually changes something.
        if (detected !== article.original_language_code) {
          entry.original_language_code = detected;
        }
        cacheWrites.push(entry);
        successIds.push(id);
        continue;
      }

      toTranslate.push({
        id,
        title,
        description,
        sourceLang: detected ?? 'unknown',
      });
    }

    // Chunk the non-English remainder per language at derived caps, then fire
    // all chunks concurrently under the shared policy and settle ALL of them.
    const chunks = this.buildChunks(toTranslate);
    const settled = await Promise.allSettled(
      chunks.map((chunk) =>
        this.policy.execute(({ signal }) =>
          this.provider.translateBatch(chunk, signal),
        ),
      ),
    );

    settled.forEach((outcome, i) => {
      const chunk = chunks[i];
      if (outcome.status === 'rejected') {
        // Whole chunk died (network/5xx after retries, breaker open, timeout).
        // Confine the failure to this chunk's articles — the job lives on.
        const message =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        for (const item of chunk) {
          failureOps.push(
            this.failureOp(item.id, `Translation error: ${message}`, now),
          );
        }
        return;
      }

      const outputs = outcome.value;
      chunk.forEach((item, j) => {
        const out = outputs[j];
        if (!out || out.skipped || !out.title_en?.trim()) {
          // Terminal content failure (safety block / id misalignment / empty)
          // — must NOT flow downstream untranslated. An empty `title_en` from a
          // provider that reported success is the same livelock as the
          // no-title guard above, so it fails here rather than reaching the
          // embedding stage as textless work.
          failureOps.push(
            this.failureOp(
              item.id,
              `Translation skipped: ${
                out?.reason ?? (out ? 'empty title_en' : 'unknown')
              }`,
              now,
            ),
          );
          return;
        }
        translated++;
        const entry: ArticleCacheEntry = {
          articleId: item.id,
          title_en_internal_only: out.title_en,
          description_en_internal_only: out.description_en ?? '',
          embedding_text_source: 'english_translation',
          translationCompletedAt: nowIso,
        };
        // Same self-correction as the passthrough path. `item.sourceLang` is
        // the per-article CLD3 result captured when this item was queued for
        // translation ('unknown' means CLD3 itself failed — never write that).
        const article = byId.get(item.id);
        if (
          item.sourceLang !== 'unknown' &&
          item.sourceLang !== article?.original_language_code
        ) {
          entry.original_language_code = item.sourceLang;
        }
        cacheWrites.push(entry);
        successIds.push(item.id);
      });
    });

    // Persist both sides. A throw here is a whole-job fault (Redis/Mongo
    // unreachable) → BullMQ retries; the idempotency check resumes from persisted truth.
    if (cacheWrites.length > 0) {
      await this.cache.setMany(cacheWrites);
    }
    if (failureOps.length > 0) {
      await this.articleModel.bulkWrite(failureOps, { ordered: false });
    }

    const failed = failureOps.length;
    this.logger.log(
      `translate batch: requested=${requested} translated=${translated} ` +
        `passthrough=${passthrough} alreadyReady=${alreadyReady} ` +
        `failed=${failed} missing=${missing} → embed=${successIds.length}`,
    );

    return {
      requested,
      translated,
      passthrough,
      alreadyReady,
      failed,
      missing,
      successIds,
    };
  }

  /** Group by source language, then chunk each language at count/token caps. */
  private buildChunks(items: TranslateInput[]): TranslateInput[][] {
    const byLang = new Map<string, TranslateInput[]>();
    for (const item of items) {
      const arr = byLang.get(item.sourceLang) ?? [];
      arr.push(item);
      byLang.set(item.sourceLang, arr);
    }

    const chunks: TranslateInput[][] = [];
    for (const group of byLang.values()) {
      let current: TranslateInput[] = [];
      let weight = 0;
      for (const item of group) {
        const w = this.estTokens(item.title, item.description);
        if (
          current.length > 0 &&
          (current.length >= this.maxBatch || weight + w > this.tokenBudget)
        ) {
          chunks.push(current);
          current = [];
          weight = 0;
        }
        current.push(item);
        weight += w;
      }
      if (current.length > 0) chunks.push(current);
    }
    return chunks;
  }

  private failureOp(
    articleId: string,
    message: string,
    now: Date,
  ): AnyBulkWriteOperation<NewsArticleDocument> {
    return {
      updateOne: {
        filter: { _id: new Types.ObjectId(articleId) },
        update: {
          $set: {
            processingStatus: ArticleProcessingStatus.TRANSLATION_FAILED,
            translationError: message,
            translationCompletedAt: now,
            updatedAt: now,
          },
          $inc: { translation_attempts: 1 },
        },
      },
    };
  }

  private estTokens(title: string, description: string): number {
    return (
      Math.ceil(((title?.length ?? 0) + (description?.length ?? 0)) / 4) + 16
    );
  }

  private emptyResult(requested: number): TranslateBatchResult {
    return {
      requested,
      translated: 0,
      passthrough: 0,
      alreadyReady: 0,
      failed: 0,
      missing: 0,
      successIds: [],
    };
  }
}
