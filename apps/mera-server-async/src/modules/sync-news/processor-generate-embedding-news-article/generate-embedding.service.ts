/**
 * ID-array batch embedding. One job carries an array of
 * articleIds (a translate step's successful ids, or a fanout sweep-B chunk). The
 * service:
 *   1. MGETs the Redis scratchpad for the translated delta (title_en/desc_en +
 *      embedding_text_source), falling back to Mongo failure-records for
 *      re-drives (an embedding failure persists its translation),
 *   2. reads Mongo ONCE for publicationSourceId (retrieval enrichment) and the
 *      idempotency check (a present retrieval vector = already projected → drop),
 *   3. chunks at Jina caps and issues direct `provider.embed` calls (retrieval +
 *      text-matching) per chunk under a shared cockatiel policy,
 *   4. settles ALL chunks (Promise.allSettled: a job never dies
 *      because some provider requests died),
 *   5. persists successes to the scratchpad (delta + both vectors) and the failed
 *      subset to Mongo in ONE bulkWrite (embedding_failed, attempts++, error,
 *      PLUS the translated text so the re-drive skips Gemini).
 *
 * Vectors live in the cache — Mongo is NOT written on the happy path (the
 * terminal database-projector flushes both vectors + the English text in ONE
 * bulkWrite). The MicroBatcher is gone — chunking + Promise.allSettled + the
 * cockatiel bulkhead replace cross-job coalescing.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { Cache } from 'cache-manager';
import { InjectModel } from '@nestjs/mongoose';
import { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import {
  NewsArticle,
  NewsArticleDocument,
  ArticleProcessingStatus,
} from '@mera/models/models/news-article.model';
import {
  PublicationSource,
  PublicationSourceDocument,
} from '@mera/models/models/publication-source.model';
import {
  CountryCodeMapper,
  buildArticleData,
  EMBEDDING_PROVIDER,
  type EmbeddingProvider,
  ArticleCacheService,
  type ArticleCacheEntry,
  buildProviderResiliencePolicy,
  DEFAULT_PROVIDER_RESILIENCE,
} from '@mera/shared';
import { packSignBits } from '@mera/shared/vector/pack-sign-bits';
import { isCalibratedEmbedding } from '@mera/shared/embedding-provider/embedding-config';
import { classifyCanonical } from '@mera/shared/enrichment/category-tree';
import type { IPolicy } from 'cockatiel';
import { CanonicalTopicIndex } from './canonical-topic-index.service';

const PUB_SOURCE_CACHE_PREFIX = 'pub-source-info:';
const PUB_SOURCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface PublicationSourceInfo {
  countryName: string | null;
  category: string | null;
}

export interface GenerateEmbeddingBatchResult {
  requested: number;
  embedded: number;
  alreadyEmbedded: number;
  failed: number;
  missing: number;
  /** Ids embedded this run → caller enqueues database-projector. */
  successIds: string[];
}

/** A single article resolved to its English text + enrichment, ready to embed. */
interface EmbedCandidate {
  id: string;
  titleEn: string;
  descriptionEn: string;
  source: 'english_original' | 'english_translation';
  retrievalText: string;
  matchingText: string;
  /** The translation delta already in the cache (carried through untouched). */
  cacheEntry?: ArticleCacheEntry;
}

@Injectable()
export class GenerateEmbeddingService {
  private readonly logger = new Logger(GenerateEmbeddingService.name);
  private readonly maxBatch: number;
  private readonly policy: IPolicy;
  private readonly calibrated: boolean;

