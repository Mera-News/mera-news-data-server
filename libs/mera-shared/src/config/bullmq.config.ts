import { JobsOptions } from 'bullmq';

/**
 * Default job options for all BullMQ queues across all services.
 * These settings ensure consistent job behavior and automatic cleanup.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 2, // 1 retry + initial attempt
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
  removeOnComplete: {
    age: 60, // 1 minute — completed jobs are cleaned up quickly
  },
  removeOnFail: {
    age: 3600, // 1 hour — failed jobs are retained longer for investigation
  },
};

/**
 * Queue-specific timeout configurations in milliseconds.
 * These define how long a job can run before being considered timed out.
 * Used by processors to implement timeout behavior via Promise.race.
 */
export const QUEUE_TIMEOUTS: Record<string, number> = {
  // Article processing pipeline.
  // The ID-array pipeline queues (news-sync-fanout, translate-article,
  // generate-embedding-article, database-projector) intentionally have NO
  // per-job timeout: a 250-id batch legitimately runs minutes, so they rely on
  // BullMQ lock renewal (lockDuration 10 min) + maxQueueAgeMs=Infinity instead.
  // Only load-rss-feed keeps the AbortController timeout.
  'load-rss-feed': 2 * 60 * 1000, // 2 minutes - RSS fetch

  // User topics
  'link-topic-to-clusters': 3 * 60 * 1000, // 3 minutes - vector search
  'link-all-topics-to-clusters': 60 * 1000, // 1 minute - enqueues workers

  // Headline editions (precomputed top-headlines materialization)
  'build-headline-editions': 10 * 60 * 1000, // 10 minutes - full 48h pool rebuild, ~5.5 min in prod

  // Utility
  'data-retention-sweep': 15 * 60 * 1000, // 15 minutes - bulk deleteMany per retention rule + cascade
};

/**
 * Default lock duration for processors in milliseconds.
 * Jobs should complete within this time or they'll be considered stalled.
 */
export const DEFAULT_LOCK_DURATION = 60000; // 1 minute

/**
 * Job options for FlowProducer children.
 *
 * BullMQ does NOT propagate `defaultJobOptions` (set on BullModule.forRootAsync)
 * to jobs created via `FlowProducer.add()`. Without explicit `removeOnComplete`/
 * `removeOnFail`, the parent's `<jobKey>:processed` hash (which holds every
 * child's return value) lives forever in Redis. With large fan-outs that single
 * hash can exceed 17 MB and OOM Memorystore.
 *
 * Apply this to every FlowProducer.add() child's `opts` (the sole remaining
 * flow is `link-all-topics-to-clusters`; the rss-processing-flow parent was
 * removed, so FLOW_PARENT_JOB_OPTIONS is gone).
 */
export const FLOW_CHILD_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 60 },
  removeOnFail: { age: 3600 },
};
