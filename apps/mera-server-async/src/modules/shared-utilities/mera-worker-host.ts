import { Logger } from '@nestjs/common';
import { WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';

/** Maximum age (ms) a job can wait in the queue before being discarded. */
const DEFAULT_MAX_QUEUE_AGE_MS = 10 * 60 * 1000; // 10 minutes

/** Max characters of `job.data` to include in the Bull Board start log line. */
const DATA_PREVIEW_MAX_CHARS = 500;

/**
 * Mid-job progress/log reporter handed to a processor (and its services) so
 * long-running work can narrate itself into the Bull Board **Progress** and
 * **Logs** tabs.
 *
 * Both methods write to Redis via the job, independent of the Pino log level
 * (often `warn`-only in production). They never throw — a logging hiccup must never
 * fail the underlying job.
 */
export interface JobReporter {
  /** Append a line to the job's Bull Board Logs tab. */
  log(message: string): Promise<void>;
  /** Set the job's progress (0–100) and optionally log a message. */
  progress(pct: number, message?: string): Promise<void>;
}

/** A reporter that does nothing — default when a service is called outside a job. */
export const NOOP_JOB_REPORTER: JobReporter = {
  log: async () => {},
  progress: async () => {},
};

/**
 * Base class for all BullMQ processors.
 *
 * Responsibilities:
 * - Wraps the return value to always include the original job input alongside
 *   the result, making completed jobs easy to inspect in Bull Board (Data tab).
 * - Discards jobs that have waited longer than `maxQueueAgeMs` to keep stale
 *   work from blocking the pipeline (thrown as UnrecoverableError → failed,
 *   never retried).
 * - Narrates every job's lifecycle into Bull Board via `job.log()` (Logs tab)
 *   and `job.updateProgress()` (Progress tab): a start line, 0→100 progress,
 *   and a success/failure line. This is intentionally the **detailed** sink —
 *   production Pino often runs at `warn`, so step detail lives here, almost free.
 *
 * Subclasses implement `processJob()` instead of `process()`. Heavy/iterative
 * processors can call `this.makeReporter(job)` and thread the reporter into
 * their services for mid-job progress.
 */
export abstract class MeraWorkerHost extends WorkerHost {
  private readonly baseLogger = new Logger('MeraWorkerHost');

  /** Override in subclass to customise the max queue age for this processor. */
  protected maxQueueAgeMs: number = DEFAULT_MAX_QUEUE_AGE_MS;

  async process(job: Job): Promise<{ input: unknown; result: unknown }> {
    const startedAt = Date.now();
    const waitTimeMs = startedAt - job.timestamp;

    if (waitTimeMs > this.maxQueueAgeMs) {
      const reason =
        `Discarding stale job ${job.id} (queue: ${job.queueName}) — ` +
        `waited ${Math.round(waitTimeMs / 1000)}s, max ${Math.round(this.maxQueueAgeMs / 1000)}s`;
      this.baseLogger.warn(reason);
      await this.jobLog(job, `⤫ ${reason}`);
      // UnrecoverableError → the job lands in the FAILED tab (visible,
      // countable, alertable) without BullMQ retries. Returning a value here
      // would mark it COMPLETED and hide the drop (2026-07-10: 5000 discarded
      // jobs read as successes in Bull Board).
      throw new UnrecoverableError(reason);
    }

    const attempt = job.attemptsMade + 1;
    const maxAttempts = job.opts?.attempts ?? 1;
    await this.jobLog(
      job,
      `▶ start queue=${job.queueName} attempt=${attempt}/${maxAttempts} ` +
        `data=${this.previewData(job.data)}`,
    );
    await this.setProgress(job, 0);

    try {
      const result = await this.processJob(job);
      await this.setProgress(job, 100);
      await this.jobLog(job, `✓ completed in ${Date.now() - startedAt}ms`);
      return { input: job.data, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.jobLog(
        job,
        `✗ failed in ${Date.now() - startedAt}ms: ${message}`,
      );
      // Re-throw unchanged: preserves each processor's UnrecoverableError /
      // structured-error handling and the Bull Board Error tab.
      throw error;
    }
  }

  abstract processJob(job: Job): Promise<unknown>;

  /**
   * Build a {@link JobReporter} bound to `job` for mid-job progress/logs.
   * Pass it into services so iterative work can report per-step.
   */
  protected makeReporter(job: Job): JobReporter {
    return {
      log: (message: string) => this.jobLog(job, message),
      progress: async (pct: number, message?: string) => {
        await this.setProgress(job, pct);
        if (message) {
          await this.jobLog(job, message);
        }
      },
    };
  }

  /** Append a timestamped line to the job's Bull Board Logs tab; never throws. */
  private async jobLog(job: Job, message: string): Promise<void> {
    try {
      await job.log(`[${new Date().toISOString()}] ${message}`);
    } catch (err) {
      // A logging failure must never fail the job.
      this.baseLogger.warn(
        `Failed to write job.log for job ${job.id} (queue: ${job.queueName}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Set job progress (clamped 0–100) for the Bull Board Progress tab; never throws. */
  private async setProgress(job: Job, pct: number): Promise<void> {
    try {
      const clamped = Math.max(0, Math.min(100, Math.round(pct)));
      await job.updateProgress(clamped);
    } catch (err) {
      this.baseLogger.warn(
        `Failed to update progress for job ${job.id} (queue: ${job.queueName}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Compact, length-bounded preview of job.data for the start log line. */
  private previewData(data: unknown): string {
    try {
      const json = JSON.stringify(data) ?? String(data);
      return json.length > DATA_PREVIEW_MAX_CHARS
        ? `${json.slice(0, DATA_PREVIEW_MAX_CHARS)}…(${json.length} chars)`
        : json;
    } catch {
      return '[unserializable]';
    }
  }
}