  constructor(
    @InjectModel(NewsArticle.name)
    private newsArticleModel: Model<NewsArticleDocument>,
    @InjectModel(PublicationSource.name)
    private publicationSourceModel: Model<PublicationSourceDocument>,
    @Inject(EMBEDDING_PROVIDER) private readonly provider: EmbeddingProvider,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
    private readonly cache: ArticleCacheService,
    config: ConfigService,
    private readonly canonicalIndex: CanonicalTopicIndex,
  ) {
    this.calibrated = isCalibratedEmbedding(config);
    this.maxBatch = config.get<number>('JINA_BATCH_TEXTS', 500);
    const maxInflight = config.get<number>('JINA_MAX_INFLIGHT', 3);

    // ONE shared policy (singleton service) so the bulkhead semaphore and the
    // circuit breaker are shared across concurrently-running embed jobs. The
    // bulkhead width IS the Jina in-flight cap.
    this.policy = buildProviderResiliencePolicy({
      concurrency: maxInflight,
      retryAttempts: config.get<number>(
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
      timeoutMs: config.get<number>(
        'PROVIDER_CHUNK_TIMEOUT_MS',
        DEFAULT_PROVIDER_RESILIENCE.timeoutMs,
      ),
    });
  }

  /**
   * Build the article_data string for embedding — delegates to the shared
   * v1-parity builder so retrieval (with country+category) and text-matching
   * (metadata-free) inputs are byte-identical to what v1 embeds today.
   */
  static buildArticleData(
    titleEn: string,
    descriptionEn: string | null | undefined,
    countryName: string | null | undefined,
    category: string | null | undefined,
  ): string {
    return buildArticleData(titleEn, descriptionEn, countryName, category);
  }

  async embedArticles(
    articleIds: string[],
  ): Promise<GenerateEmbeddingBatchResult> {
    const requested = articleIds.length;
    if (requested === 0) {
      return this.emptyResult(0);
    }

    const objectIds = articleIds
      .filter((id) => Types.ObjectId.isValid(id))
      .map((id) => new Types.ObjectId(id));

    // One Mongo read: publicationSourceId (enrichment), the failure-record text
    // fallback, and the idempotency vector.
    const articles = await this.newsArticleModel
      .find({ _id: { $in: objectIds } })
      .select(
        '+embedding_article_data_retrieval publicationSourceId title ' +
          'title_en_internal_only description_en_internal_only embedding_text_source',
      )
      .lean();
    const byId = new Map(articles.map((a) => [a._id.toString(), a]));

    // MGET the translated delta from the scratchpad (the happy-path source).
    const cached = await this.cache.getMany(articleIds);

    const now = new Date();
    const nowIso = now.toISOString();
    const successIds: string[] = [];
    const cacheWrites: ArticleCacheEntry[] = [];
    const failureOps: AnyBulkWriteOperation<NewsArticleDocument>[] = [];
    const candidates: EmbedCandidate[] = [];

    let alreadyEmbedded = 0;
    let missing = 0;

    for (const id of articleIds) {
      const doc = byId.get(id);
      if (!doc) {
        missing++;
        continue;
      }

      // Idempotency: a present retrieval vector means the article
      // was already embedded AND projected → drop the id entirely.
      if (
        doc.embedding_article_data_retrieval &&
        doc.embedding_article_data_retrieval.length > 0
      ) {
        alreadyEmbedded++;
        continue;
      }

      const cacheEntry = cached.get(id);
      const titleEn =
        cacheEntry?.title_en_internal_only ?? doc.title_en_internal_only;
      if (!titleEn) {
        // No English text anywhere — cannot embed. This used to count as
        // `missing`, which writes NOTHING to Mongo and leaves the id to the
        // translate re-drive; idempotent is exactly the problem, because for a
        // textless article that re-drive is deterministic and loops hourly
        // until retention deletes the row. Record a terminal failure so the
        // sweep-B attempt cap can end it. `missing` now means only what it
        // says: the article is not in Mongo at all.
        failureOps.push(this.noTextFailureOp(id, now));
        continue;
      }
      const descriptionEn =
        cacheEntry?.description_en_internal_only ??
        doc.description_en_internal_only ??
        '';
      const source: 'english_original' | 'english_translation' =
        cacheEntry?.embedding_text_source ??
        doc.embedding_text_source ??
        (titleEn === doc.title ? 'english_original' : 'english_translation');

      const { countryName, category } = await this.getPublicationSourceInfo(
        doc.publicationSourceId?.toString(),
      );

      candidates.push({
        id,
        titleEn,
        descriptionEn,
        source,
        // retrieval: metadata-enriched (country + category); text-matching:
        // metadata-free (clustering matches by content, not geography).
        retrievalText: buildArticleData(
          titleEn,
          descriptionEn,
          countryName,
          category,
        ),
        matchingText: buildArticleData(titleEn, descriptionEn, null, null),
        cacheEntry,
      });
    }

    // Chunk at the Jina batch cap; fire all chunks concurrently under the shared
    // policy and settle ALL of them.
    const chunks = this.chunk(candidates);
    const settled = await Promise.allSettled(
      chunks.map((chunk) => this.embedChunk(chunk)),
    );

    const canonicalIndex = await this.canonicalIndex.get();
    let categorized = 0;
    let embedded = 0;
    settled.forEach((outcome, i) => {
      const chunk = chunks[i];
      if (outcome.status === 'rejected') {
        // Whole chunk died (network/5xx after retries, breaker open, timeout).
        // Confine the failure to this chunk's articles — the job lives on, and
        // the translated text rides along so the re-drive skips Gemini.
        const message =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        for (const cand of chunk) {
          failureOps.push(this.failureOp(cand, message, now));
        }
        return;
      }

      const { retrieval, matching } = outcome.value;
      chunk.forEach((cand, j) => {
        embedded++;
        // Packed sign-bit sidecar of the retrieval vector, computed here at
        // embedding time (not per request) — see packSignBits for the
        // MSB-first bit-order contract the on-device client must reproduce.
        // The sidecar and the canonical links are both tuned on the Jina
        // model (the client's Hamming bar, the canonical topic vectors), so
        // another model gets neither.
        const vectorSidecarPacked = this.calibrated
          ? packSignBits(retrieval[j]).toString('base64')
          : undefined;
        const links = this.calibrated
          ? classifyCanonical(matching[j], canonicalIndex)
          : [];
        if (links.length > 0) categorized++;
        cacheWrites.push({
          // Carry the translation delta through untouched, add both vectors.
          articleId: cand.id,
          title_en_internal_only: cand.titleEn,
          description_en_internal_only: cand.descriptionEn,
          embedding_text_source: cand.source,
          translationSkipReason: cand.cacheEntry?.translationSkipReason,
          translationCompletedAt: cand.cacheEntry?.translationCompletedAt,
          // Carry the translate step's language-label self-correction
          // through untouched — setMany is a full overwrite per key,
          // so anything not re-listed here is silently dropped.
          original_language_code: cand.cacheEntry?.original_language_code,
          retrievalVector: retrieval[j],
          textMatchingVector: matching[j],
          vectorSidecarPacked,
          embeddingCompletedAt: nowIso,
          ...(links.length > 0 ? { canonical_links: links } : {}),
        });
        successIds.push(cand.id);
      });
    });

    // Persist both sides. A throw here is a whole-job fault (Redis/Mongo
    // unreachable) → BullMQ retries; the idempotency check resumes from persisted truth.
    if (cacheWrites.length > 0) {
      await this.cache.setMany(cacheWrites);
    }
    if (failureOps.length > 0) {
      await this.newsArticleModel.bulkWrite(failureOps, { ordered: false });
    }

    const failed = failureOps.length;
    this.logger.log(
      `embed batch: requested=${requested} embedded=${embedded} ` +
        `alreadyEmbedded=${alreadyEmbedded} failed=${failed} ` +
        `categorized=${categorized} missing=${missing} → project=${successIds.length}`,
    );

    return {
      requested,
      embedded,
      alreadyEmbedded,
      failed,
      missing,
      successIds,
    };
  }

  /** Embed one chunk's retrieval + text-matching inputs under the shared policy. */
  private async embedChunk(
    chunk: EmbedCandidate[],
  ): Promise<{ retrieval: number[][]; matching: number[][] }> {
    const retrievalTexts = chunk.map((c) => c.retrievalText);
    const matchingTexts = chunk.map((c) => c.matchingText);
    const [retrieval, matching] = await Promise.all([
      this.policy.execute(({ signal }) =>
        this.provider.embed(retrievalTexts, 'retrieval.passage', signal),
      ),
      this.policy.execute(({ signal }) =>
        this.provider.embed(matchingTexts, 'text-matching', signal),
      ),
    ]);
    return { retrieval, matching };
  }

  private chunk(candidates: EmbedCandidate[]): EmbedCandidate[][] {
    const chunks: EmbedCandidate[][] = [];
    for (let i = 0; i < candidates.length; i += this.maxBatch) {
      chunks.push(candidates.slice(i, i + this.maxBatch));
    }
    return chunks;
  }

  /**
   * Failure op for an article with no English text anywhere. Unlike
   * `failureOp` there is no paid translation to preserve, so this writes no
   * text — only the terminal status and the attempt counter that lets sweep B
   * stop re-driving it. Writing an empty `title_en_internal_only` instead would
   * silence the sweeps by making the article look translated, which is a worse
   * lie than a recorded failure.
   */
  private noTextFailureOp(
    id: string,
    now: Date,
  ): AnyBulkWriteOperation<NewsArticleDocument> {
    return {
      updateOne: {
        filter: { _id: new Types.ObjectId(id) },
        update: {
          $set: {
            processingStatus: ArticleProcessingStatus.EMBEDDING_FAILED,
            embeddingError: 'Embedding error: no English text to embed',
            updatedAt: now,
          },
          $inc: { embedding_attempts: 1 },
        },
      },
    };
  }

  private failureOp(
    cand: EmbedCandidate,
    message: string,
    now: Date,
  ): AnyBulkWriteOperation<NewsArticleDocument> {
    return {
      updateOne: {
        filter: { _id: new Types.ObjectId(cand.id) },
        update: {
          $set: {
            processingStatus: ArticleProcessingStatus.EMBEDDING_FAILED,
            embeddingError: `Embedding error: ${message}`,
            // Paid translation is never lost: persist it with the
            // failure so the next re-drive skips Gemini and only re-embeds.
            title_en_internal_only: cand.titleEn,
            description_en_internal_only: cand.descriptionEn,
            embedding_text_source: cand.source,
            embeddingCompletedAt: now,
            updatedAt: now,
          },
          $inc: { embedding_attempts: 1 },
        },
      },
    };
  }

  private emptyResult(requested: number): GenerateEmbeddingBatchResult {
    return {
      requested,
      embedded: 0,
      alreadyEmbedded: 0,
      failed: 0,
      missing: 0,
      successIds: [],
    };
  }

  /**
   * Look up country name and category for a publication source, with Redis caching.
   */
  async getPublicationSourceInfo(
    publicationSourceId: string | undefined,
  ): Promise<PublicationSourceInfo> {
    if (!publicationSourceId) return { countryName: null, category: null };

    const cacheKey = `${PUB_SOURCE_CACHE_PREFIX}${publicationSourceId}`;

    try {
      const cached =
        await this.cacheManager.get<PublicationSourceInfo>(cacheKey);
      if (cached !== undefined && cached !== null) {
        return cached;
      }

      const pubSource = await this.publicationSourceModel
        .findById(publicationSourceId)
        .select('country_name country_code category')
        .lean();

      const countryName = pubSource
        ? pubSource.country_name ||
          CountryCodeMapper.getCountryName(pubSource.country_code)
        : null;

      const category = pubSource?.category || null;

      const info: PublicationSourceInfo = { countryName, category };

      if (countryName || category) {
        await this.cacheManager.set(cacheKey, info, PUB_SOURCE_CACHE_TTL_MS);
      }

      return info;
    } catch (error) {
      this.logger.warn(
        `Failed to look up publication source ${publicationSourceId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { countryName: null, category: null };
    }
  }
}
