import { Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { MeraWorkerHost } from '../../shared-utilities/mera-worker-host';
import { InjectModel } from '@nestjs/mongoose';
import { Job, UnrecoverableError } from 'bullmq';
import { Model, Types } from 'mongoose';
import {
  LinkTopicToClusterService,
  LinkTopicToClusterResult,
} from './link-topic-to-clusters.service';
import {
  StateMachineLinkTopicsToClusters,
  StateMachineLinkTopicsToClustersDocument,
} from '@mera/models/models/state-machine-link-topics-to-clusters.model';
import { QueueName, QUEUE_TIMEOUTS } from '@mera/shared';

export interface LinkTopicToClusterJobData {
  topicId: string;
  userTopicLinkingResultId: string;
}

@Processor(QueueName.LINK_TOPIC_TO_CLUSTERS, {
  concurrency: 3,
  lockDuration: 180000, // 3 minutes - must be >= job timeout for stall detection
  // Each job runs an Atlas $vectorSearch; cap job starts to spread the hourly batch and avoid pinning mongot CPU
  limiter: { max: 3, duration: 1000 },
})
export class LinkTopicToClusterProcessor extends MeraWorkerHost {
  private readonly logger = new Logger(LinkTopicToClusterProcessor.name);
  private readonly jobTimeout =
    QUEUE_TIMEOUTS['link-topic-to-clusters'] || 3 * 60 * 1000;

  // The 3 jobs/s limiter means a full hourly batch (~3000 topics) legitimately
  // waits up to ~20 min; 45 min still expires stragglers before the next
  // hour's batch lands at :20.
  protected override maxQueueAgeMs = 45 * 60 * 1000;

  constructor(
    private readonly linkTopicToClusterService: LinkTopicToClusterService,
    @InjectModel(StateMachineLinkTopicsToClusters.name)
    private readonly stateMachineLinkTopicsToClustersModel: Model<StateMachineLinkTopicsToClustersDocument>,
  ) {
    super();
  }

  async processJob(
    job: Job<LinkTopicToClusterJobData>,
  ): Promise<LinkTopicToClusterResult> {
    // Use AbortController for timeout handling (BullMQ recommended pattern)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.jobTimeout);

    // Extract job data for use in catch block
    const { topicId, userTopicLinkingResultId } = job.data;

    try {
      if (!topicId) {
        throw new Error('topicId is required in job data');
      }

      if (!userTopicLinkingResultId) {
        throw new Error('userTopicLinkingResultId is required in job data');
      }

      const result = await this.processWork(
        job,
        topicId,
        userTopicLinkingResultId,
        controller.signal,
      );

      return result;
    } catch (error) {
      // Handle timeout abort - throw UnrecoverableError to prevent retries
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new UnrecoverableError(
          `Job ${job.id} timed out after ${this.jobTimeout}ms for topic ${topicId}`,
        );
        this.logger.error({ err: timeoutError }, timeoutError.message);
        throw timeoutError;
      }

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      this.logger.error(
        `Failed to process job ${job.id}: ${errorMessage}`,
        errorStack,
      );

      const structuredError = new Error(
        `Failed to link topic to clusters: ${errorMessage}`,
      );
      if (errorStack) {
        structuredError.stack = errorStack;
      }

      Object.assign(structuredError, {
        jobId: job.id,
        topicId,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      });

      throw structuredError;
    } finally {
      clearTimeout(timer);
    }
  }

  private async processWork(
    _job: Job<LinkTopicToClusterJobData>,
    topicId: string,
    userTopicLinkingResultId: string,
    signal: AbortSignal,
  ): Promise<LinkTopicToClusterResult> {
    const checkAbort = () => {
      if (signal.aborted) {
        const error = new Error('Operation aborted due to timeout');
        error.name = 'AbortError';
        throw error;
      }
    };

    checkAbort();

    const result =
      await this.linkTopicToClusterService.linkTopicToClusters(topicId);

    checkAbort();

    // Update the linking result with this processed topic ID
    await this.stateMachineLinkTopicsToClustersModel.findByIdAndUpdate(
      userTopicLinkingResultId,
      { $push: { processedTopicIds: new Types.ObjectId(topicId) } },
    );

    checkAbort();

    return result;
  }
}
