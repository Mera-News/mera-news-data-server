/**
 * `database-projector` — the terminal step of the ID-array ingestion pipeline
 * It is the ONLY happy-path Mongo write after ingestion.
 *
 *   1. MGET the Redis scratchpad for the accumulated per-article delta
 *      (English text + both vectors + stamps),
 *   2. flush the complete entries to Mongo in ONE `bulkWrite` (full delta +
 *      `processingStatus` + `*CompletedAt` stamps),
 *   3. DEL ONLY the keys whose write the bulkWrite confirmed —
 *      unconfirmed ids keep their cache entry (TTL-bounded) and the job retries
 *      them; a crash between bulkWrite and DEL just re-projects idempotently
 *      (same `$set`).
 *
 * Collapsing the pipeline's per-article `updateOne`s into this single bulk
 * projection is the whole point of the refactor (~100× fewer Mongo write ops on
 * the happy path).
 *
 * Enrich on ingest (`PREPROCESS_ON_INGEST_ENABLED`, default off): the same
 * bulkWrite also stamps `tags_status: TAGGING_ENQUEUED` + `tags_enqueued_at`
 * on rows that have no `tags_status` yet (a conditional pipeline update, no
 * extra write), and the ids it marked are handed to `pre-process-articles`.
 * All of that is fire-and-forget: a failed read-back or enqueue is counted and
 * logged, never thrown, so enrichment can never fail or delay projection. A
 * row marked but never enqueued is re-claimed by the fanout's stale sweep.
 *
 * Story keys: each projection also stores the text-matching sign bits, and the
 * confirmed ids are handed to `StoryKeyIndexService.submit` last, unawaited, so
 * story keys can never fail or delay projection, the DEL or the enrichment
 * enqueue. `story_key` is therefore NOT written by the projection op: the index
 * service writes it afterwards in its own guarded fire-and-forget bulkWrite
 * (pipeline `$ifNull`, write-once). An article is projected but keyless for a
 * few seconds (longer if that write fails, until the next boot backfill);
 * clustering runs at :10, so nothing reads a keyless row in practice.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { AnyBulkWriteOperation, Model, Types } from 'mongoose';
import {
  NewsArticle,
  NewsArticleDocument,
  ArticleProcessingStatus,
} from '@mera/models/models/news-article.model';
import {
  TopicArticleLink,
  TopicArticleLinkDocument,
} from '@mera/models/models/topic-article-link.model';
import {
  ArticleCacheService,
  JobLogger,
  QueueName,
  type ArticleCacheEntry,
} from '@mera/shared';
import { packSignBits } from '@mera/shared/vector/pack-sign-bits';
import { TAGGING_ENQUEUED } from '../processor-pre-process-articles-fanout/pre-process-articles-fanout.service';
import { StoryKeyIndexService } from './story-key-index.service';
import { enTextChars } from './story-key.config';

export interface DatabaseProjectorResult {
  requested: number;
  projected: number;
  /** Ids whose cache entry was incomplete (missing vectors/text) → left for retry. */
  incomplete: number;
  /** Ids absent from the cache (already projected + DELeted, or never written). */
  missing: number;
  /** Ids whose write Mongo confirmed and whose cache key was DELeted. */
  confirmed: number;
  /** Ids stamped TAGGING_ENQUEUED and queued for enrichment (flag on only). */
  enrichEnqueued?: number;
}

/** A bulkWrite op paired with the articleId it targets (for confirm/DEL). */
interface ProjectionOp {
  id: string;
  op: AnyBulkWriteOperation<NewsArticleDocument>;
}

@Injectable()
export class DatabaseProjectorService {
  private readonly logger = new Logger(DatabaseProjectorService.name);
  private readonly jobLogger: JobLogger;
  private readonly enrichOnIngest: boolean;
  private readonly chunkSize: number;

