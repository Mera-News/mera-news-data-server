import { Processor } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MeraWorkerHost,
  JobReporter,
} from '../../shared-utilities/mera-worker-host';
import { Job, UnrecoverableError } from 'bullmq';
import { LoadRSSFeedService, LoadRssFeedResult } from './load-rss-feed.service';
import { QueueName, QUEUE_TIMEOUTS } from '@mera/shared';

interface LoadRssFeedJobData {
  rssFeedId: string;
  /**
   * Fanout cycle stamp. Makes the feed-health failure counter idempotent
   * across BullMQ re-attempts and stall re-deliveries of the same cycle.
   */
  cycleId?: string;
  /** Slow-cadence probe of an auto-deactivated feed (see FeedFailurePolicy). */
  probe?: boolean;
}

/**
 * Code default, and the fallback when `FEED_FETCH_CONCURRENCY` is unparseable.
 *
 * 48 was tuned when the catalogue was 2,859 feeds; it is now 4,833. Note what
 * this number costs when fetches FAIL rather than succeed: on 2026-08-11 a
 * proxy-503 storm put every one of the 48 slots on the ~90s retry path, and the
 * queue drained at exactly 48 jobs/minute for 30 minutes. Concurrency is the
 * multiplier on a bad fetch as much as on a good one.
 */
const DEFAULT_FEED_FETCH_CONCURRENCY = 48;

@Processor(QueueName.LOAD_RSS_FEED, {
  // Fetches are network-bound and spread across the 32-proxy pool. Overridden
  // at bootstrap from FEED_FETCH_CONCURRENCY — @Processor options are evaluated
  // at class-definition time, before DI exists, so this literal is only the
  // starting value. See onApplicationBootstrap().
  concurrency: DEFAULT_FEED_FETCH_CONCURRENCY,
  lockDuration: 150000, // 2.5 minutes - must be >= job timeout for stall detection
})
export class LoadRSSFeedProcessor
  extends MeraWorkerHost
  implements OnApplicationBootstrap
{
  private readonly logger = new Logger(LoadRSSFeedProcessor.name);
  private readonly jobTimeout =
    QUEUE_TIMEOUTS['load-rss-feed'] || 2 * 60 * 1000;

  // A slow cycle can queue the tail of the 4,833-feed fan-out well past the
  // 10-min default; 45 min still expires stragglers before the next hourly
  // fan-out's articles would be affected.
  protected override maxQueueAgeMs = 45 * 60 * 1000;

  constructor(
    private readonly loadRSSFeedService: LoadRSSFeedService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  /**
   * Apply `FEED_FETCH_CONCURRENCY` to the live worker.
   *
   * Why here and not in the decorator: `@Processor` options are evaluated when
   * the class is DEFINED, long before DI exists, so a config value cannot reach
   * them. `onApplicationBootstrap` (not `onModuleInit`) is the first hook that
   * runs after every module's init, which is what guarantees `this.worker` has
   * been assigned by BullExplorer rather than racing module ordering.
   *
   * BullMQ's run loop re-reads `_concurrency` each iteration, so this takes
   * effect immediately without a restart.
   */
  onApplicationBootstrap(): void {
    const raw = this.configService?.get<number>(
      'FEED_FETCH_CONCURRENCY',
      DEFAULT_FEED_FETCH_CONCURRENCY,
    );
    const parsed = parseInt(String(raw), 10);
    // `set concurrency` throws on anything < 1, and this is precisely the knob
    // someone reaches for mid-incident — a typo must not take the worker down.
    const resolved =
      Number.isNaN(parsed) || parsed < 1
        ? DEFAULT_FEED_FETCH_CONCURRENCY
        : parsed;

    // `this.worker` is a GETTER that THROWS when the Bull explorer has not
    // registered yet — `if (this.worker)` is not a usable guard. Bootstrap
    // ordering says it is always ready here, but a throw in this hook would
    // take the whole async service down over a tuning knob, so it is caught.
    try {
      this.worker.concurrency = resolved;
      this.logger.log(`load-rss-feed worker concurrency = ${resolved}`);
    } catch (error) {
      this.logger.warn(
        `Could not apply load-rss-feed concurrency ${resolved}; ` +
          `worker not registered (${
            error instanceof Error ? error.message : String(error)
          }). Falling back to the decorator value.`,
      );
    }
  }

  async processJob(
    job: Job<LoadRssFeedJobData, unknown, string>,
  ): Promise<LoadRssFeedResult> {
    const { rssFeedId } = job.data;

    // Validate job data
    if (!rssFeedId) {
      const error = new Error('Missing required field: rssFeedId');
      this.logger.error(`Job ${job.id} failed: ${error.message}`);
      throw error;
    }

    // Use AbortController for timeout handling (BullMQ recommended pattern)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.jobTimeout);

    try {
      const result = await this.processWork(
        job,
        rssFeedId,
        controller.signal,
        this.makeReporter(job),
      );
      return result;
    } catch (error) {
      // SEAM 3 of 3. An UnrecoverableError raised deeper down — today, the
      // egress-shed path in LoadRSSFeedService — must reach BullMQ AS ONE. The
      // generic handler below rebuilds every error as a plain `Error`, which
      // would silently strip the do-not-retry semantics and turn a deliberate
      // shed into a retryable failure against the very egress that is down.
      if (error instanceof UnrecoverableError) {
        throw error;
      }

      // Handle timeout abort - throw UnrecoverableError to prevent retries
      if (error instanceof Error && error.name === 'AbortError') {
        const timeoutError = new UnrecoverableError(
          `Job ${job.id} timed out after ${this.jobTimeout}ms for RSS feed ${rssFeedId}`,
        );
        // Use warn for timeouts - expected operational issue, not a bug
        this.logger.warn(timeoutError.message);
        throw timeoutError;
      }

      // Enhanced error logging for BullBoard visibility
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      // Use warn for RSS feed failures - expected operational issues (blocked feeds, network issues)
      this.logger.warn(`Job ${job.id} failed: ${errorMessage}`, errorStack);

      // Create a structured error object for BullBoard
      const structuredError = new Error(
        `Failed to load RSS feed: ${errorMessage}`,
      );
      if (errorStack) {
        structuredError.stack = errorStack;
      }

      // Add additional context to the error
      Object.assign(structuredError, {
        jobId: job.id,
        rssFeedId: rssFeedId,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      });

      throw structuredError;
    } finally {
      clearTimeout(timer);
    }
  }

  private async processWork(
    job: Job<LoadRssFeedJobData, unknown, string>,
    rssFeedId: string,
    signal: AbortSignal,
    reporter: JobReporter,
  ): Promise<LoadRssFeedResult> {
    const checkAbort = () => {
      if (signal.aborted) {
        const error = new Error('Operation aborted due to timeout');
        error.name = 'AbortError';
        throw error;
      }
    };

    checkAbort();

    // Fall back to the job id so a manually-added job (no cycleId) still gets
    // a stable key rather than counting once per BullMQ attempt.
    const cycleId = job.data.cycleId ?? String(job.id);

    const result = await this.loadRSSFeedService.loadRssFeed(
      rssFeedId,
      reporter,
      cycleId,
    );

    checkAbort();

    return result;
  }
}
