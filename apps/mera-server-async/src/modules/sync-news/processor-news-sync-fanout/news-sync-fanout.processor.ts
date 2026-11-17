import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MeraWorkerHost } from '../../shared-utilities/mera-worker-host';
import { QueueName } from '@mera/shared';
import {
  NewsSyncFanoutService,
  NewsSyncFanoutResult,
} from './news-sync-fanout.service';

/**
 * `news-sync-fanout` processor — fired by the `:00` Cloud Scheduler cron via
 * `/invoke {queue_name: news-sync-fanout}`. Single-concurrency (one fan-out at a
 * time), no per-job timeout, `maxQueueAgeMs=Infinity` (the sweep queries are the
 * freshness authority, not queue age).
 */
@Processor(QueueName.NEWS_SYNC_FANOUT, {
  concurrency: 1,
  lockDuration: 600000, // 10 minutes
})
export class NewsSyncFanoutProcessor extends MeraWorkerHost {
  protected override maxQueueAgeMs = Infinity;
  private readonly logger = new Logger(NewsSyncFanoutProcessor.name);

  constructor(private readonly service: NewsSyncFanoutService) {
    super();
  }

  async processJob(job: Job): Promise<NewsSyncFanoutResult> {
    this.logger.log(`Running news-sync-fanout (job ${job.id})`);
    return this.service.runFanout();
  }
}