  constructor(
    @InjectModel(NewsArticle.name)
    private readonly articleModel: Model<NewsArticleDocument>,
    private readonly cache: ArticleCacheService,
    config: ConfigService,
    @InjectQueue(QueueName.PRE_PROCESS_ARTICLES)
    private readonly preProcessQueue: Queue,
    private readonly storyKeys: StoryKeyIndexService,
    @InjectModel(TopicArticleLink.name)
    private readonly linkModel: Model<TopicArticleLinkDocument>,
  ) {
    this.enrichOnIngest =
      String(
        config.get<string | boolean>('PREPROCESS_ON_INGEST_ENABLED', false),
      ).toLowerCase() === 'true';
    const chunk = Number(config.get<string | number>('FANOUT_CHUNK_SIZE'));
    this.chunkSize = Number.isInteger(chunk) && chunk > 0 ? chunk : 250;
    this.jobLogger = new JobLogger({
      job: 'database-projector',
      level: JobLogger.parseLevel(config.get<string>('LOG_LEVEL')),
    });
  }

  async projectArticles(
    articleIds: string[],
  ): Promise<DatabaseProjectorResult> {
    const requested = articleIds.length;
    if (requested === 0) {
      return this.emptyResult(0);
    }

    const cached = await this.cache.getMany(articleIds);

    // One stamp per run: it is both the claim time and the marker that tells
    // this run's marked rows apart from rows an earlier run marked.
    const markAt = this.enrichOnIngest ? new Date() : null;
    const projectionOps: ProjectionOp[] = [];
    const tmBitsById = new Map<string, Buffer>();
    const textCharsById = new Map<string, number>();
    let incomplete = 0;
    let missing = 0;

    for (const id of articleIds) {
      const entry = cached.get(id);
      if (!entry) {
        // Already projected + DELeted (idempotent re-run) or never written.
        missing++;
        continue;
      }
      if (!this.isComplete(entry)) {
        // Missing text or a vector — cannot project. Leave the cache entry
        // (TTL-bounded); the grace sweep re-drives it.
        incomplete++;
        continue;
      }
      const tmBits = packSignBits(entry.textMatchingVector as number[]);
      tmBitsById.set(id, tmBits);
      textCharsById.set(
        id,
        enTextChars(
          entry.title_en_internal_only,
          entry.description_en_internal_only,
        ),
      );
      projectionOps.push({
        id,
        op: this.projectionOp(id, entry, tmBits, markAt),
      });
    }

    let confirmed = 0;
    let enrichEnqueued: number | undefined;
    if (projectionOps.length > 0) {
      const confirmedIds = await this.flush(projectionOps);
      confirmed = confirmedIds.length;
      // DEL only the keys the bulkWrite confirmed.
      if (confirmedIds.length > 0) {
        await this.cache.delMany(confirmedIds);
      }
      if (markAt && confirmedIds.length > 0) {
        enrichEnqueued = await this.enqueueMarked(confirmedIds, markAt);
      }
      this.writeCanonicalLinks(confirmedIds, cached);
      this.storyKeys.submit(
        confirmedIds.map((id) => ({
          id,
          tmBits: tmBitsById.get(id) ?? null,
          textChars: textCharsById.get(id) ?? 0,
        })),
      );
    }

    const result: DatabaseProjectorResult = {
      requested,
      projected: projectionOps.length,
      incomplete,
      missing,
      confirmed,
      ...(enrichEnqueued !== undefined ? { enrichEnqueued } : {}),
    };
    this.logger.log(
      `project batch: requested=${requested} projected=${result.projected} ` +
        `confirmed=${confirmed} incomplete=${incomplete} missing=${missing}`,
    );
    return result;
  }

