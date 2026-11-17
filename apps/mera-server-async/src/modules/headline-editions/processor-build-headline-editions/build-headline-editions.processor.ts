import { Processor } from '@nestjs/bullmq';
import {
  MeraWorkerHost,
  JobReporter,
} from '../../shared-utilities/mera-worker-host';
import { Logger } from '@nestjs/common';
import { Job, UnrecoverableError } from 'bullmq';
import {
  BuildHeadlineEditionsService,
  BuildHeadlineEditionsResult,
} from './build-headline-editions.service';
import { QueueName, QUEUE_TIMEOUTS } from '@mera/shared';

@Processor(QueueName.BUILD_HEADLINE_EDITIONS, {
  concurrency: 1,
  lockDuration: 600000, // 10 minutes - must be >= job timeout for stall detection
})
export class BuildHeadlineEditionsProcessor extends MeraWorkerHost {
  private readonly logger = new Logger(BuildHeadlineEditionsProcessor.name);
  private readonly jobTimeout =
    QUEUE_TIMEOUTS['build-headline-editions'] || 600 * 1000;

  protected override maxQueueAgeMs = Infinity;

  constructor(
    private readonly buildHeadlineEditionsService: BuildHeadlineEditionsService,
  ) {
    super();
  }

  async processJob(job: Job): Promise<BuildHeadlineEditionsResult> {
    // Use AbortController for timeout handling (BullMQ recommended pattern)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.jobTimeout);

    try {
      const result = await this.processWork(
        job,
        controller.signal,
        this.makeReporter(job),
      );
      return result;
    } catch (error) {
      // Handle timeout abort - throw UnrecoverableError to prevent retries
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new UnrecoverableError(
          `Job ${job.id} timed out after ${this.jobTimeout}ms`,
        );
        this.logger.error({ err: timeoutError }, timeoutError.message);
        throw timeoutError;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(`Failed job ${job.id}: ${errorMessage}`, errorStack);

      const structuredError = new Error(
        `Failed to build headline editions: ${errorMessage}`,
      );
      if (errorStack) {
        structuredError.stack = errorStack;
      }

      Object.assign(structuredError, {
        jobId: job.id,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      });

      throw structuredError;
    } finally {
      clearTimeout(timer);
    }
  }

  private async processWork(
    _job: Job,
    signal: AbortSignal,
    reporter: JobReporter,
  ): Promise<BuildHeadlineEditionsResult> {
    const checkAbort = () => {
      if (signal.aborted) {
        const error = new Error('Operation aborted due to timeout');
        error.name = 'AbortError';
        throw error;
      }
    };

    checkAbort();

    const result =
      await this.buildHeadlineEditionsService.buildHeadlineEditions(reporter);

    checkAbort();

    return result;
  }
}
