import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MeraWorkerHost } from '../../shared-utilities/mera-worker-host';
import { QueueName } from '@mera/shared';
import {
  DatabaseProjectorService,
  DatabaseProjectorResult,
} from './database-projector.service';

export interface DatabaseProjectorJobData {
  articleIds: string[];
}

/**
 * `database-projector` processor — the terminal step. Fed
 * by generate-embedding-article with the ids whose full delta now lives in the
 * scratchpad. It flushes them to Mongo in ONE bulkWrite and DELetes the
 * confirmed keys. Concurrency 2 (bulkWrites are cheap; low fan-in), no per-job
 * timeout, `maxQueueAgeMs=Infinity`. Idempotent: a re-run re-projects the same
 * `$set` and clears any keys a prior crash left behind.
 */
@Processor(QueueName.DATABASE_PROJECTOR, {
  concurrency: 2,
  lockDuration: 600000, // 10 minutes
})
export class DatabaseProjectorProcessor extends MeraWorkerHost {
  protected override maxQueueAgeMs = Infinity;
  private readonly logger = new Logger(DatabaseProjectorProcessor.name);

  constructor(private readonly service: DatabaseProjectorService) {
    super();
  }

  async processJob(
    job: Job<DatabaseProjectorJobData, unknown, string>,
  ): Promise<DatabaseProjectorResult> {
    const articleIds = job.data?.articleIds ?? [];
    if (!Array.isArray(articleIds)) {
      throw new Error('Invalid job data: articleIds must be an array');
    }
    return this.service.projectArticles(articleIds);
  }
}
