import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { MeraWorkerHost } from '../../shared-utilities/mera-worker-host';
import { QueueName } from '@mera/shared';
import {
  PreProcessArticlesFanoutService,
  PreProcessFanoutResult,
} from './pre-process-articles-fanout.service';

/**
 * `pre-process-articles-fanout` processor — fired by a scheduler via
 * `/invoke {queue_name: pre-process-articles-fanout}`. Single-concurrency (one fan-out at
 * a time), no per-job timeout, `maxQueueAgeMs=Infinity` (the claim queries are
 * the freshness authority, not queue age).
 */
@Processor(QueueName.PRE_PROCESS_ARTICLES_FANOUT, {
  concurrency: 1,
  lockDuration: 600000, // 10 minutes
})
export class PreProcessArticlesFanoutProcessor extends MeraWorkerHost {
  protected override maxQueueAgeMs = Infinity;
  private readonly logger = new Logger(PreProcessArticlesFanoutProcessor.name);

  constructor(private readonly service: PreProcessArticlesFanoutService) {
    super();
  }

  async processJob(job: Job): Promise<PreProcessFanoutResult> {
    this.logger.log(`Running pre-process-articles-fanout (job ${job.id})`);
    return this.service.runPreProcessFanout();
  }
}
