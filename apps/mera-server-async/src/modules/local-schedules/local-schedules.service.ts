import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { QueueName } from '@mera/shared';
import { readBool, readText } from '@mera/shared/config/env-choice';

/** `true` or `false`; unset is off. Anything else throws, so boot fails. */
export function parseLocalSchedules(config: ConfigService): boolean {
  return readBool(config, 'LOCAL_SCHEDULES', false);
}

const SCHEDULES = [
  {
    id: 'news-sync-fanout',
    queue: QueueName.NEWS_SYNC_FANOUT,
    pattern: '0 * * * *',
    data: {},
  },
  {
    id: 'link-all-topics-to-clusters',
    queue: QueueName.LINK_ALL_TOPICS_TO_CLUSTERS,
    pattern: '20 * * * *',
    data: {},
  },
  {
    id: 'data-retention-hourly',
    queue: QueueName.DATA_RETENTION_SWEEP,
    pattern: '0 * * * *',
    data: { skipOrphans: true },
  },
  {
    id: 'data-retention-daily',
    queue: QueueName.DATA_RETENTION_SWEEP,
    pattern: '15 3 * * *',
    data: {},
  },
] as const;

/**
 * Runs the hourly jobs from inside the worker when LOCAL_SCHEDULES=true.
 * LOCAL_SCHEDULES=false removes these four schedulers, for a worker that once
 * ran with them on and now sits next to an outside scheduler that calls
 * /invoke. Unset touches nothing: a boot that never asked for local schedules
 * must not wait on Redis for them.
 */
@Injectable()
export class LocalSchedulesService implements OnModuleInit {
  private readonly logger = new Logger(LocalSchedulesService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // The queues the processors already registered, never a second instance.
  private queue(name: QueueName): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
  }

  async onModuleInit(): Promise<void> {
    if (!parseLocalSchedules(this.config)) {
      if (readText(this.config, 'LOCAL_SCHEDULES').toLowerCase() !== 'false') {
        return;
      }
      await Promise.all(
        SCHEDULES.map((s) => this.queue(s.queue).removeJobScheduler(s.id)),
      );
      this.logger.log(
        'Local schedules are off; removed any left from an earlier run.',
      );
      return;
    }
    await Promise.all(
      SCHEDULES.map((s) =>
        this.queue(s.queue).upsertJobScheduler(
          s.id,
          { pattern: s.pattern },
          { name: `scheduled-${s.id}`, data: s.data },
        ),
      ),
    );
    this.logger.log(
      `Local schedules are on: ${SCHEDULES.map((s) => `${s.id} (${s.pattern})`).join(', ')}.`,
    );
  }
}
