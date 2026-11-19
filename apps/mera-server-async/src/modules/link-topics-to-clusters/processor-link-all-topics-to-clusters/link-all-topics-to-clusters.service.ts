import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import {
  UserTopic,
  UserTopicDocument,
} from '@mera/models/models/user-topic.model';
import {
  LinkTopicsToClustersStatus,
  StateMachineLinkTopicsToClusters,
  StateMachineLinkTopicsToClustersDocument,
} from '@mera/models/models/state-machine-link-topics-to-clusters.model';
import { QueueName, FLOW_CHILD_JOB_OPTIONS } from '@mera/shared';
import {
  JobReporter,
  NOOP_JOB_REPORTER,
} from '../../shared-utilities/mera-worker-host';

// Only topics somebody has actually requested inside this window are re-linked
// on the hourly run. Warming links for the whole (anonymous, shared) topic
// cache is wasted work: a topic idle for 7–14 days still serves correctly from
// the cold vector-search path, and gets re-warmed the hour after its next
// request. The 14-day `UserTopic` retention rule is the hard upper bound, so
// this window is always strictly inside a topic's lifetime.
const ACTIVE_TOPIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface LinkAllTopicsToClustersResult {
  success: boolean;
  totalTopicsFound: number;
  enqueuedWorkers: number;
  linkingResultId: string;
  processedAt: string;
}

@Injectable()
export class LinkAllTopicsToClustersService {
  private readonly logger = new Logger(LinkAllTopicsToClustersService.name);

  constructor(
    @InjectQueue(QueueName.LINK_TOPIC_TO_CLUSTERS)
    private readonly linkTopicQueue: Queue,
    @InjectQueue(QueueName.BUILD_HEADLINE_EDITIONS)
    private readonly buildHeadlineEditionsQueue: Queue,
    @InjectModel(UserTopic.name)
    private readonly userTopicModel: Model<UserTopicDocument>,
    @InjectModel(StateMachineLinkTopicsToClusters.name)
    private readonly stateMachineLinkTopicsToClustersModel: Model<StateMachineLinkTopicsToClustersDocument>,
  ) {}

  async linkAllTopicsToClusters(
    reporter: JobReporter = NOOP_JOB_REPORTER,
  ): Promise<LinkAllTopicsToClustersResult> {
    // Kick off the headline-edition rebuild for this clustering run. This is
    // fire-and-forget and INDEPENDENT of topic linking — a queue failure here
    // must never fail (or abort) the topic-linking run, so it is best-effort.
    await this.enqueueHeadlineEditionBuild();

    let runId: Types.ObjectId | undefined;
    try {
      // `_id` projection only: the full document carries the 768-dim
      // `news_topic_embed` vector and nothing downstream reads anything but the
      // id, so hydrating every topic vector was pure heap churn.
      const activeSince = new Date(Date.now() - ACTIVE_TOPIC_WINDOW_MS);
      const allTopics = (await this.userTopicModel
        .find({
          is_canonical: { $ne: true },
          $or: [
            { lastRequestedAt: { $gte: activeSince } },
            // TRANSITION TOLERANCE: topics written before `lastRequestedAt`
            // existed carry no activity stamp at all, and Mongo never matches a
            // missing field with `$gte` — without this clause the hourly run
            // would link almost nothing between deploy and backfill. A topic
            // with no stamp yet is treated as active. Once the
            // `decouple-user-topics` migration has backfilled (and because new
            // inserts carry a schema default) this clause matches nothing.
            { lastRequestedAt: { $exists: false } },
          ],
        })
        .select('_id')
        .lean()
        .exec()) as unknown as Array<{ _id: Types.ObjectId }>;
      await reporter.progress(40, `Found ${allTopics.length} user topic(s)`);

      if (allTopics.length === 0) {
        const emptyLinkingResult =
          await this.stateMachineLinkTopicsToClustersModel.create({
            status: LinkTopicsToClustersStatus.ENQUEUE_SUCCESS,
            totalTopicsEnqueuedForProcessing: 0,
            processedTopicIds: [],
          });

        return {
          success: true,
          totalTopicsFound: 0,
          enqueuedWorkers: 0,
          linkingResultId: emptyLinkingResult._id.toString(),
          processedAt: new Date().toISOString(),
        };
      }

      const linkingResult =
        await this.stateMachineLinkTopicsToClustersModel.create({
          totalTopicsEnqueuedForProcessing: allTopics.length,
          processedTopicIds: [],
        });
      runId = linkingResult._id;

      const timestamp = Date.now();

      await this.linkTopicQueue.addBulk(
        allTopics.map((topic) => ({
          name: 'link-topic-to-cluster',
          data: {
            topicId: topic._id.toString(),
            userTopicLinkingResultId: linkingResult._id.toString(),
          },
          opts: {
            ...FLOW_CHILD_JOB_OPTIONS,
            jobId: `link-topic-${topic._id.toString()}-${timestamp}`,
          },
        })),
      );

      // `status --check linked` waits for this mark.
      await this.stateMachineLinkTopicsToClustersModel.updateOne(
        { _id: runId },
        {
          status: LinkTopicsToClustersStatus.ENQUEUE_SUCCESS,
          successfullyEnqueuedCount: allTopics.length,
        },
      );
      this.logger.log(
        `Enqueued ${allTopics.length} link-topic-to-clusters jobs`,
      );
      await reporter.progress(
        90,
        `Enqueued ${allTopics.length} link-topic-to-clusters worker job(s)`,
      );

      return {
        success: true,
        totalTopicsFound: allTopics.length,
        enqueuedWorkers: allTopics.length,
        linkingResultId: linkingResult._id.toString(),
        processedAt: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Job failed: ${errorMessage}`);
      if (runId) {
        await this.stateMachineLinkTopicsToClustersModel
          .updateOne(
            { _id: runId },
            { status: LinkTopicsToClustersStatus.ENQUEUE_FAILED, errorMessage },
          )
          .catch(() => undefined);
      }
      throw error;
    }
  }

  /**
   * Enqueue a single `build-headline-editions` job. Wrapped so any queue error
   * is logged and swallowed — the headline rebuild is a downstream convenience
   * and must never take down the topic-linking run.
   */
  private async enqueueHeadlineEditionBuild(): Promise<void> {
    try {
      await this.buildHeadlineEditionsQueue.add(
        'build-headline-editions',
        {},
        { jobId: `build-headline-editions-${Date.now()}` },
      );
      this.logger.log('Enqueued build-headline-editions job');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to enqueue build-headline-editions (non-fatal): ${errorMessage}`,
      );
    }
  }
}