  /**
   * Run the bulkWrite (ordered:false, strict:false so the schemaless
   * text-matching vector persists) and return the ids Mongo confirmed. A pure
   * write-error (per-op) confines the failure to those ids; any other error is a
   * whole-job fault and rethrows for BullMQ to retry.
   */
  private async flush(projectionOps: ProjectionOp[]): Promise<string[]> {
    const ops = projectionOps.map((p) => p.op);
    try {
      await this.articleModel.bulkWrite(ops, {
        ordered: false,
        strict: false,
      });
      // No throw → every op applied.
      return projectionOps.map((p) => p.id);
    } catch (error) {
      const writeErrors =
        (
          error as {
            writeErrors?: Array<{ index?: number; err?: { index?: number } }>;
          }
        )?.writeErrors ?? [];
      // Not a per-op bulk write error (e.g. connection lost) → whole-job fault.
      if (writeErrors.length === 0) {
        throw error;
      }
      const failedIdx = new Set(
        writeErrors.map((e) => e.index ?? e.err?.index),
      );
      const confirmed = projectionOps
        .filter((_, i) => !failedIdx.has(i))
        .map((p) => p.id);
      this.logger.warn(
        `projector bulkWrite had ${writeErrors.length} write errors; ` +
          `confirmed ${confirmed.length}/${projectionOps.length}`,
      );
      return confirmed;
    }
  }

  /**
   * Fire-and-forget: one unordered bulkWrite of canonical link upserts for the
   * confirmed ids. `$setOnInsert` keeps a replay idempotent. Never awaited, so
   * projection cannot wait on it; a failure is logged with a count.
   */
  private writeCanonicalLinks(
    confirmedIds: string[],
    cached: Map<string, ArticleCacheEntry>,
  ): void {
    const ops: AnyBulkWriteOperation<TopicArticleLinkDocument>[] = [];
    for (const id of confirmedIds) {
      for (const l of cached.get(id)?.canonical_links ?? []) {
        ops.push({
          updateOne: {
            filter: {
              topicId: new Types.ObjectId(l.topicId),
              articleId: new Types.ObjectId(id),
            },
            update: {
              $setOnInsert: {
                confidence: l.confidence,
                canonical: true,
                createdAt: new Date(),
              },
            },
            upsert: true,
          },
        });
      }
    }
    if (ops.length === 0) return;
    // try/catch covers a synchronous throw from the model; .catch the async one.
    try {
      void this.linkModel
        .bulkWrite(ops, { ordered: false })
        .catch((err: Error) => this.logLinkFailure(ops.length, err));
    } catch (err) {
      this.logLinkFailure(ops.length, err as Error);
    }
  }

  private logLinkFailure(count: number, err: Error): void {
    this.jobLogger.warn('canonical_link_write_failed', {
      count,
      error: err.message,
    });
  }

  /** A cache entry is projectable only once it carries text AND both vectors. */
  private isComplete(entry: ArticleCacheEntry): boolean {
    return Boolean(
      entry.title_en_internal_only &&
      entry.retrievalVector &&
      entry.retrievalVector.length > 0 &&
      entry.textMatchingVector &&
      entry.textMatchingVector.length > 0,
    );
  }

  /**
   * Read back which confirmed ids THIS run marked (`tags_enqueued_at ===
   * markAt`, `_id` projection only) and queue them in FANOUT_CHUNK_SIZE jobs.
   * Never throws: a failure is counted and logged, and the rows stay
   * TAGGING_ENQUEUED for the fanout's stale sweep to re-claim.
   */
  private async enqueueMarked(ids: string[], markAt: Date): Promise<number> {
    let marked: string[];
    try {
      const docs = await this.articleModel
        .find(
          {
            _id: { $in: ids.map((id) => new Types.ObjectId(id)) },
            tags_status: TAGGING_ENQUEUED,
            tags_enqueued_at: markAt,
          },
          { _id: 1 },
        )
        .lean();
      marked = docs.map((d) => d._id.toString());
    } catch (err) {
      this.jobLogger.warn('pre_process_ingest_enqueue_failed', {
        stage: 'read_marked',
        ids: ids.length,
        error: (err as Error).message,
      });
      return 0;
    }

    let enqueued = 0;
    let failedChunks = 0;
    for (let i = 0; i < marked.length; i += this.chunkSize) {
      const chunk = marked.slice(i, i + this.chunkSize);
      try {
        await this.preProcessQueue.add(
          'pre-process-articles',
          { articleIds: chunk },
          {
            // Unique per chunk: an id is marked once, so its first id plus
            // the run stamp can never repeat, and BullMQ never silently
            // drops a chunk as a duplicate jobId.
            jobId: `ingest-preprocess-${chunk[0]}-${markAt.getTime()}`,
            // The fanout's stale sweep is the retry; a BullMQ retry would
            // re-bill an enrichment call that already succeeded.
            attempts: 1,
          },
        );
        enqueued += chunk.length;
      } catch (err) {
        failedChunks++;
        this.jobLogger.warn('pre_process_ingest_enqueue_failed', {
          stage: 'enqueue',
          ids: chunk.length,
          error: (err as Error).message,
        });
      }
    }
    this.jobLogger.info('pre_process_ingest_enqueue', {
      confirmed: ids.length,
      marked: marked.length,
      enqueued,
      failedChunks,
    });
    return enqueued;
  }

