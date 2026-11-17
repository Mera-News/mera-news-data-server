import { Processor, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { MeraWorkerHost } from '../../shared-utilities/mera-worker-host';
import { QueueName } from '@mera/shared';
import {
  TranslateArticleService,
  TranslateBatchResult,
} from './translate-article.service';

export interface TranslateArticleJobData {
  articleIds: string[];
}

/**
 * Code default, and the fallback when `TRANSLATE_ARTICLE_WORKER_CONCURRENCY`
 * is unparseable. This, not the provider bulkhead, is the burst ceiling:
 * load-rss-feed enqueues one small job per feed, so during the :00-:05 burst
 * roughly this many chunk calls are in flight per instance. A slower provider
 * (the `routed` OpenRouter leg) needs it raised to keep the drain time.
 */
export const DEFAULT_TRANSLATE_WORKER_CONCURRENCY = 3;

/**
 * ID-array batch translation. One job = one feed's new ids or
 * a fanout sweep chunk (≤250). Parallelism lives INSIDE the job (chunks fire
 * concurrently under the service's shared cockatiel bulkhead), so worker
 * concurrency is low (3). No per-job AbortController/timeout — a 250-id batch
 * legitimately runs minutes; BullMQ lock renewal (10 min) handles stalls and
 * `maxQueueAgeMs=Infinity` keeps sweep bursts from being discarded.
 *
 * The service settles all chunks and persists successes (cache) + failures
 * (Mongo bulkWrite) itself; this processor only enqueues the English-ready ids
 * onward to embedding and rethrows whole-job faults for BullMQ to retry.
 */
@Processor(QueueName.TRANSLATE_ARTICLE, {
  // Starting value only: overridden in onApplicationBootstrap from
  // TRANSLATE_ARTICLE_WORKER_CONCURRENCY (decorator options exist before DI).
  concurrency: DEFAULT_TRANSLATE_WORKER_CONCURRENCY,
  lockDuration: 600000, // 10 minutes
})
export class TranslateArticleProcessor
  extends MeraWorkerHost
  implements OnApplicationBootstrap
{
  protected override maxQueueAgeMs = Infinity;
  private readonly logger = new Logger(TranslateArticleProcessor.name);

  constructor(
    private readonly service: TranslateArticleService,
    @InjectQueue(QueueName.GENERATE_EMBEDDING_ARTICLE)
    private readonly embeddingQueue: Queue,
    @Optional() private readonly configService?: ConfigService,
  ) {
    super();
  }

  /**
   * Apply `TRANSLATE_ARTICLE_WORKER_CONCURRENCY` to the live worker, the same
   * way load-rss-feed applies FEED_FETCH_CONCURRENCY: `onApplicationBootstrap`
   * is the first hook where `this.worker` is assigned, BullMQ re-reads the
   * value each loop, and a bad value or an unregistered worker never throws.
   */
  onApplicationBootstrap(): void {
    const raw = this.configService?.get<number | string>(
      'TRANSLATE_ARTICLE_WORKER_CONCURRENCY',
      DEFAULT_TRANSLATE_WORKER_CONCURRENCY,
    );
    const parsed = parseInt(String(raw), 10);
    const resolved =
      Number.isNaN(parsed) || parsed < 1
        ? DEFAULT_TRANSLATE_WORKER_CONCURRENCY
        : parsed;
    try {
      this.worker.concurrency = resolved;
      this.logger.log(`translate-article worker concurrency = ${resolved}`);
    } catch (error) {
      this.logger.warn(
        `Could not apply translate-article concurrency ${resolved}; worker ` +
          `not registered (${
            error instanceof Error ? error.message : String(error)
          }). Falling back to the decorator value.`,
      );
    }
  }

  async processJob(
    job: Job<TranslateArticleJobData, unknown, string>,
  ): Promise<TranslateBatchResult> {
    const articleIds = job.data?.articleIds ?? [];
    if (!Array.isArray(articleIds)) {
      throw new Error('Invalid job data: articleIds must be an array');
    }

    const result = await this.service.translateArticles(articleIds);

    if (result.successIds.length > 0) {
      await this.embeddingQueue.add(
        'generate-embedding-article',
        { articleIds: result.successIds },
        { jobId: `generate-embedding-article-${job.id}-${Date.now()}` },
      );
    }

    return result;
  }
}
