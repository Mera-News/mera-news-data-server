import { Processor, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { MeraWorkerHost } from '../../shared-utilities/mera-worker-host';
import { QueueName } from '@mera/shared';
import {
  GenerateEmbeddingService,
  GenerateEmbeddingBatchResult,
} from './generate-embedding.service';

export interface GenerateEmbeddingJobData {
  articleIds: string[];
}

/**
 * ID-array batch embedding. One job = a translate step's
 * successful ids or a fanout sweep-B chunk (≤250). Parallelism lives INSIDE the
 * job (chunks fire concurrently under the service's shared cockatiel bulkhead =
 * the Jina in-flight cap), so worker concurrency is low (3). No per-job
 * AbortController/timeout — a batch legitimately runs minutes; BullMQ lock
 * renewal (10 min) handles stalls and `maxQueueAgeMs=Infinity` keeps sweep
 * bursts from being discarded.
 *
 * The service settles all chunks and persists successes (cache) + failures
 * (Mongo bulkWrite) itself; this processor only enqueues the embedded ids
 * onward to the database-projector and rethrows whole-job faults for BullMQ
 * to retry.
 */
@Processor(QueueName.GENERATE_EMBEDDING_ARTICLE, {
  concurrency: 3,
  lockDuration: 600000, // 10 minutes
})
export class GenerateEmbeddingProcessor extends MeraWorkerHost {
  protected override maxQueueAgeMs = Infinity;
  private readonly logger = new Logger(GenerateEmbeddingProcessor.name);

  constructor(
    private readonly service: GenerateEmbeddingService,
    @InjectQueue(QueueName.DATABASE_PROJECTOR)
    private readonly projectorQueue: Queue,
  ) {
    super();
  }

  async processJob(
    job: Job<GenerateEmbeddingJobData, unknown, string>,
  ): Promise<GenerateEmbeddingBatchResult> {
    const articleIds = job.data?.articleIds ?? [];
    if (!Array.isArray(articleIds)) {
      throw new Error('Invalid job data: articleIds must be an array');
    }

    const result = await this.service.embedArticles(articleIds);

    if (result.successIds.length > 0) {
      await this.projectorQueue.add(
        'database-projector',
        { articleIds: result.successIds },
        { jobId: `database-projector-${job.id}-${Date.now()}` },
      );
    }

    return result;
  }
}
