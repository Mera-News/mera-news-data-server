import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import { QueueName, QUEUE_TIMEOUTS } from '@mera/shared';
import { MeraWorkerHost } from '../../shared-utilities/mera-worker-host';
import {
  DataRetentionSweepJobData,
  DataRetentionSweepService,
} from './data-retention-sweep.service';

const TIMEOUT = QUEUE_TIMEOUTS['data-retention-sweep'] || 15 * 60 * 1000;

@Processor(QueueName.DATA_RETENTION_SWEEP, {
  concurrency: 1,
  lockDuration: TIMEOUT,
})
export class DataRetentionSweepProcessor extends MeraWorkerHost {
  private readonly logger = new Logger(DataRetentionSweepProcessor.name);

  constructor(
    private readonly dataRetentionSweepService: DataRetentionSweepService,
  ) {
    super();
    this.maxQueueAgeMs = TIMEOUT;
  }

  async processJob(job: Job<DataRetentionSweepJobData>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);

    try {
      return await this.dataRetentionSweepService.sweep(
        job.data ?? {},
        controller.signal,
        this.makeReporter(job),
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new UnrecoverableError(
          `Job ${job.id} timed out after ${TIMEOUT}ms while running data-retention sweep`,
        );
        this.logger.error({ err: timeoutError }, timeoutError.message);
        throw timeoutError;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Data retention sweep failed (job ${job.id}): ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
