import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MeraWorkerHost } from '../../shared-utilities/mera-worker-host';
import { QueueName } from '@mera/shared';
import {
  PreProcessArticlesService,
  PreProcessArticlesResult,
} from './pre-process-articles.service';

export interface PreProcessArticlesJobData {
  articleIds: string[];
}

/**
 * `pre-process-articles` worker — processes one fanout chunk (≤FANOUT_CHUNK_SIZE ids).
 * Parallelism lives INSIDE the job (sub-batches fire concurrently under the
 * service's shared cockatiel bulkhead), so worker concurrency is low (3). No
 * per-job AbortController/timeout — a full chunk legitimately runs minutes;
 * BullMQ lock renewal (10 min) handles stalls and `maxQueueAgeMs=Infinity` keeps
 * fanout bursts from being discarded.
 */
@Processor(QueueName.PRE_PROCESS_ARTICLES, {
  concurrency: 3,
  lockDuration: 600000, // 10 minutes
})
export class PreProcessArticlesProcessor extends MeraWorkerHost {
  protected override maxQueueAgeMs = Infinity;
  private readonly logger = new Logger(PreProcessArticlesProcessor.name);

  constructor(private readonly service: PreProcessArticlesService) {
    super();
  }

  async processJob(
    job: Job<PreProcessArticlesJobData, unknown, string>,
  ): Promise<PreProcessArticlesResult> {
    const articleIds = job.data?.articleIds ?? [];
    if (!Array.isArray(articleIds)) {
      throw new Error('Invalid job data: articleIds must be an array');
    }
    return this.service.preProcessArticles(articleIds);
  }
}