  private projectionOp(
    id: string,
    entry: ArticleCacheEntry,
    tmBits: Buffer,
    markAt: Date | null = null,
  ): AnyBulkWriteOperation<NewsArticleDocument> {
    const set: Record<string, unknown> = {
      title_en_internal_only: entry.title_en_internal_only,
      description_en_internal_only: entry.description_en_internal_only ?? '',
      embedding_article_data_retrieval: entry.retrievalVector,
      // Prod ground-truth field name (NO `_internal_only` suffix — that variant
      // is v3 drift). Undeclared on the schema → strict:false persists it.
      // Agent B's Python clustering job reads this exact field.
      embedding_article_data_text_matching: entry.textMatchingVector,
      // Near-copy signal for the story-key index rebuild (select:false).
      vector_sidecar_tm_packed: tmBits,
      processingStatus: ArticleProcessingStatus.EMBEDDING_SUCCESSFUL,
      updatedAt: new Date(),
    };
    if (entry.vectorSidecarPacked) {
      // Buffer at rest (~33% smaller than base64 String) — see
      // NewsArticle.vector_sidecar_packed for the full rationale. The cache
      // entry already carries it base64-encoded (it was already binary
      // bytes; no Float32 codec needed), so this is a plain decode.
      set.vector_sidecar_packed = Buffer.from(
        entry.vectorSidecarPacked,
        'base64',
      );
    }
    if (entry.embedding_text_source) {
      set.embedding_text_source = entry.embedding_text_source;
    }
    if (entry.translationSkipReason) {
      set.translationSkipReason = entry.translationSkipReason;
    }
    if (entry.translationCompletedAt) {
      set.translationCompletedAt = new Date(entry.translationCompletedAt);
    }
    if (entry.embeddingCompletedAt) {
      set.embeddingCompletedAt = new Date(entry.embeddingCompletedAt);
    }
    if (entry.original_language_code) {
      // The per-article CLD3 self-correction from translate-article
      // overrides the (possibly wrong) per-batch/feed-declared code stamped
      // on the article at ingest.
      set.original_language_code = entry.original_language_code;
    }
    if (!markAt) {
      return {
        updateOne: {
          filter: { _id: new Types.ObjectId(id) },
          update: { $set: set },
        },
      };
    }
    // Enrich on ingest: the same write as a one-stage pipeline update, so the
    // ENQUEUED marker lands only where tags_status is missing. Every projected
    // value is wrapped in $literal because a pipeline $set evaluates
    // expressions: an English title starting with "$" would otherwise be read
    // as a field path.
    const literal: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(set)) literal[k] = { $literal: v };
    const unmarked = { $eq: [{ $type: '$tags_status' }, 'missing'] };
    return {
      updateOne: {
        filter: { _id: new Types.ObjectId(id) },
        update: [
          {
            $set: {
              ...literal,
              tags_status: {
                $cond: [unmarked, TAGGING_ENQUEUED, '$tags_status'],
              },
              tags_enqueued_at: {
                $cond: [unmarked, markAt, '$tags_enqueued_at'],
              },
            },
          },
        ],
      },
    } as AnyBulkWriteOperation<NewsArticleDocument>;
  }

  private emptyResult(requested: number): DatabaseProjectorResult {
    return { requested, projected: 0, incomplete: 0, missing: 0, confirmed: 0 };
  }
}
